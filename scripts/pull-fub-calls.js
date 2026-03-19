const { createClient } = require('@supabase/supabase-js');

// =============================================================
// FUB Call Data Pull — Node.js (GitHub Actions)
//
// Incremental sync of call records from Follow Up Boss /v1/calls
// into call_daily_stats table. Uses call_sync_cursor singleton
// for cursor-based pagination across runs.
//
// Mirror of: supabase/functions/pull-fub-calls/index.ts
// IMPORTANT: Business logic changes must be applied to both.
// See ARCHITECTURE.md for details.
// =============================================================

// ── Config ──
const FUB_API_KEY = process.env.FUB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const PAGE_LIMIT = 100;
const RATE_LIMIT_DELAY_MS = 120; // ~8 req/sec, within FUB's 250/10s limit
const CONVERSATION_THRESHOLD_SEC = 120; // 2 min+ call = "conversation"
const BATCH_SIZE = 500;

// ── Helpers ──

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, options);
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '10', 10);
      console.warn(`  ⚠ 429 rate limited — retrying in ${retryAfter}s (attempt ${attempt}/${maxRetries})`);
      await sleep(retryAfter * 1000);
      continue;
    }
    return resp;
  }
  throw new Error(`FUB API: still rate-limited after ${maxRetries} retries`);
}

function fubHeaders() {
  const token = Buffer.from(FUB_API_KEY + ':').toString('base64');
  return {
    Authorization: `Basic ${token}`,
    'Content-Type': 'application/json',
    'X-System': 'ExpectationsTracker',
    'X-System-Key': 'expectations-tracker-v1',
  };
}

/**
 * Convert an ISO timestamp to a YYYY-MM-DD date in Pacific time.
 *
 * FUB returns UTC timestamps. A call at 5pm Pacific on 3/3 is
 * "2026-03-04T01:00:00Z" in UTC — naive substring would bucket
 * it as 3/4 instead of 3/3. We convert to America/Los_Angeles
 * so daily aggregation matches the San Diego business day.
 *
 * IMPORTANT: Must stay in sync with the edge function mirror.
 */
function datePacific(isoString) {
  const d = new Date(isoString);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${day}`;
}

/**
 * Fetch all calls from FUB since a given timestamp.
 * Uses keyset pagination via _metadata.nextLink.
 */
async function fetchCallsSince(since) {
  const allCalls = [];
  let url = `https://api.followupboss.com/v1/calls?limit=${PAGE_LIMIT}&sort=created&createdAfter=${encodeURIComponent(since)}`;
  let pageCount = 0;

  while (url) {
    const resp = await fetchWithRetry(url, { headers: fubHeaders() });
    if (!resp.ok) {
      throw new Error(`FUB API ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    const calls = data.calls || [];
    allCalls.push(...calls);
    pageCount++;

    console.log(`  Page ${pageCount}: ${calls.length} calls (total: ${allCalls.length})`);

    if (calls.length >= PAGE_LIMIT && data._metadata?.nextLink) {
      url = data._metadata.nextLink;
    } else {
      url = null;
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return allCalls;
}

/**
 * Group calls by (userId, date) and aggregate stats.
 * A "conversation" is any call lasting >= CONVERSATION_THRESHOLD_SEC.
 */
function aggregateCalls(calls) {
  const map = new Map();

  for (const call of calls) {
    if (!call.userId || !call.created) continue;

    const date = datePacific(call.created);
    const key = `${call.userId}:${date}`;

    if (!map.has(key)) {
      map.set(key, {
        agent_id: call.userId,
        call_date: date,
        outbound_total: 0,
        inbound_total: 0,
        outbound_duration_sec: 0,
        inbound_duration_sec: 0,
        outbound_conversations: 0,
        inbound_conversations: 0,
      });
    }

    const bucket = map.get(key);
    const dur = call.duration || 0;
    const isConversation = dur >= CONVERSATION_THRESHOLD_SEC;

    if (!call.isIncoming) {
      // Outbound call
      bucket.outbound_total++;
      bucket.outbound_duration_sec += dur;
      if (isConversation) bucket.outbound_conversations++;
    } else {
      // Inbound call
      bucket.inbound_total++;
      bucket.inbound_duration_sec += dur;
      if (isConversation) bucket.inbound_conversations++;
    }
  }

  return map;
}

// ── Main ──

async function main() {
  const startTime = Date.now();
  console.log('=== FUB Call Data Pull ===');
  console.log(`Time: ${new Date().toISOString()}`);

  // Step 1: Read sync cursor
  const { data: cursor, error: cursorError } = await supabase
    .from('call_sync_cursor')
    .select('*')
    .eq('id', 1)
    .single();

  if (cursorError) {
    throw new Error(`Failed to read sync cursor: ${cursorError.message}`);
  }

  // Sync from midnight UTC of the cursor's Pacific date. This ensures we
  // re-pull the full day's calls on every run so the upsert overwrites
  // with complete daily totals — not just the partial increment.
  // UTC midnight <= Pacific midnight, so we may fetch a few extra calls
  // from late the previous Pacific day; that's fine since aggregation
  // groups by Pacific date and the upsert is idempotent.
  const cursorDate = datePacific(cursor.last_synced_at);
  const syncSince = `${cursorDate}T00:00:00Z`;
  console.log(`Syncing calls from start of cursor date: ${syncSince} (cursor was ${cursor.last_synced_at})`);

  // Step 2: Fetch calls from FUB
  const calls = await fetchCallsSince(syncSince);
  console.log(`Fetched ${calls.length} total calls`);

  if (calls.length === 0) {
    const duration = Date.now() - startTime;
    console.log(`✓ No new calls since last sync (${duration}ms)`);
    return;
  }

  // Step 3: Aggregate into daily buckets per agent
  const buckets = aggregateCalls(calls);
  console.log(`Aggregated into ${buckets.size} agent-day buckets`);

  // Step 4: Upsert into call_daily_stats (batched)
  const rows = Array.from(buckets.values()).map((b) => ({
    ...b,
    updated_at: new Date().toISOString(),
  }));

  let rowsUpserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error: upsertError } = await supabase
      .from('call_daily_stats')
      .upsert(batch, { onConflict: 'agent_id,call_date' });

    if (upsertError) {
      throw new Error(`Failed to upsert call_daily_stats: ${upsertError.message}`);
    }
    rowsUpserted += batch.length;
  }

  console.log(`Upserted ${rowsUpserted} rows`);

  // Step 5: Advance sync cursor to latest call
  const latestCall = calls.reduce((latest, c) =>
    c.created > latest.created ? c : latest
  );

  const { error: cursorUpdateError } = await supabase
    .from('call_sync_cursor')
    .update({
      last_synced_at: latestCall.created,
      last_call_id: latestCall.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (cursorUpdateError) {
    console.warn(`Cursor update warning: ${cursorUpdateError.message}`);
  }

  const duration = Date.now() - startTime;
  console.log(`✓ Complete in ${duration}ms: ${calls.length} calls → ${rowsUpserted} rows`);
  console.log(`  Cursor advanced to: ${latestCall.created}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

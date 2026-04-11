/**
 * One-time backfill: Pull ALL calls from FUB API for the last 45 days
 * and rebuild call_daily_stats with correct totals.
 *
 * This fixes historical data corrupted by the overwrite bug where
 * straggler calls from prior days overwrote complete daily totals.
 *
 * Run via: node scripts/backfill-calls.js
 * Safe to re-run — uses upsert with full daily totals.
 */

const { createClient } = require('@supabase/supabase-js');

const FUB_API_KEY = process.env.FUB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const PAGE_LIMIT = 100;
const CONVERSATION_THRESHOLD_SEC = 120;
const BATCH_SIZE = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fubHeaders() {
  const token = Buffer.from(FUB_API_KEY + ':').toString('base64');
  return { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' };
}

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

async function main() {
  const startTime = Date.now();
  console.log('=== Call Data Backfill ===');

  // Fetch all calls from the last 45 days
  const since = new Date();
  since.setDate(since.getDate() - 45);
  const sinceStr = since.toISOString();
  console.log(`Fetching ALL calls since ${sinceStr}...`);

  const allCalls = [];
  let url = `https://api.followupboss.com/v1/calls?limit=${PAGE_LIMIT}&sort=created&createdAfter=${encodeURIComponent(sinceStr)}`;
  let pageCount = 0;

  while (url) {
    const resp = await fetch(url, { headers: fubHeaders() });
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '10', 10);
      console.warn(`  Rate limited — waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!resp.ok) throw new Error(`FUB API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const calls = data.calls || [];
    allCalls.push(...calls);
    pageCount++;
    if (pageCount % 10 === 0) console.log(`  Page ${pageCount}: ${allCalls.length} calls so far`);
    if (calls.length >= PAGE_LIMIT && data._metadata?.nextLink) {
      url = data._metadata.nextLink;
    } else {
      url = null;
    }
    await sleep(150);
  }

  console.log(`Fetched ${allCalls.length} calls in ${pageCount} pages`);

  // Aggregate by (agent, Pacific date)
  const map = new Map();
  for (const call of allCalls) {
    if (!call.userId || !call.created) continue;
    const date = datePacific(call.created);
    const key = `${call.userId}:${date}`;
    if (!map.has(key)) {
      map.set(key, {
        agent_id: call.userId, call_date: date,
        outbound_total: 0, inbound_total: 0,
        outbound_duration_sec: 0, inbound_duration_sec: 0,
        outbound_conversations: 0, inbound_conversations: 0,
      });
    }
    const bucket = map.get(key);
    const dur = call.duration || 0;
    const isConvo = dur >= CONVERSATION_THRESHOLD_SEC;
    if (!call.isIncoming) {
      bucket.outbound_total++;
      bucket.outbound_duration_sec += dur;
      if (isConvo) bucket.outbound_conversations++;
    } else {
      bucket.inbound_total++;
      bucket.inbound_duration_sec += dur;
      if (isConvo) bucket.inbound_conversations++;
    }
  }

  console.log(`Aggregated into ${map.size} agent-day buckets`);

  // Upsert all rows (full overwrite is safe here — we have the complete picture)
  const rows = Array.from(map.values()).map(b => ({ ...b, updated_at: new Date().toISOString() }));
  let rowsUpserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('call_daily_stats')
      .upsert(batch, { onConflict: 'agent_id,call_date' });
    if (error) throw new Error(`Upsert failed: ${error.message}`);
    rowsUpserted += batch.length;
  }

  const duration = Date.now() - startTime;
  console.log(`\n✓ Backfill complete: ${rowsUpserted} rows upserted in ${Math.round(duration / 1000)}s`);
  console.log(`  Unique agents: ${new Set(rows.map(r => r.agent_id)).size}`);
  console.log(`  Date range: ${rows.map(r => r.call_date).sort()[0]} to ${rows.map(r => r.call_date).sort().pop()}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

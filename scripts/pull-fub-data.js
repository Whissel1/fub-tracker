const { createClient } = require('@supabase/supabase-js');

// ── Config ──
const FUB_API_KEY = process.env.FUB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TRACKED_LISTS = [
  { fub_list_id: 1100, name: 'New Opportunities' },
  { fub_list_id: 1078, name: 'High Intent' },
  { fub_list_id: 1079, name: 'Browsing' },
  { fub_list_id: 1083, name: 'Attempted 0-7 Days' },
  { fub_list_id: 1084, name: 'Attempted 8-30 Days' },
  { fub_list_id: 1086, name: 'Spoke - Need Appointment' },
  { fub_list_id: 1089, name: 'Met - Stay Close' },
  { fub_list_id: 1105, name: 'Showing Homes' },
  { fub_list_id: 1106, name: 'Submitting Offers' },
];

// ── FUB helpers ──
function fubHeaders() {
  const token = Buffer.from(FUB_API_KEY + ':').toString('base64');
  return {
    Authorization: `Basic ${token}`,
    'Content-Type': 'application/json',
    'X-System': 'WhisselTracker',
    'X-System-Key': 'fub-tracker-v1',
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function daysBetween(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (d.getFullYear() <= 2001) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function processPerson(person) {
  const agentId = person.assignedUserId || null;
  if (!agentId) return null;

  const lastAttempt = person.lastOutboundAttempt || person.lastAttemptedContact || null;
  const lastTwoWay = person.lastTwoWayCommunication || person.lastCommunication || null;
  const lastSiteVisit = person.lastSiteVisit || person.lastPropertySearch || null;

  return {
    agentId,
    daysSinceLastAttempt: daysBetween(lastAttempt),
    hasRecentTwoWay: daysBetween(lastTwoWay) !== null && daysBetween(lastTwoWay) <= 14,
    hasSiteActivity14d: daysBetween(lastSiteVisit) !== null && daysBetween(lastSiteVisit) <= 14,
    noAttempt30d: daysBetween(lastAttempt) === null || daysBetween(lastAttempt) > 30,
  };
}

// ── Load known agent IDs from DB ──
async function loadKnownAgentIds() {
  const ids = new Set();
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('agents')
      .select('id')
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Failed to load agents: ${error.message}`);
    for (const row of data) ids.add(row.id);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return ids;
}

async function pullList(listConfig, knownAgentIds) {
  const { fub_list_id, name } = listConfig;
  console.log(`\n── Pulling list: ${name} (${fub_list_id}) ──`);
  const startTime = Date.now();

  const { data: sl } = await supabase
    .from('smart_lists')
    .select('id')
    .eq('id', fub_list_id)
    .single();

  if (!sl) {
    console.error(`  Smart list not found in DB for fub_list_id=${fub_list_id}`);
    return;
  }

  const { data: snap, error: snapErr } = await supabase
    .from('snapshots')
    .insert({
      pull_type: 'scheduled',
      status: 'running',
      smart_list_id: sl.id,
      pull_date: new Date().toISOString().slice(0, 10),
    })
    .select()
    .single();

  if (snapErr) {
    console.error(`  Snapshot create error:`, snapErr.message);
    return;
  }

  const snapshotId = snap.id;
  const agentBuckets = {};
  let url = `https://api.followupboss.com/v1/people?smartListId=${fub_list_id}&limit=100`;
  let pageCount = 0;
  let totalPeople = 0;

  try {
    while (url) {
      pageCount++;
      console.log(`  Page ${pageCount}...`);

      const resp = await fetch(url, { headers: fubHeaders() });
      if (!resp.ok) {
        throw new Error(`FUB API ${resp.status}: ${await resp.text()}`);
      }
      const json = await resp.json();
      const people = json.people || [];

      for (const person of people) {
        const result = processPerson(person);
        if (!result) continue;
        totalPeople++;

        if (!agentBuckets[result.agentId]) {
          agentBuckets[result.agentId] = {
            count: 0, totalDays: 0, daysCount: 0, maxDays: 0,
            noAttempt30d: 0, recentTwoWay: 0, siteActivity14d: 0,
          };
        }
        const b = agentBuckets[result.agentId];
        b.count++;
        if (result.daysSinceLastAttempt !== null) {
          b.totalDays += result.daysSinceLastAttempt;
          b.daysCount++;
          b.maxDays = Math.max(b.maxDays, result.daysSinceLastAttempt);
        }
        if (result.noAttempt30d) b.noAttempt30d++;
        if (result.hasRecentTwoWay) b.recentTwoWay++;
        if (result.hasSiteActivity14d) b.siteActivity14d++;
      }

      url = json._metadata?.nextLink || null;
      if (url) await sleep(200);
    }

    // Filter out agent IDs not in the agents table
    const skippedAgents = [];
    const rows = [];
    for (const [agentId, b] of Object.entries(agentBuckets)) {
      const id = parseInt(agentId);
      if (!knownAgentIds.has(id)) {
        skippedAgents.push(id);
        continue;
      }
      rows.push({
        snapshot_id: snapshotId,
        agent_id: id,
        smart_list_id: sl.id,
        lead_count: b.count,
        avg_days_since_last_attempt: b.daysCount > 0 ? Math.round(b.totalDays / b.daysCount) : null,
        max_days_since_last_attempt: b.maxDays || null,
        leads_with_no_attempt_30d: b.noAttempt30d,
        leads_with_recent_2way: b.recentTwoWay,
        leads_with_site_activity_14d: b.siteActivity14d,
      });
    }

    if (skippedAgents.length > 0) {
      console.log(`  ⚠ Skipped ${skippedAgents.length} unknown agent IDs: ${skippedAgents.join(', ')}`);
    }

    if (rows.length > 0) {
      const { error: insertErr } = await supabase.from('agent_list_counts').insert(rows);
      if (insertErr) throw new Error(`Insert error: ${insertErr.message}`);
    }

    const duration = Date.now() - startTime;
    await supabase.from('snapshots').update({
      status: 'complete', duration_ms: duration, pulled_at: new Date().toISOString(),
    }).eq('id', snapshotId);

    console.log(`  ✓ ${name}: ${totalPeople} leads across ${rows.length} agents (${pageCount} pages, ${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - startTime;
    await supabase.from('snapshots').update({
      status: 'error', error_message: err.message, duration_ms: duration,
    }).eq('id', snapshotId);
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

async function main() {
  console.log('=== FUB Smart List Pull ===');
  console.log(`Time: ${new Date().toISOString()}`);

  // Load known agent IDs once before pulling lists
  console.log('Loading known agents from DB...');
  const knownAgentIds = await loadKnownAgentIds();
  console.log(`Found ${knownAgentIds.size} agents in DB`);

  for (const list of TRACKED_LISTS) {
    await pullList(list, knownAgentIds);
    await sleep(1000);
  }
  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

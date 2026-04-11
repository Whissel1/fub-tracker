/**
 * Debug script: Compare FUB API call counts vs Supabase for a specific agent.
 * Run via: node scripts/debug-call-counts.js
 * Requires: FUB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

const FUB_API_KEY = process.env.FUB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const PAGE_LIMIT = 100;

function fubHeaders() {
  const token = Buffer.from(FUB_API_KEY + ':').toString('base64');
  return { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllCallsSince(since) {
  const allCalls = [];
  let url = `https://api.followupboss.com/v1/calls?limit=${PAGE_LIMIT}&sort=created&createdAfter=${encodeURIComponent(since)}`;
  let pageCount = 0;

  while (url) {
    const resp = await fetch(url, { headers: fubHeaders() });
    if (!resp.ok) throw new Error(`FUB API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const calls = data.calls || [];
    allCalls.push(...calls);
    pageCount++;
    if (calls.length >= PAGE_LIMIT && data._metadata?.nextLink) {
      url = data._metadata.nextLink;
    } else {
      url = null;
    }
    await sleep(150);
  }
  return allCalls;
}

async function main() {
  // Look up target agents
  const { data: agents } = await supabase
    .from('agents')
    .select('id, name')
    .or('name.ilike.%bahar%,name.ilike.%kyle mchale%,name.ilike.%steven nguyen%,name.ilike.%stephen nguyen%');

  console.log('=== Target Agents ===');
  for (const a of agents) console.log(`  ${a.id}: ${a.name}`);
  const targetIds = new Set(agents.map(a => a.id));

  // Fetch 7 days of calls from FUB API
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const sinceStr = since.toISOString();
  console.log(`\n=== Fetching ALL calls from FUB API since ${sinceStr} ===`);

  const allCalls = await fetchAllCallsSince(sinceStr);
  console.log(`Total calls from API: ${allCalls.length}`);

  // Count by agent
  const byAgent = {};
  for (const call of allCalls) {
    if (!targetIds.has(call.userId)) continue;
    if (!byAgent[call.userId]) {
      byAgent[call.userId] = { outbound: 0, inbound: 0, total: 0, byDate: {} };
    }
    const bucket = byAgent[call.userId];
    bucket.total++;
    if (call.isIncoming) bucket.inbound++;
    else bucket.outbound++;

    // Group by date (UTC for comparison)
    const dateKey = call.created?.substring(0, 10) || 'unknown';
    if (!bucket.byDate[dateKey]) bucket.byDate[dateKey] = { out: 0, in: 0 };
    if (call.isIncoming) bucket.byDate[dateKey].in++;
    else bucket.byDate[dateKey].out++;
  }

  console.log('\n=== FUB API Call Counts (last 7 days) ===');
  for (const agent of agents) {
    const counts = byAgent[agent.id];
    if (!counts) {
      console.log(`\n${agent.name} (${agent.id}): NO CALLS IN API`);
      continue;
    }
    console.log(`\n${agent.name} (${agent.id}):`);
    console.log(`  API Total: ${counts.total} (outbound: ${counts.outbound}, inbound: ${counts.inbound})`);
    console.log('  By date (UTC):');
    for (const [date, c] of Object.entries(counts.byDate).sort()) {
      console.log(`    ${date}: out=${c.out}, in=${c.in}`);
    }
  }

  // Now compare with Supabase
  console.log('\n=== Supabase call_daily_stats (last 7 days) ===');
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoff = sevenDaysAgo.toISOString().slice(0, 10);

  for (const agent of agents) {
    const { data: rows } = await supabase
      .from('call_daily_stats')
      .select('call_date, outbound_total, inbound_total')
      .eq('agent_id', agent.id)
      .gte('call_date', cutoff)
      .order('call_date', { ascending: true });

    const totalOut = rows?.reduce((s, r) => s + r.outbound_total, 0) || 0;
    const totalIn = rows?.reduce((s, r) => s + r.inbound_total, 0) || 0;
    console.log(`\n${agent.name} (${agent.id}):`);
    console.log(`  Supabase Total: outbound=${totalOut}, inbound=${totalIn}`);
    for (const r of (rows || [])) {
      console.log(`    ${r.call_date}: out=${r.outbound_total}, in=${r.inbound_total}`);
    }

    // Compare
    const apiCounts = byAgent[agent.id];
    if (apiCounts) {
      const apiOut = apiCounts.outbound;
      const gap = apiOut - totalOut;
      const pct = totalOut > 0 ? Math.round((gap / apiOut) * 100) : 'N/A';
      console.log(`  >>> GAP: API=${apiOut} vs Supabase=${totalOut} (missing ${gap}, ${pct}%)`);
    }
  }

  // Also check cursor
  const { data: cursor } = await supabase.from('call_sync_cursor').select('*').eq('id', 1).single();
  console.log('\n=== Sync Cursor ===');
  console.log(`  last_synced_at: ${cursor.last_synced_at}`);
  console.log(`  last_call_id: ${cursor.last_call_id}`);
  console.log(`  updated_at: ${cursor.updated_at}`);

  // Sample a few raw calls to check fields
  console.log('\n=== Sample Raw Call Objects (first 3 for Bahar) ===');
  const baharId = agents.find(a => a.name.toLowerCase().includes('bahar'))?.id;
  if (baharId) {
    const baharCalls = allCalls.filter(c => c.userId === baharId).slice(0, 3);
    for (const c of baharCalls) {
      console.log(JSON.stringify(c, null, 2));
    }
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

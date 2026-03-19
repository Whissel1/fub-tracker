const { createClient } = require('@supabase/supabase-js');

// ── Config ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const STREAK_START = '2026-02-26';
const STREAK_GOOD_THRESHOLD = 7; // out of 9 lists

// ── Pacific date utility ──
function getPacificDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function getStatus(leadCount, greenMax, yellowMax) {
  if (leadCount <= greenMax) return 'green';
  if (leadCount <= yellowMax) return 'yellow';
  return 'red';
}

function calcStreak(history, thresholds, todayPacific, agentCalls, callsGreenMin) {
  const dayMap = {};
  const dayPresence = {};

  for (const h of history) {
    if (h.date < STREAK_START) continue;
    if (h.date === todayPacific) continue;
    if (!dayMap[h.date]) dayMap[h.date] = new Set();
    if (!dayPresence[h.date]) dayPresence[h.date] = new Set();
    dayPresence[h.date].add(h.list_id);
    const t = thresholds[h.list_id];
    if (t && getStatus(h.lead_count, t.green_max, t.yellow_max) === 'green') {
      dayMap[h.date].add(h.list_id);
    }
  }

  // Missing lists = 0 leads = implicitly green
  const allListIds = Object.keys(thresholds).map(Number);
  for (const date of Object.keys(dayMap)) {
    for (const listId of allListIds) {
      if (!dayPresence[date].has(listId)) {
        dayMap[date].add(listId);
      }
    }
  }

  const sortedDates = Object.keys(dayMap).sort();
  const dailyResults = sortedDates.map(d => {
    const listsGood = dayMap[d].size >= STREAK_GOOD_THRESHOLD;
    const dailyCalls = (agentCalls && agentCalls[d]) || 0;
    const callsGood = dailyCalls >= callsGreenMin;
    return { date: d, good: listsGood && callsGood };
  });

  let current = 0;
  for (let i = dailyResults.length - 1; i >= 0; i--) {
    if (dailyResults[i].good) current++;
    else break;
  }

  let best = 0, run = 0;
  for (const d of dailyResults) {
    if (d.good) { run++; if (run > best) best = run; }
    else run = 0;
  }

  const lastGood = dailyResults.filter(d => d.good).pop();
  return { current, best, last_good_date: lastGood ? lastGood.date : null };
}

async function main() {
  console.log('=== Calculating Streaks ===');
  console.log(`Time: ${new Date().toISOString()}`);
  const todayPacific = getPacificDate();
  console.log(`Pacific date: ${todayPacific}`);

  // 1. Load thresholds
  const { data: thresholdRows, error: tErr } = await supabase.from('thresholds').select('smart_list_id, metric, green_max, yellow_max');
  if (tErr) throw new Error(`Failed to load thresholds: ${tErr.message}`);
  const thresholds = {};
  let callsGreenMin = 5; // default
  for (const t of thresholdRows) {
    if (t.metric === 'calls_per_day') {
      callsGreenMin = t.green_max; // green_max stores the "green if >= X" value
      console.log(`Calls streak threshold: ${callsGreenMin}/day`);
    } else {
      thresholds[t.smart_list_id] = { green_max: t.green_max, yellow_max: t.yellow_max };
    }
  }
  console.log(`Loaded ${Object.keys(thresholds).length} list thresholds`);

  // 2. Load all visible agent IDs
  const { data: agents, error: aErr } = await supabase.from('agents').select('id').eq('visible', true);
  if (aErr) throw new Error(`Failed to load agents: ${aErr.message}`);
  const agentIds = agents.map(a => a.id);
  console.log(`${agentIds.length} visible agents`);

  // 3. Load existing streaks (to preserve best_streak)
  const { data: existingStreaks, error: sErr } = await supabase.from('agent_streaks').select('agent_id, best_streak');
  if (sErr) throw new Error(`Failed to load existing streaks: ${sErr.message}`);
  const storedBest = {};
  for (const s of existingStreaks) storedBest[s.agent_id] = s.best_streak || 0;

  // 4. Load all complete snapshots since STREAK_START
  let allSnaps = [];
  let snapOffset = 0;
  while (true) {
    const { data: page, error: err } = await supabase
      .from('snapshots')
      .select('id, smart_list_id, pull_date')
      .eq('status', 'complete')
      .gte('pull_date', STREAK_START)
      .order('pull_date', { ascending: false })
      .range(snapOffset, snapOffset + 999);
    if (err) throw new Error(`Snapshot query failed: ${err.message}`);
    if (!page || page.length === 0) break;
    allSnaps = allSnaps.concat(page);
    if (page.length < 1000) break;
    snapOffset += 1000;
  }

  // Deduplicate: latest per (smart_list_id, pull_date)
  const seen = new Set();
  const snaps = [];
  for (const s of allSnaps) {
    const key = `${s.smart_list_id}_${s.pull_date}`;
    if (!seen.has(key)) { seen.add(key); snaps.push(s); }
  }
  console.log(`${allSnaps.length} snapshots deduped to ${snaps.length}`);

  const snapIds = snaps.map(s => s.id);
  const snapDateMap = {};
  for (const s of snaps) snapDateMap[s.id] = s.pull_date;

  // 5. Load agent_list_counts — batch snapshot IDs and paginate
  let counts = [];
  const BATCH = 200;
  for (let b = 0; b < snapIds.length; b += BATCH) {
    const batchIds = snapIds.slice(b, b + BATCH);
    let offset = 0;
    while (true) {
      const { data: page, error: err } = await supabase
        .from('agent_list_counts')
        .select('agent_id, smart_list_id, lead_count, snapshot_id')
        .in('snapshot_id', batchIds)
        .range(offset, offset + 999);
      if (err) throw new Error(`Counts query failed: ${err.message}`);
      if (!page || page.length === 0) break;
      counts = counts.concat(page);
      if (page.length < 1000) break;
      offset += 1000;
    }
  }
  console.log(`Loaded ${counts.length} agent_list_counts rows`);

  // 6. Load call_daily_stats since STREAK_START — paginated
  let allCallRows = [];
  let callOffset = 0;
  while (true) {
    const { data: page, error: err } = await supabase
      .from('call_daily_stats')
      .select('agent_id, call_date, outbound_total')
      .gte('call_date', STREAK_START)
      .range(callOffset, callOffset + 999);
    if (err) throw new Error(`Call stats query failed: ${err.message}`);
    if (!page || page.length === 0) break;
    allCallRows = allCallRows.concat(page);
    if (page.length < 1000) break;
    callOffset += 1000;
  }
  // Build daily outbound calls per agent: { agentId: { date: outbound_total } }
  const callsByAgent = {};
  for (const r of allCallRows) {
    if (!callsByAgent[r.agent_id]) callsByAgent[r.agent_id] = {};
    callsByAgent[r.agent_id][r.call_date] = r.outbound_total;
  }
  console.log(`Loaded ${allCallRows.length} call_daily_stats rows for ${Object.keys(callsByAgent).length} agents`);

  // 7. Build history per agent
  const byAgent = {};
  for (const c of counts) {
    if (!byAgent[c.agent_id]) byAgent[c.agent_id] = [];
    byAgent[c.agent_id].push({
      date: snapDateMap[c.snapshot_id],
      list_id: c.smart_list_id,
      lead_count: c.lead_count
    });
  }

  // 7. Calculate streaks and upsert
  const upserts = [];
  for (const id of agentIds) {
    const hist = byAgent[id] || [];
    const agentCalls = callsByAgent[id] || {};
    const result = calcStreak(hist, thresholds, todayPacific, agentCalls, callsGreenMin);
    const durableBest = Math.max(result.best, storedBest[id] || 0);
    upserts.push({
      agent_id: id,
      current_streak: result.current,
      best_streak: durableBest,
      last_good_date: result.last_good_date,
      updated_at: new Date().toISOString()
    });
  }

  if (upserts.length > 0) {
    // Batch upserts in groups of 500
    for (let i = 0; i < upserts.length; i += 500) {
      const batch = upserts.slice(i, i + 500);
      const { error: uErr } = await supabase.from('agent_streaks').upsert(batch, { onConflict: 'agent_id' });
      if (uErr) throw new Error(`Streak upsert failed: ${uErr.message}`);
    }
  }

  console.log(`✓ Updated streaks for ${upserts.length} agents`);
  console.log('=== Done ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

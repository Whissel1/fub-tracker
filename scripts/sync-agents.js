const { createClient } = require('@supabase/supabase-js');

// ── Config ──
const FUB_API_KEY = process.env.FUB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function fubHeaders() {
  const token = Buffer.from(FUB_API_KEY + ':').toString('base64');
  return {
    Authorization: `Basic ${token}`,
    'Content-Type': 'application/json',
    'X-System': 'ExpectationsTracker',
    'X-System-Key': 'expectations-tracker-v1',
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Derive the display role that matches the FUB UI labels.
 *
 * FUB API returns { role, isOwner, teamLeaderOf } — we combine
 * these to produce the correct display role:
 *
 *   Broker + isOwner=true  → Owner
 *   Broker + isOwner=false → Admin
 *   Agent  + teamLeaderOf  → ISA / Team Leader
 *   Agent  (no teams)      → Agent
 *   Lender                 → Lender
 *
 * IMPORTANT: This must stay in sync with the deriveRole() in the
 * sync-agents edge function (supabase/functions/sync-agents/index.ts).
 * See ARCHITECTURE.md for details.
 */
function deriveRole(user) {
  const apiRole = (user.role || '').toLowerCase();

  if (apiRole === 'broker') {
    return user.isOwner ? 'Owner' : 'Admin';
  }
  if (apiRole === 'agent') {
    return user.teamLeaderOf && user.teamLeaderOf.length > 0
      ? 'ISA / Team Leader'
      : 'Agent';
  }
  if (apiRole === 'lender') {
    return 'Lender';
  }
  // Fallback for any unexpected API values
  return user.role || 'Unknown';
}

async function main() {
  console.log('=== Syncing FUB Agents ===');
  const allUsers = [];
  let url = 'https://api.followupboss.com/v1/users?limit=100';
  let pageCount = 0;

  while (url) {
    pageCount++;
    console.log(`  Page ${pageCount}...`);
    const resp = await fetch(url, { headers: fubHeaders() });
    if (!resp.ok) {
      throw new Error(`FUB API ${resp.status}: ${await resp.text()}`);
    }
    const json = await resp.json();
    const users = json.users || [];
    allUsers.push(...users);
    url = json._metadata?.nextLink || null;
    if (url) await sleep(200);
  }

  const rows = allUsers.map((u) => ({
    id: u.id,
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || `User ${u.id}`,
    email: u.email || null,
    role: deriveRole(u),
    team: u.teamName || null,
    is_active: (u.status || '').toLowerCase() === 'active',
    updated_at: new Date().toISOString(),
  }));

  // Build role distribution for logging
  const roleCounts = {};
  for (const r of rows) {
    roleCounts[r.role] = (roleCounts[r.role] || 0) + 1;
  }

  if (rows.length > 0) {
    const { error } = await supabase.from('agents').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`Upsert error: ${error.message}`);
  }

  console.log(`✓ Synced ${rows.length} agents across ${pageCount} pages`);
  console.log(`  Roles:`, roleCounts);
  console.log(`  Active: ${rows.filter((r) => r.is_active).length}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

const { createClient } = require('@supabase/supabase-js');

const FUB_API_KEY = process.env.FUB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function fubHeaders() {
  const token = Buffer.from(FUB_API_KEY + ':').toString('base64');
  return {
    Authorization: `Basic ${token}`,
    'Content-Type': 'application/json',
    'X-System': 'WhisselTracker',
    'X-System-Key': 'fub-tracker-v1',
  };
}

async function main() {
  console.log('=== Syncing FUB Agents ===');

  const resp = await fetch('https://api.followupboss.com/v1/users?limit=100', {
    headers: fubHeaders(),
  });

  if (!resp.ok) {
    throw new Error(`FUB API ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();
  const users = json.users || [];

  const rows = users.map((u) => ({
    fub_user_id: u.id,
    name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
    email: u.email || null,
    role: u.role || null,
    is_active: u.status === 'active',
  }));

  const { error } = await supabase
    .from('agents')
    .upsert(rows, { onConflict: 'fub_user_id' });

  if (error) throw new Error(`Upsert error: ${error.message}`);

  console.log(`✓ Synced ${rows.length} agents`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

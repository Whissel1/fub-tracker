# FUB Expectations Tracker — Architecture Guide

> **Last updated:** 2026-03-04
>
> This document is the single source of truth for how the system is built,
> how data flows, what runs where, and why. Read this before making changes.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Scheduling & Automation](#scheduling--automation)
3. [Data Flow](#data-flow)
4. [Database Schema](#database-schema)
5. [Scripts (GitHub Actions)](#scripts-github-actions)
6. [Edge Functions (Supabase)](#edge-functions-supabase)
7. [Frontend Dashboard](#frontend-dashboard)
8. [Deployment](#deployment)
9. [Business Logic: Role Derivation](#business-logic-role-derivation)
10. [Business Logic: Call Aggregation](#business-logic-call-aggregation)
11. [Business Logic: Streaks](#business-logic-streaks)
12. [Data Retention](#data-retention)
13. [Secrets & Environment Variables](#secrets--environment-variables)
14. [Troubleshooting](#troubleshooting)
15. [Lessons Learned](#lessons-learned)

---

## System Overview

The Expectations Tracker pulls data from **Follow Up Boss (FUB)** into
**Supabase** (Postgres), then renders a single-page dashboard that shows
agent performance across SmartLists and call activity.

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────┐
│  FUB API     │────▶│  GitHub Actions      │────▶│  Supabase    │
│  /v1/people  │     │  (Node.js scripts)   │     │  (Postgres)  │
│  /v1/calls   │     │  Every 15 min        │     │              │
│  /v1/users   │     └─────────────────────┘     │              │
└──────────────┘                                  │              │
                     ┌─────────────────────┐     │              │
                     │  Edge Functions      │────▶│              │
                     │  (Deno/TypeScript)   │     │              │
                     │  On-demand only      │     └──────┬───────┘
                     └─────────────────────┘            │
                                                        │
                     ┌─────────────────────┐            │
                     │  GitHub Pages        │◀───────────┘
                     │  docs/progress.html  │  (Supabase JS client)
                     │  Static dashboard    │
                     └─────────────────────┘
```

**Key principle:** GitHub Actions is the **only** scheduler. No pg_cron,
no external cron services. Edge functions exist for manual/on-demand use
only (dashboard buttons, future webhooks). See [Lessons Learned](#lessons-learned).

---

## Scheduling & Automation

### GitHub Actions Workflow

**File:** `.github/workflows/pull-fub-data.yml`

Three cron entries combine to provide **every-15-minute** refreshes
throughout the business day. All times in UTC (PST/PDT offsets shown):

| UTC Cron                 | PST Time           | PDT Time           | What Runs                              |
|--------------------------|--------------------|--------------------|----------------------------------------|
| `0 11 * * *`            | 3:00 AM            | 4:00 AM            | Agent sync + Call data (overnight)     |
| `*/15 0,14-23 * * *`    | 6:00 AM – 4:45 PM  | 7:00 AM – 5:45 PM  | Calls + SmartLists (every 15 min)      |
| `0 1 * * *`             | 5:00 PM            | 6:00 PM            | Calls + SmartLists (final run)         |

**Runs per day:** ~46 (1 agent sync + 44 business-hours + 1 final).

**Why 15-minute intervals?** Calls = effort, SmartLists = results. Team
leads monitor both in real time. The incremental cursor-based call sync is
extremely lightweight (~seconds for a few dozen new calls). SmartList pulls
are heavier (~30–60s per run for 9 lists × pagination) but well within the
30-minute timeout and FUB API limits.

**GitHub Actions minutes budget:** ~46 runs/day × ~1.5 min avg ≈ 70 min/day
≈ 2,100 min/month. Close to the free tier (2,000 min/month for private
repos). If overages occur, reduce to `*/20` or use GitHub's paid tier.

**Manual trigger** (`workflow_dispatch`) runs ALL steps.

**Conditional execution:**
- **Agent sync** runs only at 3am (roles don't change intraday)
- **Call data** runs on every trigger (incremental, fast)
- **SmartList snapshots** run on every business-day trigger (skip 3am overnight run)

```yaml
- name: Sync agents
  if: github.event.schedule == '0 11 * * *' || github.event_name == 'workflow_dispatch'
  run: node scripts/sync-agents.js
```

### DST Note

UTC crons are fixed. During Pacific Daylight Time (Mar–Nov), local times
shift 1 hour later. The 3am PST agent sync fires at 4am PDT. This is
acceptable — the data is from the previous day regardless.

### What Does NOT Schedule

- **pg_cron**: Removed. Was previously broken due to misconfigured
  `current_setting()` calls. Do not recreate. See [Lessons Learned](#lessons-learned).
- **External cron services**: Not used.
- **Edge function schedules**: Edge functions are invoked on-demand only.

---

## Data Flow

### Agent Sync (daily at 3am PST)

```
FUB /v1/users → scripts/sync-agents.js → agents table
```

1. Paginate through all FUB users (100 per page)
2. Apply `deriveRole()` to map API roles to display roles
3. Upsert into `agents` table on conflict `id`

### Call Data Pull (every 15 min, 3am + 6am–5pm PST)

```
FUB /v1/calls → scripts/pull-fub-calls.js → call_daily_stats table
```

1. Read `call_sync_cursor` for last sync timestamp
2. Fetch all calls created after that timestamp (paginated)
3. Convert call timestamps to **Pacific time** before date bucketing
4. Aggregate into daily buckets per agent (outbound/inbound counts,
   durations, conversations)
5. Upsert into `call_daily_stats` on conflict `(agent_id, call_date)`
6. Advance cursor to latest call's `created` timestamp

**Timezone handling:** FUB returns UTC timestamps. The `datePacific()`
function converts to `America/Los_Angeles` before extracting the date,
so a call at 5pm Pacific on 3/3 (which is `2026-03-04T01:00:00Z` in UTC)
correctly buckets as 2026-03-03, not 2026-03-04.

**Conversation threshold:** 120 seconds. Any call >= 2 minutes counts as
a "conversation" in outbound_conversations / inbound_conversations.

### SmartList Snapshot (every 15 min, 6am–5pm PST)

```
FUB /v1/people?smartListId=X → scripts/pull-fub-data.js → snapshots + agent_list_counts
```

1. Load known agent IDs from `agents` table
2. For each of 9 tracked SmartLists:
   a. Create a `snapshots` row (status: running)
   b. Paginate through all people in that SmartList
   c. Aggregate per agent: lead count, days since last attempt, etc.
   d. Insert rows into `agent_list_counts`
   e. Update snapshot status to complete (or error)

### Streak Calculation

Streaks are computed client-side in `progress.html` when the dashboard
loads. The `agent_streaks` table stores the last computed result for
persistence. Streak data is independent of raw snapshot data — deleting
old snapshots does not break streaks.

---

## Database Schema

**Supabase Project:** `ndicmtqagcgtbqtxaxwb`

### `agents`

Agent roster synced from FUB. Source of truth for agent identity.

| Column      | Type      | Notes                                    |
|-------------|-----------|------------------------------------------|
| id          | int (PK)  | FUB user ID                              |
| name        | text      | First + Last from FUB                    |
| email       | text      | Nullable                                 |
| role        | text      | Derived role (see Role Derivation below) |
| team        | text      | FUB team name, nullable                  |
| is_active   | boolean   | Synced from FUB status field             |
| visible     | boolean   | Manual dashboard toggle (default true)   |
| created_at  | timestamp | Auto                                     |
| updated_at  | timestamp | Set on each sync                         |

`is_active` = automated (from FUB). `visible` = manual (admin toggle in
Manage Agents modal). Dashboard shows agents where `visible = true`.

**RLS Policies:**

| Policy Name                | Operation | Role         | Notes                                      |
|----------------------------|-----------|--------------|--------------------------------------------|
| `Allow read access`        | SELECT    | public       | Dashboard reads via anon key               |
| `Service role full access` | ALL       | service_role | GitHub Actions scripts use service role key |
| `Allow anon update visible`| UPDATE    | anon         | Manage Agents toggle writes via anon key   |

⚠️ The anon UPDATE policy is intentionally broad (allows updating any
column, not just `visible`). This should be tightened to a column-specific
check when auth is implemented. See BACKLOG.md → "Tighten Agents Table
RLS Policy".

### `smart_lists`

Static reference table for the 9 tracked SmartLists.

| Column     | Type     | Notes                      |
|------------|----------|----------------------------|
| id         | int (PK) | Matches FUB SmartList ID   |
| name       | text     | Display name               |
| category   | text     | Grouping                   |
| sort_order | int      | Display ordering           |
| is_tracked | boolean  | Whether actively pulled    |

### `thresholds`

Green/yellow/red thresholds per SmartList for the dashboard heatmap.

| Column       | Type     | Notes                         |
|--------------|----------|-------------------------------|
| id           | int (PK) | Auto                          |
| smart_list_id| int (FK) | → smart_lists.id              |
| metric       | text     | Default 'count'               |
| green_max    | int      | <= this = green               |
| yellow_max   | int      | <= this = yellow, else red    |
| notes        | text     | Nullable                      |
| updated_by   | text     | Nullable                      |

### `snapshots`

One row per SmartList pull. Tracks pull metadata and status.

| Column        | Type      | Notes                                       |
|---------------|-----------|---------------------------------------------|
| id            | int (PK)  | Auto                                        |
| pulled_at     | timestamp | When pull completed                         |
| pull_type     | text      | morning / evening / manual / scheduled      |
| pull_date     | date      | Calendar date of pull                       |
| status        | text      | running / complete / error                  |
| smart_list_id | int (FK)  | → smart_lists.id                            |
| duration_ms   | int       | How long the pull took                      |
| error_message | text      | Nullable, populated on error                |

### `agent_list_counts`

Per-agent, per-SmartList aggregated data for each snapshot.

| Column                        | Type     | Notes                       |
|-------------------------------|----------|-----------------------------|
| id                            | int (PK) | Auto                        |
| snapshot_id                   | int (FK) | → snapshots.id              |
| agent_id                      | int (FK) | → agents.id                 |
| smart_list_id                 | int (FK) | → smart_lists.id            |
| lead_count                    | int      | Total leads assigned        |
| avg_days_since_last_attempt   | int      | Nullable                    |
| max_days_since_last_attempt   | int      | Nullable                    |
| leads_with_no_attempt_30d     | int      | Count of stale leads        |
| leads_with_recent_2way        | int      | Two-way comms in last 14d   |
| leads_with_site_activity_14d  | int      | Site visits in last 14d     |

### `agent_streaks`

Computed streak data. Independent of raw snapshot data.

| Column          | Type      | Notes                       |
|-----------------|-----------|-----------------------------|
| agent_id        | int (PK)  | FK → agents.id              |
| current_streak  | int       | Consecutive good days       |
| best_streak     | int       | All-time best               |
| last_good_date  | date      | Most recent qualifying day  |
| updated_at      | timestamp | Last recomputation          |

### `call_daily_stats`

Daily call aggregates per agent. Upserted on `(agent_id, call_date)`.

| Column                   | Type      | Notes                    |
|--------------------------|-----------|--------------------------|
| id                       | int (PK)  | Identity column          |
| agent_id                 | int       | FUB user ID              |
| call_date                | date      | Calendar date            |
| outbound_total           | int       | Total outbound calls     |
| inbound_total            | int       | Total inbound calls      |
| outbound_duration_sec    | int       | Total seconds outbound   |
| inbound_duration_sec     | int       | Total seconds inbound    |
| outbound_conversations   | int       | Calls >= 120s outbound   |
| inbound_conversations    | int       | Calls >= 120s inbound    |
| created_at               | timestamp | Auto                     |
| updated_at               | timestamp | Set on each upsert       |

**Unique constraint:** `(agent_id, call_date)` — allows upsert.

### `call_sync_cursor`

Singleton row (id=1) tracking incremental call sync position.

| Column         | Type      | Notes                          |
|----------------|-----------|--------------------------------|
| id             | int (PK)  | Always 1 (CHECK constraint)    |
| last_synced_at | timestamp | Cursor: fetch calls after this |
| last_call_id   | int       | Last processed call ID         |
| updated_at     | timestamp | Last cursor advance            |

### `lead_details`

Reserved for future per-lead detail storage. Currently empty (0 rows).

---

## Scripts (GitHub Actions)

These Node.js scripts run in GitHub Actions. They are the **primary**
automation and the only scheduled data pipeline.

### `scripts/sync-agents.js`

- Fetches all users from FUB `/v1/users`
- Applies `deriveRole()` (see below)
- Upserts into `agents` table
- Rate limited: 200ms between pages

### `scripts/pull-fub-calls.js`

- Reads cursor from `call_sync_cursor`
- Fetches calls from FUB `/v1/calls?createdAfter=...`
- Aggregates into daily buckets per agent
- Upserts into `call_daily_stats` (batches of 500)
- Advances cursor
- Rate limited: 120ms between pages (~8 req/sec)

### `scripts/pull-fub-data.js`

- Loads known agent IDs from `agents` table
- Iterates 9 tracked SmartLists (hardcoded in `TRACKED_LISTS` array)
- For each: creates snapshot, paginates FUB people, aggregates, inserts
- Skips agent IDs not in the `agents` table (logs warning)
- Rate limited: 200ms between pages, 1s between lists

### Adding a New SmartList

1. Add to `TRACKED_LISTS` array in `scripts/pull-fub-data.js`
2. Insert corresponding row in `smart_lists` table
3. Insert threshold row in `thresholds` table
4. Dashboard picks it up automatically on next load

---

## Edge Functions (Supabase)

Edge functions are **NOT scheduled**. They exist for on-demand use:
manual triggers from the dashboard, debugging, or future webhook
integrations.

| Function          | Version | JWT  | Purpose                        |
|-------------------|---------|------|--------------------------------|
| `pull-fub-data`   | v5      | OFF  | Manual SmartList pull          |
| `sync-agents`     | v7      | OFF  | Manual agent sync              |
| `pull-fub-calls`  | v2      | OFF  | Manual call data pull          |
| `debug-fub-calls` | v1      | ON   | Debug tool for call API        |

**CRITICAL:** The edge functions and Node.js scripts implement the same
business logic independently. Changes to business logic (like role
derivation, call aggregation thresholds, SmartList processing) **must be
applied to both**. Each file contains a comment noting its mirror.

### Why Both Exist

- **GitHub Actions (Node.js):** Reliable scheduled execution. Runs on
  Ubuntu, has access to secrets, produces logs in GitHub.
- **Edge Functions (Deno):** Instant invocation from dashboard or API.
  No cold start for the user, no CI/CD pipeline needed for manual runs.

---

## Frontend Dashboard

### `docs/progress.html`

Single-file static HTML/CSS/JS application served via GitHub Pages.
Contains all UI logic, Supabase queries, and rendering.

**Key components:**

- **Matrix table:** Agents × SmartLists heatmap with color coding
- **Drawer:** Slide-out panel with agent detail (calls, streaks, trends)
- **Call Activity section:** 7-day outbound chart, daily breakdown table
- **Streak dots:** Last 7 days pass/fail visualization
- **Lead Count Trend:** Sparkline chart with 7d/14d/30d toggle
- **Manage Agents modal:** Toggle agent visibility on dashboard
- **Threshold editor:** Inline editing of green/yellow/red thresholds

### Supabase Access from the Frontend

The dashboard connects to Supabase using the **anon key** via the
Supabase JS client (`createClient(SUPABASE_URL, SUPABASE_ANON_KEY)`).
This means all frontend database operations are subject to **Row Level
Security (RLS)** policies. The anon key can:

- **SELECT** from `agents`, `smart_lists`, `thresholds`, `snapshots`,
  `agent_list_counts`, `call_daily_stats`, `agent_streaks`
- **UPDATE** the `agents` table (for the Manage Agents visibility toggle)

It **cannot** INSERT, DELETE, or modify any other table. All write-heavy
operations (syncing agents, pulling calls, pulling SmartLists) go through
GitHub Actions using the **service role key**, which bypasses RLS.

**Important:** Supabase silently returns empty results (no error) when an
RLS-denied operation is attempted. This makes debugging RLS issues
non-obvious — the operation appears to succeed but nothing is persisted.

### `docs/index.html`

Landing page / entry point. Redirects or links to `progress.html`.

---

## Deployment

### Frontend (GitHub Pages)

- Source: `docs/` directory on `main` branch
- URL: `https://whissel1.github.io/fub-tracker/progress.html`
- Deploys automatically on push to `main`

### Backend (Supabase)

- Project: `ndicmtqagcgtbqtxaxwb`
- Region: us-east-1
- Edge functions deployed via `supabase functions deploy`

### GitHub Actions

- Workflow file: `.github/workflows/pull-fub-data.yml`
- Runs on: `ubuntu-latest`
- Node.js version: 20
- Timeout: 30 minutes

---

## Business Logic: Role Derivation

FUB's API returns a raw `role` field plus `isOwner` and `teamLeaderOf`.
These must be combined to produce the display role:

```
FUB API fields          →  Display Role
─────────────────────────────────────────
role=broker, isOwner    →  Owner
role=broker, !isOwner   →  Admin
role=agent, teamLeader  →  ISA / Team Leader
role=agent, no teams    →  Agent
role=lender             →  Lender
```

**This logic exists in TWO places** that must stay in sync:

1. `scripts/sync-agents.js` → `deriveRole()` function
2. `supabase/functions/sync-agents/index.ts` → `deriveRole()` function

If you change role derivation, update both files and test.

---

## Business Logic: Call Aggregation

Calls are pulled incrementally from FUB `/v1/calls` using a cursor.
Each call is classified:

- **Direction:** `isIncoming` (true = inbound, false = outbound)
- **Conversation:** `duration >= 120 seconds` (2 minutes)

Aggregated into daily buckets per agent with 6 metrics:
`outbound_total`, `inbound_total`, `outbound_duration_sec`,
`inbound_duration_sec`, `outbound_conversations`, `inbound_conversations`

The dashboard displays a **7-day rolling average** of outbound calls per
day (`outPerDay`), shown as a whole number (rounded, not decimal).

**This logic exists in TWO places:**

1. `scripts/pull-fub-calls.js` (Node.js, GitHub Actions)
2. `supabase/functions/pull-fub-calls/index.ts` (Deno, edge function)

---

## Business Logic: Streaks

A "good day" = agent meets threshold on 7+ out of 9 SmartLists
(`STREAK_GOOD_THRESHOLD = 7`). The streak counter tracks consecutive
good days ending at the most recent date. Data starts from
`STREAK_START = '2026-02-26'`.

### Calculation: `calcStreakFromSnapshots(history)`

Takes an array of `agent_list_counts` rows and returns `{ current, best,
dailyResults }`. The function deduplicates by list_id per day using a
`Set` — if a list appears green in ANY snapshot on a given day, the agent
gets credit for that list once. This prevents double-counting when
multiple snapshots exist per day (the system pulls ~2 snapshots/day per
SmartList, so without dedup an agent with 4 green lists would register
as 8).

`current` = consecutive good days counting backward from the most recent
date. `best` = longest consecutive run across all dates. `dailyResults`
= array of `{ date, good }` objects for the dot trail.

### Streak Tiers

| Range   | Label      | Color   |
|---------|------------|---------|
| 1–6     | Building   | #f4a261 |
| 7–13    | Consistent | #2a9d8f |
| 14–29   | Strong     | #264653 |
| 30+     | Elite      | #e63946 |

### Data Flow

1. **Page load** → `loadAllStreaks()` fetches `agent_list_counts` for all
   agents, runs `calcStreakFromSnapshots()` for each, upserts results into
   `agent_streaks` DB table, and populates the in-memory `streakData` map.
   Recalculation runs on every page load (no staleness caching) to ensure
   correctness as new snapshots arrive throughout the day.

2. **Matrix table** → `updateStreakCells()` reads from `streakData` map to
   render mini-rings in each agent's streak column.

3. **Agent drawer** → `renderDrawerStreak()` uses on-the-fly
   `calcStreakFromSnapshots()` for BOTH the ring number AND the dot trail.
   This guarantees the ring and dots always agree (single source of truth).
   The drawer fetches its own history via `loadDrawerHistory()` which uses
   `pulled_at` timestamp filters vs the date-based `pull_date` filter in
   `loadAllStreaks`, but `calcStreakFromSnapshots` deduplicates by list_id
   regardless of how many rows per day exist.

### Storage: `agent_streaks` Table

Streak data is stored in `agent_streaks` and is **independent** of raw
snapshot data. Deleting old `snapshots` and `agent_list_counts` rows does
not impact streak scores (the DB values are recalculated from current
data on each page load and upserted).

---

## Data Retention

### Current Data Volumes (as of 2026-03-03)

| Table              | Rows    | Growth Rate          |
|--------------------|---------|----------------------|
| agents             | ~242    | Stable               |
| smart_lists        | 9       | Static               |
| thresholds         | 9       | Static               |
| snapshots          | ~117    | ~405/day (9 lists × 45 runs) |
| agent_list_counts  | ~10,600 | ~10,000/day          |
| call_daily_stats   | ~564    | ~40/day (upsert, not append) |
| agent_streaks      | ~165    | Stable               |

### Retention Strategy

- **agent_list_counts + snapshots:** Safe to delete rows older than 6
  months. Streaks are not impacted. The dashboard primarily uses last
  30 days. Historical data beyond 6 months has no current use case.
- **call_daily_stats:** Safe to delete rows older than 6 months. The
  dashboard shows a 7-day rolling window.
- **agents, smart_lists, thresholds:** Never delete. Reference data.
- **agent_streaks:** Never delete. Contains computed aggregates.
- **call_sync_cursor:** Never delete. Single row, always needed.

### Future: Automated Cleanup

Consider a monthly GitHub Action or SQL function that runs:

```sql
-- Delete SmartList snapshot data older than 6 months
DELETE FROM agent_list_counts
WHERE snapshot_id IN (
  SELECT id FROM snapshots
  WHERE pulled_at < NOW() - INTERVAL '6 months'
);
DELETE FROM snapshots WHERE pulled_at < NOW() - INTERVAL '6 months';

-- Delete call data older than 6 months
DELETE FROM call_daily_stats
WHERE call_date < CURRENT_DATE - INTERVAL '6 months';
```

---

## Secrets & Environment Variables

### GitHub Actions Secrets

| Secret                    | Purpose                              |
|---------------------------|--------------------------------------|
| `FUB_API_KEY`             | Follow Up Boss API key (Basic auth)  |
| `SUPABASE_URL`            | Supabase project URL                 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (admin)  |

### Supabase Edge Function Secrets

Same three values, set via `supabase secrets set`:

- `FUB_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### FUB API Authentication

Basic auth with API key as username, empty password:

```
Authorization: Basic base64(API_KEY + ':')
```

Custom headers included for FUB's system identification:

```
X-System: ExpectationsTracker
X-System-Key: expectations-tracker-v1
```

---

## Troubleshooting

### "Dashboard shows stale data"

1. Check GitHub Actions: go to repo → Actions → FUB Data Sync
2. Look for failed runs. Common causes:
   - FUB API rate limit (429) — increase `RATE_LIMIT_DELAY_MS`
   - Expired/invalid `FUB_API_KEY`
   - Supabase down or service key rotated
3. Manual trigger: click "Run workflow" on the Actions page

### "Agent roles are wrong"

1. Roles are derived from FUB API fields, not stored directly
2. `deriveRole()` runs on each sync — check if sync has run recently
3. If role logic is wrong, update BOTH `scripts/sync-agents.js` AND
   the edge function `sync-agents/index.ts`
4. After fixing, trigger a manual workflow run

### "Call data not updating"

1. Check `call_sync_cursor`: `SELECT * FROM call_sync_cursor;`
2. If `last_synced_at` is recent, there may genuinely be no new calls
3. If stuck, you can manually reset the cursor:
   ```sql
   UPDATE call_sync_cursor
   SET last_synced_at = '2026-01-01T00:00:00Z'
   WHERE id = 1;
   ```
4. Then trigger a manual workflow run

### "New SmartList not appearing"

1. Add to `TRACKED_LISTS` in `scripts/pull-fub-data.js`
2. Insert row into `smart_lists` table
3. Insert threshold into `thresholds` table
4. Push changes and wait for next scheduled run (or manual trigger)

### "Agent not showing on dashboard"

1. Check `agents` table: `SELECT visible, is_active FROM agents WHERE name LIKE '%Name%';`
2. `visible = false` → toggled off in Manage Agents modal
3. `is_active = false` → marked inactive in FUB
4. Agent ID not in `agents` table → sync hasn't run or user is new

---

## Lessons Learned

### The Dual Automation Incident (March 2026)

**What happened:** The system was built with two independent automation
mechanisms:

1. **GitHub Actions** (`.github/workflows/pull-fub-data.yml`) — ran
   Node.js scripts on a cron schedule
2. **Supabase pg_cron** — attempted to invoke edge functions via
   `net.http_post()`

The pg_cron jobs were broken from day one due to using
`current_setting('app.settings.supabase_url')` which was never
configured. This was invisible because GitHub Actions was successfully
running the same data pulls via a completely separate code path (Node.js
scripts vs. Deno edge functions).

When the pg_cron breakage was discovered, we initially assumed ALL
automation was broken and attempted to fix pg_cron — when in reality
the data had been flowing fine through GitHub Actions the entire time.

**Root cause:** No single document explained which system was
responsible for what. Two parallel implementations existed without clear
ownership documentation.

**Resolution:**

1. Removed all pg_cron jobs
2. Consolidated all scheduling into GitHub Actions (single source of truth)
3. Kept edge functions for on-demand use only
4. Created this document

**Lesson:** For any scheduled task, there must be exactly ONE scheduler
clearly documented. If you need redundancy, build it into the same
system (e.g., retry logic in the GitHub Action), not by adding a second
independent scheduler.

### The Role Overwrite Bug (March 2026)

**What happened:** The `sync-agents` edge function was updated with
`deriveRole()` to correctly map FUB roles (Broker→Owner/Admin, etc.).
But the GitHub Action's `scripts/sync-agents.js` still used raw FUB
roles (`u.role || null`). Since the GitHub Action ran daily, it would
overwrite the corrected roles every morning.

**Root cause:** Two implementations of the same logic without
cross-referencing or shared business logic.

**Resolution:** Ported `deriveRole()` to the Node.js script. Added
comments in both files pointing to each other.

**Lesson:** When business logic exists in multiple files, each file must
contain a comment pointing to its mirror. Any change to one requires
changing the other. Consider extracting shared logic into a common
module if it diverges again.

---

## Tracked SmartLists

| FUB List ID | Name                    |
|-------------|-------------------------|
| 1100        | New Opportunities       |
| 1078        | High Intent             |
| 1079        | Browsing                |
| 1083        | Attempted 0-7 Days      |
| 1084        | Attempted 8-30 Days     |
| 1086        | Spoke - Need Appointment|
| 1089        | Met - Stay Close        |
| 1105        | Showing Homes           |
| 1106        | Submitting Offers       |

---

## FUB API Rate Limits

FUB allows **250 requests per 10 seconds** per API key.

Current rate limiting in scripts:

| Script              | Delay Between Pages | Effective Rate  |
|---------------------|---------------------|-----------------|
| `sync-agents.js`    | 200ms               | ~5 req/sec      |
| `pull-fub-calls.js` | 120ms               | ~8 req/sec      |
| `pull-fub-data.js`  | 200ms (+ 1s/list)   | ~5 req/sec      |

All well within limits. If you need to increase throughput, the limit is
~25 req/sec safely.

---

## Repository Structure

```
fub-tracker/
├── .github/
│   └── workflows/
│       └── pull-fub-data.yml    ← GitHub Actions workflow (SCHEDULER)
├── docs/
│   ├── index.html               ← Landing page
│   └── progress.html            ← Dashboard app (single file)
├── scripts/
│   ├── sync-agents.js           ← Agent sync (Node.js)
│   ├── pull-fub-calls.js        ← Call data pull (Node.js)
│   └── pull-fub-data.js         ← SmartList pull (Node.js)
├── ARCHITECTURE.md              ← This file
├── BACKLOG.md                   ← Living backlog (features, bugs, ideas)
├── package.json                 ← Dependencies (@supabase/supabase-js)
└── README.md                    ← Project overview
```

Edge functions are deployed to Supabase separately and are not stored in
this repository. They live in the Supabase dashboard under Edge Functions.

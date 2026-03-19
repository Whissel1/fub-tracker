# FUB Expectations Tracker — Backlog

> **Owner:** Claude (updated each session)
> **Last updated:** 2026-03-18
>
> This is the living backlog for the project. Every feature request,
> bug, and idea gets captured here — whether it ships now or never.
> Items only leave this file when they're shipped or explicitly killed.

---

## Shipped

_Completed items moved here with ship date for reference._

| Date | Item |
|------|------|
| 2026-03-03 | Call volume feature (outbound/inbound, 7-day rolling avg, per-agent) |
| 2026-03-03 | Round Calls/Day to whole numbers |
| 2026-03-03 | Help icon tooltip on Calls/Day column header |
| 2026-03-03 | Show 0s (not dashes) for agents with no call data |
| 2026-03-03 | Daily breakdown scroll container with sticky headers |
| 2026-03-03 | Lead Count Trend 7d/14d/30d toggle fix (full date range) |
| 2026-03-03 | Remove redundant drawer status bar |
| 2026-03-03 | Reorder drawer sections (calls → streak → chart → table) |
| 2026-03-03 | Streak dots "X/7 good" label |
| 2026-03-03 | Agent role sync fix (deriveRole in edge fn + sync script) |
| 2026-03-03 | Manage Agents modal (visibility toggle + save flash) |
| 2026-03-04 | Consolidate all automation to GitHub Actions (remove pg_cron) |
| 2026-03-04 | Fix sync-agents.js overwriting derived roles |
| 2026-03-04 | Create pull-fub-calls.js for GH Actions |
| 2026-03-04 | Fix timezone bug (dateOnly → datePacific) |
| 2026-03-04 | ARCHITECTURE.md (~710 lines) |
| 2026-03-04 | Upgrade to 15-min refresh intervals (6am–5pm PST) |
| 2026-03-04 | Latest pull timestamp display (Pacific time, full datetime) |
| 2026-03-04 | Fix Manage Agents toggle persistence (RLS policy for anon UPDATE) |
| 2026-03-04 | Fix streak ring/dots mismatch (Set-based dedup, unified data source, remove staleness cache) |
| 2026-03-04 | Fix matrix vs drawer streak divergence (Supabase row limit + pull_date filter consistency) |
| 2026-03-04 | Purge stale agent_streaks cache, add error checking to loadAllStreaks, add no-cache meta tags |
| 2026-03-04 | Fix Supabase 1000-row server cap — paginated `loadAllStreaks` fetches all ~11K rows across multiple `.range()` requests |
| 2026-03-04 | Exclude current day (Pacific time) from streak calculation — incomplete days don't count for or against |
| 2026-03-04 | Durable best_streak — `Math.max(computed, stored)` ensures best streak is never lowered even if raw data is pruned |
| 2026-03-04 | Fix streak calc: treat missing SmartList data as implicitly green — agents with 0 leads (no `agent_list_counts` row) now count as green via `dayPresence` tracking |
| 2026-03-04 | Drawer panel design overhaul — 3-zone header (name / compact streak / range toggle + controls), move subtitle under Lead Count Trend, visual divider between Call Activity and Lead Count, Call Activity title matched to section style (17px Playfair bold), compact 40px streak ring with dot trail in header |
| 2026-03-04 | Streak widget visual enhancement — tier-colored pill container (background + border tint), 48px ring with 4px stroke, 8px dots, tier label ("Building"/"Consistent"/"Strong"/"Elite"), progressive visual impact by tier |
| 2026-03-04 | Streak column help tooltip — ⓘ icon with explanation: "Consecutive days with 7+ of 9 Smart Lists green. Resets on any day below that." |
| 2026-03-14 | Fix call stats overwrite bug — sync from midnight UTC of cursor's Pacific date instead of exact cursor timestamp |
| 2026-03-18 | Fix call data pagination — Supabase PostgREST 1000-row server cap was silently truncating call data. Switched to `.range()` pagination for call_daily_stats and agent_list_counts queries |
| 2026-03-18 | Fix agent_list_counts pagination — same 1000-row cap issue, paginated with `.range()` |
| 2026-03-18 | Auto-hide inactive agents — `sync-agents.js` now sets `visible: false` when `is_active` becomes false |
| 2026-03-18 | Snapshot bloat eliminated — switched `pull-fub-data.js` to upsert model (one snapshot per list per day). Reduced from ~600 snapshots/day to 9. Includes `pull_date` fix to use Pacific timezone |
| 2026-03-18 | Fix `maxDays` falsy-zero bug — `b.maxDays \|\| null` misreported 0 as null. Fixed to `b.daysCount > 0 ? b.maxDays : null` |
| 2026-03-18 | Add workflow concurrency group — prevents duplicate parallel runs from overlapping cron schedules. Consolidated cron expressions |
| 2026-03-18 | Fix streak query truncation — paginated snapshot fetch with deduplication, batched `.in()` calls to avoid PostgREST URL length limits |
| 2026-03-18 | Fix drawer chart memory leak — track and destroy Chart.js instances on drawer close/reopen |
| 2026-03-18 | Load Chart.js annotation plugin — average line on call chart now renders (was silently failing) |
| 2026-03-18 | Pacific timezone for all frontend dates — new `getPacificDate()`/`getPacificDaysAgo()` utilities replace all UTC-based `toISOString().slice()` patterns. Fixes off-by-one near midnight for San Diego team |
| 2026-03-18 | 429 rate-limit retry — `fetchWithRetry()` added to all 3 backend scripts (pull-fub-calls, pull-fub-data, sync-agents). Retries up to 3x with Retry-After backoff |
| 2026-03-18 | Move streak calculation to backend — new `scripts/calc-streaks.js` runs server-side in GitHub Actions after smart list pulls. Frontend now reads pre-computed values (no more writes from browser) |
| 2026-03-18 | Fix `en-CA` date formatting — replaced locale-dependent `toLocaleDateString('en-CA')` with explicit `Intl.DateTimeFormat` in pull-fub-calls.js |
| 2026-03-18 | Dead code cleanup — removed empty CSS rule, unused `prevDate` variable, replaced DOM-based `escHTML` with regex, replaced `buildMatrix(allAgentRows)` with `Set.size` |
| 2026-03-18 | Fix call average dilution — drawer now divides by actual days with data instead of `drawerRange` |
| 2026-03-18 | Fix sort after async data loads — matrix re-sorts when streak/call data arrives if sorted by those columns |
| 2026-03-18 | Prune historical snapshot bloat — one-time SQL cleanup: 213K → 18K rows in agent_list_counts, 2,385 → 198 snapshots. Kept most complete snapshot per list per day |
| 2026-03-19 | Calls/Day threshold color coding — green ≥ 5, yellow ≥ 3, red < 3. Thresholds stored in DB (editable). Tooltip shows current values |

---

## Active Backlog

### Features

#### Communication Channel Breakdown
**Priority:** TBD
**Status:** Not started
**Depends on:** FUB API support for text/email activity at agent level

Break out calls vs. texts vs. emails separately. Call volume is built — texts and emails are not. Need to verify what FUB's API exposes for text and email activity with enough granularity to be useful.

#### Automated Weekly Report to Agents (Slack)
**Priority:** TBD
**Status:** Not started
**Depends on:** Slack workspace access, webhook/bot setup

Send each agent a weekly performance summary via Slack. Data layer exists. Needs: Slack webhook or bot integration, report template design, scheduled trigger (likely a new GH Actions workflow on a weekly cron).

#### Leaderboard
**Priority:** TBD
**Status:** Blocked — needs product decision on ranking metrics
**Depends on:** Leaderboard metrics design (see below)

Public-facing agent ranking. Open question: what metrics drive the ranking? Needs a product decision before any build work starts.

#### Leaderboard Metrics Design
**Priority:** TBD
**Status:** Needs decision
**Depends on:** Nothing — this is a product/strategy call

What combination of metrics creates a fair and motivating ranking? Tied to the leaderboard feature. This is a design decision, not a build task.

#### Company vs. Self-Gen Lead Filter
**Priority:** TBD
**Status:** Not started
**Depends on:** FUB data quality (tags/custom fields for lead source)

Filter smart list data by lead source (company-provided vs. agent-generated). Depends on whether FUB tags or custom fields reliably distinguish lead source, and whether existing smart lists already segment this way.

#### Lead Generation / Assignment Tracking
**Priority:** TBD
**Status:** Idea — needs data source investigation
**Depends on:** FUB API (new leads assigned or created per agent per day)

An agent can be green across all smart lists simply because they have no pipeline — zero leads means zero over-threshold counts. That looks great on the matrix but masks a real problem: no business. Need a metric that surfaces lead volume per agent (assigned + self-generated) so managers can distinguish "healthy and organized" from "empty pipeline." Open questions: does FUB expose lead assignment/creation events at the agent level with enough granularity? Could be a new column in the matrix, a card in the drawer, or a separate view entirely.


---

### Infrastructure / Data

#### Tighten Agents Table RLS Policy
**Priority:** Low (do when auth ships)
**Status:** Not started — blocked on auth implementation
**Depends on:** Settings Page / auth system

The `agents` table currently has a broad `"Allow anon update visible"` RLS policy that permits the anon key to UPDATE any column. This was added to fix the Manage Agents toggle persistence bug (the frontend writes `visible` directly via the Supabase JS client). When auth is implemented, this should be scoped to only allow updating the `visible` column, and ideally require an authenticated admin role rather than anon.

#### Beginning-of-Day Smart List Snapshot
**Priority:** TBD
**Status:** Idea — not committed

Store the first smart list snapshot of each day separately to enable showing daily deltas (how much each list changed during the business day). With the upsert model, each 15-min pull overwrites the day's snapshot, so start-of-day vs end-of-day comparison isn't possible without capturing the first pull separately.

---

### UX / Design

#### Streak Visualization Redesign (30/90-Day Grid)
**Priority:** Low
**Status:** Idea — user was thinking out loud

Replace streak dots with a 30 or 90-day colored grid table. Substantial UX project. Current "X/7 good" label is the quick fix; this would be the full redesign if the concept is worth pursuing.

#### User Authentication (Google SSO) + Settings Page
**Priority:** Deferred — fully scoped, ready to build when needed
**Status:** Planned (4-6 hours total across 3 phases)
**Depends on:** Google Workspace admin access for OAuth client creation

**Current state:** Zero auth. Supabase anon key hardcoded, all reads public, one write (`agents.visible` UPDATE) open to anyone via broad RLS policy. Backend automation (GitHub Actions) uses service_role key and is unaffected by auth changes.

**Architecture:** Google SSO via Supabase Auth using PKCE flow (works on static GitHub Pages). Domain restricted to `@whisselrealty.com` via Google `hd` parameter + app-side email check + RLS as the real security boundary. Reads stay public (no login to view dashboard). Auth only gates Manage Agents and future write operations.

**Schema changes:** Two new columns on `agents` table — `auth_user_id UUID REFERENCES auth.users(id)` for user-to-agent mapping (matched via email on first login) and `app_role TEXT DEFAULT 'agent' CHECK (app_role IN ('agent', 'admin'))` for permission tiers. Seeded from FUB roles: Owner/Admin → `app_role = 'admin'`, everyone else → `'agent'`. A `SECURITY DEFINER` function (`link_auth_user()`) handles self-linking so agents can write their own `auth_user_id` without broad UPDATE access.

**RLS redesign:** Drop current broad anon UPDATE → admin-only authenticated UPDATE policy. Reads unchanged.

**Frontend (~90 lines in progress.html):** Auth state management (`initAuth()`, `setCurrentUser()`, `onAuthStateChange`), login/logout UI in header bar, admin gating on Manage Agents button.

**Phase 1 — Backend prep (1-2 hrs, no user impact):** Google Cloud Console OAuth client, Supabase Auth Google provider config, two SQL migrations (add columns, seed app_role), `link_auth_user()` function.

**Phase 2 — Frontend + RLS cutover (3-4 hrs, single deploy):** Auth state JS, login/logout UI, admin gating, RLS policy swap, full OAuth round-trip test.

**Phase 3 — Polish (2-3 hrs, fully deferrable):** Admin UI for role management, auto-set app_role in sync-agents.js for new agents, manual agent-linking UI for email mismatches, optional read-gating.

**Key risks:** Google Workspace admin may need to approve third-party OAuth app (lead time). Email mismatch between Google and FUB accounts causes silent auto-link failure (fixable via SQL or Phase 3 UI). First-admin bootstrapping requires verifying deployer is Owner/Admin in FUB before RLS swap.

---

## Killed / Won't Do

_Items explicitly decided against. Kept for context._

| Date | Item | Reason |
|------|------|--------|
| 2026-03-04 | pg_cron scheduling | Unreliable in Supabase free tier, replaced by GH Actions |
| 2026-03-18 | Pre-aggregated daily agent status table | Solved differently — `calc-streaks.js` runs server-side in GH Actions, frontend reads pre-computed values |
| 2026-03-18 | Data retention strategy (snapshot cleanup) | Solved at the source — upsert model produces 9 snapshots/day instead of ~600. Historical bloat pruned (213K → 18K rows) |

# FUB Expectations Tracker — Backlog

> **Owner:** Claude (updated each session)
> **Last updated:** 2026-03-04
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

---

### Infrastructure / Data

#### Data Retention Strategy
**Priority:** Low
**Status:** Not started

Define and implement cleanup for old snapshots (e.g., older than 6 months). Need to evaluate impact on streak calculations and historical trend charts before deleting anything. Currently ~405 snapshot rows/day, ~10K agent_list_counts/day — not urgent but will matter at scale.

#### Tighten Agents Table RLS Policy
**Priority:** Low (do when auth ships)
**Status:** Not started — blocked on auth implementation
**Depends on:** Settings Page / auth system

The `agents` table currently has a broad `"Allow anon update visible"` RLS policy that permits the anon key to UPDATE any column. This was added to fix the Manage Agents toggle persistence bug (the frontend writes `visible` directly via the Supabase JS client). When auth is implemented, this should be scoped to only allow updating the `visible` column, and ideally require an authenticated admin role rather than anon.

#### Pre-Aggregated Daily Agent Status Table
**Priority:** Medium
**Status:** Not started — architectural change
**Depends on:** Nothing — can be built incrementally alongside current system

Move streak computation server-side by creating a `daily_agent_status` table that stores one row per agent per day with the count of green SmartLists. This pre-aggregated data would feed both the matrix table and the drawer, eliminating the need for the client to paginate through ~11K raw `agent_list_counts` rows and compute streaks in the browser. The current client-side pagination works but is a tactical fix — this is the architectural solution. The table would be populated by a nightly GitHub Action or as part of each SmartList pull.

#### Beginning-of-Day Smart List Snapshot
**Priority:** TBD
**Status:** Idea — not committed

Store the first smart list snapshot of each day separately to enable showing daily deltas (how much each list changed during the business day). Currently snapshots overwrite, so start-of-day vs end-of-day comparison isn't possible.

---

### UX / Design

#### Streak Visualization Redesign (30/90-Day Grid)
**Priority:** Low
**Status:** Idea — user was thinking out loud

Replace streak dots with a 30 or 90-day colored grid table. Substantial UX project. Current "X/7 good" label is the quick fix; this would be the full redesign if the concept is worth pursuing.

#### Settings Page
**Priority:** Deferred
**Status:** Blocked — requires auth/user management

Full settings UI with user authentication and role-based access. Explicitly deferred as future scope. Prerequisite for any admin-only features.

---

## Killed / Won't Do

_Items explicitly decided against. Kept for context._

| Date | Item | Reason |
|------|------|--------|
| 2026-03-04 | pg_cron scheduling | Unreliable in Supabase free tier, replaced by GH Actions |

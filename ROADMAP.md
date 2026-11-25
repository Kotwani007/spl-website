# SPL Product Upgrade Roadmap

The work is staged so the supplied league history remains recoverable. The current deliverable stays in `spl-js`; the archived Django application and its database are treated as read-only source material. The explicit JavaScript requirement remains in force, so backend work will use JavaScript equivalents rather than Django/Python.

## Phase 1 — Audit, baseline, and recovery (complete)

- [x] Inventory the Express routes, EJS pages, browser scripts, CSS, assets, dependencies, and database tables.
- [x] Record existing application boundaries and the main security, performance, and concurrency risks in `ARCHITECTURE.md`.
- [x] Add a consistent SQLite backup command with integrity and row-count verification.
- [x] Add baseline HTTP smoke checks for public routes, detail routes, health, and staff-route gating.
- [x] Exclude local databases, backups, secrets, and generated files from Git.
- [x] Document the backup and migration guardrails in `DATABASE.md`.
- [x] Create this staged implementation checklist.
- [x] Review existing desktop and mobile pages against the local JavaScript rebuild; correct the narrow match ticker status column.

## Phase 2 — Data model and migrations (SQLite complete; PostgreSQL out of scope)

- [ ] Inventory all current tables, constraints, indices, joins, JSON fields, and important aggregate counts.
- [x] Establish a versioned JavaScript migration tool and a rollback-tested local workflow.
- [x] Add SQLite tables for auction, role assignments, team-owner assignments, idempotency, audit records, plus query indexes; reuse existing league schema and IDs.
- [ ] Keep legal deliveries as integer ball counts and add check/unique constraints for auction state and identities.
- [x] Run migrations and forward/rollback validation against temporary copies while preserving supported source IDs and rows.
- [x] Compare integrity, row counts, key aggregates, and foreign-key relationships in migration checks.
- [ ] Keep the SQLite copy and verified backup unchanged until the migration is reviewed.

## Phase 3 — Design system and responsive public experience (source-guided rebuild complete; pixel QA partial)

- [x] Build the JavaScript pages around the SPL editorial sports identity and shared visual styles.
- [x] Implement compact desktop navigation, mobile navigation, match ticker, homepage, and reusable page components.
- [x] Implement public routes and page structures using the supplied content and relationships.
- [ ] Add accessible focus states, reduced-motion behavior, responsive scorecards, touch targets, and safe-area spacing.
- [ ] Complete a full screenshot comparison at every listed viewport; browser review so far covered desktop and 390px mobile.
- [ ] Use supplied photography and logos where they exist; retain honest placeholders where the archive has no asset.

## Phase 4 — Tournament, teams, player analytics (partial)

- [ ] Move scoring and statistics calculations into testable services and selectors.
- [x] Add supported player career/season analytics and clearly mark unavailable history.
- [x] Add player comparison using source-supported values.
- [ ] Add team form, head-to-head records, awards, and a points table where source data supports them.
- [ ] Add pagination and query plans for player, match, and leaderboard pages.
- [ ] Add registration review and tournament configuration workflows without exposing private registration data.

## Phase 5 — Identity and permissions (core complete)

- [x] Add explicit Super Admin, Organiser, Auctioneer, Scorer, Team Owner, Player, and Spectator permissions.
- [x] Add durable sessions, stable secret configuration, login throttling, security headers, and role-focused authorization tests.
- [x] Add owner-to-team assignment and verify owners can only bid for their assigned team.
- [x] Preserve existing staff/superuser login compatibility and document account mapping.

## Phase 6 — Transactional auction engine (partial)

- [x] Enforce auction state, team eligibility, available purse, and bid increment rules inside database transactions.
- [x] Add bid idempotency, transaction-backed purse accounting, and an audit trail for bids/results/state/queue changes.
- [x] Add result settlement and CSV export.
- [ ] Add squad/category/retention/reserved-purse rules, auction timers, timer extensions, unsold re-queue, retained players, reversible corrections, and true concurrent-writer tests.
- [ ] PostgreSQL is not part of the requested SQLite deliverable.

## Phase 7 — Auction viewing and owner tools (partial)

- [x] Build public auction room, auctioneer controls, team-owner dashboard, and projector mode.
- [ ] Add reconnect/state synchronization and send real-time events only after committed database changes.
- [x] Add auction result export and player purchase history.
- [x] Verify owner isolation and review the public auction experience at desktop/mobile sizes.

## Phase 8 — Live scoring and match center (partial)

- [x] Add transactional delivery undo, audit trail, legal-ball accounting, innings transitions, and match finalization.
- [ ] Calculate strike rotation, extras, wickets, partnerships, fall of wickets, run rates, targets, and results from supported deliveries.
- [ ] Persist match state transactionally and prevent concurrent scorers from corrupting totals.
- [x] Add polling-based live score refresh and mobile scorecard layouts.
- [ ] Do not fabricate missing historical delivery data.

## Phase 9 — Supporting features and performance (partial)

- [ ] Announcements, gallery, and notifications remain unimplemented; sponsor management is available through organiser desk.
- [x] Add PWA metadata, CSV export, metadata, Open Graph tags, sitemap, responsive structure, and a static-only asset cache.
- [ ] Measure representative mobile performance and record actual Lighthouse results before making claims.

## Phase 10 — Security, reliability, and deployment (partial)

- [x] Add HTTP, authorization, migration, owner-bid idempotency/isolation, analytics, and backup integrity checks.
- [ ] Expand browser and accessibility coverage, scoring edge cases, true concurrent auction checks, and restore drills.
- [ ] Add backups/restore drills, structured logging, health monitoring, and deployment runbooks.
- [ ] Review permissions, secret handling, session storage, data exposure, and operational recovery.
- [x] Review desktop/mobile reference pages and update `CHANGELOG.md`, `README.md`, and database/architecture docs.
- [ ] Complete the remaining viewport matrix and production deployment validation.

## Working rules

- Preserve the original archive and database; work only on copies.
- Do not invent missing photos, auction history, or ball-by-ball records.
- Do not commit or push unless the user explicitly asks.
- At each phase, record the objective, files changed, decisions, checks run, remaining limits, and a suggested conventional commit message.

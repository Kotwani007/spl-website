# Changelog

## Unreleased

- Added JavaScript migrations for auction, role, audit, and query-index schema, plus verified backups and guarded rollback checks.
- Added durable SQLite sessions, login throttling, security headers, role-based access controls, team-owner assignment, and audit events.
- Added transactional delivery scoring, undo/innings controls, idempotent auction bidding, purse/queue/state management, and result settlement.
- Added supported player career/season analytics, player comparison, auction purchase history, and CSV exports for leaderboards and auction results.
- Added a team-owner dashboard, public auction results, PWA metadata and static asset caching, robots.txt, sitemap.xml, and page metadata.
- Refined mobile match ticker readability and documented setup, migration, backup, source limitations, and current workflow coverage.
- Expanded HTTP, role, analytics, bid-isolation/idempotency, and migration checks; all run against disposable copies of the supplied SQLite data.

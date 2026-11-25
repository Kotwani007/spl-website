# SPL Database and Backup Procedure

## Current data

`data/db.sqlite3` is the working copy of the SQLite database supplied with the archive. The original ZIP and original project database are not used as writable files. The JavaScript app preserves the archive's season, team, player, match, scorecard, statistic, sponsor, and staff records. Auction tables and player auction fields were added to this working copy because the archive has no auction schema or saved auction records.

The app does not generate historical deliveries. Existing player statistics and score summaries remain the source for matches whose delivery history is absent.

The source baseline contained 3 tournaments, 40 teams, 302 players, 74 matches, 118 innings, 1,810 player-match statistic rows, 1 sponsor, and 0 delivery rows. The JavaScript migrations add auction, role, audit, and supporting indexes while preserving the source records and IDs. Auction tables and role assignments begin empty; legacy staff/superuser records remain available through the compatibility mapping. Run `npm run db:migrate:status` for the current migration ledger.

## Create and verify a backup

Run:

```sh
npm run db:backup
```

The script uses SQLite `VACUUM INTO` to create a consistent timestamped snapshot in `data/backups/`. It refuses to overwrite an existing file, checks `PRAGMA integrity_check`, compares every table's row counts between the working database and the snapshot, and prints a SHA-256 checksum. Backups are excluded from Git. Copy important backups to a protected location outside this checkout.

The pre-migration Phase 1 baseline backup was verified at `data/backups/spl-2026-11-24T16-08-34-926Z.sqlite3`. Its SHA-256 is `b887be96adc0389233f0ff1c91e75ac1a2a2e385c21c7b82def2d1fe78786f96`; SQLite reported `integrity_check: ok`, and all table counts matched the working database at that point. The migration runner creates a distinct verified backup for each schema upgrade and does not overwrite an earlier snapshot.

Before manual schema work or a rollback:

1. Stop writes to the working database.
2. Run the backup command and retain its successful verification output and checksum.
3. Record the table counts and key league totals from the backup.
4. Apply migrations to a staging database copied from that backup first where operationally possible. The runner's automatic backup is a second guard, not a substitute for review.
5. Verify integrity, row counts, identifiers, foreign-key relationships, score totals, and representative scorecards against the source.
6. Keep the original SQLite file and verified backup unchanged until cutover has been approved and the migrated app has been checked.

Do not delete, reset, overwrite, or migrate the archive database in place.

## Migrations

Migrations are numbered JavaScript modules under `scripts/migrations/`. Check status with `npm run db:migrate:status` and apply pending migrations with `npm run db:migrate`. The app also checks migrations at startup; if any are pending, it creates and verifies a unique backup before the transaction. Rollback is available with `npm run db:migrate:rollback` only when the migration's down-check accepts the current state. The runner refuses an unsafe rollback and does not delete the backup. `npm run test:migrations` verifies the migration cycle on a temporary database copy.

PostgreSQL migration is outside this SQLite deliverable. Keep original integer IDs and derive bowling overs from integer legal-ball counts if that work is commissioned later. Derived values must be recalculated from supported records or explicitly marked unavailable when underlying history is missing.

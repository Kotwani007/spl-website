# Sindhi Premier League · JavaScript rebuild

This is a separate rebuild of the Sindhi Premier League site in `../splfinal.zip`, using Node.js, Express, EJS, browser JavaScript, CSS, and SQLite.

## Run locally

Use Node.js 22.13 or newer. From this directory, run:

```sh
npm install
npm start
```

Then open <http://localhost:3000/>. Copy `.env.example` to `.env` to set local options. Set `PORT`, a stable `SITE_URL`, and a randomly generated `SESSION_SECRET` of at least 32 characters for deployment. Set `GOOGLE_FORM_URL` if registration should open an external form. Existing Django password hashes are verified without replacing them.

## Deploy to Render

The repository's root Render Blueprint belongs to a separate Java app. To deploy this JavaScript version, create a Render Blueprint and select the custom Blueprint file `spl-js/render.yaml`. It points Render at this directory, runs `npm ci` and `npm start`, and attaches a persistent disk for SQLite.

The first deploy starts in a temporary database-setup screen because the SQLite file is deliberately excluded from Git. After Render reports the service healthy, set `SPL_DEPLOY_URL` to its HTTPS URL and `DATABASE_BOOTSTRAP_TOKEN` to the generated value shown in the Render service environment. From this directory, run:

```sh
npm run deploy:upload-db
```

The uploader makes and verifies a fresh database backup, sends it over HTTPS to a token-protected one-time endpoint, and prints no token or record contents. Restart the Render service after it confirms the upload. Once the persistent copy is in place, the normal SPL app starts and the temporary setup endpoint is no longer mounted. Keep the token private and clear it from your shell afterward.

This transfer includes the saved league records and the legacy staff account, including its password hash and email address. Review the database contents and destination before running the uploader. Do not add `data/db.sqlite3` or a backup to Git; `.gitignore` excludes both.

Run the HTTP and feature checks with `npm test`, and run the migration/backup checks with `npm run test:migrations`. Review schema state with `npm run db:migrate:status`; apply pending migrations with `npm run db:migrate`. The app checks and applies migrations at startup only after creating and verifying a non-overwriting SQLite backup. Create a manual verified backup with `npm run db:backup`. See [DATABASE.md](DATABASE.md) for safeguards and rollback limits.

## Database and assets

`data/db.sqlite3` is a separate working copy of the SQLite database supplied in the archive. It retains the supplied seasons, teams, players, matches, scorecards, statistics, sponsors, and staff account records. Versioned JavaScript migrations add auction, access, audit, and query-index schema to this copy. The app never writes to the ZIP or the original project database, and it does not recreate or reset the working database. Tests use isolated temporary copies.

The archived stylesheet and supplied local fonts are reused, with responsive and feature-specific CSS additions. The ZIP and project files do not contain the database-referenced sponsor logo or player/team photo files, so the site uses text or initials where those images would appear. The source stylesheet’s Google Fonts import is preserved; local Barlow Condensed and Inter font files from the project are included as well.

The working database and generated backups are ignored by Git. Keep them in local storage or a protected backup location, and never replace the original archive database.

## Pages and organiser workflows

Public pages cover home, About, seasons and teams, team profiles, fixtures and results, match scorecards and live scoring, players and profiles, leaderboards, sponsors, registration, contact, and the auction room. Search and season filters use supplied records; the mobile menu, live score refresh, auction refresh, and leaderboard show-more controls are included.

Staff pages provide sign-in, a record desk for seasons, teams, players, matches, sponsors, and enquiries, match setup and ball-by-ball scoring, innings control, match completion and player-stat saving, delivery CSV import, and auction category/player/queue/purse/bidding/result controls. Separate super-admin, organiser, auctioneer, scorer, team-owner, player, and spectator roles are supported. Existing Django superusers/staff accounts remain compatible; super-admins can manage roles and account/team-owner assignments. Team owners can view only their assigned team’s purse and place bids for that team. The owner dashboard is at `/owner/`.

Player profiles include source-supported career and season analytics, recent form, sale history, and a two-player comparison page at `/players/compare/`. Leaderboard and auction results can be downloaded as CSV. PWA install metadata, a static-only service worker, robots.txt, sitemap.xml, and page metadata are included. The service worker does not cache live or staff data.

## Source limitations

The original Django app could not be started in this environment because its Python dependencies were incomplete, so the rebuild was guided by the archive’s templates, routes, database, and stylesheet rather than runtime screenshots. The archive database contains no auction records or auction schema; the JavaScript app adds the schema and management flow, and the public room stays empty until staff create an auction. The uploaded image files referenced in the database are also absent from the archive and available project files. Historical ball-by-ball deliveries were not supplied, so delivery-derived fielding and match history are shown as unavailable when not supported by source records. SQLite remains the required storage engine for this deliverable; PostgreSQL migration and hosted real-time infrastructure are not included.

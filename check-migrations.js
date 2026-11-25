import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createVerifiedBackup } from './lib/db-backup.js';
import { migrateDatabase, migrationStatus, rollbackLastMigration } from './migrate-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workingDatabasePath = path.join(here, '..', 'data', 'db.sqlite3');
const backupRoot = path.join(here, '..', 'data', 'backups');
const testTempRoot = path.resolve(here, '..', '.test-tmp');
fs.mkdirSync(testTempRoot, { recursive: true });
const tempDirectory = fs.mkdtempSync(path.join(testTempRoot, 'spl-migration-check-'));
const copyPath = path.join(tempDirectory, 'copy.sqlite3');
const backupDirectory = path.join(tempDirectory, 'backups');
const baselinePath = path.join(tempDirectory, 'baseline.sqlite3');
const counts = database => Object.fromEntries(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, Number(database.prepare(`SELECT COUNT(*) count FROM "${name.replaceAll('"','""')}"`).get().count)]));

try {
  let sourcePath = workingDatabasePath;
  const working = new DatabaseSync(workingDatabasePath, { readOnly: true });
  const hasLedger = Boolean(working.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spl_schema_migrations'").get());
  working.close();
  if (hasLedger) {
    const candidates = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).filter(name => name.endsWith('.sqlite3')).sort().reverse() : [];
    sourcePath = null;
    for (const candidate of candidates) {
      const candidatePath = path.join(backupRoot, candidate);
      const snapshot = new DatabaseSync(candidatePath, { readOnly: true });
      const migrated = Boolean(snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spl_schema_migrations'").get());
      snapshot.close();
      if (!migrated) { sourcePath = candidatePath; break; }
    }
    if (!sourcePath) throw new Error('No pre-migration SQLite snapshot is available for migration checks. Preserve one before running the suite.');
  }
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const escapedCopy = copyPath.replaceAll("'", "''");
  source.exec(`VACUUM INTO '${escapedCopy}'`);
  const expectedCounts = counts(source);
  source.close();

  const copy = new DatabaseSync(copyPath, { timeout: 5000 });
  copy.exec('PRAGMA foreign_keys = ON;');
  const preserved = migrateDatabase(copy, { databasePath: copyPath, backupDirectory });
  assert.equal(preserved.applied.length, 3, 'all migrations apply to the copied source database');
  assert.ok(preserved.backup?.integrity === 'ok', 'an integrity-checked backup is made before migration');
  const preservedCounts = counts(copy);
  for (const [table, count] of Object.entries(expectedCounts)) assert.equal(preservedCounts[table], count, `${table} count is preserved`);
  assert.deepEqual(copy.prepare('PRAGMA foreign_key_check').all(), [], 'migrated copy has no foreign-key violations');
  assert.equal(migrationStatus(copy).filter(row => row.state === 'applied').length, 3);
  copy.close();

  const baseline = new DatabaseSync(baselinePath);
  baseline.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE league_tournament(id INTEGER PRIMARY KEY);
    CREATE TABLE league_team(id INTEGER PRIMARY KEY,tournament_id INTEGER);
    CREATE TABLE league_player(id INTEGER PRIMARY KEY);
    CREATE TABLE auth_user(id INTEGER PRIMARY KEY);
    CREATE TABLE league_match(id INTEGER PRIMARY KEY,tournament_id INTEGER,date TEXT,status TEXT);
    CREATE TABLE league_playermatchstat(id INTEGER PRIMARY KEY,player_id INTEGER,match_id INTEGER,team_id INTEGER);
    CREATE TABLE league_innings(id INTEGER PRIMARY KEY);
    CREATE TABLE league_delivery(id INTEGER PRIMARY KEY,innings_id INTEGER,over_number INTEGER,ball_number INTEGER);`);
  const rolledForward = migrateDatabase(baseline, { databasePath: baselinePath, backupDirectory });
  assert.equal(rolledForward.applied.length, 3);
  for (const status of [...migrationStatus(baseline)].reverse()) {
    const result = rollbackLastMigration(baseline, { databasePath: baselinePath, backupDirectory });
    assert.ok(result.rolledBack, `${status.version} rolls back`);
  }
  assert.deepEqual(migrationStatus(baseline).map(row => row.state), ['pending','pending','pending']);
  assert.deepEqual(baseline.prepare('PRAGMA foreign_key_check').all(), [], 'rolled-back baseline has no foreign-key violations');
  baseline.close();
  console.log('Migration checks passed: backup, source row counts, forward migrations, foreign keys, and safe rollback.');
} finally {
  if (!path.resolve(tempDirectory).startsWith(`${testTempRoot}${path.sep}`)) throw new Error('Refusing to remove a migration test directory outside the local test-temp folder.');
  fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

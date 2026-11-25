import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerifiedBackup } from './lib/db-backup.js';
import * as auctionSchema from './migrations/001-auction-schema.js';
import * as queryIndexes from './migrations/002-query-indexes.js';
import * as accessAndAudit from './migrations/003-access-and-audit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.join(here, 'migrations');
const modules = new Map([['001', auctionSchema], ['002', queryIndexes], ['003', accessAndAudit]]);

function migrationList() {
  return fs.readdirSync(migrationDirectory)
    .filter(name => /^\d{3}-[a-z0-9-]+\.js$/i.test(name))
    .sort()
    .map(name => {
      const file = path.join(migrationDirectory, name);
      const source = fs.readFileSync(file);
      const version = name.slice(0, 3);
      return { version, name, checksum: crypto.createHash('sha256').update(source).digest('hex'), file };
    });
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS spl_schema_migrations (
    version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

function assertChecksums(db, migrations) {
  const applied = new Map(db.prepare('SELECT version,checksum,name FROM spl_schema_migrations').all().map(row => [row.version, row]));
  const known = new Set(migrations.map(migration => migration.version));
  for (const version of applied.keys()) if (!known.has(version)) throw new Error(`Applied migration ${version} has no matching source file. Restore the migration before making schema changes.`);
  for (const migration of migrations) {
    const previous = applied.get(migration.version);
    if (previous && previous.checksum !== migration.checksum) {
      throw new Error(`Applied migration ${migration.version} (${previous.name}) was edited. Add a new migration instead of changing deployed migration files.`);
    }
  }
  return applied;
}

export function migrationStatus(db) {
  const migrations = migrationList();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spl_schema_migrations'").get();
  const applied = exists ? assertChecksums(db, migrations) : new Map();
  return migrations.map(migration => ({ version: migration.version, name: migration.name, state: applied.has(migration.version) ? 'applied' : 'pending' }));
}

export function migrateDatabase(db, { databasePath, backupDirectory, createBackup = true } = {}) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spl_schema_migrations'").get();
  const migrations = migrationList();
  const applied = exists ? assertChecksums(db, migrations) : new Map();
  const pending = migrations.filter(migration => !applied.has(migration.version));
  if (!pending.length) return { applied: [], backup: null };
  const backup = createBackup ? createVerifiedBackup(databasePath, backupDirectory) : null;
  ensureTable(db);
  const completed = [];
  for (const migration of pending) {
    const module = modules.get(migration.version);
    if (!module) throw new Error(`Migration module ${migration.version} is missing.`);
    db.exec('BEGIN IMMEDIATE');
    try {
      module.up(db);
      db.prepare('INSERT INTO spl_schema_migrations(version,name,checksum) VALUES(?,?,?)').run(migration.version, migration.name, migration.checksum);
      db.exec('COMMIT');
      completed.push(migration.name);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.version} failed${backup ? `; verified pre-migration backup: ${backup.backup}` : ''}: ${error.message}`, { cause: error });
    }
  }
  return { applied: completed, backup };
}

export function rollbackLastMigration(db, { databasePath, backupDirectory, createBackup = true } = {}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spl_schema_migrations'").get()) return { rolledBack: null, backup: null };
  const rows = db.prepare('SELECT version,name,checksum FROM spl_schema_migrations ORDER BY version DESC LIMIT 1').all();
  if (!rows.length) return { rolledBack: null, backup: null };
  const row = rows[0];
  const migration = migrationList().find(item => item.version === row.version);
  if (!migration) throw new Error(`Migration ${row.version} is applied but its source file is missing.`);
  if (migration.checksum !== row.checksum) throw new Error(`Migration ${row.version} checksum differs from its applied record.`);
  const module = modules.get(migration.version);
  if (!module?.down) throw new Error(`Migration ${row.version} does not provide a safe rollback.`);
  const backup = createBackup ? createVerifiedBackup(databasePath, backupDirectory) : null;
  db.exec('BEGIN IMMEDIATE');
  try {
    module.down(db);
    db.prepare('DELETE FROM spl_schema_migrations WHERE version=?').run(row.version);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`Rollback of migration ${row.version} failed${backup ? `; verified pre-rollback backup: ${backup.backup}` : ''}: ${error.message}`, { cause: error });
  }
  return { rolledBack: migration.name, backup };
}

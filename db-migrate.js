import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { migrateDatabase, migrationStatus, rollbackLastMigration } from './migrate-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const databasePath = path.join(here, '..', 'data', 'db.sqlite3');
const db = new DatabaseSync(databasePath, { timeout: 5000 });
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
try {
  if (process.argv.includes('--status')) console.log(JSON.stringify(migrationStatus(db), null, 2));
  else if (process.argv.includes('--rollback')) console.log(JSON.stringify(rollbackLastMigration(db, { databasePath }), null, 2));
  else console.log(JSON.stringify(migrateDatabase(db, { databasePath }), null, 2));
} finally { db.close(); }

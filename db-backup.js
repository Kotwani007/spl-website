import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function tableSnapshot(database) {
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(names.map(({ name }) => {
    const quotedName = `"${name.replaceAll('"', '""')}"`;
    return [name, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quotedName}`).get().count)];
  }));
}

function integrityResult(database) {
  return database.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check);
}

export function createVerifiedBackup(sourcePath, backupDirectory = path.join(path.dirname(sourcePath), 'backups')) {
  if (!fs.existsSync(sourcePath)) throw new Error(`Working SQLite database not found: ${sourcePath}`);
  fs.mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupPath = path.join(backupDirectory, `spl-${timestamp}-${crypto.randomBytes(3).toString('hex')}.sqlite3`);
  if (fs.existsSync(backupPath)) throw new Error(`Backup already exists; refusing to overwrite it: ${backupPath}`);

  const source = new DatabaseSync(sourcePath, { timeout: 5000 });
  source.exec('PRAGMA busy_timeout = 5000');
  const sourceIntegrity = integrityResult(source);
  if (sourceIntegrity.length !== 1 || sourceIntegrity[0] !== 'ok') {
    source.close();
    throw new Error(`Source integrity check failed: ${sourceIntegrity.join('; ')}`);
  }
  const sourceCounts = tableSnapshot(source);
  const escapedBackupPath = backupPath.replaceAll("'", "''");
  try { source.exec(`VACUUM INTO '${escapedBackupPath}'`); }
  finally { source.close(); }

  const backup = new DatabaseSync(backupPath, { timeout: 5000 });
  const backupIntegrity = integrityResult(backup);
  const backupCounts = tableSnapshot(backup);
  backup.close();
  if (backupIntegrity.length !== 1 || backupIntegrity[0] !== 'ok') {
    throw new Error(`Backup integrity check failed: ${backupIntegrity.join('; ')}. The backup was retained at ${backupPath}`);
  }
  if (JSON.stringify(sourceCounts) !== JSON.stringify(backupCounts)) {
    throw new Error(`Backup row counts do not match the source. The backup was retained at ${backupPath}`);
  }

  return {
    source: sourcePath,
    backup: backupPath,
    bytes: fs.statSync(backupPath).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex'),
    integrity: backupIntegrity[0],
    tableCounts: backupCounts
  };
}

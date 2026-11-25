import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerifiedBackup } from './lib/db-backup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const rawUrl = process.env.SPL_DEPLOY_URL;
const token = process.env.DATABASE_BOOTSTRAP_TOKEN;
if (!rawUrl || !token || token.length < 32) {
  throw new Error('Set SPL_DEPLOY_URL and DATABASE_BOOTSTRAP_TOKEN in the current shell. The token is read from the environment and is never printed.');
}

const destination = new URL(rawUrl);
if (destination.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(destination.hostname)) {
  throw new Error('Database upload requires HTTPS outside a local development environment.');
}
const sourcePath = path.join(projectRoot, 'data', 'db.sqlite3');
const verified = createVerifiedBackup(sourcePath);
const upload = fs.readFileSync(verified.backup);
console.info(`Uploading verified SQLite backup to ${destination.origin} (${verified.bytes} bytes; SHA-256 ${verified.sha256}).`);
const response = await fetch(new URL('/__setup/database', destination.origin), {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
  body: upload,
  redirect: 'error'
});
const message = await response.text();
if (!response.ok) throw new Error(`Database upload was not accepted (HTTP ${response.status}): ${message.slice(0, 400)}`);
console.info(message);

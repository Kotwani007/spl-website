import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerifiedBackup } from './lib/db-backup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const result = createVerifiedBackup(path.join(projectRoot, 'data', 'db.sqlite3'));
console.log(JSON.stringify({ ...result, source: path.relative(projectRoot, result.source), backup: path.relative(projectRoot, result.backup) }, null, 2));

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBootstrapApp } from './db-bootstrap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDatabasePath = path.join(here, '..', 'data', 'db.sqlite3');
const databasePath = path.resolve(process.env.SPL_DATABASE_PATH || defaultDatabasePath);

if (fs.existsSync(databasePath)) {
  await import('../app.js');
} else {
  const token = process.env.DATABASE_BOOTSTRAP_TOKEN;
  if (!token || token.length < 32) {
    throw new Error('The SPL database is missing and DATABASE_BOOTSTRAP_TOKEN is not configured. Configure persistent storage and a private bootstrap token.');
  }
  const port = Number(process.env.PORT || 3000);
  const bootstrapApp = createBootstrapApp({ databasePath, token });
  bootstrapApp.listen(port, () => console.info(`SPL database setup endpoint ready on port ${port}.`));
}

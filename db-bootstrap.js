import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';

const MAX_DATABASE_BYTES = 20 * 1024 * 1024;
const REQUIRED_TABLES = [
  'auth_user', 'league_tournament', 'league_team', 'league_player', 'league_player_teams',
  'league_match', 'league_innings', 'league_delivery', 'league_playermatchstat', 'league_contactenquiry'
];

function isAuthorized(request, token) {
  const match = /^Bearer\s+(.+)$/i.exec(request.get('authorization') || '');
  const supplied = Buffer.from(match?.[1] || '');
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function validateDatabase(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true, timeout: 5000 });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error('integrity check failed');
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const missing = REQUIRED_TABLES.filter(name => !tables.has(name));
    if (missing.length) throw new Error('required league tables are missing');
    for (const [table, label] of [['league_tournament','season'],['league_team','team'],['league_player','player'],['auth_user','staff account']]) {
      if (!database.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()) throw new Error(`the uploaded database has no ${label} records`);
    }
  } finally {
    database.close();
  }
}

export function createBootstrapApp({ databasePath, token }) {
  if (!token || token.length < 32) throw new Error('Database bootstrap requires a token with at least 32 characters.');
  const target = path.resolve(databasePath);
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.get('/health', (_request, response) => response.json({ status: fs.existsSync(target) ? 'database-installed-restart-required' : 'awaiting-database' }));
  app.get('/', (_request, response) => response.status(503).type('text/plain').send('The SPL website is being prepared. Please check back shortly.'));
  app.post('/__setup/database', (request, response, next) => {
    if (fs.existsSync(target)) return response.status(409).json({ error: 'The database is already installed. Restart the service to finish setup.' });
    if (!isAuthorized(request, token)) return response.status(401).json({ error: 'A valid database setup token is required.' });
    return next();
  }, express.raw({ type: 'application/octet-stream', limit: MAX_DATABASE_BYTES }), (request, response) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) return response.status(415).json({ error: 'Send the SQLite database as application/octet-stream.' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.${crypto.randomBytes(12).toString('hex')}.upload`;
    try {
      fs.writeFileSync(temporaryPath, request.body, { flag: 'wx', mode: 0o600 });
      validateDatabase(temporaryPath);
      if (fs.existsSync(target)) return response.status(409).json({ error: 'The database is already installed. Restart the service to finish setup.' });
      fs.renameSync(temporaryPath, target);
      return response.status(201).json({ status: 'database-installed', message: 'Restart the Render service to launch the SPL website.' });
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* keep the validation response generic */ }
      console.warn(`[SPL bootstrap] Database upload rejected: ${error.message}`);
      return response.status(400).json({ error: 'The upload did not pass SQLite and SPL data validation.' });
    }
  });
  return app;
}

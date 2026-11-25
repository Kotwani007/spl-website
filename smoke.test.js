import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBootstrapApp } from '../scripts/db-bootstrap.js';

process.env.NODE_ENV = 'test';
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

let app;
let database;
let store;
let server;
let baseUrl;
let tempDirectory;
let testDatabasePath;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-smoke-'));
  testDatabasePath = path.join(tempDirectory, 'db.sqlite3');
  const source = new DatabaseSync(path.join(projectRoot, 'data', 'db.sqlite3'), { readOnly: true });
  const escaped = testDatabasePath.replaceAll("'", "''");
  source.exec(`VACUUM INTO '${escaped}'`);
  source.close();
  process.env.SPL_DATABASE_PATH = testDatabasePath;
  ({ app } = await import('../app.js'));
  ({ db: database } = await import('../db.js'));
  store = await import('../db.js');
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (database) database.close();
  if (tempDirectory && path.resolve(tempDirectory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) fs.rmSync(tempDirectory, { recursive: true, force: true });
});

function createTestUser(username, password) {
  const salt = `spl-test-${username}`;
  const iterations = 1200;
  const encoded = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64').replace(/=+$/, '');
  const hash = `pbkdf2_sha256$${iterations}$${salt}$${encoded}`;
  return Number(store.run(`INSERT INTO auth_user(password,last_login,is_superuser,username,last_name,email,is_staff,is_active,date_joined,first_name)
    VALUES(?,NULL,0,?,'','',0,1,CURRENT_TIMESTAMP,'')`, hash, username).lastInsertRowid);
}

async function login(username, password) {
  const pageResponse = await fetch(`${baseUrl}/login/`);
  const initialCookie = pageResponse.headers.get('set-cookie')?.split(';')[0];
  const markup = await pageResponse.text();
  const csrfToken = markup.match(/name="csrfToken" value="([^"]+)"/)?.[1];
  assert.ok(initialCookie && csrfToken, 'sign-in form includes a session cookie and CSRF token');
  const response = await fetch(`${baseUrl}/login/`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: initialCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrfToken, username, password })
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] || initialCookie };
}

test('health endpoint reports the application is ready', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('first-deploy database setup requires its token and installs one validated SQLite file', async () => {
  const bootstrapDatabasePath = path.join(tempDirectory, 'bootstrap.sqlite3');
  const token = `spl-test-${'x'.repeat(48)}`;
  const bootstrapApp = createBootstrapApp({ databasePath: bootstrapDatabasePath, token });
  const bootstrapServer = bootstrapApp.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    bootstrapServer.once('listening', resolve);
    bootstrapServer.once('error', reject);
  });
  const bootstrapUrl = `http://127.0.0.1:${bootstrapServer.address().port}/__setup/database`;
  const upload = fs.readFileSync(testDatabasePath);
  const headers = { 'content-type': 'application/octet-stream' };
  try {
    const unauthorized = await fetch(bootstrapUrl, { method: 'POST', headers, body: upload });
    assert.equal(unauthorized.status, 401);

    const installed = await fetch(bootstrapUrl, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body: upload });
    assert.equal(installed.status, 201);
    assert.equal((await installed.json()).status, 'database-installed');
    assert.ok(fs.existsSync(bootstrapDatabasePath));

    const duplicate = await fetch(bootstrapUrl, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body: upload });
    assert.equal(duplicate.status, 409);
    const installedDb = new DatabaseSync(bootstrapDatabasePath, { readOnly: true });
    assert.equal(Number(installedDb.prepare('SELECT COUNT(*) n FROM league_player').get().n), 302);
    installedDb.close();
  } finally {
    await new Promise(resolve => bootstrapServer.close(resolve));
  }
});

test('public pages render successfully', async () => {
  for (const route of ['/','/about/','/teams/','/matches/','/players/','/players/compare/','/leaderboards/','/sponsors/','/register/','/contact/','/auction/']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, `${route} should render`);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
  }
});

test('a supplied team, match, player, and live scorecard detail render', async () => {
  const team = store.teams()[0];
  const match = store.matchList({ limit: 1 })[0];
  const player = store.players('', false)[0];
  assert.ok(team && match && player, 'the supplied database should contain league records');

  for (const route of [`/teams/${team.id}/`, `/matches/${match.id}/`, `/matches/${match.id}/live/`, `/players/${player.id}/`]) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, `${route} should render`);
  }
});

test('player analytics use source statistics and mark unsupported fielding data unavailable', async () => {
  const player = store.players('', false)[0];
  const analytics = store.playerAnalytics(player.id);
  const sourceRows = store.playerStats(player.id);
  assert.equal(analytics.totals.runs, sourceRows.reduce((sum, row) => sum + Number(row.runs || 0), 0));
  assert.equal(analytics.totals.wickets, sourceRows.reduce((sum, row) => sum + Number(row.wickets || 0), 0));
  assert.equal(analytics.fielding.available, false, 'the supplied archive has no delivery-level fielding history');
  const compare = await fetch(`${baseUrl}/players/compare/?a=${player.id}&b=${store.players('', false)[1].id}`);
  assert.equal(compare.status, 200);
  assert.match(await compare.text(), /Bowling average/);
});

test('organiser record management requires staff sign-in', async () => {
  const response = await fetch(`${baseUrl}/organiser/manage/`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login/');
});

test('SQLite sessions and assigned roles gate organiser and scoring pages', async () => {
  const scorerId = createTestUser('scorer-test', 'score-secret');
  const scorerRole = store.get("SELECT id FROM spl_role WHERE role_key='scorer'");
  store.run('INSERT INTO spl_user_role(user_id,role_id) VALUES(?,?)', scorerId, scorerRole.id);
  const { response, cookie } = await login('scorer-test', 'score-secret');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/matches/start/');
  assert.ok(cookie);

  const start = await fetch(`${baseUrl}/matches/start/`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(start.status, 200, 'a scorer can open the match setup screen');
  const manage = await fetch(`${baseUrl}/organiser/manage/`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(manage.status, 403, 'a scorer cannot access league administration');
  assert.ok(start.headers.get('x-frame-options') === 'DENY');
  const sessions = Number(store.get('SELECT COUNT(*) count FROM spl_session').count);
  assert.ok(sessions > 0, 'sessions persist in the isolated SQLite database');
});

test('Super Admin can create a role-bound account and the new account can sign in', async () => {
  const adminId = createTestUser('admin-test', 'admin-secret');
  store.assignRole(adminId, 'super_admin', null);
  const { response, cookie } = await login('admin-test', 'admin-secret');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/organiser/');
  const accessPage = await fetch(`${baseUrl}/organiser/manage/?section=access`, { headers: { cookie } });
  assert.equal(accessPage.status, 200);
  const token = (await accessPage.text()).match(/name="csrfToken" value="([^"]+)"/)?.[1];
  assert.ok(token);
  const teams = store.teams(3);
  const created = await fetch(`${baseUrl}/organiser/manage/`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrfToken: token, entity: 'access', access_action: 'account_create', username: 'owner-created', email: 'owner@example.test', password: 'owner-account-pass', role_key: 'team_owner', team_id: String(teams[0].id) })
  });
  assert.equal(created.status, 302);
  assert.match(created.headers.get('location'), /section=access/);
  const account = store.get("SELECT id FROM auth_user WHERE username='owner-created'");
  assert.ok(account);
  assert.ok(store.rolesForUser(account.id).includes('team_owner'));
  assert.equal(store.teamOwnerTeams(account.id)[0].id, teams[0].id);
  const ownerLogin = await login('owner-created', 'owner-account-pass');
  assert.equal(ownerLogin.response.status, 302);
  assert.equal(ownerLogin.response.headers.get('location'), '/owner/');
});

test('team-owner bids are limited to assigned teams and request keys prevent duplicates', async () => {
  const teams = store.teams(3);
  assert.ok(teams.length >= 2, 'the supplied season has teams for this isolated workflow check');
  const assignedTeam = teams[0];
  const otherTeam = teams.find(team => team.id !== assignedTeam.id);
  const player = store.teamPlayers(assignedTeam.id)[0];
  assert.ok(player, 'the assigned team has a source player record');
  const ownerId = createTestUser('owner-test', 'owner-secret');
  store.assignRole(ownerId, 'team_owner', null, assignedTeam.id);
  const auction = store.run("INSERT INTO league_auction(tournament_id,name,status,bid_increment) VALUES(?,?,'running',100000)", assignedTeam.tournament_id, 'Workflow verification');
  const auctionId = Number(auction.lastInsertRowid);
  for (const team of teams) store.run('INSERT INTO league_auctionpurse(auction_id,team_id,budget,spent) VALUES(?,?,5000000,0)', auctionId, team.id);
  const lot = store.run("INSERT INTO league_auctionlot(auction_id,player_id,category_name,base_price,position,status,current_bid) VALUES(?,?,?,100000,1,'current',0)", auctionId, player.id, 'Open');
  const lotId = Number(lot.lastInsertRowid);
  const { response, cookie } = await login('owner-test', 'owner-secret');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/owner/');
  const pageResponse = await fetch(`${baseUrl}/owner/?auction=${auctionId}`, { headers: { cookie } });
  assert.equal(pageResponse.status, 200);
  const ownerHtml = await pageResponse.text();
  assert.match(ownerHtml, new RegExp(assignedTeam.name));
  assert.doesNotMatch(ownerHtml, new RegExp(otherTeam.name), 'the owner room only includes assigned team purses');

  const loginPage = await fetch(`${baseUrl}/login/`, { headers: { cookie } });
  const csrf = (await loginPage.text()).match(/name="csrfToken" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  const key = 'a'.repeat(32);
  async function placeBid(teamId) {
    return fetch(`${baseUrl}/owner/bid/`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: csrf, auction_id: String(auctionId), lot_id: String(lotId), team_id: String(teamId), amount: '100000', idempotencyKey: key })
    });
  }
  assert.equal((await placeBid(otherTeam.id)).status, 302);
  assert.equal(Number(store.get('SELECT COUNT(*) count FROM league_auctionbid').count), 0, 'the owner cannot bid for a different team');
  assert.equal((await placeBid(assignedTeam.id)).status, 302);
  assert.equal((await placeBid(assignedTeam.id)).status, 302);
  assert.equal(Number(store.get('SELECT COUNT(*) count FROM league_auctionbid').count), 1, 'a replayed bid key cannot create another bid');
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './scripts/migrate-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const dbFile = path.resolve(process.env.SPL_DATABASE_PATH || path.join(here, 'data', 'db.sqlite3'));
const mediaRoot = path.resolve(here, '..', 'media');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
if (!fs.existsSync(dbFile)) throw new Error(`The bundled working database is missing: ${dbFile}. Restore it from the project copy; the source archive is never used or modified.`);

export const db = new DatabaseSync(dbFile, { timeout: 5000 });
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
const migrationResult = migrateDatabase(db, { databasePath: dbFile });
if (migrationResult.applied.length) console.info(`[SPL] Applied migrations: ${migrationResult.applied.join(', ')}; backup: ${migrationResult.backup?.backup}`);

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params) ?? null;
export const run = (sql, ...params) => db.prepare(sql).run(...params);
export function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const jparse = (value, fallback) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
};
const scalarTeam = row => row ? {
  id: row.id, pk: row.id, name: row.name, short_name: row.short_name || '',
  logo: row.logo || '', primary_colour: row.primary_colour || '#D9A441',
  tournament: row.tournament_season ? { season: row.tournament_season, name: row.tournament_name } : undefined
} : null;
const tournament = row => row && ({ id: row.id, season: row.season, name: row.name, venue: row.venue, is_current: Boolean(row.is_current), start_date: row.start_date, end_date: row.end_date, description: row.description, champion: row.champion || null });

export function seasons() {
  return all(`SELECT t.*, (SELECT COUNT(*) FROM league_team x WHERE x.tournament_id=t.id) teams_count,
    (SELECT COUNT(*) FROM league_match m WHERE m.tournament_id=t.id) matches_count,
    (SELECT w.name FROM league_match m JOIN league_team w ON w.id=m.winner_id
      WHERE m.tournament_id=t.id AND LOWER(m.stage)='final' AND m.status='completed'
      ORDER BY m.date DESC,m.id DESC LIMIT 1) champion
    FROM league_tournament t ORDER BY season DESC`).map(tournament);
}
export function currentTournament() {
  return tournament(get('SELECT * FROM league_tournament WHERE is_current=1 ORDER BY season DESC LIMIT 1')
    || get('SELECT * FROM league_tournament ORDER BY season DESC LIMIT 1'));
}
export function teams(season = null) {
  const rows = all(`SELECT t.*, tour.season tournament_season,tour.name tournament_name,
    (SELECT COUNT(DISTINCT s.match_id) FROM league_playermatchstat s WHERE s.team_id=t.id) matches_played_count,
    (SELECT COUNT(*) FROM league_player_teams pt WHERE pt.team_id=t.id) player_count
    FROM league_team t JOIN league_tournament tour ON tour.id=t.tournament_id
    ${season ? 'WHERE tour.season=?' : ''} ORDER BY tour.season DESC,t.name`, ...(season ? [season] : []));
  return rows.map(row => ({ ...row, pk: row.id, tournament: { season: row.tournament_season, name: row.tournament_name }, players_count: row.player_count }));
}
export function teamById(id) {
  const row = get(`SELECT t.*,tour.season tournament_season,tour.name tournament_name
    FROM league_team t JOIN league_tournament tour ON tour.id=t.tournament_id WHERE t.id=?`, id);
  return row && { ...row, pk: row.id, tournament: { season: row.tournament_season, name: row.tournament_name } };
}
export function teamPlayers(teamId) {
  return all(`SELECT p.*,COUNT(DISTINCT s.match_id) matches_played_count
    FROM league_player_teams pt JOIN league_player p ON p.id=pt.player_id
    LEFT JOIN league_playermatchstat s ON s.player_id=p.id AND s.team_id=pt.team_id
    WHERE pt.team_id=? GROUP BY p.id ORDER BY p.name`, teamId).map(p => ({ ...p, pk: p.id, photo_url: mediaUrl(p.photo) }));
}
export function players(search = '', activeOnly = true) {
  const where = [];
  const args = [];
  if (activeOnly) where.push('p.is_active=1');
  if (search) { where.push('LOWER(p.name) LIKE LOWER(?)'); args.push(`%${search}%`); }
  const rows = all(`SELECT p.*,COUNT(DISTINCT s.match_id) matches_played_count FROM league_player p
    LEFT JOIN league_playermatchstat s ON s.player_id=p.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY p.id ORDER BY p.name`, ...args);
  return rows.map(p => ({ ...p, pk: p.id, photo_url: mediaUrl(p.photo), teams: playerTeams(p.id) }));
}
function playerTeams(id) {
  return all(`SELECT t.*,tour.season tournament_season,tour.name tournament_name FROM league_player_teams pt
    JOIN league_team t ON t.id=pt.team_id JOIN league_tournament tour ON tour.id=t.tournament_id
    WHERE pt.player_id=? ORDER BY tour.season DESC,t.name`, id).map(t => ({ ...t, pk: t.id, tournament: { season: t.tournament_season, name: t.tournament_name } }));
}
export function playerById(id) {
  const p = get('SELECT p.*, c.name category_name,c.base_price category_base_price FROM league_player p LEFT JOIN league_playercategory c ON c.id=p.auction_category_id WHERE p.id=?', id);
  if (!p) return null;
  return { ...p, pk: p.id, photo_url: mediaUrl(p.photo), teams: playerTeams(p.id),
    stats: all(`SELECT s.*,m.date match_date,m.stage match_stage,m.status match_status,m.result_text match_result,
      tour.season tournament_season,ta.name team_a_name,tb.name team_b_name,t.name performance_team_name
      FROM league_playermatchstat s JOIN league_match m ON m.id=s.match_id JOIN league_tournament tour ON tour.id=m.tournament_id
      JOIN league_team ta ON ta.id=m.team_a_id JOIN league_team tb ON tb.id=m.team_b_id JOIN league_team t ON t.id=s.team_id
      WHERE s.player_id=? ORDER BY m.date DESC,m.id DESC`, id) };
}
function oversToLegalBalls(value) {
  const match = String(value ?? '').match(/^(\d+)(?:\.(\d))?$/);
  if (!match) return 0;
  const balls = Number(match[2] || 0);
  return balls > 5 ? 0 : Number(match[1]) * 6 + balls;
}
export function playerAnalytics(playerId, season = null) {
  const player = playerById(Number(playerId));
  if (!player) return null;
  const rows = player.stats.filter(row => !season || Number(row.tournament_season) === Number(season));
  const totals = rows.reduce((acc, row) => {
    acc.runs += Number(row.runs || 0); acc.balls_faced += Number(row.balls_faced || 0);
    acc.fours += Number(row.fours || 0); acc.sixes += Number(row.sixes || 0);
    acc.dismissals += Number(row.batting_dismissed || 0); acc.wickets += Number(row.wickets || 0);
    acc.bowling_runs += Number(row.bowling_runs || 0); acc.bowling_balls += oversToLegalBalls(row.bowling_overs);
    acc.dot_balls += Number(row.dot_balls || 0); acc.maidens += Number(row.bowling_maidens || 0);
    if (Number(row.balls_faced || 0) || Number(row.runs || 0) || Number(row.batting_dismissed || 0)) acc.batting_innings += 1;
    if (oversToLegalBalls(row.bowling_overs) || Number(row.wickets || 0)) acc.bowling_innings += 1;
    return acc;
  }, { runs:0,balls_faced:0,fours:0,sixes:0,dismissals:0,wickets:0,bowling_runs:0,bowling_balls:0,dot_balls:0,maidens:0,batting_innings:0,bowling_innings:0 });
  totals.matches = new Set(rows.map(row => Number(row.match_id))).size;
  totals.not_outs = Math.max(0, totals.batting_innings - totals.dismissals);
  totals.batting_average = totals.dismissals ? Number((totals.runs / totals.dismissals).toFixed(2)) : null;
  totals.strike_rate = totals.balls_faced ? Number((100 * totals.runs / totals.balls_faced).toFixed(2)) : null;
  totals.bowling_average = totals.wickets ? Number((totals.bowling_runs / totals.wickets).toFixed(2)) : null;
  totals.economy = totals.bowling_balls ? Number((6 * totals.bowling_runs / totals.bowling_balls).toFixed(2)) : null;
  totals.bowling_strike_rate = totals.wickets ? Number((totals.bowling_balls / totals.wickets).toFixed(2)) : null;
  totals.bowling_overs = overs(totals.bowling_balls);
  const best = [...rows].sort((a,b) => Number(b.wickets||0)-Number(a.wickets||0) || Number(a.bowling_runs||0)-Number(b.bowling_runs||0))[0];
  totals.best_bowling = best && (Number(best.wickets||0) || Number(best.bowling_runs||0)) ? `${best.wickets}/${best.bowling_runs}` : null;
  const fielding = get(`SELECT COUNT(*) fielding_rows,
      SUM(CASE WHEN dismissal_type IN ('caught','caught_and_bowled') THEN 1 ELSE 0 END) catches,
      SUM(CASE WHEN dismissal_type='run_out' THEN 1 ELSE 0 END) run_outs,
      SUM(CASE WHEN dismissal_type='stumped' THEN 1 ELSE 0 END) stumpings
    FROM league_delivery d JOIN league_innings i ON i.id=d.innings_id JOIN league_match m ON m.id=i.match_id
    WHERE d.fielder_id=? ${season ? 'AND m.tournament_id=(SELECT id FROM league_tournament WHERE season=?)' : ''}`,
  ...season ? [Number(playerId), Number(season)] : [Number(playerId)]);
  const auctionHistory = all(`SELECT l.id,l.sold_price,l.base_price,l.status,l.category_name,a.name auction_name,tour.season,team.name team_name
    FROM league_auctionlot l JOIN league_auction a ON a.id=l.auction_id JOIN league_tournament tour ON tour.id=a.tournament_id
    LEFT JOIN league_team team ON team.id=l.highest_team_id WHERE l.player_id=? AND l.status='sold'
    ${season ? 'AND tour.season=?' : ''} ORDER BY a.created_at DESC,l.id DESC`, ...season ? [Number(playerId), Number(season)] : [Number(playerId)]);
  return { player, season: season ? Number(season) : null, totals,
    fielding: { available: Number(fielding.fielding_rows || 0) > 0, catches: Number(fielding.catches || 0), run_outs: Number(fielding.run_outs || 0), stumpings: Number(fielding.stumpings || 0) },
    recent: rows.slice(0,6), rows, auctionHistory,
    seasons: [...new Set(player.stats.map(row => Number(row.tournament_season)).filter(Boolean))].sort((a,b) => b-a) };
}
export function playerComparison(playerAId, playerBId, season = null) {
  const a = playerAnalytics(playerAId, season);
  const b = playerAnalytics(playerBId, season);
  return a && b ? { a, b, season: season ? Number(season) : null } : null;
}
export function matchList({ season = null, q = '', status = null, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (season) { where.push('tour.season=?'); args.push(season); }
  if (status) { where.push('m.status=?'); args.push(status); }
  if (q) { where.push('(LOWER(ta.name) LIKE LOWER(?) OR LOWER(tb.name) LIKE LOWER(?))'); args.push(`%${q}%`, `%${q}%`); }
  args.push(limit);
  return all(`SELECT m.*,tour.season tournament_season,tour.name tournament_name,
    ta.id ta_id,ta.name ta_name,ta.short_name ta_short,ta.logo ta_logo,ta.primary_colour ta_colour,
    tb.id tb_id,tb.name tb_name,tb.short_name tb_short,tb.logo tb_logo,tb.primary_colour tb_colour,
    w.id w_id,w.name w_name,w.short_name w_short,w.logo w_logo,w.primary_colour w_colour
    FROM league_match m JOIN league_tournament tour ON tour.id=m.tournament_id
    JOIN league_team ta ON ta.id=m.team_a_id JOIN league_team tb ON tb.id=m.team_b_id LEFT JOIN league_team w ON w.id=m.winner_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.date DESC,m.id DESC LIMIT ?`, ...args).map(row => {
      const team_a = scalarTeam({ id: row.ta_id, name: row.ta_name, short_name: row.ta_short, logo: row.ta_logo, primary_colour: row.ta_colour });
      const team_b = scalarTeam({ id: row.tb_id, name: row.tb_name, short_name: row.tb_short, logo: row.tb_logo, primary_colour: row.tb_colour });
      const winner = row.w_id ? scalarTeam({ id: row.w_id, name: row.w_name, short_name: row.w_short, logo: row.w_logo, primary_colour: row.w_colour }) : null;
      const match = { ...row, pk: row.id, team_a, team_b, winner,
        score_summaries: jparse(row.score_summaries, []), best_batters: jparse(row.best_batters, []), best_bowlers: jparse(row.best_bowlers, []), full_scorecard: jparse(row.full_scorecard, {}),
        tournament: { season: row.tournament_season, name: row.tournament_name }, status_display: statusLabel(row.status) };
      match.innings = inningsForMatch(row.id);
      match.score_a = scoreFor(match, team_a);
      match.score_b = scoreFor(match, team_b);
      return match;
    });
}
export function matchById(id) { return matchList({ limit: 1, q: '', status: null }).find(m => m.id === Number(id)) || (get('SELECT id FROM league_match WHERE id=?', id) ? matchList({ limit: 500 }).find(m => m.id === Number(id)) : null); }
function inningsForMatch(id) {
  return all(`SELECT i.*,bt.name bt_name,bt.short_name bt_short,bt.logo bt_logo,bt.primary_colour bt_colour,
    bw.name bw_name,bw.short_name bw_short,bw.logo bw_logo,bw.primary_colour bw_colour
    FROM league_innings i JOIN league_team bt ON bt.id=i.batting_team_id JOIN league_team bw ON bw.id=i.bowling_team_id
    WHERE i.match_id=? ORDER BY i.innings_number`, id).map(i => ({ ...i, pk: i.id,
      batting_team: scalarTeam({ id: i.batting_team_id, name: i.bt_name, short_name: i.bt_short, logo: i.bt_logo, primary_colour: i.bt_colour }),
      bowling_team: scalarTeam({ id: i.bowling_team_id, name: i.bw_name, short_name: i.bw_short, logo: i.bw_logo, primary_colour: i.bw_colour }),
      deliveries: all(`SELECT d.*,b.name batter_name,bw.name bowler_name,dp.name dismissed_name,f.name fielder_name
        FROM league_delivery d JOIN league_player b ON b.id=d.batter_id JOIN league_player bw ON bw.id=d.bowler_id
        LEFT JOIN league_player dp ON dp.id=d.dismissed_player_id LEFT JOIN league_player f ON f.id=d.fielder_id
        WHERE d.innings_id=? ORDER BY d.over_number DESC,d.ball_number DESC,d.id DESC`, i.id).map(d => ({ ...d, batter: { id: d.batter_id, name: d.batter_name }, bowler: { id: d.bowler_id, name: d.bowler_name }, dismissed_player: d.dismissed_player_id ? { id: d.dismissed_player_id, name: d.dismissed_name } : null, fielder: d.fielder_id ? { id: d.fielder_id, name: d.fielder_name } : null }))
    }));
}
function scoreFor(match, team) {
  const live = (match.innings || []).filter(i => Number(i.batting_team_id) === Number(team.id));
  if (live.length) { const i = live.at(-1); return { score: `${i.total_runs}/${i.wickets}`, overs: overs(i.legal_balls) }; }
  const summaries = jparse(match.score_summaries, []);
  const found = summaries.find(x => String(x.team || '').toLowerCase() === String(team.name).toLowerCase());
  return found ? { score: found.score ?? '—', overs: found.overs || '' } : { score: '—', overs: '' };
}
export function playerStats(id) { return all('SELECT * FROM league_playermatchstat WHERE player_id=? ORDER BY id DESC', id); }
export function rolesForUser(userId) {
  const user = get('SELECT id,is_staff,is_superuser,is_active FROM auth_user WHERE id=?', userId);
  if (!user || !user.is_active) return [];
  const assigned = all(`SELECT r.role_key FROM spl_user_role ur JOIN spl_role r ON r.id=ur.role_id WHERE ur.user_id=? ORDER BY r.role_key`, userId).map(row => row.role_key);
  if (user.is_superuser) return [...new Set(['super_admin', ...assigned])];
  if (assigned.length) return assigned;
  return user.is_staff ? ['organiser'] : ['spectator'];
}
export function accessUsers() {
  return all(`SELECT u.id,u.username,u.email,u.is_staff,u.is_superuser,u.is_active,
      GROUP_CONCAT(DISTINCT r.role_key) role_keys,GROUP_CONCAT(DISTINCT towner.team_id) owner_team_ids
    FROM auth_user u LEFT JOIN spl_user_role ur ON ur.user_id=u.id LEFT JOIN spl_role r ON r.id=ur.role_id
    LEFT JOIN spl_team_owner towner ON towner.user_id=u.id
    GROUP BY u.id ORDER BY u.username COLLATE NOCASE`);
}
export function accessAssignments() {
  return all(`SELECT ur.user_id,ur.role_id,ur.granted_by_id,ur.created_at,u.username,r.role_key,r.display_name
    FROM spl_user_role ur JOIN auth_user u ON u.id=ur.user_id JOIN spl_role r ON r.id=ur.role_id WHERE r.role_key<>'team_owner'
    ORDER BY u.username COLLATE NOCASE,r.role_key`);
}
export function teamOwnerAssignments() {
  return all(`SELECT owner.user_id,owner.team_id,u.username,t.name team_name,tour.season
    FROM spl_team_owner owner JOIN auth_user u ON u.id=owner.user_id
    JOIN league_team t ON t.id=owner.team_id JOIN league_tournament tour ON tour.id=t.tournament_id
    ORDER BY u.username COLLATE NOCASE,tour.season DESC,t.name`);
}
export function teamOwnerTeams(userId) {
  return all(`SELECT t.*,tour.season tournament_season,tour.name tournament_name FROM spl_team_owner o
    JOIN league_team t ON t.id=o.team_id JOIN league_tournament tour ON tour.id=t.tournament_id
    WHERE o.user_id=? ORDER BY tour.season DESC,t.name`, userId).map(row => ({ ...row, tournament: { season: row.tournament_season, name: row.tournament_name } }));
}
export function ownerAuctions(userId) {
  return all(`SELECT DISTINCT a.*,tour.season FROM spl_team_owner owner
    JOIN league_team team ON team.id=owner.team_id JOIN league_auction a ON a.tournament_id=team.tournament_id
    JOIN league_tournament tour ON tour.id=a.tournament_id WHERE owner.user_id=? ORDER BY a.created_at DESC,a.id DESC`, userId);
}
export function assignRole(userId, roleKey, grantedById, teamId = null) {
  const user = get('SELECT id,is_active FROM auth_user WHERE id=?', userId);
  const role = get('SELECT id,role_key FROM spl_role WHERE role_key=? AND is_assignable=1', roleKey);
  if (!user || !user.is_active || !role) throw new Error('Choose an active account and an available role.');
  if (roleKey === 'team_owner') {
    const team = get('SELECT id FROM league_team WHERE id=?', teamId);
    if (!team) throw new Error('Choose a valid team for the owner assignment.');
  }
  transaction(() => {
    run('INSERT OR IGNORE INTO spl_user_role(user_id,role_id,granted_by_id) VALUES(?,?,?)', user.id, role.id, grantedById || null);
    if (roleKey === 'team_owner') run('INSERT OR IGNORE INTO spl_team_owner(user_id,team_id) VALUES(?,?)', user.id, Number(teamId));
  });
}
export function removeRole(userId, roleKey, teamId = null) {
  const role = get('SELECT id FROM spl_role WHERE role_key=?', roleKey);
  if (!role) throw new Error('Choose a valid role.');
  transaction(() => {
    if (roleKey === 'team_owner' && teamId) run('DELETE FROM spl_team_owner WHERE user_id=? AND team_id=?', userId, teamId);
    if (roleKey !== 'team_owner' || !get('SELECT 1 FROM spl_team_owner WHERE user_id=?', userId)) run('DELETE FROM spl_user_role WHERE user_id=? AND role_id=?', userId, role.id);
  });
}
export function recordAudit({ actorId = null, action, entityType, entityId = null, details = {}, requestId = null }) {
  run('INSERT INTO spl_audit_log(actor_id,action,entity_type,entity_id,details_json,request_id) VALUES(?,?,?,?,?,?)',
    actorId, String(action).slice(0,80), String(entityType).slice(0,80), entityId == null ? null : String(entityId).slice(0,100), JSON.stringify(details).slice(0,2000), requestId ? String(requestId).slice(0,80) : null);
}
function requiredInteger(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${label} must be a whole number of at least ${minimum}.`);
  return number;
}
export function placeAuctionBid({ auctionId, lotId, teamId, amount, userId, requestKey }) {
  if (!/^[a-f0-9]{32}$/i.test(String(requestKey || ''))) throw new Error('Refresh the auction page before placing a bid.');
  return transaction(() => {
    const prior = get('SELECT action FROM spl_idempotency_key WHERE user_id=? AND request_key=?', userId, requestKey);
    if (prior) return { duplicate: true };
    const auction = get('SELECT * FROM league_auction WHERE id=?', requiredInteger(auctionId, 'Auction', 1));
    if (!auction || auction.status !== 'running') throw new Error('Bids are accepted only while the auction is live.');
    const lot = get("SELECT * FROM league_auctionlot WHERE id=? AND auction_id=? AND status='current'", requiredInteger(lotId, 'Player lot', 1), auction.id);
    if (!lot) throw new Error('That player is no longer on the block.');
    const purse = get('SELECT ap.*,team.name FROM league_auctionpurse ap JOIN league_team team ON team.id=ap.team_id WHERE ap.auction_id=? AND ap.team_id=?', auction.id, requiredInteger(teamId, 'Team', 1));
    if (!purse) throw new Error('Choose a participating team.');
    if (Number(lot.highest_team_id) === Number(purse.team_id)) throw new Error('That team already leads this player.');
    const minimum = lot.highest_team_id ? Math.max(lot.base_price, lot.current_bid + auction.bid_increment) : lot.base_price;
    const bid = requiredInteger(amount, 'Bid amount', minimum);
    if (bid > purse.budget - purse.spent) throw new Error(`That bid exceeds ${purse.name}’s remaining purse.`);
    run('INSERT INTO league_auctionbid(lot_id,team_id,amount,placed_by_id,placed_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)', lot.id, purse.team_id, bid, userId);
    run('UPDATE league_auctionlot SET current_bid=?,highest_team_id=? WHERE id=? AND status=\'current\'', bid, purse.team_id, lot.id);
    run('INSERT INTO spl_idempotency_key(user_id,request_key,action,response_json) VALUES(?,?,?,?)', userId, requestKey, 'auction_bid', JSON.stringify({ auctionId: auction.id, lotId: lot.id, teamId: purse.team_id, amount: bid }));
    recordAudit({ actorId: userId, action: 'place_bid', entityType: 'auction_lot', entityId: lot.id, details: { teamId: purse.team_id, amount: bid } });
    return { duplicate: false, amount: bid, teamId: purse.team_id };
  });
}
export function settleAuctionLot({ auctionId, lotId, result, actorId }) {
  if (!['sold','unsold'].includes(result)) throw new Error('Choose sold or unsold.');
  return transaction(() => {
    const auction = get('SELECT * FROM league_auction WHERE id=?', requiredInteger(auctionId, 'Auction', 1));
    if (!auction || auction.status !== 'running') throw new Error('The auction must be live to record a result.');
    const lot = get("SELECT * FROM league_auctionlot WHERE id=? AND auction_id=? AND status='current'", requiredInteger(lotId, 'Player lot', 1), auction.id);
    if (!lot) throw new Error('That player is no longer on the block.');
    if (result === 'sold' && !lot.highest_team_id) throw new Error('A player can be sold after a team places a valid bid.');
    const next = get("SELECT id FROM league_auctionlot WHERE auction_id=? AND status='queued' ORDER BY position,id LIMIT 1", auction.id);
    if (result === 'sold') {
      const purse = get('SELECT * FROM league_auctionpurse WHERE auction_id=? AND team_id=?', auction.id, lot.highest_team_id);
      if (!purse || purse.budget - purse.spent < lot.current_bid) throw new Error('The leading team’s purse no longer covers this bid.');
      run('UPDATE league_auctionpurse SET spent=spent+? WHERE id=? AND spent+?<=budget', lot.current_bid, purse.id, lot.current_bid);
      if (db.prepare('SELECT changes() changed').get().changed !== 1) throw new Error('The team purse changed before the sale was recorded.');
      run("UPDATE league_auctionlot SET status='sold',sold_price=? WHERE id=? AND status='current'", lot.current_bid, lot.id);
    } else run("UPDATE league_auctionlot SET status='unsold' WHERE id=? AND status='current'", lot.id);
    if (db.prepare('SELECT changes() changed').get().changed !== 1) throw new Error('That player has already been settled.');
    if (next) run("UPDATE league_auctionlot SET status='current' WHERE id=? AND status='queued'", next.id);
    else run("UPDATE league_auction SET status='finalized',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'", auction.id);
    recordAudit({ actorId, action: `auction_${result}`, entityType: 'auction_lot', entityId: lot.id, details: { teamId: lot.highest_team_id, amount: result === 'sold' ? lot.current_bid : null } });
    return { lotId: lot.id, result, nextLotId: next?.id || null };
  });
}
export function changeAuctionState(auctionId, action, actorId) {
  return transaction(() => {
    const auction = get('SELECT * FROM league_auction WHERE id=?', requiredInteger(auctionId, 'Auction', 1));
    if (!auction) throw new Error('Choose a valid auction.');
    if (action === 'start') {
      if (!['draft','ready'].includes(auction.status)) throw new Error('That auction state change is not available.');
      const first = get("SELECT id FROM league_auctionlot WHERE auction_id=? AND status='queued' ORDER BY position,id LIMIT 1", auction.id);
      if (!first) throw new Error('Add at least one player to the auction queue first.');
      if (!get('SELECT id FROM league_auctionpurse WHERE auction_id=? AND budget>0', auction.id)) throw new Error('Set positive team purses before starting.');
      run("UPDATE league_auctionlot SET status='current' WHERE id=? AND status='queued'", first.id);
      run("UPDATE league_auction SET status='running',updated_at=CURRENT_TIMESTAMP WHERE id=?", auction.id);
    } else if (action === 'pause' && auction.status === 'running') run("UPDATE league_auction SET status='paused',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'", auction.id);
    else if (action === 'resume' && auction.status === 'paused') run("UPDATE league_auction SET status='running',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='paused'", auction.id);
    else throw new Error('That auction state change is not available.');
    recordAudit({ actorId, action: `auction_${action}`, entityType: 'auction', entityId: auction.id });
    return get('SELECT * FROM league_auction WHERE id=?', auction.id);
  });
}
export function moveAuctionQueue(auctionId, lotId, direction, actorId) {
  return transaction(() => {
    const auction = get('SELECT * FROM league_auction WHERE id=?', requiredInteger(auctionId, 'Auction', 1));
    if (!auction || !['draft','ready'].includes(auction.status)) throw new Error('The queue is locked once the auction starts.');
    const lot = get("SELECT * FROM league_auctionlot WHERE id=? AND auction_id=? AND status='queued'", requiredInteger(lotId, 'Player lot', 1), auction.id);
    if (!lot) throw new Error('That queued player is no longer available to move.');
    const upward = direction === 'up';
    const other = get(`SELECT * FROM league_auctionlot WHERE auction_id=? AND status='queued' AND position ${upward ? '<' : '>'} ? ORDER BY position ${upward ? 'DESC' : 'ASC'},id ${upward ? 'DESC' : 'ASC'} LIMIT 1`, auction.id, lot.position);
    if (!other) return false;
    const temporary = Number(get('SELECT COALESCE(MAX(position),0)+1 value FROM league_auctionlot WHERE auction_id=?', auction.id).value);
    run('UPDATE league_auctionlot SET position=? WHERE id=?', temporary, lot.id);
    run('UPDATE league_auctionlot SET position=? WHERE id=?', lot.position, other.id);
    run('UPDATE league_auctionlot SET position=? WHERE id=?', other.position, lot.id);
    recordAudit({ actorId, action: 'auction_queue_move', entityType: 'auction_lot', entityId: lot.id, details: { direction } });
    return true;
  });
}
export function auditRecords({ limit = 100 } = {}) {
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  return all(`SELECT a.*,u.username FROM spl_audit_log a LEFT JOIN auth_user u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.id DESC LIMIT ?`, take);
}
export function leaderboard(season = null) {
  const condition = season ? 'AND m.tournament_id=(SELECT id FROM league_tournament WHERE season=?)' : '';
  const args = season ? [season] : [];
  const base = all(`SELECT p.id,p.name,p.city,p.photo, SUM(s.runs) runs,SUM(s.balls_faced) balls_faced,
    SUM(s.fours) fours,SUM(s.sixes) sixes,SUM(s.wickets) wickets,SUM(s.dot_balls) dot_balls,
    SUM(s.bowling_runs) bowling_runs,
    SUM(CASE WHEN instr(s.bowling_overs,'.')>0 THEN CAST(substr(s.bowling_overs,1,instr(s.bowling_overs,'.')-1) AS INTEGER)*6+CAST(substr(s.bowling_overs,instr(s.bowling_overs,'.')+1) AS INTEGER) ELSE 0 END) bowling_balls,
    COUNT(DISTINCT s.match_id) appearances,SUM(s.batting_dismissed) dismissals
    FROM league_playermatchstat s JOIN league_player p ON p.id=s.player_id JOIN league_match m ON m.id=s.match_id
    WHERE 1=1 ${condition} GROUP BY p.id ORDER BY p.name`, ...args).map(r => {
      const memberships = playerTeams(r.id).filter(t => !season || Number(t.tournament.season) === Number(season));
      const runs = Number(r.runs || 0), balls = Number(r.balls_faced || 0), wickets = Number(r.wickets || 0);
      const points = runs + 7 * Number(r.fours || 0) + 9 * Number(r.sixes || 0) + 25 * wickets;
      const bowlingBalls = Number(r.bowling_balls || 0), bowlingRuns = Number(r.bowling_runs || 0);
      return { ...r, id: r.id, profile: { id: r.id, pk: r.id, name: r.name, photo: r.photo, photo_url: mediaUrl(r.photo) },
        team: memberships[0]?.name || 'SPL player', teams: memberships.map(t => t.name).join(', ') || 'SPL player',
        mvp: points, points, value: runs, matches_played: Number(r.appearances || 0),
        strike_rate: balls ? (100 * runs / balls).toFixed(2) : '0.00',
        economy: bowlingBalls ? (6 * bowlingRuns / bowlingBalls).toFixed(2) : '0.00' };
    });
  const batting = base.filter(r => Number(r.runs) || Number(r.balls_faced)).sort((a,b) => b.runs-a.runs).slice(0,20);
  const bowling = base.filter(r => Number(r.wickets) || Number(r.dot_balls)).sort((a,b) => b.wickets-a.wickets || b.dot_balls-a.dot_balls).slice(0,20);
  const mvp = [...base].filter(r => r.mvp > 0).sort((a,b) => b.mvp-a.mvp).slice(0,20);
  const dot_balls = [...base].filter(r => Number(r.dot_balls)).sort((a,b) => b.dot_balls-a.dot_balls).slice(0,20);
  const appearances = [...base].sort((a,b) => b.appearances-a.appearances).slice(0,20);
  const fielding = all(`SELECT p.id,p.name,p.city,
    SUM(CASE WHEN d.dismissal_type IN ('caught','caught_and_bowled') THEN 1 ELSE 0 END) catches,
    SUM(CASE WHEN d.dismissal_type='run_out' THEN 1 ELSE 0 END) run_outs,
    COUNT(*) value
    FROM league_delivery d JOIN league_player p ON p.id=d.fielder_id JOIN league_innings i ON i.id=d.innings_id JOIN league_match m ON m.id=i.match_id
    WHERE d.fielder_id IS NOT NULL AND d.dismissal_type IN ('caught','caught_and_bowled','run_out') ${season ? 'AND m.tournament_id=(SELECT id FROM league_tournament WHERE season=?)' : ''}
    GROUP BY p.id ORDER BY value DESC LIMIT 20`, ...args).map(r => ({ ...r, dismissals: Number(r.catches || 0) + Number(r.run_outs || 0), name: r.name, profile: { id: r.id, name: r.name }, team: 'SPL player' }));
  return { batting, bowling, mvp, dot_balls, appearances, fielding };
}
export function pointsTable(season = null) {
  const selected = season ? seasons().find(item => Number(item.season) === Number(season)) : currentTournament();
  if (!selected) return [];
  const rows = teams(selected.season).map(team => ({
    team, played: 0, won: 0, lost: 0, tied: 0, no_result: 0, points: 0, net_run_rate: null
  }));
  const byId = new Map(rows.map(row => [Number(row.team.id), row]));
  const leagueMatches = matchList({ season: selected.season, status: 'completed', limit: 500 })
    .filter(match => !/(quarter|semi|final|playoff|knockout)/i.test(match.stage || ''));
  for (const match of leagueMatches) {
    const home = byId.get(Number(match.team_a.id));
    const away = byId.get(Number(match.team_b.id));
    if (!home || !away) continue;
    home.played += 1;
    away.played += 1;
    if (match.winner?.id === home.team.id) { home.won += 1; away.lost += 1; }
    else if (match.winner?.id === away.team.id) { away.won += 1; home.lost += 1; }
    else if (/\b(tie|tied|draw|drawn)\b/i.test(match.result_text || '')) {
      home.tied += 1; away.tied += 1;
    } else {
      home.no_result += 1; away.no_result += 1;
    }
  }
  for (const row of rows) row.points = row.won * 2 + row.tied + row.no_result;
  return rows.sort((a, b) => b.points - a.points || b.won - a.won || a.team.name.localeCompare(b.team.name));
}
export function sponsors() {
  return all(`SELECT * FROM league_sponsor ORDER BY CASE category WHEN 'title' THEN 0 ELSE 1 END,name`).map(s => ({ ...s, pk: s.id, category_display: s.category === 'title' ? 'Title Sponsor' : 'Associate Sponsor', logo_url: mediaUrl(s.logo) }));
}
export function playerCount() { return Number(get('SELECT COUNT(*) n FROM league_player').n); }
export function matchCount() { return Number(get('SELECT COUNT(*) n FROM league_match').n); }
export function teamCount() { return Number(get('SELECT COUNT(*) n FROM league_team').n); }
export function mediaUrl(value) {
  if (!value) return '';
  const relative = String(value).replace(/^\/+/, '').replaceAll('\\', '/');
  const target = path.resolve(mediaRoot, relative);
  if (!target.startsWith(`${mediaRoot}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return '';
  return `/media/${relative.split('/').map(encodeURIComponent).join('/')}`;
}
export function statusLabel(status) { return ({ live: 'Live', completed: 'Completed', scheduled: 'Scheduled', abandoned: 'Abandoned', running: 'Live', paused: 'Paused', ready: 'Ready', draft: 'Draft', finalized: 'Finalized' })[status] || status; }
export function overs(legalBalls) { return `${Math.floor(Number(legalBalls || 0) / 6)}.${Number(legalBalls || 0) % 6}`; }
export function sharedData() {
  const tour = currentTournament();
  const season = tour?.season || null;
  const live = matchList({ status: 'live', limit: 4 });
  const recent = matchList({ status: 'completed', limit: 4 });
  const upcoming = matchList({ status: 'scheduled', limit: 4 });
  return { tournament: tour, seasons: seasons(), live, recent, upcoming, ticker: [...live, ...upcoming, ...recent].slice(0,4),
    leaders: leaderboard(season), teams: season ? teams(season) : [], standings: pointsTable(season),
    champions: matchList({ status: 'completed', limit: 100 }).filter(m => /final/i.test(m.stage || '') && m.winner).slice(0,3) };
}
export function publicAuction(id = null) {
  const auction = id ? get('SELECT a.*,t.season FROM league_auction a JOIN league_tournament t ON t.id=a.tournament_id WHERE a.id=?', id)
    : get('SELECT a.*,t.season FROM league_auction a JOIN league_tournament t ON t.id=a.tournament_id ORDER BY a.created_at DESC,a.id DESC LIMIT 1');
  if (!auction) return { auction: null, refresh_active: false };
  const lots = all(`SELECT l.*,p.name player_name,p.city,p.photo,c.name category,ht.name highest_team_name,ht.short_name highest_team_short,ht.logo highest_team_logo,ht.primary_colour highest_team_colour FROM league_auctionlot l JOIN league_player p ON p.id=l.player_id LEFT JOIN league_playercategory c ON c.id=l.category_id LEFT JOIN league_team ht ON ht.id=l.highest_team_id WHERE l.auction_id=? ORDER BY l.position,l.id`, auction.id).map(l => ({ ...l, player: { id: l.player_id, pk: l.player_id, name: l.player_name, city: l.city, photo: l.photo, photo_url: mediaUrl(l.photo) }, category_name: l.category_name || l.category || 'Uncategorised', highest_team: l.highest_team_id ? { id: l.highest_team_id, name: l.highest_team_name, short_name: l.highest_team_short, logo: l.highest_team_logo, primary_colour: l.highest_team_colour } : null, next_bid: l.highest_team_id ? Math.max(l.base_price, l.current_bid + auction.bid_increment) : l.base_price }));
  const current_lot = lots.find(l => l.status === 'current') || null;
  const purses = all(`SELECT ap.*,t.name team_name,t.short_name,t.logo,t.primary_colour FROM league_auctionpurse ap JOIN league_team t ON t.id=ap.team_id WHERE ap.auction_id=? ORDER BY t.name`, auction.id).map(p => ({ ...p, team: scalarTeam({ id: p.team_id, name: p.team_name, short_name: p.short_name, logo: p.logo, primary_colour: p.primary_colour }), remaining: p.budget - p.spent, percent_spent: p.budget ? Math.min(100, Math.floor(p.spent * 100 / p.budget)) : 0, acquired_count: lots.filter(l => l.status === 'sold' && l.highest_team_id === p.team_id).length }));
  const bids = all(`SELECT b.*,t.name team_name,t.short_name,l.player_id,p.name player_name FROM league_auctionbid b JOIN league_team t ON t.id=b.team_id JOIN league_auctionlot l ON l.id=b.lot_id JOIN league_player p ON p.id=l.player_id WHERE l.auction_id=? ORDER BY b.placed_at DESC,b.id DESC LIMIT 6`, auction.id).map(b => ({ ...b, team: { name: b.team_name, short_name: b.short_name }, lot: { player: { name: b.player_name } } }));
  const sold = lots.filter(l => l.status === 'sold');
  return { auction: { ...auction, pk: auction.id, status_display: statusLabel(auction.status) }, current_lot, team_purses: purses,
    recent_bids: bids, upcoming_lots: lots.filter(l => l.status === 'queued').slice(0,8), previous_lots: lots.filter(l => ['sold','unsold'].includes(l.status)).slice(-8).reverse(),
    category_sales: Object.values(sold.reduce((acc,l) => { const k=l.category_name; acc[k] ||= { category_name:k,players_sold:0,total_spend:0 }; acc[k].players_sold++; acc[k].total_spend += l.sold_price||0; return acc; },{})),
    total_lots: lots.length, sold_count: sold.length, unsold_count: lots.filter(l=>l.status==='unsold').length, queued_count: lots.filter(l=>l.status==='queued').length,
    auctioned_count: sold.length + lots.filter(l=>l.status==='unsold').length, highest_bid: Math.max(0,...lots.map(l=>l.current_bid||0)),
    top_sale: sold.sort((a,b)=>b.sold_price-a.sold_price)[0] || null,
    refresh_active: ['ready','running','paused'].includes(auction.status) };
}
export function auctionResults(id = null) {
  const auction = id ? get('SELECT a.id,a.name,a.status,t.season FROM league_auction a JOIN league_tournament t ON t.id=a.tournament_id WHERE a.id=?', id)
    : get('SELECT a.id,a.name,a.status,t.season FROM league_auction a JOIN league_tournament t ON t.id=a.tournament_id ORDER BY a.created_at DESC,a.id DESC LIMIT 1');
  if (!auction) return null;
  const lots = all(`SELECT l.id,l.position,l.category_name,l.base_price,l.status,l.sold_price,p.name player_name,t.name team_name
    FROM league_auctionlot l JOIN league_player p ON p.id=l.player_id LEFT JOIN league_team t ON t.id=l.highest_team_id
    WHERE l.auction_id=? ORDER BY l.position,l.id`, auction.id);
  return { auction, lots };
}
export function organizerAuctionData() {
  return { categories: all('SELECT * FROM league_playercategory ORDER BY position,name'),
    players: all(`SELECT p.*,c.name category_name,c.base_price category_base_price FROM league_player p LEFT JOIN league_playercategory c ON c.id=p.auction_category_id ORDER BY p.name`),
    auctions: all('SELECT a.*,t.season FROM league_auction a JOIN league_tournament t ON t.id=a.tournament_id ORDER BY a.created_at DESC,a.id DESC'),
    tournaments: all('SELECT * FROM league_tournament ORDER BY season DESC').map(tournament) };
}
export function adminCounts() {
  return { teams: teamCount(), matches: matchCount(), players: playerCount(), deliveries: Number(get('SELECT COUNT(*) n FROM league_delivery').n),
    enquiries: Number(get('SELECT COUNT(*) n FROM league_contactenquiry WHERE is_resolved=0').n), marquee_players: Number(get('SELECT COUNT(*) n FROM league_player WHERE is_marquee=1').n), auction_categories: Number(get('SELECT COUNT(*) n FROM league_playercategory').n),
    recent_enquiries: all('SELECT * FROM league_contactenquiry ORDER BY created_at DESC LIMIT 8') };
}

export function archiveTeamMatches(teamId) {
  return matchList({ limit: 500 }).filter(m => m.team_a_id === Number(teamId) || m.team_b_id === Number(teamId));
}
export function deliveryPlayersForMatch(match) {
  return all(`SELECT DISTINCT p.* FROM league_player p JOIN league_player_teams pt ON pt.player_id=p.id WHERE pt.team_id IN (?,?) AND p.is_active=1 ORDER BY p.name`, match.team_a_id, match.team_b_id).map(p => ({ ...p, pk: p.id, teams: playerTeams(p.id) }));
}


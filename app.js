import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
import * as store from './db.js';
import { SQLiteSessionStore } from './scripts/sqlite-session-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
const port = Number(process.env.PORT || 3000);
const uploads = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const production = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;
if (production && (!sessionSecret || sessionSecret.length < 32 || sessionSecret.includes('replace-with-'))) {
  throw new Error('Production requires a SESSION_SECRET with at least 32 characters. Set it in the deployment environment before starting SPL.');
}
const loginAttempts = new Map();
const configuredSiteUrl = process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
const parsedSiteUrl = new URL(configuredSiteUrl);
if (!['http:','https:'].includes(parsedSiteUrl.protocol)) throw new Error('SITE_URL must use HTTP or HTTPS.');
const siteOrigin = parsedSiteUrl.origin;

app.disable('x-powered-by');
if (production) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(here, 'views'));
app.use('/static', express.static(path.join(here, 'public', 'static'), { maxAge: '1h' }));
app.use('/media', express.static(path.resolve(here, '..', 'media'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(session({
  name: 'spl.sid',
  store: new SQLiteSessionStore(store.db),
  secret: sessionSecret || crypto.randomBytes(48).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

app.locals.initials = value => String(value || 'SPL').trim().split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase();
app.locals.abbreviation = team => String(team?.short_name || team?.name || 'SPL').trim().split(/\s+/).map(x => x[0]).join('').slice(0, 3).toUpperCase();
app.locals.teamColour = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#d9ad50';
app.locals.mediaUrl = store.mediaUrl;
app.locals.overs = store.overs;
app.locals.inr = value => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Number(value || 0));
app.locals.date = value => value ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(`${String(value).slice(0, 10)}T12:00:00+05:30`)) : 'Date to be announced';
app.locals.statusLabel = store.statusLabel;
app.locals.scoreFor = (match, team) => match.team_a?.id === team.id ? match.score_a : match.score_b;
app.locals.csrfField = token => `<input type="hidden" name="csrfToken" value="${String(token).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`;

function flash(req, message, type = 'info') { req.session.flash = { message, type }; }
function sendCsv(res, filename, headers, records) {
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  const content = [headers, ...records].map(row => row.map(cell).join(',')).join('\r\n');
  return res.status(200).attachment(filename).type('text/csv; charset=utf-8').send(`\uFEFF${content}`);
}
function validSeason(raw) {
  if (raw == null || raw === '') return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error('Choose a valid positive season number.');
  return value;
}
function shared(req, res, page, extra = {}) {
  const currentUser = req.session.user || null;
  const message = req.session.flash || null;
  delete req.session.flash;
  const pageSeasons = extra.seasons ?? extra.ui?.seasons ?? store.seasons();
  const roles = currentUser ? store.rolesForUser(currentUser.id) : [];
  const staff = roles.some(role => ['super_admin','organiser','auctioneer','scorer'].includes(role));
  return { page, ui: extra.ui ?? null, seasons: pageSeasons, user: { id: currentUser?.id, is_staff: staff, is_authenticated: Boolean(currentUser), username: currentUser?.username, roles },
    currentYear: new Date().getFullYear(), csrfToken: req.session.csrfToken ||= crypto.randomBytes(24).toString('hex'), auctionNonce: crypto.randomBytes(16).toString('hex'), message, query: req.query,
    metaDescription: 'Sindhi Premier League — community cricket, match results, teams, players and statistics from Ulhasnagar.', canonicalUrl: `${siteOrigin}${req.path || '/'}`, ...extra };
}
function page(res, req, template, title, name, data = {}) {
  return res.render(`pages/${template}`, { ...shared(req, res, name, data), title, metaDescription: data.metaDescription || 'Sindhi Premier League — community cricket, match results, teams, players and statistics from Ulhasnagar.', canonicalUrl: `${siteOrigin}${req.path || '/'}` });
}
function routePage(template, title, name, load) {
  return (req, res, next) => { try { page(res, req, template, title, name, load(req)); } catch (e) { next(e); } };
}
function requireRoles(...allowed) {
  return (req, res, next) => {
    const currentUser = req.session.user;
    if (!currentUser) {
      flash(req, 'Sign in with an authorised SPL account to continue.', 'error');
      return res.redirect('/login/');
    }
    const roles = store.rolesForUser(currentUser.id);
    if (roles.includes('super_admin') || roles.some(role => allowed.includes(role))) return next();
    return res.status(403).render('pages/error', { ...shared(req, res, 'error'), title: 'Access restricted · SPL', status: 403, message: 'This account does not have permission to open this SPL control room.' });
  };
}
const requireLeagueAdmin = requireRoles('organiser');
const requireScorer = requireRoles('organiser','scorer');
const requireAuctioneer = requireRoles('organiser','auctioneer');
function requireAuthenticated(req, res, next) {
  if (req.session.user && store.rolesForUser(req.session.user.id).length) return next();
  flash(req, 'Sign in to continue.', 'error');
  return res.redirect('/login/');
}
function requireExplicitRole(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      flash(req, 'Sign in with an authorised SPL account to continue.', 'error');
      return res.redirect('/login/');
    }
    if (store.rolesForUser(req.session.user.id).includes(role)) return next();
    return res.status(403).render('pages/error', { ...shared(req, res, 'error'), title: 'Access restricted · SPL', status: 403, message: 'This account does not have permission to open this SPL area.' });
  };
}
function requireManageAccess(req, res, next) {
  return req.query.section === 'access' ? requireExplicitRole('super_admin')(req, res, next) : requireLeagueAdmin(req, res, next);
}
function requireManageMutation(req, res, next) {
  return req.body.entity === 'access' ? requireExplicitRole('super_admin')(req, res, next) : requireLeagueAdmin(req, res, next);
}
function loginRateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const previous = loginAttempts.get(key) || { count: 0, expires: now + 15 * 60 * 1000 };
  if (now > previous.expires) { previous.count = 0; previous.expires = now + 15 * 60 * 1000; }
  if (previous.count >= 8) {
    res.setHeader('Retry-After', Math.ceil((previous.expires - now) / 1000));
    res.status(429);
    return page(res, req, 'login', 'Organiser sign-in · SPL', 'login', { error: 'Too many sign-in attempts. Wait a few minutes and try again.' });
  }
  previous.count += 1;
  loginAttempts.set(key, previous);
  if (loginAttempts.size > 2000) for (const [address, entry] of loginAttempts) if (entry.expires <= now) loginAttempts.delete(address);
  next();
}
function audit(req, action, entityType, entityId = null, details = {}) {
  store.recordAudit({ actorId: req.session.user?.id || null, action, entityType, entityId, details, requestId: req.get('x-request-id') || null });
}
function requireCsrf(req, res, next) {
  const supplied = Buffer.from(String(req.body?.csrfToken || ''));
  const expected = Buffer.from(String(req.session.csrfToken || ''));
  if (supplied.length && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return next();
  return res.status(403).send('Your session expired. Return to the page and try again.');
}
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
  return n;
}
function positiveId(value, label = 'record') { return integer(value, `Choose a valid ${label}`, 1); }
function notFound(res) { return res.status(404).render('pages/error', { ...shared({ session: {} }, res, 'error'), title: 'Page not found · SPL', status: 404, message: 'The SPL record you requested could not be found.' }); }

// Parse multipart forms once, with strict memory and file-size limits.
app.use((req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  uploads.any()(req, res, next);
});
app.use((req, res, next) => {
  if (req.method === 'POST' && !['/health'].includes(req.path)) return requireCsrf(req, res, next);
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/robots.txt', (_req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /organiser/\nDisallow: /matches/start/\nDisallow: /owner/\nDisallow: /login/\nSitemap: ${siteOrigin}/sitemap.xml\n`));
app.get('/sitemap.xml', (_req, res) => {
  const urls = [
    '/', '/about/', '/teams/', '/matches/', '/players/', '/players/compare/',
    '/leaderboards/', '/sponsors/', '/register/', '/contact/', '/auction/'
  ];
  for (const team of store.teams()) urls.push(`/teams/${team.id}/`);
  for (const match of store.matchList({ limit: 500 })) if (match.status !== 'live') urls.push(`/matches/${match.id}/`);
  for (const player of store.players('', true)) urls.push(`/players/${player.id}/`);
  const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...new Set(urls)].map(url => `<url><loc>${escape(`${siteOrigin}${url}`)}</loc></url>`).join('')}</urlset>`;
  res.type('application/xml').send(xml);
});
app.get('/service-worker.js', (_req, res) => res.set('Service-Worker-Allowed','/').sendFile(path.join(here,'public','service-worker.js')));
app.get('/leaderboards/export.csv', (req, res, next) => {
  try {
    const season = validSeason(req.query.season);
    const boards = store.leaderboard(season);
    const headers = ['leaderboard','rank','player','team','matches','runs','balls_faced','strike_rate','wickets','bowling_runs','legal_balls','economy','dot_balls','mvp_points'];
    const records = Object.entries(boards).flatMap(([category, rows]) => rows.map((row,index) => [category,index+1,row.profile?.name||row.name,row.team,row.matches_played,row.runs,row.balls_faced,row.strike_rate,row.wickets,row.bowling_runs,row.bowling_balls,row.economy,row.dot_balls,row.mvp]));
    return sendCsv(res, `spl-leaderboards${season?`-season-${season}`:''}.csv`, headers, records);
  } catch (error) { next(error); }
});
app.get('/', routePage('home', 'Sindhi Premier League · SPL', 'home', () => ({ ui: store.sharedData(), matches_count: store.matchCount(), players_count: store.playerCount(), teams_count: store.teamCount(), sponsors: store.sponsors().slice(0, 4), live_matches: store.matchList({ status: 'live', limit: 3 }), auction_preview: store.publicAuction() })));
app.get('/about/', routePage('about', 'Our story · SPL', 'about', () => ({ season_history: store.seasons() })));
app.get('/teams/', (req, res, next) => { try { const season = validSeason(req.query.season); page(res, req, 'teams', 'Teams · SPL', 'teams', { teams: store.teams(season), selectedSeason: season }); } catch (e) { next(e); } });
app.get('/teams/:id/', (req, res) => {
  const team = store.teamById(Number(req.params.id));
  if (!team) return notFound(res);
  page(res, req, 'team-detail', `${team.name} · Teams · SPL`, 'team_detail', { team, players: store.teamPlayers(team.id), history: store.archiveTeamMatches(team.id) });
});
app.get('/matches/start/', requireScorer, (req, res) => page(res, req, 'start-match', 'Start a match · SPL', 'start_match', { tournaments: store.seasons(), teams: store.teams() }));
app.post('/matches/start/', requireScorer, (req, res) => {
  try {
    const tourId = positiveId(req.body.tournament, 'season');
    const a = positiveId(req.body.team_a, 'team'); const b = positiveId(req.body.team_b, 'team');
    if (a === b) throw new Error('Choose two different teams.');
    const tour = store.get('SELECT * FROM league_tournament WHERE id=?', tourId);
    const teamA = store.get('SELECT * FROM league_team WHERE id=? AND tournament_id=?', a, tourId);
    const teamB = store.get('SELECT * FROM league_team WHERE id=? AND tournament_id=?', b, tourId);
    if (!tour || !teamA || !teamB) throw new Error('Choose two teams from the selected season.');
    const matchId = store.transaction(() => {
      const result = store.run(`INSERT INTO league_match (tournament_id,match_number,date,stage,team_a_id,team_b_id,result_text,winner_id,status,cricheroes_url,ground,toss,scorecard_text,score_summaries,best_batters,best_bowlers,full_scorecard) VALUES (?,NULL,date('now'), 'Live Match', ?, ?, '', NULL, 'live', '', ?, '', '', '[]','[]','[]','{}')`, tourId, a, b, tour.venue || 'Ulhasnagar');
      const id = Number(result.lastInsertRowid);
      store.run('INSERT INTO league_innings (match_id,batting_team_id,bowling_team_id,innings_number,total_runs,wickets,legal_balls) VALUES (?,?,?,1,0,0,0)', id, a, b);
      return id;
    });
    flash(req, 'Match started. Team A will bat first.', 'success');
    return res.redirect(`/matches/${matchId}/live/`);
  } catch (e) { flash(req, e.message, 'error'); return res.redirect('/matches/start/'); }
});
app.get('/matches/', (req, res, next) => {
  try {
    const season = validSeason(req.query.season);
    page(res, req, 'matches', 'Match centre · SPL', 'matches', { matches: store.matchList({ season, q: String(req.query.q || '').trim() }), live_matches: store.matchList({ status: 'live', limit: 20 }), selectedSeason: season, search: req.query.q || '' });
  } catch (e) { next(e); }
});
app.get('/matches/:id/live/', (req, res) => {
  const match = store.matchById(req.params.id);
  if (!match) return notFound(res);
  const data = { match, innings_list: match.innings, current_innings: match.innings.at(-1) || null, players: store.deliveryPlayersForMatch(match) };
  if (req.query.fragment === 'score') return res.render('partials/live-score-update', data);
  page(res, req, 'live-match', `${match.team_a.name} vs ${match.team_b.name} · ${match.status === 'live' ? 'Live centre' : 'Match centre'} · SPL`, 'live_match', data);
});
app.post('/matches/:id/live/', requireScorer, (req, res) => {
  try {
    const match = store.matchById(req.params.id);
    if (!match) throw new Error('Match not found.');
    if (match.status !== 'live') throw new Error('This match is not open for scoring.');
    const action = req.body.action;
    if (action === 'ball') {
      const result = recordBall(match.id, req.body, req);
      if (result.duplicate) { flash(req, 'This delivery was already recorded; no duplicate was added.', 'info'); return res.redirect(`/matches/${match.id}/live/`); }
    }
    else if (action === 'undo') {
      const result = undoLastBall(match.id, req);
      flash(req, result ? 'The last delivery was removed and the score was recalculated.' : 'There is no delivery to undo.', result ? 'success' : 'info');
      return res.redirect(`/matches/${match.id}/live/`);
    }
    else if (action === 'end_innings') {
      const next = startSecondInnings(match.id, req);
      flash(req, `Second innings started: ${next.team}.`, 'success');
    } else if (action === 'finish') {
      finishMatch(match.id, req);
      flash(req, 'Match completed and player statistics saved.', 'success');
      return res.redirect(`/matches/${match.id}/`);
    } else throw new Error('Choose a valid scoring action.');
    if (action === 'ball') flash(req, 'Ball added to the live score.', 'success');
  } catch (e) { flash(req, e.message || 'Please check the scoring details.', 'error'); }
  res.redirect(`/matches/${req.params.id}/live/`);
});
app.get('/matches/:id/', (req, res) => {
  const match = store.matchById(req.params.id);
  if (!match) return notFound(res);
  page(res, req, 'match-detail', `${match.team_a.name} vs ${match.team_b.name} · SPL`, 'match_detail', { match, live_innings: match.innings });
});
app.get('/players/', (req, res) => page(res, req, 'players', 'Players · SPL', 'players', { players: store.players(String(req.query.q || '').trim()), search: req.query.q || '' }));
app.get('/players/compare/', (req, res, next) => {
  try {
    const season = validSeason(req.query.season);
    const firstId = Number(req.query.a) || null; const secondId = Number(req.query.b) || null;
    const comparison = firstId && secondId && firstId !== secondId ? store.playerComparison(firstId, secondId, season) : null;
    page(res, req, 'player-compare', 'Compare SPL players · SPL', 'player_compare', { players: store.players('', true), comparison, selectedA: firstId, selectedB: secondId, selectedSeason: season });
  } catch (error) { next(error); }
});
app.get('/players/:id/', (req, res) => {
  const player = store.playerById(Number(req.params.id));
  if (!player) return notFound(res);
  const selectedSeason = validSeason(req.query.season);
  const analytics = store.playerAnalytics(player.id, selectedSeason);
  page(res, req, 'player-detail', `${player.name} · SPL player profile`, 'player_detail', { player, analytics, stats: analytics.rows, selectedSeason });
});
app.get('/leaderboards/', (req, res, next) => {
  try { const season = validSeason(req.query.season); page(res, req, 'leaderboards', 'Statistics & leaderboards · SPL', 'leaderboards', { stats: store.leaderboard(season), selectedSeason: season }); }
  catch (e) { next(e); }
});
app.get('/auction/export.csv', (req, res) => {
  const id = req.query.auction ? positiveId(req.query.auction, 'auction') : null;
  const data = store.auctionResults(id);
  if (!data) return res.status(404).type('text/plain').send('No auction results are available.');
  const records = data.lots.map(lot => [data.auction.name,data.auction.season,lot.position,lot.player_name,lot.category_name,lot.base_price,lot.status,lot.team_name,lot.sold_price]);
  return sendCsv(res, `spl-auction-season-${data.auction.season}-results.csv`, ['auction','season','queue_position','player','category','base_price','status','team','sold_price'], records);
});
app.get('/sponsors/', routePage('sponsors', 'Our partners · SPL', 'sponsors', () => ({ sponsors: store.sponsors() })));
app.get('/register/', (req, res) => {
  if (process.env.GOOGLE_FORM_URL) return res.redirect(process.env.GOOGLE_FORM_URL);
  page(res, req, 'registration', 'Join the league · SPL', 'registration', { ui: { tournament: store.currentTournament() } });
});
app.get('/contact/', routePage('contact', 'Contact SPL · SPL', 'contact', () => ({ formErrors: {}, formValues: {} })));
app.post('/contact/', (req, res) => {
  const values = { name: String(req.body.name || '').trim(), email: String(req.body.email || '').trim(), phone: String(req.body.phone || '').trim(), subject: String(req.body.subject || '').trim(), message: String(req.body.message || '').trim() };
  const errors = {};
  if (!values.name || values.name.length > 120) errors.name = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || values.email.length > 254) errors.email = 'Enter a valid email address.';
  if (values.phone.length > 30) errors.phone = 'Enter a shorter phone number.';
  if (values.subject.length > 160) errors.subject = 'Keep the subject under 160 characters.';
  if (!values.message || values.message.length > 10000) errors.message = 'Enter a message.';
  if (Object.keys(errors).length) return page(res, req, 'contact', 'Contact SPL · SPL', 'contact', { formErrors: errors, formValues: values });
  store.run('INSERT INTO league_contactenquiry (name,email,phone,subject,message,created_at,is_resolved) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,0)', values.name, values.email, values.phone, values.subject, values.message);
  flash(req, 'Your enquiry has been submitted.', 'success');
  res.redirect('/contact/');
});
app.get('/auction/', (req, res) => {
  const data = store.publicAuction();
  if (req.query.fragment === 'live') return res.render('partials/auction-live', { ...data, user: { is_staff: Boolean(req.session.user?.is_staff) } });
  page(res, req, 'auction', 'SPL Auction Room', 'auction', data);
});
app.get('/owner/', requireExplicitRole('team_owner'), (req, res) => {
  const teams = store.teamOwnerTeams(req.session.user.id);
  if (!teams.length) return res.status(403).render('pages/error', { ...shared(req, res, 'error'), title: 'Team owner access · SPL', status: 403, message: 'This account does not have a team assignment yet. Ask an organiser to connect it to a team.' });
  const auctions = store.ownerAuctions(req.session.user.id);
  const requested = Number(req.query.auction || auctions[0]?.id || 0);
  const selectedAuction = auctions.find(item => item.id === requested) || null;
  const data = selectedAuction ? store.publicAuction(selectedAuction.id) : { auction: null, current_lot: null, team_purses: [], upcoming_lots: [], previous_lots: [], recent_bids: [] };
  const allowedTeamIds = new Set(teams.filter(team => !selectedAuction || Number(team.tournament_id) === Number(selectedAuction.tournament_id)).map(team => Number(team.id)));
  data.team_purses = (data.team_purses || []).filter(purse => allowedTeamIds.has(Number(purse.team.id)));
  return page(res, req, 'owner-dashboard', 'Team owner room · SPL', 'owner', { teams: teams.filter(team => allowedTeamIds.has(Number(team.id))), auctions, selectedAuction, ...data });
});
app.post('/owner/bid/', requireExplicitRole('team_owner'), (req, res) => {
  const requestedAuction = positiveId(req.body.auction_id, 'auction');
  try {
    const teams = store.teamOwnerTeams(req.session.user.id);
    const teamId = positiveId(req.body.team_id, 'team');
    if (!teams.some(team => Number(team.id) === teamId)) throw new Error('You can only place bids for a team assigned to your account.');
    if (!store.ownerAuctions(req.session.user.id).some(item => Number(item.id) === requestedAuction)) throw new Error('That auction is not available to your assigned team.');
    const result = store.placeAuctionBid({ auctionId: requestedAuction, lotId: req.body.lot_id, teamId, amount: req.body.amount, userId: req.session.user.id, requestKey: req.body.idempotencyKey });
    flash(req, result.duplicate ? 'This bid was already recorded; no duplicate bid was added.' : 'Your bid has been recorded.', result.duplicate ? 'info' : 'success');
  } catch (error) { flash(req, error.message || 'Your bid could not be recorded.', 'error'); }
  return res.redirect(`/owner/?auction=${requestedAuction}`);
});

app.get('/login/', (req, res) => page(res, req, 'login', 'SPL sign-in', 'login', { error: null }));
app.post('/login/', loginRateLimit, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || username.length > 150 || !password || password.length > 1024) {
    return page(res, req, 'login', 'SPL sign-in', 'login', { error: 'The username or password was not recognised.' });
  }
  const user = store.get('SELECT id,username,password,is_active FROM auth_user WHERE LOWER(username)=LOWER(?) AND is_active=1', username);
  if (!user || !verifyDjangoPassword(password, user.password)) {
    return page(res, req, 'login', 'SPL sign-in', 'login', { error: 'The username or password was not recognised.' });
  }
  req.session.regenerate(error => {
    if (error) return res.status(500).send('Could not create a secure session.');
    req.session.user = { id: user.id, username: user.username };
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    loginAttempts.delete(req.ip || req.socket.remoteAddress || 'unknown');
    store.recordAudit({ actorId: user.id, action: 'sign_in', entityType: 'account', entityId: user.id });
    const roles = store.rolesForUser(user.id);
    const destination = roles.includes('team_owner') && !roles.includes('super_admin') ? '/owner/'
      : roles.includes('super_admin') || roles.includes('organiser') ? '/organiser/'
        : roles.includes('auctioneer') ? '/organiser/auction/' : roles.includes('scorer') ? '/matches/start/' : '/';
    res.redirect(destination);
  });
});
app.post('/logout/', requireAuthenticated, (req, res) => { audit(req, 'sign_out', 'account', req.session.user?.id); req.session.destroy(() => res.redirect('/')); });
app.get('/django-admin/', requireLeagueAdmin, (_req, res) => res.redirect('/organiser/manage/'));
app.get('/organiser/', requireLeagueAdmin, (req, res) => page(res, req, 'organiser', 'Organiser desk · SPL', 'organiser', store.adminCounts()));
app.post('/organiser/', requireLeagueAdmin, (req, res) => {
  try {
    const file = (req.files || []).find(f => f.fieldname === 'csv_file');
    if (!file) throw new Error('Choose a delivery CSV file.');
    const count = importDeliveries(file.buffer.toString('utf8'));
    audit(req, 'delivery_csv_import', 'match_deliveries', null, { rows: count });
    flash(req, `Imported ${count} ball-by-ball rows.`, 'success');
  } catch (e) { flash(req, e.message, 'error'); }
  res.redirect('/organiser/');
});
app.get('/organiser/auction/', requireAuctioneer, (req, res) => {
  const data = store.organizerAuctionData();
  const selectedId = Number(req.query.auction || data.auctions[0]?.id || 0);
  const selectedAuction = selectedId ? data.auctions.find(a => a.id === selectedId) || null : null;
  const publicData = selectedAuction ? store.publicAuction(selectedId) : { auction: null, current_lot: null, team_purses: [], upcoming_lots: [], previous_lots: [] };
  page(res, req, 'organiser-auction', 'Auction controls · SPL', 'auction_config', { ...data, selectedAuction, ...publicData });
});
app.post('/organiser/auction/', requireAuctioneer, (req, res) => handleAuctionAction(req, res));
app.get('/organiser/manage/', requireManageAccess, (req, res, next) => {
  try {
    const data = adminWorkspace(req);
    page(res, req, 'admin-manage', 'League records · SPL organiser', 'admin_manage', data);
  } catch (e) { next(e); }
});
app.post('/organiser/manage/', requireManageMutation, (req, res) => {
  try {
    const message = req.body.entity === 'access' ? saveAccessAction(req) : saveAdminRecord(req.body);
    if (req.body.entity !== 'access') audit(req, `${String(req.body.entity || 'record')}_save`, 'league_record', req.body.id || null, { recordType: String(req.body.entity || '') });
    flash(req, message, 'success');
  } catch (e) {
    flash(req, e.message || 'That record could not be saved.', 'error');
  }
  const section = ['seasons','teams','players','matches','sponsors','enquiries','access'].includes(req.body.entity) ? req.body.entity : 'seasons';
  res.redirect(`/organiser/manage/?section=${section}`);
});

app.use((req, res) => notFound(res));
app.use((error, req, res, _next) => {
  if (error?.code === 'LIMIT_FILE_SIZE') return res.status(413).send('Files must be smaller than 8 MB.');
  console.error(`[SPL] ${req.method} ${req.path}: ${error.message}`);
  const status = error.message.includes('season number') ? 400 : 500;
  if (res.headersSent) return;
  res.status(status).render('pages/error', { ...shared(req, res, 'error'), title: status === 404 ? 'Page not found · SPL' : 'Something went wrong · SPL', status, message: status === 400 ? error.message : 'We could not load this SPL page right now.' });
});

function adminWorkspace(req) {
  const sections = ['seasons','teams','players','matches','sponsors','enquiries','access'];
  const section = sections.includes(String(req.query.section || '')) ? String(req.query.section) : 'seasons';
  const search = String(req.query.q || '').trim().slice(0, 100);
  const requestedPage = Number.parseInt(req.query.page || '1', 10);
  const pageNumber = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const tournaments = store.all('SELECT * FROM league_tournament ORDER BY season DESC');
  const teams = store.all(`SELECT t.*,tour.season FROM league_team t JOIN league_tournament tour ON tour.id=t.tournament_id ORDER BY tour.season DESC,t.name`);
  const categories = store.all('SELECT * FROM league_playercategory ORDER BY position,name');
  let records = [];
  if (section === 'seasons') records = tournaments;
  if (section === 'teams') records = search ? teams.filter(x => x.name.toLowerCase().includes(search.toLowerCase()) || String(x.season).includes(search)) : teams;
  if (section === 'players') {
    records = store.all(`SELECT p.*,GROUP_CONCAT(pt.team_id) team_ids FROM league_player p LEFT JOIN league_player_teams pt ON pt.player_id=p.id GROUP BY p.id ORDER BY p.name`);
    if (search) records = records.filter(x => `${x.name} ${x.city || ''}`.toLowerCase().includes(search.toLowerCase()));
  }
  if (section === 'matches') {
    records = store.matchList({ limit: 500 });
    if (search) records = records.filter(x => `${x.team_a.name} ${x.team_b.name} ${x.stage || ''} ${x.tournament.season}`.toLowerCase().includes(search.toLowerCase()));
  }
  if (section === 'sponsors') {
    records = store.sponsors();
    if (search) records = records.filter(x => x.name.toLowerCase().includes(search.toLowerCase()));
  }
  if (section === 'enquiries') records = store.all(`SELECT * FROM league_contactenquiry ${search ? 'WHERE LOWER(name) LIKE LOWER(?) OR LOWER(email) LIKE LOWER(?) OR LOWER(subject) LIKE LOWER(?)' : ''} ORDER BY created_at DESC`, ...(search ? [`%${search}%`,`%${search}%`,`%${search}%`] : []));
  if (section === 'access') records = store.accessUsers().filter(user => !search || `${user.username} ${user.email||''} ${user.role_keys||''}`.toLowerCase().includes(search.toLowerCase()));
  const perPage = section === 'players' ? 40 : 100;
  const pageCount = Math.max(1, Math.ceil(records.length / perPage));
  const safePage = Math.min(pageNumber, pageCount);
  return { section, search, pageNumber: safePage, pageCount, records: records.slice((safePage - 1) * perPage, safePage * perPage), tournaments, teams, categories, total: records.length,
    accessRoles: section === 'access' ? store.all('SELECT role_key,display_name FROM spl_role WHERE is_assignable=1 ORDER BY id') : [],
    accessAssignments: section === 'access' ? store.accessAssignments() : [],
    teamOwnerAssignments: section === 'access' ? store.teamOwnerAssignments() : [] };
}

function saveAdminRecord(body) {
  const entity = String(body.entity || '');
  const id = body.id ? positiveId(body.id, 'record') : null;
  const shortText = (value, label, max) => {
    const text = String(value || '').trim();
    if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
    return text;
  };
  const optionalDate = (value, label) => {
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== text) throw new Error(`${label} must be a valid date.`);
    return text;
  };
  const booleanValue = value => ['true','on','1','yes'].includes(String(value || '').toLowerCase()) ? 1 : 0;
  const urlValue = (value, label, max = 500) => {
    const text = shortText(value, label, max);
    if (!text) return '';
    try { const url = new URL(text); if (!['http:','https:'].includes(url.protocol)) throw new Error(); }
    catch { throw new Error(`${label} must be a valid HTTP or HTTPS address.`); }
    return text;
  };
  if (entity === 'enquiries') {
    const enquiryId = positiveId(body.id, 'enquiry');
    if (!store.get('SELECT id FROM league_contactenquiry WHERE id=?', enquiryId)) throw new Error('Choose an enquiry that still exists.');
    store.run('UPDATE league_contactenquiry SET is_resolved=? WHERE id=?', booleanValue(body.is_resolved), enquiryId);
    return 'Enquiry status saved.';
  }
  if (entity === 'seasons') {
    const name = shortText(body.name, 'Season name', 150) || 'Sindhi Premier League';
    const season = integer(body.season, 'Season number', 1, 2147483647);
    const duplicate = store.get('SELECT id FROM league_tournament WHERE season=? AND id<>COALESCE(?,0)', season, id || 0);
    if (duplicate) throw new Error(`Season ${season} already exists.`);
    const start = optionalDate(body.start_date, 'Start date'); const end = optionalDate(body.end_date, 'End date');
    if (start && end && end < start) throw new Error('The season end date must be after its start date.');
    const current = booleanValue(body.is_current);
    store.transaction(() => {
      if (current) store.run('UPDATE league_tournament SET is_current=0');
      if (id) {
        if (!store.get('SELECT id FROM league_tournament WHERE id=?', id)) throw new Error('Choose a season that still exists.');
        store.run('UPDATE league_tournament SET name=?,season=?,start_date=?,end_date=?,venue=?,description=?,is_current=? WHERE id=?', name, season, start, end, shortText(body.venue,'Venue',180), shortText(body.description,'Description',2000), current, id);
      } else store.run('INSERT INTO league_tournament (name,season,start_date,end_date,venue,description,is_current) VALUES (?,?,?,?,?,?,?)', name, season, start, end, shortText(body.venue,'Venue',180), shortText(body.description,'Description',2000), current);
    });
    return 'Season details saved.';
  }
  if (entity === 'teams') {
    const tournamentId = positiveId(body.tournament_id, 'season');
    if (!store.get('SELECT id FROM league_tournament WHERE id=?', tournamentId)) throw new Error('Choose a season that still exists.');
    const name = shortText(body.name,'Team name',120); if (!name) throw new Error('Enter a team name.');
    const shortName = shortText(body.short_name,'Short name',20);
    const logo = shortText(body.logo,'Logo path',255);
    const colour = String(body.primary_colour || '#D9A441').trim();
    if (!/^#[0-9a-f]{6}$/i.test(colour)) throw new Error('Team colour must be a six-digit hex colour.');
    const duplicate = store.get('SELECT id FROM league_team WHERE tournament_id=? AND name=? AND id<>COALESCE(?,0)', tournamentId, name, id || 0);
    if (duplicate) throw new Error(`${name} is already listed in that season.`);
    if (id) store.run('UPDATE league_team SET tournament_id=?,name=?,short_name=?,logo=?,primary_colour=? WHERE id=?', tournamentId,name,shortName,logo,colour,id);
    else store.run('INSERT INTO league_team (tournament_id,name,short_name,logo,primary_colour) VALUES (?,?,?,?,?)', tournamentId,name,shortName,logo,colour);
    return 'Team details saved.';
  }
  if (entity === 'players') {
    const name = shortText(body.name,'Player name',120); if (!name) throw new Error('Enter a player name.');
    const city = shortText(body.city,'City',100); const photo = shortText(body.photo,'Photo path',255);
    const teamIds = [...new Set((Array.isArray(body.teams) ? body.teams : [body.teams]).filter(Boolean).map(x => positiveId(x,'team')))];
    const validTeams = teamIds.length ? store.all(`SELECT id FROM league_team WHERE id IN (${teamIds.map(()=>'?').join(',')})`, ...teamIds) : [];
    if (validTeams.length !== teamIds.length) throw new Error('Choose teams that still exist.');
    const isActive = booleanValue(body.is_active);
    store.transaction(() => {
      let playerId = id;
      if (id) {
        if (!store.get('SELECT id FROM league_player WHERE id=?', id)) throw new Error('Choose a player that still exists.');
        store.run('UPDATE league_player SET name=?,city=?,photo=?,is_active=? WHERE id=?', name,city,photo,isActive,id);
        store.run('DELETE FROM league_player_teams WHERE player_id=?', id);
      } else {
        const created = store.run('INSERT INTO league_player (name,city,photo,is_active) VALUES (?,?,?,?)', name,city,photo,isActive);
        playerId = Number(created.lastInsertRowid);
      }
      for (const teamId of teamIds) store.run('INSERT OR IGNORE INTO league_player_teams (player_id,team_id) VALUES (?,?)', playerId,teamId);
    });
    return 'Player details and team assignments saved.';
  }
  if (entity === 'matches') {
    const tournamentId = positiveId(body.tournament_id, 'season');
    const a = positiveId(body.team_a_id,'Team A'); const b = positiveId(body.team_b_id,'Team B');
    if (a === b) throw new Error('Choose two different teams.');
    const tour = store.get('SELECT id FROM league_tournament WHERE id=?', tournamentId);
    const teamA = store.get('SELECT id FROM league_team WHERE id=? AND tournament_id=?', a,tournamentId);
    const teamB = store.get('SELECT id FROM league_team WHERE id=? AND tournament_id=?', b,tournamentId);
    if (!tour || !teamA || !teamB) throw new Error('Choose two teams from the selected season.');
    const stage = shortText(body.stage,'Match stage',80); const dateValue = optionalDate(body.date,'Match date');
    const ground = shortText(body.ground,'Ground',180); const toss = shortText(body.toss,'Toss',255);
    const cricheroes = urlValue(body.cricheroes_url,'CricHeroes link');
    const requestedStatus = String(body.status || 'scheduled');
    if (!['scheduled','completed','abandoned','live'].includes(requestedStatus)) throw new Error('Choose a valid match status.');
    const winner = body.winner_id ? positiveId(body.winner_id,'winner') : null;
    if (winner && ![a,b].includes(winner)) throw new Error('The winner must be one of the two teams.');
    const result = shortText(body.result_text,'Result',255);
    if (id) {
      const old = store.get('SELECT status FROM league_match WHERE id=?', id); if (!old) throw new Error('Choose a match that still exists.');
      if (old.status === 'live' && requestedStatus !== 'live') throw new Error('Finish a live match from its scoring page.');
      store.run('UPDATE league_match SET tournament_id=?,date=?,stage=?,team_a_id=?,team_b_id=?,ground=?,toss=?,cricheroes_url=?,status=?,winner_id=?,result_text=? WHERE id=?', tournamentId,dateValue,stage,a,b,ground,toss,cricheroes,requestedStatus,winner,result,id);
    } else {
      if (requestedStatus !== 'scheduled') throw new Error('New matches start as scheduled; use Start a match to begin live scoring.');
      store.run('INSERT INTO league_match (tournament_id,date,stage,team_a_id,team_b_id,ground,toss,cricheroes_url,status,winner_id,result_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)', tournamentId,dateValue,stage,a,b,ground,toss,cricheroes,requestedStatus,winner,result);
    }
    return id ? 'Match details saved.' : 'Fixture added.';
  }
  if (entity === 'sponsors') {
    const name = shortText(body.name,'Sponsor name',150); if (!name) throw new Error('Enter a sponsor name.');
    const category = String(body.category || ''); if (!['title','associate'].includes(category)) throw new Error('Choose a sponsor category.');
    const logo = shortText(body.logo,'Logo path',255); const website = urlValue(body.website,'Website');
    if (id) {
      if (!store.get('SELECT id FROM league_sponsor WHERE id=?',id)) throw new Error('Choose a sponsor that still exists.');
      store.run('UPDATE league_sponsor SET name=?,category=?,logo=?,website=? WHERE id=?',name,category,logo,website,id);
    } else store.run('INSERT INTO league_sponsor (name,category,logo,website) VALUES (?,?,?,?)',name,category,logo,website);
    return 'Sponsor details saved.';
  }
  throw new Error('Choose a valid record type.');
}

function saveAccessAction(req) {
  const action = String(req.body.access_action || '');
  const roleKey = String(req.body.role_key || '');
  const allowedRoles = ['super_admin','organiser','auctioneer','team_owner','scorer','player'];
  if (!allowedRoles.includes(roleKey)) throw new Error('Choose a valid access role.');
  const teamId = roleKey === 'team_owner' ? positiveId(req.body.team_id, 'team') : null;
  if (action === 'account_create') {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) throw new Error('Use 3–32 letters, numbers, dots, underscores, or hyphens for the username.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
    if (password.length < 12 || password.length > 1024) throw new Error('Set a password with at least 12 characters.');
    if (store.get('SELECT id FROM auth_user WHERE LOWER(username)=LOWER(?)', username)) throw new Error('That username is already in use.');
    const salt = crypto.randomBytes(24).toString('hex');
    const iterations = 390000;
    const digest = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64').replace(/=+$/, '');
    const encoded = `pbkdf2_sha256$${iterations}$${salt}$${digest}`;
    const role = store.get('SELECT id FROM spl_role WHERE role_key=? AND is_assignable=1', roleKey);
    if (!role) throw new Error('Choose an available role.');
    if (roleKey === 'team_owner' && !store.get('SELECT id FROM league_team WHERE id=?', teamId)) throw new Error('Choose a valid team for the owner assignment.');
    const accountId = store.transaction(() => {
      const created = store.run(`INSERT INTO auth_user(password,last_login,is_superuser,username,last_name,email,is_staff,is_active,date_joined,first_name)
        VALUES(?,NULL,0,?,'',?,0,1,CURRENT_TIMESTAMP,'')`, encoded, username, email);
      const id = Number(created.lastInsertRowid);
      store.run('INSERT INTO spl_user_role(user_id,role_id,granted_by_id) VALUES(?,?,?)', id, role.id, req.session.user.id);
      if (roleKey === 'team_owner') store.run('INSERT INTO spl_team_owner(user_id,team_id) VALUES(?,?)', id, teamId);
      store.recordAudit({ actorId: req.session.user.id, action: 'account_create', entityType: 'account', entityId: id, details: { role: roleKey, teamId } });
      return id;
    });
    return `Account ${username} created with ${roleKey.replaceAll('_',' ')} access.`;
  }
  const userId = positiveId(req.body.user_id, 'account');
  if (action === 'grant') {
    store.assignRole(userId, roleKey, req.session.user.id, teamId);
    audit(req, 'access_role_grant', roleKey === 'team_owner' ? 'team_owner' : 'user_role', userId, { role: roleKey, teamId });
    return roleKey === 'team_owner' ? 'Team owner access assigned.' : 'Role assigned.';
  }
  if (action === 'revoke') {
    if (roleKey === 'super_admin') {
      const target = store.get('SELECT is_superuser FROM auth_user WHERE id=? AND is_active=1', userId);
      const adminCount = store.accessUsers().filter(user => user.is_superuser || String(user.role_keys || '').split(',').includes('super_admin')).length;
      if (!target) throw new Error('Choose an active account.');
      if (!target.is_superuser && adminCount <= 1) throw new Error('The final Super Admin role cannot be removed. Assign another Super Admin first.');
    }
    store.removeRole(userId, roleKey, teamId);
    audit(req, 'access_role_revoke', roleKey === 'team_owner' ? 'team_owner' : 'user_role', userId, { role: roleKey, teamId });
    return roleKey === 'team_owner' ? 'Team owner assignment removed.' : 'Role removed.';
  }
  throw new Error('Choose whether to assign or remove access.');
}

function verifyDjangoPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  try {
    const hash = crypto.pbkdf2Sync(password, parts[2], Number(parts[1]), 32, 'sha256').toString('base64').replace(/=+$/, '');
    const expected = parts[3].replace(/=+$/, '');
    return hash.length === expected.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
  } catch { return false; }
}
function recordBall(matchId, body, req) {
  return store.transaction(() => {
    const requestKey = String(body.idempotencyKey || '');
    if (!/^[a-f0-9]{32}$/i.test(requestKey)) throw new Error('Refresh the scoring page before recording a delivery.');
    if (store.get('SELECT 1 FROM spl_idempotency_key WHERE user_id=? AND request_key=?', req.session.user.id, requestKey)) return { duplicate: true };
    const match = store.get('SELECT * FROM league_match WHERE id=? AND status=\'live\'', matchId);
    if (!match) throw new Error('This match is not open for scoring.');
    const innings = store.get('SELECT * FROM league_innings WHERE match_id=? ORDER BY innings_number DESC LIMIT 1', match.id);
    if (!innings) throw new Error('Start the match before recording a ball.');
    const batter = positiveId(body.batter, 'batter'); const bowler = positiveId(body.bowler, 'bowler');
    const runs = integer(body.batter_runs || 0, 'Runs off the bat', 0, 6); const extraRuns = integer(body.extra_runs || 0, 'Extra runs', 0, 6);
    const extra = body.extra_type || 'none';
    if (!['none','wide','no_ball','bye','leg_bye','penalty'].includes(extra)) throw new Error('Choose a valid extra type.');
    if (extra === 'wide' && runs > 0) throw new Error('Runs off the bat cannot be recorded on a wide.');
    if (!store.get('SELECT 1 FROM league_player_teams WHERE player_id=? AND team_id=?', batter, innings.batting_team_id)) throw new Error('Select a batter from the batting team.');
    if (!store.get('SELECT 1 FROM league_player_teams WHERE player_id=? AND team_id=?', bowler, innings.bowling_team_id)) throw new Error('Select a bowler from the bowling team.');
    const dismissal = String(body.dismissal_type || '');
    const dismissed = dismissal ? positiveId(body.dismissed_player, 'dismissed player') : null;
    const fielder = body.fielder ? positiveId(body.fielder, 'fielder') : null;
    if (dismissal && !['bowled','caught','lbw','run_out','stumped','hit_wicket','caught_and_bowled','other'].includes(dismissal)) throw new Error('Choose a valid dismissal.');
    if (dismissed && !store.get('SELECT 1 FROM league_player_teams WHERE player_id=? AND team_id=?', dismissed, innings.batting_team_id)) throw new Error('Select a dismissed player from the batting team.');
    if (fielder && !store.get('SELECT 1 FROM league_player_teams WHERE player_id=? AND team_id=?', fielder, innings.bowling_team_id)) throw new Error('Select a fielder from the bowling team.');
    if (dismissal && !dismissed) throw new Error('Choose the player who was dismissed.');
    if (['caught','run_out','stumped'].includes(dismissal) && !fielder) throw new Error('Choose a fielder for a catch, run-out, or stumping.');
    const last = store.get('SELECT over_number,ball_number FROM league_delivery WHERE innings_id=? ORDER BY id DESC LIMIT 1', innings.id);
    const legal = !['wide','no_ball'].includes(extra);
    const legalBalls = Number(innings.legal_balls);
    const overNo = legalBalls ? Math.floor(legalBalls / 6) + 1 : 1;
    const ballNo = legalBalls % 6 + 1;
    const at = last && !legal ? { over: last.over_number, ball: last.ball_number } : { over: overNo, ball: ballNo };
    const inserted = store.run(`INSERT INTO league_delivery (innings_id,over_number,ball_number,batter_id,bowler_id,batter_runs,extra_runs,extra_type,dismissal_type,dismissed_player_id,fielder_id,is_legal)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, innings.id, at.over, at.ball, batter, bowler, runs, extraRuns, extra, dismissal, dismissed, fielder, legal ? 1 : 0);
    store.run(`UPDATE league_innings SET total_runs=total_runs+?+?, wickets=wickets+?,legal_balls=legal_balls+? WHERE id=?`, runs, extraRuns, dismissal ? 1 : 0, legal ? 1 : 0, innings.id);
    store.run('INSERT INTO spl_idempotency_key(user_id,request_key,action,response_json) VALUES(?,?,?,?)', req.session.user.id, requestKey, 'delivery_record', JSON.stringify({ matchId: match.id, deliveryId: Number(inserted.lastInsertRowid) }));
    audit(req, 'delivery_record', 'match', match.id, { deliveryId: Number(inserted.lastInsertRowid), extraType: extra, hasDismissal: Boolean(dismissal) });
    return { duplicate: false, deliveryId: Number(inserted.lastInsertRowid) };
  });
}
function undoLastBall(matchId, req) {
  return store.transaction(() => {
    const match = store.get('SELECT * FROM league_match WHERE id=? AND status=\'live\'', matchId);
    if (!match) throw new Error('This match is not open for scoring.');
    const innings = store.get('SELECT * FROM league_innings WHERE match_id=? ORDER BY innings_number DESC LIMIT 1', match.id);
    if (!innings) throw new Error('Start the match before undoing a delivery.');
    const delivery = store.get('SELECT * FROM league_delivery WHERE innings_id=? ORDER BY id DESC LIMIT 1', innings.id);
    if (!delivery) return false;
    store.run('DELETE FROM league_delivery WHERE id=?', delivery.id);
    const totals = store.get(`SELECT COALESCE(SUM(batter_runs+extra_runs),0) runs,
      COALESCE(SUM(CASE WHEN dismissal_type<>'' THEN 1 ELSE 0 END),0) wickets,
      COALESCE(SUM(is_legal),0) legal_balls FROM league_delivery WHERE innings_id=?`, innings.id);
    store.run('UPDATE league_innings SET total_runs=?,wickets=?,legal_balls=? WHERE id=?', totals.runs, totals.wickets, totals.legal_balls, innings.id);
    audit(req, 'delivery_undo', 'match', match.id, { deliveryId: delivery.id, batterRuns: delivery.batter_runs, extraRuns: delivery.extra_runs, extraType: delivery.extra_type, dismissalType: delivery.dismissal_type });
    return true;
  });
}
function startSecondInnings(matchId, req) {
  return store.transaction(() => {
    const match = store.get('SELECT * FROM league_match WHERE id=? AND status=\'live\'', matchId);
    if (!match) throw new Error('This match is not open for scoring.');
    const previous = store.get('SELECT * FROM league_innings WHERE match_id=? ORDER BY innings_number DESC LIMIT 1', match.id);
    if (!previous) throw new Error('Start the match before ending an innings.');
    if (Number(previous.innings_number) >= 2) throw new Error('Both innings have already started. Finish the match to close scoring.');
    store.run('INSERT INTO league_innings (match_id,batting_team_id,bowling_team_id,innings_number,total_runs,wickets,legal_balls) VALUES (?,?,?,2,0,0,0)', match.id, previous.bowling_team_id, previous.batting_team_id);
    const team = store.get('SELECT name FROM league_team WHERE id=?', previous.bowling_team_id)?.name || 'the second team';
    audit(req, 'innings_start', 'match', match.id, { inningsNumber: 2 });
    return { team };
  });
}
function finishMatch(matchId, req) {
  store.transaction(() => {
    const match = store.get('SELECT * FROM league_match WHERE id=? AND status=\'live\'', matchId);
    if (!match) throw new Error('This match is not open for scoring.');
    const inns = store.all('SELECT * FROM league_innings WHERE match_id=? ORDER BY innings_number', match.id);
    if (!inns.length) throw new Error('Start the match before finishing it.');
    saveMatchFromDeliveries(match.id);
    audit(req, 'match_finish', 'match', match.id, { innings: inns.length });
  });
}
function emptyPlayerTotals(player_id, team_id) { return { player_id, team_id, runs: 0, balls_faced: 0, fours: 0, sixes: 0, bowling_balls: 0, bowling_runs: 0, wickets: 0, dot_balls: 0, bowling_maidens: 0, dismissed: false }; }
function saveMatchFromDeliveries(matchId) {
  const match = store.get('SELECT * FROM league_match WHERE id=?', matchId);
  if (!match) throw new Error('Match not found.');
  const teamA = store.get('SELECT * FROM league_team WHERE id=?', match.team_a_id);
  const teamB = store.get('SELECT * FROM league_team WHERE id=?', match.team_b_id);
  const innings = store.all(`SELECT i.*,t.name batting_name FROM league_innings i JOIN league_team t ON t.id=i.batting_team_id WHERE i.match_id=? ORDER BY i.innings_number`, matchId);
  if (!innings.length) throw new Error('Start the match before finishing it.');
  const totals = new Map();
  const maidenOvers = new Map();
  for (const inning of innings) {
    const deliveries = store.all('SELECT * FROM league_delivery WHERE innings_id=? ORDER BY over_number,ball_number,id', inning.id);
    let runs = 0, wickets = 0, legalBalls = 0;
    for (const delivery of deliveries) {
      const batter = totals.get(delivery.batter_id) || emptyPlayerTotals(delivery.batter_id, inning.batting_team_id);
      batter.runs += delivery.batter_runs;
      batter.balls_faced += delivery.extra_type === 'wide' ? 0 : 1;
      batter.fours += delivery.batter_runs === 4 ? 1 : 0;
      batter.sixes += delivery.batter_runs === 6 ? 1 : 0;
      totals.set(delivery.batter_id, batter);

      if (delivery.dismissal_type) {
        wickets++;
        const outId = delivery.dismissed_player_id || delivery.batter_id;
        const dismissed = totals.get(outId) || emptyPlayerTotals(outId, inning.batting_team_id);
        dismissed.dismissed = true;
        totals.set(outId, dismissed);
      }

      const bowler = totals.get(delivery.bowler_id) || emptyPlayerTotals(delivery.bowler_id, inning.bowling_team_id);
      const legal = Boolean(delivery.is_legal);
      const concededExtras = ['bye','leg_bye','penalty'].includes(delivery.extra_type) ? 0 : delivery.extra_runs;
      bowler.bowling_balls += legal ? 1 : 0;
      bowler.bowling_runs += delivery.batter_runs + concededExtras;
      bowler.wickets += delivery.dismissal_type && !['run_out','other'].includes(delivery.dismissal_type) ? 1 : 0;
      bowler.dot_balls += legal && delivery.batter_runs + delivery.extra_runs === 0 ? 1 : 0;
      totals.set(delivery.bowler_id, bowler);

      if (delivery.fielder_id) {
        const fielder = totals.get(delivery.fielder_id) || emptyPlayerTotals(delivery.fielder_id, inning.bowling_team_id);
        totals.set(delivery.fielder_id, fielder);
      }
      runs += delivery.batter_runs + delivery.extra_runs;
      legalBalls += legal ? 1 : 0;
      const overKey = `${inning.id}:${delivery.bowler_id}:${delivery.over_number}`;
      const over = maidenOvers.get(overKey) || { bowler, legalBalls: 0, conceded: 0 };
      over.legalBalls += legal ? 1 : 0;
      over.conceded += delivery.batter_runs + concededExtras;
      maidenOvers.set(overKey, over);
    }
    store.run('UPDATE league_innings SET total_runs=?,wickets=?,legal_balls=? WHERE id=?', runs, wickets, legalBalls, inning.id);
    inning.total_runs = runs; inning.wickets = wickets; inning.legal_balls = legalBalls;
  }
  for (const over of maidenOvers.values()) if (over.legalBalls === 6 && over.conceded === 0) over.bowler.bowling_maidens++;
  for (const player of totals.values()) {
    store.run(`INSERT OR REPLACE INTO league_playermatchstat (match_id,player_id,team_id,runs,balls_faced,fours,sixes,batting_dismissed,bowling_overs,bowling_runs,wickets,dot_balls,bowling_maidens,played_in_squad)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, matchId, player.player_id, player.team_id, player.runs, player.balls_faced, player.fours, player.sixes, player.dismissed ? 1 : 0, `${Math.floor(player.bowling_balls / 6)}.${player.bowling_balls % 6}`, player.bowling_runs, player.wickets, player.dot_balls, player.bowling_maidens);
  }
  const a = innings.reduce((sum, row) => sum + (Number(row.batting_team_id) === Number(match.team_a_id) ? row.total_runs : 0), 0);
  const b = innings.reduce((sum, row) => sum + (Number(row.batting_team_id) === Number(match.team_b_id) ? row.total_runs : 0), 0);
  const winnerId = a === b ? null : a > b ? match.team_a_id : match.team_b_id;
  const winnerName = winnerId === Number(teamA.id) ? teamA.name : winnerId === Number(teamB.id) ? teamB.name : '';
  const summaries = innings.map(row => ({ team: row.batting_name, score: `${row.total_runs}/${row.wickets}`, overs: store.overs(row.legal_balls) }));
  const stats = store.all(`SELECT s.*,p.name FROM league_playermatchstat s JOIN league_player p ON p.id=s.player_id WHERE s.match_id=?`, matchId);
  const bestBatters = stats.filter(row => row.runs || row.balls_faced).sort((x,y) => y.runs-x.runs || y.balls_faced-x.balls_faced).slice(0,3).map(row => ({ name: row.name, runs: row.runs }));
  const bestBowlers = stats.filter(row => row.wickets || row.bowling_balls).sort((x,y) => y.wickets-x.wickets || x.bowling_runs-y.bowling_runs).slice(0,3).map(row => ({ name: row.name, wickets: row.wickets }));
  const result = winnerId ? `${winnerName} won` : 'Match tied';
  store.run(`UPDATE league_match SET status='completed',winner_id=?,result_text=?,score_summaries=?,best_batters=?,best_bowlers=? WHERE id=?`, winnerId, result, JSON.stringify(summaries), JSON.stringify(bestBatters), JSON.stringify(bestBowlers), matchId);
}
function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') { value += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(value); if (row.some(x => x !== '')) rows.push(row); row = []; value = ''; }
    else value += c;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const headers = (rows.shift() || []).map(x => x.trim().replace(/^\uFEFF/, ''));
  return rows.map(values => Object.fromEntries(headers.map((h, i) => [h, (values[i] || '').trim()])));
}
function importDeliveries(text) {
  const rows = parseCsv(text);
  const required = ['season','match_date','stage','team_a','team_b','innings','batting_team','bowling_team','over','ball','batter','bowler','batter_runs','extra_runs','extra_type','dismissal_type'];
  const headers = new Set(Object.keys(rows[0] || {}));
  const missing = required.filter(h => !headers.has(h));
  if (missing.length) throw new Error(`Missing CSV headers: ${missing.join(', ')}`);
  return store.transaction(() => {
    const cache = new Map(); const importedMatches = new Set();
    for (const r of rows) {
      const season = integer(r.season, 'Season', 1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.match_date) || Number.isNaN(new Date(`${r.match_date}T00:00:00Z`).getTime())) throw new Error('Use a match date in YYYY-MM-DD format.');
      let tour = store.get('SELECT * FROM league_tournament WHERE season=?', season);
      if (!tour) { const x = store.run('INSERT INTO league_tournament (name,season,venue,description,is_current) VALUES (?,?,?,?,0)', 'Sindhi Premier League', season, 'Ulhasnagar', ''); tour = store.get('SELECT * FROM league_tournament WHERE id=?', x.lastInsertRowid); }
      const team = name => { const cleaned = String(name || '').trim(); if (!cleaned) throw new Error('Team names in the CSV cannot be blank.'); let t = store.get('SELECT * FROM league_team WHERE tournament_id=? AND name=?', tour.id, cleaned); if (!t) { const x = store.run('INSERT INTO league_team (tournament_id,name,short_name,logo,primary_colour) VALUES (?,?,\'\',\'\',\'#D9A441\')', tour.id, cleaned); t = store.get('SELECT * FROM league_team WHERE id=?', x.lastInsertRowid); } return t; };
      const player = name => { const cleaned = name.trim(); let p = store.get('SELECT * FROM league_player WHERE name=?', cleaned); if (!p) { const x = store.run('INSERT INTO league_player (name,city,photo,auction_category_id,auction_base_price,is_marquee,in_auction_pool,is_active) VALUES (?,?,\'\',NULL,NULL,0,0,1)', cleaned, ''); p = store.get('SELECT * FROM league_player WHERE id=?', x.lastInsertRowid); } return p; };
      const a = team(r.team_a), b = team(r.team_b), bat = team(r.batting_team), bowl = team(r.bowling_team);
      if (a.id === b.id || ![a.id,b.id].includes(bat.id) || ![a.id,b.id].includes(bowl.id) || bat.id === bowl.id) throw new Error('Each CSV innings must use the two match teams, batting against the other team.');
      const key = [season,r.match_date,r.stage,a.id,b.id].join('|');
      let m = cache.get(key) || store.get('SELECT * FROM league_match WHERE tournament_id=? AND date=? AND stage=? AND team_a_id=? AND team_b_id=?', tour.id, r.match_date, r.stage, a.id, b.id);
      if (!m) { const x = store.run(`INSERT INTO league_match (tournament_id,date,stage,team_a_id,team_b_id,status,ground,score_summaries,best_batters,best_bowlers,full_scorecard) VALUES (?,?,?,?,?,'completed',?,'[]','[]','[]','{}')`, tour.id, r.match_date, r.stage, a.id, b.id, tour.venue); m = store.get('SELECT * FROM league_match WHERE id=?', x.lastInsertRowid); }
      if (!cache.has(key)) {
        const existingDelivery = store.get('SELECT 1 present FROM league_delivery d JOIN league_innings i ON i.id=d.innings_id WHERE i.match_id=? LIMIT 1', m.id);
        const existingStats = store.get('SELECT 1 present FROM league_playermatchstat WHERE match_id=? LIMIT 1', m.id);
        if (existingDelivery || existingStats) throw new Error(`Match ${a.name} vs ${b.name} already has saved delivery or player statistics; import into a new match to avoid duplicating data.`);
        importedMatches.add(Number(m.id));
      }
      cache.set(key,m);
      const no = integer(r.innings, 'Innings', 1, 2);
      let inn = store.get('SELECT * FROM league_innings WHERE match_id=? AND innings_number=?', m.id, no);
      if (!inn) { const x = store.run('INSERT INTO league_innings (match_id,batting_team_id,bowling_team_id,innings_number,total_runs,wickets,legal_balls) VALUES (?,?,?, ?,0,0,0)', m.id, bat.id, bowl.id, no); inn = store.get('SELECT * FROM league_innings WHERE id=?', x.lastInsertRowid); }
      if (Number(inn.batting_team_id)!==Number(bat.id) || Number(inn.bowling_team_id)!==Number(bowl.id)) throw new Error('The CSV assigns conflicting teams to the same innings.');
      const batter=player(r.batter), bowler=player(r.bowler), dismissed=r.dismissed_player ? player(r.dismissed_player) : null, fielder=r.fielder ? player(r.fielder) : null;
      const extra = r.extra_type || 'none';
      const dismissal = r.dismissal_type || '';
      if (!['none','wide','no_ball','bye','leg_bye','penalty'].includes(extra)) throw new Error(`Unsupported extra type: ${extra}`);
      if (dismissal && !['bowled','caught','lbw','run_out','stumped','hit_wicket','caught_and_bowled','other'].includes(dismissal)) throw new Error(`Unsupported dismissal type: ${dismissal}`);
      if (dismissed && !dismissal) throw new Error('A dismissed player requires a dismissal type.');
      const outPlayer = dismissed || (dismissal ? batter : null);
      store.run('INSERT OR IGNORE INTO league_player_teams (player_id,team_id) VALUES (?,?)', batter.id, bat.id);
      store.run('INSERT OR IGNORE INTO league_player_teams (player_id,team_id) VALUES (?,?)', bowler.id, bowl.id);
      if (outPlayer) store.run('INSERT OR IGNORE INTO league_player_teams (player_id,team_id) VALUES (?,?)', outPlayer.id, bat.id);
      if (fielder) store.run('INSERT OR IGNORE INTO league_player_teams (player_id,team_id) VALUES (?,?)', fielder.id, bowl.id);
      store.run(`INSERT INTO league_delivery (innings_id,over_number,ball_number,batter_id,bowler_id,batter_runs,extra_runs,extra_type,dismissal_type,dismissed_player_id,fielder_id,is_legal) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, inn.id, integer(r.over,'Over',1), integer(r.ball,'Ball',1,6), batter.id, bowler.id, integer(r.batter_runs||0,'Batter runs',0,6), integer(r.extra_runs||0,'Extra runs',0,6), extra, r.dismissal_type||'', dismissed?.id||null, fielder?.id||null, ['wide','no_ball'].includes(extra)?0:1);
    }
    for (const matchId of importedMatches) saveMatchFromDeliveries(matchId);
    return rows.length;
  });
}
function handleAuctionAction(req, res) {
  const action = String(req.body.action || ''); const auctionId = req.body.auction_id ? Number(req.body.auction_id) : null;
  try {
    if (action === 'category_save') {
      const name = String(req.body.name || '').trim(); const price = integer(req.body.base_price || 0, 'Base price', 0);
      if (!name || name.length > 80) throw new Error('Enter a category name under 80 characters.');
      const id = req.body.category_id ? positiveId(req.body.category_id, 'category') : null;
      if (id) store.run('UPDATE league_playercategory SET name=?,description=?,base_price=?,position=? WHERE id=?', name, String(req.body.description||'').slice(0,240), price, integer(req.body.position||0,'Position',0,65535), id);
      else store.run('INSERT INTO league_playercategory (name,description,base_price,position) VALUES (?,?,?,?)', name, String(req.body.description||'').slice(0,240), price, integer(req.body.position||0,'Position',0,65535));
      audit(req, id ? 'auction_category_update' : 'auction_category_create', 'auction_category', id || store.get('SELECT last_insert_rowid() id').id);
      flash(req, 'Category saved.', 'success');
    } else if (action === 'category_delete') {
      const id = positiveId(req.body.category_id, 'category');
      store.run('DELETE FROM league_playercategory WHERE id=?', id);
      audit(req, 'auction_category_delete', 'auction_category', id);
      flash(req, 'Category deleted.', 'success');
    } else if (action === 'player_create' || action === 'player_save') {
      const name = String(req.body.name || '').trim(); if (!name || name.length > 120) throw new Error('Enter a player name.');
      const category = req.body.auction_category ? positiveId(req.body.auction_category, 'category') : null;
      const base = req.body.auction_base_price === '' ? null : integer(req.body.auction_base_price, 'Base price', 0);
      const id = action === 'player_save' ? positiveId(req.body.player_id, 'player') : null;
      const pool = req.body.in_auction_pool === 'true' ? 1 : 0; const marquee = req.body.is_marquee === 'true' ? 1 : 0;
      if (id) store.run('UPDATE league_player SET name=?,city=?,auction_category_id=?,auction_base_price=?,is_marquee=?,in_auction_pool=? WHERE id=?', name, String(req.body.city||'').slice(0,100), category, base, marquee, pool, id);
      else store.run('INSERT INTO league_player (name,city,photo,auction_category_id,auction_base_price,is_marquee,in_auction_pool,is_active) VALUES (?,?,\'\',?,?,?, ?,1)', name, String(req.body.city||'').slice(0,100), category, base, marquee, pool);
      audit(req, id ? 'auction_player_update' : 'auction_player_create', 'player', id || store.get('SELECT last_insert_rowid() id').id, { inAuctionPool: Boolean(pool), isMarquee: Boolean(marquee) });
      flash(req, id ? 'Player details saved.' : 'Player record added.', 'success');
    } else if (action === 'auction_create') {
      const name = String(req.body.name||'').trim(); const tournament = positiveId(req.body.tournament, 'season'); const increment = integer(req.body.bid_increment, 'Bid increment', 1); const budget = integer(req.body.team_budget, 'Team budget', 1);
      const playerIds = [...new Set((Array.isArray(req.body.players)?req.body.players:[req.body.players]).filter(Boolean).map(x=>positiveId(x,'player')))];
      if (!name || name.length > 150 || !playerIds.length) throw new Error('Enter an auction name and select at least one player.');
      const id = store.transaction(() => {
        const tour=store.get('SELECT id FROM league_tournament WHERE id=?', tournament); if (!tour) throw new Error('Choose a valid season.');
        const teamRows=store.all('SELECT id FROM league_team WHERE tournament_id=? ORDER BY name',tournament); if (!teamRows.length) throw new Error('The selected season has no teams.');
        const selected=store.all(`SELECT p.*,c.name category_name,c.base_price category_base_price FROM league_player p LEFT JOIN league_playercategory c ON c.id=p.auction_category_id WHERE p.id IN (${playerIds.map(()=>'?').join(',')}) AND p.is_active=1 AND p.in_auction_pool=1`,...playerIds);
        if (selected.length !== playerIds.length || selected.some(p=>p.auction_base_price==null&&p.category_base_price==null)) throw new Error('Every selected player must be active, in the auction pool, and have a category price or individual base price.');
        const a=store.run("INSERT INTO league_auction (tournament_id,name,status,bid_increment,created_at,updated_at) VALUES (?,?,'ready',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",tournament,name,increment);
        const auction=Number(a.lastInsertRowid);
        for(const t of teamRows) store.run('INSERT INTO league_auctionpurse (auction_id,team_id,budget,spent) VALUES (?,?,?,0)',auction,t.id,budget);
        let pos=1; for(const p of selected) store.run("INSERT INTO league_auctionlot (auction_id,player_id,category_id,category_name,base_price,is_marquee,position,status,current_bid,highest_team_id,sold_price) VALUES (?,?,?,?,?,?,?,'queued',0,NULL,NULL)",auction,p.id,p.auction_category_id,p.category_name||'Uncategorised',p.auction_base_price??p.category_base_price,p.is_marquee,pos++);
        return auction;
      });
      audit(req, 'auction_create', 'auction', id, { tournamentId: tournament, playerCount: playerIds.length });
      flash(req,'Auction queue created.','success'); return res.redirect(`/organiser/auction/?auction=${id}`);
    } else {
      const id = positiveId(auctionId, 'auction');
      const state = store.get('SELECT * FROM league_auction WHERE id=?',id); if(!state) throw new Error('Choose a valid auction.');
      if (action === 'increment_save') {
        store.transaction(() => {
          const current = store.get('SELECT * FROM league_auction WHERE id=?',id);
          if (!current || !['draft','ready'].includes(current.status)) throw new Error('Bid increment is locked after the auction starts.');
          store.run('UPDATE league_auction SET bid_increment=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',integer(req.body.bid_increment,'Bid increment',1),id);
        });
        audit(req, 'auction_increment_update', 'auction', id);
      } else if (action === 'purse_save') {
        store.transaction(() => {
          const current = store.get('SELECT * FROM league_auction WHERE id=?',id);
          if (!current || !['draft','ready'].includes(current.status)) throw new Error('Team purses are locked after the auction starts.');
          const purse=store.get('SELECT * FROM league_auctionpurse WHERE id=? AND auction_id=?',positiveId(req.body.purse_id,'purse'),id); if(!purse)throw new Error('Choose a valid team purse.');
          const budget=integer(req.body.budget,'Purse amount',0); if(budget<purse.spent)throw new Error('The budget cannot be below the team’s recorded spend.'); store.run('UPDATE league_auctionpurse SET budget=? WHERE id=?',budget,purse.id);
        });
        audit(req, 'auction_purse_update', 'auction', id, { purseId: Number(req.body.purse_id) });
      } else if (action === 'queue_move') {
        store.moveAuctionQueue(id, positiveId(req.body.lot_id,'lot'), req.body.direction, req.session.user.id);
      } else if (['start','pause','resume'].includes(action)) {
        store.changeAuctionState(id, action, req.session.user.id);
      } else if (action === 'bid') {
        const bid = store.placeAuctionBid({ auctionId: id, lotId: req.body.lot_id, teamId: req.body.team_id, amount: req.body.amount, userId: req.session.user.id, requestKey: req.body.idempotencyKey });
        flash(req, bid.duplicate ? 'This bid was already recorded; no duplicate bid was added.' : 'Bid recorded.', bid.duplicate ? 'info' : 'success');
        return res.redirect(`/organiser/auction/?auction=${id}`);
      } else if (action === 'sold' || action === 'unsold') {
        store.settleAuctionLot({ auctionId: id, lotId: req.body.lot_id, result: action, actorId: req.session.user.id });
      } else throw new Error('That organiser action was not recognised.');
      flash(req,'Auction settings updated.','success');
    }
  } catch(e) { flash(req,e.message || 'That auction action could not be saved.','error'); }
  const suffix = auctionId ? `?auction=${auctionId}` : '';
  res.redirect(`/organiser/auction/${suffix}`);
}

export function startServer(listenPort = port) {
  return app.listen(listenPort, () => console.log(`SPL JavaScript site ready on http://localhost:${listenPort}`));
}

if (process.env.NODE_ENV !== 'test') startServer();


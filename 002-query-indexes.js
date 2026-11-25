const indexes = [
  ['idx_spl_match_tournament_date', 'CREATE INDEX IF NOT EXISTS idx_spl_match_tournament_date ON league_match(tournament_id,date DESC,id DESC)'],
  ['idx_spl_match_status_date', 'CREATE INDEX IF NOT EXISTS idx_spl_match_status_date ON league_match(status,date DESC,id DESC)'],
  ['idx_spl_playerstat_player_match', 'CREATE INDEX IF NOT EXISTS idx_spl_playerstat_player_match ON league_playermatchstat(player_id,match_id)'],
  ['idx_spl_playerstat_team_match', 'CREATE INDEX IF NOT EXISTS idx_spl_playerstat_team_match ON league_playermatchstat(team_id,match_id)'],
  ['idx_spl_delivery_innings_ball', 'CREATE INDEX IF NOT EXISTS idx_spl_delivery_innings_ball ON league_delivery(innings_id,over_number,ball_number,id)']
];

export function up(db) { for (const [, sql] of indexes) db.exec(sql); }
export function down(db) { for (const [name] of indexes) db.exec(`DROP INDEX IF EXISTS ${name}`); }

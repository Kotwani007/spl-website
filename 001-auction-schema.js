function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS league_playercategory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(80) NOT NULL UNIQUE,
    description VARCHAR(240) NOT NULL DEFAULT '', base_price BIGINT NOT NULL DEFAULT 0 CHECK(base_price >= 0),
    position SMALLINT NOT NULL DEFAULT 0 CHECK(position >= 0)
  );
  CREATE TABLE IF NOT EXISTS league_auction (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER NOT NULL REFERENCES league_tournament(id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','running','paused','finalized')),
    bid_increment BIGINT NOT NULL DEFAULT 100000 CHECK(bid_increment > 0),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  const playerColumns = columns(db, 'league_player');
  if (!playerColumns.has('auction_category_id')) db.exec('ALTER TABLE league_player ADD COLUMN auction_category_id INTEGER REFERENCES league_playercategory(id) ON DELETE RESTRICT');
  if (!playerColumns.has('auction_base_price')) db.exec('ALTER TABLE league_player ADD COLUMN auction_base_price BIGINT CHECK(auction_base_price IS NULL OR auction_base_price >= 0)');
  if (!playerColumns.has('is_marquee')) db.exec('ALTER TABLE league_player ADD COLUMN is_marquee BOOLEAN NOT NULL DEFAULT 0 CHECK(is_marquee IN (0,1))');
  if (!playerColumns.has('in_auction_pool')) db.exec('ALTER TABLE league_player ADD COLUMN in_auction_pool BOOLEAN NOT NULL DEFAULT 0 CHECK(in_auction_pool IN (0,1))');
  db.exec(`CREATE TABLE IF NOT EXISTS league_auctionpurse (
    id INTEGER PRIMARY KEY AUTOINCREMENT, auction_id INTEGER NOT NULL REFERENCES league_auction(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES league_team(id) ON DELETE RESTRICT,
    budget BIGINT NOT NULL DEFAULT 0 CHECK(budget >= 0), spent BIGINT NOT NULL DEFAULT 0 CHECK(spent >= 0 AND spent <= budget),
    UNIQUE(auction_id,team_id)
  );
  CREATE TABLE IF NOT EXISTS league_auctionlot (
    id INTEGER PRIMARY KEY AUTOINCREMENT, auction_id INTEGER NOT NULL REFERENCES league_auction(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES league_player(id) ON DELETE RESTRICT,
    category_id INTEGER REFERENCES league_playercategory(id) ON DELETE RESTRICT,
    category_name VARCHAR(80) NOT NULL DEFAULT '', base_price BIGINT NOT NULL DEFAULT 0 CHECK(base_price >= 0),
    is_marquee BOOLEAN NOT NULL DEFAULT 0 CHECK(is_marquee IN (0,1)), position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
    status VARCHAR(12) NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','current','sold','unsold')),
    current_bid BIGINT NOT NULL DEFAULT 0 CHECK(current_bid >= 0),
    highest_team_id INTEGER REFERENCES league_team(id) ON DELETE RESTRICT, sold_price BIGINT CHECK(sold_price IS NULL OR sold_price >= 0),
    UNIQUE(auction_id,position), UNIQUE(auction_id,player_id)
  );
  CREATE TABLE IF NOT EXISTS league_auctionbid (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lot_id INTEGER NOT NULL REFERENCES league_auctionlot(id) ON DELETE RESTRICT,
    team_id INTEGER NOT NULL REFERENCES league_team(id) ON DELETE RESTRICT, amount BIGINT NOT NULL CHECK(amount > 0),
    placed_by_id INTEGER REFERENCES auth_user(id) ON DELETE SET NULL, placed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_spl_auctionlot_state ON league_auctionlot(auction_id,status,position);
  CREATE INDEX IF NOT EXISTS idx_spl_auctionbid_lot ON league_auctionbid(lot_id,placed_at,id);`);
}

export function down(db) {
  for (const table of ['league_auctionbid', 'league_auctionlot', 'league_auctionpurse', 'league_auction', 'league_playercategory']) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error(`Cannot roll back the auction schema while ${table} contains records. Restore a verified backup instead.`);
  }
  if (db.prepare('SELECT 1 FROM league_player WHERE auction_category_id IS NOT NULL OR auction_base_price IS NOT NULL OR is_marquee<>0 OR in_auction_pool<>0 LIMIT 1').get()) {
    throw new Error('Cannot roll back auction player fields while player auction data exists. Restore a verified backup instead.');
  }
  db.exec(`DROP INDEX IF EXISTS idx_spl_auctionlot_state;
    DROP INDEX IF EXISTS idx_spl_auctionbid_lot;
    DROP TABLE IF EXISTS league_auctionbid;
    DROP TABLE IF EXISTS league_auctionlot;
    DROP TABLE IF EXISTS league_auctionpurse;
    DROP TABLE IF EXISTS league_auction;`);
  const playerColumns = columns(db, 'league_player');
  for (const column of ['in_auction_pool', 'is_marquee', 'auction_base_price', 'auction_category_id']) {
    if (playerColumns.has(column)) db.exec(`ALTER TABLE league_player DROP COLUMN ${column}`);
  }
  db.exec('DROP TABLE IF EXISTS league_playercategory');
}

export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS spl_role (
    id INTEGER PRIMARY KEY AUTOINCREMENT, role_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL, is_assignable INTEGER NOT NULL DEFAULT 1 CHECK(is_assignable IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS spl_user_role (
    user_id INTEGER NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES spl_role(id) ON DELETE RESTRICT,
    granted_by_id INTEGER REFERENCES auth_user(id) ON DELETE SET NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id,role_id)
  );
  CREATE TABLE IF NOT EXISTS spl_team_owner (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES league_team(id) ON DELETE CASCADE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,team_id)
  );
  CREATE TABLE IF NOT EXISTS spl_session (
    sid TEXT PRIMARY KEY, session_json TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spl_session_expiry ON spl_session(expires_at);
  CREATE TABLE IF NOT EXISTS spl_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER REFERENCES auth_user(id) ON DELETE SET NULL,
    action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}', request_id TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS spl_idempotency_key (
    user_id INTEGER NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    request_key TEXT NOT NULL, action TEXT NOT NULL,
    response_json TEXT NOT NULL DEFAULT '{}', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id,request_key)
  );
  CREATE INDEX IF NOT EXISTS idx_spl_audit_entity ON spl_audit_log(entity_type,entity_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_spl_audit_actor ON spl_audit_log(actor_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_spl_idempotency_created ON spl_idempotency_key(created_at);
  INSERT OR IGNORE INTO spl_role(role_key,display_name,is_assignable) VALUES
    ('super_admin','Super Admin',1),('organiser','Tournament Organiser',1),
    ('auctioneer','Auctioneer',1),('team_owner','Team Owner',1),
    ('scorer','Scorer',1),('player','Registered Player',1),('spectator','Spectator',0);`);
}

export function down(db) {
  if (db.prepare('SELECT 1 FROM spl_user_role LIMIT 1').get() || db.prepare('SELECT 1 FROM spl_team_owner LIMIT 1').get() || db.prepare('SELECT 1 FROM spl_audit_log LIMIT 1').get() || db.prepare('SELECT 1 FROM spl_idempotency_key LIMIT 1').get() || db.prepare('SELECT 1 FROM spl_session LIMIT 1').get()) {
    throw new Error('Cannot roll back access, session, or audit tables after role assignments, sessions, or audit records exist. Restore a verified backup instead.');
  }
  db.exec(`DROP INDEX IF EXISTS idx_spl_audit_actor;
    DROP INDEX IF EXISTS idx_spl_audit_entity;
    DROP INDEX IF EXISTS idx_spl_session_expiry;
    DROP INDEX IF EXISTS idx_spl_idempotency_created;
    DROP TABLE IF EXISTS spl_audit_log;
    DROP TABLE IF EXISTS spl_idempotency_key;
    DROP TABLE IF EXISTS spl_session;
    DROP TABLE IF EXISTS spl_team_owner;
    DROP TABLE IF EXISTS spl_user_role;
    DROP TABLE IF EXISTS spl_role;`);
}

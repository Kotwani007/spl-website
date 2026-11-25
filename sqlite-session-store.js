import session from 'express-session';

const FALLBACK_TTL = 8 * 60 * 60 * 1000;

export class SQLiteSessionStore extends session.Store {
  constructor(database, { pruneInterval = 15 * 60 * 1000 } = {}) {
    super();
    this.database = database;
    this.pruneTimer = setInterval(() => {
      try { this.database.prepare('DELETE FROM spl_session WHERE expires_at <= ?').run(Date.now()); }
      catch (error) { this.emit('error', error); }
    }, pruneInterval);
    this.pruneTimer.unref?.();
  }

  get(sid, callback) {
    try {
      const row = this.database.prepare('SELECT session_json,expires_at FROM spl_session WHERE sid=?').get(sid);
      if (!row) return callback(null, null);
      if (Number(row.expires_at) <= Date.now()) {
        this.database.prepare('DELETE FROM spl_session WHERE sid=?').run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.session_json));
    } catch (error) { return callback(error); }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiry = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + Number(value.cookie?.maxAge || FALLBACK_TTL);
      this.database.prepare(`INSERT INTO spl_session(sid,session_json,expires_at) VALUES(?,?,?)
        ON CONFLICT(sid) DO UPDATE SET session_json=excluded.session_json,expires_at=excluded.expires_at`)
        .run(sid, JSON.stringify(value), expiry);
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, value, callback = () => {}) {
    try {
      const expiry = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + Number(value.cookie?.maxAge || FALLBACK_TTL);
      this.database.prepare('UPDATE spl_session SET expires_at=? WHERE sid=?').run(expiry, sid);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try { this.database.prepare('DELETE FROM spl_session WHERE sid=?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }

  close() { clearInterval(this.pruneTimer); }
}

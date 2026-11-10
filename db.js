const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'data', 'app.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  year INTEGER,
  category TEXT,
  description TEXT,
  poster_url TEXT,
  download_url TEXT,
  watch_url TEXT,
  price INTEGER,            -- rupees; NULL = use global price
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id INTEGER NOT NULL,
  contact TEXT NOT NULL,
  amount INTEGER NOT NULL,
  order_id TEXT UNIQUE,
  payment_id TEXT,
  status TEXT DEFAULT 'created',   -- created | paid
  token TEXT UNIQUE,
  expires_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const defaults = { price: '10', access_hours: '24', payments_enabled: '1', site_name: 'MovieHub' };
for (const [k, v] of Object.entries(defaults))
  db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(k, v);

const getSettings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

module.exports = { db, getSettings, setSetting };

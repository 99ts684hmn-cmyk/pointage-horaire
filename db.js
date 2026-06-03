'use strict';

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schéma ---------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    pin_hash   TEXT    NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    clock_in    INTEGER NOT NULL,
    clock_out   INTEGER,
    ended_by    TEXT,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_entries_emp  ON time_entries(employee_id);
  CREATE INDEX IF NOT EXISTS idx_entries_open ON time_entries(employee_id, clock_out);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Statut d'absence d'un salarié pour une journée : 'cp', 'am' ou 'ecole'.
  CREATE TABLE IF NOT EXISTS day_status (
    employee_id INTEGER NOT NULL,
    day         TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    PRIMARY KEY (employee_id, day),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  );
`);

// --- Migration : catégorie des salariés (ajout non destructif) ------------
// Catégories : 'responsable', 'chef_de_rang' (défaut), 'apprenti'.
const empCols = db.prepare("PRAGMA table_info(employees)").all();
if (!empCols.some((c) => c.name === 'category')) {
  db.exec("ALTER TABLE employees ADD COLUMN category TEXT NOT NULL DEFAULT 'chef_de_rang'");
}
// Jours de repos hebdomadaires : liste de jours (0=dim .. 6=sam) séparés par virgule.
if (!empCols.some((c) => c.name === 'rest_days')) {
  db.exec("ALTER TABLE employees ADD COLUMN rest_days TEXT NOT NULL DEFAULT ''");
}
// Service continu : le salarié fait les deux services sans coupure.
if (!empCols.some((c) => c.name === 'continuous_service')) {
  db.exec('ALTER TABLE employees ADD COLUMN continuous_service INTEGER NOT NULL DEFAULT 0');
}
// Ordre d'affichage personnalisé (glisser-déposer). Initialisé sur l'id existant.
if (!empCols.some((c) => c.name === 'sort_order')) {
  db.exec('ALTER TABLE employees ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE employees SET sort_order = id');
}
// Dernier jour dans l'entreprise (à la désactivation). Le salarié reste visible
// sur les plannings jusqu'à la semaine de cette date incluse, puis disparaît.
if (!empCols.some((c) => c.name === 'end_date')) {
  db.exec('ALTER TABLE employees ADD COLUMN end_date TEXT');
}

// --- Hachage des secrets (PIN, mot de passe admin) ------------------------
function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(secret), salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifySecret(secret, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = crypto.scryptSync(String(secret), salt, 64);
  return derived.length === expected.length &&
    crypto.timingSafeEqual(derived, expected);
}

// --- Paramètres -----------------------------------------------------------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// --- Initialisation (premier lancement) -----------------------------------
function seed() {
  // Secret HMAC pour signer les sessions admin
  if (!getSetting('session_secret')) {
    setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
  }
  // Mot de passe admin par défaut
  if (!getSetting('admin_password')) {
    setSetting('admin_password', hashSecret('admin123'));
  }
  // Créneaux de pause obligatoire déduits automatiquement
  if (!getSetting('break_windows')) {
    setSetting('break_windows', JSON.stringify([
      { start: '11:15', end: '11:45' },
      { start: '18:15', end: '18:45' },
    ]));
  }
  // Quelques employés de démonstration au tout premier lancement
  const count = db.prepare('SELECT COUNT(*) AS n FROM employees').get().n;
  if (count === 0) {
    const now = Date.now();
    const insert = db.prepare(
      'INSERT INTO employees (name, pin_hash, active, created_at) VALUES (?, ?, 1, ?)'
    );
    insert.run('Jean Dupont', hashSecret('1234'), now);
    insert.run('Marie Martin', hashSecret('5678'), now);
  }
}

seed();

module.exports = {
  db,
  hashSecret,
  verifySecret,
  getSetting,
  setSetting,
};

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Emplacement de la base cuisine. IMPORTANT : ne JAMAIS réutiliser la variable
// DB_PATH du pointage (ce serait la même base → collision). On utilise :
//   1. CUISINE_DB_PATH si défini, sinon
//   2. un fichier « cuisine.db » À CÔTÉ de la base du pointage (même disque
//      persistant en production, dérivé de DB_PATH), sinon
//   3. cuisine/data.db en local.
const DB_PATH = process.env.CUISINE_DB_PATH
  || (process.env.DB_PATH
    ? path.join(path.dirname(process.env.DB_PATH), 'cuisine.db')
    : path.join(__dirname, 'data.db'));

// Amorçage : au TOUT premier démarrage (la base n'existe pas encore, ex. après
// un déploiement sur un disque vierge), on copie le jeu de données livré dans
// le dépôt (seed.db) vers l'emplacement réel. Les démarrages suivants gardent
// la base en place (les saisies de l'utilisateur ne sont jamais écrasées).
const SEED_PATH = path.join(__dirname, 'seed.db');
if (!fs.existsSync(DB_PATH) && fs.existsSync(SEED_PATH)) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.copyFileSync(SEED_PATH, DB_PATH);
  console.log(`  Cuisine : base initialisée depuis seed.db → ${DB_PATH}`);
}

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

  -- Statut d'absence d'un salarié pour une journée : 'cp', 'am', 'ecole', etc.
  CREATE TABLE IF NOT EXISTS day_status (
    employee_id INTEGER NOT NULL,
    day         TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    PRIMARY KEY (employee_id, day),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  );

  -- Affectation MANUELLE d'un poste (grillade, froid…) pour un service donné.
  -- Prime sur l'affectation automatique calculée d'après les préférences.
  CREATE TABLE IF NOT EXISTS poste_assign (
    employee_id INTEGER NOT NULL,
    day         TEXT    NOT NULL,
    service     TEXT    NOT NULL, -- 'midi' ou 'soir'
    poste       TEXT    NOT NULL,
    PRIMARY KEY (employee_id, day, service),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  );
`);

// --- Migration : catégorie des salariés (ajout non destructif) ------------
// Catégories cuisine : 'chef', 'manager', 'chef_de_partie', 'cuisinier' (défaut), 'apprenti', 'plongeur'.
const empCols = db.prepare("PRAGMA table_info(employees)").all();
if (!empCols.some((c) => c.name === 'category')) {
  db.exec("ALTER TABLE employees ADD COLUMN category TEXT NOT NULL DEFAULT 'cuisinier'");
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
// Préférences de poste (JSON {grillade:1..3, garnitures, volant, froid, plonge}).
// 1 = poste principal, 2 = bon pour le poste, 3 = dépannage, absent = jamais.
if (!empCols.some((c) => c.name === 'postes')) {
  db.exec("ALTER TABLE employees ADD COLUMN postes TEXT NOT NULL DEFAULT ''");
}

// --- Hachage des secrets (mot de passe admin) ------------------------------
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
  // Créneaux de pause obligatoire déduits automatiquement des totaux
  if (!getSetting('break_windows')) {
    setSetting('break_windows', JSON.stringify([
      { start: '11:15', end: '11:45' },
      { start: '18:15', end: '18:45' },
    ]));
  }
  // Pas d'employés de démonstration : l'équipe de cuisine se crée dans l'admin.
}

seed();

module.exports = {
  db,
  hashSecret,
  verifySecret,
  getSetting,
  setSetting,
};

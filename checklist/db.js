'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Emplacement de la base check-lists. On n'utilise JAMAIS la DB_PATH du
// pointage (collision). Priorité :
//   1. CHECKLIST_DB_PATH si défini, sinon
//   2. un fichier « checklist.db » à côté de la base du pointage (même disque
//      persistant en production, dérivé de DB_PATH), sinon
//   3. checklist/data.db en local.
const DB_PATH = process.env.CHECKLIST_DB_PATH
  || (process.env.DB_PATH
    ? path.join(path.dirname(process.env.DB_PATH), 'checklist.db')
    : path.join(__dirname, 'data.db'));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    color      TEXT,
    icon       TEXT,
    reset_mode TEXT NOT NULL,
    ord        INTEGER NOT NULL DEFAULT 0,
    is_active  INTEGER NOT NULL DEFAULT 1,
    category   TEXT NOT NULL DEFAULT 'general',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    title       TEXT NOT NULL,
    ord         INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    day_of_week INTEGER,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS employees (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    template_id  TEXT NOT NULL,
    date         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'EN_COURS',
    completed_by TEXT,
    completed_at TEXT,
    created_at   TEXT NOT NULL,
    UNIQUE (template_id, date),
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS completions (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    task_id       TEXT NOT NULL,
    is_done       INTEGER NOT NULL DEFAULT 0,
    done_at       TEXT,
    original_date TEXT,
    UNIQUE (session_id, task_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_tmpl     ON tasks(template_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_date  ON sessions(date);
  CREATE INDEX IF NOT EXISTS idx_compl_session  ON completions(session_id);
`);

// Migration de schéma : ajoute la colonne « category » sur les bases déjà
// créées avant cette version (regroupe les check-lists par onglet : general /
// manager / bar). Idempotent (n'ajoute la colonne que si elle manque).
if (!db.prepare('PRAGMA table_info(templates)').all().some((c) => c.name === 'category')) {
  db.exec("ALTER TABLE templates ADD COLUMN category TEXT NOT NULL DEFAULT 'general'");
}

const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

// --- Données initiales (livrées avec l'appli) -----------------------------
// Reprises à l'identique de l'appli check-lists d'origine.

const WEEKLY_TASKS = [
  { title: 'Ramasser mégots et nettoyage des pots de fleur', dayOfWeek: 1 },
  { title: 'Étagère bar + étagère à mule', dayOfWeek: 1 },
  { title: 'Nettoyer devanture', dayOfWeek: 1 },
  { title: 'Nettoyer corbeille à pain', dayOfWeek: 1 },
  { title: 'Décaler les banquettes et balais en dessous', dayOfWeek: 2 },
  { title: 'Nettoyage sol cave et égout', dayOfWeek: 2 },
  { title: 'Nettoyer au dessus tireuse à bière', dayOfWeek: 2 },
  { title: 'Arroser pots de fleur', dayOfWeek: 2 },
  { title: 'Remonter carton du -1', dayOfWeek: 3 },
  { title: 'Nettoyer toutes les plinthes du restaurant', dayOfWeek: 3 },
  { title: 'Faire la poussière', dayOfWeek: 3 },
  { title: 'Remplir fleur de sel, sel et poivre', dayOfWeek: 3 },
  { title: 'Nettoyer chariot côté bœuf', dayOfWeek: 4 },
  { title: 'Nettoyage pied de chaise et table', dayOfWeek: 4 },
  { title: 'Nettoyer les murs entrée et sortie de cuisine', dayOfWeek: 4 },
  { title: 'Tirer les frigos et nettoyer derrière', dayOfWeek: 4 },
  { title: 'Nettoyer mur à côté de l\'entrée', dayOfWeek: 5 },
  { title: 'Vérifier les DLC soft en déco et frigo bar', dayOfWeek: 5 },
  { title: 'Produit inox cave maturation et machine à glaçon', dayOfWeek: 5 },
  { title: 'Nettoyage vestiaire perso + toilette', dayOfWeek: 5 },
  { title: 'Décaler les banquettes et balais en dessous', dayOfWeek: 6 },
  { title: 'Nettoyer les murs de la 14 à 33 et de la 36 à 32', dayOfWeek: 6 },
  { title: 'Nettoyer les réglettes au sol entrée cuisine', dayOfWeek: 6 },
  { title: 'Arroser pots de fleur', dayOfWeek: 6 },
  { title: 'Remonter carton du -1', dayOfWeek: 7 },
  { title: 'Aspirer miettes chaises', dayOfWeek: 7 },
  { title: 'Nettoyer filtre des clims', dayOfWeek: 7 },
  { title: 'Faire l\'escalier à la brosse', dayOfWeek: 7 },
  { title: 'Aiguiser les couteaux', dayOfWeek: 7 },
];

// Onglet « CL manager ouv matin »
const MANAGER_MATIN_TASKS = [
  'Vérifier que la terrasse soit bien mise, pot de fleur chaise table',
  'Vérifier que la devanture soit propre : pas de cigarette, pas de cendre',
  'Vérifier porte et fenetre propre',
  'Vérifier cave a vin bas et haut allumées X3 petites X2 grandes, + frigo',
  'Vérifier chauffage/',
  'Prendre le téléphone',
  'Vérifier les resa tombées la nuit et le matin, rentrer et placer et fermer les créneaux',
  'Faire un tour complet du restau : banquette table bord de fenêtre sol trace de doigt sur écran et bar toilette bar prêt à accueillir les clients',
  'Lancer la caisse et verifier que tout est ok',
  'Déposer cash (mardi & samedi)',
  'Vérifier les demi pour le soir et le lendemain et poster les horaires si on a le temps',
  'Mettre les bougies à charger',
  'Vérif réception pain',
  'Verifier Resa pour le soir et les jours suivants',
  'Vérifier que les téléphones et tablettes aient de la batterie et donner le tel bis au barman',
  'Stock pour le service et menu du jour et mettre a jour les autres',
  'verif clim haut allumé si besoin',
  'Vérifier les stocks : bidon ethanol stock en cave, gel flambage, verre, couvert, serviette, carte visite, carte anniversaire, rouleau tpe etc',
  'Faire le tour du restaurant y compris réserve, vestiaire, frigo, cave, placard, et faire en sorte que cela soit niquel.',
  'Faire le tour du restaurant en détail : exemple : les plinthes qui ne sont pas faite, les coins qu’on ne voit plus, chariot à viande etc.',
];

// Onglet « CL manager Hebdo »
const MANAGER_HEBDO_TASKS = [
  'Vérifier les stocks : bidon ethanol stock en cave, gel flambage, verre, couvert, serviette, carte visite, carte anniversaire, rouleau tpe etc',
  'Faire le tour du restaurant y compris réserve, vestiaire, frigo, cave, placard, et faire en sorte que cela soit niquel.',
];

// Onglet « Brief Manager 11 45 »
const BRIEF_MANAGER_TASKS = [
  'Menu du jour / Suggestion',
  'Qui prend quel rang : à définir en fonction des forces et ensuite des envies de chacun',
  'Information sur les resa de chaque rang',
  'Rupture ou plat à pousser',
  'Vin ou cocktail du moment',
  'Traduction en anglais 1 par jour',
];

// Les 4 anciennes check-lists d'exemple (Ouverture, Fermeture, Nettoyage,
// Inventaire) ont été retirées : plus créées sur une base neuve, et désactivées
// sur les bases existantes (migration 3).
const DEFAULT_TEMPLATES = [];

function insertTemplate(t) {
  const id = uid();
  db.prepare('INSERT INTO templates(id,name,type,color,icon,reset_mode,ord,is_active,category,created_at) VALUES(?,?,?,?,?,?,?,1,?,?)')
    .run(id, t.name, t.type, t.color, t.icon, t.resetMode, t.order, t.category || 'general', nowISO());
  return id;
}
function insertTask(templateId, title, order, dayOfWeek) {
  db.prepare('INSERT INTO tasks(id,template_id,title,ord,is_active,day_of_week,created_at) VALUES(?,?,?,?,1,?,?)')
    .run(uid(), templateId, title, order, dayOfWeek ?? null, nowISO());
}

function ensureTemplateByType(type, build) {
  const exists = db.prepare('SELECT id FROM templates WHERE type = ?').get(type);
  if (exists) return;
  build();
}

// Version de schéma/migrations appliquée à cette base (PRAGMA user_version).
const SCHEMA_VERSION = 4;

function seedAndMigrate() {
  const count = db.prepare('SELECT COUNT(*) c FROM templates').get().c;
  const freshDb = count === 0;

  if (freshDb) {
    for (const t of DEFAULT_TEMPLATES) {
      const id = insertTemplate(t);
      t.tasks.forEach((title, i) => insertTask(id, title, i + 1));
    }
    if (db.prepare('SELECT COUNT(*) c FROM employees').get().c === 0) {
      for (const name of ['Manager', 'Chef de rang', 'Serveur(se)', 'Cuisinier(e)']) {
        db.prepare('INSERT INTO employees(id,name,is_active) VALUES(?,?,1)').run(uid(), name);
      }
    }
  }

  // Idempotent : crée les check-lists manquantes (sur base neuve ET sur base
  // existante au prochain démarrage). Ne touche jamais une check-list déjà là.
  ensureTemplateByType('HEBDOMADAIRE', () => {
    const id = insertTemplate({ name: 'Tâches hebdo salle', type: 'HEBDOMADAIRE', color: 'bg-purple-500', icon: '📅', resetMode: 'WEEKLY_CARRY_OVER', order: 5 });
    WEEKLY_TASKS.forEach((t, i) => insertTask(id, t.title, i + 1, t.dayOfWeek));
  });
  ensureTemplateByType('MANAGER_MATIN', () => {
    const id = insertTemplate({ name: 'Check Manager Matin', type: 'MANAGER_MATIN', color: 'bg-red-600', icon: '👔', resetMode: 'AUTO_DAILY', order: 6, category: 'manager' });
    MANAGER_MATIN_TASKS.forEach((title, i) => insertTask(id, title, i + 1));
  });
  ensureTemplateByType('MANAGER_HEBDO', () => {
    const id = insertTemplate({ name: 'Manager Hebdo', type: 'MANAGER_HEBDO', color: 'bg-purple-500', icon: '🗓️', resetMode: 'AUTO_DAILY', order: 7, category: 'manager' });
    MANAGER_HEBDO_TASKS.forEach((title, i) => insertTask(id, title, i + 1));
  });
  ensureTemplateByType('BRIEF_MANAGER', () => {
    const id = insertTemplate({ name: 'Brief Manager', type: 'BRIEF_MANAGER', color: 'bg-rose-600', icon: '🗣️', resetMode: 'AUTO_DAILY', order: 8, category: 'manager' });
    BRIEF_MANAGER_TASKS.forEach((title, i) => insertTask(id, title, i + 1));
  });
  // Nouvelles check-lists de service (onglet « Check-lists »), créées vides :
  // les tâches sont à ajouter ensuite via l'Admin.
  ensureTemplateByType('OUV_MIDI', () => insertTemplate({ name: 'Ouverture midi', type: 'OUV_MIDI', color: 'bg-amber-400', icon: '☀️', resetMode: 'AUTO_DAILY', order: 1, category: 'general' }));
  ensureTemplateByType('FERM_MIDI', () => insertTemplate({ name: 'Fermeture midi', type: 'FERM_MIDI', color: 'bg-amber-600', icon: '🍽️', resetMode: 'AUTO_DAILY', order: 2, category: 'general' }));
  ensureTemplateByType('OUV_SOIR', () => insertTemplate({ name: 'Ouverture soir', type: 'OUV_SOIR', color: 'bg-indigo-400', icon: '🌆', resetMode: 'AUTO_DAILY', order: 3, category: 'general' }));
  ensureTemplateByType('FERM_SOIR', () => insertTemplate({ name: 'Fermeture soir', type: 'FERM_SOIR', color: 'bg-indigo-600', icon: '🌃', resetMode: 'AUTO_DAILY', order: 4, category: 'general' }));
  // Check-lists Bar (onglet « Check-list Bar »), créées vides.
  ensureTemplateByType('BAR_FERM_MIDI_HAUT', () => insertTemplate({ name: 'Fermeture midi bar du haut', type: 'BAR_FERM_MIDI_HAUT', color: 'bg-rose-500', icon: '🍸', resetMode: 'AUTO_DAILY', order: 13, category: 'bar' }));
  ensureTemplateByType('BAR_FERM_MIDI_BAS', () => insertTemplate({ name: 'Fermeture midi bar du bas', type: 'BAR_FERM_MIDI_BAS', color: 'bg-rose-500', icon: '🍹', resetMode: 'AUTO_DAILY', order: 14, category: 'bar' }));

  // Migration 1 : remplacer les tâches de « Check Manager Matin » par celles de
  // l'onglet « CL manager ouv matin ». Uniquement sur une base DÉJÀ existante
  // (sur base neuve, le seed ci-dessus a déjà mis les bonnes tâches). On ne
  // SUPPRIME pas : on désactive les anciennes (l'historique des sessions reste
  // intact) puis on insère les nouvelles. Exécutée une seule fois (user_version).
  const version = db.pragma('user_version', { simple: true });
  if (version < 1 && !freshDb) {
    const mm = db.prepare("SELECT id FROM templates WHERE type = 'MANAGER_MATIN'").get();
    if (mm) {
      db.prepare('UPDATE tasks SET is_active = 0 WHERE template_id = ? AND is_active = 1').run(mm.id);
      MANAGER_MATIN_TASKS.forEach((title, i) => insertTask(mm.id, title, i + 1));
    }
  }
  // Migration 2 : ranger les check-lists manager dans l'onglet « Manager »
  // (sur base existante, la colonne category vient d'être ajoutée à 'general').
  if (version < 2 && !freshDb) {
    db.prepare("UPDATE templates SET category = 'manager' WHERE type IN ('MANAGER_MATIN','MANAGER_HEBDO','BRIEF_MANAGER')").run();
  }
  // Migration 3 : retirer les 4 check-lists d'exemple (Ouverture, Fermeture,
  // Nettoyage, Inventaire). Désactivées (is_active=0) → elles disparaissent de
  // l'app ; l'historique éventuel reste en base. Réversible (réactivable).
  if (version < 3 && !freshDb) {
    db.prepare("UPDATE templates SET is_active = 0 WHERE type IN ('OUVERTURE','FERMETURE','NETTOYAGE','INVENTAIRE')").run();
  }
  // Migration 4 : ordre de l'onglet « Check-lists » (service) →
  // Ouverture midi, Fermeture midi, Ouverture soir, Fermeture soir, Tâches hebdo.
  if (version < 4 && !freshDb) {
    const setOrd = db.prepare('UPDATE templates SET ord = ? WHERE type = ?');
    setOrd.run(1, 'OUV_MIDI');
    setOrd.run(2, 'FERM_MIDI');
    setOrd.run(3, 'OUV_SOIR');
    setOrd.run(4, 'FERM_SOIR');
    setOrd.run(5, 'HEBDOMADAIRE');
  }
  db.pragma('user_version = ' + SCHEMA_VERSION);
}

seedAndMigrate();

module.exports = { db, uid, nowISO, DB_PATH };

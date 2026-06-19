'use strict';

// Test automatique des migrations de la base check-lists.
// Usage :  node checklist/test-migrations.js
//
// Ne touche JAMAIS la base de prod : tout se passe sur des copies dans un dossier
// temporaire. Couvre :
//   [1] Base neuve     → atteint SCHEMA_VERSION, pas de doublon, types attendus présents
//   [2] Idempotence    → 2e chargement stable (aucun doublon créé)
//   [3] Rejouabilité   → remettre user_version en arrière puis recharger ne casse rien
//   [4] Copie de prod  → la vraie base se charge proprement (si présente)
// Sort en code 1 si un test échoue (utilisable en CI / pre-push).

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DB_JS = path.join(__dirname, 'db.js');
const PROD = path.join(__dirname, 'data.db');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-migtest-'));

const EXPECTED = parseInt(fs.readFileSync(DB_JS, 'utf8').match(/SCHEMA_VERSION\s*=\s*(\d+)/)[1], 10);

// Check-lists qui DOIVENT exister sur une base neuve.
const MUST_EXIST = [
  'OUV_MIDI', 'OUV_MIDI_HAUT', 'FERM_MIDI', 'FERM_MIDI_HAUT',
  'OUV_SOIR', 'OUV_SOIR_HAUT', 'FERM_SOIR', 'FERM_SOIR_HAUT',
  'BAR_FERM_SOIR_BAS', 'BAR_FERM_SOIR_HAUT', 'HEBDOMADAIRE', 'MENAGE_HEBDO',
  'MANAGER_MATIN', 'MANAGER_HEBDO', 'BRIEF_MANAGER',
  'CUISINE_PLANCHA', 'CUISINE_GARNITURE', 'CUISINE_FERM_FROID', 'CUISINE_MENAGE_HEBDO',
];
// Check-lists qui NE doivent PLUS être actives (supprimées par migration).
const MUST_BE_GONE = ['BAR_FERM_MIDI_HAUT', 'BAR_FERM_MIDI_BAS'];

// Charge db.js (= joue les migrations) dans un process enfant isolé, sur dbPath.
// Renvoie { version, templates:[{type,name,category,ord}] }.
function loadDb(dbPath) {
  const code = `
    process.env.CHECKLIST_DB_PATH = ${JSON.stringify(dbPath)};
    const { db } = require(${JSON.stringify(DB_JS)});
    const v = db.pragma('user_version', { simple: true });
    const t = db.prepare("SELECT type,name,category,ord FROM templates WHERE is_active=1 ORDER BY ord").all();
    process.stdout.write('__RESULT__' + JSON.stringify({ version: v, templates: t }));
  `;
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  return JSON.parse(out.slice(out.indexOf('__RESULT__') + 10));
}

function setVersion(dbPath, v) {
  const d = new Database(dbPath);
  d.pragma('user_version = ' + v);
  d.close();
}

let failures = 0;
function check(label, cond, detail) {
  console.log('  ' + (cond ? '✓' : '✗ ÉCHEC') + ' ' + label + (detail ? ' — ' + detail : ''));
  if (!cond) failures++;
}
function noDup(types) { return new Set(types).size === types.length; }

async function main() {
  console.log('SCHEMA_VERSION attendu = ' + EXPECTED + '\n');

  // [1] Base neuve
  console.log('[1] Base neuve');
  const fresh = path.join(TMP, 'fresh.db');
  const r1 = loadDb(fresh);
  const types1 = r1.templates.map((t) => t.type);
  check('version = ' + EXPECTED, r1.version === EXPECTED, 'v=' + r1.version);
  check('aucun type en double', noDup(types1), types1.length + ' check-lists');
  const missing = MUST_EXIST.filter((t) => !types1.includes(t));
  check('toutes les check-lists attendues présentes', missing.length === 0, missing.length ? 'manquantes: ' + missing.join(', ') : '');
  const stillThere = MUST_BE_GONE.filter((t) => types1.includes(t));
  check('check-lists supprimées bien absentes', stillThere.length === 0, stillThere.length ? 'encore là: ' + stillThere.join(', ') : '');

  // [2] Idempotence — 2e chargement de la même base
  console.log('\n[2] Idempotence (2e démarrage)');
  const r2 = loadDb(fresh);
  check('même nombre de check-lists', r2.templates.length === r1.templates.length, r1.templates.length + ' → ' + r2.templates.length);
  check('version stable', r2.version === EXPECTED, 'v=' + r2.version);

  // [3] Rejouabilité des dernières migrations
  const back = Math.max(0, EXPECTED - 4);
  console.log('\n[3] Rejouabilité (user_version remis à ' + back + ' puis rechargé)');
  setVersion(fresh, back);
  const r3 = loadDb(fresh);
  check('revient à ' + EXPECTED, r3.version === EXPECTED, 'v=' + r3.version);
  check('aucun doublon après rejeu', noDup(r3.templates.map((t) => t.type)));
  check('nombre de check-lists inchangé', r3.templates.length === r1.templates.length, r1.templates.length + ' → ' + r3.templates.length);

  // [4] Copie de la base de prod (sans la toucher)
  console.log('\n[4] Copie de la prod');
  if (fs.existsSync(PROD)) {
    const copy = path.join(TMP, 'prod-copy.db');
    const src = new Database(PROD, { readonly: true });
    await src.backup(copy);
    src.close();
    const r4 = loadDb(copy);
    check('prod chargée à ' + EXPECTED, r4.version === EXPECTED, 'v=' + r4.version);
    check('aucun type en double', noDup(r4.templates.map((t) => t.type)), r4.templates.length + ' check-lists');
  } else {
    console.log('  (pas de base de prod locale — test ignoré)');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + (failures === 0 ? '✅ Tous les tests passent.' : '❌ ' + failures + ' test(s) en échec.'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });

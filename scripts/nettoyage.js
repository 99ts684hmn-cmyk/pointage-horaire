'use strict';
/*
 * Outil de nettoyage PONCTUEL — sécurisé.
 *
 *   node scripts/nettoyage.js            → SIMULATION : n'efface rien, affiche le bilan
 *   node scripts/nettoyage.js --apply    → APPLIQUE réellement (sauvegarde auto avant)
 *
 * Effets en mode --apply :
 *   1) Supprime DÉFINITIVEMENT les salariés listés dans NOMS (et tous leurs pointages + statuts).
 *   2) Supprime tous les pointages dont le JOUR OUVRÉ est strictement avant DATE_LIMITE.
 *
 * Utilise la même base que l'application (variable d'environnement DB_PATH).
 */
const path = require('path');
const Database = require('better-sqlite3');

// ---- Paramètres ----------------------------------------------------------
const NOMS = ['Jean Dupont', 'Marie Martin'];
const DATE_LIMITE = '2026-06-01'; // on supprime les pointages AVANT cette date (non incluse)
// --------------------------------------------------------------------------

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const APPLY = process.argv.includes('--apply');

const DAY_CUTOFF_HOUR = 5; // même logique « jour ouvré » que l'application
function localDay(ts) {
  const d = new Date(ts);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-');
}
function businessDay(ts) { return localDay(ts - DAY_CUTOFF_HOUR * 3600 * 1000); }

const db = new Database(DB_PATH);
const hasDayStatus = !!db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='day_status'").get();

console.log('Base :', DB_PATH);
console.log('Mode :', APPLY ? '⚠️  APPLICATION RÉELLE' : 'SIMULATION (rien ne sera supprimé)');
console.log('');

// 1) Salariés à supprimer définitivement
const emps = [];
for (const nom of NOMS) {
  for (const r of db.prepare(
    'SELECT id, name FROM employees WHERE lower(trim(name)) = lower(trim(?))').all(nom)) {
    emps.push(r);
  }
}
const empIds = emps.map((e) => e.id);
console.log('1) Salariés à supprimer définitivement :');
if (!emps.length) console.log('   (aucun trouvé — rien à faire)');
for (const e of emps) {
  const n = db.prepare('SELECT COUNT(*) c FROM time_entries WHERE employee_id=?').get(e.id).c;
  console.log(`   - ${e.name} (id ${e.id}) → ${n} pointage(s)`);
}

// 2) Pointages avant la date limite (jour ouvré)
const all = db.prepare('SELECT id, clock_in FROM time_entries').all();
const oldIds = all.filter((r) => businessDay(r.clock_in) < DATE_LIMITE).map((r) => r.id);
console.log(`\n2) Pointages avant le ${DATE_LIMITE} (jour ouvré, non inclus) : ${oldIds.length} à supprimer`);
console.log(`   (sur ${all.length} pointages au total)`);

if (!APPLY) {
  console.log('\n👉 Simulation terminée. Pour appliquer réellement :');
  console.log('   node scripts/nettoyage.js --apply');
  process.exit(0);
}

(async () => {
  // Sauvegarde automatique AVANT toute suppression
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DB_PATH}.backup-${stamp}`;
  await db.backup(backupPath);
  console.log('\n✔ Sauvegarde créée :', backupPath);

  const tx = db.transaction(() => {
    for (const id of empIds) {
      db.prepare('DELETE FROM time_entries WHERE employee_id = ?').run(id);
      if (hasDayStatus) db.prepare('DELETE FROM day_status WHERE employee_id = ?').run(id);
      db.prepare('DELETE FROM employees WHERE id = ?').run(id);
    }
    const del = db.prepare('DELETE FROM time_entries WHERE id = ?');
    for (const id of oldIds) del.run(id);
  });
  tx();

  const remEntries = db.prepare('SELECT COUNT(*) c FROM time_entries').get().c;
  const remEmps = db.prepare('SELECT COUNT(*) c FROM employees').get().c;
  console.log('✔ Suppression appliquée.');
  console.log(`   Pointages restants : ${remEntries} | Salariés restants : ${remEmps}`);
  console.log(`   En cas de problème, restaurez : ${backupPath}`);
})();

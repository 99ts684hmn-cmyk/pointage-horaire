'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const DOW = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
function dayHead(iso) {
  const d = new Date(iso + 'T12:00:00');
  const [, m, dd] = iso.split('-');
  return `${DOW[d.getDay()]} ${dd}/${m}`;
}
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dm(iso) { const [, m, dd] = iso.split('-'); return `${dd}/${m}`; }
function weekRange(monday) { return `${dm(monday)} → ${dm(addDaysIso(monday, 6))}`; }

// Menus : 3 lignes « indélébiles » × 2 colonnes (début / fin de semaine).
const MENU_ROWS = [['entree', 'Entrée'], ['pj', 'PJ'], ['dessert', 'Dessert']];
const MENU_COLS = [['debut', 'Début de semaine'], ['fin', 'Fin de semaine']];
// Groupes : champs du formulaire (clé → libellé + type).
const GROUP_FIELDS = [
  ['nom', 'Nom du groupe', 'text'],
  ['pers', 'Nombre de personnes', 'number'],
  ['menu', 'Menu', 'textarea'],
  ['allergies', 'Allergies', 'text'],
  ['boissons', 'Boissons', 'text'],
  ['prix', 'Prix par personne', 'text'],
  ['gratuite', 'Gratuité', 'text'],
  ['guide', 'Guide', 'text'],
  ['infos', 'Infos', 'textarea'],
];

const content = document.getElementById('content');
const ov = document.getElementById('ov');
const modal = document.getElementById('modal');
let data = { semaineMonday: '', semaineProMonday: '', groupes: [], cells: {} };
let gDate = null;
let gIndex = null; // index du groupe édité (null = nouveau)
let view = 'boards'; // 'boards' | 'menus' | 'groupes'
let recap = null; // données des récapitulatifs (chargées à la demande)
// Page : 'menus' (menus seuls), 'groupes' (groupes seuls) ou 'all' (les deux).
const PAGE = window.MENU_PAGE || 'all';

async function load() {
  try { data = await fetch('api/menus').then((r) => r.json()); }
  catch (e) { content.innerHTML = '<div class="empty">Impossible de charger les menus.</div>'; return; }
  if (!data.cells) data.cells = {};
  render();
}

function menuTable(monday) {
  const head = `<thead><tr><th class="lbl cnr"></th>${MENU_COLS.map((c) => `<th>${c[1]}</th>`).join('')}</tr></thead>`;
  const body = MENU_ROWS.map(([row, label]) => {
    const tds = MENU_COLS.map(([col]) => {
      const slot = `${col}_${row}`;
      const v = (data.cells[monday] && data.cells[monday][slot]) || '';
      return `<td><textarea rows="1" data-date="${monday}" data-slot="${slot}">${esc(v)}</textarea></td>`;
    }).join('');
    return `<tr><td class="lbl">${esc(label)}</td>${tds}</tr>`;
  }).join('');
  return `<div class="veleda-wrap"><table class="veleda">${head}<tbody>${body}</tbody></table></div>`;
}

// Plusieurs groupes par jour → tableau JSON. Compat : objet unique ou texte brut.
function parseGroups(raw) {
  if (!raw) return [];
  try {
    const o = JSON.parse(raw);
    if (Array.isArray(o)) return o.filter((x) => x && typeof x === 'object');
    if (o && typeof o === 'object') return [o];
  } catch (e) { return [{ nom: String(raw) }]; }
  return [];
}
function groupFilled(g) { return GROUP_FIELDS.some(([k]) => g[k] && String(g[k]).trim()); }

function groupSummary(g) {
  const top = [];
  if (g.nom) top.push(`<strong>${esc(g.nom)}</strong>`);
  if (g.pers) top.push(`${esc(g.pers)} pers`);
  if (g.prix) top.push(`${esc(g.prix)}/pers`);
  let html = `<div class="g-sum">${top.join(' · ') || '(groupe)'}</div>`;
  if (g.menu) html += `<div class="g-line">${esc(g.menu)}</div>`;
  if (g.allergies) html += `<div class="g-line">⚠️ ${esc(g.allergies)}</div>`;
  if (g.boissons) html += `<div class="g-line">🥤 ${esc(g.boissons)}</div>`;
  if (g.gratuite) html += `<div class="g-line">🎁 Gratuité : ${esc(g.gratuite)}</div>`;
  if (g.guide) html += `<div class="g-line">🧭 Guide : ${esc(g.guide)}</div>`;
  if (g.infos) html += `<div class="g-line">ℹ️ ${esc(g.infos)}</div>`;
  if (g.annule) html = `<div class="g-annule-badge">ANNULÉ</div>${html}`;
  return html;
}

function groupTable(dates) {
  const head = `<thead><tr>${dates.map((d) => `<th>${dayHead(d)}</th>`).join('')}</tr></thead>`;
  const tds = dates.map((d) => {
    const arr = parseGroups(data.cells[d] && data.cells[d].groupe);
    const items = arr.map((g, i) => `<button class="g-item${g.annule ? ' annule' : ''}" data-date="${d}" data-index="${i}">${groupSummary(g)}</button>`).join('');
    return `<td><div class="g-list">${items}<button class="g-add" data-date="${d}">+ Ajouter un groupe</button></div></td>`;
  }).join('');
  return `<div class="veleda-wrap"><table class="veleda">${head}<tbody><tr>${tds}</tr></tbody></table></div>`;
}

// Tableau menu en lecture seule (pour les récapitulatifs).
function menuTableRO(cells) {
  const head = `<thead><tr><th class="lbl cnr"></th>${MENU_COLS.map((c) => `<th>${c[1]}</th>`).join('')}</tr></thead>`;
  const body = MENU_ROWS.map(([row, label]) => {
    const tds = MENU_COLS.map(([col]) => {
      const v = (cells && cells[`${col}_${row}`]) || '';
      return `<td class="ro">${v ? esc(v) : '<span class="ro-empty">—</span>'}</td>`;
    }).join('');
    return `<tr><td class="lbl">${esc(label)}</td>${tds}</tr>`;
  }).join('');
  return `<div class="veleda-wrap"><table class="veleda">${head}<tbody>${body}</tbody></table></div>`;
}

function boardsHTML() {
  const menuSemaine = `<section class="board"><h2>📋 Menu — cette semaine <span class="wk">${weekRange(data.semaineMonday)}</span></h2>${menuTable(data.semaineMonday)}</section>`;
  const menuPro = `<section class="board"><h2>📋 Menu — semaine prochaine <span class="wk">${weekRange(data.semaineProMonday)}</span></h2>${menuTable(data.semaineProMonday)}</section>`;
  const groupes = `<section class="board groupes">
      <h2>👥 Groupes</h2>
      <div class="g-nav">
        <button class="btn btn-grey" id="g-prev">‹ Semaine précédente</button>
        <span class="g-range">${dayHead(data.groupes[0])} → ${dayHead(data.groupes[6])}</span>
        <button class="btn btn-grey" id="g-next">Semaine suivante ›</button>
      </div>
      ${groupTable(data.groupes)}
    </section>`;
  if (PAGE === 'menus') return menuSemaine + menuPro;
  if (PAGE === 'groupes') return groupes;
  return menuSemaine + groupes + menuPro;
}

function recapMenusHTML() {
  if (!recap) return '<div class="loading pulse">Chargement…</div>';
  if (!recap.menus.length) return '<div class="empty">Aucun menu enregistré.</div>';
  return recap.menus.map((w) => `<section class="board"><h2>📋 Semaine du <span class="wk">${weekRange(w.monday)}</span></h2>${menuTableRO(w.cells)}</section>`).join('');
}

function recapGroupesHTML() {
  if (!recap) return '<div class="loading pulse">Chargement…</div>';
  const entries = recap.groupes.map((e) => ({ date: e.date, arr: parseGroups(e.value) })).filter((e) => e.arr.length);
  if (!entries.length) return '<div class="empty">Aucun groupe enregistré.</div>';
  return entries.map((e) => {
    const items = e.arr.map((g) => `<div class="g-item${g.annule ? ' annule' : ''}" style="cursor:default">${groupSummary(g)}</div>`).join('');
    return `<section class="board groupes"><h2>👥 <span class="wk">${dayHead(e.date)}</span></h2><div class="g-list">${items}</div></section>`;
  }).join('');
}

function render() {
  const recapMenus = `<button class="vb${view === 'menus' ? ' active' : ''}" data-view="menus">📋 Récap menus</button>`;
  const recapGroupes = `<button class="vb${view === 'groupes' ? ' active' : ''}" data-view="groupes">👥 Récap groupes</button>`;
  const recapBtns = PAGE === 'menus' ? recapMenus : PAGE === 'groupes' ? recapGroupes : recapMenus + recapGroupes;
  const bar = `<div class="viewbar"><button class="vb${view === 'boards' ? ' active' : ''}" data-view="boards">Tableaux</button>${recapBtns}</div>`;
  const body = view === 'menus' ? recapMenusHTML() : view === 'groupes' ? recapGroupesHTML() : boardsHTML();
  content.innerHTML = bar + body;

  content.querySelectorAll('.vb').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  if (view !== 'boards') return;

  content.querySelectorAll('textarea').forEach((t) => {
    autoGrow(t);
    t.addEventListener('input', () => autoGrow(t));
    t.addEventListener('change', () => saveCell(t));
  });
  content.querySelectorAll('.g-item').forEach((b) => b.addEventListener('click', () => openGroup(b.dataset.date, parseInt(b.dataset.index, 10))));
  content.querySelectorAll('.g-add').forEach((b) => b.addEventListener('click', () => openGroup(b.dataset.date, null)));
  const prev = document.getElementById('g-prev'); if (prev) prev.addEventListener('click', () => reloadGroupes(addDaysIso(data.groupStart, -7)));
  const next = document.getElementById('g-next'); if (next) next.addEventListener('click', () => reloadGroupes(addDaysIso(data.groupStart, 7)));
}

function setView(v) {
  view = v;
  render();
  if (v !== 'boards') fetchRecap(); // rafraîchit le récap en arrière-plan
}

async function fetchRecap() {
  try { recap = await fetch('api/menus/recap').then((r) => r.json()); }
  catch (e) { if (!recap) recap = { menus: [], groupes: [] }; }
  if (view !== 'boards') render();
}

async function reloadGroupes(start) {
  try {
    data = await fetch('api/menus?groupStart=' + encodeURIComponent(start)).then((r) => r.json());
    if (!data.cells) data.cells = {};
    render();
  } catch (e) { /* on garde l'affichage courant */ }
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = Math.max(50, t.scrollHeight) + 'px';
}

// --- Menus (cases texte) ---
async function saveCell(t) {
  const date = t.dataset.date; const slot = t.dataset.slot; const value = t.value.trim();
  if (!data.cells[date]) data.cells[date] = {};
  if (value) data.cells[date][slot] = value; else delete data.cells[date][slot];
  try {
    await fetch('api/menus/cell', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, slot, value }) });
    t.classList.remove('saved-flash'); void t.offsetWidth; t.classList.add('saved-flash');
  } catch (e) { /* gardé localement */ }
}

// --- Groupes : formulaire (ajout ou édition) ---
function openGroup(date, index) {
  gDate = date;
  gIndex = (index == null || isNaN(index)) ? null : index;
  const arr = parseGroups(data.cells[date] && data.cells[date].groupe);
  const g = gIndex != null ? (arr[gIndex] || {}) : {};
  modal.innerHTML = `
    <h2>${gIndex != null ? 'Groupe' : 'Nouveau groupe'} — ${dayHead(date)}</h2>
    <div class="gform">
      ${GROUP_FIELDS.map(([k, label, type]) => (type === 'textarea'
    ? `<label>${label}</label><textarea id="g-${k}">${esc(g[k] || '')}</textarea>`
    : `<label>${label}</label><input id="g-${k}" type="${type}"${type === 'number' ? ' inputmode="numeric"' : ''} value="${esc(g[k] || '')}">`)).join('')}
    </div>
    <div class="actions" style="flex-wrap:wrap">
      ${gIndex != null
    ? (g.annule
      ? '<button class="btn btn-grey" id="g-react">Réactiver le groupe</button>'
      : '<button class="btn btn-grey" id="g-annuler">🚫 Annuler le groupe</button>')
        + '<button class="btn btn-grey" id="g-del">Supprimer</button>'
    : '<button class="btn btn-grey" id="g-cancel">Annuler</button>'}
      <button class="btn btn-red" id="g-save">Enregistrer</button>
    </div>`;
  const byId = (id) => modal.querySelector('#' + id);
  if (byId('g-cancel')) byId('g-cancel').addEventListener('click', closeGroup);
  byId('g-save').addEventListener('click', () => saveGroup('save'));
  if (byId('g-annuler')) byId('g-annuler').addEventListener('click', () => saveGroup('annuler'));
  if (byId('g-react')) byId('g-react').addEventListener('click', () => saveGroup('reactiver'));
  if (byId('g-del')) byId('g-del').addEventListener('click', () => saveGroup('delete'));
  ov.classList.add('show');
  const first = modal.querySelector('#g-nom'); if (first) first.focus();
}
function closeGroup() { ov.classList.remove('show'); gDate = null; gIndex = null; }

async function saveGroup(mode) {
  const date = gDate;
  const arr = parseGroups(data.cells[date] && data.cells[date].groupe);
  const prev = (gIndex != null && arr[gIndex]) ? arr[gIndex] : {};
  if (mode === 'delete') {
    if (gIndex != null) arr.splice(gIndex, 1);
  } else {
    const g = {};
    GROUP_FIELDS.forEach(([k]) => { const el = modal.querySelector('#g-' + k); g[k] = el ? el.value.trim() : ''; });
    // annule : forcé selon le bouton, sinon on conserve l'état précédent.
    g.annule = mode === 'annuler' ? true : mode === 'reactiver' ? false : !!prev.annule;
    if (groupFilled(g) || g.annule) {
      if (gIndex != null) arr[gIndex] = g; else arr.push(g);
    } else if (gIndex != null) {
      arr.splice(gIndex, 1); // formulaire vidé sur un groupe existant = suppression
    }
  }
  const value = arr.length ? JSON.stringify(arr) : '';
  if (!data.cells[date]) data.cells[date] = {};
  if (value) data.cells[date].groupe = value; else delete data.cells[date].groupe;
  closeGroup();
  render();
  try {
    await fetch('api/menus/cell', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, slot: 'groupe', value }) });
  } catch (e) { /* gardé localement */ }
}

ov.addEventListener('click', (e) => { if (e.target === ov) closeGroup(); });

load();

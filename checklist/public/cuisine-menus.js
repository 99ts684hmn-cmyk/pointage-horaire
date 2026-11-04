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

// Page Groupes : vue sur 3 semaines (lundi → dimanche), à partir de la semaine
// en cours ; ailleurs, fenêtre de 7 jours à partir d'aujourd'hui.
const GROUP_DAYS = PAGE === 'groupes' ? 21 : 7;
function mondayOfIso(iso) {
  const d = new Date(iso + 'T12:00:00');
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (dow - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function menusUrl(start) {
  const q = [];
  if (start) q.push('groupStart=' + encodeURIComponent(start));
  if (GROUP_DAYS !== 7) q.push('groupDays=' + GROUP_DAYS);
  return 'api/menus' + (q.length ? '?' + q.join('&') : '');
}

async function load() {
  try {
    data = await fetch(menusUrl()).then((r) => r.json());
    // Page Groupes : on recale la fenêtre sur le lundi de la semaine en cours.
    if (PAGE === 'groupes' && data.today && data.groupStart !== mondayOfIso(data.today)) {
      data = await fetch(menusUrl(mondayOfIso(data.today))).then((r) => r.json());
    }
  } catch (e) { content.innerHTML = '<div class="empty">Impossible de charger les menus.</div>'; return; }
  if (!data.cells) data.cells = {};
  render();
}

function menuTable(monday) {
  const head = `<thead><tr><th class="lbl cnr"></th>${MENU_COLS.map((c) => `<th>${c[1]}</th>`).join('')}</tr></thead>`;
  const body = MENU_ROWS.map(([row, label]) => {
    const tds = MENU_COLS.map(([col]) => {
      const slot = `${col}_${row}`;
      const v = (data.cells[monday] && data.cells[monday][slot]) || '';
      const pinned = !!(data.pins && data.pins[monday] && data.pins[monday][slot]);
      return `<td class="mcell"><input type="checkbox" class="pin-chk" data-date="${monday}" data-slot="${slot}"${pinned ? ' checked' : ''} title="Cocher pour afficher cette case dans le bandeau (cuisine + managers salle)"><textarea rows="1" data-date="${monday}" data-slot="${slot}">${esc(v)}</textarea></td>`;
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

// Résumé compact pour les cases du tableau : nom · pers · prix + allergies.
function groupSummaryCompact(g) {
  const top = [];
  if (g.nom) top.push(`<strong>${esc(g.nom)}</strong>`);
  if (g.pers) top.push(`${esc(g.pers)} pers`);
  if (g.prix) top.push(`${esc(g.prix)}/pers`);
  let html = `<div class="g-sum">${top.join(' · ') || '(groupe)'}</div>`;
  if (g.allergies) html += `<div class="g-line">⚠️ ${esc(g.allergies)}</div>`;
  if (g.annule) html = `<div class="g-annule-badge">ANNULÉ</div>${html}`;
  return html;
}

function groupTable(dates) {
  const head = `<thead><tr>${dates.map((d) => `<th>${dayHead(d)}</th>`).join('')}</tr></thead>`;
  const tds = dates.map((d) => {
    const arr = parseGroups(data.cells[d] && data.cells[d].groupe);
    const items = arr.map((g, i) => `<button class="g-item${g.annule ? ' annule' : ''}" data-date="${d}" data-index="${i}">${groupSummaryCompact(g)}</button>`).join('');
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
  const menuSuiv = `<section class="board"><h2>📋 Menu — semaine suivante <span class="wk">${weekRange(data.semaineSuivMonday)}</span></h2>${menuTable(data.semaineSuivMonday)}</section>`;
  // Bloc « Ajouter un groupe » : on choisit la date, puis le formulaire habituel
  // s'ouvre pour ce jour-là (même si la date est hors de la semaine affichée).
  const addBar = `<div class="g-addbar">
        <span class="g-addlbl">➕ Ajouter un groupe</span>
        <input type="date" id="g-newdate" value="${esc(data.today || '')}" min="${esc(data.today || '')}">
        <button class="btn btn-red" id="g-newbtn">Ajouter</button>
      </div>`;
  // Bloc « Rechercher un groupe » : par nom, date et/ou tranche de convives,
  // dans TOUS les groupes enregistrés (passés et à venir).
  const searchBar = `<div class="g-addbar g-search">
        <span class="g-addlbl">🔍 Rechercher un groupe</span>
        <input type="text" id="gs-nom" placeholder="Nom…" value="${esc(gSearch.nom)}">
        <input type="date" id="gs-date" value="${esc(gSearch.date)}">
        <select id="gs-pers">${PERS_RANGES.map(([v, l]) => `<option value="${v}"${v === gSearch.pers ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn btn-grey" id="gs-clear" type="button">Effacer</button>
        <div id="gs-results" class="gs-results">${searchResultsHTML()}</div>
      </div>`;
  // Tableaux par semaine (7 jours chacun) ; sur la page Groupes : 3 semaines.
  const weeks = [];
  for (let i = 0; i < data.groupes.length; i += 7) weeks.push(data.groupes.slice(i, i + 7));
  const last = data.groupes[data.groupes.length - 1];
  const tables = weeks.map((w, i) => `<div class="g-week">
        ${weeks.length > 1 ? `<div class="g-week-title">${i === 0 ? 'Cette semaine' : i === 1 ? 'Semaine prochaine' : 'Dans 2 semaines'} <span class="wk">${dayHead(w[0])} → ${dayHead(w[w.length - 1])}</span></div>` : ''}
        ${groupTable(w)}
      </div>`).join('');
  const groupes = `<section class="board groupes">
      <h2>👥 Groupes</h2>
      ${addBar}
      ${searchBar}
      <div class="g-nav">
        <button class="btn btn-grey" id="g-prev">‹ Semaine précédente</button>
        <span class="g-range">${dayHead(data.groupes[0])} → ${dayHead(last)}</span>
        <button class="btn btn-grey" id="g-next">Semaine suivante ›</button>
        ${PAGE === 'groupes' ? '<a class="btn btn-grey" href="cuisine-groupes-pdf.html?print=1" target="_blank" rel="noopener" title="Tous les groupes des 30 prochains jours, prêts à imprimer">📄 PDF 30 jours</a>' : ''}
      </div>
      ${tables}
    </section>`;
  if (PAGE === 'menus') return menuSemaine + menuPro + menuSuiv;
  if (PAGE === 'groupes') return groupes;
  return menuSemaine + groupes + menuPro;
}

// --- Recherche de groupes ---
const PERS_RANGES = [
  ['', 'Convives : tous'],
  ['15-20', '15 à 20 convives'],
  ['20-30', '20 à 30 convives'],
  ['30-40', '30 à 40 convives'],
  ['40+', '40 convives ou plus'],
];
const gSearch = { nom: '', date: '', pers: '' };
let gSearchHits = null; // null = pas de recherche en cours

function persInRange(pers, range) {
  const n = parseInt(String(pers || '').replace(/[^\d]/g, ''), 10);
  if (!range) return true;
  if (isNaN(n)) return false;
  if (range === '40+') return n >= 40;
  const [lo, hi] = range.split('-').map(Number);
  return n >= lo && n <= hi;
}

async function runSearch() {
  const active = gSearch.nom.trim() || gSearch.date || gSearch.pers;
  if (!active) { gSearchHits = null; renderSearchResults(); return; }
  if (!recap) { try { recap = await fetch('api/menus/recap').then((r) => r.json()); } catch (e) { recap = { menus: [], groupes: [] }; } }
  const q = gSearch.nom.trim().toLowerCase();
  const hits = [];
  for (const e of recap.groupes) {
    if (gSearch.date && e.date !== gSearch.date) continue;
    parseGroups(e.value).forEach((g, i) => {
      if (q && !String(g.nom || '').toLowerCase().includes(q)) return;
      if (!persInRange(g.pers, gSearch.pers)) return;
      hits.push({ date: e.date, index: i, g });
    });
  }
  hits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.index - b.index)); // plus récents d'abord
  gSearchHits = hits.slice(0, 50);
  renderSearchResults();
}

function searchResultsHTML() {
  if (gSearchHits === null) return '';
  if (!gSearchHits.length) return '<div class="gs-empty">Aucun groupe trouvé.</div>';
  return gSearchHits.map((h) => `<button type="button" class="gs-hit${h.g.annule ? ' annule' : ''}" data-date="${h.date}" data-index="${h.index}">
      <span class="gs-date">${dayHead(h.date)}</span>
      <span class="gs-txt"><strong>${esc(h.g.nom || '(sans nom)')}</strong>${h.g.pers ? ` · ${esc(h.g.pers)} pers` : ''}${h.g.annule ? ' · <em>annulé</em>' : ''}</span>
    </button>`).join('') + (gSearchHits.length >= 50 ? '<div class="gs-empty">Affinez la recherche (50 premiers résultats).</div>' : '');
}

function renderSearchResults() {
  const box = document.getElementById('gs-results');
  if (!box) return;
  box.innerHTML = searchResultsHTML();
  box.querySelectorAll('.gs-hit').forEach((b) => b.addEventListener('click', async () => {
    // On charge la semaine de ce groupe (pour avoir sa case), puis on l'ouvre.
    await reloadGroupes(b.dataset.date);
    openGroup(b.dataset.date, parseInt(b.dataset.index, 10));
  }));
}

function bindSearch() {
  const nom = document.getElementById('gs-nom'); const date = document.getElementById('gs-date');
  const pers = document.getElementById('gs-pers'); const clear = document.getElementById('gs-clear');
  if (!nom) return;
  nom.addEventListener('input', () => { gSearch.nom = nom.value; runSearch(); });
  date.addEventListener('change', () => { gSearch.date = date.value; runSearch(); });
  pers.addEventListener('change', () => { gSearch.pers = pers.value; runSearch(); });
  clear.addEventListener('click', () => { gSearch.nom = ''; gSearch.date = ''; gSearch.pers = ''; nom.value = ''; date.value = ''; pers.value = ''; runSearch(); });
  renderSearchResults();
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
  content.querySelectorAll('.pin-chk').forEach((c) => c.addEventListener('change', () => savePin(c)));
  content.querySelectorAll('.g-item').forEach((b) => b.addEventListener('click', () => openGroup(b.dataset.date, parseInt(b.dataset.index, 10))));
  content.querySelectorAll('.g-add').forEach((b) => b.addEventListener('click', () => openGroup(b.dataset.date, null)));
  bindSearch();
  const newBtn = document.getElementById('g-newbtn');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      const d = (document.getElementById('g-newdate').value || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { alert('Choisissez une date.'); return; }
      openGroup(d, null);
    });
  }
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
  if (PAGE === 'groupes') start = mondayOfIso(start); // semaines entières lundi → dimanche
  try {
    data = await fetch(menusUrl(start)).then((r) => r.json());
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

// Épingle / désépingle une case (affichée ou non dans le bandeau aperçu).
async function savePin(c) {
  const date = c.dataset.date; const slot = c.dataset.slot; const pinned = c.checked;
  if (!data.pins) data.pins = {};
  if (!data.pins[date]) data.pins[date] = {};
  if (pinned) data.pins[date][slot] = 1; else delete data.pins[date][slot];
  try {
    await fetch('api/menus/pin', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, slot, pinned }) });
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
  recap = null; // la recherche relira les groupes à jour
  if (gSearchHits !== null) runSearch();
  // Groupe ajouté sur une date hors de la semaine affichée (bloc « Ajouter un
  // groupe ») : on déplace la fenêtre sur cette date pour le voir apparaître.
  if (Array.isArray(data.groupes) && !data.groupes.includes(date)) reloadGroupes(date);
}

ov.addEventListener('click', (e) => { if (e.target === ov) closeGroup(); });

load();

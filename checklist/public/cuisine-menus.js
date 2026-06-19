'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const DOW = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
function dayHead(iso) {
  const d = new Date(iso + 'T12:00:00');
  const [, m, dd] = iso.split('-');
  return `${DOW[d.getDay()]} ${dd}/${m}`;
}

// Intitulés « indélébiles » (fixes) des tableaux.
const MENU_ROWS = [['e1', 'Entrée 1'], ['e2', 'Entrée 2'], ['pj1', 'PJ 1'], ['pj2', 'PJ 2'], ['d1', 'Dessert 1'], ['d2', 'Dessert 2']];
const GROUP_ROWS = [['groupe', 'Groupe']];

const content = document.getElementById('content');
let data = { semaine: [], semainePro: [], groupes: [], cells: {} };

async function load() {
  try { data = await fetch('api/menus').then((r) => r.json()); }
  catch (e) { content.innerHTML = '<div class="empty">Impossible de charger les menus.</div>'; return; }
  if (!data.cells) data.cells = {};
  render();
}

function tableHTML(dates, rows) {
  const head = `<thead><tr><th class="lbl cnr"></th>${dates.map((d) => `<th>${dayHead(d)}</th>`).join('')}</tr></thead>`;
  const body = rows.map(([slot, label]) => {
    const tds = dates.map((d) => {
      const v = (data.cells[d] && data.cells[d][slot]) || '';
      return `<td><textarea rows="1" data-date="${d}" data-slot="${esc(slot)}">${esc(v)}</textarea></td>`;
    }).join('');
    return `<tr><td class="lbl">${esc(label)}</td>${tds}</tr>`;
  }).join('');
  return `<div class="veleda-wrap"><table class="veleda">${head}<tbody>${body}</tbody></table></div>`;
}

function render() {
  content.innerHTML = `
    <section class="board"><h2>📋 Menu — cette semaine</h2>${tableHTML(data.semaine, MENU_ROWS)}</section>
    <section class="board"><h2>📋 Menu — semaine prochaine</h2>${tableHTML(data.semainePro, MENU_ROWS)}</section>
    <section class="board groupes"><h2>👥 Groupes — semaine prochaine</h2>${tableHTML(data.groupes, GROUP_ROWS)}</section>`;
  content.querySelectorAll('textarea').forEach((t) => {
    autoGrow(t);
    t.addEventListener('input', () => autoGrow(t));
    t.addEventListener('change', () => save(t));
  });
}

function autoGrow(t) {
  const min = t.closest('.groupes') ? 92 : 46;
  t.style.height = 'auto';
  t.style.height = Math.max(min, t.scrollHeight) + 'px';
}

async function save(t) {
  const date = t.dataset.date;
  const slot = t.dataset.slot;
  const value = t.value.trim();
  // Cache local pour rester cohérent sans recharger.
  if (!data.cells[date]) data.cells[date] = {};
  if (value) data.cells[date][slot] = value; else delete data.cells[date][slot];
  try {
    await fetch('api/menus/cell', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, slot, value }),
    });
    t.classList.remove('saved-flash'); void t.offsetWidth; t.classList.add('saved-flash');
  } catch (e) { /* on garde la saisie locale, réessai au prochain changement */ }
}

load();

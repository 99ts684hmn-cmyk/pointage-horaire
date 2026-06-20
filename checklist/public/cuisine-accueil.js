'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const DOW = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
function dayHead(iso) {
  const d = new Date(iso + 'T12:00:00');
  const [, m, dd] = iso.split('-');
  return `${DOW[d.getDay()]} ${dd}/${m}`;
}

function menuLine(label, a, b) {
  const parts = [a, b].filter((v) => v && v.trim());
  return `<div class="ap-line"><span class="ap-lbl">${label}</span><span class="ap-v">${parts.length ? parts.map(esc).join(' · ') : '—'}</span></div>`;
}

async function load() {
  let d;
  try { d = await fetch('api/menus/apercu').then((r) => r.json()); }
  catch (e) { return; }
  const cells = d.menu || {};
  const grp = Array.isArray(d.groupes) ? d.groupes : [];

  document.getElementById('ap-groupes').innerHTML = grp.length
    ? grp.map((g) => `<div class="ap-line"><span class="ap-d">${dayHead(g.date)}</span><span class="ap-n">${esc(g.nom)}${g.pers ? ` · ${esc(g.pers)} pers` : ''}</span></div>`).join('')
    : '<div class="ap-empty">Aucun groupe à venir</div>';

  const mt = document.getElementById('ap-menu-title');
  if (mt) mt.textContent = d.menuNextWeek ? '📋 Menu de la semaine prochaine' : '📋 Menu de la semaine';

  const hasMenu = ['debut_entree', 'fin_entree', 'debut_pj', 'fin_pj', 'debut_dessert', 'fin_dessert'].some((k) => (cells[k] || '').trim());
  document.getElementById('ap-menu').innerHTML = hasMenu
    ? menuLine('Entrées', cells.debut_entree, cells.fin_entree)
      + menuLine('Plats', cells.debut_pj, cells.fin_pj)
      + menuLine('Desserts', cells.debut_dessert, cells.fin_dessert)
    : '<div class="ap-empty">Menu de la semaine non renseigné</div>';

  document.getElementById('apercu').hidden = false;
}

load();

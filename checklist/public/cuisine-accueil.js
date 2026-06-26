'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const DOW = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
function dayHead(iso) {
  const d = new Date(iso + 'T12:00:00');
  const [, m, dd] = iso.split('-');
  return `${DOW[d.getDay()]} ${dd}/${m}`;
}

function daysUntil(iso) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso + 'T00:00:00');
  return Math.round((d - today) / 86400000);
}
function whenInfo(iso) {
  const n = daysUntil(iso);
  if (n <= 0) return { txt: "aujourd'hui", soon: true };
  if (n === 1) return { txt: 'demain', soon: true };
  return { txt: `dans ${n} j`, soon: false };
}

function menuLine(label, a, b) {
  const parts = [a, b].filter((v) => v && v.trim());
  return `<div class="ap-line"><span class="ap-lbl">${label}</span><span class="ap-v">${parts.length ? parts.map(esc).join(' · ') : '—'}</span></div>`;
}

// Texte du menu prêt à coller dans un message.
function buildMenuText(cells, title) {
  const lines = [title];
  const add = (label, a, b) => { const p = [a, b].filter((v) => v && v.trim()); if (p.length) lines.push(`${label} : ${p.join(' · ')}`); };
  add('Entrées', cells.debut_entree, cells.fin_entree);
  add('Plats', cells.debut_pj, cells.fin_pj);
  add('Desserts', cells.debut_dessert, cells.fin_dessert);
  return lines.join('\n');
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); resolve();
    } catch (e) { reject(e); }
  });
}
// Rend la case « Menu » cliquable : copie le menu, prêt à coller dans un message.
function wireMenuCopy(cells, title, hasMenu) {
  const mt = document.getElementById('ap-menu-title');
  const col = document.getElementById('ap-menu').closest('.ap-col');
  if (!col || !hasMenu) return;
  col.style.cursor = 'pointer';
  col.title = 'Cliquer pour copier le menu (prêt à coller dans un message)';
  col.onclick = () => {
    copyText(buildMenuText(cells, title)).then(() => {
      if (mt) { mt.textContent = '✅ Menu copié !'; setTimeout(() => { mt.textContent = title; }, 1400); }
    }).catch(() => {});
  };
}

async function load() {
  let d;
  try { d = await fetch('api/menus/apercu').then((r) => r.json()); }
  catch (e) { return; }
  const cells = d.menu || {};
  const grp = Array.isArray(d.groupes) ? d.groupes : [];

  document.getElementById('ap-groupes').innerHTML = grp.length
    ? grp.map((g) => {
      const w = whenInfo(g.date);
      return `<div class="ap-line"><span class="ap-d">${dayHead(g.date)} <span class="ap-when${w.soon ? ' soon' : ''}">${w.txt}</span></span><span class="ap-n">${esc(g.nom)}${g.pers ? ` · ${esc(g.pers)} pers` : ''}</span></div>`;
    }).join('')
    : '<div class="ap-empty">Aucun groupe à venir</div>';

  const menuTitle = d.menuNextWeek ? '📋 Menu de la semaine prochaine' : '📋 Menu de la semaine';
  const mt = document.getElementById('ap-menu-title');
  if (mt) mt.textContent = menuTitle;

  const hasMenu = ['debut_entree', 'fin_entree', 'debut_pj', 'fin_pj', 'debut_dessert', 'fin_dessert'].some((k) => (cells[k] || '').trim());
  document.getElementById('ap-menu').innerHTML = hasMenu
    ? menuLine('Entrées', cells.debut_entree, cells.fin_entree)
      + menuLine('Plats', cells.debut_pj, cells.fin_pj)
      + menuLine('Desserts', cells.debut_dessert, cells.fin_dessert)
    : '<div class="ap-empty">Menu de la semaine non renseigné</div>';

  wireMenuCopy(cells, menuTitle, hasMenu);
  document.getElementById('apercu').hidden = false;
}

load();

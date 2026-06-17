'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const DAYS = [['1', 'Lun'], ['2', 'Mar'], ['3', 'Mer'], ['4', 'Jeu'], ['5', 'Ven'], ['6', 'Sam'], ['7', 'Dim']];

const content = document.getElementById('content');
let data = { rows: [] };

async function load() {
  try {
    data = await fetch('api/commandes').then((r) => r.json());
  } catch (e) {
    content.innerHTML = '<div class="empty">Impossible de charger la grille.</div>';
    return;
  }
  render();
}

function cellBtn(item, kind) {
  const cls = item.done ? 'done' : (kind === 'liv' ? 'todo liv' : 'todo');
  return `<button class="cellbtn ${cls}" data-cell="${esc(item.id)}">${esc(item.label)}</button>`;
}

function render() {
  if (!data.rows || !data.rows.length) {
    content.innerHTML = '<div class="empty">Aucun fournisseur. Ajoutez-en dans l\'Admin.</div>';
    return;
  }
  const head = `<thead><tr><th class="frn">Fournisseur</th>${DAYS.map((d) => `<th>${d[1]}</th>`).join('')}</tr></thead>`;
  const body = data.rows.map((r) => {
    const cells = DAYS.map((d) => {
      const c = r.cells[d[0]] || {};
      let inner = '';
      if (c.cmd) inner += cellBtn(c.cmd, 'cmd');
      if (c.liv) inner += cellBtn(c.liv, 'liv');
      if (!inner) inner = '<span class="cellbtn empty"></span>';
      return `<td class="cell">${inner}</td>`;
    }).join('');
    const frn = r.sublabel
      ? `<button class="frn-name" data-info="${esc(r.id)}"><span class="nm">${esc(r.label)}</span><span class="chev">▾</span></button><div class="sub" id="info-${esc(r.id)}" hidden>${esc(r.sublabel)}</div>`
      : `<div class="nm">${esc(r.label)}</div>`;
    return `<tr><td class="frn">${frn}</td>${cells}</tr>`;
  }).join('');
  content.innerHTML = `<div class="cmd-wrap"><table class="cmd">${head}<tbody>${body}</tbody></table></div>`;

  content.querySelectorAll('[data-cell]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.cell)));
  content.querySelectorAll('[data-info]').forEach((b) => b.addEventListener('click', () => {
    const info = document.getElementById('info-' + b.dataset.info);
    if (info) info.hidden = !info.hidden;
    b.classList.toggle('open');
  }));
}

async function toggle(cellId) {
  // Mise à jour optimiste : on bascule visuellement avant la réponse serveur.
  const r = await fetch(`api/commandes/cells/${encodeURIComponent(cellId)}/toggle`, { method: 'POST' }).then((x) => x.json()).catch(() => null);
  if (!r) return;
  // Recharge l'état (simple et fiable).
  await load();
}

load();

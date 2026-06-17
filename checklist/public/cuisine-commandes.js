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

function isLivraison(label) { return /livr/i.test(label || ''); }

function render() {
  if (!data.rows || !data.rows.length) {
    content.innerHTML = '<div class="empty">Aucun fournisseur. Ajoutez-en dans l\'Admin.</div>';
    return;
  }
  const head = `<thead><tr><th class="frn">Fournisseur</th>${DAYS.map((d) => `<th>${d[1]}</th>`).join('')}</tr></thead>`;
  const body = data.rows.map((r) => {
    const cells = DAYS.map((d) => {
      const c = r.cells[d[0]];
      if (!c) return '<td class="cell"><span class="cellbtn empty"></span></td>';
      const cls = c.done ? 'done' : (isLivraison(c.label) ? 'todo liv' : 'todo');
      return `<td class="cell"><button class="cellbtn ${cls}" data-cell="${esc(c.id)}">${esc(c.label)}</button></td>`;
    }).join('');
    return `<tr><td class="frn"><div class="nm">${esc(r.label)}</div>${r.sublabel ? `<div class="sub">${esc(r.sublabel)}</div>` : ''}</td>${cells}</tr>`;
  }).join('');
  content.innerHTML = `<div class="cmd-wrap"><table class="cmd">${head}<tbody>${body}</tbody></table></div>`;

  content.querySelectorAll('[data-cell]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.cell)));
}

async function toggle(cellId) {
  // Mise à jour optimiste : on bascule visuellement avant la réponse serveur.
  const r = await fetch(`api/commandes/cells/${encodeURIComponent(cellId)}/toggle`, { method: 'POST' }).then((x) => x.json()).catch(() => null);
  if (!r) return;
  // Recharge l'état (simple et fiable).
  await load();
}

load();

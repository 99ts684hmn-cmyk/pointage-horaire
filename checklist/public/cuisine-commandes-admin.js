'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const DAYS = [['1', 'Lun'], ['2', 'Mar'], ['3', 'Mer'], ['4', 'Jeu'], ['5', 'Ven'], ['6', 'Sam'], ['7', 'Dim']];
const PRESETS = ['CMD matin', 'CMD soir', 'CMD matin + soir', 'LIVRAISON', 'CMD + LIVRAISON'];
const AUTRE = '__autre__';

const content = document.getElementById('content');
let data = { rows: [] };

async function load() {
  try { data = await fetch('api/commandes').then((r) => r.json()); }
  catch (e) { content.innerHTML = '<div class="empty">Impossible de charger la grille.</div>'; return; }
  render();
}

function cellClass(label) {
  if (!label) return '';
  return /livr/i.test(label) && !/cmd/i.test(label) ? 'has-liv' : 'has-cmd';
}

function optionsFor(label) {
  const opts = [`<option value="">—</option>`];
  const presets = PRESETS.slice();
  if (label && !presets.includes(label)) presets.unshift(label); // conserve un libellé custom existant
  presets.forEach((p) => { opts.push(`<option value="${esc(p)}"${p === label ? ' selected' : ''}>${esc(p)}</option>`); });
  opts.push(`<option value="${AUTRE}">Autre…</option>`);
  return opts.join('');
}

function render() {
  const head = `<thead><tr><th>Fournisseur</th>${DAYS.map((d) => `<th>${d[1]}</th>`).join('')}</tr></thead>`;
  const body = data.rows.map((r) => {
    const cells = DAYS.map((d) => {
      const c = r.cells[d[0]];
      const label = c ? c.label : '';
      return `<td class="cell ${cellClass(label)}" data-cellwrap="${esc(r.id)}_${d[0]}">
        <select data-row="${esc(r.id)}" data-day="${d[0]}">${optionsFor(label)}</select>
      </td>`;
    }).join('');
    return `<tr>
      <td class="frn">
        <div class="nm">${esc(r.label)}</div>${r.sublabel ? `<div class="sub">${esc(r.sublabel)}</div>` : ''}
        <div class="acts"><button data-edit-row="${esc(r.id)}">Renommer</button><button data-del-row="${esc(r.id)}">Supprimer</button></div>
      </td>${cells}</tr>`;
  }).join('');

  content.innerHTML = `<div class="cmd-wrap"><table class="cmd">${head}<tbody>${body}</tbody></table></div>
    <div class="addbar">
      <input type="text" id="add-name" placeholder="Nouveau fournisseur…" style="flex:2;min-width:160px">
      <input type="text" id="add-sub" placeholder="Contact / note (optionnel)" style="flex:3;min-width:160px">
      <button class="btn btn-red" id="add-row">+ Ajouter</button>
    </div>`;

  content.querySelectorAll('select[data-row]').forEach((sel) => {
    sel.dataset.prev = sel.value;
    sel.addEventListener('change', () => onCellChange(sel));
  });
  content.querySelectorAll('[data-del-row]').forEach((b) => b.addEventListener('click', () => delRow(b.dataset.delRow)));
  content.querySelectorAll('[data-edit-row]').forEach((b) => b.addEventListener('click', () => editRow(b.dataset.editRow)));
  document.getElementById('add-row').addEventListener('click', addRow);
  document.getElementById('add-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addRow(); });
}

async function setCell(rowId, day, label) {
  await fetch('api/commandes/cell', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rowId, day, label }),
  });
  await load();
}

function onCellChange(sel) {
  let label = sel.value;
  if (label === AUTRE) {
    const v = (prompt('Libellé de la case :', '') || '').trim();
    if (!v) { sel.value = sel.dataset.prev || ''; return; }
    label = v;
  }
  setCell(sel.dataset.row, sel.dataset.day, label);
}

async function addRow() {
  const name = document.getElementById('add-name').value.trim();
  if (!name) return;
  const sublabel = document.getElementById('add-sub').value.trim();
  await fetch('api/commandes/rows', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: name, sublabel }),
  });
  await load();
}
async function delRow(id) {
  if (!confirm('Supprimer ce fournisseur ?\nSes cases sont retirées de la grille (réversible côté base).')) return;
  await fetch(`api/commandes/rows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await load();
}
async function editRow(id) {
  const row = data.rows.find((r) => r.id === id);
  if (!row) return;
  const label = (prompt('Nom du fournisseur :', row.label) || '').trim();
  if (!label) return;
  const sublabel = (prompt('Contact / note :', row.sublabel || '') || '').trim();
  await fetch(`api/commandes/rows/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, sublabel }),
  });
  await load();
}

load();

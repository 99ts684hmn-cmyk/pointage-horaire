'use strict';

function localISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function frDate(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function frDateTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const fromEl = document.getElementById('from');
const toEl = document.getElementById('to');
const typeEl = document.getElementById('type');
const content = document.getElementById('content');

// Périmètre optionnel : ?scope=salle (tout sauf cuisine) ou ?scope=cuisine.
const SCOPE = new URLSearchParams(location.search).get('scope') || '';
(function applyScope() {
  if (!SCOPE) return;
  const sub = document.querySelector('.page-sub');
  if (sub) sub.textContent = SCOPE === 'salle' ? 'Historique des check-lists — Salle' : 'Historique des check-lists — Cuisine';
})();

(function initDates() {
  const now = new Date();
  const from = new Date(); from.setDate(from.getDate() - 30);
  fromEl.value = localISO(from);
  toEl.value = localISO(now);
})();

async function load() {
  content.innerHTML = '<div class="loading pulse">Chargement…</div>';
  const p = new URLSearchParams();
  if (fromEl.value) p.set('from', fromEl.value);
  if (toEl.value) p.set('to', toEl.value);
  if (typeEl.value) p.set('type', typeEl.value);
  if (SCOPE) p.set('scope', SCOPE);

  let reports = [];
  try { reports = await fetch(`api/reports?${p}`).then((r) => r.json()); } catch (e) { reports = []; }
  if (!Array.isArray(reports)) reports = [];

  const done = reports.filter((r) => r.status === 'TERMINE');
  const prog = reports.filter((r) => r.status === 'EN_COURS');
  document.getElementById('st-total').textContent = reports.length;
  document.getElementById('st-done').textContent = done.length;
  document.getElementById('st-prog').textContent = prog.length;

  if (!reports.length) {
    content.innerHTML = '<div class="empty"><p style="font-size:2rem;margin:0 0 8px">📋</p>Aucun rapport pour cette période</div>';
    return;
  }

  content.innerHTML = `<div class="card tablecard"><div class="tbl-scroll"><table class="rep">
    <thead><tr><th>Date</th><th>Check-list</th><th>Statut</th><th>Effectuée par</th><th>Heure fin</th><th>Tâches</th></tr></thead>
    <tbody>${reports.map((e) => {
    const status = e.status === 'TERMINE'
      ? '<span class="pill done">✓ Terminé</span>'
      : '<span class="pill prog">En cours</span>';
    const by = e.status === 'TERMINE' ? `<span style="font-weight:600">${esc(e.completedBy)}</span>` : '<span style="color:var(--muted)">-</span>';
    const barColor = e.progress === 100 ? 'var(--green)' : 'var(--gold)';
    return `<tr class="rowlink" data-id="${esc(e.id)}">
      <td class="nowrap" style="font-weight:600">${frDate(e.date)}</td>
      <td><span>${esc(e.templateIcon)}</span> <span style="font-weight:600">${esc(e.templateName)}</span></td>
      <td>${status}</td>
      <td>${by}</td>
      <td class="nowrap" style="color:var(--muted)">${e.completedAt ? frDateTime(e.completedAt) : '-'}</td>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="bar on-light mini-bar"><i style="width:${e.progress}%;background:${barColor}"></i></div><span style="font-size:.72rem;color:var(--muted)">${e.doneTasks}/${e.totalTasks}</span></div></td>
    </tr>`;
  }).join('')}</tbody></table></div></div>`;

  // Clic sur une ligne → détail de la check-list (retour vers les rapports).
  content.querySelectorAll('tr.rowlink').forEach((tr) => {
    tr.addEventListener('click', () => {
      location.href = `session.html?id=${encodeURIComponent(tr.dataset.id)}&from=rapports${SCOPE ? '&scope=' + encodeURIComponent(SCOPE) : ''}`;
    });
  });
}

[fromEl, toEl, typeEl].forEach((el) => el.addEventListener('change', load));
load();

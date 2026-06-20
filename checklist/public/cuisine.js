'use strict';

function localToday() {
  // « Jour de service » : les check-lists basculent à 2h du matin, pas à minuit.
  // Avant 2h, on reste sur la date de la veille.
  const d = new Date();
  if (d.getHours() < 2) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function frDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function frTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const MODE_LABEL = {
  AUTO_DAILY: 'Reset auto quotidien',
  CARRY_OVER: 'Report des tâches non faites',
  MANUAL: 'Gestion manuelle',
};

let sessions = [];
// Catégorie affichée (défaut cuisine) et provenance pour le retour de session.
const CATEGORY = window.CL_CATEGORY || 'cuisine';
const FROM = window.CL_FROM || 'cuisine';

async function load() {
  const content = document.getElementById('content');
  try {
    const r = await fetch(`api/sessions?date=${localToday()}`);
    const all = await r.json();
    sessions = (Array.isArray(all) ? all : []).filter((s) => (s.category || 'general') === CATEGORY);
  } catch (e) {
    content.innerHTML = '<div class="empty">Impossible de charger les check-lists.</div>';
    return;
  }
  render();
}

function render() {
  const today = localToday();
  const content = document.getElementById('content');

  const totalDone = sessions.filter((s) => s.status === 'TERMINE').length;
  const totalAll = sessions.length;
  document.getElementById('subtitle').textContent = `${frDate(today)} — ${totalDone}/${totalAll} terminées`;

  const g = document.getElementById('global');
  const gpct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0;
  g.hidden = totalAll === 0;
  document.getElementById('global-pct').textContent = gpct + '%';
  const gbar = document.getElementById('global-bar');
  gbar.style.width = gpct + '%';
  gbar.style.background = (totalDone === totalAll && totalAll > 0) ? 'var(--green)' : 'var(--gold)';

  if (!sessions.length) {
    content.innerHTML = '<div class="empty">Aucune check-list cuisine.</div>';
    return;
  }

  // Sous-titre utile uniquement pour les hebdo (pas de jargon « Reset auto… »).
  const subFor = (s) => (s.resetMode === 'WEEKLY_CARRY_OVER' ? `Tâches du ${esc(s.todayLabel || '')}`
    : s.resetMode === 'WEEKLY_MONDAY' ? esc(s.todayLabel || '') : '');

  const cardTodo = (s) => {
    const sub = subFor(s);
    const remain = Math.max(0, s.totalTasks - s.doneTasks);
    const pill = s.progress === 0 ? '<span class="pill prog">À faire</span>' : '<span class="pill prog">En cours</span>';
    const barColor = s.progress > 60 ? 'var(--gold)' : 'var(--red)';
    const carried = s.carriedCount > 0
      ? `<p class="carried">↩ ${s.carriedCount} tâche${s.carriedCount > 1 ? 's' : ''} reportée${s.carriedCount > 1 ? 's' : ''}</p>` : '';
    const right = remain > 0 ? `reste ${remain}` : `${s.progress}%`;
    return `<a class="card clcard todo" href="session.html?id=${encodeURIComponent(s.id)}&from=${FROM}">
      <div class="head">
        <div class="l"><span class="icon">${esc(s.templateIcon)}</span>
          <div><h2>${esc(s.templateName)}</h2>${sub ? `<p class="mode">${sub}</p>` : ''}</div>
        </div>${pill}
      </div>
      <div class="meta"><span class="m">${s.doneTasks} / ${s.totalTasks} tâches</span><span class="p">${right}</span></div>
      <div class="bar on-light"><i style="width:${s.progress}%;background:${barColor}"></i></div>
      ${carried}
    </a>`;
  };

  const cardDone = (s) => {
    const by = s.completedBy ? `par ${esc(s.completedBy)} · ${frTime(s.completedAt)}` : '✓';
    return `<a class="clcard compact" href="session.html?id=${encodeURIComponent(s.id)}&from=${FROM}">
      <span class="cdone"><span class="icon">${esc(s.templateIcon)}</span> ${esc(s.templateName)}</span>
      <span class="cby">${by}</span>
    </a>`;
  };

  const todo = sessions.filter((s) => s.status !== 'TERMINE');
  const done = sessions.filter((s) => s.status === 'TERMINE');
  const banner = todo.length === 0 ? '<div class="alldone">✅ Tout est bouclé, bravo !</div>' : '';
  const todoHtml = todo.length ? `<div class="grid">${todo.map(cardTodo).join('')}</div>` : '';
  const doneHtml = done.length ? `<div class="donelist">${done.map(cardDone).join('')}</div>` : '';
  content.innerHTML = banner + todoHtml + doneHtml;
}

load();

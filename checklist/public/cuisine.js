'use strict';

function localToday() {
  const d = new Date();
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

async function load() {
  const content = document.getElementById('content');
  try {
    const r = await fetch(`api/sessions?date=${localToday()}`);
    const all = await r.json();
    sessions = (Array.isArray(all) ? all : []).filter((s) => (s.category || 'general') === 'cuisine');
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

  content.innerHTML = '<div class="grid">' + sessions.map((s) => {
    const modeTxt = s.resetMode === 'WEEKLY_CARRY_OVER' ? `Tâches du ${esc(s.todayLabel || '')}`
      : s.resetMode === 'WEEKLY_MONDAY' ? `Hebdo (lundi) — ${esc(s.todayLabel || '')}`
      : (MODE_LABEL[s.resetMode] || '');
    const barColor = s.status === 'TERMINE' ? 'var(--green)' : (s.progress > 60 ? 'var(--gold)' : 'var(--red)');
    const pill = s.status === 'TERMINE'
      ? '<span class="pill done">✓ Terminé</span>'
      : '<span class="pill prog">En cours</span>';
    const carried = (s.carriedCount > 0 && s.status !== 'TERMINE')
      ? `<p class="carried">↩ ${s.carriedCount} tâche${s.carriedCount > 1 ? 's' : ''} reportée${s.carriedCount > 1 ? 's' : ''}</p>` : '';
    const byline = (s.status === 'TERMINE' && s.completedBy)
      ? `<p class="byline">✓ Par ${esc(s.completedBy)} à ${frTime(s.completedAt)}</p>` : '';
    return `<a class="card clcard${s.status === 'TERMINE' ? ' done' : ''}" href="session.html?id=${encodeURIComponent(s.id)}">
      <div class="head">
        <div class="l"><span class="icon">${esc(s.templateIcon)}</span>
          <div><h2>${esc(s.templateName)}</h2><p class="mode">${modeTxt}</p></div>
        </div>${pill}
      </div>
      <div class="meta"><span class="m">${s.doneTasks}/${s.totalTasks} tâches</span><span class="p">${s.progress}%</span></div>
      <div class="bar on-light"><i style="width:${s.progress}%;background:${barColor}"></i></div>
      ${carried}${byline}
    </a>`;
  }).join('') + '</div>';
}

load();

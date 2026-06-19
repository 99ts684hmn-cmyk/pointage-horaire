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

let allSessions = [];
let tab = 'general'; // 'general' | 'manager' | 'bar'
const CAT_EMPTY = { general: 'Aucune check-list ici.', manager: 'Aucune check-list manager.', bar: 'Aucune check-list bar.' };

async function load() {
  const content = document.getElementById('content');
  try {
    const r = await fetch(`api/sessions?date=${localToday()}`);
    allSessions = await r.json();
    if (!Array.isArray(allSessions)) allSessions = [];
  } catch (e) {
    content.innerHTML = '<div class="empty">Impossible de charger les check-lists.</div>';
    return;
  }
  render();
}

function render() {
  const today = localToday();
  const content = document.getElementById('content');
  ['general', 'manager', 'bar'].forEach((t) => {
    const el = document.getElementById('tab-' + t);
    if (el) el.classList.toggle('active', tab === t);
  });

  const sessions = allSessions.filter((s) => (s.category || 'general') === tab);
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
    content.innerHTML = `<div class="empty">${CAT_EMPTY[tab] || 'Aucune check-list.'}</div>`;
    return;
  }

  // Regroupe les check-lists par service : Midi / Soir / Autres (selon le type).
  const blockOf = (s) => {
    const t = String(s.templateType || '').toUpperCase();
    if (t.includes('MIDI')) return 'midi';
    if (t.includes('SOIR')) return 'soir';
    return 'autre';
  };
  const groups = { midi: [], soir: [], autre: [] };
  sessions.forEach((s) => { groups[blockOf(s)].push(s); });
  const BLOCK_LABEL = { midi: '🌞 Midi', soir: '🌙 Soir', autre: 'Autres' };
  // Ordre selon l'heure : service du midi (8h→17h) → Midi en haut, Soir en bas ;
  // le reste du temps (17h→8h) → Soir en haut, Midi en bas. « Autres » au milieu.
  const h = new Date().getHours();
  const dayService = h >= 8 && h < 17;
  const order = dayService ? ['midi', 'autre', 'soir'] : ['soir', 'autre', 'midi'];
  const nonEmpty = order.filter((k) => groups[k].length);
  const showHeads = nonEmpty.length > 1; // une seule famille → pas d'en-tête.

  const card = (s) => {
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
  };

  content.innerHTML = nonEmpty.map((k) => {
    const head = showHeads ? `<h3 class="block-title">${BLOCK_LABEL[k]}</h3>` : '';
    return `<section class="block">${head}<div class="grid">${groups[k].map(card).join('')}</div></section>`;
  }).join('');
}

['general', 'manager', 'bar'].forEach((t) => {
  document.getElementById('tab-' + t).addEventListener('click', () => { tab = t; render(); });
});

load();

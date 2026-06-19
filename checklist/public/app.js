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
  ['general', 'manager'].forEach((t) => {
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

  // Sous-titre utile uniquement pour les check-lists hebdo (sinon rien : on évite
  // le jargon « Reset auto quotidien » qui ne sert pas au personnel).
  const subFor = (s) => (s.resetMode === 'WEEKLY_CARRY_OVER' ? `Tâches du ${esc(s.todayLabel || '')}`
    : s.resetMode === 'WEEKLY_MONDAY' ? esc(s.todayLabel || '') : '');

  // Carte « à faire » (en cours / pas commencée) : on met en avant ce qu'il reste.
  const cardTodo = (s) => {
    const sub = subFor(s);
    const remain = Math.max(0, s.totalTasks - s.doneTasks);
    const pill = s.progress === 0 ? '<span class="pill prog">À faire</span>' : '<span class="pill prog">En cours</span>';
    const barColor = s.progress > 60 ? 'var(--gold)' : 'var(--red)';
    const carried = s.carriedCount > 0
      ? `<p class="carried">↩ ${s.carriedCount} tâche${s.carriedCount > 1 ? 's' : ''} reportée${s.carriedCount > 1 ? 's' : ''}</p>` : '';
    const right = remain > 0 ? `reste ${remain}` : `${s.progress}%`;
    return `<a class="card clcard todo" href="session.html?id=${encodeURIComponent(s.id)}">
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

  // Check-list terminée : ligne compacte grisée, reléguée en bas du bloc.
  const cardDone = (s) => {
    const by = s.completedBy ? `par ${esc(s.completedBy)} · ${frTime(s.completedAt)}` : '✓';
    return `<a class="clcard compact" href="session.html?id=${encodeURIComponent(s.id)}">
      <span class="cdone"><span class="icon">${esc(s.templateIcon)}</span> ${esc(s.templateName)}</span>
      <span class="cby">${by}</span>
    </a>`;
  };

  content.innerHTML = nonEmpty.map((k) => {
    const list = groups[k];
    const todo = list.filter((s) => s.status !== 'TERMINE');
    const done = list.filter((s) => s.status === 'TERMINE');
    const head = showHeads
      ? `<h3 class="block-title"><span>${BLOCK_LABEL[k]}</span><span class="bcount">${done.length}/${list.length} faite${done.length > 1 ? 's' : ''}</span></h3>`
      : '';
    const todoHtml = todo.length ? `<div class="grid">${todo.map(cardTodo).join('')}</div>` : '';
    const doneHtml = done.length ? `<div class="donelist">${done.map(cardDone).join('')}</div>` : '';
    return `<section class="block">${head}${todoHtml}${doneHtml}</section>`;
  }).join('');
}

['general', 'manager'].forEach((t) => {
  document.getElementById('tab-' + t).addEventListener('click', () => { tab = t; render(); });
});

load();

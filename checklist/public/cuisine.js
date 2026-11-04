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

  // Blocs (ex. « Fermeture », « Ménage ») : les check-lists hors bloc d'abord,
  // puis chaque bloc dans l'ordre de sa première check-list. Les titres de bloc
  // n'apparaissent que s'il existe au moins un bloc.
  const groups = new Map([['', []]]);
  for (const s of sessions) {
    const k = s.templateGroup || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const showHeads = [...groups.keys()].some((k) => k !== '');
  const banner = sessions.every((s) => s.status === 'TERMINE') ? '<div class="alldone">✅ Tout est bouclé, bravo !</div>' : '';
  content.innerHTML = banner + [...groups.entries()].filter(([, list]) => list.length).map(([k, list]) => {
    const todo = list.filter((s) => s.status !== 'TERMINE');
    const done = list.filter((s) => s.status === 'TERMINE');
    const head = (showHeads && k)
      ? `<h3 class="block-title"><span>${esc(k)}</span><span class="bcount">${done.length}/${list.length} faite${done.length > 1 ? 's' : ''}</span></h3>`
      : '';
    const todoHtml = todo.length ? `<div class="grid">${todo.map(cardTodo).join('')}</div>` : '';
    const doneHtml = done.length ? `<div class="donelist">${done.map(cardDone).join('')}</div>` : '';
    return `<section class="block">${head}${todoHtml}${doneHtml}</section>`;
  }).join('');
  renderMenageBox();
}

// Cartouche « Ménage du jour » : les 5 premières tâches de ménage restantes,
// dans l'ordre de la check-list (les reportées en rouge). Cliquer ouvre la liste.
async function renderMenageBox() {
  const box = document.getElementById('menage-box');
  if (!box) return;
  const s = sessions.find((x) => x.templateType === 'CUISINE_MENAGE_HEBDO');
  if (!s) { box.hidden = true; return; }
  let tasks = [];
  try {
    const d = await fetch(`api/sessions/${encodeURIComponent(s.id)}`).then((r) => r.json());
    tasks = Array.isArray(d.tasks) ? d.tasks : [];
  } catch (e) { box.hidden = true; return; }
  const todo = tasks.filter((t) => !t.isDone);
  const link = `session.html?id=${encodeURIComponent(s.id)}&from=${FROM}`;
  if (!tasks.length) { box.hidden = true; return; } // liste vide ≠ terminée
  if (!todo.length) {
    box.className = 'menage-box done';
    // Tout est coché : la finalisation (nom + animation) se fait sur la liste.
    box.innerHTML = `<div class="mh"><span>🧽 ${esc(s.templateName)}</span><span class="mc">✅ tout est fait</span></div>
      ${s.status === 'TERMINE' ? '' : `<a class="more" href="${link}">Finaliser la liste →</a>`}`;
  } else {
    const first = todo.slice(0, 5);
    const rest = todo.length - first.length;
    box.className = 'menage-box';
    box.innerHTML = `<div class="mh"><span>🧽 ${esc(s.templateName)} — à faire</span><span class="mc">${tasks.length - todo.length}/${tasks.length} faites</span></div>
      ${first.map((t) => `<button type="button" class="mt${t.isCarriedOver ? ' carried' : ''}" data-task="${esc(t.id)}" title="Marquer comme faite"><span class="cb"></span><span>${esc(t.title)}${t.isCarriedOver ? ' <small>↩ reporté</small>' : ''}</span></button>`).join('')}
      <a class="more" href="${link}">${rest > 0 ? `+ ${rest} autre${rest > 1 ? 's' : ''} tâche${rest > 1 ? 's' : ''} → ouvrir la liste` : 'Ouvrir la liste →'}</a>`;
    // Un appui coche la tâche (même action que sur la page de la liste), puis
    // le cartouche se recharge : la tâche suivante prend la place.
    box.querySelectorAll('.mt').forEach((b) => b.addEventListener('click', async () => {
      b.classList.add('busy');
      b.querySelector('.cb').textContent = '✓';
      b.querySelector('.cb').style.background = 'var(--green)';
      b.querySelector('.cb').style.borderColor = 'var(--green)';
      try {
        await fetch(`api/sessions/${encodeURIComponent(s.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'toggle_task', taskId: b.dataset.task, isDone: true }),
        });
      } catch (e) { /* le rechargement ci-dessous remettra l'état réel */ }
      load();
    }));
  }
  box.hidden = false;
}

// Mise à jour automatique : toutes les 15 s, et dès qu'on revient sur la page
// (retour depuis une check-list, écran rallumé), pour que le cartouche suive
// l'avancement des coches faites sur les autres écrans.
setInterval(() => { if (!document.hidden) load(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) load(); });

load();

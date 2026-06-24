'use strict';

function frDate(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function frTime(iso) { if (!iso) return '-'; return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const params = new URLSearchParams(location.search);
const sessionId = params.get('id');
// « Retour » dépend de la provenance : cuisine, rapports, ou (défaut) salle.
const from = params.get('from');
// Sélecteur de clôture : salle = salariés pointage ; cuisine = cuisiniers du planning cuisine.
const STAFF_URL = (from === 'cuisine' || from === 'resp') ? '/cuisine/api/cooks' : '/api/employees';
if (from === 'cuisine') {
  const back = document.getElementById('back-link');
  const navList = document.getElementById('nav-list');
  const navAdmin = document.getElementById('nav-admin');
  if (back) back.href = 'cuisine.html';
  if (navList) navList.href = 'cuisine.html';
  if (navAdmin) navAdmin.href = 'cuisine-admin-accueil.html';
} else if (from === 'resp') {
  const back = document.getElementById('back-link');
  const navList = document.getElementById('nav-list');
  const navAdmin = document.getElementById('nav-admin');
  if (back) back.href = 'resp-cuisine.html';
  if (navList) navList.href = 'resp-cuisine.html';
  if (navAdmin) navAdmin.href = 'resp-cuisine-admin.html';
} else if (from === 'rapports') {
  const back = document.getElementById('back-link');
  const scope = params.get('scope');
  if (back) back.href = 'rapports.html' + (scope ? `?scope=${encodeURIComponent(scope)}` : '');
}
const content = document.getElementById('content');
const overlay = document.getElementById('overlay');
const modal = document.getElementById('modal');
let session = null;
let employees = [];
let selectedEmp = '';
let customName = '';

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff8f0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';

async function fetchSession() {
  const r = await fetch(`api/sessions/${encodeURIComponent(sessionId)}`);
  if (!r.ok) { content.innerHTML = '<div class="empty">Session introuvable.</div>'; return; }
  session = await r.json();
  render();
}

async function toggleTask(taskId, isDone) {
  const t = session.tasks.find((x) => x.id === taskId);
  if (t) { t.isDone = isDone; t.doneAt = isDone ? new Date().toISOString() : null; }
  render();
  // Dernière tâche cochée → on propose directement la clôture (choix du nom),
  // sans avoir à taper « Finaliser ».
  const allDone = session.tasks.length > 0 && session.tasks.every((x) => x.isDone);
  if (isDone && allDone && session.status !== 'TERMINE') openFinalize();
  await fetch(`api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'toggle_task', taskId, isDone }),
  });
}

async function reopen() {
  await fetch(`api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reopen' }),
  });
  fetchSession();
}

async function finalize() {
  const name = selectedEmp || customName.trim();
  if (!name) return;
  await fetch(`api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', completedBy: name }),
  });
  overlay.classList.remove('show');
  celebrate(name);
  fetchSession();
}

// Blagues façon Carambar, tirées au sort à la validation.
const JOKES = [
  'Quel est le comble pour un électricien ? Ne pas être au courant !',
  'Pourquoi le café est-il un mauvais élève ? Il se fait toujours repasser !',
  'Quel poisson ne fête jamais son anniversaire ? Le poisson pané !',
  'Quel est le comble pour un jardinier ? Raconter des salades !',
  'Que fait une fraise sur un cheval ? Tagada, tagada !',
  'Qu\'est-ce qui est jaune et qui attend ? Jonathan !',
  'Quel est le comble pour un cuisinier ? Avoir un poil dans la main !',
  'Pourquoi les plongeurs plongent-ils en arrière ? Sinon ils tombent dans le bateau !',
  'Que dit une maman tomate à son petit qui traîne ? Dépêche-toi, tu vas finir en pizza !',
  'Quel est le comble pour un boucher ? Avoir un caractère de cochon !',
  'Pourquoi les vaches ferment-elles les yeux quand on les trait ? Pour faire du lait concentré !',
  'Monsieur et Madame Térieur ont un fils. Comment s\'appelle-t-il ? Alain ! (Alain Térieur)',
  'Comment appelle-t-on un chien sans pattes ? On ne l\'appelle pas, on va le chercher !',
  'Quel est le sport le plus fruité ? La boxe : on y prend des pêches !',
  'Que dit un oignon quand il se cogne ? Ail ail ail !',
  'Quelle est la femelle du hamster ? L\'Amsterdam !',
];

// Petite animation de fête (confettis + emojis cuisine + blague) à la validation.
// Pure vanilla, sans dépendance, retirée toute seule après ~4,2 s.
function celebrate(name) {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) { /* ignore */ }
  const layer = document.createElement('div');
  layer.className = 'celebrate-layer';
  const colors = ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#ff8fab', '#8ecae6', '#ffd166'];
  for (let i = 0; i < 40; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = (Math.random() * 100) + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = (1.6 + Math.random() * 1.3) + 's';
    c.style.animationDelay = (Math.random() * 0.6) + 's';
    layer.appendChild(c);
  }
  const emojis = ['🥩', '🔥', '🍔', '👨‍🍳', '🎉', '👏', '🧑‍🍳', '✅', '🍟', '⭐'];
  for (let i = 0; i < emojis.length; i++) {
    const e = document.createElement('span');
    e.className = 'cele-emoji';
    e.textContent = emojis[i];
    const ang = (i / emojis.length) * Math.PI * 2;
    const dist = 150 + Math.random() * 60;
    e.style.setProperty('--dx', (Math.cos(ang) * dist) + 'px');
    e.style.setProperty('--dy', (Math.sin(ang) * dist - 30) + 'px');
    e.style.setProperty('--rot', (Math.random() * 160 - 80) + 'deg');
    e.style.animationDelay = (0.04 * i) + 's';
    layer.appendChild(e);
  }
  const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
  const b = document.createElement('div');
  b.className = 'cele-bravo';
  b.innerHTML = `<div class="cele-bravo-title">${name ? 'Bravo ' + esc(name) + ' ! 🎉' : 'Bravo ! 🎉'}</div>`
    + `<div class="cele-joke">${esc(joke)}</div>`;
  layer.appendChild(b);
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 4200);
}

function render() {
  const done = session.tasks.filter((t) => t.isDone).length;
  const total = session.tasks.length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const allDone = done === total && total > 0;
  const ro = session.status === 'TERMINE';
  const progressColor = (ro || progress === 100) ? 'var(--green)' : (progress >= 50 ? 'var(--gold)' : 'var(--red)');

  const statusBox = ro
    ? `<div style="text-align:right">
         <span class="pill done" style="display:inline-block;margin-bottom:4px">✓ Terminé</span>
         ${session.completedBy ? `<p style="font-size:.72rem;color:var(--green);margin:0">Par ${esc(session.completedBy)} à ${frTime(session.completedAt)}</p>` : ''}
       </div>`
    : '<span class="pill prog">En cours</span>';

  // Les tâches cochées descendent en bas (les tâches à faire restent en haut,
  // dans leur ordre). Tri stable : non-faites d'abord, puis faites.
  const ordered = [...session.tasks.filter((t) => !t.isDone), ...session.tasks.filter((t) => t.isDone)];
  const tasksHtml = ordered.map((t, i) => {
    const cls = 'task' + (t.isDone ? ' done' : (t.isCarriedOver ? ' carried' : '')) + (ro ? ' ro' : '');
    const tag = (t.isCarriedOver && !t.isDone) ? `<span class="tagc">↩ Reporté (${esc(t.dayLabel || '')})</span>` : '';
    const at = (t.isDone && t.doneAt) ? `<p class="at">Fait à ${frTime(t.doneAt)}</p>` : '';
    return `<div class="${cls}" data-id="${esc(t.id)}">
      <div class="chk">${t.isDone ? CHECK_SVG : ''}</div>
      <div class="body"><span class="title">${esc(t.title)}</span>${tag}${at}</div>
    </div>`;
  }).join('');

  const action = ro
    ? '<button class="btn btn-grey btn-block" id="reopen">Réouvrir la check-list</button>'
    : `<button class="btn btn-red btn-block" id="finalize"${allDone ? '' : ' disabled'}>${allDone ? '✓ Finaliser la check-list' : `Encore ${total - done} tâche(s) à faire`}</button>`;

  content.innerHTML = `
    <div class="card shead">
      <div class="top">
        <div class="l"><span class="icon">${esc(session.templateIcon)}</span>
          <div><h1>${esc(session.templateName)}</h1><p class="date">${frDate(session.date)}</p></div>
        </div>${statusBox}
      </div>
      <div style="margin-top:16px">
        <div class="meta" style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:5px;color:var(--muted)">
          <span>${done}/${total} tâches effectuées</span><span style="font-weight:700;color:var(--dark)">${progress}%</span>
        </div>
        <div class="bar on-light"><i style="width:${progress}%;background:${progressColor}"></i></div>
      </div>
    </div>
    <div class="card tasklist">${tasksHtml}</div>
    <div>${action}</div>`;

  if (!ro) {
    content.querySelectorAll('.task').forEach((el) => {
      el.addEventListener('click', () => {
        const t = session.tasks.find((x) => x.id === el.dataset.id);
        if (t) toggleTask(t.id, !t.isDone);
      });
    });
    const fb = document.getElementById('finalize');
    if (fb && allDone) fb.addEventListener('click', openFinalize);
  } else {
    document.getElementById('reopen').addEventListener('click', reopen);
  }
}

function openFinalize() {
  selectedEmp = ''; customName = '';
  renderModal();
  overlay.classList.add('show');
}
function renderModal() {
  const name = selectedEmp || customName.trim();
  modal.innerHTML = `
    <h2>Finaliser</h2>
    <p class="q">Qui a effectué cette check-list ?</p>
    <div id="emp-list">${employees.map((e) => `<button class="emp-opt${selectedEmp === e.name ? ' sel' : ''}" data-name="${esc(e.name)}">${esc(e.name)}</button>`).join('')}</div>
    <div style="margin:6px 0 4px"><input type="text" id="custom" placeholder="Ou entrer un nom manuellement…" value="${esc(customName)}"></div>
    <div class="actions">
      <button class="btn btn-grey" style="flex:1" id="cancel">Annuler</button>
      <button class="btn btn-red" style="flex:1" id="confirm"${name ? '' : ' disabled'}>Confirmer</button>
    </div>`;
  modal.querySelectorAll('.emp-opt').forEach((b) => b.addEventListener('click', () => {
    selectedEmp = b.dataset.name; customName = ''; renderModal();
  }));
  const ci = modal.querySelector('#custom');
  ci.addEventListener('input', () => { customName = ci.value; selectedEmp = ''; updateConfirm(); });
  modal.querySelector('#cancel').addEventListener('click', () => overlay.classList.remove('show'));
  modal.querySelector('#confirm').addEventListener('click', finalize);
}
function updateConfirm() {
  const name = selectedEmp || customName.trim();
  const c = modal.querySelector('#confirm');
  if (c) c.disabled = !name;
}

overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('show'); });

if (!sessionId) {
  content.innerHTML = '<div class="empty">Aucune check-list indiquée.</div>';
} else {
  // Personnel proposé à la clôture : salle = salariés pointage, cuisine = cuisiniers du planning cuisine.
  fetch(STAFF_URL).then((r) => r.json()).then((e) => { employees = Array.isArray(e) ? e : []; }).catch(() => {});
  fetchSession();
}

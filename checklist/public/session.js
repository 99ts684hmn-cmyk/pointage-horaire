'use strict';

function frDate(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function frTime(iso) { if (!iso) return '-'; return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const sessionId = new URLSearchParams(location.search).get('id');
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
  fetchSession();
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

  const tasksHtml = session.tasks.map((t, i) => {
    const cls = 'task' + (t.isDone ? ' done' : (t.isCarriedOver ? ' carried' : '')) + (ro ? ' ro' : '');
    const tag = (t.isCarriedOver && !t.isDone) ? `<span class="tagc">↩ Reporté (${esc(t.dayLabel || '')})</span>` : '';
    const at = (t.isDone && t.doneAt) ? `<p class="at">Fait à ${frTime(t.doneAt)}</p>` : '';
    return `<div class="${cls}" data-id="${esc(t.id)}">
      <div class="chk">${t.isDone ? CHECK_SVG : ''}</div>
      <div class="body"><span class="title">${i + 1}. ${esc(t.title)}</span>${tag}${at}</div>
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
  fetch('api/employees').then((r) => r.json()).then((e) => { employees = Array.isArray(e) ? e : []; }).catch(() => {});
  fetchSession();
}

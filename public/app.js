'use strict';

// --- Horloge --------------------------------------------------------------
function tickClock() {
  const now = new Date();
  document.getElementById('clock-time').textContent =
    now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('clock-date').textContent =
    now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
tickClock();
setInterval(tickClock, 1000);

// --- Utils ----------------------------------------------------------------
function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}
function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function dateISOfromTs(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hmFromTs(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// Jour ouvré : coupure à 5h du matin (la nuit est rattachée à la veille).
function businessDayOf(ts) {
  const d = new Date(ts - 5 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- Chargement des employés ---------------------------------------------
const CATEGORY_LABELS = { responsable: 'Responsables', chef_de_rang: 'Chefs de rang', apprenti: 'Apprentis' };
const CATEGORY_ORDER = ['responsable', 'chef_de_rang', 'apprenti'];

async function loadEmployees() {
  const grid = document.getElementById('employees');
  try {
    const res = await fetch('/api/employees');
    const employees = await res.json();
    grid.className = '';
    if (!employees.length) {
      grid.innerHTML = '<div class="empty" style="color:#cbd5e1">Aucun employé. Rendez-vous dans l\'Administration pour en ajouter.</div>';
      return;
    }
    grid.innerHTML = '';
    for (const cat of CATEGORY_ORDER) {
      const list = employees.filter((e) => (CATEGORY_ORDER.includes(e.category) ? e.category : 'chef_de_rang') === cat);
      if (!list.length) continue;
      const section = document.createElement('div');
      section.className = 'emp-section';
      section.innerHTML = `<div class="section-title">${CATEGORY_LABELS[cat]}</div>`;
      const g = document.createElement('div');
      g.className = 'employees-grid';
      for (const emp of list) g.appendChild(buildCard(emp));
      section.appendChild(g);
      grid.appendChild(section);
    }
  } catch {
    grid.innerHTML = '<div class="empty" style="color:#fca5a5">Impossible de contacter le serveur.</div>';
  }
}

function buildCard(emp) {
  const card = document.createElement('button');
  const hasToday = emp.todaySeconds > 0;
  const statusText = hasToday ? "Aujourd'hui : " + fmtDuration(emp.todaySeconds) : 'Saisir mon départ';
  card.className = 'emp-card' + (hasToday ? ' is-working' : '');
  card.innerHTML = `
    <div class="avatar">${initials(emp.name)}</div>
    <div class="name">${escapeHtml(emp.name)}</div>
    <div class="status">
      <span class="dot ${hasToday ? 'on' : ''}"></span>
      ${statusText}
    </div>`;
  card.addEventListener('click', () => openModal(emp));
  return card;
}

// --- Modale ---------------------------------------------------------------
const overlay = document.getElementById('overlay');
const modal = document.getElementById('modal');
let pin = ''; // conservé pour compatibilité serveur (PIN désactivé)
let currentEmp = null;

function closeModal() {
  overlay.classList.remove('show');
  currentEmp = null;
}
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (overlay.classList.contains('show') && e.key === 'Escape') closeModal();
});

function openModal(emp) {
  currentEmp = emp;
  overlay.classList.add('show');
  openDepartureForm();
}

function showActionError(msg) {
  const el = document.getElementById('modal-msg');
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

// --- Saisie de l'heure de départ (jour ouvré en cours) --------------------
// Heures de départ autorisées : midi 13h–17h, soir 20h–02h ; minutes par quart.
const DEP_HOURS = [
  { grp: 'Midi', hours: ['13', '14', '15', '16', '17'] },
  { grp: 'Soir', hours: ['20', '21', '22', '23', '00', '01', '02'] },
];
const DEP_MINUTES = ['00', '15', '30', '45'];

function hourSelectHtml(id) {
  const opts = DEP_HOURS.map((g) =>
    `<optgroup label="${g.grp}">${g.hours.map((h) => `<option value="${h}">${h}h</option>`).join('')}</optgroup>`
  ).join('');
  return `<select class="dep-hour" data-id="${id}"><option value="" selected disabled>– h –</option>${opts}</select>`;
}
function minSelectHtml(id) {
  const opts = DEP_MINUTES.map((m) => `<option value="${m}">${m}</option>`).join('');
  return `<select class="dep-min" data-id="${id}"><option value="" selected disabled>– min –</option>${opts}</select>`;
}

async function openDepartureForm() {
  modal.innerHTML = `<h2>${escapeHtml(currentEmp.name)}</h2><div class="sub">Chargement…</div>`;
  try {
    const res = await fetch('/api/my-entries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmp.id, pin }),
    });
    const data = await res.json();
    if (!res.ok) { showActionError(data.error || 'Erreur'); return; }
    const curBiz = businessDayOf(Date.now());
    const open = data.entries.filter((e) => e.open && businessDayOf(e.clockIn) === curBiz);
    renderDepartureForm(open);
  } catch {
    showActionError('Erreur de connexion au serveur.');
  }
}

function renderDepartureForm(openEntries) {
  let body;
  if (!openEntries.length) {
    body = `<div class="sub" style="margin-top:10px">Aucune arrivée à clôturer aujourd'hui.<br>
      Les heures d'arrivée sont saisies par le responsable dans le planning.</div>`;
  } else {
    body = openEntries.map((e) => `
      <div class="dep-row">
        <div class="dep-info">Arrivée <strong>${hmFromTs(e.clockIn)}</strong> &nbsp;→&nbsp; départ :</div>
        <div class="dep-pickers">
          ${hourSelectHtml(e.id)}
          ${minSelectHtml(e.id)}
          <button class="btn btn-red dep-save" data-id="${e.id}"
                  data-start="${hmFromTs(e.clockIn)}" data-date="${dateISOfromTs(e.clockIn)}">Valider</button>
        </div>
      </div>`).join('');
  }
  modal.innerHTML = `
    <h2>${escapeHtml(currentEmp.name)}</h2>
    <div class="sub">Saisie de l'heure de départ — aujourd'hui</div>
    ${body}
    <div class="msg error" id="modal-msg"></div>
    <div style="margin-top:14px"><button class="btn btn-ghost" id="dep-back">Fermer</button></div>
  `;
  modal.querySelectorAll('.dep-save').forEach((b) => b.addEventListener('click', () => saveDeparture(b)));
  document.getElementById('dep-back').addEventListener('click', closeModal);
}

async function saveDeparture(btn) {
  const id = btn.dataset.id;
  const h = modal.querySelector(`.dep-hour[data-id="${id}"]`).value;
  const m = modal.querySelector(`.dep-min[data-id="${id}"]`).value;
  if (!h || !m) return showActionError("Choisissez l'heure et les minutes du départ.");
  const end = `${h}:${m}`;
  try {
    const res = await fetch(`/api/my-entries/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmp.id, pin, date: btn.dataset.date, start: btn.dataset.start, end }),
    });
    const data = await res.json();
    if (!res.ok) { showActionError(data.error || 'Erreur'); return; }
    loadEmployees();
    openDepartureForm(); // la période clôturée disparaît
  } catch {
    showActionError('Erreur de connexion au serveur.');
  }
}

// --- Nom de l'établissement (si plusieurs sites) --------------------------
async function applyEstablishment() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.establishment) document.title = cfg.establishment + ' — Saisie des départs';
  } catch { /* ignore */ }
}

// --- Init -----------------------------------------------------------------
applyEstablishment();
loadEmployees();
setInterval(loadEmployees, 30000);

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

const SERVICE_LABEL = { midi: 'midi', soir: 'soir' };
const SERVICE_HOURS = {
  midi: ['13', '14', '15', '16', '17'],
  soir: ['20', '21', '22', '23', '00', '01', '02'],
};
const DEP_MINUTES = ['00', '15', '30', '45'];

// --- État + chargement des présents du jour -------------------------------
let openEntries = [];
let currentService = (new Date().getHours() >= 17) ? 'soir' : 'midi';
let currentEntry = null;

async function loadOpenEntries() {
  try {
    const res = await fetch('/api/open-entries');
    openEntries = await res.json();
  } catch {
    openEntries = [];
  }
  renderPage();
}

function renderPage() {
  const root = document.getElementById('employees');
  root.className = '';
  const counts = { midi: 0, soir: 0 };
  openEntries.forEach((e) => { counts[e.service] = (counts[e.service] || 0) + 1; });
  const list = openEntries
    .filter((e) => e.service === currentService)
    .sort((a, b) => a.clockIn - b.clockIn);

  const tab = (svc, icon, label) => `
    <button class="svc-tab ${currentService === svc ? 'active' : ''}" data-svc="${svc}">
      ${icon} Saisir départ ${label}${counts[svc] ? ` <span class="svc-count">${counts[svc]}</span>` : ''}
    </button>`;

  const tabs = `<div class="svc-tabs">${tab('midi', '🌞', 'midi')}${tab('soir', '🌙', 'soir')}</div>`;

  let grid;
  if (!list.length) {
    grid = `<div class="empty" style="color:#cbd5e1;margin-top:24px">
      Aucun salarié à pointer pour le service du ${SERVICE_LABEL[currentService]}.<br>
      <span style="font-size:.85rem">Les arrivées sont saisies par le responsable dans le planning.</span>
    </div>`;
  } else {
    grid = `<div class="employees-grid" style="margin-top:18px">${list.map(cardHtml).join('')}</div>`;
  }

  root.innerHTML = tabs + grid;
  root.querySelectorAll('.svc-tab').forEach((b) =>
    b.addEventListener('click', () => { currentService = b.dataset.svc; renderPage(); }));
  root.querySelectorAll('.emp-card').forEach((c) =>
    c.addEventListener('click', () => {
      const e = openEntries.find((x) => String(x.entryId) === c.dataset.entry);
      if (e) openDepartureModal(e);
    }));
}

function cardHtml(e) {
  return `<button class="emp-card is-working" data-entry="${e.entryId}">
    <div class="avatar">${initials(e.name)}</div>
    <div class="name">${escapeHtml(e.name)}</div>
    <div class="status"><span class="dot on"></span>Arrivée ${hmFromTs(e.clockIn)}</div>
  </button>`;
}

// --- Modale de saisie du départ ------------------------------------------
const overlay = document.getElementById('overlay');
const modal = document.getElementById('modal');

function closeModal() {
  overlay.classList.remove('show');
  currentEntry = null;
}
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (overlay.classList.contains('show') && e.key === 'Escape') closeModal();
});

function showActionError(msg) {
  const el = document.getElementById('modal-msg');
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

function openDepartureModal(e) {
  currentEntry = e;
  const hourOpts = SERVICE_HOURS[e.service].map((h) => `<option value="${h}">${h}h</option>`).join('');
  const minOpts = DEP_MINUTES.map((m) => `<option value="${m}">${m}</option>`).join('');
  modal.innerHTML = `
    <h2>${escapeHtml(e.name)}</h2>
    <div class="sub">Départ du ${SERVICE_LABEL[e.service]} — arrivée ${hmFromTs(e.clockIn)}</div>
    <div class="dep-pickers" style="margin-top:18px;justify-content:center">
      <select id="dep-hour"><option value="" selected>– h –</option>${hourOpts}</select>
      <select id="dep-min"><option value="" selected>– min –</option>${minOpts}</select>
    </div>
    <div class="msg error" id="modal-msg"></div>
    <div class="action-buttons" style="margin-top:18px;grid-template-columns:1fr 1fr">
      <button class="btn btn-red" id="dep-save">Valider le départ</button>
      <button class="btn btn-ghost" id="dep-cancel">Annuler</button>
    </div>`;
  modal.querySelector('#dep-save').addEventListener('click', saveDeparture);
  modal.querySelector('#dep-cancel').addEventListener('click', closeModal);
  overlay.classList.add('show');
}

async function saveDeparture() {
  const e = currentEntry;
  if (!e) return;
  const h = document.getElementById('dep-hour').value;
  const m = document.getElementById('dep-min').value;
  if (!h || !m) return showActionError("Choisissez l'heure et les minutes du départ.");
  const end = `${h}:${m}`;
  try {
    const res = await fetch(`/api/my-entries/${e.entryId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: e.employeeId, pin: '', date: dateISOfromTs(e.clockIn), start: hmFromTs(e.clockIn), end }),
    });
    const data = await res.json();
    if (!res.ok) { showActionError(data.error || 'Erreur'); return; }
    closeModal();
    loadOpenEntries();
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

// --- Planning de la semaine (lecture seule) -------------------------------
function pvLocalISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function pvFrDate(iso) {
  const dt = new Date(iso + 'T12:00:00');
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
}
// Lundi de la semaine en cours (base immuable). Navigation bornée : ±2 semaines.
const pvBaseMonday = (() => {
  const d = new Date(); const dow = d.getDay(); const back = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - back); d.setHours(0, 0, 0, 0); return d;
})();
let pvOffset = 0;
const PV_MIN = -2; const PV_MAX = 2;
let pvLastSig = null; // signature du dernier rendu, pour ne re-render que si ça a changé

async function loadPlanningView() {
  const out = document.getElementById('pv-output');
  if (!out || !window.PlanningView) return;
  const monday = new Date(pvBaseMonday); monday.setDate(monday.getDate() + pvOffset * 7);
  const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
  const from = pvLocalISO(monday); const to = pvLocalISO(sunday);
  const lbl = document.getElementById('pv-label');
  if (lbl) lbl.textContent = `du ${pvFrDate(from)} au ${pvFrDate(to)}`;
  const prev = document.getElementById('pv-prev'); const next = document.getElementById('pv-next');
  if (prev) prev.disabled = pvOffset <= PV_MIN;
  if (next) next.disabled = pvOffset >= PV_MAX;
  try {
    const res = await fetch(`/api/planning?from=${from}&to=${to}`);
    if (!res.ok) { out.innerHTML = '<div class="empty">Erreur de chargement.</div>'; return; }
    const data = await res.json();
    data.from = from; data.to = to;
    // On ne re-rend que si les données ont changé (évite le clignotement à chaque rafraîchissement).
    const sig = JSON.stringify(data);
    if (sig === pvLastSig && out.querySelector('table')) return;
    pvLastSig = sig;
    window.PlanningView.render(out, data);
  } catch {
    out.innerHTML = '<div class="empty">Impossible de charger le planning.</div>';
  }
}
function pvShiftWeek(delta) {
  const n = pvOffset + delta;
  if (n < PV_MIN || n > PV_MAX) return;
  pvOffset = n; loadPlanningView();
}
document.getElementById('pv-prev')?.addEventListener('click', () => pvShiftWeek(-1));
document.getElementById('pv-next')?.addEventListener('click', () => pvShiftWeek(1));

// --- Init -----------------------------------------------------------------
applyEstablishment();
loadOpenEntries();
setInterval(loadOpenEntries, 30000);
loadPlanningView();
// Rafraîchit le planning automatiquement pour refléter les modifications faites
// côté admin (toutes les 15 s ; ne re-rend que si quelque chose a changé).
setInterval(loadPlanningView, 15000);
// Rafraîchit aussi dès qu'on revient sur l'onglet/écran.
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadPlanningView(); });

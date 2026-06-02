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
function fmtSince(ts) {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// --- Chargement des employés ---------------------------------------------
async function loadEmployees() {
  const grid = document.getElementById('employees');
  try {
    const res = await fetch('/api/employees');
    const employees = await res.json();
    grid.className = ''; // conteneur de sections (les grilles sont à l'intérieur)
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

const CATEGORY_LABELS = { responsable: 'Responsables', chef_de_rang: 'Chefs de rang', apprenti: 'Apprentis' };
const CATEGORY_ORDER = ['responsable', 'chef_de_rang', 'apprenti'];

function buildCard(emp) {
  const card = document.createElement('button');
  const hasToday = emp.todaySeconds > 0;
  const statusText = hasToday
    ? "Aujourd'hui : " + fmtDuration(emp.todaySeconds)
    : 'Saisir les horaires';
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Modale ---------------------------------------------------------------
const overlay = document.getElementById('overlay');
const modal = document.getElementById('modal');
let pin = '';
let currentEmp = null;

function closeModal() {
  overlay.classList.remove('show');
  pin = '';
  currentEmp = null;
}
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

function openModal(emp) {
  currentEmp = emp;
  pin = ''; // PIN retiré : on ouvre directement le menu de pointage
  renderHub();
  overlay.classList.add('show');
}

function renderPinScreen(errorMsg) {
  const emp = currentEmp;
  modal.innerHTML = `
    <h2>${escapeHtml(emp.name)}</h2>
    <div class="sub">Saisissez votre code PIN</div>
    <div class="pin-display" id="pin-display"></div>
    <div class="keypad" id="keypad"></div>
    <div class="msg error ${errorMsg ? 'show' : ''}" id="modal-msg">${errorMsg || ''}</div>
    <div style="margin-top:16px"><button class="btn btn-ghost" id="cancel-btn">Annuler</button></div>
  `;
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '←', '0', 'OK'];
  const keypad = document.getElementById('keypad');
  for (const k of keys) {
    const btn = document.createElement('button');
    btn.className = 'key' + (k === '←' || k === 'OK' ? ' wide' : '');
    btn.textContent = k;
    btn.addEventListener('click', () => handleKey(k));
    keypad.appendChild(btn);
  }
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  updatePinDisplay();
}

function updatePinDisplay() {
  const disp = document.getElementById('pin-display');
  if (!disp) return;
  disp.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement('div');
    dot.className = 'pin-dot' + (i < pin.length ? ' filled' : '');
    disp.appendChild(dot);
  }
}

function handleKey(k) {
  if (k === '←') {
    pin = pin.slice(0, -1);
  } else if (k === 'OK') {
    if (pin.length === 4) submitPin();
    return;
  } else if (pin.length < 4) {
    pin += k;
    if (pin.length === 4) { updatePinDisplay(); setTimeout(submitPin, 150); return; }
  }
  updatePinDisplay();
}

// Clavier physique
document.addEventListener('keydown', (e) => {
  if (!overlay.classList.contains('show') || !currentEmp) return;
  if (e.key === 'Escape') { closeModal(); return; }
  // Le pavé numérique ne pilote le PIN que sur l'écran PIN (sinon il
  // perturberait la saisie dans les champs date/heure du formulaire).
  if (!document.getElementById('keypad')) return;
  if (e.key >= '0' && e.key <= '9') handleKey(e.key);
  else if (e.key === 'Backspace') handleKey('←');
  else if (e.key === 'Enter') handleKey('OK');
});

// --- Soumission du PIN → formulaire de saisie des horaires ----------------
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nowHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dateISOfromTs(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hmFromTs(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDayShort(ts) {
  return new Date(ts).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

function showActionError(msg) {
  const el = document.getElementById('modal-msg');
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

// Un 403 « PIN » renvoie à l'écran PIN ; tout autre 403 (verrouillage) reste affiché.
function handledAuthError(res, data) {
  if (res.status === 403 && /PIN/i.test(data.error || '')) {
    pin = '';
    renderPinScreen(data.error);
    return true;
  }
  return false;
}

// --- Menu après PIN -------------------------------------------------------
function submitPin() {
  renderHub();
}

function renderHub() {
  const e = currentEmp;
  modal.innerHTML = `
    <h2>${escapeHtml(e.name)}</h2>
    <div class="sub">Que voulez-vous faire ?</div>
    <div class="action-buttons">
      <button class="btn btn-green" id="hub-main">➕ Saisir des horaires</button>
      <button class="btn btn-red" id="hub-depart">🏁 Saisir mon départ (aujourd'hui)</button>
      <button class="btn btn-ghost" id="hub-edit">📝 Modifier mes pointages</button>
      <button class="btn btn-ghost" id="hub-cancel">Fermer</button>
    </div>
    <div class="msg error" id="modal-msg"></div>
  `;
  document.getElementById('hub-main').addEventListener('click', renderEntryForm);
  document.getElementById('hub-depart').addEventListener('click', openDepartureForm);
  document.getElementById('hub-edit').addEventListener('click', loadMyEntries);
  document.getElementById('hub-cancel').addEventListener('click', closeModal);
}

// --- Saisir son départ pour aujourd'hui (clôture des arrivées ouvertes) ----
async function openDepartureForm() {
  try {
    const res = await fetch('/api/my-entries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmp.id, pin }),
    });
    const data = await res.json();
    if (!res.ok) { if (!handledAuthError(res, data)) showActionError(data.error); return; }
    const today = todayISO();
    const open = data.entries.filter((e) => e.open && dateISOfromTs(e.clockIn) === today);
    renderDepartureForm(open);
  } catch {
    showActionError('Erreur de connexion au serveur.');
  }
}

function renderDepartureForm(openEntries) {
  let body;
  if (!openEntries.length) {
    body = `<div class="sub">Aucune arrivée à clôturer aujourd'hui.<br>
      Si vous venez d'arriver, utilisez « Saisir des horaires ».</div>`;
  } else {
    body = openEntries.map((e) => `
      <div class="dep-row">
        <span>Arrivée <strong>${hmFromTs(e.clockIn)}</strong> → départ</span>
        <input type="time" class="dep-time" data-id="${e.id}" data-start="${hmFromTs(e.clockIn)}" data-date="${dateISOfromTs(e.clockIn)}" value="${nowHM()}">
        <button class="btn btn-red dep-save" data-id="${e.id}">Valider</button>
      </div>`).join('');
  }
  modal.innerHTML = `
    <h2>${escapeHtml(currentEmp.name)}</h2>
    <div class="sub">Mon heure de départ — aujourd'hui</div>
    ${body}
    <div class="msg error" id="modal-msg"></div>
    <div style="margin-top:14px"><button class="btn btn-ghost" id="dep-back">Retour</button></div>
  `;
  modal.querySelectorAll('.dep-save').forEach((b) => b.addEventListener('click', () => saveDeparture(b.dataset.id)));
  document.getElementById('dep-back').addEventListener('click', renderHub);
}

async function saveDeparture(id) {
  const inp = modal.querySelector(`.dep-time[data-id="${id}"]`);
  const end = inp ? inp.value : '';
  if (!end) return showActionError("Renseignez l'heure de départ.");
  try {
    const res = await fetch(`/api/my-entries/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmp.id, pin, date: inp.dataset.date, start: inp.dataset.start, end }),
    });
    const data = await res.json();
    if (!res.ok) { if (!handledAuthError(res, data)) showActionError(data.error); return; }
    loadEmployees();
    openDepartureForm(); // rafraîchit (la période clôturée disparaît)
  } catch {
    showActionError('Erreur de connexion au serveur.');
  }
}

// --- Saisie d'horaires (arrivée + départ) ---------------------------------
// Créneaux d'arrivée proposés en raccourci (saisie manuelle aussi possible).
const ARRIVAL_PRESETS = [
  { label: 'Matin', times: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:50'] },
  { label: 'Soir', times: ['17:00', '17:30', '18:00', '18:50'] },
];

function presetsHtml(groups) {
  return groups.map((g) => `
    <div class="preset-label">${g.label}</div>
    <div class="preset-chips">
      ${g.times.map((t) => `<button type="button" class="chip" data-time="${t}">${t}</button>`).join('')}
    </div>`).join('');
}

function renderEntryForm() {
  modal.innerHTML = `
    <h2>${escapeHtml(currentEmp.name)}</h2>
    <div class="sub">Saisissez vos horaires</div>
    <div class="field">
      <label for="ef-date">Date</label>
      <input type="date" id="ef-date" value="${todayISO()}">
    </div>
    <div class="field" style="margin-bottom:6px">
      <label for="ef-start">Heure d'arrivée</label>
      <input type="time" id="ef-start">
      <div class="presets">${presetsHtml(ARRIVAL_PRESETS)}</div>
    </div>
    <div class="field">
      <label for="ef-end">Heure de départ <span style="color:var(--muted);font-weight:400">(optionnel)</span></label>
      <input type="time" id="ef-end">
    </div>
    <div class="msg error" id="modal-msg"></div>
    <div class="action-buttons" style="margin-top:16px">
      <button class="btn btn-green" id="ef-submit">Enregistrer</button>
      <button class="btn btn-ghost" id="ef-cancel">Retour</button>
    </div>
  `;
  const startInput = document.getElementById('ef-start');
  modal.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      startInput.value = chip.dataset.time;
      modal.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });
  startInput.addEventListener('input', () => {
    modal.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  });
  document.getElementById('ef-submit').addEventListener('click', submitEntry);
  document.getElementById('ef-cancel').addEventListener('click', renderHub);
}

async function submitEntry() {
  const date = document.getElementById('ef-date').value;
  const start = document.getElementById('ef-start').value;
  const end = document.getElementById('ef-end').value;
  if (!date || !start) return showActionError("Renseignez au moins la date et l'heure d'arrivée.");
  try {
    const res = await fetch('/api/entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmp.id, date, start, end: end || undefined }),
    });
    const data = await res.json();
    if (!res.ok) { showActionError(data.error || 'Erreur'); return; }
    renderEntryConfirmation(data);
    loadEmployees();
  } catch {
    showActionError('Erreur de connexion au serveur.');
  }
}

function renderEntryConfirmation(data) {
  modal.innerHTML = `
    <div class="confirm">
      <div class="icon in">✓</div>
      <h2>Horaires enregistrés</h2>
      <div class="detail">${escapeHtml(data.name)} — ${data.start} → ${data.end || '<em>départ à compléter</em>'}</div>
      <div class="total">Total du jour : <strong>${fmtDuration(data.todaySeconds)}</strong></div>
      <button class="btn btn-blue" id="confirm-close">Fermer</button>
    </div>
  `;
  document.getElementById('confirm-close').addEventListener('click', closeModal);
  setTimeout(() => { if (overlay.classList.contains('show')) closeModal(); }, 4000);
}

// --- Modification de ses pointages (verrouillés au-delà de 7 jours) --------
let myEntriesData = null;

async function loadMyEntries() {
  try {
    const res = await fetch('/api/my-entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmp.id, pin }),
    });
    const data = await res.json();
    if (!res.ok) { if (!handledAuthError(res, data)) showActionError(data.error); return; }
    myEntriesData = data;
    renderEntriesList();
  } catch {
    showActionError('Erreur de connexion au serveur.');
  }
}

function renderEntriesList() {
  const { entries, editWindowDays } = myEntriesData;
  let rows = '';
  if (!entries.length) {
    rows = '<div class="empty">Aucun pointage sur les 30 derniers jours.</div>';
  } else {
    for (const en of entries) {
      const period = en.open
        ? `${hmFromTs(en.clockIn)} → <em>en cours</em>`
        : `${hmFromTs(en.clockIn)} → ${hmFromTs(en.clockOut)}`;
      const right = en.editable
        ? `<button class="link-btn" data-edit="${en.id}">Modifier</button> <button class="link-btn danger" data-del="${en.id}">Supprimer</button>`
        : '<span class="tag inactive">Verrouillé</span>';
      rows += `
        <div class="entry-row">
          <div>
            <div style="font-weight:600">${fmtDayShort(en.clockIn)}</div>
            <div style="color:#64748b;font-size:.88rem">${period} · net ${fmtDuration(en.netSeconds)}</div>
          </div>
          <div>${right}</div>
        </div>`;
    }
  }
  modal.innerHTML = `
    <h2>Mes pointages</h2>
    <div class="sub">Modifiables jusqu'à ${editWindowDays} jours ; au-delà, verrouillés.</div>
    <div class="entries-list">${rows}</div>
    <div class="msg error" id="modal-msg"></div>
    <div style="margin-top:14px"><button class="btn btn-ghost" id="entries-back">Retour</button></div>
  `;
  modal.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const en = entries.find((x) => String(x.id) === btn.dataset.edit);
      renderEditForm(en);
    });
  });
  modal.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer ce pointage ?')) return;
      try {
        const res = await fetch(`/api/my-entries/${btn.dataset.del}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employeeId: currentEmp.id, pin }),
        });
        const data = await res.json();
        if (!res.ok) { if (!handledAuthError(res, data)) showActionError(data.error); return; }
        loadEmployees();
        await loadMyEntries();
      } catch {
        showActionError('Erreur de connexion au serveur.');
      }
    });
  });
  document.getElementById('entries-back').addEventListener('click', renderHub);
}

function renderEditForm(en) {
  modal.innerHTML = `
    <h2>Modifier le pointage</h2>
    <div class="sub">${fmtDayShort(en.clockIn)}</div>
    <div class="field">
      <label for="ef-date">Date</label>
      <input type="date" id="ef-date" value="${dateISOfromTs(en.clockIn)}">
    </div>
    <div class="row">
      <div class="field">
        <label for="ef-start">Arrivée</label>
        <input type="time" id="ef-start" value="${hmFromTs(en.clockIn)}">
      </div>
      <div class="field">
        <label for="ef-end">Départ</label>
        <input type="time" id="ef-end" value="${en.open ? '' : hmFromTs(en.clockOut)}">
      </div>
    </div>
    <div class="sub" style="font-size:.82rem">Laissez le départ vide si la période est encore en cours.</div>
    <div class="msg error" id="modal-msg"></div>
    <div class="action-buttons" style="margin-top:14px">
      <button class="btn btn-blue" id="ef-submit">Enregistrer les modifications</button>
      <button class="btn btn-ghost" id="ef-cancel">Retour</button>
    </div>
  `;
  document.getElementById('ef-submit').addEventListener('click', () => submitEdit(en.id));
  document.getElementById('ef-cancel').addEventListener('click', loadMyEntries);
}

async function submitEdit(entryId) {
  const date = document.getElementById('ef-date').value;
  const start = document.getElementById('ef-start').value;
  const end = document.getElementById('ef-end').value;
  if (!date || !start) return showActionError('La date et l\'heure d\'arrivée sont obligatoires.');
  try {
    const res = await fetch(`/api/my-entries/${entryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmp.id, pin, date, start, end }),
    });
    const data = await res.json();
    if (!res.ok) { if (!handledAuthError(res, data)) showActionError(data.error); return; }
    loadEmployees();
    await loadMyEntries();
  } catch {
    showActionError('Erreur de connexion au serveur.');
  }
}

// --- Nom de l'établissement (si plusieurs sites) --------------------------
async function applyEstablishment() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.establishment) {
      document.title = cfg.establishment + ' — Pointage';
    }
  } catch { /* ignore */ }
}

// --- Init -----------------------------------------------------------------
applyEstablishment();
loadEmployees();
setInterval(loadEmployees, 30000); // rafraîchit les statuts

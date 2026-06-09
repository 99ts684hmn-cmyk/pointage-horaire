'use strict';

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtH(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}`;
}
function fmtTime(ts) {
  return ts == null ? '—' : new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function showMsg(el, text, type) {
  el.textContent = text;
  el.className = 'msg show ' + (type || 'error');
}
function clearMsg(el) { el.className = 'msg'; el.textContent = ''; }
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Jours de repos applicables à une date (dernière période dont from <= date).
function restDaysOn(periods, dateStr) {
  let best = null;
  for (const p of (periods || [])) if (p.from <= dateStr && (!best || p.from > best.from)) best = p;
  return best ? best.days : [];
}

// Lundi et dimanche de la semaine calendaire contenant la date donnée.
function weekBounds(date) {
  const dow = date.getDay(); // 0 = dimanche, 1 = lundi, …
  const toMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - toMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { monday, sunday };
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* csv ou vide */ }
  return { ok: res.ok, status: res.status, data };
}

// --- Authentification -----------------------------------------------------
async function checkAuth() {
  const { data } = await api('/api/admin/me');
  if (data && data.loggedIn) showAdmin();
  else showLogin();
}

function showLogin() {
  $('login-view').style.display = '';
  $('admin-view').style.display = 'none';
  $('logout-link').style.display = 'none';
  $('login-password').focus();
}

async function showAdmin() {
  $('login-view').style.display = 'none';
  $('admin-view').style.display = '';
  $('logout-link').style.display = '';
  await loadEmployees();
  await loadBreaks();
  await loadEstablishment();
  // Période par défaut : semaine calendaire en cours (lundi → dimanche).
  const { monday, sunday } = weekBounds(new Date());
  $('rep-from').value = localISO(monday);
  $('rep-to').value = localISO(sunday);
  loadReport();
  loadPlanning();
  loadRecap();
}

// --- Établissement --------------------------------------------------------
async function loadEstablishment() {
  const { data } = await api('/api/admin/establishment');
  if (!data) return;
  $('estab-name').value = data.establishment || '';
  if (data.envOverride) {
    $('estab-name').disabled = true;
    showMsg($('estab-msg'), 'Le nom est défini par la configuration du serveur (variable ETABLISSEMENT).', 'success');
  }
}

$('estab-btn').addEventListener('click', async () => {
  clearMsg($('estab-msg'));
  const name = $('estab-name').value.trim();
  const { ok, data } = await api('/api/admin/establishment', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (ok) {
    showMsg($('estab-msg'), 'Nom de l\'établissement enregistré.', 'success');
    applyEstablishment(); // met à jour le bandeau immédiatement
  } else showMsg($('estab-msg'), (data && data.error) || 'Erreur');
});

$('login-btn').addEventListener('click', login);
$('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

async function login() {
  clearMsg($('login-msg'));
  const password = $('login-password').value;
  const { ok, data } = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (ok) { $('login-password').value = ''; showAdmin(); }
  else showMsg($('login-msg'), (data && data.error) || 'Erreur de connexion');
}

$('logout-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
});

// --- Employés -------------------------------------------------------------
let allEmployees = []; // liste complète, pour le planning hebdomadaire
const CAT_LABELS = { responsable: 'Responsable', chef_de_rang: 'Chef de rang', apprenti: 'Apprenti' };
const CAT_ORDER = ['responsable', 'chef_de_rang', 'apprenti'];
const catOf = (e) => (CAT_ORDER.includes(e.category) ? e.category : 'chef_de_rang');

async function loadEmployees() {
  const { data } = await api('/api/admin/employees');
  allEmployees = data || [];
  const tbody = $('emp-tbody');
  const select = $('rep-emp');
  tbody.innerHTML = '';
  select.innerHTML = '<option value="">Tous les employés</option>';

  if (!data || !data.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Aucun employé.</td></tr>';
    return;
  }
  for (const emp of data) {
    const tr = document.createElement('tr');
    tr.dataset.id = emp.id;
    const opts = CAT_ORDER.map((c) => `<option value="${c}" ${catOf(emp) === c ? 'selected' : ''}>${CAT_LABELS[c]}</option>`).join('');
    tr.innerHTML = `
      <td class="drag-handle" title="Glisser pour réordonner">⠿</td>
      <td>${escapeHtml(emp.name)}</td>
      <td><select class="cat-select" data-id="${emp.id}">${opts}</select></td>
      <td><span class="tag ${emp.active ? 'active' : 'inactive'}">${emp.active ? 'Actif' : 'Inactif'}</span>${(!emp.active && emp.endDate) ? `<div class="sub" style="font-size:.72rem">Dernier jour : ${frDate(emp.endDate)}</div>` : ''}</td>
      <td style="text-align:right">
        <button class="link-btn" data-act="profile" data-id="${emp.id}">Profil</button>
        <button class="link-btn" data-act="toggle" data-id="${emp.id}" data-active="${emp.active}">${emp.active ? 'Désactiver' : 'Réactiver'}</button>
      </td>`;
    tbody.appendChild(tr);
    if (emp.active) {
      const opt = document.createElement('option');
      opt.value = emp.id; opt.textContent = emp.name;
      select.appendChild(opt);
    }
  }

  tbody.querySelectorAll('.link-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleEmpAction(btn));
  });
  tbody.querySelectorAll('.cat-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      await api(`/api/admin/employees/${sel.dataset.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: sel.value }),
      });
      await loadEmployees();
      renderPlanning();
    });
  });

  // Glisser-déposer pour réordonner (souris + tactile via SortableJS).
  if (window.Sortable) {
    window.Sortable.create(tbody, {
      handle: '.drag-handle',
      animation: 150,
      onEnd: async () => {
        const order = [...tbody.querySelectorAll('tr')].map((tr) => Number(tr.dataset.id)).filter(Boolean);
        await api('/api/admin/employees/order', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order }),
        });
        await loadEmployees();
        loadPlanning();
      },
    });
  }
}

async function handleEmpAction(btn) {
  const id = btn.dataset.id;
  if (btn.dataset.act === 'profile') { openProfile(Number(id)); return; }
  if (btn.dataset.act === 'toggle') {
    const active = btn.dataset.active === '1';
    if (active) {
      const emp = allEmployees.find((e) => e.id === Number(id));
      openDeactivateModal(Number(id), emp ? emp.name : '');
    } else {
      // Réactivation directe (efface la date de fin côté serveur).
      await api(`/api/admin/employees/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });
      loadEmployees();
    }
  }
}

// Désactivation : demande le dernier jour dans l'entreprise (obligatoire).
function openDeactivateModal(empId, empName) {
  cellModal.innerHTML = `
    <h2>Désactiver ${escapeHtml(empName)}</h2>
    <div class="field" style="margin-top:12px">
      <label for="deact-date">Dernier jour dans l'entreprise</label>
      <input type="date" id="deact-date" value="${localISO(new Date())}">
      <div class="sub" style="font-size:.78rem;margin-top:6px">Le salarié reste sur les plannings jusqu'à la semaine de cette date incluse, puis disparaît des semaines suivantes. Les plannings précédents restent intacts.</div>
    </div>
    <div class="msg error" id="deact-msg"></div>
    <div class="action-buttons" style="margin-top:14px;grid-template-columns:1fr 1fr">
      <button class="btn btn-red" id="deact-confirm">Désactiver</button>
      <button class="btn btn-ghost" id="deact-cancel">Annuler</button>
    </div>`;
  cellModal.querySelector('#deact-confirm').addEventListener('click', async () => {
    const endDate = cellModal.querySelector('#deact-date').value;
    const m = $('deact-msg');
    if (!endDate) { m.textContent = 'La date du dernier jour est obligatoire.'; m.className = 'msg show error'; return; }
    const { ok, data } = await api(`/api/admin/employees/${empId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false, endDate }),
    });
    if (!ok) { m.textContent = (data && data.error) || 'Erreur'; m.className = 'msg show error'; return; }
    cellOverlay.classList.remove('show');
    loadEmployees();
  });
  cellModal.querySelector('#deact-cancel').addEventListener('click', () => cellOverlay.classList.remove('show'));
  cellOverlay.classList.add('show');
}

$('add-btn').addEventListener('click', async () => {
  clearMsg($('emp-msg'));
  const name = $('new-name').value.trim();
  const category = $('new-cat').value;
  const { ok, data } = await api('/api/admin/employees', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, category }),
  });
  if (ok) {
    $('new-name').value = '';
    await loadEmployees();
    renderPlanning();
  } else showMsg($('emp-msg'), (data && data.error) || 'Erreur');
});

// --- Profil salarié (jours de repos + service continu) --------------------
const DOW = [{ n: 1, l: 'Lun' }, { n: 2, l: 'Mar' }, { n: 3, l: 'Mer' }, { n: 4, l: 'Jeu' },
  { n: 5, l: 'Ven' }, { n: 6, l: 'Sam' }, { n: 0, l: 'Dim' }];
const profileOverlay = $('profile-overlay');
const profileModal = $('profile-modal');
profileOverlay.addEventListener('click', (e) => { if (e.target === profileOverlay) profileOverlay.classList.remove('show'); });

function openProfile(empId) {
  const emp = allEmployees.find((e) => e.id === empId);
  if (!emp) return;
  const rest = new Set(emp.restDays || []);
  // Date d'effet par défaut : lundi de la semaine EN COURS, pour qu'un changement
  // s'applique immédiatement. Mettre une date antérieure/ultérieure si besoin.
  const thisMonday = localISO(weekBounds(new Date()).monday);
  profileModal.innerHTML = `
    <h2>${escapeHtml(emp.name)}</h2>
    <div class="sub">Profil — repos &amp; service</div>
    <div class="field">
      <label>Jours de repos hebdomadaires</label>
      <div class="preset-chips" id="pf-rest">
        ${DOW.map((d) => `<button type="button" class="chip ${rest.has(d.n) ? 'active' : ''}" data-d="${d.n}">${d.l}</button>`).join('')}
      </div>
    </div>
    <div class="field" style="margin-top:10px">
      <label for="pf-from">Repos applicables à partir du</label>
      <input type="date" id="pf-from" value="${thisMonday}">
      <div class="sub" style="font-size:.78rem;margin-top:4px">Par défaut : début de la semaine en cours (effet immédiat). Avancez la date pour ne changer que les semaines futures, ou reculez-la pour corriger le passé.</div>
    </div>
    <div class="field" style="margin-top:12px">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="pf-continu" ${emp.continuous ? 'checked' : ''} style="width:auto">
        Service continu (les deux services sans coupure)
      </label>
    </div>
    <div class="msg" id="pf-msg"></div>
    <div class="action-buttons" style="margin-top:14px">
      <button class="btn btn-blue" id="pf-save">Enregistrer</button>
      <button class="btn btn-ghost" id="pf-close">Fermer</button>
    </div>
  `;
  profileModal.querySelectorAll('#pf-rest .chip').forEach((c) => {
    c.addEventListener('click', () => c.classList.toggle('active'));
  });
  profileModal.querySelector('#pf-save').addEventListener('click', async () => {
    const restDays = [...profileModal.querySelectorAll('#pf-rest .chip.active')].map((c) => Number(c.dataset.d));
    const restDaysFrom = profileModal.querySelector('#pf-from').value;
    const continuous = profileModal.querySelector('#pf-continu').checked;
    const { ok, data } = await api(`/api/admin/employees/${empId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restDays, restDaysFrom, continuous }),
    });
    if (!ok) { const m = $('pf-msg'); m.textContent = (data && data.error) || 'Erreur'; m.className = 'msg show error'; return; }
    profileOverlay.classList.remove('show');
    await loadEmployees();
    loadPlanning();
  });
  profileModal.querySelector('#pf-close').addEventListener('click', () => profileOverlay.classList.remove('show'));
  profileOverlay.classList.add('show');
}

// --- Pauses obligatoires --------------------------------------------------
function renderBreakRow(start = '', end = '') {
  const div = document.createElement('div');
  div.className = 'row break-row';
  div.style.marginBottom = '10px';
  div.innerHTML = `
    <div class="field" style="max-width:140px">
      <label>Début</label>
      <input type="time" class="break-start" value="${start}">
    </div>
    <div class="field" style="max-width:140px">
      <label>Fin</label>
      <input type="time" class="break-end" value="${end}">
    </div>
    <button class="link-btn danger remove-break" style="flex:0 0 auto">Supprimer</button>`;
  div.querySelector('.remove-break').addEventListener('click', () => div.remove());
  return div;
}

async function loadBreaks() {
  const { data } = await api('/api/admin/breaks');
  const list = $('breaks-list');
  list.innerHTML = '';
  (data || []).forEach((w) => list.appendChild(renderBreakRow(w.start, w.end)));
  if (!list.children.length) list.appendChild(renderBreakRow());
}

$('add-break').addEventListener('click', () => {
  $('breaks-list').appendChild(renderBreakRow());
});

$('save-breaks').addEventListener('click', async () => {
  clearMsg($('breaks-msg'));
  const windows = [];
  for (const row of $('breaks-list').querySelectorAll('.break-row')) {
    const start = row.querySelector('.break-start').value;
    const end = row.querySelector('.break-end').value;
    if (!start && !end) continue;
    windows.push({ start, end });
  }
  const { ok, data } = await api('/api/admin/breaks', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windows }),
  });
  if (ok) {
    showMsg($('breaks-msg'), 'Pauses enregistrées. Elles s\'appliquent aux calculs.', 'success');
    loadBreaks();
  } else showMsg($('breaks-msg'), (data && data.error) || 'Erreur');
});

// --- Rapport --------------------------------------------------------------
$('rep-btn').addEventListener('click', () => { loadReport(); loadPlanning(); });

function reportQuery() {
  const from = $('rep-from').value;
  const to = $('rep-to').value;
  const emp = $('rep-emp').value;
  const params = new URLSearchParams({ from, to });
  if (emp) params.set('employeeId', emp);
  return { from, to, params };
}

function addDaysISO(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localISO(d); }

async function loadReport() {
  const out = $('report-output');
  const { from, to } = reportQuery();
  const empFilter = $('rep-emp').value;
  if (!from || !to) { out.innerHTML = '<div class="empty">Choisissez une période.</div>'; return; }

  // Fenêtre élargie (±4 semaines) pour permettre le report d'échange multi-semaines.
  const extFrom = addDaysISO(from, -28);
  const extTo = addDaysISO(to, 28);
  const p = new URLSearchParams({ from: extFrom, to: extTo });
  const [rep, st] = await Promise.all([
    api('/api/admin/report?' + p.toString()),
    api('/api/admin/day-statuses?' + p.toString()),
  ]);
  if (!rep.ok) { out.innerHTML = '<div class="empty">Erreur lors du chargement.</div>'; return; }
  const repData = rep.data || [];
  const stat = new Map();
  if (st.ok && Array.isArray(st.data)) for (const s of st.data) stat.set(s.employeeId + '|' + s.day, s.status);

  const AWAY = ['cp', 'am', 'absent', 'ecole'];
  const dispDays = daysBetween(from, to);
  const extDays = daysBetween(extFrom, extTo);
  const repById = new Map(repData.map((e) => [e.employeeId, e]));

  // Salariés à afficher : actifs / sortants encore visibles, ou ayant des données.
  let emps = allEmployees.filter((e) => e.active || (e.endDate && e.endDate >= from) || repById.has(e.id));
  if (empFilter) emps = emps.filter((e) => String(e.id) === String(empFilter));
  emps.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  if (!emps.length) { out.innerHTML = '<div class="empty">Aucun salarié.</div>'; return; }

  // Info par salarié et par jour (heures, statut, repos) puis report des échanges.
  const perEmp = new Map();
  for (const emp of emps) {
    const secByDay = new Map(((repById.get(emp.id) || {}).days || []).map((x) => [x.day, x.seconds]));
    const info = new Map();
    for (const d of extDays) {
      const wd = new Date(d + 'T12:00:00').getDay();
      const status = stat.get(emp.id + '|' + d);
      const isRest = restDaysOn(emp.restPeriods, d).includes(wd) || status === 'repos';
      info.set(d, { sec: secByDay.get(d) || 0, status, isRest, carriedFrom: null, carriedTo: null });
    }
    // Échange : jour de repos avec heures → reporter sur le jour vide le plus proche
    // (avant OU après, en s'éloignant ; un jour vide = non-repos, sans statut, sans heure).
    const used = new Set();
    for (const exDay of extDays) {
      const it = info.get(exDay);
      if (!(it.isRest && it.sec > 0)) continue;
      const idx = extDays.indexOf(exDay);
      let target = null;
      for (let k = 1; k < extDays.length && !target; k++) {
        for (const j of [idx - k, idx + k]) {
          if (j < 0 || j >= extDays.length) continue;
          const dd = extDays[j];
          if (used.has(dd)) continue;
          const t = info.get(dd);
          if (!t.isRest && !AWAY.includes(t.status) && t.sec === 0 && !t.carriedFrom) { target = dd; break; }
        }
      }
      if (target) {
        used.add(target);
        const t = info.get(target);
        t.sec = it.sec; t.carriedFrom = exDay;
        it.carriedTo = target; it.sec = 0;
      }
    }
    perEmp.set(emp.id, info);
  }

  const cell = (it) => {
    if (it.sec > 0) {
      const mark = it.carriedFrom ? '<span class="rep-carried" title="Heures d\'un échange reportées ici">↳</span>' : '';
      return `<td>${mark}${fmtH(it.sec)}</td>`;
    }
    if (AWAY.includes(it.status)) return `<td class="pl-statusfill st-${it.status}"><span class="pl-status-lbl">${STATUS_SHORT[it.status]}</span></td>`;
    if (it.isRest) return `<td class="pl-rest">${CROSS_SVG}</td>`;
    return '<td>—</td>';
  };

  let html = '<table class="planning"><thead><tr><th class="pl-name">Salarié</th>';
  for (const d of dispDays) html += `<th>${planningDayLabel(d)}</th>`;
  html += '<th style="text-align:right">Total</th></tr></thead><tbody>';

  const dayTot = {}; dispDays.forEach((d) => { dayTot[d] = 0; }); let grand = 0;
  for (const emp of emps) {
    const info = perEmp.get(emp.id);
    let tot = 0;
    html += `<tr class="pl-emp-row"><td class="pl-name"><div class="pl-name-inner"><span class="pl-name-txt">${escapeHtml(emp.name)}</span></div></td>`;
    for (const d of dispDays) {
      const it = info.get(d);
      html += cell(it);
      dayTot[d] += it.sec; tot += it.sec;
    }
    grand += tot;
    html += `<td class="pl-total">${tot ? fmtH(tot) : '—'}</td></tr>`;
  }
  html += '<tr class="pl-tot-row"><td class="pl-name">Total / jour</td>';
  for (const d of dispDays) html += `<td>${dayTot[d] ? fmtH(dayTot[d]) : '—'}</td>`;
  html += `<td class="pl-total">${fmtH(grand)}</td></tr>`;
  html += '</tbody></table>';
  out.innerHTML = `<div class="table-wrap">${html}</div>`;
}

$('csv-btn').addEventListener('click', () => {
  const { from, to, params } = reportQuery();
  if (!from || !to) { alert('Choisissez une période.'); return; }
  window.location.href = '/api/admin/report.csv?' + params.toString();
});

// --- Planning hebdomadaire (grille salariés × jours) ----------------------
function daysBetween(from, to) {
  const out = [];
  const d = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  while (d <= end) { out.push(localISO(d)); d.setDate(d.getDate() + 1); }
  return out;
}
function planningDayLabel(iso) {
  const dt = new Date(iso + 'T12:00:00');
  const j = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][dt.getDay()];
  return `${j}<br>${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
}
function frDate(iso) {
  const dt = new Date(iso + 'T12:00:00');
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

// Présence d'un créneau dans les services : midi 9h–14h, soir 18h–21h.
function svcPresence(seg) {
  const d = new Date(seg.clockIn);
  const at = (h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  const midiStart = at(9, 0); const midiEnd = at(14, 0);
  const soirStart = at(18, 0); const soirEnd = at(21, 0);
  const inT = seg.clockIn;
  if (seg.clockOut != null) {
    return {
      midi: inT < midiEnd && seg.clockOut > midiStart,
      soir: inT < soirEnd && seg.clockOut > soirStart,
    };
  }
  // Période ouverte (arrivée seule) : on classe selon l'heure d'arrivée.
  return { midi: inT < midiEnd, soir: inT >= midiEnd && inT < soirEnd };
}

// Répartit les créneaux d'un jour en : continu (couvre les deux services),
// midi, soir. Les cas hors fenêtres sont rattachés selon l'heure d'arrivée.
function classifyDay(segments) {
  const cont = []; const midi = []; const soir = [];
  for (const s of segments) {
    const p = svcPresence(s);
    if (p.midi && p.soir) cont.push(s);
    else if (p.midi) midi.push(s);
    else if (p.soir) soir.push(s);
    else (new Date(s.clockIn).getHours() < 17 ? midi : soir).push(s);
  }
  return { cont, midi, soir };
}

// Données du planning (toujours complètes, indépendantes du filtre du rapport).
let planningReport = [];
let statusMap = new Map(); // clé "empId|day" → 'cp'|'am'|'ecole'
let extraMap = {}; // clé "YYYY-MM-DD|midi" / "…|soir" → texte libre (ligne « Extra »)
const STATUS_SHORT = { cp: 'CP', am: 'AM', ecole: 'École', absent: 'Abs', repos: 'Repos' };
const STATUS_FULL = { cp: 'Congés payés', am: 'Arrêt maladie', ecole: 'École', absent: 'Absent', repos: 'Repos', demi_midi: 'Demi midi (présent soir)', demi_soir: 'Demi soir (présent midi)', echange_midi: 'Échange midi', echange_soir: 'Échange soir', echange_both: 'Échange midi + soir' };
const AWAY_STATUSES = ['cp', 'am', 'absent', 'ecole'];
// Croix (X) en coin à coin, remplit la case (repos) ou la demi-case (demi).
const CROSS_SVG = '<svg class="pl-cross" viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="0" x2="10" y2="10"/><line x1="10" y1="0" x2="0" y2="10"/></svg>';

async function loadPlanning() {
  const from = $('rep-from').value;
  const to = $('rep-to').value;
  if (!from || !to) { renderPlanning(); return; }
  const params = new URLSearchParams({ from, to });
  const [rep, st, ex] = await Promise.all([
    api('/api/admin/report?' + params.toString()),
    api('/api/admin/day-statuses?' + params.toString()),
    api('/api/admin/extra?' + params.toString()),
  ]);
  planningReport = (rep.ok && rep.data) ? rep.data : [];
  statusMap = new Map();
  if (st.ok && Array.isArray(st.data)) {
    for (const s of st.data) statusMap.set(s.employeeId + '|' + s.day, s.status);
  }
  extraMap = (ex.ok && ex.data && typeof ex.data === 'object') ? ex.data : {};
  renderPlanning();
}

function renderPlanning() {
  const out = $('planning-output');
  const from = $('rep-from').value;
  const to = $('rep-to').value;
  const lbl = $('wk-label');
  if (lbl) lbl.textContent = (from && to) ? `📅 du ${frDate(from)} au ${frDate(to)}` : '';
  const wkDate = $('wk-date');
  if (wkDate && from) wkDate.value = from;
  const lblPrint = $('wk-print-dates');
  if (lblPrint) lblPrint.textContent = (from && to) ? ` — du ${frDate(from)} au ${frDate(to)}` : '';
  if (!from || !to) { out.innerHTML = '<div class="empty">Choisissez une semaine.</div>'; return; }

  const days = daysBetween(from, to);
  const byId = new Map((planningReport || []).map((e) => [e.employeeId, e]));
  // Salariés visibles cette semaine : actifs, OU sortis mais dont le dernier jour
  // tombe cette semaine ou après (ils restent sur les plannings jusque-là).
  const actives = allEmployees
    .filter((e) => e.active || (e.endDate && e.endDate >= from))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  if (!actives.length) { out.innerHTML = '<div class="empty">Aucun salarié.</div>'; return; }

  let html = '<table class="planning"><thead><tr><th class="pl-name">Salarié</th>';
  for (const d of days) html += `<th class="pl-day-head" data-day="${d}" title="Cliquer pour copier les arrivées du jour">${planningDayLabel(d)}</th>`;
  html += '<th style="text-align:right">Total</th></tr></thead><tbody>';

  const dayTotals = {};
  const midiCount = {};
  const soirCount = {};
  const weekday = {};
  days.forEach((d) => {
    dayTotals[d] = 0; midiCount[d] = 0; soirCount[d] = 0;
    weekday[d] = new Date(d + 'T12:00:00').getDay();
  });
  let grand = 0;

  // Heure de la PREMIÈRE arrivée de chaque service (par jour), hors service
  // continu. On retient l'heure : tous les salariés arrivés à cette heure
  // sont colorés (les ex æquo sont tous mis en couleur).
  const firstMidiT = {}; const firstSoirT = {};
  for (const d of days) {
    let bmT = Infinity; let bsT = Infinity;
    for (const emp of actives) {
      const rep = byId.get(emp.id);
      const day = rep && rep.days.find((x) => x.day === d);
      if (!day || !day.segments.length) continue;
      const { cont, midi, soir } = classifyDay(day.segments);
      if (emp.continuous || cont.length) continue;
      for (const s of midi) if (s.clockIn < bmT) bmT = s.clockIn;
      for (const s of soir) if (s.clockIn < bsT) bsT = s.clockIn;
    }
    firstMidiT[d] = bmT; firstSoirT[d] = bsT;
  }

  for (const emp of actives) {
      const rep = byId.get(emp.id);
      let dayCells = '';
      let demiCount = 0; // nombre de demi-journées (un seul service) sur la semaine
      for (const d of days) {
        const day = rep && rep.days.find((x) => x.day === d);
        const hasHours = !!(day && day.segments.length);
        const status = statusMap.get(emp.id + '|' + d);
        const awayStatus = AWAY_STATUSES.includes(status) ? status : null; // cp/am/absent/ecole
        const isRest = restDaysOn(emp.restPeriods, d).includes(weekday[d]) || status === 'repos';
        const demiMidi = status === 'demi_midi'; const demiSoir = status === 'demi_soir';
        const echMidi = status === 'echange_midi' || status === 'echange_both';
        const echSoir = status === 'echange_soir' || status === 'echange_both';
        let inner; let fillCls = ''; let exchangeMark = '';

        if (awayStatus && !hasHours) {
          inner = `<span class="pl-status-lbl">${STATUS_SHORT[awayStatus]}</span>`;
          fillCls = ` pl-statusfill st-${awayStatus}`;
        } else if (isRest && !hasHours) {
          inner = CROSS_SVG;
          fillCls = ' pl-rest';
        } else {
          // Jour travaillé (ou repos avec heures = échange) : demi-cases midi + soir.
          // Sans heures : « PM » (présent midi) / « PS » (présent soir) par défaut ;
          // demi manuel → croix sur le service non travaillé.
          const fmt = (s) => (s.open ? fmtTime(s.clockIn) : `${fmtTime(s.clockIn)}–${fmtTime(s.clockOut)}`);
          const { cont, midi, soir } = hasHours ? classifyDay(day.segments) : { cont: [], midi: [], soir: [] };
          const isCont = hasHours && (emp.continuous || cont.length > 0);
          let stack;
          if (isCont) {
            stack = `<div class="pl-half pl-cont">${day.segments.map(fmt).join('<br>')}</div>`;
            midiCount[d]++; soirCount[d]++;
          } else {
            let midiHalf;
            if (midi.length) {
              const isFirst = Math.min(...midi.map((s) => s.clockIn)) === firstMidiT[d];
              midiHalf = `<div class="pl-half${isFirst ? ' pl-first' : ''}">${midi.map(fmt).join('<br>')}</div>`;
              midiCount[d]++;
            } else if (demiMidi) {
              midiHalf = `<div class="pl-half pl-demi">${CROSS_SVG}</div>`;
            } else if (echMidi) {
              midiHalf = '<div class="pl-half pl-echange" title="Échange midi">É</div>'; // non compté
            } else {
              midiHalf = '<div class="pl-half pl-pres">PM</div>'; midiCount[d]++;
            }
            let soirHalf;
            if (soir.length) {
              const isOpen = Math.min(...soir.map((s) => s.clockIn)) === firstSoirT[d];
              soirHalf = `<div class="pl-half${isOpen ? ' pl-open' : ''}">${soir.map(fmt).join('<br>')}</div>`;
              soirCount[d]++;
            } else if (demiSoir) {
              soirHalf = `<div class="pl-half pl-demi">${CROSS_SVG}</div>`;
            } else if (echSoir) {
              soirHalf = '<div class="pl-half pl-echange" title="Échange soir">É</div>'; // non compté
            } else {
              soirHalf = '<div class="pl-half pl-pres">PS</div>'; soirCount[d]++;
            }
            stack = midiHalf + soirHalf;
            if (demiMidi || demiSoir) demiCount++;
          }
          inner = `<div class="pl-stack">${stack}</div>`;
          fillCls = ' pl-filled';
          if (hasHours) dayTotals[d] += day.seconds;
          if (isRest && hasHours) exchangeMark = '<span class="pl-exchange" title="Échange — travaillé un jour de repos">E</span>';
        }
        const cls = 'pl-cell pl-click' + fillCls;
        dayCells += `<td class="${cls}" data-emp="${emp.id}" data-day="${d}">${exchangeMark}${inner}</td>`;
      }
      const tot = rep ? rep.totalSeconds : 0;
      grand += tot;
      const nameCell = `<td class="pl-name"><div class="pl-name-inner"><span class="pl-name-txt">${escapeHtml(emp.name)}</span>`
        + (demiCount ? `<span class="pl-demi-count" title="${demiCount} demi cette semaine">${demiCount}</span>` : '')
        + '</div></td>';
      html += `<tr class="pl-emp-row">${nameCell}${dayCells}<td class="pl-total">${fmtH(tot)}</td></tr>`;
  }

  // Ligne « Extra » : saisie libre par service ; chaque texte saisi compte +1 présent.
  html += '<tr class="pl-extra-row"><td class="pl-name">Extra</td>';
  for (const d of days) {
    const m = (extraMap[d + '|midi'] || '').trim();
    const s = (extraMap[d + '|soir'] || '').trim();
    if (m) midiCount[d]++;
    if (s) soirCount[d]++;
    const sub = (svc, val) => `<div class="pl-extra-sub${val ? ' has' : ''}" data-day="${d}" data-svc="${svc}">`
      + (val ? `<span class="pl-extra-txt">${escapeHtml(val)}</span>` : '<span class="pl-empty">+</span>')
      + '</div>';
    html += `<td class="pl-extra-cell">${sub('midi', m)}${sub('soir', s)}</td>`;
  }
  html += '<td></td></tr>';

  // Nombre de présents par service (par jour).
  html += '<tr class="pl-svc-row"><td class="pl-name">Pres. midi</td>';
  for (const d of days) html += `<td>${midiCount[d] || '—'}</td>`;
  html += '<td></td></tr>';
  html += '<tr class="pl-svc-row"><td class="pl-name">Pres. soir</td>';
  for (const d of days) html += `<td>${soirCount[d] || '—'}</td>`;
  html += '<td></td></tr>';

  html += '<tr class="pl-tot-row"><td class="pl-name">Total / jour</td>';
  for (const d of days) html += `<td>${dayTotals[d] ? fmtH(dayTotals[d]) : '—'}</td>`;
  html += `<td class="pl-total">${fmtH(grand)}</td></tr>`;
  html += '</tbody></table>';
  out.innerHTML = html;

  out.querySelectorAll('.pl-click').forEach((td) => {
    td.addEventListener('click', () => openCellEditor(Number(td.dataset.emp), td.dataset.day));
  });
  out.querySelectorAll('.pl-day-head').forEach((th) => {
    th.addEventListener('click', () => copyDayArrivals(th.dataset.day));
  });
  out.querySelectorAll('.pl-extra-sub').forEach((el) => {
    el.addEventListener('click', () => openExtraEditor(el.dataset.day, el.dataset.svc));
  });
}

// Éditeur d'une case « Extra » (texte libre pour un service donné).
function openExtraEditor(day, svc) {
  const key = day + '|' + svc;
  const cur = extraMap[key] || '';
  const svcLabel = svc === 'midi' ? 'Midi' : 'Soir';
  cellModal.innerHTML = `
    <h2>Extra — ${svcLabel}</h2>
    <div class="sub">${planningDayLabel(day).replace('<br>', ' ')}</div>
    <div class="field" style="margin-top:12px">
      <label for="ex-text">Texte libre (ex. nom d'un extra, renfort…)</label>
      <textarea id="ex-text" style="width:100%;height:90px;font-family:inherit;font-size:.95rem;padding:10px;border:1px solid var(--border);border-radius:10px">${escapeHtml(cur)}</textarea>
      <div class="sub" style="font-size:.78rem;margin-top:4px">Si du texte est saisi, +1 présent est compté pour le service du ${svcLabel.toLowerCase()}.</div>
    </div>
    <div class="action-buttons" style="margin-top:12px;grid-template-columns:repeat(2,1fr)">
      <button class="btn btn-green" id="ex-save">Enregistrer</button>
      ${cur ? '<button class="btn btn-ghost" id="ex-clear">Effacer</button>' : ''}
    </div>
    <div class="msg error" id="ex-msg"></div>
    <div style="margin-top:12px"><button class="btn btn-ghost" id="ex-close">Fermer</button></div>
  `;
  cellModal.querySelector('#ex-save').addEventListener('click', () => {
    saveExtra(day, svc, cellModal.querySelector('#ex-text').value);
  });
  const clr = cellModal.querySelector('#ex-clear');
  if (clr) clr.addEventListener('click', () => saveExtra(day, svc, ''));
  cellModal.querySelector('#ex-close').addEventListener('click', () => cellOverlay.classList.remove('show'));
  cellOverlay.classList.add('show');
}

async function saveExtra(day, svc, text) {
  const { ok, data } = await api('/api/admin/extra', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: day, service: svc, text }),
  });
  if (!ok) {
    const m = $('ex-msg');
    if (m) { m.textContent = (data && data.error) || 'Erreur'; m.classList.add('show'); }
    return;
  }
  cellOverlay.classList.remove('show');
  await loadPlanning();
}

// Copie « Nom : heures d'arrivée » pour le jour cliqué.
function copyDayArrivals(d) {
  const byId = new Map((planningReport || []).map((e) => [e.employeeId, e]));
  const rows = [];
  // Visibles ce jour-là : actifs OU sortants pas encore partis (même règle que le planning).
  for (const emp of allEmployees.filter((e) => e.active || (e.endDate && e.endDate >= d))) {
    const rep = byId.get(emp.id);
    const day = rep && rep.days.find((x) => x.day === d);
    if (!day || !day.segments.length) continue;
    const times = day.segments.map((s) => s.clockIn).sort((a, b) => a - b);
    rows.push({ first: times[0], text: `${emp.name} : ${times.map(fmtTime).join(', ')}` });
  }
  rows.sort((a, b) => a.first - b.first);
  const dt = new Date(d + 'T12:00:00');
  let label = dt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  label = label.charAt(0).toUpperCase() + label.slice(1);
  const text = [label, ...rows.map((r) => r.text)].join('\n') || label;
  copyText(text);
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(() => { t.className = 'toast'; }, 1800);
}

async function copyText(text) {
  // 1) API moderne (fonctionne sur localhost / HTTPS)
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast('Copié ✓');
      return;
    }
  } catch { /* on tente le repli */ }
  // 2) Repli execCommand (geste utilisateur)
  if (execCopy(text)) { toast('Copié ✓'); return; }
  // 3) Dernier recours : fenêtre avec le texte présélectionné
  showCopyModal(text);
}

function execCopy(text) {
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed'; el.style.top = '0'; el.style.left = '0';
    el.style.width = '1px'; el.style.height = '1px'; el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus(); el.select(); el.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch { return false; }
}

// Fenêtre de secours : texte affiché et sélectionné, l'utilisateur fait Cmd+C.
function showCopyModal(text) {
  cellModal.innerHTML = `
    <h2>Arrivées du jour</h2>
    <div class="sub">Texte sélectionné — faites Cmd+C (ou maintenez puis « Copier »).</div>
    <textarea id="copy-ta" style="width:100%;height:200px;margin-top:10px;font-family:inherit;font-size:.95rem;padding:10px;border:1px solid var(--border);border-radius:10px"></textarea>
    <div class="action-buttons" style="margin-top:12px">
      <button class="btn btn-blue" id="copy-now">Copier</button>
      <button class="btn btn-ghost" id="copy-close">Fermer</button>
    </div>`;
  const ta = cellModal.querySelector('#copy-ta');
  ta.value = text;
  cellOverlay.classList.add('show');
  ta.focus(); ta.select();
  cellModal.querySelector('#copy-now').addEventListener('click', () => {
    ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    try { document.execCommand('copy'); toast('Copié ✓'); } catch { /* rien */ }
  });
  cellModal.querySelector('#copy-close').addEventListener('click', () => cellOverlay.classList.remove('show'));
}

function shiftWeek(delta) {
  const base = new Date(($('rep-from').value || localISO(new Date())) + 'T12:00:00');
  base.setDate(base.getDate() + delta * 7);
  const { monday, sunday } = weekBounds(base);
  $('rep-from').value = localISO(monday);
  $('rep-to').value = localISO(sunday);
  loadReport();
  loadPlanning();
}
$('wk-prev').addEventListener('click', () => shiftWeek(-1));
$('wk-next').addEventListener('click', () => shiftWeek(1));
// Saut direct à une semaine via le calendrier : la date choisie est ramenée au lundi.
$('wk-date').addEventListener('change', () => {
  const v = $('wk-date').value;
  if (!v) return;
  const { monday, sunday } = weekBounds(new Date(v + 'T12:00:00'));
  $('rep-from').value = localISO(monday);
  $('rep-to').value = localISO(sunday);
  loadReport();
  loadPlanning();
});
$('rep-prev').addEventListener('click', () => shiftWeek(-1));
$('rep-next').addEventListener('click', () => shiftWeek(1));

// --- Récapitulatif annuel (vacances scolaires 3 zones, CP, école apprentis) ---
// Vacances scolaires : jours OÙ les élèves sont en vacances, par zone (dates officielles).
const VACANCES = [
  { z: 'ALL', from: '2026-07-04', to: '2026-08-31' }, // Été 2026
  { z: 'ALL', from: '2026-10-17', to: '2026-11-01' }, // Toussaint
  { z: 'ALL', from: '2026-12-19', to: '2027-01-03' }, // Noël
  { z: 'C', from: '2027-02-06', to: '2027-02-21' }, // Hiver C
  { z: 'A', from: '2027-02-13', to: '2027-02-28' }, // Hiver A
  { z: 'B', from: '2027-02-20', to: '2027-03-07' }, // Hiver B
  { z: 'C', from: '2027-04-03', to: '2027-04-18' }, // Printemps C
  { z: 'A', from: '2027-04-10', to: '2027-04-25' }, // Printemps A
  { z: 'B', from: '2027-04-17', to: '2027-05-02' }, // Printemps B
  { z: 'ALL', from: '2027-07-03', to: '2027-08-31' }, // Été 2027
];
function zonesEnVacances(iso) {
  const out = new Set();
  for (const v of VACANCES) {
    if (iso >= v.from && iso <= v.to) {
      if (v.z === 'ALL') { out.add('A'); out.add('B'); out.add('C'); } else out.add(v.z);
    }
  }
  return out;
}
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(year, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
function feriesForYear(year) {
  const easter = easterSunday(year);
  const add = (dt, n) => { const x = new Date(dt); x.setDate(x.getDate() + n); return x; };
  return [
    `${year}-01-01`, `${year}-05-01`, `${year}-05-08`, `${year}-07-14`,
    `${year}-08-15`, `${year}-11-01`, `${year}-11-11`, `${year}-12-25`,
    localISO(add(easter, 1)), localISO(add(easter, 39)), localISO(add(easter, 50)),
  ];
}
const FERIES = new Set([...feriesForYear(2026), ...feriesForYear(2027), ...feriesForYear(2028)]);

let recapCP = new Map(); let recapEcole = new Map(); // jour -> [noms] (pour la fenêtre de détail)
let recapBars = new Map(); // jour -> [{ status, lane }] : périodes ≥ 6 jours (traits)
let recapDots = new Map(); // jour -> [{ status, lane }] : périodes < 6 jours (pastilles)
let recapLabels = new Map(); // 'YYYY-MM-DD' -> [{ text, kind }] (1er jour d'une période)
let recapLayout = { ecLanes: 0, cpLanes: 0, dotLanes: 0, zoneOrder: [] };
let recapOffset = 0; // décalage de la fenêtre, par pas de RECAP_MONTHS
function prevISO(iso) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() - 1); return localISO(d); }
// Découpe un ensemble de jours (triés) en périodes de jours consécutifs.
function consecutiveRuns(daysSet) {
  const sorted = [...daysSet].sort();
  const runs = []; let cur = null;
  for (const d of sorted) {
    if (cur && prevISO(d) === cur[cur.length - 1]) cur.push(d);
    else { cur = [d]; runs.push(cur); }
  }
  return runs;
}
// Affecte une « voie » (colonne) à chaque période pour que deux périodes qui se
// chevauchent dans le temps ne partagent pas la même colonne. Renvoie le nb de voies.
function assignLanes(periods) {
  const sorted = periods.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const laneEnd = [];
  for (const p of sorted) {
    let lane = laneEnd.findIndex((end) => end < p.start);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(p.end); } else laneEnd[lane] = p.end;
    p.lane = lane;
  }
  return laneEnd.length;
}
const RECAP_MONTHS = 6;
const RECAP_MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

async function loadRecap() {
  const out = $('recap-output');
  if (!out) return;
  const base = new Date(); base.setHours(0, 0, 0, 0); base.setDate(1);
  base.setMonth(base.getMonth() + recapOffset);
  const from = localISO(base);
  const to = localISO(new Date(base.getFullYear(), base.getMonth() + RECAP_MONTHS, 0));
  const { ok, data } = await api(`/api/admin/day-statuses?from=${from}&to=${to}`);
  recapCP = new Map(); recapEcole = new Map();
  recapBars = new Map(); recapDots = new Map(); recapLabels = new Map();
  const nameById = new Map(allEmployees.map((e) => [e.id, e.name]));
  const cpByPerson = new Map(); const ecByPerson = new Map(); // empId -> Set(jours)
  if (ok && Array.isArray(data)) {
    for (const s of data) {
      const nm = nameById.get(s.employeeId) || '?';
      if (s.status === 'cp') {
        if (!recapCP.has(s.day)) recapCP.set(s.day, []); recapCP.get(s.day).push(nm);
        if (!cpByPerson.has(s.employeeId)) cpByPerson.set(s.employeeId, new Set()); cpByPerson.get(s.employeeId).add(s.day);
      } else if (s.status === 'ecole') {
        if (!recapEcole.has(s.day)) recapEcole.set(s.day, []); recapEcole.get(s.day).push(nm);
        if (!ecByPerson.has(s.employeeId)) ecByPerson.set(s.employeeId, new Set()); ecByPerson.get(s.employeeId).add(s.day);
      }
    }
  }
  // Construit les périodes (jours consécutifs) par personne et par statut.
  const allRuns = []; // { id, status, days, start, end, len }
  const addRuns = (byPerson, status) => {
    for (const [id, daysSet] of byPerson) {
      for (const days of consecutiveRuns(daysSet)) {
        allRuns.push({ id, status, days, start: days[0], end: days[days.length - 1], len: days.length });
      }
    }
  };
  addRuns(cpByPerson, 'cp'); addRuns(ecByPerson, 'ecole');
  // Voies (colonnes) par statut : toutes les périodes d'un même statut (traits ET
  // pastilles) partagent le même système de colonnes. Ainsi une pastille occupe la
  // colonne où serait le trait (collée aux traits) et deux périodes qui se chevauchent
  // ne se superposent jamais.
  const ecLanes = assignLanes(allRuns.filter((r) => r.status === 'ecole'));
  const cpLanes = assignLanes(allRuns.filter((r) => r.status === 'cp'));
  const addTo = (map, day, o) => { if (!map.has(day)) map.set(day, []); map.get(day).push(o); };
  for (const r of allRuns) {
    const target = r.len >= 6 ? recapBars : recapDots; // ≥ 6 jours => trait ; < 6 => pastille
    for (const d of r.days) addTo(target, d, { status: r.status, lane: r.lane });
  }
  // Étiquette « Nom (CP) » / « Nom (E) » au 1er jour de chaque période (porte la période).
  for (const r of allRuns) {
    const nm = nameById.get(r.id) || '?';
    addTo(recapLabels, r.start, { text: `${nm} (${r.len} ${r.status === 'cp' ? 'CP' : 'E'})`, kind: r.status === 'cp' ? 'cp' : 'ec', name: nm, start: r.start, end: r.end });
  }
  // Zones de vacances présentes dans la fenêtre (pour réserver les colonnes).
  const zonesPresent = new Set();
  { const d = new Date(from + 'T12:00:00'); const end = new Date(to + 'T12:00:00');
    while (d <= end) { for (const z of zonesEnVacances(localISO(d))) zonesPresent.add(z); d.setDate(d.getDate() + 1); } }
  const zoneOrder = ['C', 'B', 'A'].filter((z) => zonesPresent.has(z)); // de l'intérieur vers l'extérieur
  recapLayout = { ecLanes, cpLanes, zoneOrder };
  renderRecap(base);
  const last = new Date(base.getFullYear(), base.getMonth() + RECAP_MONTHS - 1, 1);
  const lbl = $('rc-label');
  if (lbl) lbl.textContent = `${RECAP_MOIS[base.getMonth()]} ${base.getFullYear()} → ${RECAP_MOIS[last.getMonth()]} ${last.getFullYear()}`;
}
$('rc-prev').addEventListener('click', () => { recapOffset -= RECAP_MONTHS; loadRecap(); });
$('rc-next').addEventListener('click', () => { recapOffset += RECAP_MONTHS; loadRecap(); });

function renderRecap(baseMonth) {
  const out = $('recap-output');
  const JJ = ['Di', 'Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa'];
  const MN = ['Janv.', 'Févr.', 'Mars', 'Avril', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
  const months = [];
  for (let i = 0; i < RECAP_MONTHS; i++) months.push(new Date(baseMonth.getFullYear(), baseMonth.getMonth() + i, 1));
  // Disposition des colonnes (de droite à gauche) : statut école, statut CP, zones.
  // Traits et pastilles d'un même statut partagent les mêmes colonnes.
  const W = 5;
  const L = recapLayout;
  const ecBase = 0; const cpBase = L.ecLanes * W;
  const zoneBase = (L.ecLanes + L.cpLanes) * W;
  const zoneOff = {}; L.zoneOrder.forEach((z, i) => { zoneOff[z] = zoneBase + i * W; });
  const padR = zoneBase + L.zoneOrder.length * W + 6;
  const padL = 7;
  const CP_SHADES = ['#f5b700', '#b9860b', '#7a5600'];
  const EC_SHADES = ['#ec4899', '#a21d5c', '#6d1640'];
  const ZONE_COL = { A: '#f47b20', B: '#3b6fb5', C: '#7cb342' };
  const barRight = (b) => (b.status === 'ecole' ? ecBase : cpBase) + b.lane * W;
  const barColor = (b) => (b.status === 'ecole' ? EC_SHADES[b.lane % EC_SHADES.length] : CP_SHADES[b.lane % CP_SHADES.length]);
  let html = `<table class="recap" style="--rc-pl:${padL}px;--rc-pr:${padR}px"><thead><tr>`;
  for (const m of months) html += `<th>${MN[m.getMonth()]}<br>${m.getFullYear()}</th>`;
  html += '</tr></thead><tbody>';
  for (let day = 1; day <= 31; day++) {
    html += '<tr>';
    for (const m of months) {
      const dt = new Date(m.getFullYear(), m.getMonth(), day);
      if (dt.getMonth() !== m.getMonth()) { html += '<td class="rc-empty"></td>'; continue; }
      const iso = localISO(dt);
      const dow = dt.getDay();
      const zones = zonesEnVacances(iso);
      const hasCP = recapCP.has(iso); const hasEc = recapEcole.has(iso);
      const ferie = FERIES.has(iso);
      const we = (dow === 0 || dow === 6) ? ' rc-we' : '';
      // Traits verticaux (droite) : zones scolaires, puis CP/école des périodes ≥ 6 jours.
      let barHtml = '';
      for (const z of L.zoneOrder) if (zones.has(z)) barHtml += `<i class="rc-b" style="right:${zoneOff[z]}px;background:${ZONE_COL[z]}"></i>`;
      for (const b of (recapBars.get(iso) || [])) barHtml += `<i class="rc-b" style="right:${barRight(b)}px;background:${barColor(b)}"></i>`;
      // Pastilles (périodes < 6 jours) : même colonne que le trait du même statut.
      let dotHtml = '';
      for (const d of (recapDots.get(iso) || [])) dotHtml += `<i class="rc-dot" style="right:${barRight(d)}px;background:${d.status === 'ecole' ? EC_SHADES[0] : CP_SHADES[0]}"></i>`;
      // Étiquettes « Nom (CP)/(E) » au 1er jour de période (cliquables → période complète).
      const labels = recapLabels.get(iso);
      const lblHtml = labels
        ? labels.map((l) => `<span class="rc-lbl rc-lbl-${l.kind} rc-lbl-click" data-name="${escapeHtml(l.name)}" data-kind="${l.kind}" data-start="${l.start}" data-end="${l.end}">${escapeHtml(l.text)}</span>`).join('')
        : '';
      const click = (hasCP || hasEc) ? ' rc-click' : '';
      html += `<td class="rc-day${we}${ferie ? ' rc-ferie' : ''}${click}" data-day="${iso}">`
        + `<span class="rc-num">${day}</span><span class="rc-dow">${JJ[dow]}</span>`
        + lblHtml + dotHtml + barHtml + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  out.innerHTML = html;
  out.querySelectorAll('.rc-click').forEach((td) => td.addEventListener('click', () => openRecapDay(td.dataset.day)));
  out.querySelectorAll('.rc-lbl-click').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    openRecapPeriod(el.dataset.name, el.dataset.kind, el.dataset.start, el.dataset.end);
  }));
}

function openRecapPeriod(name, kind, start, end) {
  const statut = kind === 'cp' ? 'Congés payés' : 'École (apprenti)';
  const icon = kind === 'cp' ? '🟡' : '🌸';
  const nbJours = Math.round((new Date(end + 'T12:00:00') - new Date(start + 'T12:00:00')) / 86400000) + 1;
  const periode = start === end ? `le ${frDate(start)}` : `du ${frDate(start)} au ${frDate(end)}`;
  cellModal.innerHTML = `
    <h2>${escapeHtml(name)}</h2>
    <div class="field"><label>${icon} ${statut}</label>
      <div class="sub">Période : ${periode}</div>
      <div class="sub">${nbJours} jour${nbJours > 1 ? 's' : ''}</div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-ghost" id="rc-close">Fermer</button></div>`;
  cellModal.querySelector('#rc-close').addEventListener('click', () => cellOverlay.classList.remove('show'));
  cellOverlay.classList.add('show');
}

function openRecapDay(iso) {
  const cp = recapCP.get(iso) || []; const ec = recapEcole.get(iso) || [];
  const dt = new Date(iso + 'T12:00:00');
  let lbl = dt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  lbl = lbl.charAt(0).toUpperCase() + lbl.slice(1);
  cellModal.innerHTML = `
    <h2>${lbl}</h2>
    ${cp.length ? `<div class="field"><label>🟡 Congés payés (${cp.length})</label><div class="sub">${cp.map(escapeHtml).join(', ')}</div></div>` : ''}
    ${ec.length ? `<div class="field" style="margin-top:10px"><label>🌸 École — apprentis (${ec.length})</label><div class="sub">${ec.map(escapeHtml).join(', ')}</div></div>` : ''}
    ${(!cp.length && !ec.length) ? '<div class="sub">Aucun CP ni école ce jour.</div>' : ''}
    <div style="margin-top:14px"><button class="btn btn-ghost" id="rc-close">Fermer</button></div>`;
  cellModal.querySelector('#rc-close').addEventListener('click', () => cellOverlay.classList.remove('show'));
  cellOverlay.classList.add('show');
}

// --- Hors entreprise : statut sur toute la semaine (CP/AM/Absent/École) ----
$('he-btn').addEventListener('click', openOffWork);

function openOffWork() {
  const from = $('rep-from').value; const to = $('rep-to').value;
  if (!from || !to) return;
  const list = allEmployees.filter((e) => e.active || (e.endDate && e.endDate >= from))
    .map((e) => `<label class="grp-row"><input type="checkbox" class="he-emp" value="${e.id}"> ${escapeHtml(e.name)}</label>`).join('');
  cellModal.innerHTML = `
    <h2>Hors entreprise</h2>
    <div class="sub">Applique un statut sur toute la semaine du ${frDate(from)} au ${frDate(to)}.</div>
    <div class="field">
      <label for="he-status">Statut</label>
      <select id="he-status">
        <option value="cp">Congés payés</option>
        <option value="am">Arrêt maladie</option>
        <option value="absent">Absent</option>
        <option value="ecole">École (apprentis)</option>
      </select>
    </div>
    <div class="grp-list">${list}</div>
    <div class="msg error" id="he-msg"></div>
    <div class="action-buttons" style="margin-top:12px">
      <button class="btn btn-blue" id="he-save">Appliquer à la semaine</button>
      <button class="btn btn-ghost" id="he-cancel">Annuler</button>
    </div>`;
  cellModal.querySelector('#he-save').addEventListener('click', submitOffWork);
  cellModal.querySelector('#he-cancel').addEventListener('click', () => cellOverlay.classList.remove('show'));
  cellOverlay.classList.add('show');
}

async function submitOffWork() {
  const from = $('rep-from').value; const to = $('rep-to').value;
  const status = cellModal.querySelector('#he-status').value;
  const ids = [...cellModal.querySelectorAll('.he-emp:checked')].map((c) => Number(c.value));
  const msg = (m) => { const el = $('he-msg'); el.textContent = m; el.className = 'msg show error'; };
  if (!ids.length) return msg('Cochez au moins une personne.');
  const { ok, data } = await api('/api/admin/day-status/range', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeIds: ids, from, to, status }),
  });
  if (!ok) { msg((data && data.error) || 'Erreur'); return; }
  if (data.skippedEcole) alert(`${data.skippedEcole} non-apprenti(s) ignoré(s) pour le statut École.`);
  cellOverlay.classList.remove('show');
  loadPlanning();
  loadRecap();
}

// --- Arrivée groupée (admin, jour choisi dans la semaine) -----------------
$('grp-btn').addEventListener('click', openGroupArrival);

// Salariés éligibles à l'arrivée groupée un jour donné : actifs, PAS en repos,
// SANS arrivée déjà saisie, et SANS statut (CP/AM/École/Absent) ce jour-là.
function eligibleForGroup(d) {
  const byId = new Map((planningReport || []).map((e) => [e.employeeId, e]));
  const wd = new Date(d + 'T12:00:00').getDay();
  return allEmployees.filter((e) => {
    if (!e.active && !(e.endDate && e.endDate >= d)) return false;
    if (restDaysOn(e.restPeriods, d).includes(wd)) return false;
    if (statusMap.has(e.id + '|' + d)) return false;
    const rep = byId.get(e.id);
    const day = rep && rep.days.find((x) => x.day === d);
    if (day && day.segments.length) {
      // Exclu seulement si la journée est DÉJÀ COMPLÈTE (midi ET soir).
      // Les demi-journées restent proposables pour compléter l'autre service.
      const { cont, midi, soir } = classifyDay(day.segments);
      const hasMidi = cont.length || midi.length;
      const hasSoir = cont.length || soir.length;
      if (hasMidi && hasSoir) return false;
    }
    return true;
  });
}

function openGroupArrival() {
  const from = $('rep-from').value; const to = $('rep-to').value;
  if (!from || !to) return;
  const days = daysBetween(from, to);
  const today = localISO(new Date());
  const defaultDay = days.includes(today) ? today : days[0];
  const jj = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const dayOpts = days.map((d) => {
    const dt = new Date(d + 'T12:00:00');
    return `<option value="${d}" ${d === defaultDay ? 'selected' : ''}>${jj[dt.getDay()]} ${frDate(d)}</option>`;
  }).join('');
  cellModal.innerHTML = `
    <h2>Arrivée groupée</h2>
    <div class="field"><label for="grp-day">Jour</label><select id="grp-day">${dayOpts}</select></div>
    <div class="field" style="margin-bottom:6px">
      <label for="grp-time">Heure d'arrivée</label>
      <input type="time" id="grp-time" value="11:50">
      <div class="preset-chips" id="grp-chips"></div>
    </div>
    <div class="grp-list" id="grp-list"></div>
    <div class="msg error" id="grp-msg"></div>
    <div class="action-buttons" style="margin-top:12px">
      <button class="btn btn-green" id="grp-save">Enregistrer l'arrivée</button>
      <button class="btn btn-ghost" id="grp-cancel">Annuler</button>
    </div>`;
  fillChips(cellModal.querySelector('#grp-chips'), ['11:50', '18:00', '18:50'], cellModal.querySelector('#grp-time'));
  const daySel = cellModal.querySelector('#grp-day');
  const refreshList = () => {
    const list = cellModal.querySelector('#grp-list');
    const elig = eligibleForGroup(daySel.value);
    if (!elig.length) {
      list.innerHTML = '<div class="sub" style="padding:8px 4px">Personne à proposer : tout le monde a déjà une arrivée, est en repos ou absent ce jour.</div>';
      return;
    }
    list.innerHTML = '<label class="grp-row grp-all"><input type="checkbox" id="grp-all"> <strong>Tout sélectionner</strong></label>'
      + elig.map((e) => `<label class="grp-row"><input type="checkbox" class="grp-emp" value="${e.id}"> ${escapeHtml(e.name)}</label>`).join('');
    const allCb = list.querySelector('#grp-all');
    const indiv = [...list.querySelectorAll('.grp-emp')];
    allCb.addEventListener('change', () => { indiv.forEach((c) => { c.checked = allCb.checked; }); });
    indiv.forEach((c) => c.addEventListener('change', () => { allCb.checked = indiv.every((x) => x.checked); }));
  };
  daySel.addEventListener('change', refreshList);
  refreshList();
  cellModal.querySelector('#grp-save').addEventListener('click', submitGroupArrival);
  cellModal.querySelector('#grp-cancel').addEventListener('click', () => cellOverlay.classList.remove('show'));
  cellOverlay.classList.add('show');
}

async function submitGroupArrival() {
  const date = cellModal.querySelector('#grp-day').value;
  const start = cellModal.querySelector('#grp-time').value;
  const ids = [...cellModal.querySelectorAll('.grp-emp:checked')].map((c) => Number(c.value));
  const msg = (m) => { const el = $('grp-msg'); el.textContent = m; el.className = 'msg show error'; };
  if (!date || !start) return msg("Choisissez le jour et l'heure.");
  if (!ids.length) return msg('Cochez au moins une personne.');
  const { ok, data } = await api('/api/entries/bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeIds: ids, date, start }),
  });
  if (!ok) { msg((data && data.error) || 'Erreur'); return; }
  cellOverlay.classList.remove('show');
  loadPlanning();
}

$('pdf-btn').addEventListener('click', () => {
  // Le nom par défaut du PDF = titre de la page → on y met les dates de la semaine.
  const from = $('rep-from').value;
  const to = $('rep-to').value;
  const fr = (iso) => (iso || '').split('-').reverse().join('-'); // 2026-05-25 → 25-05-2026
  const prev = document.title;
  document.title = (from && to) ? `Planning ${fr(from)} au ${fr(to)}` : 'Planning';
  window.addEventListener('afterprint', () => { document.title = prev; }, { once: true });
  window.print();
});

// --- Éditeur de case du planning ------------------------------------------
// Raccourcis d'horaires d'arrivée proposés dans l'éditeur de case (deux services).
// Les départs se saisissent manuellement (pas de raccourcis).
const ARR_MORNING = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:50'];
const ARR_EVENING = ['17:00', '17:30', '18:00', '18:50'];

// Sélecteurs d'heure défilants : heures de 8h à 2h (en passant par la nuit), minutes 00/15/30/45/50.
const HOUR_ORDER = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2];
const MIN_OPTIONS = ['00', '15', '30', '45', '50'];
function timeSelect(cls, id, value) {
  let hh = '', mm = '';
  if (value && /^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(':');
    hh = String(parseInt(h, 10)); mm = m;
  }
  const hOpts = ['<option value="">--</option>']
    .concat(HOUR_ORDER.map((h) => `<option value="${h}"${String(h) === hh ? ' selected' : ''}>${String(h).padStart(2, '0')}h</option>`))
    .join('');
  const mOpts = ['<option value="">--</option>']
    .concat(MIN_OPTIONS.map((m) => `<option value="${m}"${m === mm ? ' selected' : ''}>${m}</option>`))
    .join('');
  return `<span class="time-sel"><select class="${cls}-h" data-id="${id}">${hOpts}</select><span class="time-colon">:</span><select class="${cls}-m" data-id="${id}">${mOpts}</select></span>`;
}
function readTimeSel(scope, cls, id) {
  const hSel = scope.querySelector(`.${cls}-h[data-id="${id}"]`);
  const mSel = scope.querySelector(`.${cls}-m[data-id="${id}"]`);
  const h = hSel ? hSel.value : '';
  const m = mSel ? mSel.value : '';
  if (!h && !m) return '';
  return `${String(h || 0).padStart(2, '0')}:${m || '00'}`;
}

function fillChips(container, presets, input) {
  if (!container) return;
  container.innerHTML = presets.map((t) => `<button type="button" class="chip" data-t="${t}">${t}</button>`).join('');
  container.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => {
      input.value = c.dataset.t;
      container.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
    });
  });
}

const cellOverlay = $('cell-overlay');
const cellModal = $('cell-modal');
function closeCellEditor() { cellOverlay.classList.remove('show'); }
cellOverlay.addEventListener('click', (e) => { if (e.target === cellOverlay) closeCellEditor(); });

function openCellEditor(empId, day) {
  const emp = allEmployees.find((e) => e.id === empId);
  if (!emp) return;
  const rep = (planningReport || []).find((e) => e.employeeId === empId);
  const dayData = rep && rep.days.find((x) => x.day === day);
  const status = statusMap.get(empId + '|' + day);
  const isApprenti = catOf(emp) === 'apprenti';

  let existingHtml = '';
  if (dayData && dayData.segments.length) {
    existingHtml = '<div class="cell-existing"><div style="font-weight:600;margin-bottom:6px">Horaires saisis</div>';
    for (const s of dayData.segments) {
      existingHtml += `<div class="seg-edit">
        <label>Arrivée</label>${timeSelect('seg-start', s.id, fmtTime(s.clockIn))}
        <label>Départ</label>${timeSelect('seg-end', s.id, s.open ? '' : fmtTime(s.clockOut))}
        <button class="link-btn seg-save" data-id="${s.id}">Enregistrer</button>
        <button class="link-btn danger seg-del" data-id="${s.id}">Supprimer</button>
      </div>`;
    }
    existingHtml += '</div>';
  }
  const statusLine = status ? `<div class="sub">Statut actuel : <strong>${STATUS_FULL[status]}</strong></div>` : '';

  cellModal.innerHTML = `
    <h2>${escapeHtml(emp.name)}</h2>
    <div class="sub">${planningDayLabel(day).replace('<br>', ' ')}</div>
    ${statusLine}
    ${existingHtml}
    <div class="field" style="margin-top:14px"><label>Marquer la journée</label></div>
    <div class="action-buttons" style="grid-template-columns:repeat(2,1fr)">
      <button class="btn btn-ghost st-btn st-repos${status === 'repos' ? ' active' : ''}" data-st="repos">Repos</button>
      <button class="btn btn-ghost st-btn st-cp${status === 'cp' ? ' active' : ''}" data-st="cp">Congés payés</button>
      <button class="btn btn-ghost st-btn st-am${status === 'am' ? ' active' : ''}" data-st="am">Arrêt maladie</button>
      <button class="btn btn-ghost st-btn st-absent${status === 'absent' ? ' active' : ''}" data-st="absent">Absent</button>
      ${isApprenti ? `<button class="btn btn-ghost st-btn st-ecole${status === 'ecole' ? ' active' : ''}" data-st="ecole">École</button>` : ''}
      <button class="btn btn-ghost st-btn st-demi${status === 'demi_midi' ? ' active' : ''}" data-st="demi_midi">Demi midi</button>
      <button class="btn btn-ghost st-btn st-demi${status === 'demi_soir' ? ' active' : ''}" data-st="demi_soir">Demi soir</button>
      <button class="btn btn-ghost ech-btn st-echange${(status === 'echange_midi' || status === 'echange_both') ? ' active' : ''}" data-ech="midi">Échange midi</button>
      <button class="btn btn-ghost ech-btn st-echange${(status === 'echange_soir' || status === 'echange_both') ? ' active' : ''}" data-ech="soir">Échange soir</button>
      ${status ? '<button class="btn btn-ghost" id="ce-clear">Effacer le statut</button>' : ''}
    </div>
    <div class="field" style="margin-top:18px"><label>Ou ajouter des horaires (un ou deux services)</label></div>
    <div class="shift-block">
      <div class="shift-title">☀️ Service du matin / midi</div>
      <div class="field"><label for="ce-start1">Arrivée</label><input type="time" id="ce-start1"><div class="preset-chips" id="ce-arr1"></div></div>
      <div class="field" style="margin-top:8px"><label for="ce-end1">Départ</label><input type="time" id="ce-end1"></div>
    </div>
    <div class="shift-block">
      <div class="shift-title">🌙 Service du soir</div>
      <div class="field"><label for="ce-start2">Arrivée</label><input type="time" id="ce-start2"><div class="preset-chips" id="ce-arr2"></div></div>
      <div class="field" style="margin-top:8px"><label for="ce-end2">Départ</label><input type="time" id="ce-end2"></div>
    </div>
    <button class="btn btn-green" id="ce-add" style="width:100%">Ajouter ces horaires</button>
    <div class="msg error" id="ce-msg"></div>
    <div style="margin-top:14px"><button class="btn btn-ghost" id="ce-close">Fermer</button></div>
  `;

  fillChips(cellModal.querySelector('#ce-arr1'), ARR_MORNING, cellModal.querySelector('#ce-start1'));
  fillChips(cellModal.querySelector('#ce-arr2'), ARR_EVENING, cellModal.querySelector('#ce-start2'));

  cellModal.querySelector('#ce-add').addEventListener('click', async () => {
    const shifts = [
      { label: 'matin', s: cellModal.querySelector('#ce-start1').value, e: cellModal.querySelector('#ce-end1').value },
      { label: 'soir', s: cellModal.querySelector('#ce-start2').value, e: cellModal.querySelector('#ce-end2').value },
    ];
    const toAdd = [];
    for (const sh of shifts) {
      if (!sh.s && !sh.e) continue; // service non renseigné → ignoré
      if (!sh.s) { cellMsg(`Service du ${sh.label} : renseignez au moins l'arrivée.`); return; }
      toAdd.push(sh); // le départ est facultatif (période laissée ouverte)
    }
    if (!toAdd.length) { cellMsg('Renseignez au moins une arrivée.'); return; }
    for (const sh of toAdd) {
      const { ok, data } = await api('/api/admin/entries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: empId, date: day, start: sh.s, end: sh.e || undefined }),
      });
      if (!ok) { cellMsg(`Service du ${sh.label} : ${(data && data.error) || 'erreur'}`); return; }
    }
    await refreshAfterCell(empId, day);
  });

  cellModal.querySelectorAll('.seg-save').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const start = readTimeSel(cellModal, 'seg-start', id);
      const end = readTimeSel(cellModal, 'seg-end', id);
      if (!start) { cellMsg("L'heure d'arrivée est obligatoire."); return; }
      const { ok, data } = await api(`/api/admin/entries/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start, end }),
      });
      if (!ok) { cellMsg((data && data.error) || 'Erreur'); return; }
      await refreshAfterCell(empId, day);
    });
  });
  cellModal.querySelectorAll('.seg-del').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Supprimer cette ligne d\'horaire ?')) return;
      const { ok, data } = await api(`/api/admin/entries/${b.dataset.id}`, { method: 'DELETE' });
      if (!ok) { cellMsg((data && data.error) || 'Erreur'); return; }
      await refreshAfterCell(empId, day);
    });
  });
  cellModal.querySelectorAll('.st-btn').forEach((b) => {
    // Clic sur le statut déjà actif => on l'enlève (bascule), comme les boutons Échange.
    b.addEventListener('click', () => setCellStatus(empId, day, status === b.dataset.st ? null : b.dataset.st));
  });
  cellModal.querySelectorAll('.ech-btn').forEach((b) => {
    b.addEventListener('click', () => toggleEchange(empId, day, b.dataset.ech));
  });
  const clearBtn = cellModal.querySelector('#ce-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => setCellStatus(empId, day, null));
  cellModal.querySelector('#ce-close').addEventListener('click', closeCellEditor);
  cellOverlay.classList.add('show');
}

function cellMsg(m) { const el = $('ce-msg'); if (el) { el.textContent = m; el.classList.add('show'); } }

// Bascule l'échange d'un service (midi/soir). Les deux peuvent coexister (echange_both).
function toggleEchange(empId, day, service) {
  const cur = statusMap.get(empId + '|' + day);
  let m = (cur === 'echange_midi' || cur === 'echange_both');
  let s = (cur === 'echange_soir' || cur === 'echange_both');
  if (service === 'midi') m = !m; else s = !s;
  let next = null;
  if (m && s) next = 'echange_both';
  else if (m) next = 'echange_midi';
  else if (s) next = 'echange_soir';
  setCellStatus(empId, day, next);
}

async function setCellStatus(empId, day, status) {
  const { ok, data } = await api('/api/admin/day-status', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: empId, date: day, status }),
  });
  if (!ok) { cellMsg((data && data.error) || 'Erreur'); return; }
  await refreshAfterCell(empId, day);
}

async function refreshAfterCell(empId, day) {
  await loadPlanning();
  loadReport();
  loadRecap();
  openCellEditor(empId, day); // ré-ouvre avec les données à jour
}

// --- Mot de passe ---------------------------------------------------------
$('pwd-btn').addEventListener('click', async () => {
  clearMsg($('pwd-msg'));
  const current = $('cur-pwd').value;
  const next = $('new-pwd').value;
  const { ok, data } = await api('/api/admin/password', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current, next }),
  });
  if (ok) {
    showMsg($('pwd-msg'), 'Mot de passe modifié avec succès.', 'success');
    $('cur-pwd').value = ''; $('new-pwd').value = '';
  } else showMsg($('pwd-msg'), (data && data.error) || 'Erreur');
});

// --- Nom de l'établissement (si plusieurs sites) --------------------------
async function applyEstablishment() {
  try {
    const { data } = await api('/api/config');
    if (data && data.establishment) {
      document.title = data.establishment + ' — Administration';
    }
  } catch { /* ignore */ }
}

// --- Init -----------------------------------------------------------------
applyEstablishment();
checkAuth();

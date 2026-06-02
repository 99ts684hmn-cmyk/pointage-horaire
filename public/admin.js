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
function fmtDay(dayStr) {
  return new Date(dayStr + 'T12:00:00').toLocaleDateString('fr-FR',
    { weekday: 'short', day: 'numeric', month: 'short' });
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
const CAT_PLURAL = { responsable: 'Responsables', chef_de_rang: 'Chefs de rang', apprenti: 'Apprentis' };
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
      <td><span class="tag ${emp.active ? 'active' : 'inactive'}">${emp.active ? 'Actif' : 'Inactif'}</span></td>
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
    await api(`/api/admin/employees/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !active }),
    });
    loadEmployees();
  }
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
  // Date d'effet par défaut : lundi de la semaine prochaine (le futur n'altère pas le passé/présent).
  const nm = weekBounds(new Date()).monday; nm.setDate(nm.getDate() + 7);
  const nextMonday = localISO(nm);
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
      <input type="date" id="pf-from" value="${nextMonday}">
      <div class="sub" style="font-size:.78rem;margin-top:4px">Laissez cette date pour ne pas modifier les semaines passées ou en cours.</div>
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

async function loadReport() {
  const out = $('report-output');
  const { from, to, params } = reportQuery();
  if (!from || !to) { out.innerHTML = '<div class="empty">Choisissez une période.</div>'; return; }

  const { ok, data } = await api('/api/admin/report?' + params.toString());
  if (!ok) { out.innerHTML = '<div class="empty">Erreur lors du chargement.</div>'; return; }
  if (!data.length) { out.innerHTML = '<div class="empty">Aucun pointage sur cette période.</div>'; return; }

  // Grille lisible (comme le planning) : salariés × jours, heures NETTES + total.
  const days = daysBetween(from, to);
  const orderIndex = new Map(allEmployees.map((e, i) => [e.id, i]));
  data.sort((a, b) => (orderIndex.get(a.employeeId) ?? 999) - (orderIndex.get(b.employeeId) ?? 999));

  let html = '<table class="planning"><thead><tr><th class="pl-name">Salarié</th>';
  for (const d of days) html += `<th>${planningDayLabel(d)}</th>`;
  html += '<th style="text-align:right">Total</th></tr></thead><tbody>';

  const dayTot = {}; days.forEach((d) => { dayTot[d] = 0; }); let grand = 0;
  for (const emp of data) {
    const byDay = new Map(emp.days.map((x) => [x.day, x.seconds]));
    html += `<tr><td class="pl-name">${escapeHtml(emp.name)}</td>`;
    for (const d of days) {
      const sec = byDay.get(d) || 0;
      dayTot[d] += sec;
      html += `<td>${sec ? fmtH(sec) : '—'}</td>`;
    }
    grand += emp.totalSeconds;
    html += `<td class="pl-total">${fmtH(emp.totalSeconds)}</td></tr>`;
  }
  html += '<tr class="pl-tot-row"><td class="pl-name">Total / jour</td>';
  for (const d of days) html += `<td>${dayTot[d] ? fmtH(dayTot[d]) : '—'}</td>`;
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
const STATUS_SHORT = { cp: 'CP', am: 'AM', ecole: 'École', absent: 'Abs', repos: 'Repos' };
const STATUS_FULL = { cp: 'Congés payés', am: 'Arrêt maladie', ecole: 'École', absent: 'Absent', repos: 'Repos' };

async function loadPlanning() {
  const from = $('rep-from').value;
  const to = $('rep-to').value;
  if (!from || !to) { renderPlanning(); return; }
  const params = new URLSearchParams({ from, to });
  const [rep, st] = await Promise.all([
    api('/api/admin/report?' + params.toString()),
    api('/api/admin/day-statuses?' + params.toString()),
  ]);
  planningReport = (rep.ok && rep.data) ? rep.data : [];
  statusMap = new Map();
  if (st.ok && Array.isArray(st.data)) {
    for (const s of st.data) statusMap.set(s.employeeId + '|' + s.day, s.status);
  }
  renderPlanning();
}

function renderPlanning() {
  const out = $('planning-output');
  const from = $('rep-from').value;
  const to = $('rep-to').value;
  const lbl = $('wk-label');
  if (lbl) lbl.textContent = (from && to) ? `du ${frDate(from)} au ${frDate(to)}` : '';
  if (!from || !to) { out.innerHTML = '<div class="empty">Choisissez une semaine.</div>'; return; }

  const days = daysBetween(from, to);
  const byId = new Map((planningReport || []).map((e) => [e.employeeId, e]));
  const actives = allEmployees.filter((e) => e.active);
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
  const colspan = days.length + 2;

  // Première personne à arriver pour chaque service (par jour), hors service continu.
  const firstMidi = {}; const firstSoir = {};
  for (const d of days) {
    let bmId = null; let bmT = Infinity; let bsId = null; let bsT = Infinity;
    for (const emp of actives) {
      const rep = byId.get(emp.id);
      const day = rep && rep.days.find((x) => x.day === d);
      if (!day || !day.segments.length) continue;
      const { cont, midi, soir } = classifyDay(day.segments);
      if (emp.continuous || cont.length) continue;
      for (const s of midi) if (s.clockIn < bmT) { bmT = s.clockIn; bmId = emp.id; }
      for (const s of soir) if (s.clockIn < bsT) { bsT = s.clockIn; bsId = emp.id; }
    }
    firstMidi[d] = bmId; firstSoir[d] = bsId;
  }

  for (const emp of actives) {
      const rep = byId.get(emp.id);
      html += `<tr><td class="pl-name">${escapeHtml(emp.name)}</td>`;
      for (const d of days) {
        const day = rep && rep.days.find((x) => x.day === d);
        const status = statusMap.get(emp.id + '|' + d);
        // Repos = motif récurrent du jour OU repos ponctuel (statut, ex. apprentis).
        const isRest = restDaysOn(emp.restPeriods, d).includes(weekday[d]) || status === 'repos';
        const parts = [];
        if (isRest) parts.push('<span class="pl-rest-lbl">Repos</span>');
        if (status && status !== 'repos') parts.push(`<span class="pl-badge st-${status}">${STATUS_SHORT[status]}</span>`);
        if (day && day.segments.length) {
          const fmt = (s) => `${fmtTime(s.clockIn)}–${s.open ? '…' : fmtTime(s.clockOut)}`;
          const { cont, midi, soir } = classifyDay(day.segments);
          const isCont = emp.continuous || cont.length > 0;
          const lines = [];
          if (isCont) {
            // Service continu → bloc rouge, compté midi + soir.
            lines.push(`<span class="pl-hours pl-cont">${day.segments.map(fmt).join('<br>')}</span>`);
            midiCount[d]++; soirCount[d]++;
          } else {
            // Moitié midi (jaune si 1er arrivé du midi, sinon « demi » grisé).
            if (midi.length) {
              lines.push(`<span class="pl-hours${emp.id === firstMidi[d] ? ' pl-first' : ''}">${midi.map(fmt).join('<br>')}</span>`);
              midiCount[d]++;
            } else lines.push('<span class="pl-demi">demi</span>');
            // Moitié soir (jaune si 1er arrivé du soir, sinon « demi » grisé).
            if (soir.length) {
              lines.push(`<span class="pl-hours${emp.id === firstSoir[d] ? ' pl-open' : ''}">${soir.map(fmt).join('<br>')}</span>`);
              soirCount[d]++;
            } else lines.push('<span class="pl-demi">demi</span>');
          }
          parts.push(lines.join(''));
          dayTotals[d] += day.seconds;
        }
        const inner = parts.length ? parts.join('<br>') : '<span class="pl-empty">+</span>';
        const cls = 'pl-cell pl-click' + (isRest ? ' pl-rest' : '');
        html += `<td class="${cls}" data-emp="${emp.id}" data-day="${d}">${inner}</td>`;
      }
      const tot = rep ? rep.totalSeconds : 0;
      grand += tot;
      html += `<td class="pl-total">${fmtH(tot)}</td></tr>`;
  }

  // Nombre de présents par service (par jour).
  html += '<tr class="pl-svc-row"><td class="pl-name">Présents midi (9h–14h)</td>';
  for (const d of days) html += `<td>${midiCount[d] || '—'}</td>`;
  html += '<td></td></tr>';
  html += '<tr class="pl-svc-row"><td class="pl-name">Présents soir (18h–21h)</td>';
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
}

// Copie « Nom : heures d'arrivée » pour le jour cliqué.
function copyDayArrivals(d) {
  const byId = new Map((planningReport || []).map((e) => [e.employeeId, e]));
  const rows = [];
  for (const emp of allEmployees.filter((e) => e.active)) {
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
$('rep-prev').addEventListener('click', () => shiftWeek(-1));
$('rep-next').addEventListener('click', () => shiftWeek(1));
// --- Hors entreprise : statut sur toute la semaine (CP/AM/Absent/École) ----
$('he-btn').addEventListener('click', openOffWork);

function openOffWork() {
  const from = $('rep-from').value; const to = $('rep-to').value;
  if (!from || !to) return;
  const list = allEmployees.filter((e) => e.active)
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
}

// --- Arrivée groupée (admin, jour choisi dans la semaine) -----------------
$('grp-btn').addEventListener('click', openGroupArrival);

// Salariés éligibles à l'arrivée groupée un jour donné : actifs, PAS en repos,
// SANS arrivée déjà saisie, et SANS statut (CP/AM/École/Absent) ce jour-là.
function eligibleForGroup(d) {
  const byId = new Map((planningReport || []).map((e) => [e.employeeId, e]));
  const wd = new Date(d + 'T12:00:00').getDay();
  return allEmployees.filter((e) => {
    if (!e.active) return false;
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
    const elig = eligibleForGroup(daySel.value);
    cellModal.querySelector('#grp-list').innerHTML = elig.length
      ? elig.map((e) => `<label class="grp-row"><input type="checkbox" class="grp-emp" value="${e.id}"> ${escapeHtml(e.name)}</label>`).join('')
      : '<div class="sub" style="padding:8px 4px">Personne à proposer : tout le monde a déjà une arrivée, est en repos ou absent ce jour.</div>';
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
        <label>Arrivée</label><input type="time" class="seg-start" data-id="${s.id}" value="${fmtTime(s.clockIn)}">
        <label>Départ</label><input type="time" class="seg-end" data-id="${s.id}" value="${s.open ? '' : fmtTime(s.clockOut)}">
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
    <div class="field" style="margin-top:14px"><label>Ajouter des horaires (un ou deux services)</label></div>
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
    <div class="field" style="margin-top:8px"><label>Ou marquer la journée</label></div>
    <div class="action-buttons" style="grid-template-columns:repeat(2,1fr)">
      <button class="btn btn-ghost st-btn st-repos" data-st="repos">Repos</button>
      <button class="btn btn-ghost st-btn st-cp" data-st="cp">Congés payés</button>
      <button class="btn btn-ghost st-btn st-am" data-st="am">Arrêt maladie</button>
      <button class="btn btn-ghost st-btn st-absent" data-st="absent">Absent</button>
      ${isApprenti ? '<button class="btn btn-ghost st-btn st-ecole" data-st="ecole">École</button>' : ''}
      ${status ? '<button class="btn btn-ghost" id="ce-clear">Effacer le statut</button>' : ''}
    </div>
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
      const start = cellModal.querySelector(`.seg-start[data-id="${id}"]`).value;
      const end = cellModal.querySelector(`.seg-end[data-id="${id}"]`).value;
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
    b.addEventListener('click', () => setCellStatus(empId, day, b.dataset.st));
  });
  const clearBtn = cellModal.querySelector('#ce-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => setCellStatus(empId, day, null));
  cellModal.querySelector('#ce-close').addEventListener('click', closeCellEditor);
  cellOverlay.classList.add('show');
}

function cellMsg(m) { const el = $('ce-msg'); if (el) { el.textContent = m; el.classList.add('show'); } }

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

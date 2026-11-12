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
// Rythme (demi + continue) applicable à une date : même règle que les repos.
function scheduleOn(periods, dateStr) {
  let best = null;
  for (const p of (periods || [])) if (p.from <= dateStr && (!best || p.from > best.from)) best = p;
  return best;
}

// Lundi et dimanche de la semaine calendaire contenant la date donnée.
function weekBounds(date) {
  const dow = date.getDay(); // 0 = dimanche, 1 = lundi, …
  const toMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - toMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { monday, sunday };
}

// Préfixe des appels API = dossier de la page courante. L'appli fonctionne
// ainsi qu'elle soit servie à la racine (port propre) OU montée sous /cuisine
// dans le pointage (la page est alors /cuisine/ → API_BASE = '/cuisine').
const API_BASE = location.pathname.replace(/\/[^/]*$/, '');
async function api(url, opts) {
  const res = await fetch(API_BASE + url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* vide */ }
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
  await loadEstablishment();
  // Semaine par défaut : semaine calendaire en cours (lundi → dimanche).
  const { monday, sunday } = weekBounds(new Date());
  $('rep-from').value = localISO(monday);
  $('rep-to').value = localISO(sunday);
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
const CAT_LABELS = { chef: 'Chef', manager: 'Manager', chef_de_partie: 'Chef de partie', cuisinier: 'Cuisinier', apprenti: 'Apprenti', plongeur: 'Plongeur' };
const CAT_ORDER = ['chef', 'manager', 'chef_de_partie', 'cuisinier', 'apprenti', 'plongeur'];
const catOf = (e) => (CAT_ORDER.includes(e.category) ? e.category : 'cuisinier');

async function loadEmployees() {
  const { data } = await api('/api/admin/employees');
  allEmployees = data || [];
  const tbody = $('emp-tbody');
  tbody.innerHTML = '';

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

// --- Profil salarié (repos, demi-journée, journée continue, postes) --------
const DOW_FULL = [{ n: 1, l: 'Lundi' }, { n: 2, l: 'Mardi' }, { n: 3, l: 'Mercredi' }, { n: 4, l: 'Jeudi' },
  { n: 5, l: 'Vendredi' }, { n: 6, l: 'Samedi' }, { n: 0, l: 'Dimanche' }];
const SCHED_KINDS = [
  { k: 'demi', l: 'Demi', full: 'Demi-journée' },
  { k: 'cont', l: 'Continue', full: 'Journée continue' },
];
const DOW = [{ n: 1, l: 'Lun' }, { n: 2, l: 'Mar' }, { n: 3, l: 'Mer' }, { n: 4, l: 'Jeu' },
  { n: 5, l: 'Ven' }, { n: 6, l: 'Sam' }, { n: 0, l: 'Dim' }];
const profileOverlay = $('profile-overlay');
const profileModal = $('profile-modal');
profileOverlay.addEventListener('click', (e) => { if (e.target === profileOverlay) profileOverlay.classList.remove('show'); });

function openProfile(empId) {
  const emp = allEmployees.find((e) => e.id === empId);
  if (!emp) return;
  // Date d'effet par défaut : lundi de la semaine EN COURS, pour qu'un changement
  // s'applique immédiatement. Si un changement est déjà programmé plus tard, c'est
  // lui qu'on affiche (et sa date qu'on propose) : on ne l'écrase pas par mégarde.
  const thisMonday = localISO(weekBounds(new Date()).monday);
  const lastFrom = [...(emp.restPeriods || []), ...(emp.schedulePeriods || [])].map((p) => p.from).sort().pop() || '';
  const refDate = lastFrom > thisMonday ? lastFrom : thisMonday;
  const rest = new Set(restDaysOn(emp.restPeriods, refDate));
  const sched = scheduleOn(emp.schedulePeriods, refDate) || {};
  const schedRow = (kd) => {
    const cur = sched[kd.k] || null;
    const opts = ['<option value="">— aucune —</option>']
      .concat(DOW_FULL.map((d) => `<option value="${d.n}"${cur && cur.day === d.n ? ' selected' : ''}>${d.l}</option>`)).join('');
    return `<div class="pf-sched-row" data-k="${kd.k}">
      <span class="pf-sched-lbl">${kd.l}</span>
      <select class="pf-sched-day" aria-label="Jour — ${kd.full}">${opts}</select>
      <label class="pf-sched-t">Début <input type="time" class="pf-sched-start" value="${cur ? cur.start : ''}"></label>
      <label class="pf-sched-t">Fin <input type="time" class="pf-sched-end" value="${cur ? cur.end : ''}"></label>
    </div>`;
  };
  profileModal.innerHTML = `
    <h2>${escapeHtml(emp.name)}</h2>
    <div class="sub">Profil — repos, demi, continue &amp; postes</div>
    <div class="field">
      <label for="pf-name">Nom du salarié</label>
      <input type="text" id="pf-name" value="${escapeHtml(emp.name)}" autocomplete="off">
    </div>
    <div class="field" style="margin-top:10px">
      <label>Jours de repos hebdomadaires</label>
      <div class="preset-chips" id="pf-rest">
        ${DOW.map((d) => `<button type="button" class="chip ${rest.has(d.n) ? 'active' : ''}" data-d="${d.n}">${d.l}</button>`).join('')}
      </div>
    </div>
    <div class="field" style="margin-top:12px">
      <label>Demi-journée et journée continue de la semaine</label>
      <div id="pf-sched">${SCHED_KINDS.map(schedRow).join('')}</div>
      <div class="sub" style="font-size:.78rem;margin-top:4px">Le planning pose ces horaires tout seul, chaque semaine. Le service hors de ces horaires est barré. Un jour où vous saisissez autre chose (horaires, congé, repos…) n'est pas touché.</div>
    </div>
    <div class="field" style="margin-top:10px">
      <label for="pf-from">Repos, demi et continue applicables à partir du</label>
      <input type="date" id="pf-from" value="${refDate}">
      <div class="sub" style="font-size:.78rem;margin-top:4px">${refDate > thisMonday
        ? `Un changement est déjà programmé à partir du ${frDate(refDate)} : c'est lui qui est affiché. Pour modifier dès cette semaine, reculez la date.`
        : 'Par défaut : début de la semaine en cours (effet immédiat). Avancez la date pour ne changer que les semaines futures, ou reculez-la pour corriger le passé.'}</div>
    </div>
    <div class="field" style="margin-top:12px">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="pf-continu" ${emp.continuous ? 'checked' : ''}>
        Service continu (les deux services sans coupure)
      </label>
    </div>
    <div class="field" style="margin-top:12px">
      <label>Préférences de poste — 1 = poste principal, 2 = bon pour le poste, 3 = dépannage, 4 = jamais</label>
      <div id="pf-postes">
        ${POSTES.map((p) => {
          const cur = Number((emp.postes || {})[p.key] || 4); // non renseigné = jamais
          const LBL = { 1: '1 · principal', 2: '2 · bon', 3: '3 · dépannage', 4: '4 · jamais' };
          const opts = [1, 2, 3, 4].map((n) => `<option value="${n}"${n === cur ? ' selected' : ''}>${LBL[n]}</option>`).join('');
          return `<div class="pf-poste-row"><i class="po-dot po-${p.key}"></i><span class="pf-poste-lbl">${p.label}${p.slots > 1 ? ` (×${p.slots})` : ''}</span><select class="pf-poste" data-k="${p.key}">${opts}</select></div>`;
        }).join('')}
      </div>
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
  // Sans jour choisi, les heures sont grisées.
  profileModal.querySelectorAll('.pf-sched-row').forEach((row) => {
    const sync = () => {
      const off = row.querySelector('.pf-sched-day').value === '';
      row.querySelectorAll('input').forEach((i) => { i.disabled = off; });
      row.classList.toggle('off', off);
    };
    row.querySelector('.pf-sched-day').addEventListener('change', sync);
    sync();
  });
  profileModal.querySelector('#pf-save').addEventListener('click', async () => {
    const name = profileModal.querySelector('#pf-name').value.trim();
    if (!name) { const m = $('pf-msg'); m.textContent = 'Le nom ne peut pas être vide.'; m.className = 'msg show error'; return; }
    const restDays = [...profileModal.querySelectorAll('#pf-rest .chip.active')].map((c) => Number(c.dataset.d));
    const restDaysFrom = profileModal.querySelector('#pf-from').value;
    const continuous = profileModal.querySelector('#pf-continu').checked;
    const pfErr = (t) => { const m = $('pf-msg'); m.textContent = t; m.className = 'msg show error'; };
    // Demi + continue : jour, début et fin obligatoires dès qu'un jour est choisi.
    const schedule = {};
    for (const kd of SCHED_KINDS) {
      const row = profileModal.querySelector(`.pf-sched-row[data-k="${kd.k}"]`);
      const dayV = row.querySelector('.pf-sched-day').value;
      if (dayV === '') { schedule[kd.k] = null; continue; }
      const start = row.querySelector('.pf-sched-start').value;
      const end = row.querySelector('.pf-sched-end').value;
      if (!start || !end) { pfErr(`${kd.full} : saisissez l'heure de début et l'heure de fin.`); return; }
      if (start === end) { pfErr(`${kd.full} : le début et la fin sont identiques.`); return; }
      const dn = DOW_FULL.find((d) => d.n === Number(dayV)).l.toLowerCase();
      if (restDays.includes(Number(dayV))) { pfErr(`${kd.full} : le ${dn} est un jour de repos. Choisissez un autre jour.`); return; }
      schedule[kd.k] = { day: Number(dayV), start, end };
    }
    if (schedule.demi && schedule.cont && schedule.demi.day === schedule.cont.day) {
      pfErr('La demi-journée et la journée continue ne peuvent pas tomber le même jour.'); return;
    }
    if (!restDaysFrom) { pfErr("Indiquez la date d'application."); return; }
    const postes = {};
    profileModal.querySelectorAll('.pf-poste').forEach((s) => {
      const n = Number(s.value);
      if (n >= 1 && n <= 3) postes[s.dataset.k] = n; // 4 = jamais → non enregistré
    });
    const { ok, data } = await api(`/api/admin/employees/${empId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, restDays, restDaysFrom, continuous, postes, schedule }),
    });
    if (!ok) { const m = $('pf-msg'); m.textContent = (data && data.error) || 'Erreur'; m.className = 'msg show error'; return; }
    profileOverlay.classList.remove('show');
    if (data && data.cleaned) toast(`Profil enregistré — ${data.cleaned} jour(s) déjà rempli(s) avec l'ancien rythme mis à jour`, 5000);
    await loadEmployees();
    loadPlanning();
  });
  profileModal.querySelector('#pf-close').addEventListener('click', () => profileOverlay.classList.remove('show'));
  profileOverlay.classList.add('show');
}

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

// Postes de cuisine : couleurs du planning. À chaque service, les présents
// sont affectés aux postes selon leurs préférences (réglées dans le profil).
const POSTES = [
  { key: 'grillade', label: 'Grillade', slots: 1 },
  { key: 'garnitures', label: 'Garnitures', slots: 1 },
  { key: 'volant', label: 'Volant', slots: 1 },
  { key: 'froid', label: 'Froid', slots: 2 },
  { key: 'plonge', label: 'Plonge', slots: 1 },
];
const POSTE_LABELS = Object.fromEntries(POSTES.map((p) => [p.key, p.label]));
POSTE_LABELS.mise_en_place = 'Mise en place'; // renfort au-delà des 6 postes (rose)

// Ordre de PRIORITÉ de remplissage : d'abord grillade, garnitures, froid (×2)
// et plonge ; le volant ne se remplit qu'ensuite ; le reste → mise en place.
const POSTE_PRIORITY = ['grillade', 'garnitures', 'froid', 'plonge', 'volant'];

let assignMap = new Map(); // affectations MANUELLES : "empId|jour|service" → poste
let weekTemplates = []; // semaines types (périodes) : l'auto suit leurs postes

// Poste VERROUILLÉ dans la semaine type pour ce salarié, ce jour et ce service
// (null si rien de verrouillé, ou « mise en place »).
// La période applicable = la dernière dont « from » <= jour.
function tplPosteOf(empId, day, svc) {
  let best = null;
  for (const t of weekTemplates) {
    if (t && t.from && t.from <= day && (!best || t.from > best.from)) best = t;
  }
  const byWd = best && best.shifts && best.shifts[empId];
  const sh = byWd && byWd[new Date(day + 'T12:00:00').getDay()];
  if (!sh) return null;
  return POSTES.some((p) => p.key === sh[svc]) ? sh[svc] : null;
}
let lastPosteOf = {}; // affectations effectives du dernier rendu (manuel + auto)

// Données du planning.
let planningReport = [];
let statusMap = new Map(); // clé "empId|day" → 'cp'|'am'|…
let virtualStatus = new Map(); // clé "empId|day" → 'demi'|'cont' : demi posée par le PROFIL (rien d'enregistré ce jour-là)
let extraMap = {}; // clé "YYYY-MM-DD|midi" / "…|soir" → texte libre (ligne « Extra »)
const STATUS_SHORT = { cp: 'CP', am: 'AM', ecole: 'École', absent: 'Abs', repos: 'Repos' };
const STATUS_FULL = { normal: 'Journée complète (demi / continue du profil annulée ce jour)', cp: 'Congés payés', am: 'Arrêt maladie', ecole: 'École', absent: 'Absent', repos: 'Repos', demi_midi: 'Demi midi (présent soir)', demi_soir: 'Demi soir (présent midi)', echange_midi: 'Échange midi', echange_soir: 'Échange soir', echange_both: 'Échange midi + soir', extra_midi: 'Extra midi', extra_soir: 'Extra soir', extra_both: 'Extra midi + soir' };
const AWAY_STATUSES = ['cp', 'am', 'absent', 'ecole'];
// Croix (X) en coin à coin, remplit la case (repos) ou la demi-case (demi).
const CROSS_SVG = '<svg class="pl-cross" viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="0" x2="10" y2="10"/><line x1="10" y1="0" x2="0" y2="10"/></svg>';

async function loadPlanning() {
  const from = $('rep-from').value;
  const to = $('rep-to').value;
  if (!from || !to) { renderPlanning(); return; }
  const params = new URLSearchParams({ from, to });
  const [rep, st, ex, pa, wt] = await Promise.all([
    api('/api/admin/report?' + params.toString()),
    api('/api/admin/day-statuses?' + params.toString()),
    api('/api/admin/extra?' + params.toString()),
    api('/api/admin/poste-assigns?' + params.toString()),
    api('/api/admin/week-template'),
  ]);
  weekTemplates = (wt.ok && Array.isArray(wt.data)) ? wt.data : [];
  planningReport = (rep.ok && rep.data) ? rep.data : [];
  statusMap = new Map();
  virtualStatus = new Map();
  if (st.ok && Array.isArray(st.data)) {
    for (const s of st.data) {
      statusMap.set(s.employeeId + '|' + s.day, s.status);
      if (s.virtual) virtualStatus.set(s.employeeId + '|' + s.day, s.kind || 'demi');
    }
  }
  extraMap = (ex.ok && ex.data && typeof ex.data === 'object') ? ex.data : {};
  assignMap = new Map();
  if (pa.ok && Array.isArray(pa.data)) {
    for (const a of pa.data) {
      // Les anciennes lignes posées par « ⚡ Semaine type » (src 'tpl') sont
      // ignorées : l'automatique lit désormais la semaine type directement.
      if (a.src === 'tpl') continue;
      assignMap.set(a.employeeId + '|' + a.day + '|' + a.service, a.poste);
    }
  }
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
  if (!actives.length) { out.innerHTML = '<div class="empty">Aucun salarié — ajoutez l\'équipe de cuisine dans la partie « Employés » ci-dessous.</div>'; return; }

  let html = '<div class="poste-legend">'
    + POSTES.map((p) => `<span class="po-chip"><i class="po-dot po-${p.key}"></i>${p.label}${p.slots > 1 ? ' ×' + p.slots : ''}</span>`).join('')
    + '<span class="po-chip"><i class="po-dot po-mise_en_place"></i>Mise en place</span>'
    + '<span class="poste-legend-note">postes verrouillés de la semaine type, puis préférences (Profil) — clic sur une case pour changer, ↻ en bas de colonne pour réaffecter le jour</span></div>';
  html += '<table class="planning"><thead><tr><th class="pl-name">Salarié</th>';
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

  // Affectation des postes par jour et par service : on liste les présents
  // (mêmes règles que les compteurs), puis on attribue les postes : d'abord
  // celui prévu par la SEMAINE TYPE, sinon les préférences du profil (1 → 3 ;
  // vide = jamais). Égalité :
  // l'ordre du planning (sortOrder) tranche. Clé : "empId|jour|service".
  const posteOf = {};
  for (const d of days) {
    for (const svc of ['midi', 'soir']) {
      const present = [];
      for (const emp of actives) {
        const repE = byId.get(emp.id);
        const dayData = repE && repE.days.find((x) => x.day === d);
        const hasHours = !!(dayData && dayData.segments.length);
        const status = statusMap.get(emp.id + '|' + d);
        if (AWAY_STATUSES.includes(status) && !hasHours) continue;
        const isRest = restDaysOn(emp.restPeriods, d).includes(weekday[d]) || status === 'repos';
        const ex = status === ('extra_' + svc) || status === 'extra_both';
        // Un extra coché « réveille » le service, même un jour de repos.
        if (isRest && !hasHours && !ex) continue;
        const { cont, midi, soir } = hasHours ? classifyDay(dayData.segments) : { cont: [], midi: [], soir: [] };
        if (hasHours && (emp.continuous || cont.length)) { present.push(emp); continue; }
        const segs = svc === 'midi' ? midi : soir;
        const demi = status === (svc === 'midi' ? 'demi_midi' : 'demi_soir');
        const ech = status === (svc === 'midi' ? 'echange_midi' : 'echange_soir') || status === 'echange_both';
        // Jour de repos sans extra sur ce service → pas présent sur ce service.
        if (segs.length || (!demi && !ech && (!isRest || ex))) present.push(emp);
      }
      // 1) Les affectations MANUELLES priment et consomment les places.
      const left = Object.fromEntries(POSTES.map((p) => [p.key, p.slots]));
      const autoCands = [];
      for (const emp of present) {
        const key = emp.id + '|' + d + '|' + svc;
        const manual = assignMap.get(key);
        if (manual) {
          posteOf[key] = manual;
          if (left[manual] > 0) left[manual]--;
        } else autoCands.push(emp);
      }
      // 2) Affectation automatique OPTIMALE, en deux exigences hiérarchisées :
      //    a) remplir le MAXIMUM de places, dans l'ordre d'importance
      //       1 grillade, 2 garnitures, 3-4 froid, 5 plonge, 6 volant
      //       (une place de rang supérieur ne reste jamais vide si quelqu'un
      //       peut la tenir — quitte à déplacer quelqu'un d'un rang inférieur) ;
      //    b) à couverture égale, mettre chacun au meilleur poste possible
      //       (somme des préférences la plus basse : les « 1 » avant les « 2 »…).
      // Recherche exhaustive (équipe petite) avec garde-fou de complexité.
      const slots = [];
      for (const pk of POSTE_PRIORITY) for (let k = 0; k < left[pk]; k++) slots.push(pk);
      // Le poste de la semaine type vaut 0 : il passe avant toute préférence
      // du profil (1 à 3). Semaine normale → chacun à son poste type ; en cas
      // d'absence, les autres comblent selon leurs préférences.
      const tplOf = {};
      for (const emp of autoCands) tplOf[emp.id] = tplPosteOf(emp.id, d, svc);
      const prefOf = (emp, pk) => {
        if (tplOf[emp.id] === pk) return 0;
        const v = Number((emp.postes || {})[pk] || 0);
        return (v >= 1 && v <= 3) ? v : null; // 4 / non renseigné = jamais
      };
      let best = null; // { picks, coverage, prefSum, vec }
      let nodes = 0;
      const picks = []; const vec = [];
      const used = new Set();
      // À couverture et somme égales : départage par les préférences poste par
      // poste, dans l'ordre de priorité (le « 1 » garde sa grillade plutôt
      // qu'un « 2 », même si la somme totale est identique).
      const vecBetter = (a, b) => {
        for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
        return false;
      };
      const explore = (i, coverage, prefSum) => {
        if (nodes++ > 300000) return; // garde-fou (jamais atteint en pratique)
        if (i === slots.length) {
          if (!best || coverage > best.coverage
            || (coverage === best.coverage && prefSum < best.prefSum)
            || (coverage === best.coverage && prefSum === best.prefSum && vecBetter(vec, best.vec))) {
            best = { picks: [...picks], coverage, prefSum, vec: [...vec] };
          }
          return;
        }
        const bit = 1 << (slots.length - 1 - i); // rang prioritaire = poids fort
        let any = false;
        for (const emp of autoCands) {
          if (used.has(emp.id)) continue;
          const v = prefOf(emp, slots[i]);
          if (v == null) continue;
          any = true;
          used.add(emp.id); picks.push(emp.id); vec.push(v);
          explore(i + 1, coverage | bit, prefSum + v);
          used.delete(emp.id); picks.pop(); vec.pop();
        }
        // Laisser la place vide seulement si personne ne peut la tenir
        // (la remplir l'emporte toujours, par construction des poids).
        if (!any) { picks.push(null); vec.push(9); explore(i + 1, coverage, prefSum); picks.pop(); vec.pop(); }
      };
      explore(0, 0, 0);
      if (best) {
        best.picks.forEach((empId, i) => {
          if (empId != null) posteOf[empId + '|' + d + '|' + svc] = slots[i];
        });
      }
      // 3) Présents sans poste (places prises ou sans préférence) → mise en place.
      for (const emp of autoCands) {
        const key = emp.id + '|' + d + '|' + svc;
        if (!posteOf[key]) posteOf[key] = 'mise_en_place';
      }
    }
  }
  lastPosteOf = posteOf; // exposé à l'éditeur de case (affichage du poste auto)

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
        const extraMidi = status === 'extra_midi' || status === 'extra_both';
        const extraSoir = status === 'extra_soir' || status === 'extra_both';
        const exBadge = (on) => (on ? '<span class="pl-ex" title="Extra">EX</span>' : '');
        let inner; let fillCls = ''; let exchangeMark = '';

        if (awayStatus && !hasHours) {
          inner = `<span class="pl-status-lbl">${STATUS_SHORT[awayStatus]}</span>`;
          fillCls = ` pl-statusfill st-${awayStatus}`;
        } else if (isRest && !hasHours && !extraMidi && !extraSoir) {
          // Repos : croix sur toute la case — SAUF si un extra est coché
          // (la case passe alors en demi-cases, le service extra est actif).
          inner = CROSS_SVG;
          fillCls = ' pl-rest';
        } else {
          // Jour travaillé (ou repos avec heures = échange) : demi-cases midi + soir.
          // Sans heures : « PM » (présent midi) / « PS » (présent soir) par défaut ;
          // demi manuel → croix sur le service non travaillé.
          // « C » dans un cadre blanc : créneau saisi de PLUS de 7h d'affilée.
          const SEVEN_H = 7 * 3600 * 1000;
          const cMark = (s) => (!s.open && (s.clockOut - s.clockIn) > SEVEN_H
            ? ' <span class="pl-c" title="Plus de 7h en continu">C</span>' : '');
          const fmt = (s) => (s.open ? fmtTime(s.clockIn) : `${fmtTime(s.clockIn)}–${fmtTime(s.clockOut)}`) + cMark(s);
          const { cont, midi, soir } = hasHours ? classifyDay(day.segments) : { cont: [], midi: [], soir: [] };
          // Continu (rouge plein) seulement si la journée l'est VRAIMENT : segment
          // couvrant les deux services, ou profil « continu » sans coupure visible
          // ni demi posée ce jour-là.
          const isCont = hasHours && (cont.length > 0
            || (emp.continuous && !(midi.length && soir.length) && !demiMidi && !demiSoir));
          const pmKey = posteOf[emp.id + '|' + d + '|midi'];
          const psKey = posteOf[emp.id + '|' + d + '|soir'];
          // Liseré sur les affectations manuelles (≠ automatiques).
          const isManual = (svc) => assignMap.has(emp.id + '|' + d + '|' + svc);
          const pmCls = pmKey ? ` po-${pmKey}${isManual('midi') ? ' po-manual' : ''}` : '';
          const psCls = psKey ? ` po-${psKey}${isManual('soir') ? ' po-manual' : ''}` : '';
          const pLbl = (k) => (k ? `<span class="pl-poste">${POSTE_LABELS[k]}</span>` : '');
          let stack;
          if (isCont) {
            const lbl = (pmKey && psKey && pmKey !== psKey)
              ? `<span class="pl-poste">${POSTE_LABELS[pmKey]} / ${POSTE_LABELS[psKey]}</span>`
              : pLbl(pmKey || psKey);
            stack = `<div class="pl-half pl-cont${pmCls}">${exBadge(extraMidi || extraSoir)}${day.segments.map(fmt).join('<br>')}${lbl}</div>`;
            midiCount[d]++; soirCount[d]++;
          } else {
            let midiHalf;
            if (midi.length) {
              midiHalf = `<div class="pl-half${pmCls}">${exBadge(extraMidi)}${midi.map(fmt).join('<br>')}${pLbl(pmKey)}</div>`;
              midiCount[d]++;
            } else if (demiMidi) {
              midiHalf = `<div class="pl-half pl-demi">${CROSS_SVG}</div>`;
            } else if (echMidi) {
              midiHalf = '<div class="pl-half pl-echange" title="Échange midi">É</div>'; // non compté
            } else if (isRest && !extraMidi) {
              // Jour de repos : seul un service coché « extra » est actif, l'autre garde sa croix.
              midiHalf = `<div class="pl-half pl-demi">${CROSS_SVG}</div>`;
            } else {
              midiHalf = pmKey
                ? `<div class="pl-half pl-pres${pmCls}" title="Présent midi — horaires à préciser">${exBadge(extraMidi)}${POSTE_LABELS[pmKey]}</div>`
                : `<div class="pl-half pl-pres">${exBadge(extraMidi)}PM</div>`;
              midiCount[d]++;
            }
            let soirHalf;
            if (soir.length) {
              soirHalf = `<div class="pl-half${psCls}">${exBadge(extraSoir)}${soir.map(fmt).join('<br>')}${pLbl(psKey)}</div>`;
              soirCount[d]++;
            } else if (demiSoir) {
              soirHalf = `<div class="pl-half pl-demi">${CROSS_SVG}</div>`;
            } else if (echSoir) {
              soirHalf = '<div class="pl-half pl-echange" title="Échange soir">É</div>'; // non compté
            } else if (isRest && !extraSoir) {
              // Jour de repos : seul un service coché « extra » est actif, l'autre garde sa croix.
              soirHalf = `<div class="pl-half pl-demi">${CROSS_SVG}</div>`;
            } else {
              soirHalf = psKey
                ? `<div class="pl-half pl-pres${psCls}" title="Présent soir — horaires à préciser">${exBadge(extraSoir)}${POSTE_LABELS[psKey]}</div>`
                : `<div class="pl-half pl-pres">${exBadge(extraSoir)}PS</div>`;
              soirCount[d]++;
            }
            stack = midiHalf + soirHalf;
            // Ne compter une demi que si le service marqué « demi » est réellement vide.
            // Si des heures ont été saisies sur ce service, la personne a travaillé :
            // ce n'est plus une demi (sinon le compteur gonfle à tort).
            if ((demiMidi && !midi.length) || (demiSoir && !soir.length)) demiCount++;
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

  // Boutons ↻ : réaffecte les postes du jour selon les préférences
  // (efface les affectations manuelles de la colonne).
  html += '<tr class="pl-reassign-row"><td class="pl-name">Postes</td>';
  for (const d of days) html += `<td><button class="pl-reassign" data-day="${d}" title="Réaffecter les postes de ce jour selon les préférences (efface les choix manuels du jour)">↻</button></td>`;
  html += '<td></td></tr>';

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
  out.querySelectorAll('.pl-reassign').forEach((btn) => {
    btn.addEventListener('click', () => openReassignModal(btn.dataset.day));
  });
}

// Fenêtre de confirmation de la réaffectation d'un jour (boutons ↻).
// Fenêtre de l'appli (pas de confirm() natif, qui pose problème selon le navigateur).
function openReassignModal(d) {
  cellModal.innerHTML = `
    <h2>↻ Réaffecter les postes</h2>
    <div class="sub">${planningDayLabel(d).replace('<br>', ' ')}</div>
    <p style="margin:10px 0 0;font-size:.92rem">Les postes de ce jour seront recalculés selon les préférences.
    Les affectations posées à la main ce jour-là (liseré sombre) seront effacées.</p>
    <div class="action-buttons" style="margin-top:16px;grid-template-columns:1fr 1fr">
      <button class="btn btn-blue" id="ra-ok">Réaffecter</button>
      <button class="btn btn-ghost" id="ra-cancel">Annuler</button>
    </div>`;
  cellModal.querySelector('#ra-ok').addEventListener('click', async () => {
    const { ok, status, data } = await api('/api/admin/poste-assigns/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: d }),
    });
    cellOverlay.classList.remove('show');
    if (!ok) {
      if (status === 401) { showLogin(); return; } // session expirée → reconnexion
      toast((data && data.error) || 'Erreur');
      return;
    }
    toast(data.cleared
      ? `${data.cleared} affectation(s) manuelle(s) effacée(s) — postes du ${frDate(d)} recalculés`
      : `Aucune affectation manuelle le ${frDate(d)} — postes déjà selon les préférences`);
    loadPlanning();
  });
  cellModal.querySelector('#ra-cancel').addEventListener('click', () => cellOverlay.classList.remove('show'));
  cellOverlay.classList.add('show');
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

function toast(msg, ms) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(() => { t.className = 'toast'; }, ms || 1800);
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
  loadPlanning();
});

// --- Semaine type : postes verrouillés ---------------------------------------
// La semaine type ne porte plus que les POSTES : pour chaque salarié, chaque
// jour et chaque service, un poste « verrouillé » (ou rien = automatique selon
// les préférences). Les repos, la demi-journée et la journée continue viennent
// du PROFIL : ils sont affichés ici pour information, pas modifiables.
// Chaque version s'applique à partir de sa date (« from ») jusqu'à la veille de
// la version suivante. Les anciennes versions restent enregistrées (historique).
const tplOverlay = $('tpl-overlay');
const tplModal = $('tpl-modal');
const tplCellOverlay = $('tplcell-overlay');
const tplCellModal = $('tplcell-modal');
const TE_DAYS = [1, 2, 3, 4, 5, 6, 0]; // colonnes Lun → Dim (0 = dimanche)
const TE_DAY_NAMES = { 1: 'Lundi', 2: 'Mardi', 3: 'Mercredi', 4: 'Jeudi', 5: 'Vendredi', 6: 'Samedi', 0: 'Dimanche' };
const TE_DAY_SHORT = { 1: 'Lun', 2: 'Mar', 3: 'Mer', 4: 'Jeu', 5: 'Ven', 6: 'Sam', 0: 'Dim' };
const TE_POSTE_KEYS = [...POSTES.map((p) => p.key), 'mise_en_place'];
const TE_ISO = /^\d{4}-\d{2}-\d{2}$/;
let te = null; // { from, shifts, dirty, readOnly, saveFrom, confirmClose, confirmDel }

const teToday = () => localISO(new Date());
function teAddDays(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localISO(d); }
function teFr(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function teNextMonday() {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return localISO(d);
}
function teVersions() {
  return weekTemplates.filter((t) => t && TE_ISO.test(t.from || '') && t.shifts && typeof t.shifts === 'object')
    .sort((a, b) => a.from.localeCompare(b.from));
}
function teVersionOn(day) { let best = null; for (const t of teVersions()) if (t.from <= day) best = t.from; return best; }

async function openTplEditor() {
  const wt = await api('/api/admin/week-template');
  if (!wt.ok) { if (wt.status === 401) showLogin(); else toast('Erreur de chargement'); return; }
  weekTemplates = Array.isArray(wt.data) ? wt.data : [];
  const vs = teVersions();
  // Version ouverte : celle en vigueur pour la semaine affichée au planning.
  const shown = $('rep-from').value || teToday();
  teLoad(teVersionOn(shown) || (vs[0] && vs[0].from) || null);
  tplOverlay.classList.add('show');
}

function teLoad(from) {
  const v = teVersions().find((t) => t.from === from) || null;
  const today = teToday();
  // On ne garde que les postes (les anciennes versions portaient aussi des
  // horaires et des demi-journées, désormais réglés dans le profil).
  const shifts = {};
  for (const [empId, byWd] of Object.entries((v && v.shifts) || {})) {
    for (const [wd, sh] of Object.entries(byWd || {})) {
      const entry = {};
      for (const svc of ['midi', 'soir']) if (sh && TE_POSTE_KEYS.includes(sh[svc])) entry[svc] = sh[svc];
      if (Object.keys(entry).length) (shifts[empId] || (shifts[empId] = {}))[wd] = entry;
    }
  }
  te = {
    from: v ? v.from : null,
    shifts,
    dirty: false,
    // Version dépassée (une plus récente est déjà en vigueur) : consultation seule.
    readOnly: !!v && v.from < today && v.from !== teVersionOn(today),
    // Date d'effet proposée : la version elle-même si elle n'a pas commencé,
    // sinon lundi prochain (on ne réécrit pas les semaines déjà passées).
    saveFrom: v && v.from > today ? v.from : teNextMonday(),
    confirmClose: false, confirmDel: false,
  };
  renderTplEditor();
}

const teRefDate = () => (te.readOnly ? te.from : (TE_ISO.test(te.saveFrom) ? te.saveFrom : teToday()));
function teEmployees() {
  const ref = teRefDate();
  return allEmployees.filter((e) => e.active || (e.endDate && e.endDate >= ref))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
// Service NON travaillé d'un créneau du profil (mêmes fenêtres que le planning :
// midi 9h–14h, soir 18h–21h). null = le créneau couvre les deux services.
function teOffService(sh) {
  const mn = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const s = mn(sh.start); let e = mn(sh.end); if (e <= s) e += 24 * 60;
  const midi = s < 14 * 60 && e > 9 * 60;
  const soir = s < 21 * 60 && e > 18 * 60;
  if (midi && soir) return null;
  if (midi) return 'soir';
  if (soir) return 'midi';
  return s < 17 * 60 ? 'soir' : 'midi';
}
// Ce que dit le PROFIL à la date de référence : repos, et pour le jour de demi /
// de continue, le service non travaillé + l'horaire (affiché pour information).
function teProfile(emp) {
  const ref = teRefDate();
  const out = { rest: restDaysOn(emp.restPeriods, ref), off: {}, hours: {}, kind: {} };
  const p = scheduleOn(emp.schedulePeriods, ref);
  for (const k of ['demi', 'cont']) {
    const sh = p && p[k];
    if (!sh || out.rest.includes(sh.day)) continue;
    out.off[sh.day] = teOffService(sh);
    out.hours[sh.day] = `${sh.start}–${sh.end}`;
    out.kind[sh.day] = k;
  }
  return out;
}
function teShift(empId, wd) { return (te.shifts[empId] || {})[wd] || null; }

function teCellHTML(emp, wd, prof) {
  const attrs = `data-emp="${emp.id}" data-wd="${wd}"`;
  if (prof.rest.includes(wd)) return `<td class="pl-cell pl-click pl-rest" ${attrs} title="Repos (profil)">${CROSS_SVG}</td>`;
  const sh = teShift(emp.id, wd) || {};
  const hours = prof.hours[wd] || '';
  const off = prof.off[wd] || null;
  const half = (svc) => {
    if (off === svc) return `<div class="pl-half pl-demi">${CROSS_SVG}</div>`;
    const k = TE_POSTE_KEYS.includes(sh[svc]) ? sh[svc] : null;
    // Horaire du profil : sur le service travaillé (ou sur le midi s'il couvre les deux).
    const showH = hours && (off || svc === 'midi');
    if (k) {
      return showH
        ? `<div class="pl-half po-${k}">${hours}<span class="pl-poste">${POSTE_LABELS[k]}</span></div>`
        : `<div class="pl-half pl-pres po-${k}">${POSTE_LABELS[k]}</div>`;
    }
    return `<div class="pl-half pl-pres te-auto">${showH ? hours + ' · ' : ''}Auto</div>`;
  };
  return `<td class="pl-cell pl-click pl-filled" ${attrs}><div class="pl-stack">${half('midi')}${half('soir')}</div></td>`;
}

function teHint() {
  if (te.readOnly) return '';
  const from = te.saveFrom;
  if (!TE_ISO.test(from)) return 'Choisis la date à partir de laquelle ces postes s\'appliquent.';
  const vs = teVersions();
  const notMonday = new Date(from + 'T12:00:00').getDay() !== 1 ? ' ⚠️ Cette date n\'est pas un lundi.' : '';
  if (vs.some((t) => t.from === from)) {
    const past = from <= teToday() ? ' Les semaines déjà passées depuis cette date suivront aussi ces postes.' : '';
    return `Modifie la version qui commence le ${teFr(from)}.${past}${notMonday}`;
  }
  const prev = vs.filter((t) => t.from < from).pop();
  const next = vs.find((t) => t.from > from);
  return `Crée une nouvelle version à partir du ${teFr(from)}.`
    + (prev ? ` Celle du ${teFr(prev.from)} reste enregistrée et s'applique jusqu'au ${teFr(teAddDays(from, -1))}.` : '')
    + (next ? ` La nouvelle s'arrêtera le ${teFr(teAddDays(next.from, -1))} (version suivante déjà prévue).` : '')
    + notMonday;
}

function renderTplEditor() {
  const vs = teVersions();
  const today = teToday();
  const cur = teVersionOn(today);
  const emps = teEmployees();
  const opt = (t, i) => {
    const until = vs[i + 1] ? ' au ' + teFr(teAddDays(vs[i + 1].from, -1)) : '';
    const tag = t.from === cur ? ' — en cours' : (t.from > today ? ' — à venir' : ' — passée');
    return `<option value="${t.from}"${t.from === te.from ? ' selected' : ''}>${until ? 'Du' : 'Depuis le'} ${teFr(t.from)}${until}${tag}</option>`;
  };

  let html = '<h2>✏️ Semaine type — postes verrouillés</h2>'
    + '<div class="sub">Clique sur une case pour verrouiller le poste de la personne ce jour-là. « Auto » = pas de poste verrouillé : le planning choisit selon les préférences. Les repos, la demi et la continue se règlent dans le profil.</div>'
    + '<div class="te-bar"><div class="field"><label for="te-ver">Version</label>'
    + `<select id="te-ver"${te.dirty ? ' disabled title="Enregistre ou annule les modifications pour changer de version"' : ''}>`
    + (vs.length ? vs.map(opt).join('') : '<option value="">Aucune version</option>') + '</select></div>'
    + (te.dirty ? '<button class="btn btn-ghost" id="te-undo">↩︎ Annuler les modifications</button>' : '')
    + '</div>';
  if (te.readOnly) html += '<div class="te-state">Version passée — consultation seule. « Repartir de cette version » permet de la reprendre à partir d\'une nouvelle date.</div>';
  else if (te.dirty) html += '<div class="te-state te-dirty">● Modifications non enregistrées</div>';

  html += '<div class="table-wrap"><table class="planning te-table"><thead><tr><th class="pl-name">Salarié</th>';
  for (const wd of TE_DAYS) html += `<th>${TE_DAY_SHORT[wd]}</th>`;
  html += '<th title="Nombre de services travaillés dans la semaine">Serv.</th></tr></thead><tbody>';
  const cover = {}; // "wd|svc" → { n, cnt:{poste:nb} }
  for (const wd of TE_DAYS) for (const svc of ['midi', 'soir']) cover[wd + '|' + svc] = { n: 0, cnt: {} };
  for (const emp of emps) {
    const prof = teProfile(emp);
    let services = 0; let cells = '';
    for (const wd of TE_DAYS) {
      cells += teCellHTML(emp, wd, prof);
      if (prof.rest.includes(wd)) continue;
      const sh = teShift(emp.id, wd) || {};
      for (const svc of ['midi', 'soir']) {
        if (prof.off[wd] === svc) continue;
        services++;
        const c = cover[wd + '|' + svc]; c.n++;
        if (TE_POSTE_KEYS.includes(sh[svc])) c.cnt[sh[svc]] = (c.cnt[sh[svc]] || 0) + 1;
      }
    }
    html += `<tr class="pl-emp-row"><td class="pl-name"><div class="pl-name-inner"><span class="pl-name-txt">${escapeHtml(emp.name)}</span></div></td>${cells}<td class="pl-total">${services}</td></tr>`;
  }
  // Contrôle par service : effectif + postes non verrouillés / en double.
  for (const svc of ['midi', 'soir']) {
    html += `<tr class="pl-svc-row"><td class="pl-name">${svc === 'midi' ? '☀️ Midi' : '🌙 Soir'}</td>`;
    for (const wd of TE_DAYS) {
      const c = cover[wd + '|' + svc];
      const miss = POSTES.filter((p) => (c.cnt[p.key] || 0) < p.slots).map((p) => p.label);
      const dup = POSTES.filter((p) => (c.cnt[p.key] || 0) > p.slots).map((p) => p.label);
      html += `<td>${c.n}`
        + (miss.length ? `<div class="te-warn" title="Poste(s) que personne n'a en verrouillé : le planning les attribue selon les préférences">non verrouillé : ${miss.join(', ')}</div>` : '')
        + (dup.length ? `<div class="te-warn te-dup" title="Plus de personnes verrouillées que de places">en trop : ${dup.join(', ')}</div>` : '')
        + '</td>';
    }
    html += '<td></td></tr>';
  }
  html += '</tbody></table></div>';

  html += '<div class="te-foot">';
  if (te.readOnly) {
    html += '<button class="btn btn-blue" id="te-fork">Repartir de cette version</button>';
  } else {
    html += `<div class="field"><label for="te-from">Appliquer à partir du</label><input type="date" id="te-from" value="${TE_ISO.test(te.saveFrom) ? te.saveFrom : ''}"></div>`
      + '<button class="btn btn-green" id="te-save">Enregistrer</button>';
  }
  html += `<button class="btn btn-ghost" id="te-close">${te.confirmClose ? 'Fermer sans enregistrer ?' : 'Fermer'}</button>`;
  if (!te.dirty && te.from && te.from > today && vs.length > 1) {
    html += `<button class="btn btn-red" id="te-del">${te.confirmDel ? 'Confirmer la suppression' : 'Supprimer cette version'}</button>`;
  }
  html += `</div><div class="te-hint" id="te-hint">${teHint()}</div>`;
  tplModal.innerHTML = html;

  const ver = tplModal.querySelector('#te-ver');
  ver.addEventListener('change', () => teLoad(ver.value || null));
  const undo = tplModal.querySelector('#te-undo');
  if (undo) undo.addEventListener('click', () => teLoad(te.from));
  tplModal.querySelectorAll('td.pl-click').forEach((td) => {
    td.addEventListener('click', () => openTplCell(Number(td.dataset.emp), Number(td.dataset.wd)));
  });
  const fork = tplModal.querySelector('#te-fork');
  if (fork) fork.addEventListener('click', () => { te.readOnly = false; te.dirty = true; te.saveFrom = teNextMonday(); renderTplEditor(); });
  const fromEl = tplModal.querySelector('#te-from');
  if (fromEl) fromEl.addEventListener('change', () => { te.saveFrom = fromEl.value; renderTplEditor(); });
  const save = tplModal.querySelector('#te-save');
  if (save) save.addEventListener('click', teSave);
  tplModal.querySelector('#te-close').addEventListener('click', () => {
    if (te.dirty && !te.confirmClose) { te.confirmClose = true; renderTplEditor(); return; }
    tplOverlay.classList.remove('show');
  });
  const del = tplModal.querySelector('#te-del');
  if (del) del.addEventListener('click', teDelete);
}

async function tePut(periods) {
  const r = await api('/api/admin/week-template', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ periods }),
  });
  if (!r.ok) {
    if (r.status === 401) { tplOverlay.classList.remove('show'); showLogin(); } else toast((r.data && r.data.error) || 'Erreur');
    return false;
  }
  weekTemplates = periods;
  return true;
}

async function teSave() {
  const from = te.saveFrom;
  if (!TE_ISO.test(from)) { toast('Choisis la date « Appliquer à partir du »'); return; }
  const shifts = JSON.parse(JSON.stringify(te.shifts));
  for (const empId of Object.keys(shifts)) {
    const byWd = shifts[empId] || {};
    for (const wd of Object.keys(byWd)) if (!byWd[wd] || (!byWd[wd].midi && !byWd[wd].soir)) delete byWd[wd];
    if (!Object.keys(byWd).length) delete shifts[empId];
  }
  const periods = teVersions().filter((t) => t.from !== from);
  periods.push({ from, shifts });
  periods.sort((a, b) => a.from.localeCompare(b.from));
  if (!(await tePut(periods))) return;
  teLoad(from);
  te.saveFrom = from; // on reste sur la version qu'on vient d'enregistrer
  renderTplEditor();
  loadPlanning();
  toast(`Postes verrouillés enregistrés (à partir du ${teFr(from)})`);
}

async function teDelete() {
  if (!te.confirmDel) { te.confirmDel = true; renderTplEditor(); return; }
  const periods = teVersions().filter((t) => t.from !== te.from);
  if (!(await tePut(periods))) return;
  teLoad(teVersionOn($('rep-from').value || teToday()) || (periods[0] && periods[0].from) || null);
  loadPlanning();
  toast('Version supprimée');
}

// Fenêtre d'une case : poste verrouillé de chaque service travaillé (ou Auto).
function openTplCell(empId, wd) {
  if (te.readOnly) { toast('Version passée : « Repartir de cette version » pour la modifier'); return; }
  const emp = allEmployees.find((e) => e.id === empId);
  if (!emp) return;
  const prof = teProfile(emp);
  if (prof.rest.includes(wd)) { toast('Jour de repos — il se change dans le profil', 2600); return; }
  const off = prof.off[wd] || null;
  const sh = teShift(empId, wd) || {};
  const st = {
    midi: TE_POSTE_KEYS.includes(sh.midi) ? sh.midi : '',
    soir: TE_POSTE_KEYS.includes(sh.soir) ? sh.soir : '',
  };
  const kindLbl = prof.kind[wd] === 'cont' ? 'journée continue' : 'demi-journée';
  const picks = (svc, icon) => `<div class="ce-poste-row"><span class="ce-poste-svc">${icon}</span>`
    + TE_POSTE_KEYS.map((k) => `<button type="button" class="po-pick po-${k}${st[svc] === k ? ' active' : ''}" data-svc="${svc}" data-k="${k}">${POSTE_LABELS[k]}</button>`).join('')
    + `<button type="button" class="po-pick po-pick-auto${st[svc] ? '' : ' active'}" data-svc="${svc}" data-k="" title="Pas de poste verrouillé : le planning choisit selon les préférences">Auto</button></div>`;
  const draw = () => {
    let h = `<h2>${escapeHtml(emp.name)} — ${TE_DAY_NAMES[wd]}</h2><div class="sub">Poste verrouillé — « Auto » pour laisser le planning choisir</div>`;
    if (off !== 'midi') h += picks('midi', '☀️');
    if (off !== 'soir') h += picks('soir', '🌙');
    if (prof.hours[wd]) {
      h += `<p class="te-small">${off ? (off === 'midi' ? 'Midi' : 'Soir') + ' non travaillé : ' : ''}${kindLbl} ${prof.hours[wd]} (réglée dans le profil).</p>`;
    }
    h += '<div class="action-buttons" style="margin-top:16px;grid-template-columns:1fr 1fr">'
      + '<button class="btn btn-green" id="tc-ok">Valider</button><button class="btn btn-ghost" id="tc-cancel">Annuler</button></div>';
    tplCellModal.innerHTML = h;
    tplCellModal.querySelectorAll('.po-pick').forEach((b) => b.addEventListener('click', () => { st[b.dataset.svc] = b.dataset.k; draw(); }));
    tplCellModal.querySelector('#tc-cancel').addEventListener('click', () => tplCellOverlay.classList.remove('show'));
    tplCellModal.querySelector('#tc-ok').addEventListener('click', () => {
      const byWd = te.shifts[empId] || (te.shifts[empId] = {});
      const entry = {};
      if (off !== 'midi' && st.midi) entry.midi = st.midi;
      if (off !== 'soir' && st.soir) entry.soir = st.soir;
      if (Object.keys(entry).length) byWd[wd] = entry; else delete byWd[wd];
      if (!Object.keys(byWd).length) delete te.shifts[empId];
      te.dirty = true; te.confirmClose = false;
      tplCellOverlay.classList.remove('show');
      renderTplEditor();
    });
  };
  draw();
  tplCellOverlay.classList.add('show');
}

$('tpl-edit-btn').addEventListener('click', openTplEditor);
tplOverlay.addEventListener('click', (e) => { if (e.target === tplOverlay && !(te && te.dirty)) tplOverlay.classList.remove('show'); });
tplCellOverlay.addEventListener('click', (e) => { if (e.target === tplCellOverlay) tplCellOverlay.classList.remove('show'); });

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
}

// --- Arrivée groupée (jour choisi dans la semaine) -------------------------
$('grp-btn').addEventListener('click', openGroupArrival);

// Salariés éligibles à l'arrivée groupée un jour donné : actifs, PAS en repos,
// SANS arrivée déjà saisie, et SANS statut (CP/AM/École/Absent) ce jour-là.
function eligibleForGroup(d) {
  const byId = new Map((planningReport || []).map((e) => [e.employeeId, e]));
  const wd = new Date(d + 'T12:00:00').getDay();
  return allEmployees.filter((e) => {
    if (!e.active && !(e.endDate && e.endDate >= d)) return false;
    if (restDaysOn(e.restPeriods, d).includes(wd)) return false;
    // « Journée complète » n'est pas une absence : la personne reste proposée.
    if (statusMap.has(e.id + '|' + d) && statusMap.get(e.id + '|' + d) !== 'normal') return false;
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
      <input type="time" id="grp-time" value="09:00">
      <div class="preset-chips" id="grp-chips"></div>
    </div>
    <div class="grp-list" id="grp-list"></div>
    <div class="msg error" id="grp-msg"></div>
    <div class="action-buttons" style="margin-top:12px">
      <button class="btn btn-green" id="grp-save">Enregistrer l'arrivée</button>
      <button class="btn btn-ghost" id="grp-cancel">Annuler</button>
    </div>`;
  fillChips(cellModal.querySelector('#grp-chips'), ['09:00', '10:00', '17:00', '18:00'], cellModal.querySelector('#grp-time'));
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
  document.title = (from && to) ? `Planning cuisine ${fr(from)} au ${fr(to)}` : 'Planning cuisine';
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

  // Horaire issu du profil (demi / continue) : rien n'est enregistré ce jour-là,
  // il ne se modifie donc pas ligne à ligne — on le remplace ou on l'annule.
  const allSegs = dayData ? dayData.segments : [];
  const realSegs = allSegs.filter((s) => !s.virtual);
  const profSegs = allSegs.filter((s) => s.virtual);
  const isProfSt = virtualStatus.has(empId + '|' + day);
  let existingHtml = '';
  if (profSegs.length) {
    const kindLbl = profSegs[0].kind === 'cont' ? 'journée continue' : 'demi-journée';
    existingHtml += `<div class="cell-existing cell-profil">
      <div style="font-weight:600;margin-bottom:4px">🗓️ Programmé dans le profil — ${kindLbl}</div>
      <div class="cell-profil-h">${profSegs.map((s) => `${fmtTime(s.clockIn)} – ${fmtTime(s.clockOut)}`).join(' · ')}</div>
      <div class="cell-profil-note">Pour ce jour seulement : ajoutez d'autres horaires plus bas (ils remplacent ceux du profil), marquez la journée (congé, repos…), ou annulez.</div>
      <button class="btn btn-ghost" id="ce-normal" style="margin-top:8px">Annuler pour ce jour — journée complète</button>
    </div>`;
  }
  if (realSegs.length) {
    existingHtml += '<div class="cell-existing"><div style="font-weight:600;margin-bottom:6px">Horaires saisis</div>';
    for (const s of realSegs) {
      existingHtml += `<div class="seg-edit">
        <label>Arrivée</label>${timeSelect('seg-start', s.id, fmtTime(s.clockIn))}
        <label>Départ</label>${timeSelect('seg-end', s.id, s.open ? '' : fmtTime(s.clockOut))}
        <button class="link-btn seg-save" data-id="${s.id}">Enregistrer</button>
        <button class="link-btn danger seg-del" data-id="${s.id}">Supprimer</button>
      </div>`;
    }
    existingHtml += '</div>';
  }
  const statusLine = status ? `<div class="sub">Statut actuel : <strong>${STATUS_FULL[status]}</strong>${isProfSt ? ' — programmé dans le profil' : ''}</div>` : '';

  // Choix du poste par service : manuel (prime sur l'auto) ou retour à l'auto.
  const ALL_POSTE_KEYS = [...POSTES.map((p) => p.key), 'mise_en_place'];
  const posteRow = (svc, icon) => {
    const manual = assignMap.get(empId + '|' + day + '|' + svc);
    const effective = lastPosteOf[empId + '|' + day + '|' + svc];
    const autoTitle = !manual && effective ? ` (actuel : ${POSTE_LABELS[effective]})` : '';
    return `<div class="ce-poste-row" data-svc="${svc}">
      <span class="ce-poste-svc">${icon}</span>
      ${ALL_POSTE_KEYS.map((k) => `<button type="button" class="po-pick po-${k}${manual === k ? ' active' : ''}" data-svc="${svc}" data-k="${k}">${POSTE_LABELS[k]}</button>`).join('')}
      <button type="button" class="po-pick po-pick-auto${manual ? '' : ' active'}" data-svc="${svc}" data-k="" title="Laisser l'affectation automatique (semaine type, puis préférences)${autoTitle}">Auto${autoTitle}</button>
    </div>`;
  };

  cellModal.innerHTML = `
    <h2>${escapeHtml(emp.name)}</h2>
    <div class="sub">${planningDayLabel(day).replace('<br>', ' ')}</div>
    ${statusLine}
    ${existingHtml}
    <div class="field" style="margin-top:14px"><label>Poste (midi / soir) — clic sur un poste pour l'imposer, « Auto » pour revenir aux préférences</label></div>
    ${posteRow('midi', '☀️')}
    ${posteRow('soir', '🌙')}
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
      <button class="btn btn-ghost exb-btn st-extra${(status === 'extra_midi' || status === 'extra_both') ? ' active' : ''}" data-exb="midi">Extra midi</button>
      <button class="btn btn-ghost exb-btn st-extra${(status === 'extra_soir' || status === 'extra_both') ? ' active' : ''}" data-exb="soir">Extra soir</button>
      ${(status && !isProfSt) ? `<button class="btn btn-ghost" id="ce-clear">${status === 'normal' ? "Rétablir l'horaire du profil" : 'Effacer le statut'}</button>` : ''}
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
  cellModal.querySelectorAll('.po-pick').forEach((b) => {
    b.addEventListener('click', async () => {
      const svc = b.dataset.svc;
      const cur = assignMap.get(empId + '|' + day + '|' + svc);
      // Re-clic sur le poste déjà imposé, ou clic sur « Auto » → retour à l'auto.
      const next = (!b.dataset.k || cur === b.dataset.k) ? null : b.dataset.k;
      const { ok, data } = await api('/api/admin/poste-assign', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: empId, date: day, service: svc, poste: next }),
      });
      if (!ok) { cellMsg((data && data.error) || 'Erreur'); return; }
      await refreshAfterCell(empId, day);
    });
  });
  cellModal.querySelectorAll('.st-btn').forEach((b) => {
    // Clic sur le statut déjà actif => on l'enlève (bascule), comme les boutons Échange.
    // Demi posée par le profil : re-cliquer dessus = l'annuler pour ce jour
    // (statut « journée complète »), puisqu'il n'y a rien d'enregistré à effacer.
    b.addEventListener('click', () => setCellStatus(empId, day,
      status === b.dataset.st ? (isProfSt ? 'normal' : null) : b.dataset.st));
  });
  cellModal.querySelectorAll('.ech-btn').forEach((b) => {
    b.addEventListener('click', () => toggleEchange(empId, day, b.dataset.ech));
  });
  cellModal.querySelectorAll('.exb-btn').forEach((b) => {
    b.addEventListener('click', () => toggleExtra(empId, day, b.dataset.exb));
  });
  const normalBtn = cellModal.querySelector('#ce-normal');
  if (normalBtn) normalBtn.addEventListener('click', () => setCellStatus(empId, day, 'normal'));
  const clearBtn = cellModal.querySelector('#ce-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => setCellStatus(empId, day, null));
  cellModal.querySelector('#ce-close').addEventListener('click', closeCellEditor);
  cellOverlay.classList.add('show');
}

function cellMsg(m) { const el = $('ce-msg'); if (el) { el.textContent = m; el.classList.add('show'); } }

// Bascule le marquage « extra » d'un service (midi/soir), combinable (extra_both).
function toggleExtra(empId, day, service) {
  const cur = statusMap.get(empId + '|' + day);
  let m = (cur === 'extra_midi' || cur === 'extra_both');
  let s = (cur === 'extra_soir' || cur === 'extra_both');
  if (service === 'midi') m = !m; else s = !s;
  let next = null;
  if (m && s) next = 'extra_both';
  else if (m) next = 'extra_midi';
  else if (s) next = 'extra_soir';
  setCellStatus(empId, day, next);
}

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
      document.title = data.establishment + ' — Planning Cuisine';
    }
  } catch { /* ignore */ }
}

// --- Init -----------------------------------------------------------------
applyEstablishment();
checkAuth();

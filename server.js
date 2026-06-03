'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const {
  db, hashSecret, verifySecret, getSetting, setSetting,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_NAME = 'ph_session';
// Nom de l'établissement (optionnel) : permet, en cas de plusieurs sites,
// de distinguer chaque instance. Défini par établissement via la variable
// d'environnement ETABLISSEMENT. Vide = comportement actuel inchangé.
const ETABLISSEMENT = (process.env.ETABLISSEMENT || '').trim();
// En production (HTTPS), sécuriser le cookie admin. Activé par COOKIE_SECURE=1.
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration publique (nom de l'établissement affiché dans l'interface).
// Priorité : variable d'environnement ETABLISSEMENT, sinon réglage en base.
app.get('/api/config', (req, res) => {
  res.json({ establishment: ETABLISSEMENT || getSetting('establishment') || '' });
});

// --- Utilitaires ----------------------------------------------------------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function signSession(payload) {
  const secret = getSetting('session_secret');
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const secret = getSetting('session_secret');
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  const session = verifySession(token);
  if (!session || session.role !== 'admin') {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
}

// --- Pauses obligatoires --------------------------------------------------

function getBreakWindows() {
  try {
    const raw = getSetting('break_windows');
    const arr = raw ? JSON.parse(raw) : [];
    return arr.filter((w) => /^\d{2}:\d{2}$/.test(w.start) && /^\d{2}:\d{2}$/.test(w.end));
  } catch {
    return [];
  }
}

// Timestamp d'un horaire "HH:MM" pour le jour calendaire d'une date donnée.
function windowTs(baseDate, hm) {
  const [h, m] = hm.split(':').map(Number);
  return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), h, m, 0, 0).getTime();
}

// Durée (ms) de chevauchement entre un segment [inTs, endTs] et les créneaux
// de pause obligatoire. Gère le cas (rare) d'un segment à cheval sur plusieurs jours.
function breakOverlapMs(inTs, endTs, windows = getBreakWindows()) {
  if (endTs <= inTs || !windows.length) return 0;
  let deduct = 0;
  const cursor = new Date(inTs);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= endTs) {
    for (const w of windows) {
      const ws = windowTs(cursor, w.start);
      const we = windowTs(cursor, w.end);
      const overlap = Math.min(endTs, we) - Math.max(inTs, ws);
      if (overlap > 0) deduct += overlap;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return deduct;
}

// Décomposition d'un segment : durée brute, pause déduite, durée nette (en ms).
// Tant que le DÉPART n'est pas renseigné (clock_out null), la période ne compte
// pas (0) : les heures ne sont calculées qu'une fois le départ saisi.
function segmentBreakdown(e, now = Date.now(), windows = getBreakWindows()) {
  if (e.clock_out == null) return { grossMs: 0, breakMs: 0, netMs: 0 };
  const end = e.clock_out;
  const grossMs = Math.max(0, end - e.clock_in);
  const breakMs = Math.min(grossMs, breakOverlapMs(e.clock_in, end, windows));
  return { grossMs, breakMs, netMs: grossMs - breakMs };
}

// Total de secondes NETTES travaillées (pauses obligatoires déduites).
function workedSeconds(entries, now = Date.now()) {
  const windows = getBreakWindows();
  let netMs = 0;
  for (const e of entries) netMs += segmentBreakdown(e, now, windows).netMs;
  return Math.floor(netMs / 1000);
}

// Clé de jour locale "AAAA-MM-JJ" à partir d'un timestamp.
function localDay(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getTime();
}
function endOfDay(dateStr) {
  return new Date(`${dateStr}T23:59:59.999`).getTime();
}
// Timestamp local à partir d'une date "AAAA-MM-JJ" et d'une heure "HH:MM".
function tsFromDateTime(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`).getTime();
}

// Heure de bascule du « jour de travail » (en heures). Un pointage commencé
// avant cette heure (travail de nuit) est rattaché au jour PRÉCÉDENT, c.-à-d.
// au jour de l'arrivée du poste. Les arrivées normales sont à partir de 9h30,
// donc 5h laisse une large marge sans jamais déplacer un poste de jour.
const DAY_CUTOFF_HOUR = 5;
const DAY_CUTOFF_MS = DAY_CUTOFF_HOUR * 60 * 60 * 1000;

// Jour de travail (clé "AAAA-MM-JJ") auquel rattacher un horodatage.
function businessDay(ts) {
  return localDay(ts - DAY_CUTOFF_MS);
}
// Début (timestamp) de la journée de travail d'une date donnée.
function businessDayStart(dateStr) {
  return startOfDay(dateStr) + DAY_CUTOFF_MS;
}
const DAY_MS = 24 * 60 * 60 * 1000;

function openEntryFor(employeeId) {
  return db.prepare(
    'SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1'
  ).get(employeeId);
}

// Pointages de la journée de travail en cours (les heures de nuit d'après
// minuit restent rattachées à la journée commencée la veille).
function todayEntries(employeeId) {
  const from = businessDayStart(businessDay(Date.now()));
  const to = from + DAY_MS;
  return db.prepare(
    'SELECT * FROM time_entries WHERE employee_id = ? AND clock_in >= ? AND clock_in < ? ORDER BY clock_in ASC'
  ).all(employeeId, from, to);
}

// =========================================================================
//  API PUBLIQUE (pointage)
// =========================================================================

// Catégories de salariés (ordre hiérarchique d'affichage).
const CATEGORIES = ['responsable', 'chef_de_rang', 'apprenti'];

// Liste des employés actifs avec leur statut courant.
app.get('/api/employees', (req, res) => {
  const employees = db.prepare(
    'SELECT id, name, category FROM employees WHERE active = 1 ORDER BY name COLLATE NOCASE'
  ).all();
  const result = employees.map((emp) => {
    const open = openEntryFor(emp.id);
    const entries = todayEntries(emp.id);
    return {
      id: emp.id,
      name: emp.name,
      category: emp.category || 'chef_de_rang',
      working: !!open,
      since: open ? open.clock_in : null,
      todaySeconds: workedSeconds(entries),
      todayCount: entries.length,
    };
  });
  res.json(result);
});

// Planning d'une semaine en LECTURE SEULE (écran de pointage). Public, sans édition.
app.get('/api/planning', (req, res) => {
  const { from, to } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return res.status(400).json({ error: 'Période invalide' });
  }
  const employees = db.prepare(
    'SELECT id, name, category, rest_days, continuous_service, active, end_date, sort_order FROM employees'
  ).all().map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    restPeriods: parseRestPeriods(r.rest_days),
    continuous: !!r.continuous_service,
    active: r.active,
    endDate: r.end_date || null,
    sortOrder: r.sort_order,
  }));
  const report = buildReport({ from, to });
  const statuses = db.prepare(
    'SELECT employee_id AS employeeId, day, status FROM day_status WHERE day >= ? AND day <= ?'
  ).all(from, to);
  let extra = {};
  try { const v = JSON.parse(getSetting('extra_notes') || '{}'); if (v && typeof v === 'object') extra = v; } catch { /* ignore */ }
  let events = {};
  try { const v = JSON.parse(getSetting('event_notes') || '{}'); if (v && typeof v === 'object') events = v; } catch { /* ignore */ }
  res.json({ employees, report, statuses, extra, events });
});

// Arrivées encore ouvertes (sans départ) de la journée de travail en cours,
// classées par service (midi / soir) selon l'heure d'arrivée. Sert à l'écran
// de saisie des départs : seuls les salariés présents ce jour apparaissent.
app.get('/api/open-entries', (req, res) => {
  const today = businessDay(Date.now());
  const rows = db.prepare(`
    SELECT t.id, t.clock_in, t.employee_id, e.name, e.category
    FROM time_entries t JOIN employees e ON e.id = t.employee_id
    WHERE t.clock_out IS NULL AND e.active = 1
    ORDER BY t.clock_in ASC
  `).all();
  const out = [];
  for (const r of rows) {
    if (businessDay(r.clock_in) !== today) continue;
    const h = new Date(r.clock_in).getHours();
    const service = (h >= DAY_CUTOFF_HOUR && h < 17) ? 'midi' : 'soir';
    out.push({
      entryId: r.id,
      employeeId: r.employee_id,
      name: r.name,
      category: r.category || 'chef_de_rang',
      clockIn: r.clock_in,
      service,
    });
  }
  res.json(out);
});

// Délai au-delà duquel un pointage déjà enregistré ne peut plus être modifié.
const EDIT_WINDOW_DAYS = 7;
const EDIT_WINDOW_MS = EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Identifie un employé. Le code PIN a été retiré : on vérifie seulement que
// l'employé existe et est actif (l'argument pin est ignoré, conservé pour
// compatibilité au cas où le PIN serait réactivé plus tard).
function authEmployee(employeeId, pin) {
  const emp = db.prepare(
    'SELECT * FROM employees WHERE id = ? AND active = 1'
  ).get(employeeId);
  if (!emp) return { status: 404, error: 'Employé introuvable' };
  return { emp };
}

// Un pointage est modifiable tant qu'il a moins de EDIT_WINDOW_DAYS jours.
function isEditable(clockIn) {
  return (Date.now() - clockIn) <= EDIT_WINDOW_MS;
}

// Pointer avec saisie manuelle de l'heure.
//   action 'in'  : le salarié (absent) saisit son heure d'ARRIVÉE → ouvre une période.
//   action 'out' : le salarié (présent) saisit son heure de DÉPART → ferme la période.
// L'heure saisie peut être dans le passé OU le futur (aucune restriction).
app.post('/api/punch', (req, res) => {
  const { employeeId, pin, action, date, time } = req.body || {};
  if (!employeeId || !['in', 'out'].includes(action)) {
    return res.status(400).json({ error: 'Requête invalide' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) {
    return res.status(400).json({ error: 'Date ou heure invalide' });
  }
  const auth = authEmployee(employeeId, pin);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const emp = auth.emp;

  const ts = tsFromDateTime(date, time);
  if (Number.isNaN(ts)) return res.status(400).json({ error: 'Date ou heure invalide' });

  const open = openEntryFor(emp.id);

  if (action === 'in') {
    if (open) {
      return res.status(409).json({ error: "Vous êtes déjà pointé. Saisissez d'abord votre départ." });
    }
    db.prepare('INSERT INTO time_entries (employee_id, clock_in) VALUES (?, ?)').run(emp.id, ts);
  } else {
    if (!open) {
      return res.status(409).json({ error: "Vous n'êtes pas pointé." });
    }
    if (ts <= open.clock_in) {
      return res.status(400).json({ error: "Le départ doit être après l'arrivée." });
    }
    db.prepare('UPDATE time_entries SET clock_out = ?, ended_by = ? WHERE id = ?')
      .run(ts, 'manual', open.id);
  }

  const entries = todayEntries(emp.id);
  const nowOpen = openEntryFor(emp.id);
  res.json({
    name: emp.name,
    working: !!nowOpen,
    since: nowOpen ? nowOpen.clock_in : null,
    todaySeconds: workedSeconds(entries),
    action,
    at: ts,
  });
});

// Saisie d'une période complète (arrivée + départ optionnel) par le salarié.
// L'application sert surtout à SAISIR les horaires (pas de notion présent/absent).
app.post('/api/entry', (req, res) => {
  const { employeeId, date, start, end } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(Number(employeeId));
  if (!emp) return res.status(404).json({ error: 'Employé introuvable' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(start || '')) {
    return res.status(400).json({ error: "Date ou heure d'arrivée invalide" });
  }
  const inTs = tsFromDateTime(date, start);
  if (Number.isNaN(inTs)) return res.status(400).json({ error: 'Date ou heure invalide' });

  let outTs = null; // départ optionnel : période ouverte (non comptée) tant qu'absent
  if (end) {
    if (!/^\d{2}:\d{2}$/.test(end)) return res.status(400).json({ error: 'Heure de départ invalide' });
    outTs = tsFromDateTime(date, end);
    if (Number.isNaN(outTs)) return res.status(400).json({ error: 'Heure de départ invalide' });
    if (outTs <= inTs) outTs += DAY_MS; // départ après minuit → lendemain
  }
  db.prepare(
    'INSERT INTO time_entries (employee_id, clock_in, clock_out, ended_by) VALUES (?, ?, ?, ?)'
  ).run(emp.id, inTs, outTs, outTs != null ? 'manual' : null);

  const entries = todayEntries(emp.id);
  res.json({
    name: emp.name, date, start, end: end || null,
    todaySeconds: workedSeconds(entries),
  });
});

// Arrivée groupée : une même heure d'arrivée pour plusieurs salariés (arrivée
// seule, départ à compléter ensuite).
app.post('/api/entries/bulk', (req, res) => {
  const { employeeIds, date, start } = req.body || {};
  if (!Array.isArray(employeeIds) || !employeeIds.length) {
    return res.status(400).json({ error: 'Aucun salarié sélectionné' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(start || '')) {
    return res.status(400).json({ error: "Date ou heure d'arrivée invalide" });
  }
  const inTs = tsFromDateTime(date, start);
  if (Number.isNaN(inTs)) return res.status(400).json({ error: 'Date ou heure invalide' });
  const ins = db.prepare('INSERT INTO time_entries (employee_id, clock_in, clock_out, ended_by) VALUES (?, ?, NULL, NULL)');
  let count = 0;
  db.transaction(() => {
    for (const id of employeeIds) {
      const emp = db.prepare('SELECT id FROM employees WHERE id = ? AND active = 1').get(Number(id));
      if (emp) { ins.run(emp.id, inTs); count++; }
    }
  })();
  res.json({ ok: true, count });
});

// Liste des pointages récents de l'employé (consultation / modification).
app.post('/api/my-entries', (req, res) => {
  const { employeeId, pin } = req.body || {};
  const auth = authEmployee(employeeId, pin);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const emp = auth.emp;

  const from = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    'SELECT * FROM time_entries WHERE employee_id = ? AND clock_in >= ? ORDER BY clock_in DESC'
  ).all(emp.id, from);

  res.json({
    name: emp.name,
    editWindowDays: EDIT_WINDOW_DAYS,
    entries: rows.map((r) => {
      const b = segmentBreakdown(r);
      return {
        id: r.id,
        clockIn: r.clock_in,
        clockOut: r.clock_out,
        open: r.clock_out == null,
        grossSeconds: Math.floor(b.grossMs / 1000),
        breakSeconds: Math.floor(b.breakMs / 1000),
        netSeconds: Math.floor(b.netMs / 1000),
        editable: isEditable(r.clock_in),
      };
    }),
  });
});

// Modification d'un pointage déjà enregistré (verrouillé au-delà de 7 jours).
app.put('/api/my-entries/:id', (req, res) => {
  const { employeeId, pin, date, start, end } = req.body || {};
  const auth = authEmployee(employeeId, pin);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const emp = auth.emp;

  const entry = db.prepare(
    'SELECT * FROM time_entries WHERE id = ? AND employee_id = ?'
  ).get(Number(req.params.id), emp.id);
  if (!entry) return res.status(404).json({ error: 'Pointage introuvable' });
  if (!isEditable(entry.clock_in)) {
    return res.status(403).json({
      error: `Ce pointage a plus de ${EDIT_WINDOW_DAYS} jours et ne peut plus être modifié.`,
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(start || '')) {
    return res.status(400).json({ error: "Date ou heure d'arrivée invalide" });
  }
  const inTs = tsFromDateTime(date, start);
  if (Number.isNaN(inTs)) return res.status(400).json({ error: 'Date ou heure invalide' });

  let outTs = null;
  if (end) {
    if (!/^\d{2}:\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'Heure de départ invalide' });
    }
    outTs = tsFromDateTime(date, end);
    if (Number.isNaN(outTs)) return res.status(400).json({ error: 'Heure de départ invalide' });
    if (outTs <= inTs) outTs += DAY_MS; // départ après minuit → lendemain
  }

  db.prepare('UPDATE time_entries SET clock_in = ?, clock_out = ?, ended_by = ? WHERE id = ?')
    .run(inTs, outTs, outTs != null ? 'manual' : null, entry.id);
  res.json({ ok: true });
});

// Suppression d'un de ses pointages (verrouillé au-delà de 7 jours).
app.delete('/api/my-entries/:id', (req, res) => {
  const { employeeId, pin } = req.body || {};
  const auth = authEmployee(employeeId, pin);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const entry = db.prepare(
    'SELECT * FROM time_entries WHERE id = ? AND employee_id = ?'
  ).get(Number(req.params.id), auth.emp.id);
  if (!entry) return res.status(404).json({ error: 'Pointage introuvable' });
  if (!isEditable(entry.clock_in)) {
    return res.status(403).json({
      error: `Ce pointage a plus de ${EDIT_WINDOW_DAYS} jours et ne peut plus être supprimé.`,
    });
  }
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(entry.id);
  res.json({ ok: true });
});

// =========================================================================
//  API ADMIN
// =========================================================================

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const stored = getSetting('admin_password');
  if (!password || !verifySecret(password, stored)) {
    return res.status(403).json({ error: 'Mot de passe incorrect' });
  }
  const token = signSession({ role: 'admin', exp: Date.now() + 8 * 3600 * 1000 });
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8 * 3600}${COOKIE_SECURE}`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  const session = verifySession(parseCookies(req)[COOKIE_NAME]);
  res.json({ loggedIn: !!(session && session.role === 'admin') });
});

app.put('/api/admin/password', requireAdmin, (req, res) => {
  const { current, next: nextPwd } = req.body || {};
  if (!verifySecret(current, getSetting('admin_password'))) {
    return res.status(403).json({ error: 'Mot de passe actuel incorrect' });
  }
  if (!nextPwd || String(nextPwd).length < 4) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 4 caractères' });
  }
  setSetting('admin_password', hashSecret(nextPwd));
  res.json({ ok: true });
});

// --- Nom de l'établissement -----------------------------------------------

app.get('/api/admin/establishment', requireAdmin, (req, res) => {
  res.json({
    establishment: getSetting('establishment') || '',
    envOverride: !!ETABLISSEMENT, // si défini par variable d'env, le réglage est ignoré
  });
});

app.put('/api/admin/establishment', requireAdmin, (req, res) => {
  const { name } = req.body || {};
  setSetting('establishment', String(name || '').trim());
  res.json({ ok: true });
});

// --- Pauses obligatoires (config) -----------------------------------------

app.get('/api/admin/breaks', requireAdmin, (req, res) => {
  res.json(getBreakWindows());
});

app.put('/api/admin/breaks', requireAdmin, (req, res) => {
  const windows = Array.isArray(req.body) ? req.body : (req.body && req.body.windows);
  if (!Array.isArray(windows)) {
    return res.status(400).json({ error: 'Format invalide' });
  }
  const clean = [];
  for (const w of windows) {
    if (!/^\d{2}:\d{2}$/.test(w.start) || !/^\d{2}:\d{2}$/.test(w.end)) {
      return res.status(400).json({ error: 'Format des horaires invalide (attendu HH:MM)' });
    }
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) {
      return res.status(400).json({ error: 'Horaire invalide' });
    }
    if (eh * 60 + em <= sh * 60 + sm) {
      return res.status(400).json({ error: 'La fin doit être après le début' });
    }
    clean.push({ start: w.start, end: w.end });
  }
  setSetting('break_windows', JSON.stringify(clean));
  res.json({ ok: true, windows: clean });
});

// --- Gestion des employés -------------------------------------------------

function parseRestDays(s) {
  return String(s || '').split(',').map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

// Jours de repos HISTORISÉS : liste de périodes { from:'AAAA-MM-JJ', days:[...] }.
// Gère aussi l'ancien format CSV ("1,2") → période unique depuis 2000.
function parseRestPeriods(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) {
      return v
        .filter((p) => p && /^\d{4}-\d{2}-\d{2}$/.test(p.from))
        .map((p) => ({ from: p.from, days: parseRestDays((p.days || []).join(',')) }))
        .sort((a, b) => a.from.localeCompare(b.from));
    }
  } catch { /* ancien format CSV */ }
  return [{ from: '2000-01-01', days: parseRestDays(raw) }];
}
// Jours de repos applicables à une date donnée (dernière période dont from <= date).
function restDaysOn(periods, dateStr) {
  let best = null;
  for (const p of periods) if (p.from <= dateStr && (!best || p.from > best.from)) best = p;
  return best ? best.days : [];
}

app.get('/api/admin/employees', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, category, rest_days, continuous_service, sort_order, active, end_date, created_at FROM employees ORDER BY active DESC, sort_order ASC, name COLLATE NOCASE'
  ).all();
  const today = localDay(Date.now());
  res.json(rows.map((r) => {
    const periods = parseRestPeriods(r.rest_days);
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      active: r.active,
      endDate: r.end_date || null, // dernier jour dans l'entreprise (si désactivé)
      sortOrder: r.sort_order,
      created_at: r.created_at,
      restDays: restDaysOn(periods, today), // applicables aujourd'hui (affichage profil)
      restPeriods: periods, // historique complet (utilisé par le planning, par jour)
      continuous: !!r.continuous_service,
    };
  }));
});

// Réordonner les salariés (glisser-déposer). À placer AVANT la route /:id.
app.put('/api/admin/employees/order', requireAdmin, (req, res) => {
  const order = req.body && req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Format invalide' });
  const upd = db.prepare('UPDATE employees SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, i) => upd.run(i, Number(id))); })();
  res.json({ ok: true });
});

app.post('/api/admin/employees', requireAdmin, (req, res) => {
  const { name, pin, category } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Le nom est obligatoire' });
  }
  // Le PIN a été retiré : non requis. On conserve une valeur par défaut en
  // base (au cas où le PIN serait réactivé un jour).
  const pinValue = /^\d{4}$/.test(String(pin || '')) ? String(pin) : '0000';
  const cat = CATEGORIES.includes(category) ? category : 'chef_de_rang';
  const info = db.prepare(
    'INSERT INTO employees (name, pin_hash, category, active, created_at) VALUES (?, ?, ?, 1, ?)'
  ).run(String(name).trim(), hashSecret(pinValue), cat, Date.now());
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/admin/employees/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!emp) return res.status(404).json({ error: 'Employé introuvable' });

  const { name, pin, active, category } = req.body || {};
  if (name !== undefined && String(name).trim()) {
    db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(String(name).trim(), id);
  }
  if (category !== undefined && CATEGORIES.includes(category)) {
    db.prepare('UPDATE employees SET category = ? WHERE id = ?').run(category, id);
  }
  if (req.body && Array.isArray(req.body.restDays)) {
    const clean = [...new Set(req.body.restDays
      .map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
    // Date d'effet : par défaut aujourd'hui ; le futur n'altère pas le passé/présent.
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.body.restDaysFrom || '')
      ? req.body.restDaysFrom : localDay(Date.now());
    const periods = parseRestPeriods(emp.rest_days).filter((p) => p.from !== from);
    periods.push({ from, days: clean });
    periods.sort((a, b) => a.from.localeCompare(b.from));
    db.prepare('UPDATE employees SET rest_days = ? WHERE id = ?')
      .run(JSON.stringify(periods.map((p) => ({ from: p.from, days: p.days }))), id);
  }
  if (req.body && req.body.continuous !== undefined) {
    db.prepare('UPDATE employees SET continuous_service = ? WHERE id = ?').run(req.body.continuous ? 1 : 0, id);
  }
  if (pin !== undefined && pin !== '') {
    if (!/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ error: 'Le PIN doit comporter exactement 4 chiffres' });
    }
    db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(hashSecret(pin), id);
  }
  if (active !== undefined) {
    if (!active) {
      // Désactivation : le dernier jour dans l'entreprise est obligatoire.
      const endDate = req.body.endDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
        return res.status(400).json({ error: "Le dernier jour dans l'entreprise est obligatoire." });
      }
      db.prepare('UPDATE employees SET active = 0, end_date = ? WHERE id = ?').run(endDate, id);
    } else {
      // Réactivation : on efface la date de fin.
      db.prepare('UPDATE employees SET active = 1, end_date = NULL WHERE id = ?').run(id);
    }
  }
  res.json({ ok: true });
});

app.delete('/api/admin/employees/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  // Désactivation (on conserve l'historique des pointages).
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Saisie d'horaires côté admin (depuis le planning) --------------------

app.post('/api/admin/entries', requireAdmin, (req, res) => {
  const { employeeId, date, start, end } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(employeeId));
  if (!emp) return res.status(404).json({ error: 'Employé introuvable' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(start || '')) {
    return res.status(400).json({ error: "Date ou heure d'arrivée invalide" });
  }
  const inTs = tsFromDateTime(date, start);
  if (Number.isNaN(inTs)) return res.status(400).json({ error: 'Date ou heure invalide' });

  // Départ optionnel : sans départ, la période reste ouverte (non comptée).
  let outTs = null;
  if (end) {
    if (!/^\d{2}:\d{2}$/.test(end)) return res.status(400).json({ error: 'Heure de départ invalide' });
    outTs = tsFromDateTime(date, end);
    if (Number.isNaN(outTs)) return res.status(400).json({ error: 'Heure de départ invalide' });
    if (outTs <= inTs) outTs += DAY_MS; // départ après minuit → lendemain
  }
  db.prepare(
    'INSERT INTO time_entries (employee_id, clock_in, clock_out, ended_by) VALUES (?, ?, ?, ?)'
  ).run(emp.id, inTs, outTs, outTs != null ? 'manual' : null);
  res.json({ ok: true });
});

// Corriger une période existante : heure d'arrivée et/ou de départ.
app.put('/api/admin/entries/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ error: 'Période introuvable' });
  const { start, end } = req.body || {};
  const dayStr = localDay(e.clock_in); // on conserve le jour de l'arrivée

  let inTs = e.clock_in;
  if (start !== undefined && start !== '') {
    if (!/^\d{2}:\d{2}$/.test(start)) return res.status(400).json({ error: "Heure d'arrivée invalide" });
    inTs = tsFromDateTime(dayStr, start);
    if (Number.isNaN(inTs)) return res.status(400).json({ error: 'Heure invalide' });
  }

  let outTs = null; // départ vide → période ré-ouverte (non comptée)
  if (end !== undefined && end !== '') {
    if (!/^\d{2}:\d{2}$/.test(end)) return res.status(400).json({ error: 'Heure de départ invalide' });
    outTs = tsFromDateTime(dayStr, end);
    if (Number.isNaN(outTs)) return res.status(400).json({ error: 'Heure invalide' });
    if (outTs <= inTs) outTs += DAY_MS; // départ après minuit → lendemain
  }

  db.prepare('UPDATE time_entries SET clock_in = ?, clock_out = ?, ended_by = ? WHERE id = ?')
    .run(inTs, outTs, outTs != null ? 'manual' : null, id);
  res.json({ ok: true });
});

// Suppression d'une période (côté admin, depuis le planning).
app.delete('/api/admin/entries/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM time_entries WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true, deleted: info.changes });
});

// --- Statuts de journée (CP / AM / École) ---------------------------------

const DAY_STATUSES = ['cp', 'am', 'ecole', 'absent', 'repos'];

app.get('/api/admin/day-statuses', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Période manquante' });
  const rows = db.prepare(
    'SELECT employee_id AS employeeId, day, status FROM day_status WHERE day >= ? AND day <= ?'
  ).all(from, to);
  res.json(rows);
});

app.put('/api/admin/day-status', requireAdmin, (req, res) => {
  const { employeeId, date, status } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(employeeId));
  if (!emp) return res.status(404).json({ error: 'Employé introuvable' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return res.status(400).json({ error: 'Date invalide' });
  }
  // status null/vide → on efface le statut du jour
  if (status === null || status === undefined || status === '') {
    db.prepare('DELETE FROM day_status WHERE employee_id = ? AND day = ?').run(emp.id, date);
    return res.json({ ok: true, cleared: true });
  }
  if (!DAY_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }
  if (status === 'ecole' && (emp.category || 'chef_de_rang') !== 'apprenti') {
    return res.status(400).json({ error: "Le statut « École » est réservé aux apprentis." });
  }
  db.prepare(`
    INSERT INTO day_status (employee_id, day, status) VALUES (?, ?, ?)
    ON CONFLICT(employee_id, day) DO UPDATE SET status = excluded.status
  `).run(emp.id, date, status);
  res.json({ ok: true });
});

// --- Ligne « Extra » du planning (texte libre par jour et par service) ----
function readExtra() {
  try {
    const v = JSON.parse(getSetting('extra_notes') || '{}');
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
app.get('/api/admin/extra', requireAdmin, (req, res) => {
  res.json(readExtra());
});
app.put('/api/admin/extra', requireAdmin, (req, res) => {
  const { date, service, text } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Date invalide' });
  if (service !== 'midi' && service !== 'soir') return res.status(400).json({ error: 'Service invalide' });
  const map = readExtra();
  const key = `${date}|${service}`;
  const t = String(text == null ? '' : text).trim().slice(0, 200);
  if (t) map[key] = t; else delete map[key];
  setSetting('extra_notes', JSON.stringify(map));
  res.json({ ok: true });
});

// --- Ligne « Événement / Groupe » du planning (texte libre par jour) -------
function readEvents() {
  try {
    const v = JSON.parse(getSetting('event_notes') || '{}');
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
app.get('/api/admin/event', requireAdmin, (req, res) => {
  res.json(readEvents());
});
app.put('/api/admin/event', requireAdmin, (req, res) => {
  const { date, text } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Date invalide' });
  const map = readEvents();
  const t = String(text == null ? '' : text).trim().slice(0, 200);
  if (t) map[date] = t; else delete map[date];
  setSetting('event_notes', JSON.stringify(map));
  res.json({ ok: true });
});

// Pose un statut sur une PLAGE de jours (ex. toute la semaine) pour plusieurs
// salariés — bouton « Hors entreprise ». École réservée aux apprentis (ignorée sinon).
app.put('/api/admin/day-status/range', requireAdmin, (req, res) => {
  const { employeeIds, from, to, status } = req.body || {};
  if (!Array.isArray(employeeIds) || !employeeIds.length) {
    return res.status(400).json({ error: 'Aucun salarié sélectionné' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return res.status(400).json({ error: 'Période invalide' });
  }
  if (!DAY_STATUSES.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  const days = [];
  const cur = new Date(`${from}T12:00:00`); const end = new Date(`${to}T12:00:00`);
  while (cur <= end) { days.push(localDay(cur.getTime())); cur.setDate(cur.getDate() + 1); }
  const up = db.prepare(`
    INSERT INTO day_status (employee_id, day, status) VALUES (?, ?, ?)
    ON CONFLICT(employee_id, day) DO UPDATE SET status = excluded.status
  `);
  let count = 0; let skippedEcole = 0;
  db.transaction(() => {
    for (const id of employeeIds) {
      const emp = db.prepare('SELECT id, category FROM employees WHERE id = ? AND active = 1').get(Number(id));
      if (!emp) continue;
      if (status === 'ecole' && (emp.category || 'chef_de_rang') !== 'apprenti') { skippedEcole++; continue; }
      for (const d of days) { up.run(emp.id, d, status); count++; }
    }
  })();
  res.json({ ok: true, count, skippedEcole });
});

// --- Rapports -------------------------------------------------------------

function buildReport({ from, to, employeeId }) {
  // Bornes selon la journée de travail : du début du jour 'from' (05:00)
  // jusqu'au début du jour suivant 'to' (exclus).
  const fromTs = businessDayStart(from);
  const toTs = businessDayStart(to) + DAY_MS;

  let sql = `
    SELECT te.*, e.name AS employee_name
    FROM time_entries te
    JOIN employees e ON e.id = te.employee_id
    WHERE te.clock_in >= ? AND te.clock_in < ?
  `;
  const params = [fromTs, toTs];
  if (employeeId) {
    sql += ' AND te.employee_id = ?';
    params.push(Number(employeeId));
  }
  sql += ' ORDER BY e.name COLLATE NOCASE, te.clock_in ASC';

  const rows = db.prepare(sql).all(...params);
  const windows = getBreakWindows();

  // Regroupement par employé puis par jour. On accumule en millisecondes
  // et on n'arrondit qu'au moment de l'affichage.
  const byEmployee = new Map();
  for (const r of rows) {
    if (!byEmployee.has(r.employee_id)) {
      byEmployee.set(r.employee_id, {
        employeeId: r.employee_id,
        name: r.employee_name,
        days: new Map(),
      });
    }
    const emp = byEmployee.get(r.employee_id);
    const day = businessDay(r.clock_in);
    if (!emp.days.has(day)) {
      emp.days.set(day, { day, grossMs: 0, breakMs: 0, netMs: 0, segments: [] });
    }
    const b = segmentBreakdown(r, Date.now(), windows);
    const d = emp.days.get(day);
    d.grossMs += b.grossMs;
    d.breakMs += b.breakMs;
    d.netMs += b.netMs;
    d.segments.push({
      id: r.id,
      clockIn: r.clock_in,
      clockOut: r.clock_out,
      endedBy: r.ended_by,
      grossSeconds: Math.floor(b.grossMs / 1000),
      breakSeconds: Math.floor(b.breakMs / 1000),
      open: r.clock_out == null,
    });
  }

  const toSec = (ms) => Math.floor(ms / 1000);
  return [...byEmployee.values()].map((emp) => {
    const days = [...emp.days.values()].sort((a, b) => a.day.localeCompare(b.day));
    let totalNetMs = 0, totalGrossMs = 0, totalBreakMs = 0;
    for (const d of days) { totalNetMs += d.netMs; totalGrossMs += d.grossMs; totalBreakMs += d.breakMs; }
    return {
      employeeId: emp.employeeId,
      name: emp.name,
      totalSeconds: toSec(totalNetMs),
      totalGrossSeconds: toSec(totalGrossMs),
      totalBreakSeconds: toSec(totalBreakMs),
      days: days.map((d) => ({
        day: d.day,
        grossSeconds: toSec(d.grossMs),
        breakSeconds: toSec(d.breakMs),
        seconds: toSec(d.netMs),
        segments: d.segments,
      })),
    };
  });
}

app.get('/api/admin/report', requireAdmin, (req, res) => {
  const { from, to, employeeId } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Période manquante' });
  res.json(buildReport({ from, to, employeeId }));
});

app.get('/api/admin/report.csv', requireAdmin, (req, res) => {
  const { from, to, employeeId } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Période manquante' });

  const fmtH = (s) => (s ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : '');
  const dayList = (a, b) => {
    const out = []; const cur = new Date(`${a}T12:00:00`); const end = new Date(`${b}T12:00:00`);
    while (cur <= end) { out.push(localDay(cur.getTime())); cur.setDate(cur.getDate() + 1); }
    return out;
  };
  const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return localDay(d.getTime()); };

  // Fenêtre élargie (±4 semaines) pour le report d'échange multi-semaines (même logique que le tableau à l'écran).
  const extFrom = addDays(from, -28), extTo = addDays(to, 28);
  const report = buildReport({ from: extFrom, to: extTo, employeeId });
  const repById = new Map(report.map((e) => [e.employeeId, e]));

  const stat = new Map();
  for (const s of db.prepare('SELECT employee_id, day, status FROM day_status WHERE day >= ? AND day <= ?').all(extFrom, extTo)) {
    stat.set(s.employee_id + '|' + s.day, s.status);
  }

  const AWAY = ['cp', 'am', 'absent', 'ecole'];
  const SHORT = { cp: 'CP', am: 'AM', ecole: 'École', absent: 'Abs' };
  const extDays = dayList(extFrom, extTo);
  const dispDays = dayList(from, to);

  let emps = db.prepare('SELECT id, name, rest_days, active, end_date, sort_order FROM employees').all()
    .filter((e) => e.active || (e.end_date && e.end_date >= from) || repById.has(e.id));
  if (employeeId) emps = emps.filter((e) => String(e.id) === String(employeeId));
  emps.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));

  const jj = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const labels = dispDays.map((d) => {
    const dt = new Date(`${d}T12:00:00`);
    return `${jj[dt.getDay()]} ${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
  });

  const lines = ['Salarié;' + labels.join(';') + ';Total'];
  const dayTot = {}; dispDays.forEach((d) => { dayTot[d] = 0; }); let grand = 0;

  for (const emp of emps) {
    const periods = parseRestPeriods(emp.rest_days);
    const secByDay = new Map(((repById.get(emp.id) || {}).days || []).map((x) => [x.day, x.seconds]));
    const info = new Map();
    for (const d of extDays) {
      const wd = new Date(`${d}T12:00:00`).getDay();
      const status = stat.get(emp.id + '|' + d);
      const isRest = restDaysOn(periods, d).includes(wd) || status === 'repos';
      info.set(d, { sec: secByDay.get(d) || 0, status, isRest, carriedFrom: null, carriedTo: null });
    }
    // Report des échanges : heures d'un jour de repos → 1er jour vide (avant/après).
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
      if (target) { used.add(target); const t = info.get(target); t.sec = it.sec; t.carriedFrom = exDay; it.carriedTo = target; it.sec = 0; }
    }
    let tot = 0;
    const cells = dispDays.map((d) => {
      const it = info.get(d);
      if (it.sec > 0) { dayTot[d] += it.sec; tot += it.sec; return fmtH(it.sec) + (it.carriedFrom ? ' (éch)' : ''); }
      if (AWAY.includes(it.status)) return SHORT[it.status];
      if (it.isRest) return 'Repos';
      return '';
    });
    grand += tot;
    lines.push([emp.name, ...cells, fmtH(tot)].join(';'));
  }
  lines.push(['Total / jour', ...dispDays.map((d) => fmtH(dayTot[d])), fmtH(grand)].join(';'));

  const csv = '﻿' + lines.join('\r\n'); // BOM pour Excel
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="heures_${from}_${to}.csv"`);
  res.send(csv);
});

// =========================================================================
//  Sauvegarde automatique
// =========================================================================

// À CHAQUE démarrage, copie horodatée (date + heure) de la base dans ./backups,
// en conservant les BACKUP_KEEP dernières. Ne supprime jamais la base courante.
// Chaque redémarrage crée ainsi un point de restauration.
// En production, pointer BACKUP_DIR vers le disque persistant (ex. /var/data/backups).
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUP_KEEP = 30;

function backupOnStart() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const dest = path.join(BACKUP_DIR, `data-${stamp}.db`);
    if (fs.existsSync(dest)) return;
    db.backup(dest)
      .then(() => {
        console.log(`  Sauvegarde créée : backups/data-${stamp}.db`);
        const files = fs.readdirSync(BACKUP_DIR)
          .filter((f) => /^data-.*\.db$/.test(f)).sort();
        while (files.length > BACKUP_KEEP) {
          fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
        }
      })
      .catch((e) => console.warn('  Sauvegarde impossible :', e.message));
  } catch (e) {
    console.warn('  Sauvegarde impossible :', e.message);
  }
}

app.listen(PORT, () => {
  backupOnStart();
  console.log(`\n  Pointage horaire — serveur démarré`);
  console.log(`  Pointage : http://localhost:${PORT}/`);
  console.log(`  Admin    : http://localhost:${PORT}/admin.html\n`);
});

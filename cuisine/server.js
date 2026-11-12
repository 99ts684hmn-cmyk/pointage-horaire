'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const {
  db, hashSecret, verifySecret, getSetting, setSetting,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3200;
const COOKIE_NAME = 'plc_session';
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
// Timestamp local à partir d'une date "AAAA-MM-JJ" et d'une heure "HH:MM".
function tsFromDateTime(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`).getTime();
}

// Heure de bascule du « jour de travail » (en heures). Un horaire commencé
// avant cette heure (travail de nuit) est rattaché au jour PRÉCÉDENT, c.-à-d.
// au jour de l'arrivée du poste.
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

// Catégories de salariés (cuisine).
const CATEGORIES = ['chef', 'manager', 'chef_de_partie', 'cuisinier', 'apprenti', 'plongeur'];
const DEFAULT_CATEGORY = 'cuisinier';

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

// --- Gestion des employés -------------------------------------------------

function parseRestDays(s) {
  // filtre les chaînes vides AVANT Number() : Number('') vaut 0 (= dimanche !)
  return String(s || '').split(',').map((x) => x.trim()).filter((x) => x !== '')
    .map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
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

// --- Rythme hebdomadaire du profil : demi-journée + journée continue --------
// Chaque salarié peut avoir, par semaine, UNE demi-journée et UNE journée
// continue : un jour de la semaine + une heure de début et de fin. Le planning
// les applique tout seul, chaque semaine, tant que le jour n'a rien de saisi
// (ni horaires, ni statut). Historisé par date d'effet, comme les repos.
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanShift(x) {
  if (!x || typeof x !== 'object') return null;
  const day = Number(x.day);
  if (x.day === '' || x.day === null || x.day === undefined) return null;
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  if (!HM_RE.test(x.start || '') || !HM_RE.test(x.end || '')) return null;
  return { day, start: x.start, end: x.end };
}
function parseSchedule(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((p) => p && ISO_RE.test(p.from || ''))
      .map((p) => ({ from: p.from, demi: cleanShift(p.demi), cont: cleanShift(p.cont) }))
      .sort((a, b) => a.from.localeCompare(b.from));
  } catch { return []; }
}
function scheduleOn(periods, dateStr) {
  let best = null;
  for (const p of periods) if (p.from <= dateStr && (!best || p.from > best.from)) best = p;
  return best;
}
const sameShift = (a, b) => (!a && !b) || (!!a && !!b && a.day === b.day && a.start === b.start && a.end === b.end);
const hmMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
// Horodatages + service NON travaillé d'un créneau programmé, un jour donné.
// Mêmes fenêtres que le planning : midi 9h–14h, soir 18h–21h. Un créneau qui
// couvre les deux services ne pose aucune demi.
function shiftTimes(day, sh) {
  const inTs = tsFromDateTime(day, sh.start);
  let outTs = tsFromDateTime(day, sh.end);
  if (outTs <= inTs) outTs += DAY_MS; // fin après minuit → lendemain
  const s = hmMin(sh.start);
  let e = hmMin(sh.end); if (e <= s) e += 24 * 60;
  const midi = s < 14 * 60 && e > 9 * 60;
  const soir = s < 21 * 60 && e > 18 * 60;
  let status = null;
  if (midi && !soir) status = 'demi_soir';
  else if (soir && !midi) status = 'demi_midi';
  else if (!midi && !soir) status = s < 17 * 60 ? 'demi_soir' : 'demi_midi';
  return { inTs, outTs, status };
}
// Créneau programmé d'un salarié pour ce jour (null si aucun, ou jour de repos).
function shiftOn(schedPeriods, restPeriods, day) {
  const p = scheduleOn(schedPeriods, day);
  if (!p) return null;
  const wd = new Date(`${day}T12:00:00`).getDay();
  const kind = (p.demi && p.demi.day === wd) ? 'demi' : ((p.cont && p.cont.day === wd) ? 'cont' : null);
  if (!kind) return null;
  if (restDaysOn(restPeriods, day).includes(wd)) return null;
  return { kind, start: p[kind].start, end: p[kind].end };
}
function dayList(from, to) {
  if (!ISO_RE.test(from || '') || !ISO_RE.test(to || '')) return [];
  const days = [];
  const cur = new Date(`${from}T12:00:00`); const end = new Date(`${to}T12:00:00`);
  while (cur <= end && days.length < 800) { days.push(localDay(cur.getTime())); cur.setDate(cur.getDate() + 1); }
  return days;
}
// Créneaux programmés À AFFICHER sur une plage : uniquement les jours où rien
// n'est saisi. Des horaires saisis ce jour-là, ou un statut (CP, repos, demi,
// échange, « journée complète »…), prennent toujours le dessus. Seule exception :
// un « extra » garde les horaires programmés (sans la croix de demi).
function virtualShifts(from, to, employeeId) {
  const days = dayList(from, to);
  if (!days.length) return [];
  let emps = db.prepare("SELECT id, name, active, end_date, rest_days, schedule FROM employees WHERE schedule != ''").all();
  if (employeeId) emps = emps.filter((e) => e.id === Number(employeeId));
  if (!emps.length) return [];
  const statuses = new Map();
  for (const r of db.prepare('SELECT employee_id, day, status FROM day_status WHERE day >= ? AND day <= ?').all(from, to)) {
    statuses.set(r.employee_id + '|' + r.day, r.status);
  }
  const filled = new Set();
  const fromTs = businessDayStart(from); const toTs = businessDayStart(to) + DAY_MS;
  for (const r of db.prepare('SELECT employee_id, clock_in FROM time_entries WHERE clock_in >= ? AND clock_in < ?').all(fromTs, toTs)) {
    filled.add(r.employee_id + '|' + businessDay(r.clock_in));
  }
  const out = [];
  for (const emp of emps) {
    const sched = parseSchedule(emp.schedule);
    if (!sched.length) continue;
    const rest = parseRestPeriods(emp.rest_days);
    for (const day of days) {
      if (!emp.active && !(emp.end_date && emp.end_date >= day)) continue;
      const sh = shiftOn(sched, rest, day);
      if (!sh) continue;
      const key = emp.id + '|' + day;
      if (filled.has(key)) continue;
      const st = statuses.get(key);
      if (st && !/^extra_/.test(st)) continue;
      const t = shiftTimes(day, sh);
      out.push({
        employeeId: emp.id, name: emp.name, day, kind: sh.kind, start: sh.start, end: sh.end,
        inTs: t.inTs, outTs: t.outTs, status: st ? null : t.status,
      });
    }
  }
  return out;
}
// Quand le rythme (ou les repos) d'un profil change, les jours DÉJÀ remplis à
// l'identique de l'ancien rythme (un seul horaire, mêmes heures, même demi) sont
// vidés à partir de la date d'effet : le nouveau rythme s'y applique alors.
// Un jour modifié à la main (autre horaire, autre statut) n'est jamais touché.
function cleanGeneratedDays(oldEmp, newEmp, from) {
  const oldS = parseSchedule(oldEmp.schedule);
  if (!oldS.length) return 0;
  const newS = parseSchedule(newEmp.schedule);
  const oldR = parseRestPeriods(oldEmp.rest_days); const newR = parseRestPeriods(newEmp.rest_days);
  const last = db.prepare('SELECT MAX(clock_in) AS m FROM time_entries WHERE employee_id = ?').get(oldEmp.id).m;
  if (!last) return 0;
  const entOf = db.prepare('SELECT id, clock_in, clock_out FROM time_entries WHERE employee_id = ? AND clock_in >= ? AND clock_in < ?');
  const stOf = db.prepare('SELECT status FROM day_status WHERE employee_id = ? AND day = ?');
  const delEnt = db.prepare('DELETE FROM time_entries WHERE id = ?');
  const delSt = db.prepare('DELETE FROM day_status WHERE employee_id = ? AND day = ?');
  let n = 0;
  for (const day of dayList(from, businessDay(last))) {
    const o = shiftOn(oldS, oldR, day);
    if (!o) continue;
    const nw = shiftOn(newS, newR, day);
    if (nw && nw.start === o.start && nw.end === o.end) continue; // rien ne change ce jour-là
    const f = businessDayStart(day);
    const ents = entOf.all(oldEmp.id, f, f + DAY_MS);
    if (ents.length !== 1) continue;
    const t = shiftTimes(day, o);
    if (ents[0].clock_in !== t.inTs || ents[0].clock_out !== t.outTs) continue;
    const st = stOf.get(oldEmp.id, day);
    if ((st ? st.status : null) !== t.status) continue;
    delEnt.run(ents[0].id);
    if (st) delSt.run(oldEmp.id, day);
    n++;
  }
  return n;
}

// Postes de cuisine. Préférences par salarié : 1 = poste principal,
// 2 = bon pour le poste, 3 = dépannage, 4/non renseigné = jamais
// (seuls 1 à 3 sont stockés ; « jamais » = clé absente).
const POSTE_KEYS = ['grillade', 'garnitures', 'volant', 'froid', 'plonge'];
// Valeurs acceptées pour une affectation manuelle (+ renfort « mise en place »).
const POSTE_ASSIGN_VALUES = [...POSTE_KEYS, 'mise_en_place'];
function parsePostes(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    const out = {};
    if (v && typeof v === 'object') {
      for (const k of POSTE_KEYS) {
        const n = Number(v[k]);
        if (Number.isInteger(n) && n >= 1 && n <= 3) out[k] = n;
      }
    }
    return out;
  } catch { return {}; }
}

// Liste publique des cuisiniers ACTIFS (noms seuls) — sert au sélecteur de
// clôture des check-lists cuisine. Pas de données sensibles.
app.get('/api/cooks', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM employees WHERE active = 1 ORDER BY name COLLATE NOCASE').all());
});

app.get('/api/admin/employees', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, category, rest_days, continuous_service, sort_order, active, end_date, created_at, postes, schedule FROM employees ORDER BY active DESC, sort_order ASC, name COLLATE NOCASE'
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
      schedulePeriods: parseSchedule(r.schedule), // demi + continue programmées (historisées)
      continuous: !!r.continuous_service,
      postes: parsePostes(r.postes), // préférences de poste (1..3 par poste)
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
  const { name, category } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Le nom est obligatoire' });
  }
  const cat = CATEGORIES.includes(category) ? category : DEFAULT_CATEGORY;
  // pin_hash conservé dans le schéma (hérité de l'appli pointage) : valeur neutre.
  const info = db.prepare(
    'INSERT INTO employees (name, pin_hash, category, active, created_at) VALUES (?, ?, ?, 1, ?)'
  ).run(String(name).trim(), hashSecret('0000'), cat, Date.now());
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/admin/employees/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!emp) return res.status(404).json({ error: 'Employé introuvable' });

  const { name, active, category } = req.body || {};
  // Date d'effet commune aux repos et au rythme (demi + continue) : par défaut
  // aujourd'hui ; une date future n'altère ni le passé ni le présent.
  const effFrom = ISO_RE.test((req.body && req.body.restDaysFrom) || '')
    ? req.body.restDaysFrom : localDay(Date.now());
  // Rythme hebdomadaire : validé AVANT toute écriture.
  let newSched = null;
  if (req.body && req.body.schedule !== undefined) {
    const sc = req.body.schedule || {};
    const asked = (x) => !!x && x.day !== '' && x.day !== null && x.day !== undefined;
    const demi = cleanShift(sc.demi); const cont = cleanShift(sc.cont);
    if (asked(sc.demi) && !demi) return res.status(400).json({ error: 'Demi-journée : le jour, le début et la fin sont obligatoires.' });
    if (asked(sc.cont) && !cont) return res.status(400).json({ error: 'Journée continue : le jour, le début et la fin sont obligatoires.' });
    if (demi && cont && demi.day === cont.day) {
      return res.status(400).json({ error: 'La demi-journée et la journée continue ne peuvent pas tomber le même jour.' });
    }
    newSched = { demi, cont };
  }
  if (name !== undefined && String(name).trim()) {
    db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(String(name).trim(), id);
  }
  if (category !== undefined && CATEGORIES.includes(category)) {
    db.prepare('UPDATE employees SET category = ? WHERE id = ?').run(category, id);
  }
  if (req.body && Array.isArray(req.body.restDays)) {
    const clean = [...new Set(req.body.restDays
      .map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
    const from = effFrom;
    const periods = parseRestPeriods(emp.rest_days).filter((p) => p.from !== from);
    periods.push({ from, days: clean });
    periods.sort((a, b) => a.from.localeCompare(b.from));
    db.prepare('UPDATE employees SET rest_days = ? WHERE id = ?')
      .run(JSON.stringify(periods.map((p) => ({ from: p.from, days: p.days }))), id);
  }
  let cleaned = 0;
  if (newSched) {
    const periods = parseSchedule(emp.schedule);
    const cur = scheduleOn(periods, effFrom);
    // Inchangé par rapport à ce qui est en vigueur à cette date → rien à écrire.
    if (!(sameShift(cur && cur.demi, newSched.demi) && sameShift(cur && cur.cont, newSched.cont))) {
      const next = periods.filter((p) => p.from !== effFrom);
      next.push({ from: effFrom, demi: newSched.demi, cont: newSched.cont });
      next.sort((a, b) => a.from.localeCompare(b.from));
      db.prepare('UPDATE employees SET schedule = ? WHERE id = ?').run(JSON.stringify(next), id);
    }
  }
  if (newSched || (req.body && Array.isArray(req.body.restDays))) {
    // Les jours déjà remplis à l'identique de l'ancien rythme suivent le nouveau.
    const after = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    db.transaction(() => { cleaned = cleanGeneratedDays(emp, after, effFrom); })();
  }
  if (req.body && req.body.continuous !== undefined) {
    db.prepare('UPDATE employees SET continuous_service = ? WHERE id = ?').run(req.body.continuous ? 1 : 0, id);
  }
  if (req.body && req.body.postes !== undefined) {
    const clean = {};
    if (req.body.postes && typeof req.body.postes === 'object') {
      for (const k of POSTE_KEYS) {
        const n = Number(req.body.postes[k]);
        if (Number.isInteger(n) && n >= 1 && n <= 3) clean[k] = n;
      }
    }
    db.prepare('UPDATE employees SET postes = ? WHERE id = ?').run(JSON.stringify(clean), id);
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
  res.json({ ok: true, cleaned });
});

app.delete('/api/admin/employees/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  // Désactivation (on conserve l'historique du planning).
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Saisie d'horaires (depuis le planning) -------------------------------

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

// Arrivée groupée : une même heure d'arrivée pour plusieurs salariés (arrivée
// seule, départ à compléter ensuite). Réservé à l'admin dans cette appli.
app.post('/api/entries/bulk', requireAdmin, (req, res) => {
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

// Suppression d'une période (depuis le planning).
app.delete('/api/admin/entries/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM time_entries WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true, deleted: info.changes });
});

// --- Statuts de journée (CP / AM / École / …) ------------------------------

// « normal » = journée complète : annule, pour ce jour seulement, la demi ou la
// continue programmée dans le profil.
const DAY_STATUSES = ['cp', 'am', 'ecole', 'absent', 'repos', 'demi_midi', 'demi_soir', 'echange_midi', 'echange_soir', 'echange_both', 'extra_midi', 'extra_soir', 'extra_both', 'normal'];

app.get('/api/admin/day-statuses', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Période manquante' });
  const rows = db.prepare(
    'SELECT employee_id AS employeeId, day, status FROM day_status WHERE day >= ? AND day <= ?'
  ).all(from, to);
  // + demi-journées du rythme programmé dans les profils (jours sans rien de saisi).
  for (const v of virtualShifts(from, to)) {
    if (v.status) rows.push({ employeeId: v.employeeId, day: v.day, status: v.status, virtual: true, kind: v.kind });
  }
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
  if (status === 'ecole' && (emp.category || DEFAULT_CATEGORY) !== 'apprenti') {
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

// --- Colonne « Infos » du planning (texte libre par salarié et par semaine) ---
// Clé "<employeeId>|<lundiSemaine>" → texte. Stocké comme l'Extra (settings JSON).
function readWeekInfo() {
  try {
    const v = JSON.parse(getSetting('week_info') || '{}');
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
app.get('/api/admin/week-info', requireAdmin, (req, res) => {
  res.json(readWeekInfo());
});
app.put('/api/admin/week-info', requireAdmin, (req, res) => {
  const { employeeId, week, text } = req.body || {};
  const id = Number(employeeId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Salarié invalide' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) return res.status(400).json({ error: 'Semaine invalide' });
  const map = readWeekInfo();
  const key = `${id}|${week}`;
  const t = String(text == null ? '' : text).trim().slice(0, 500);
  if (t) map[key] = t; else delete map[key];
  setSetting('week_info', JSON.stringify(map));
  res.json({ ok: true });
});

// --- Ligne « Notes » du planning (texte libre par semaine) -------------------
// Clé "<lundiSemaine>" → texte. Une seule note par semaine (toute la semaine).
function readWeekNotes() {
  try {
    const v = JSON.parse(getSetting('week_notes') || '{}');
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
app.get('/api/admin/week-note', requireAdmin, (req, res) => {
  res.json(readWeekNotes());
});
app.put('/api/admin/week-note', requireAdmin, (req, res) => {
  const { week, text } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) return res.status(400).json({ error: 'Semaine invalide' });
  const map = readWeekNotes();
  const t = String(text == null ? '' : text).trim().slice(0, 2000);
  if (t) map[week] = t; else delete map[week];
  setSetting('week_notes', JSON.stringify(map));
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
      if (status === 'ecole' && (emp.category || DEFAULT_CATEGORY) !== 'apprenti') { skippedEcole++; continue; }
      for (const d of days) { up.run(emp.id, d, status); count++; }
    }
  })();
  res.json({ ok: true, count, skippedEcole });
});

// --- Affectation manuelle des postes (par jour et par service) -------------

app.get('/api/admin/poste-assigns', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Période manquante' });
  res.json(db.prepare(
    'SELECT employee_id AS employeeId, day, service, poste, src FROM poste_assign WHERE day >= ? AND day <= ?'
  ).all(from, to));
});

// poste null/vide → on efface l'affectation manuelle (retour à l'automatique).
app.put('/api/admin/poste-assign', requireAdmin, (req, res) => {
  const { employeeId, date, service, poste } = req.body || {};
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(Number(employeeId));
  if (!emp) return res.status(404).json({ error: 'Employé introuvable' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Date invalide' });
  if (service !== 'midi' && service !== 'soir') return res.status(400).json({ error: 'Service invalide' });
  if (poste === null || poste === undefined || poste === '') {
    db.prepare('DELETE FROM poste_assign WHERE employee_id = ? AND day = ? AND service = ?').run(emp.id, date, service);
    return res.json({ ok: true, cleared: true });
  }
  if (!POSTE_ASSIGN_VALUES.includes(poste)) return res.status(400).json({ error: 'Poste invalide' });
  db.prepare(`
    INSERT INTO poste_assign (employee_id, day, service, poste, src) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(employee_id, day, service) DO UPDATE SET poste = excluded.poste, src = NULL
  `).run(emp.id, date, service, poste);
  res.json({ ok: true });
});

// Bouton ↻ d'une colonne : efface toutes les affectations manuelles du jour,
// le planning repasse en affectation automatique selon les préférences.
app.post('/api/admin/poste-assigns/reset', requireAdmin, (req, res) => {
  const { date } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Date invalide' });
  const info = db.prepare('DELETE FROM poste_assign WHERE day = ?').run(date);
  res.json({ ok: true, cleared: info.changes });
});

// --- Semaine type (répartition habituelle des POSTES, historisée) ----------
// Ne sert plus qu'aux postes : l'affectation automatique du planning la lit.
// Les horaires et demi-journées viennent désormais du profil (rythme ci-dessus).
// Setting `week_templates` : liste de périodes { from:'AAAA-MM-JJ', shifts:{
//   <employeeId>: { <jour 0=dim..6=sam>: { start:'HH:MM', end:'HH:MM', demi:'midi'|'soir'|null,
//                                           midi:<poste>, soir:<poste> } } } }.
// start/end facultatifs : un jour sans horaire fixe peut ne porter que les postes.
// La période applicable à une date = dernière dont from <= date (comme les repos).
// Les jours de repos complets ne sont PAS dans le modèle (gérés par les profils).
function readTemplates() {
  try {
    const v = JSON.parse(getSetting('week_templates') || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Reprise unique : le rythme (demi + continue) de chaque profil est initialisé
// à partir de la dernière semaine type, pour que rien ne change à l'écran.
// Date d'effet = celle de cette semaine type si elle est à venir, sinon le jour
// de la reprise (le passé n'est jamais modifié).
(function seedSchedulesFromTemplate() {
  if (getSetting('schedule_seeded')) return;
  try {
    const tpls = readTemplates()
      .filter((t) => t && ISO_RE.test(t.from || '') && t.shifts && typeof t.shifts === 'object')
      .sort((a, b) => a.from.localeCompare(b.from));
    const last = tpls[tpls.length - 1];
    if (last) {
      const today = localDay(Date.now());
      const from = last.from >= today ? last.from : today;
      const upd = db.prepare("UPDATE employees SET schedule = ? WHERE id = ? AND schedule = ''");
      db.transaction(() => {
        for (const [empId, byWd] of Object.entries(last.shifts)) {
          const list = [];
          for (const wd of Object.keys(byWd || {})) {
            const c = cleanShift({ day: Number(wd), start: (byWd[wd] || {}).start, end: (byWd[wd] || {}).end });
            if (!c) continue;
            let mins = hmMin(c.end) - hmMin(c.start); if (mins <= 0) mins += 24 * 60;
            list.push({ c, mins });
          }
          if (!list.length) continue;
          list.sort((a, b) => b.mins - a.mins); // le plus long = la continue
          let cont = null; let demi = null;
          if (list.length === 1) { if (list[0].mins > 7 * 60) cont = list[0].c; else demi = list[0].c; }
          else { cont = list[0].c; demi = list[list.length - 1].c; }
          upd.run(JSON.stringify([{ from, demi, cont }]), Number(empId));
        }
        // Semaines DÉJÀ préparées avec l'ancien bouton (elles ont des horaires
        // ou des demi-journées) : un jour de demi / continue laissé vide l'a été
        // volontairement (journée complète). On le fige en « journée complète »
        // pour que ces plannings restent exactement tels qu'ils ont été saisis.
        const lastSt = db.prepare('SELECT MAX(day) AS d FROM day_status').get().d || '';
        const lastEn = db.prepare('SELECT MAX(clock_in) AS m FROM time_entries').get().m;
        const lastDay = (lastEn && businessDay(lastEn) > lastSt) ? businessDay(lastEn) : lastSt;
        if (lastDay && lastDay >= from) {
          const hasDemi = db.prepare("SELECT 1 FROM day_status WHERE day >= ? AND day <= ? AND status IN ('demi_midi','demi_soir') LIMIT 1");
          const hasEnt = db.prepare('SELECT 1 FROM time_entries WHERE clock_in >= ? AND clock_in < ? LIMIT 1');
          const prepared = new Map(); // lundi → semaine déjà préparée ?
          const isPrepared = (day) => {
            const d = new Date(`${day}T12:00:00`);
            d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
            const mon = localDay(d.getTime());
            if (!prepared.has(mon)) {
              d.setDate(d.getDate() + 6);
              const sun = localDay(d.getTime());
              prepared.set(mon, !!(hasDemi.get(mon, sun) || hasEnt.get(businessDayStart(mon), businessDayStart(sun) + DAY_MS)));
            }
            return prepared.get(mon);
          };
          const keepFull = db.prepare("INSERT OR IGNORE INTO day_status (employee_id, day, status) VALUES (?, ?, 'normal')");
          for (const v of virtualShifts(from, lastDay)) {
            if (v.status && isPrepared(v.day)) keepFull.run(v.employeeId, v.day);
          }
        }
      })();
    }
    setSetting('schedule_seeded', '1');
  } catch (e) {
    console.warn('  Reprise du rythme des profils impossible :', e.message);
  }
})();

app.get('/api/admin/week-template', requireAdmin, (req, res) => {
  res.json(readTemplates());
});

app.put('/api/admin/week-template', requireAdmin, (req, res) => {
  const periods = req.body && req.body.periods;
  if (!Array.isArray(periods)) return res.status(400).json({ error: 'Format invalide' });
  for (const p of periods) {
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.from || '') || typeof p.shifts !== 'object') {
      return res.status(400).json({ error: 'Période invalide (from + shifts requis)' });
    }
  }
  setSetting('week_templates', JSON.stringify(periods));
  res.json({ ok: true, count: periods.length });
});

// --- Données du planning ---------------------------------------------------

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
  // Horaires programmés dans les profils (demi + continue) : ajoutés les jours
  // où rien n'est saisi. Ils comptent dans les totaux comme des horaires saisis.
  for (const v of virtualShifts(from, to, employeeId)) {
    rows.push({
      id: null, employee_id: v.employeeId, employee_name: v.name,
      clock_in: v.inTs, clock_out: v.outTs, ended_by: 'profil', virtual: true, kind: v.kind,
    });
  }
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
      virtual: !!r.virtual, // horaire issu du profil (non modifiable ligne à ligne)
      kind: r.kind || null, // 'demi' | 'cont'
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

// =========================================================================
//  Sauvegarde automatique
// =========================================================================

// Copie horodatée (date + heure) de la base dans ./backups, en conservant les
// BACKUP_KEEP dernières. Ne supprime jamais la base courante. Lancée à CHAQUE
// démarrage PUIS toutes les heures pendant que le serveur tourne : les saisies
// faites entre deux redémarrages ont ainsi toujours un point de restauration.
// Dossier de sauvegardes cuisine, SÉPARÉ de celui du pointage (sinon les deux
// applis élagueraient mutuellement leurs sauvegardes). En production : sous-
// dossier « cuisine » du disque persistant du pointage (dérivé de BACKUP_DIR).
const BACKUP_DIR = process.env.CUISINE_BACKUP_DIR
  || (process.env.BACKUP_DIR
    ? path.join(process.env.BACKUP_DIR, 'cuisine')
    : path.join(__dirname, 'backups'));
const BACKUP_KEEP = 60;
const BACKUP_EVERY_MS = 60 * 60 * 1000; // 1 h

function backupNow() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const dest = path.join(BACKUP_DIR, `data-${stamp}.db`);
    if (fs.existsSync(dest)) return;
    db.backup(dest)
      .then(() => {
        console.log(`  Sauvegarde cuisine créée : ${path.basename(BACKUP_DIR)}/data-${stamp}.db`);
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

// Sauvegardes : lancées au chargement du module (que l'appli tourne seule OU
// qu'elle soit montée dans le pointage) puis toutes les heures.
backupNow();
setInterval(backupNow, BACKUP_EVERY_MS);

// Cette appli est conçue pour être MONTÉE dans le serveur du pointage
// (app.use('/cuisine', require('./cuisine/server'))). On exporte donc l'app.
// Si elle est lancée seule (`node cuisine/server.js`), elle écoute sur son port.
module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Planning cuisine — serveur démarré`);
    console.log(`  Planning : http://localhost:${PORT}/ (sauvegarde auto toutes les heures)\n`);
  });
}

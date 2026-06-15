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

app.get('/api/admin/employees', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, category, rest_days, continuous_service, sort_order, active, end_date, created_at, postes FROM employees ORDER BY active DESC, sort_order ASC, name COLLATE NOCASE'
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
  res.json({ ok: true });
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

const DAY_STATUSES = ['cp', 'am', 'ecole', 'absent', 'repos', 'demi_midi', 'demi_soir', 'echange_midi', 'echange_soir', 'echange_both', 'extra_midi', 'extra_soir', 'extra_both'];

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
    'SELECT employee_id AS employeeId, day, service, poste FROM poste_assign WHERE day >= ? AND day <= ?'
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
    INSERT INTO poste_assign (employee_id, day, service, poste) VALUES (?, ?, ?, ?)
    ON CONFLICT(employee_id, day, service) DO UPDATE SET poste = excluded.poste
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

// --- Semaine type (modèle hebdomadaire récurrent, historisé) ---------------
// Setting `week_templates` : liste de périodes { from:'AAAA-MM-JJ', shifts:{
//   <employeeId>: { <jour 0=dim..6=sam>: { start:'HH:MM', end:'HH:MM', demi:'midi'|'soir'|null } } } }.
// La période applicable à une date = dernière dont from <= date (comme les repos).
// Les jours de repos complets ne sont PAS dans le modèle (gérés par les profils).
function readTemplates() {
  try {
    const v = JSON.parse(getSetting('week_templates') || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function templateOn(dateStr) {
  let best = null;
  for (const t of readTemplates()) {
    if (t && /^\d{4}-\d{2}-\d{2}$/.test(t.from || '') && t.from <= dateStr && (!best || t.from > best.from)) best = t;
  }
  return best;
}

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

// Remplit une plage de jours avec la semaine type : crée les horaires fixes et
// pose les statuts « demi ». Un jour déjà rempli (horaires OU statut) est laissé
// tel quel. Les jours de repos du profil sont ignorés (sécurité).
app.post('/api/admin/apply-template', requireAdmin, (req, res) => {
  const { from, to } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return res.status(400).json({ error: 'Période invalide' });
  }
  const days = [];
  const cur = new Date(`${from}T12:00:00`); const end = new Date(`${to}T12:00:00`);
  while (cur <= end) { days.push(localDay(cur.getTime())); cur.setDate(cur.getDate() + 1); }

  const employees = db.prepare('SELECT * FROM employees').all();
  const byId = new Map(employees.map((e) => [String(e.id), e]));
  const hasStatus = db.prepare('SELECT 1 FROM day_status WHERE employee_id = ? AND day = ?');
  const insEntry = db.prepare('INSERT INTO time_entries (employee_id, clock_in, clock_out, ended_by) VALUES (?, ?, ?, ?)');
  const upStatus = db.prepare(`
    INSERT INTO day_status (employee_id, day, status) VALUES (?, ?, ?)
    ON CONFLICT(employee_id, day) DO UPDATE SET status = excluded.status
  `);
  const hasEntries = db.prepare('SELECT 1 FROM time_entries WHERE employee_id = ? AND clock_in >= ? AND clock_in < ? LIMIT 1');

  let created = 0; let demis = 0; let skipped = 0;
  db.transaction(() => {
    for (const day of days) {
      const tpl = templateOn(day);
      if (!tpl || !tpl.shifts) continue;
      const wd = String(new Date(`${day}T12:00:00`).getDay());
      for (const [empId, byWd] of Object.entries(tpl.shifts)) {
        const sh = byWd && byWd[wd];
        if (!sh || !/^\d{2}:\d{2}$/.test(sh.start || '')) continue;
        const emp = byId.get(String(empId));
        if (!emp) continue;
        if (!emp.active && !(emp.end_date && emp.end_date >= day)) continue;
        // Repos au profil ce jour-là → on ne crée rien (cohérence).
        if (restDaysOn(parseRestPeriods(emp.rest_days), day).includes(Number(wd))) continue;
        // Jour déjà rempli (statut ou horaires) → conservé tel quel.
        if (hasStatus.get(emp.id, day)) { skipped++; continue; }
        const f = businessDayStart(day);
        if (hasEntries.get(emp.id, f, f + DAY_MS)) { skipped++; continue; }
        const inTs = tsFromDateTime(day, sh.start);
        let outTs = null;
        if (/^\d{2}:\d{2}$/.test(sh.end || '')) {
          outTs = tsFromDateTime(day, sh.end);
          if (outTs <= inTs) outTs += DAY_MS; // fin après minuit → lendemain
        }
        insEntry.run(emp.id, inTs, outTs, outTs != null ? 'manual' : null);
        created++;
        if (sh.demi === 'midi' || sh.demi === 'soir') {
          upStatus.run(emp.id, day, sh.demi === 'midi' ? 'demi_midi' : 'demi_soir');
          demis++;
        }
      }
    }
  })();
  res.json({ ok: true, created, demis, skipped });
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

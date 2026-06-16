'use strict';

const path = require('path');
const express = require('express');
const { db, uid, nowISO } = require('./db');

const app = express();
const PORT = process.env.CHECKLIST_PORT || 3400;
const ETABLISSEMENT = (process.env.ETABLISSEMENT || '').trim();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers dates --------------------------------------------------------
const DAY_NAMES = { 1: 'Lundi', 2: 'Mardi', 3: 'Mercredi', 4: 'Jeudi', 5: 'Vendredi', 6: 'Samedi', 7: 'Dimanche' };

// Date du jour au fuseau Europe/Paris (le serveur peut tourner en UTC).
function todayParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}
function getDayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=Dim..6=Sam
  return day === 0 ? 7 : day; // 1=Lun..7=Dim
}
function getPreviousDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return new Intl.DateTimeFormat('en-CA').format(d);
}
function localISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Ancre hebdomadaire (mode WEEKLY_MONDAY) : date du lundi de la « semaine de
// service », qui démarre le lundi à 8h (Europe/Paris). Avant lundi 8h, on est
// encore dans la semaine précédente. Toutes les coches d'une même semaine
// partagent cette session ; reset automatique au lundi 8h suivant.
function mondayAnchor() {
  const todayStr = todayParis();
  const hour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date()), 10);
  const dow = getDayOfWeek(todayStr); // 1=lundi..7=dimanche
  let daysBack = dow - 1;
  if (dow === 1 && hour < 8) daysBack = 7; // lundi avant 8h -> lundi précédent
  const d = new Date(todayStr + 'T12:00:00');
  d.setDate(d.getDate() - daysBack);
  return localISODate(d);
}

// --- Accès données --------------------------------------------------------
const qActiveTemplates = db.prepare('SELECT * FROM templates WHERE is_active = 1 ORDER BY ord ASC');
const qTemplateTasks = db.prepare('SELECT * FROM tasks WHERE template_id = ? AND is_active = 1 ORDER BY ord ASC');
const qSessionByTmplDate = db.prepare('SELECT * FROM sessions WHERE template_id = ? AND date = ?');
const qSessionById = db.prepare('SELECT * FROM sessions WHERE id = ?');
const qCompletions = db.prepare('SELECT * FROM completions WHERE session_id = ?');

function createSession(template, date, todayDow) {
  const tasks = qTemplateTasks.all(template.id);
  let taskData = [];

  if (template.reset_mode === 'WEEKLY_CARRY_OVER') {
    const todayTasks = tasks.filter((t) => t.day_of_week === todayDow);
    const included = new Set(todayTasks.map((t) => t.id));
    const carried = [];
    const prevDate = getPreviousDate(date);
    const prevSession = qSessionByTmplDate.get(template.id, prevDate);
    if (prevSession) {
      for (const tc of qCompletions.all(prevSession.id)) {
        if (!tc.is_done && !included.has(tc.task_id)) {
          carried.push({ taskId: tc.task_id, originalDate: tc.original_date || prevDate });
          included.add(tc.task_id);
        }
      }
    }
    taskData = [
      ...todayTasks.map((t) => ({ taskId: t.id, originalDate: null })),
      ...carried.map((c) => ({ taskId: c.taskId, originalDate: c.originalDate })),
    ];
  } else {
    // AUTO_DAILY, MANUAL, CARRY_OVER : toutes les tâches remises à zéro
    taskData = tasks.map((t) => ({ taskId: t.id, originalDate: null }));
  }

  const sessionId = uid();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO sessions(id,template_id,date,status,created_at) VALUES(?,?,?,?,?)')
      .run(sessionId, template.id, date, 'EN_COURS', nowISO());
    const ins = db.prepare('INSERT INTO completions(id,session_id,task_id,is_done,original_date) VALUES(?,?,?,0,?)');
    for (const td of taskData) ins.run(uid(), sessionId, td.taskId, td.originalDate);
  });
  tx();
  return qSessionById.get(sessionId);
}

// GET /api/sessions?date=YYYY-MM-DD — liste des check-lists du jour (création paresseuse)
app.get('/api/sessions', (req, res) => {
  const date = req.query.date || todayParis();
  const todayDow = getDayOfWeek(date);
  const templates = qActiveTemplates.all();

  const weekDate = mondayAnchor();
  const out = templates.map((template) => {
    // Les check-lists hebdo-lundi partagent une session par semaine (datée du
    // lundi) ; les autres ont une session par jour.
    const sessDate = template.reset_mode === 'WEEKLY_MONDAY' ? weekDate : date;
    let session = qSessionByTmplDate.get(template.id, sessDate);
    if (!session) session = createSession(template, sessDate, getDayOfWeek(sessDate));
    const comps = qCompletions.all(session.id);
    const totalTasks = comps.length;
    const doneTasks = comps.filter((c) => c.is_done).length;
    const carriedCount = comps.filter((c) => c.original_date !== null).length;
    return {
      id: session.id,
      templateId: template.id,
      templateName: template.name,
      templateType: template.type,
      templateColor: template.color,
      templateIcon: template.icon,
      resetMode: template.reset_mode,
      category: template.category || 'general',
      date: session.date,
      status: session.status,
      completedBy: session.completed_by,
      completedAt: session.completed_at,
      totalTasks,
      doneTasks,
      carriedCount,
      progress: totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0,
      todayLabel: template.reset_mode === 'WEEKLY_CARRY_OVER' ? DAY_NAMES[todayDow]
        : (template.reset_mode === 'WEEKLY_MONDAY' ? `Semaine du ${session.date.split('-').reverse().slice(0, 2).join('/')}` : null),
    };
  });

  res.json(out);
});

// GET /api/sessions/:id — détail d'une session
app.get('/api/sessions/:id', (req, res) => {
  const session = qSessionById.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session introuvable' });
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(session.template_id);
  const tmplTasks = qTemplateTasks.all(session.template_id);
  const byId = new Map(tmplTasks.map((t) => [t.id, t]));
  const comps = qCompletions.all(session.id);
  const isWeekly = template.reset_mode === 'WEEKLY_CARRY_OVER';

  let tasks;
  if (isWeekly) {
    tasks = comps.map((c) => {
      const task = byId.get(c.task_id);
      if (!task) return null;
      return {
        id: task.id, title: task.title, order: task.ord, dayOfWeek: task.day_of_week,
        dayLabel: task.day_of_week ? DAY_NAMES[task.day_of_week] : null,
        isDone: !!c.is_done, doneAt: c.done_at || null, completionId: c.id,
        originalDate: c.original_date || null, isCarriedOver: !!c.original_date,
      };
    }).filter(Boolean).sort((a, b) => {
      if (a.isCarriedOver !== b.isCarriedOver) return a.isCarriedOver ? 1 : -1;
      return a.order - b.order;
    });
  } else {
    tasks = tmplTasks.map((task) => {
      const c = comps.find((x) => x.task_id === task.id);
      return {
        id: task.id, title: task.title, order: task.ord, dayOfWeek: task.day_of_week ?? null, dayLabel: null,
        isDone: !!(c && c.is_done), doneAt: (c && c.done_at) || null, completionId: c ? c.id : null,
        originalDate: null, isCarriedOver: false,
      };
    });
  }

  res.json({
    id: session.id, templateId: session.template_id, templateName: template.name,
    templateType: template.type, templateColor: template.color, templateIcon: template.icon,
    resetMode: template.reset_mode, date: session.date, status: session.status,
    completedBy: session.completed_by, completedAt: session.completed_at, tasks,
  });
});

// PATCH /api/sessions/:id — cocher une tâche / finaliser / réouvrir
app.patch('/api/sessions/:id', (req, res) => {
  const sessionId = req.params.id;
  const body = req.body || {};
  const session = qSessionById.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session introuvable' });

  if (body.action === 'toggle_task') {
    const { taskId, isDone } = body;
    const c = db.prepare('SELECT * FROM completions WHERE session_id = ? AND task_id = ?').get(sessionId, taskId);
    if (!c) return res.status(404).json({ error: 'Tâche introuvable' });
    db.prepare('UPDATE completions SET is_done = ?, done_at = ? WHERE id = ?')
      .run(isDone ? 1 : 0, isDone ? nowISO() : null, c.id);
    return res.json({ ok: true });
  }
  if (body.action === 'complete') {
    db.prepare('UPDATE sessions SET status = ?, completed_by = ?, completed_at = ? WHERE id = ?')
      .run('TERMINE', body.completedBy || null, nowISO(), sessionId);
    return res.json({ ok: true });
  }
  if (body.action === 'reopen') {
    db.prepare('UPDATE sessions SET status = ?, completed_by = NULL, completed_at = NULL WHERE id = ?')
      .run('EN_COURS', sessionId);
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: 'Action inconnue' });
});

// GET /api/templates — templates actifs + tâches
app.get('/api/templates', (req, res) => {
  const templates = qActiveTemplates.all().map((t) => ({
    id: t.id, name: t.name, icon: t.icon, type: t.type, resetMode: t.reset_mode,
    category: t.category || 'general',
    tasks: qTemplateTasks.all(t.id).map((task) => ({ id: task.id, title: task.title, order: task.ord })),
  }));
  res.json(templates);
});

// POST /api/templates/:id/tasks — ajouter une tâche
app.post('/api/templates/:id/tasks', (req, res) => {
  const title = (req.body && req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  const last = db.prepare('SELECT MAX(ord) m FROM tasks WHERE template_id = ?').get(req.params.id);
  const id = uid();
  db.prepare('INSERT INTO tasks(id,template_id,title,ord,is_active,day_of_week,created_at) VALUES(?,?,?,?,1,NULL,?)')
    .run(id, req.params.id, title, (last.m || 0) + 1, nowISO());
  res.status(201).json({ id, title });
});

// PUT /api/templates/:id/tasks/order — réordonner les tâches (glisser-déposer)
app.put('/api/templates/:id/tasks/order', (req, res) => {
  const order = req.body && req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Format invalide' });
  const upd = db.prepare('UPDATE tasks SET ord = ? WHERE id = ? AND template_id = ?');
  db.transaction(() => { order.forEach((taskId, i) => upd.run(i + 1, String(taskId), req.params.id)); })();
  res.json({ ok: true });
});

// PATCH /api/tasks/:id — renommer
app.patch('/api/tasks/:id', (req, res) => {
  const title = (req.body && req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/tasks/:id — désactiver (soft delete)
app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('UPDATE tasks SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Employés -------------------------------------------------------------
app.get('/api/employees', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM employees WHERE is_active = 1 ORDER BY name ASC').all());
});
app.post('/api/employees', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = uid();
  db.prepare('INSERT INTO employees(id,name,is_active) VALUES(?,?,1)').run(id, name);
  res.status(201).json({ id, name });
});
app.delete('/api/employees/:id', (req, res) => {
  db.prepare('UPDATE employees SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/reports?from=&to=&type= — historique
app.get('/api/reports', (req, res) => {
  const { from, to, type } = req.query;
  const where = [];
  const args = [];
  if (from) { where.push('s.date >= ?'); args.push(from); }
  if (to) { where.push('s.date <= ?'); args.push(to); }
  if (type) { where.push('t.type = ?'); args.push(type); }
  const sql = `
    SELECT s.*, t.name tname, t.type ttype, t.color tcolor, t.icon ticon
    FROM sessions s JOIN templates t ON t.id = s.template_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.date DESC, s.created_at DESC`;
  const rows = db.prepare(sql).all(...args);
  const out = rows.map((s) => {
    const comps = qCompletions.all(s.id);
    const total = comps.length;
    const done = comps.filter((c) => c.is_done).length;
    return {
      id: s.id, date: s.date, templateName: s.tname, templateType: s.ttype,
      templateColor: s.tcolor, templateIcon: s.ticon, status: s.status,
      completedBy: s.completed_by || '-', completedAt: s.completed_at,
      totalTasks: total, doneTasks: done, progress: total > 0 ? Math.round((done / total) * 100) : 0,
    };
  });
  res.json(out);
});

app.get('/api/config', (req, res) => {
  res.json({ establishment: ETABLISSEMENT || '' });
});

// L'appli est montée sous /checklist dans le serveur du pointage. Lancée seule
// (`node checklist/server.js`), elle écoute sur son port.
module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Check-lists — serveur démarré sur http://localhost:${PORT}/\n`);
  });
}

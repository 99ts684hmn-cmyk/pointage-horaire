'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const MODE_LABEL = { AUTO_DAILY: 'Reset quotidien', CARRY_OVER: 'Report des non-faites', MANUAL: 'Manuel', WEEKLY_CARRY_OVER: 'Hebdomadaire', WEEKLY_MONDAY: 'Hebdo (lundi 8h)' };

const content = document.getElementById('content');
let templates = [];
let employees = [];
let tab = 'general'; // 'general' | 'manager' | 'bar' | 'employes'
let expanded = null;
let editingTask = null; // id de la tâche en cours de modification
const CAT_TABS = ['general', 'manager', 'bar'];
const CAT_EMPTY = { general: 'Aucune check-list ici.', manager: 'Aucune check-list manager.', bar: 'Aucune check-list bar.' };

async function fetchData() {
  const [t, e] = await Promise.all([
    fetch('api/templates').then((r) => r.json()),
    fetch('api/employees').then((r) => r.json()),
  ]);
  templates = Array.isArray(t) ? t : [];
  employees = Array.isArray(e) ? e : [];
  render();
}

async function addTask(templateId, input) {
  const title = input.value.trim();
  if (!title) return;
  await fetch(`api/templates/${encodeURIComponent(templateId)}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
  await fetchData();
}
async function saveOrder(templateId, order) {
  // Met à jour l'ordre local pour que les re-rendus respectent le nouvel ordre.
  const tm = templates.find((t) => t.id === templateId);
  if (tm) tm.tasks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  await fetch(`api/templates/${encodeURIComponent(templateId)}/tasks/order`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }),
  });
}
async function deleteTask(taskId) {
  if (!confirm('Supprimer cette tâche ?')) return;
  await fetch(`api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
  await fetchData();
}
async function saveTaskEdit(taskId, input) {
  const title = input.value.trim();
  if (!title) return;
  // Met à jour le titre localement aussi (pour un rendu immédiat cohérent).
  for (const tm of templates) { const t = tm.tasks.find((x) => x.id === taskId); if (t) t.title = title; }
  editingTask = null;
  await fetch(`api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
  render();
}
const RESET_OPTS = [
  ['AUTO_DAILY', 'Reset quotidien'],
  ['CARRY_OVER', 'Report des non-faites'],
  ['MANUAL', 'Manuel'],
  ['WEEKLY_MONDAY', 'Hebdo (lundi 8h)'],
];
async function createTemplate(category) {
  const name = document.getElementById('new-cl-name').value.trim();
  if (!name) return;
  const icon = document.getElementById('new-cl-icon').value.trim() || '📋';
  const resetMode = document.getElementById('new-cl-reset').value;
  const r = await fetch('api/templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon, resetMode, category }),
  });
  const created = await r.json();
  await fetchData();
  if (created && created.id) { expanded = created.id; render(); }
}
async function deleteTemplate(id, name) {
  if (!confirm(`Supprimer la check-list « ${name} » ?\nL'historique reste conservé, elle disparaît simplement de l'app.`)) return;
  await fetch(`api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (expanded === id) expanded = null;
  await fetchData();
}
function createFormHTML(category) {
  return `<div class="card" style="padding:16px">
    <div class="nm" style="margin-bottom:10px">➕ Nouvelle check-list</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input type="text" id="new-cl-icon" placeholder="📋" maxlength="2" style="width:56px;text-align:center;border:1.5px solid var(--border);border-radius:9px;padding:10px;font-size:1rem;font-family:inherit">
      <input type="text" id="new-cl-name" placeholder="Nom de la check-list…" style="flex:1;min-width:160px;border:1.5px solid var(--border);border-radius:9px;padding:10px 14px;font-size:.9rem;color:var(--dark);font-family:inherit">
      <select id="new-cl-reset" style="border:1.5px solid var(--border);border-radius:9px;padding:10px;font-size:.85rem;font-family:inherit;color:var(--dark)">
        ${RESET_OPTS.map((o) => `<option value="${o[0]}">${o[1]}</option>`).join('')}
      </select>
      <button class="btn btn-red" id="new-cl-create" data-cat="${esc(category)}">Créer</button>
    </div>
  </div>`;
}
async function addEmployee(input) {
  const name = input.value.trim();
  if (!name) return;
  await fetch('api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  await fetchData();
}
async function deleteEmployee(id) {
  if (!confirm('Supprimer cet employé ?')) return;
  await fetch(`api/employees/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await fetchData();
}

function render() {
  ['general', 'manager', 'employes'].forEach((t) => {
    const el = document.getElementById('tab-' + t);
    if (el) el.classList.toggle('active', tab === t);
  });

  if (tab !== 'employes') {
    const list = templates.filter((tm) => (tm.category || 'general') === tab);
    content.innerHTML = list.map((tm) => {
      const open = expanded === tm.id;
      const body = open ? `<div class="acc-body">
        <div class="tlist" data-tmpl="${esc(tm.id)}">
          ${tm.tasks.map((task) => (editingTask === task.id
    ? `<div class="trow editing" data-id="${esc(task.id)}"><input type="text" class="edit-input" data-edit-id="${esc(task.id)}" value="${esc(task.title)}"><button class="btn btn-red" data-save-task="${esc(task.id)}">OK</button><button class="del" data-cancel-edit="1">Annuler</button></div>`
    : `<div class="trow" data-id="${esc(task.id)}"><span class="drag" title="Glisser pour réordonner">⠿</span><span class="t" data-edit-task="${esc(task.id)}">${esc(task.title)}</span><button class="edit" data-edit-task="${esc(task.id)}">Modifier</button><button class="del" data-del-task="${esc(task.id)}">Supprimer</button></div>`)).join('')}
        </div>
        <div class="addrow"><input type="text" placeholder="Nouvelle tâche…" data-add-input="${esc(tm.id)}"><button class="btn btn-red" data-add-task="${esc(tm.id)}">+ Ajouter</button></div>
        <div style="margin-top:12px;text-align:right"><button class="del" data-del-tmpl="${esc(tm.id)}" data-del-name="${esc(tm.name)}">🗑 Supprimer cette check-list</button></div>
      </div>` : '';
      return `<div class="card acc">
        <button class="acc-head" data-toggle="${esc(tm.id)}">
          <div class="l"><span class="ic">${esc(tm.icon)}</span>
            <div><div class="nm">${esc(tm.name)}</div><div class="mode">${tm.tasks.length} tâches • ${MODE_LABEL[tm.resetMode] || ''}</div></div>
          </div>
          <span class="caret">${open ? '▲' : '▼'}</span>
        </button>${body}
      </div>`;
    }).join('') || `<div class="empty" style="margin-bottom:16px">${CAT_EMPTY[tab] || 'Aucune check-list.'}</div>`;

    content.innerHTML += createFormHTML(tab);
    const createBtn = document.getElementById('new-cl-create');
    if (createBtn) {
      createBtn.addEventListener('click', () => createTemplate(createBtn.dataset.cat));
      document.getElementById('new-cl-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createTemplate(createBtn.dataset.cat); });
    }
    content.querySelectorAll('[data-del-tmpl]').forEach((b) => b.addEventListener('click', () => deleteTemplate(b.dataset.delTmpl, b.dataset.delName)));

    content.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      expanded = expanded === b.dataset.toggle ? null : b.dataset.toggle; render();
    }));
    content.querySelectorAll('[data-del-task]').forEach((b) => b.addEventListener('click', () => deleteTask(b.dataset.delTask)));
    content.querySelectorAll('[data-edit-task]').forEach((b) => b.addEventListener('click', () => { editingTask = b.dataset.editTask; render(); }));
    content.querySelectorAll('[data-save-task]').forEach((b) => b.addEventListener('click', () => {
      const inp = content.querySelector(`[data-edit-id="${CSS.escape(b.dataset.saveTask)}"]`);
      saveTaskEdit(b.dataset.saveTask, inp);
    }));
    content.querySelectorAll('[data-cancel-edit]').forEach((b) => b.addEventListener('click', () => { editingTask = null; render(); }));
    content.querySelectorAll('.edit-input').forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveTaskEdit(inp.dataset.editId, inp);
        else if (e.key === 'Escape') { editingTask = null; render(); }
      });
      inp.focus(); inp.select();
    });
    content.querySelectorAll('[data-add-task]').forEach((b) => b.addEventListener('click', () => {
      const inp = content.querySelector(`[data-add-input="${CSS.escape(b.dataset.addTask)}"]`);
      addTask(b.dataset.addTask, inp);
    }));
    content.querySelectorAll('[data-add-input]').forEach((inp) => inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addTask(inp.dataset.addInput, inp);
    }));
    // Glisser-déposer pour réordonner les tâches (souris + tactile via SortableJS).
    content.querySelectorAll('.tlist').forEach((list) => {
      if (!window.Sortable) return;
      window.Sortable.create(list, {
        handle: '.drag', animation: 150,
        onEnd: () => saveOrder(list.dataset.tmpl, [...list.querySelectorAll('.trow')].map((r) => r.dataset.id)),
      });
    });
  } else {
    const list = employees.length
      ? employees.map((e) => `<div class="emp-line"><div class="l"><div class="av">${esc((e.name[0] || '?').toUpperCase())}</div><span class="nm">${esc(e.name)}</span></div><button class="del" data-del-emp="${esc(e.id)}">Supprimer</button></div>`).join('')
      : '<p class="empty" style="border:0;box-shadow:none">Aucun employé</p>';
    content.innerHTML = `<div class="card" style="overflow:hidden;margin-bottom:16px">${list}</div>
      <div class="card" style="padding:14px;display:flex;gap:8px">
        <input type="text" id="new-emp" placeholder="Nom de l'employé…" style="flex:1;border:1.5px solid var(--border);border-radius:9px;padding:10px 14px;font-size:.88rem;color:var(--dark);font-family:inherit">
        <button class="btn btn-red" id="add-emp">+ Ajouter</button>
      </div>`;
    content.querySelectorAll('[data-del-emp]').forEach((b) => b.addEventListener('click', () => deleteEmployee(b.dataset.delEmp)));
    const inp = document.getElementById('new-emp');
    document.getElementById('add-emp').addEventListener('click', () => addEmployee(inp));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') addEmployee(inp); });
  }
}

['general', 'manager', 'employes'].forEach((t) => {
  document.getElementById('tab-' + t).addEventListener('click', () => { tab = t; expanded = null; render(); });
});

fetchData();

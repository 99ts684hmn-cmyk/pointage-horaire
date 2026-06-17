'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const MODE_LABEL = { AUTO_DAILY: 'Reset quotidien', CARRY_OVER: 'Report des non-faites', MANUAL: 'Manuel', WEEKLY_CARRY_OVER: 'Hebdomadaire', WEEKLY_MONDAY: 'Hebdo (lundi 8h)' };

const content = document.getElementById('content');
let templates = [];
let expanded = null;
let editingTask = null;

async function fetchData() {
  const t = await fetch('api/templates').then((r) => r.json());
  templates = (Array.isArray(t) ? t : []).filter((tm) => (tm.category || 'general') === 'cuisine');
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
  for (const tm of templates) { const t = tm.tasks.find((x) => x.id === taskId); if (t) t.title = title; }
  editingTask = null;
  await fetch(`api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
  render();
}

function render() {
  if (!templates.length) {
    content.innerHTML = '<div class="empty">Aucune check-list cuisine.</div>';
    return;
  }
  content.innerHTML = templates.map((tm) => {
    const open = expanded === tm.id;
    const body = open ? `<div class="acc-body">
      <div class="tlist" data-tmpl="${esc(tm.id)}">
        ${tm.tasks.map((task) => (editingTask === task.id
    ? `<div class="trow editing" data-id="${esc(task.id)}"><input type="text" class="edit-input" data-edit-id="${esc(task.id)}" value="${esc(task.title)}"><button class="btn btn-red" data-save-task="${esc(task.id)}">OK</button><button class="del" data-cancel-edit="1">Annuler</button></div>`
    : `<div class="trow" data-id="${esc(task.id)}"><span class="drag" title="Glisser pour réordonner">⠿</span><span class="t" data-edit-task="${esc(task.id)}">${esc(task.title)}</span><button class="edit" data-edit-task="${esc(task.id)}">Modifier</button><button class="del" data-del-task="${esc(task.id)}">Supprimer</button></div>`)).join('')}
      </div>
      <div class="addrow"><input type="text" placeholder="Nouvelle tâche…" data-add-input="${esc(tm.id)}"><button class="btn btn-red" data-add-task="${esc(tm.id)}">+ Ajouter</button></div>
    </div>` : '';
    return `<div class="card acc">
      <button class="acc-head" data-toggle="${esc(tm.id)}">
        <div class="l"><span class="ic">${esc(tm.icon)}</span>
          <div><div class="nm">${esc(tm.name)}</div><div class="mode">${tm.tasks.length} tâches • ${MODE_LABEL[tm.resetMode] || ''}</div></div>
        </div>
        <span class="caret">${open ? '▲' : '▼'}</span>
      </button>${body}
    </div>`;
  }).join('');

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
  content.querySelectorAll('.tlist').forEach((list) => {
    if (!window.Sortable) return;
    window.Sortable.create(list, {
      handle: '.drag', animation: 150,
      onEnd: () => saveOrder(list.dataset.tmpl, [...list.querySelectorAll('.trow')].map((r) => r.dataset.id)),
    });
  });
}

fetchData();

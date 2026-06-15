'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const MODE_LABEL = { AUTO_DAILY: 'Reset quotidien', CARRY_OVER: 'Report des non-faites', MANUAL: 'Manuel', WEEKLY_CARRY_OVER: 'Hebdomadaire' };

const content = document.getElementById('content');
let templates = [];
let employees = [];
let tab = 'checklists';
let expanded = null;

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
  document.getElementById('tab-checklists').classList.toggle('active', tab === 'checklists');
  document.getElementById('tab-employes').classList.toggle('active', tab === 'employes');

  if (tab === 'checklists') {
    content.innerHTML = templates.map((tm) => {
      const open = expanded === tm.id;
      const body = open ? `<div class="acc-body">
        <div class="tlist" data-tmpl="${esc(tm.id)}">
          ${tm.tasks.map((task) => `<div class="trow" data-id="${esc(task.id)}"><span class="drag" title="Glisser pour réordonner">⠿</span><span class="t">${esc(task.title)}</span><button class="del" data-del-task="${esc(task.id)}">Supprimer</button></div>`).join('')}
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
    }).join('') || '<div class="empty">Aucune check-list.</div>';

    content.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      expanded = expanded === b.dataset.toggle ? null : b.dataset.toggle; render();
    }));
    content.querySelectorAll('[data-del-task]').forEach((b) => b.addEventListener('click', () => deleteTask(b.dataset.delTask)));
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

document.getElementById('tab-checklists').addEventListener('click', () => { tab = 'checklists'; render(); });
document.getElementById('tab-employes').addEventListener('click', () => { tab = 'employes'; render(); });

fetchData();

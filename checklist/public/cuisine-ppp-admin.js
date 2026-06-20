'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const content = document.getElementById('content');
let templates = [];

async function load() {
  try { templates = await fetch('api/ppp').then((r) => r.json()); }
  catch (e) { content.innerHTML = '<div class="empty">Impossible de charger les modèles.</div>'; return; }
  if (!Array.isArray(templates)) templates = [];
  render();
}

function render() {
  content.innerHTML = templates.map((t) => `
    <div class="card ppp-admin" style="padding:18px; margin-bottom:16px">
      <div class="nm" style="font-weight:800; color:var(--dark); margin-bottom:8px">${esc(t.icon || '')} ${esc(t.label)}</div>
      <textarea data-key="${esc(t.key)}">${esc(t.body)}</textarea>
      <div style="display:flex; align-items:center; gap:12px; margin-top:10px">
        <button class="btn btn-red" data-save="${esc(t.key)}">Enregistrer</button>
        <span class="ppp-ok" data-ok="${esc(t.key)}" hidden>✓ Enregistré</span>
      </div>
    </div>`).join('');
  content.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => save(b.dataset.save)));
}

async function save(key) {
  const ta = content.querySelector(`textarea[data-key="${CSS.escape(key)}"]`);
  const ok = content.querySelector(`[data-ok="${CSS.escape(key)}"]`);
  if (!ta) return;
  try {
    await fetch(`api/ppp/${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: ta.value }),
    });
    if (ok) { ok.hidden = false; setTimeout(() => { ok.hidden = true; }, 2000); }
  } catch (e) { /* on garde la saisie */ }
}

load();

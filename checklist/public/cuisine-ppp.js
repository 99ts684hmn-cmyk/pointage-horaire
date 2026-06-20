'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const content = document.getElementById('content');
const ov = document.getElementById('ov');
const modal = document.getElementById('modal');
let templates = [];

async function load() {
  try { templates = await fetch('api/ppp').then((r) => r.json()); }
  catch (e) { templates = []; }
  if (!Array.isArray(templates)) templates = [];
  render();
}

function render() {
  // 1re tuile : le tableau des commandes. Puis une tuile par modèle PPP.
  const tableau = `<a class="tile" href="cuisine-commandes.html">
      <span class="accent"></span>
      <span class="ic">📦</span>
      <span class="ttl">Tableau des commandes</span>
      <span class="sub">Grille fournisseurs × jours</span>
    </a>`;
  const ppp = templates.map((t) => `
    <button class="tile" data-key="${esc(t.key)}">
      <span class="accent"></span>
      <span class="ic">${esc(t.icon || '📋')}</span>
      <span class="ttl">${esc(t.label)}</span>
      <span class="sub">Générer le message de commande</span>
    </button>`).join('');
  content.innerHTML = `<div class="tiles">${tableau}${ppp}</div>`;
  content.querySelectorAll('.tile[data-key]').forEach((b) => b.addEventListener('click', () => openGen(b.dataset.key)));
}

// Découpe le modèle en segments de texte séparés par les « ... » (≥ 2 points ou …).
function splitTemplate(body) { return String(body || '').split(/\.{2,}|…/); }

function openGen(key) {
  const t = templates.find((x) => x.key === key);
  if (!t) return;
  const segs = splitTemplate(t.body);
  let fillHtml = '';
  segs.forEach((seg, i) => {
    fillHtml += esc(seg);
    if (i < segs.length - 1) {
      // Case large seulement après « Autre(s) » (texte libre) ; sinon petite (2-3 chiffres).
      const wide = /autres?\s*:?\s*$/i.test(seg);
      fillHtml += `<input type="text" data-i="${i}"${wide ? ' class="wide"' : ' inputmode="numeric"'} aria-label="à remplir">`;
    }
  });
  modal.innerHTML = `
    <h2>${esc(t.icon || '')} ${esc(t.label)}</h2>
    <div class="ppp-fill">${fillHtml || '<em>(modèle vide)</em>'}</div>
    <div class="actions" style="margin-top:16px">
      <button class="btn btn-grey" id="ppp-cancel">Fermer</button>
      <button class="btn btn-red" id="ppp-gen">Générer &amp; copier</button>
    </div>
    <div class="ppp-result" id="ppp-result" hidden>
      <textarea id="ppp-out" readonly></textarea>
      <div class="ppp-ok" id="ppp-ok" hidden>✓ Copié — il ne reste qu'à coller et envoyer.</div>
    </div>`;
  modal.dataset.segs = JSON.stringify(segs);
  modal.querySelector('#ppp-cancel').addEventListener('click', () => ov.classList.remove('show'));
  modal.querySelector('#ppp-gen').addEventListener('click', generate);
  ov.classList.add('show');
  const first = modal.querySelector('.ppp-fill input'); if (first) first.focus();
}

function generate() {
  const segs = JSON.parse(modal.dataset.segs || '[]');
  const inputs = [...modal.querySelectorAll('.ppp-fill input')];
  let out = '';
  segs.forEach((seg, i) => {
    out += seg;
    if (i < segs.length - 1) out += (inputs[i] ? inputs[i].value.trim() : '');
  });
  out = out.trim();
  const ta = modal.querySelector('#ppp-out');
  const res = modal.querySelector('#ppp-result');
  const ok = modal.querySelector('#ppp-ok');
  ta.value = out;
  res.hidden = false;
  copyText(out).then((done) => { ok.hidden = !done; if (!done) { ta.focus(); ta.select(); } });
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* fallback ci-dessous */ }
  try {
    const ta = modal.querySelector('#ppp-out');
    ta.focus(); ta.select();
    return document.execCommand('copy');
  } catch (e) { return false; }
}

ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('show'); });

load();

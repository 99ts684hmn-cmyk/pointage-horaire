'use strict';

// Cartouches « à faire » (partagés : page des check-lists cuisine et accueil
// cuisine) : les premières tâches restantes d'une check-list, cochables
// directement ; mise à jour toutes les 15 s et au retour sur la page.
//   #menage-box → « Ménage du jour » (type CUISINE_MENAGE_HEBDO), 3 lignes
//   #matin-box  → check-list du bloc « Ouverture » (ex. Check liste du matin), 3 lignes
(function () {
  const BOXES = [
    { id: 'menage-box', icon: '🧽', lines: 3, pick: (all) => all.find((x) => x.templateType === 'CUISINE_MENAGE_HEBDO') },
    { id: 'matin-box', icon: '☕', lines: 3, pick: (all) => all.find((x) => x.templateGroup === 'Ouverture') || all.find((x) => /matin|ouverture/i.test(x.templateName || '')) },
  ].map((b) => ({ ...b, el: document.getElementById(b.id) })).filter((b) => b.el);
  if (!BOXES.length) return;

  const FROM = window.CL_FROM || 'cuisine';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // « Jour de service » : bascule à 2h du matin (même règle que les check-lists).
  function serviceDay() {
    const d = new Date();
    if (d.getHours() < 2) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function renderBox(box, s) {
    const el = box.el;
    if (!s) { el.hidden = true; return; }
    let tasks = [];
    try {
      const d = await fetch(`api/sessions/${encodeURIComponent(s.id)}`).then((r) => r.json());
      tasks = Array.isArray(d.tasks) ? d.tasks : [];
    } catch (e) { el.hidden = true; return; }
    const todo = tasks.filter((t) => !t.isDone);
    const link = `session.html?id=${encodeURIComponent(s.id)}&from=${FROM}`;
    if (!tasks.length) { el.hidden = true; return; } // liste vide ≠ terminée
    if (!todo.length) {
      el.className = 'menage-box done';
      // Tout est coché : la finalisation (nom + animation) se fait sur la liste.
      el.innerHTML = `<div class="mh"><span>${box.icon} ${esc(s.templateName)}</span><span class="mc">✅ tout est fait</span></div>
        ${s.status === 'TERMINE' ? '' : `<a class="more" href="${link}">Finaliser la liste →</a>`}`;
    } else {
      const first = todo.slice(0, box.lines);
      const rest = todo.length - first.length;
      el.className = 'menage-box';
      // En-tête compact : titre + compteur à gauche, lien « + N autres → » à droite.
      el.innerHTML = `<div class="mh"><span>${box.icon} ${esc(s.templateName)} <span class="mc">${tasks.length - todo.length}/${tasks.length}</span></span><a class="more" href="${link}" title="Ouvrir la liste complète">${rest > 0 ? `+ ${rest} autre${rest > 1 ? 's' : ''} →` : 'Ouvrir →'}</a></div>
        ${first.map((t) => `<button type="button" class="mt${t.isCarriedOver ? ' carried' : ''}" data-task="${esc(t.id)}" title="Marquer comme faite"><span class="cb"></span><span>${esc(t.title)}${t.isCarriedOver ? ' <small>↩ reporté</small>' : ''}</span></button>`).join('')}`;
      // Un appui coche la tâche (même action que sur la page de la liste), puis
      // le cartouche se recharge : la tâche suivante prend la place.
      el.querySelectorAll('.mt').forEach((b) => b.addEventListener('click', async () => {
        b.classList.add('busy');
        const cb = b.querySelector('.cb');
        cb.textContent = '✓'; cb.style.background = 'var(--green)'; cb.style.borderColor = 'var(--green)';
        try {
          await fetch(`api/sessions/${encodeURIComponent(s.id)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'toggle_task', taskId: b.dataset.task, isDone: true }),
          });
        } catch (e) { /* le rechargement ci-dessous remettra l'état réel */ }
        await refresh();
        // Prévient la page (ex. cartes des check-lists) qu'une coche a changé.
        document.dispatchEvent(new CustomEvent('menage-updated'));
      }));
    }
    el.hidden = false;
  }

  async function refresh() {
    let all = [];
    try {
      const r = await fetch(`api/sessions?date=${serviceDay()}`).then((x) => x.json());
      all = (Array.isArray(r) ? r : []).filter((x) => (x.category || 'general') === 'cuisine');
    } catch (e) { BOXES.forEach((b) => { b.el.hidden = true; }); return; }
    await Promise.all(BOXES.map((b) => renderBox(b, b.pick(all) || null)));
  }

  window.refreshMenageBox = refresh;
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) refresh(); });
  refresh();
})();

'use strict';

// Cartouche « Ménage du jour » (partagé : page des check-lists cuisine et accueil
// cuisine). Affiche les 5 premières tâches de ménage restantes, cochables
// directement ; se met à jour toutes les 15 s et au retour sur la page.
// Conteneur attendu : <div class="menage-box" id="menage-box" hidden></div>.
(function () {
  const box = document.getElementById('menage-box');
  if (!box) return;
  const FROM = window.CL_FROM || 'cuisine';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // « Jour de service » : bascule à 2h du matin (même règle que les check-lists).
  function serviceDay() {
    const d = new Date();
    if (d.getHours() < 2) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function refresh() {
    let s = null; let tasks = [];
    try {
      const all = await fetch(`api/sessions?date=${serviceDay()}`).then((r) => r.json());
      s = (Array.isArray(all) ? all : []).find((x) => x.templateType === 'CUISINE_MENAGE_HEBDO') || null;
      if (!s) { box.hidden = true; return; }
      const d = await fetch(`api/sessions/${encodeURIComponent(s.id)}`).then((r) => r.json());
      tasks = Array.isArray(d.tasks) ? d.tasks : [];
    } catch (e) { box.hidden = true; return; }
    const todo = tasks.filter((t) => !t.isDone);
    const link = `session.html?id=${encodeURIComponent(s.id)}&from=${FROM}`;
    if (!tasks.length) { box.hidden = true; return; } // liste vide ≠ terminée
    if (!todo.length) {
      box.className = 'menage-box done';
      // Tout est coché : la finalisation (nom + animation) se fait sur la liste.
      box.innerHTML = `<div class="mh"><span>🧽 ${esc(s.templateName)}</span><span class="mc">✅ tout est fait</span></div>
        ${s.status === 'TERMINE' ? '' : `<a class="more" href="${link}">Finaliser la liste →</a>`}`;
    } else {
      const first = todo.slice(0, 5);
      const rest = todo.length - first.length;
      box.className = 'menage-box';
      box.innerHTML = `<div class="mh"><span>🧽 ${esc(s.templateName)} — à faire</span><span class="mc">${tasks.length - todo.length}/${tasks.length} faites</span></div>
        ${first.map((t) => `<button type="button" class="mt${t.isCarriedOver ? ' carried' : ''}" data-task="${esc(t.id)}" title="Marquer comme faite"><span class="cb"></span><span>${esc(t.title)}${t.isCarriedOver ? ' <small>↩ reporté</small>' : ''}</span></button>`).join('')}
        <a class="more" href="${link}">${rest > 0 ? `+ ${rest} autre${rest > 1 ? 's' : ''} tâche${rest > 1 ? 's' : ''} → ouvrir la liste` : 'Ouvrir la liste →'}</a>`;
      // Un appui coche la tâche (même action que sur la page de la liste), puis
      // le cartouche se recharge : la tâche suivante prend la place.
      box.querySelectorAll('.mt').forEach((b) => b.addEventListener('click', async () => {
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
    box.hidden = false;
  }

  window.refreshMenageBox = refresh;
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) refresh(); });
  refresh();
})();

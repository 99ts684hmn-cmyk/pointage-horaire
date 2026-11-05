'use strict';

// Cartouches « à faire » : les premières tâches restantes d'une check-list,
// cochables directement ; mise à jour toutes les 15 s et au retour sur la page.
//
// Par défaut (pages cuisine) :
//   #menage-box → « Ménage du jour » (type CUISINE_MENAGE_HEBDO), 3 lignes
//   #matin-box  → check-list du bloc « Ouverture » (ex. Check liste du matin), 3 lignes
//
// Configurable par la page hôte (ex. /salle.html) via :
//   window.CL_BOXES     : tableau [{ id, icon, lines, pick(sessions) }] ou FONCTION
//                         qui le renvoie (ré-évaluée à chaque rafraîchissement →
//                         cartouches selon l'heure). Les conteneurs manquants sont
//                         créés dans #boxes-host.
//   window.CL_CATEGORY  : catégorie des check-lists ('cuisine' par défaut, 'general' = salle)
//   window.CL_API_BASE  : préfixe des appels API ('' par défaut, '/checklist/' hors de l'app)
//   window.CL_FROM      : valeur « from » du lien vers la liste ('cuisine' par défaut)
//   window.CL_BOX_CSS   : true → injecte le style des cartouches (page sans styles.css)
(function () {
  const API = window.CL_API_BASE || '';
  const FROM = window.CL_FROM || 'cuisine';
  const CATEGORY = window.CL_CATEGORY || 'cuisine';
  const DEFAULT_BOXES = [
    { id: 'menage-box', icon: '🧽', lines: 3, pick: (all) => all.find((x) => x.templateType === 'CUISINE_MENAGE_HEBDO') },
    { id: 'matin-box', icon: '☕', lines: 3, pick: (all) => all.find((x) => x.templateGroup === 'Ouverture') || all.find((x) => /matin|ouverture/i.test(x.templateName || '')) },
  ];
  const boxesConfig = () => {
    const c = window.CL_BOXES;
    const list = typeof c === 'function' ? c() : (Array.isArray(c) ? c : DEFAULT_BOXES);
    return list.filter((b) => b && b.id && typeof b.pick === 'function');
  };

  if (window.CL_BOX_CSS) {
    const st = document.createElement('style');
    st.textContent = `
      .menage-box { display: block; background: #fff; border: 2px solid #c59d5f; border-radius: 12px; padding: 12px 16px; margin: 0 0 12px; color: #1f2120; text-decoration: none; }
      .menage-box .mh { display: flex; justify-content: space-between; align-items: center; font-size: .82rem; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; color: #8a6b32; margin-bottom: 8px; }
      .menage-box .mh .mc { font-weight: 700; letter-spacing: 0; text-transform: none; color: #5a5550; font-size: .78rem; margin-left: 6px; }
      .menage-box .mh .more { margin-top: 0; white-space: nowrap; letter-spacing: 0; text-transform: none; }
      .menage-box .mt { display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 0; border: 0; background: none; text-align: left; font: inherit; font-size: .95rem; font-weight: 600; color: #1f2120; cursor: pointer; border-top: 1px solid #f1ece4; }
      .menage-box .mt:first-of-type { border-top: 0; }
      .menage-box .mt .cb { flex: 0 0 26px; width: 26px; height: 26px; border-radius: 50%; border: 2px solid #e3ddd2; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: .9rem; }
      .menage-box .mt.busy { opacity: .5; pointer-events: none; }
      .menage-box .mt.carried { color: #9e1f24; }
      .menage-box .mt small { color: #5a5550; font-weight: 500; }
      .menage-box .more { font-size: .82rem; color: #8a6b32; font-weight: 700; text-decoration: none; display: inline-block; }
      .menage-box.done { border-color: #2e8b57; }
      .menage-box.done .mh { color: #2e8b57; }`;
    document.head.appendChild(st);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // « Jour de service » : bascule à 2h du matin (même règle que les check-lists).
  function serviceDay() {
    const d = new Date();
    if (d.getHours() < 2) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Conteneurs : existants dans la page, sinon créés dans #boxes-host.
  let currentIds = '';
  function ensureElements(cfg) {
    const ids = cfg.map((b) => b.id).join('|');
    const host = document.getElementById('boxes-host');
    if (host && ids !== currentIds) {
      host.innerHTML = '';
      cfg.forEach((b) => { if (!document.getElementById(b.id)) { const d = document.createElement('div'); d.className = 'menage-box'; d.id = b.id; d.hidden = true; host.appendChild(d); } });
      currentIds = ids;
    }
    return cfg.map((b) => ({ ...b, el: document.getElementById(b.id) })).filter((b) => b.el);
  }

  async function renderBox(box, s) {
    const el = box.el;
    if (!s) { el.hidden = true; return; }
    let tasks = [];
    try {
      const d = await fetch(`${API}api/sessions/${encodeURIComponent(s.id)}`).then((r) => r.json());
      tasks = Array.isArray(d.tasks) ? d.tasks : [];
    } catch (e) { el.hidden = true; return; }
    const todo = tasks.filter((t) => !t.isDone);
    const link = `${API}session.html?id=${encodeURIComponent(s.id)}&from=${FROM}`;
    if (!tasks.length) { el.hidden = true; return; } // liste vide ≠ terminée
    if (!todo.length) {
      el.className = 'menage-box done';
      // Tout est coché : la finalisation (nom + animation) se fait sur la liste.
      el.innerHTML = `<div class="mh"><span>${box.icon} ${esc(s.templateName)}</span><span class="mc">✅ tout est fait</span></div>
        ${s.status === 'TERMINE' ? '' : `<a class="more" href="${link}">Finaliser la liste →</a>`}`;
    } else {
      const first = todo.slice(0, box.lines || 3);
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
        cb.textContent = '✓'; cb.style.background = 'var(--green, #2e8b57)'; cb.style.borderColor = 'var(--green, #2e8b57)';
        try {
          await fetch(`${API}api/sessions/${encodeURIComponent(s.id)}`, {
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
    const boxes = ensureElements(boxesConfig());
    if (!boxes.length) return;
    let all = [];
    try {
      const r = await fetch(`${API}api/sessions?date=${serviceDay()}`).then((x) => x.json());
      all = (Array.isArray(r) ? r : []).filter((x) => (x.category || 'general') === CATEGORY);
    } catch (e) { boxes.forEach((b) => { b.el.hidden = true; }); return; }
    await Promise.all(boxes.map((b) => renderBox(b, b.pick(all) || null)));
    document.dispatchEvent(new CustomEvent('boxes-rendered'));
  }

  window.refreshMenageBox = refresh;
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) refresh(); });
  refresh();
})();

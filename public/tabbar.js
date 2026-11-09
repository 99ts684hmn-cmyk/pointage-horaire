'use strict';

// Barre d'onglets fixe en bas d'écran, sur TÉLÉPHONE uniquement (≤ 680 px),
// présente sur toutes les pages du site. Son contenu dépend de la SECTION :
//   accueil  → Accueil · Planning · Salle · Cuisine · Charlène
//   salle    → Accueil · Salle · Planning · Check-lists · Managers · Admin
//   cuisine  → Accueil · Cuisine · Check-lists · Coûts · Groupes · Menu
// L'onglet actif est déduit de l'adresse de la page.
(function () {
  const path = location.pathname;
  const q = location.search;
  const is = (...pages) => pages.includes(path);
  const cuisineCtx = /\/cuisine\/|\/checklist\/(cuisine|resp)/.test(path)
    || (path === '/checklist/session.html' && /from=(cuisine|resp)/.test(q))
    || (path === '/checklist/rapports.html' && /scope=cuisine/.test(q))
    || path === '/responsable-cuisine.html';
  const salleCtx = !cuisineCtx && (is('/salle.html', '/pointage.html', '/admin.html', '/manager-salle.html')
    || path.startsWith('/checklist/'));
  const section = cuisineCtx ? 'cuisine' : salleCtx ? 'salle' : 'accueil';

  const HOME = { icon: '🏠', label: 'Accueil', href: '/', active: (p) => p === '/' || p === '/index.html' };
  const SETS = {
    accueil: [
      HOME,
      { icon: '🕒', label: 'Planning', href: '/pointage.html', active: () => false },
      { icon: '🛎️', label: 'Salle', href: '/salle.html', active: () => false },
      { icon: '🧑‍🍳', label: 'Cuisine', href: '/checklist/cuisine-accueil.html', active: () => false },
      { icon: '👸', label: 'Charlène', href: '/charlene.html', active: (p) => p === '/charlene.html' },
    ],
    salle: [
      HOME,
      { icon: '🛎️', label: 'Salle', href: '/salle.html', active: (p) => p === '/salle.html' },
      { icon: '🕒', label: 'Planning', href: '/pointage.html', active: (p) => p === '/pointage.html' },
      { icon: '✅', label: 'Check-lists', href: '/checklist/', active: (p) => is('/checklist/', '/checklist/index.html', '/checklist/session.html') && !/tab=manager/.test(q) },
      { icon: '👔', label: 'Managers', href: '/checklist/index.html?tab=manager', active: (p) => (p === '/checklist/index.html' && /tab=manager/.test(q)) || p === '/manager-salle.html' || p === '/checklist/rapports.html' },
      { icon: '⚙️', label: 'Admin', href: '/admin.html', active: (p) => p === '/admin.html' || p === '/checklist/admin.html' },
    ],
    cuisine: [
      HOME,
      { icon: '🧑‍🍳', label: 'Cuisine', href: '/checklist/cuisine-accueil.html', active: (p) => p === '/checklist/cuisine-accueil.html' || p === '/responsable-cuisine.html' },
      { icon: '✅', label: 'Check-lists', href: '/checklist/cuisine.html', active: (p) => is('/checklist/cuisine.html', '/checklist/resp-cuisine.html', '/checklist/session.html') },
      { icon: '⚖️', label: 'Coûts', href: '/checklist/cuisine-couts.html', active: (p) => p === '/checklist/cuisine-couts.html' },
      { icon: '👥', label: 'Groupes', href: '/checklist/cuisine-groupes.html', active: (p) => p === '/checklist/cuisine-groupes.html' },
      { icon: '📋', label: 'Menu', href: '/checklist/cuisine-menudujour.html', active: (p) => p === '/checklist/cuisine-menudujour.html' },
    ],
  };
  const TABS = SETS[section];

  const css = `
    .tabbar { display: none; }
    @media (max-width: 680px) {
      body { padding-bottom: calc(64px + env(safe-area-inset-bottom)) !important; }
      .tabbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; display: flex;
        background: rgba(255,255,255,.96); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
        border-top: 1px solid #e3ddd2; box-shadow: 0 -4px 16px rgba(31,33,32,.08);
        padding: 6px 4px calc(6px + env(safe-area-inset-bottom)); }
      .tabbar a { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 2px; text-decoration: none;
        color: #6f6961; font-family: inherit; font-size: .62rem; font-weight: 700; padding: 4px 1px; border-radius: 10px; white-space: nowrap; }
      .tabbar a .ti { font-size: 1.3rem; line-height: 1; }
      .tabbar a.on { color: #8a6b32; background: #f6efe2; }
      /* Les toasts remontent au-dessus de la barre. */
      .toast { bottom: calc(80px + env(safe-area-inset-bottom)) !important; }
    }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const bar = document.createElement('nav');
  bar.className = 'tabbar';
  bar.setAttribute('aria-label', 'Navigation');
  bar.innerHTML = TABS.map((t) => `<a href="${t.href}" class="${t.active(path) ? 'on' : ''}"><span class="ti">${t.icon}</span><span>${t.label}</span></a>`).join('');
  document.body.appendChild(bar);
})();

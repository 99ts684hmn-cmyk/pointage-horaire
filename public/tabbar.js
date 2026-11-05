'use strict';

// Barre d'onglets fixe en bas d'écran, sur TÉLÉPHONE uniquement (≤ 680 px),
// présente sur toutes les pages du site. Cinq entrées : Accueil, Pointage,
// Check-lists (salle ou cuisine selon la page d'où l'on vient), Cuisine, Groupes.
// L'onglet actif est déduit de l'adresse de la page.
(function () {
  const path = location.pathname;
  // Contexte cuisine : pages /checklist/cuisine-*, /checklist/resp-*, /cuisine/…
  const cuisineCtx = /\/cuisine\/|\/checklist\/(cuisine|resp)/.test(path)
    || (path === '/checklist/session.html' && /from=(cuisine|resp)/.test(location.search))
    || path === '/responsable-cuisine.html';
  const TABS = [
    { key: 'home', icon: '🏠', label: 'Accueil', href: '/', active: (p) => p === '/' || p === '/index.html' || p === '/charlene.html' },
    { key: 'pointage', icon: '🕒', label: 'Pointage', href: '/pointage.html', active: (p) => p === '/pointage.html' || p === '/salle.html' || p === '/admin.html' || p === '/manager-salle.html' },
    { key: 'check', icon: '✅', label: 'Check-lists', href: cuisineCtx ? '/checklist/cuisine.html' : '/checklist/',
      active: (p) => p === '/checklist/' || p === '/checklist/index.html' || p === '/checklist/cuisine.html' || p === '/checklist/resp-cuisine.html' || p === '/checklist/session.html' || /\/checklist\/(admin|rapports|cuisine-admin|resp-cuisine-admin)\.html/.test(p) },
    { key: 'cuisine', icon: '🍳', label: 'Cuisine', href: '/checklist/cuisine-accueil.html', active: (p) => p === '/checklist/cuisine-accueil.html' || p === '/responsable-cuisine.html' || p.startsWith('/cuisine/') || /\/checklist\/cuisine-(commandes|ppp|menudujour|admin-accueil)/.test(p) },
    { key: 'groupes', icon: '👥', label: 'Groupes', href: '/checklist/cuisine-groupes.html', active: (p) => p === '/checklist/cuisine-groupes.html' },
  ];

  const css = `
    .tabbar { display: none; }
    @media (max-width: 680px) {
      body { padding-bottom: calc(64px + env(safe-area-inset-bottom)) !important; }
      .tabbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; display: flex;
        background: rgba(255,255,255,.96); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
        border-top: 1px solid #e3ddd2; box-shadow: 0 -4px 16px rgba(31,33,32,.08);
        padding: 6px 4px calc(6px + env(safe-area-inset-bottom)); }
      .tabbar a { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; text-decoration: none;
        color: #6f6961; font-family: inherit; font-size: .68rem; font-weight: 700; padding: 4px 2px; border-radius: 10px; }
      .tabbar a .ti { font-size: 1.35rem; line-height: 1; }
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

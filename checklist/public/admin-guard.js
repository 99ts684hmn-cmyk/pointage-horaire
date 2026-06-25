'use strict';
/*
 * Protège les pages d'administration des check-lists. Les actions structurelles
 * (créer/supprimer check-lists, tâches, employés) exigent côté serveur le mot de
 * passe admin du POINTAGE (cookie ph_session, valable sur tout le site). Ici, si
 * l'utilisateur n'a pas de session admin, on affiche un voile de connexion qui
 * pose ce cookie — puis la page redevient pleinement utilisable.
 */
(function () {
  function showLogin() {
    var o = document.createElement('div');
    o.setAttribute('role', 'dialog');
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#1f2120;color:#fff8f0;display:flex;'
      + 'align-items:center;justify-content:center;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
    o.innerHTML = '<div style="width:100%;max-width:340px;text-align:center">'
      + '<div style="font-weight:800;font-size:1.2rem;margin-bottom:6px">Administration</div>'
      + '<div style="color:#b8b2a8;font-size:.9rem;margin-bottom:18px">Connexion requise (mot de passe administrateur)</div>'
      + '<input id="ag-pw" type="password" autocomplete="current-password" placeholder="Mot de passe" '
      + 'style="width:100%;padding:13px;border-radius:12px;border:2px solid #3a3c3a;background:#2a2c2a;color:#fff8f0;font-size:1rem;text-align:center;font-family:inherit">'
      + '<button id="ag-b" style="width:100%;margin-top:10px;padding:13px;border:0;border-radius:12px;background:#e9c46a;color:#1f2120;font-weight:800;cursor:pointer;font-family:inherit">Se connecter</button>'
      + '<div id="ag-e" style="color:#ff8f8f;font-size:.85rem;min-height:1.2em;margin-top:8px"></div></div>';
    document.body.appendChild(o);
    var pw = o.querySelector('#ag-pw'), b = o.querySelector('#ag-b'), e = o.querySelector('#ag-e');
    function go() {
      e.textContent = ''; b.disabled = true;
      fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) })
        .then(function (r) { if (r.ok) { o.remove(); return; } return r.json().then(function (d) { e.textContent = (d && d.error) || 'Mot de passe incorrect'; b.disabled = false; pw.select(); }); })
        .catch(function () { e.textContent = 'Erreur réseau'; b.disabled = false; });
    }
    b.addEventListener('click', go);
    pw.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
    pw.focus();
  }
  fetch('/api/admin/me').then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.loggedIn) showLogin();
  }).catch(function () { /* en cas d'erreur réseau on ne bloque pas l'affichage */ });
})();

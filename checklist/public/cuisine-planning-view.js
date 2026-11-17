// Planning cuisine en LECTURE SEULE (page d'accueil cuisine).
// Même logique que le planning de l'admin cuisine, mais sans les postes, sans
// totaux et non modifiable : horaires là où il y en a (demi-journée, journée
// continue, horaires saisis), croix sur les repos et les services non
// travaillés, libellé sur les congés / arrêts / école.
(function () {
  'use strict';
  const box = document.getElementById('cuisine-planning');
  if (!box) return;

  // --- Styles (propres à ce bloc) ---------------------------------------------
  const css = `
  .cpv { background:#fff; border:2px solid var(--gold); border-radius:12px; padding:12px 14px 14px; margin:0 0 18px; }
  .cpv-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
  .cpv-title { font-size:.82rem; font-weight:900; text-transform:uppercase; letter-spacing:.06em; color:var(--gold-dark); }
  .cpv-nav { display:flex; align-items:center; gap:6px; }
  .cpv-nav button { border:0; background:#f1ece2; color:var(--dark); border-radius:9px; padding:7px 10px; font:inherit; font-weight:800; font-size:.8rem; cursor:pointer; }
  .cpv-nav button:hover { background:#e8e0d0; }
  .cpv-week { font-weight:800; font-size:.86rem; color:var(--dark); min-width:118px; text-align:center; }
  .cpv-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  .cpv-table { border-collapse:collapse; width:100%; min-width:560px; table-layout:fixed; font-variant-numeric:tabular-nums; }
  .cpv-table th, .cpv-table td { border:1px solid var(--border); padding:0; text-align:center; vertical-align:middle; }
  .cpv-table thead th { background:#1f2120; color:var(--cream); font-size:.72rem; font-weight:700; padding:5px 2px; line-height:1.2; }
  .cpv-table thead th.cpv-today { background:var(--gold-dark); }
  .cpv-table .cpv-name { width:84px; text-align:left; padding:4px 6px; font-size:.8rem; font-weight:700; color:var(--dark);
    background:#faf3e8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; position:sticky; left:0; z-index:1; }
  .cpv-table thead th.cpv-name { background:#1f2120; color:var(--cream); z-index:2; }
  .cpv-table tbody tr > td { border-top-color:#1f2120; border-bottom-color:#1f2120; }
  .cpv-table tbody tr:nth-child(even) td.cpv-work { background:#f7f5f0; }
  .cpv-table td.cpv-work { background:#fff; height:34px; }
  .cpv-table td.cpv-tdy { box-shadow: inset 2px 0 0 var(--gold), inset -2px 0 0 var(--gold); }
  .cpv-x { position:relative; background:#d7d7d4 !important; }
  .cpv-x svg { position:absolute; inset:0; width:100%; height:100%; }
  .cpv-x svg line { stroke:#9a9a96; stroke-width:1; vector-effect:non-scaling-stroke; }
  td.cpv-x { height:34px; }
  .cpv-st { font-size:.74rem; font-weight:800; height:34px; }
  .cpv-st.s-cp { background:#dbeafe; color:#1e40af; }
  .cpv-st.s-am { background:#fee2e2; color:#b91c1c; }
  .cpv-st.s-ecole { background:#ede9fe; color:#6d28d9; }
  .cpv-st.s-absent { background:#e5e7eb; color:#374151; }
  .cpv-stack { display:flex; flex-direction:column; height:100%; min-height:34px; }
  .cpv-half { flex:1 1 50%; min-height:17px; display:flex; align-items:center; justify-content:center; gap:3px;
    font-size:.68rem; font-weight:700; color:var(--dark); line-height:1.1; white-space:nowrap; }
  .cpv-half + .cpv-half { border-top:1px dashed #cfc8bb; }
  .cpv-half.cpv-h { background:#fbf3e3; }
  .cpv-half.cpv-cp { background:#dbeafe; color:#1e40af; font-weight:800; }
  .cpv-half.cpv-ech { background:#fde9c8; color:#8a5a00; font-weight:800; }
  .cpv-full { min-height:34px; display:flex; align-items:center; justify-content:center; font-size:.68rem; font-weight:700;
    background:#fbf3e3; color:var(--dark); line-height:1.15; white-space:nowrap; padding:0 2px; }
  .cpv-ex { font-size:.56rem; font-weight:900; color:#8a5a00; border:1px solid #c9973a; border-radius:4px; padding:0 3px; }
  .cpv-legend { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:8px; font-size:.72rem; color:var(--muted); }
  .cpv-legend i { display:inline-block; width:14px; height:10px; border:1px solid var(--border); vertical-align:-1px; margin-right:4px; }
  .cpv-empty { color:var(--muted); font-size:.9rem; padding:8px 2px; }
  @media (max-width:680px) {
    .cpv { padding:10px 8px 12px; }
    .cpv-table .cpv-name { width:66px; font-size:.74rem; padding:4px; }
    .cpv-half, .cpv-full { font-size:.62rem; }
  }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // --- Outils -----------------------------------------------------------------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const p2 = (n) => String(n).padStart(2, '0');
  const hm = (ts) => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  const frDay = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
  const DOW = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const CROSS = '<svg viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="0" x2="10" y2="10"/><line x1="10" y1="0" x2="0" y2="10"/></svg>';
  const AWAY = { cp: 'CP', am: 'AM', ecole: 'École', absent: 'Abs' };

  function weekOf(offset) {
    const d = new Date(); d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
    const days = [];
    for (let i = 0; i < 7; i++) { const x = new Date(d); x.setDate(d.getDate() + i); days.push(iso(x)); }
    return days;
  }
  function restDaysOn(periods, day) {
    let best = null;
    for (const p of (periods || [])) if (p.from <= day && (!best || p.from > best.from)) best = p;
    return best ? best.days : [];
  }
  // Mêmes fenêtres que le planning de l'admin : midi 9h–14h, soir 18h–21h.
  function svcPresence(seg) {
    const d = new Date(seg.clockIn);
    const at = (h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
    const midiEnd = at(14, 0);
    if (seg.clockOut != null) {
      return { midi: seg.clockIn < midiEnd && seg.clockOut > at(9, 0), soir: seg.clockIn < at(21, 0) && seg.clockOut > at(18, 0) };
    }
    return { midi: seg.clockIn < midiEnd, soir: seg.clockIn >= midiEnd && seg.clockIn < at(21, 0) };
  }
  function classify(segs) {
    const cont = []; const midi = []; const soir = [];
    for (const s of segs) {
      const p = svcPresence(s);
      if (p.midi && p.soir) cont.push(s);
      else if (p.midi) midi.push(s);
      else if (p.soir) soir.push(s);
      else (new Date(s.clockIn).getHours() < 17 ? midi : soir).push(s);
    }
    return { cont, midi, soir };
  }
  const cpSvcOf = (s) => ((s === 'demi_cp_midi' || s === 'cp_midi_demi_soir') ? 'midi' : ((s === 'demi_cp_soir' || s === 'cp_soir_demi_midi') ? 'soir' : null));
  const demiSvcOf = (s) => ((s === 'demi_midi' || s === 'cp_soir_demi_midi') ? 'midi' : ((s === 'demi_soir' || s === 'cp_midi_demi_soir') ? 'soir' : null));
  const fmt = (s) => (s.clockOut != null ? `${hm(s.clockIn)}–${hm(s.clockOut)}` : hm(s.clockIn));

  // --- Une case (salarié × jour) ------------------------------------------------
  function cellHTML(emp, day, segs, status, isToday) {
    const tdy = isToday ? ' cpv-tdy' : '';
    const hasHours = segs.length > 0;
    const wd = new Date(day + 'T12:00:00').getDay();
    const isRest = restDaysOn(emp.restPeriods, day).includes(wd) || status === 'repos';
    const exMidi = status === 'extra_midi' || status === 'extra_both';
    const exSoir = status === 'extra_soir' || status === 'extra_both';
    if (AWAY[status] && !hasHours) return `<td class="cpv-st s-${status}${tdy}">${AWAY[status]}</td>`;
    if (isRest && !hasHours && !exMidi && !exSoir) return `<td class="cpv-x${tdy}">${CROSS}</td>`;

    const { cont, midi, soir } = classify(segs);
    const demi = demiSvcOf(status); const cp = cpSvcOf(status);
    const echMidi = status === 'echange_midi' || status === 'echange_both';
    const echSoir = status === 'echange_soir' || status === 'echange_both';
    const isCont = hasHours && (cont.length > 0 || (emp.continuous && !(midi.length && soir.length) && !demi && !cp));
    if (isCont) return `<td class="cpv-work${tdy}"><div class="cpv-full">${segs.map(fmt).join('<br>')}</div></td>`;

    const half = (svc, list, ech, ex) => {
      if (list.length) return `<div class="cpv-half cpv-h">${list.map(fmt).join(' ')}</div>`;
      if (cp === svc) return '<div class="cpv-half cpv-cp">½CP</div>';
      if (demi === svc) return `<div class="cpv-half cpv-x">${CROSS}</div>`;
      if (ech) return '<div class="cpv-half cpv-ech" title="Échange">É</div>';
      if (isRest && !ex) return `<div class="cpv-half cpv-x">${CROSS}</div>`;
      return `<div class="cpv-half">${ex ? '<span class="cpv-ex">EX</span>' : ''}</div>`; // travaillé, sans horaire précisé
    };
    const m = half('midi', midi, echMidi, exMidi);
    const s = half('soir', soir, echSoir, exSoir);
    // Journée complète sans rien de particulier : case vide, sans séparation.
    const plain = '<div class="cpv-half"></div>';
    if (m === plain && s === plain) return `<td class="cpv-work${tdy}"></td>`;
    return `<td class="cpv-work${tdy}"><div class="cpv-stack">${m}${s}</div></td>`;
  }

  // --- Rendu --------------------------------------------------------------------
  let offset = 0;
  let lastKey = '';
  function render(days, data, toToday) {
    const today = iso(new Date());
    const oldWrap = box.querySelector('.cpv-wrap');
    const keepScroll = oldWrap ? oldWrap.scrollLeft : 0;
    const from = days[0];
    const emps = (data.employees || [])
      .filter((e) => e.active || (e.endDate && e.endDate >= from))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const segsOf = new Map(); // "empId|jour" → créneaux
    for (const e of (data.report || [])) for (const d of (e.days || [])) segsOf.set(e.employeeId + '|' + d.day, d.segments || []);
    const stOf = new Map();
    for (const s of (data.statuses || [])) stOf.set(s.employeeId + '|' + s.day, s.status);

    let html = `<div class="cpv-head"><span class="cpv-title">📅 Planning cuisine</span>
      <span class="cpv-nav"><button type="button" id="cpv-prev" aria-label="Semaine précédente">‹ Préc.</button>
      <span class="cpv-week">du ${frDay(days[0])} au ${frDay(days[6])}</span>
      <button type="button" id="cpv-next" aria-label="Semaine suivante">Suiv. ›</button></span></div>`;
    if (!emps.length) html += '<div class="cpv-empty">Aucun salarié.</div>';
    else {
      html += '<div class="cpv-wrap"><table class="cpv-table"><thead><tr><th class="cpv-name">Équipe</th>';
      for (const d of days) html += `<th class="${d === today ? 'cpv-today' : ''}">${DOW[new Date(d + 'T12:00:00').getDay()]}<br>${frDay(d)}</th>`;
      html += '</tr></thead><tbody>';
      for (const emp of emps) {
        html += `<tr><td class="cpv-name" title="${esc(emp.name)}">${esc(emp.name)}</td>`;
        for (const d of days) html += cellHTML(emp, d, segsOf.get(emp.id + '|' + d) || [], stOf.get(emp.id + '|' + d), d === today);
        html += '</tr>';
      }
      html += '</tbody></table></div>'
        + '<div class="cpv-legend"><span><i style="background:#d7d7d4"></i>repos / service non travaillé</span>'
        + '<span><i style="background:#fbf3e3"></i>horaires (demi, continue)</span>'
        + '<span><i style="background:#dbeafe"></i>congé payé</span><span><i style="background:#fff"></i>journée complète</span></div>';
    }
    box.innerHTML = html;
    box.hidden = false;
    // Écran étroit (le tableau défile) : à l'ouverture et au changement de semaine,
    // on amène la colonne d'aujourd'hui juste après les noms ; lors d'un simple
    // rafraîchissement, on garde l'endroit où la personne en était.
    const wrap = box.querySelector('.cpv-wrap');
    if (wrap && wrap.scrollWidth > wrap.clientWidth) {
      const th = wrap.querySelector('thead th.cpv-today');
      const nameW = (wrap.querySelector('thead th.cpv-name') || {}).offsetWidth || 0;
      wrap.scrollLeft = toToday ? (th ? Math.max(0, th.offsetLeft - nameW) : 0) : keepScroll;
    }
    document.getElementById('cpv-prev').addEventListener('click', () => { offset--; load(true); });
    document.getElementById('cpv-next').addEventListener('click', () => { offset++; load(true); });
  }

  async function load(force) {
    const days = weekOf(offset);
    let data;
    try {
      const r = await fetch(`/cuisine/api/planning?from=${days[0]}&to=${days[6]}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      // Pas de planning disponible : au premier chargement on n'affiche rien ; ensuite on garde le dernier affichage.
      if (force && !box.hidden) { const w = box.querySelector('.cpv-week'); if (w) w.textContent = 'Indisponible'; }
      return;
    }
    // On ne redessine que si quelque chose a changé (pas de saut d'écran toutes les minutes).
    const key = days[0] + JSON.stringify(data);
    if (!force && key === lastKey) return;
    lastKey = key;
    render(days, data, !!force);
  }

  box.className = 'cpv';
  load(true);
  setInterval(() => { if (!document.hidden) load(false); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });
})();

'use strict';
/*
 * Rendu LECTURE SEULE du planning (utilisé sur l'écran de pointage).
 * Reçoit les données et produit la même grille que l'admin, mais sans édition.
 * Exposé via window.PlanningView.render(container, data).
 */
(function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtH(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h${String(m).padStart(2, '0')}`;
  }
  function fmtTime(ts) {
    return ts == null ? '—' : new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  function localISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function daysBetween(from, to) {
    const out = []; const d = new Date(from + 'T12:00:00'); const end = new Date(to + 'T12:00:00');
    while (d <= end) { out.push(localISO(d)); d.setDate(d.getDate() + 1); }
    return out;
  }
  function planningDayLabel(iso) {
    const dt = new Date(iso + 'T12:00:00');
    const j = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][dt.getDay()];
    return `${j}<br>${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
  }
  function restDaysOn(periods, dateStr) {
    let best = null;
    for (const p of (periods || [])) if (p.from <= dateStr && (!best || p.from > best.from)) best = p;
    return best ? best.days : [];
  }
  // Date de début d'un salarié = début de sa 1re période de repos (même règle
  // que l'admin) : un nouveau salarié n'apparaît qu'à partir de cette semaine.
  // Sans période de repos → visible partout ('0000-01-01').
  function empStartDate(emp) {
    const ps = emp.restPeriods || [];
    if (!ps.length) return '0000-01-01';
    return ps.reduce((min, p) => (p.from < min ? p.from : min), ps[0].from);
  }
  function svcPresence(seg) {
    const d = new Date(seg.clockIn);
    const at = (h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
    const midiEnd = at(14, 0); const soirStart = at(18, 0); const soirEnd = at(21, 0); const midiStart = at(9, 0);
    const inT = seg.clockIn;
    if (seg.clockOut != null) {
      return { midi: inT < midiEnd && seg.clockOut > midiStart, soir: inT < soirEnd && seg.clockOut > soirStart };
    }
    return { midi: inT < midiEnd, soir: inT >= midiEnd && inT < soirEnd };
  }
  function classifyDay(segments) {
    const cont = []; const midi = []; const soir = [];
    for (const s of segments) {
      const p = svcPresence(s);
      if (p.midi && p.soir) cont.push(s);
      else if (p.midi) midi.push(s);
      else if (p.soir) soir.push(s);
      else (new Date(s.clockIn).getHours() < 17 ? midi : soir).push(s);
    }
    return { cont, midi, soir };
  }
  const STATUS_SHORT = { cp: 'CP', am: 'AM', ecole: 'École', absent: 'Abs', repos: 'Repos' };
  const AWAY_STATUSES = ['cp', 'am', 'absent', 'ecole'];
  // Nombre de personnes dans une case « Extra » : prénoms séparés par « + » (ex. « Paul + Marie » = 2).
  function countExtra(txt) {
    return String(txt || '').split('+').map((x) => x.trim()).filter(Boolean).length;
  }
  // Demi-CP : la personne ne travaille pas ce service (payé comme un CP). Midi = 3h, soir = 4h.
  const HALF_CP = { demi_cp_midi: 3 * 3600, demi_cp_soir: 4 * 3600 };
  const CROSS_SVG = '<svg class="pl-cross" viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="0" x2="10" y2="10"/><line x1="10" y1="0" x2="0" y2="10"/></svg>';

  function render(container, data) {
    const { from, to } = data;
    if (!from || !to) { container.innerHTML = '<div class="empty">Semaine non définie.</div>'; return; }
    const days = daysBetween(from, to);
    const byId = new Map((data.report || []).map((e) => [e.employeeId, e]));
    const statusMap = new Map();
    for (const s of (data.statuses || [])) statusMap.set(s.employeeId + '|' + s.day, s.status);
    const extraMap = (data.extra && typeof data.extra === 'object') ? data.extra : {};
    const weekInfo = (data.weekInfo && typeof data.weekInfo === 'object') ? data.weekInfo : {};
    const weekNote = (data.weekNote || '').trim();

    const actives = (data.employees || [])
      .filter((e) => e.active || (e.endDate && e.endDate >= from))
      // …et qui ont DÉBUTÉ au plus tard cette semaine (mêmes règles que l'admin) :
      // jamais masqué s'il a déjà des heures pointées cette semaine-là.
      .filter((e) => empStartDate(e) <= to || byId.has(e.id))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    if (!actives.length) { container.innerHTML = '<div class="empty">Aucun salarié.</div>'; return; }

    let html = '<table class="planning"><thead><tr><th class="pl-name">Salarié</th>';
    for (const d of days) html += `<th>${planningDayLabel(d)}</th>`;
    html += '<th style="text-align:right">Total</th><th class="pl-info-head">Infos</th></tr></thead><tbody>';

    const dayTotals = {}; const midiCount = {}; const soirCount = {}; const weekday = {};
    days.forEach((d) => { dayTotals[d] = 0; midiCount[d] = 0; soirCount[d] = 0; weekday[d] = new Date(d + 'T12:00:00').getDay(); });
    let grand = 0;

    const firstMidiT = {}; const firstSoirT = {};
    for (const d of days) {
      let bmT = Infinity; let bsT = Infinity;
      for (const emp of actives) {
        const rep = byId.get(emp.id);
        const day = rep && rep.days.find((x) => x.day === d);
        if (!day || !day.segments.length) continue;
        const { cont, midi, soir } = classifyDay(day.segments);
        if (emp.continuous || cont.length) continue;
        for (const s of midi) if (s.clockIn < bmT) bmT = s.clockIn;
        for (const s of soir) if (s.clockIn < bsT) bsT = s.clockIn;
      }
      firstMidiT[d] = bmT; firstSoirT[d] = bsT;
    }

    for (const emp of actives) {
      const rep = byId.get(emp.id);
      let dayCells = '';
      let demiCount = 0;
      let cpBonusSec = 0; // heures créditées : CP/École/AM (7h/jour) + ½ CP (3h/4h)
      let awayDays = 0; // jours CP/École/AM crédités cette semaine (plafond : 5)
      // Semaine à 6-7 jours posés (CP/École/AM sans heures) : rien n'est crédité.
      let posedCount = 0;
      for (const d of days) {
        const st = statusMap.get(emp.id + '|' + d);
        if (st === 'cp' || st === 'ecole' || st === 'am') {
          const dd = rep && rep.days.find((x) => x.day === d);
          if (!(dd && dd.segments.length)) posedCount++;
        }
      }
      for (const d of days) {
        const day = rep && rep.days.find((x) => x.day === d);
        const hasHours = !!(day && day.segments.length);
        const status = statusMap.get(emp.id + '|' + d);
        const awayStatus = AWAY_STATUSES.includes(status) ? status : null;
        const isRest = restDaysOn(emp.restPeriods, d).includes(weekday[d]) || status === 'repos';
        const demiMidi = status === 'demi_midi'; const demiSoir = status === 'demi_soir';
        const demiCpMidi = status === 'demi_cp_midi'; const demiCpSoir = status === 'demi_cp_soir';
        const echMidi = status === 'echange_midi' || status === 'echange_both';
        const echSoir = status === 'echange_soir' || status === 'echange_both';
        let inner; let fillCls = ''; let exchangeMark = '';

        if (awayStatus && !hasHours) {
          inner = `<span class="pl-status-lbl">${STATUS_SHORT[awayStatus]}</span>`;
          fillCls = ` pl-statusfill st-${awayStatus}`;
          // CP / École / AM = 7h créditées, SAUF : jour de repos (0h), plafond de
          // 5 jours crédités (35h), semaine à 6-7 jours posés (rien). Absent = 0h.
          if ((awayStatus === 'cp' || awayStatus === 'ecole' || awayStatus === 'am') && !isRest && awayDays < 5 && posedCount < 6) {
            awayDays += 1; dayTotals[d] += 7 * 3600; cpBonusSec += 7 * 3600;
          }
        } else if (isRest && !hasHours) {
          inner = CROSS_SVG;
          fillCls = ' pl-rest';
        } else {
          const fmt = (s) => (s.open ? fmtTime(s.clockIn) : `${fmtTime(s.clockIn)}–${fmtTime(s.clockOut)}`);
          const { cont, midi, soir } = hasHours ? classifyDay(day.segments) : { cont: [], midi: [], soir: [] };
          // Continu (rouge plein) seulement si la journée l'est VRAIMENT (mêmes
          // règles que l'admin : coupure visible ou demi/½CP => demi-cases).
          const isCont = hasHours && (cont.length > 0
            || (emp.continuous && !(midi.length && soir.length) && !demiMidi && !demiSoir && !demiCpMidi && !demiCpSoir));
          let stack;
          if (isCont) {
            stack = `<div class="pl-half pl-cont">${day.segments.map(fmt).join('<br>')}</div>`;
            midiCount[d]++; soirCount[d]++;
          } else {
            let midiHalf;
            if (midi.length) {
              const isFirst = Math.min(...midi.map((s) => s.clockIn)) === firstMidiT[d];
              midiHalf = `<div class="pl-half${isFirst ? ' pl-first' : ''}">${midi.map(fmt).join('<br>')}</div>`;
              midiCount[d]++;
            } else if (demiMidi) {
              midiHalf = `<div class="pl-half pl-demi">${CROSS_SVG}</div>`;
            } else if (demiCpMidi) {
              midiHalf = '<div class="pl-half pl-cphalf">½CP</div>';
            } else if (echMidi) {
              midiHalf = '<div class="pl-half pl-echange" title="Échange midi">É</div>';
            } else {
              midiHalf = '<div class="pl-half pl-pres">PM</div>'; midiCount[d]++;
            }
            let soirHalf;
            if (soir.length) {
              const isOpen = Math.min(...soir.map((s) => s.clockIn)) === firstSoirT[d];
              soirHalf = `<div class="pl-half${isOpen ? ' pl-open' : ''}">${soir.map(fmt).join('<br>')}</div>`;
              soirCount[d]++;
            } else if (demiSoir) {
              soirHalf = `<div class="pl-half pl-demi">${CROSS_SVG}</div>`;
            } else if (demiCpSoir) {
              soirHalf = '<div class="pl-half pl-cphalf">½CP</div>';
            } else if (echSoir) {
              soirHalf = '<div class="pl-half pl-echange" title="Échange soir">É</div>';
            } else {
              soirHalf = '<div class="pl-half pl-pres">PS</div>'; soirCount[d]++;
            }
            stack = midiHalf + soirHalf;
            // Ne compter une demi que si le service marqué « demi » est réellement vide
            // (mêmes règles que côté admin : si des heures existent, la personne a travaillé).
            if ((demiMidi && !midi.length) || (demiSoir && !soir.length)) demiCount++;
          }
          inner = `<div class="pl-stack">${stack}</div>`;
          fillCls = ' pl-filled';
          if (hasHours) dayTotals[d] += day.seconds;
          // ½ CP : crédite 3h (midi) / 4h (soir) si le service concerné est vide.
          const cpSec = (demiCpMidi && !midi.length ? HALF_CP.demi_cp_midi : 0)
            + (demiCpSoir && !soir.length ? HALF_CP.demi_cp_soir : 0);
          if (cpSec) { dayTotals[d] += cpSec; cpBonusSec += cpSec; }
          if (isRest && hasHours) exchangeMark = '<span class="pl-exchange" title="Échange">E</span>';
        }
        dayCells += `<td class="pl-cell${fillCls}">${exchangeMark}${inner}</td>`;
      }
      const tot = (rep ? rep.totalSeconds : 0) + cpBonusSec; // + heures de ½ CP de la semaine
      grand += tot;
      const nameCell = `<td class="pl-name"><div class="pl-name-inner"><span class="pl-name-txt">${escapeHtml(emp.name)}</span>`
        + (demiCount ? `<span class="pl-demi-count">${demiCount}</span>` : '')
        + '</div></td>';
      const noteTxt = (weekInfo[emp.id] || '').trim();
      const infoCell = `<td class="pl-info">${noteTxt ? `<span class="pl-info-txt">${escapeHtml(noteTxt)}</span>` : ''}</td>`;
      html += `<tr class="pl-emp-row">${nameCell}${dayCells}<td class="pl-total">${fmtH(tot)}</td>${infoCell}</tr>`;
    }

    // Ligne « Extra » (lecture seule : texte si présent, sinon vide).
    html += '<tr class="pl-extra-row"><td class="pl-name">Extra</td>';
    for (const d of days) {
      const m = (extraMap[d + '|midi'] || '').trim();
      const s = (extraMap[d + '|soir'] || '').trim();
      midiCount[d] += countExtra(m);
      soirCount[d] += countExtra(s);
      const sub = (val) => `<div class="pl-extra-sub${val ? ' has' : ''}">`
        + (val ? `<span class="pl-extra-txt">${escapeHtml(val)}</span>` : '<span class="pl-empty">&nbsp;</span>')
        + '</div>';
      html += `<td class="pl-extra-cell">${sub(m)}${sub(s)}</td>`;
    }
    html += '<td></td><td></td></tr>';

    html += '<tr class="pl-svc-row"><td class="pl-name">Pres. midi</td>';
    for (const d of days) html += `<td>${midiCount[d] || '—'}</td>`;
    html += '<td></td><td></td></tr>';
    html += '<tr class="pl-svc-row"><td class="pl-name">Pres. soir</td>';
    for (const d of days) html += `<td>${soirCount[d] || '—'}</td>`;
    html += '<td></td><td></td></tr>';

    html += '<tr class="pl-tot-row"><td class="pl-name">Total / jour</td>';
    for (const d of days) html += `<td>${dayTotals[d] ? fmtH(dayTotals[d]) : '—'}</td>`;
    html += `<td class="pl-total">${fmtH(grand)}</td><td></td></tr>`;

    // Grande case « Notes » de la semaine (lecture seule), sur la largeur des 7 jours.
    html += '<tr class="pl-notes-row"><td class="pl-name">Notes</td>'
      + `<td class="pl-notes-cell" colspan="${days.length}">${weekNote ? `<span class="pl-wn-txt">${escapeHtml(weekNote)}</span>` : ''}</td>`
      + '<td></td><td></td></tr>';

    html += '</tbody></table>';

    container.innerHTML = html;
  }

  window.PlanningView = { render };
})();

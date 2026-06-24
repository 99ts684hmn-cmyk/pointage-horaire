'use strict';

function frDate(iso) { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
function frTime(iso) { if (!iso) return '-'; return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const params = new URLSearchParams(location.search);
const sessionId = params.get('id');
// « Retour » dépend de la provenance : cuisine, rapports, ou (défaut) salle.
const from = params.get('from');
// Sélecteur de clôture : salle = salariés pointage ; cuisine = cuisiniers du planning cuisine.
const STAFF_URL = (from === 'cuisine' || from === 'resp') ? '/cuisine/api/cooks' : '/api/employees';
if (from === 'cuisine') {
  const back = document.getElementById('back-link');
  const navList = document.getElementById('nav-list');
  const navAdmin = document.getElementById('nav-admin');
  if (back) back.href = 'cuisine.html';
  if (navList) navList.href = 'cuisine.html';
  if (navAdmin) navAdmin.href = 'cuisine-admin-accueil.html';
} else if (from === 'resp') {
  const back = document.getElementById('back-link');
  const navList = document.getElementById('nav-list');
  const navAdmin = document.getElementById('nav-admin');
  if (back) back.href = 'resp-cuisine.html';
  if (navList) navList.href = 'resp-cuisine.html';
  if (navAdmin) navAdmin.href = 'resp-cuisine-admin.html';
} else if (from === 'rapports') {
  const back = document.getElementById('back-link');
  const scope = params.get('scope');
  if (back) back.href = 'rapports.html' + (scope ? `?scope=${encodeURIComponent(scope)}` : '');
}
const content = document.getElementById('content');
const overlay = document.getElementById('overlay');
const modal = document.getElementById('modal');
let session = null;
let employees = [];
let selectedEmp = '';
let customName = '';

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff8f0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';

async function fetchSession() {
  const r = await fetch(`api/sessions/${encodeURIComponent(sessionId)}`);
  if (!r.ok) { content.innerHTML = '<div class="empty">Session introuvable.</div>'; return; }
  session = await r.json();
  render();
}

async function toggleTask(taskId, isDone) {
  const t = session.tasks.find((x) => x.id === taskId);
  if (t) { t.isDone = isDone; t.doneAt = isDone ? new Date().toISOString() : null; }
  render();
  // Dernière tâche cochée → on propose directement la clôture (choix du nom),
  // sans avoir à taper « Finaliser ».
  const allDone = session.tasks.length > 0 && session.tasks.every((x) => x.isDone);
  if (isDone && allDone && session.status !== 'TERMINE') openFinalize();
  await fetch(`api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'toggle_task', taskId, isDone }),
  });
}

async function reopen() {
  await fetch(`api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reopen' }),
  });
  fetchSession();
}

async function finalize() {
  const name = selectedEmp || customName.trim();
  if (!name) return;
  await fetch(`api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', completedBy: name }),
  });
  overlay.classList.remove('show');
  celebrate(name);
  fetchSession();
}

// Blagues façon Carambar, tirées au sort à la validation. Une par ligne (texte
// brut entre backticks → aucune apostrophe à échapper). Les lignes vides, qui
// servent juste à regrouper par thème, sont ignorées.
const JOKES = `
Quel est le comble pour un électricien ? Ne pas être au courant !
Pourquoi le café est-il un mauvais élève ? Il se fait toujours repasser !
Quel poisson ne fête jamais son anniversaire ? Le poisson pané !
Quel est le comble pour un jardinier ? Raconter des salades !
Que fait une fraise sur un cheval ? Tagada, tagada !
Qu'est-ce qui est jaune et qui attend ? Jonathan !
Quel est le comble pour un cuisinier ? Avoir un poil dans la main !
Pourquoi les plongeurs plongent-ils en arrière ? Sinon ils tombent dans le bateau !
Que dit une maman tomate à son petit qui traîne ? Dépêche-toi, tu vas finir en pizza !
Comment appelle-t-on un chien sans pattes ? On ne l'appelle pas, on va le chercher !
Quel est le sport le plus fruité ? La boxe : on y prend des pêches !
Que dit un oignon quand il se cogne ? Ail ail ail !
Quelle est la femelle du hamster ? L'Amsterdam !
Que dit un mur à un autre mur ? On se retrouve au coin !
Que dit un zéro à un huit ? Joli, ta ceinture !
Que dit un crayon à un autre crayon ? T'as une drôle de mine !
Pourquoi le livre de maths est-il triste ? Il a trop de problèmes !
Qu'est-ce qui est vert et qui monte et descend ? Un petit pois dans un ascenseur !
Que se disent deux chats amoureux ? On est félin pour l'autre !
Que dit un escargot quand il croise une limace ? Oh, un nudiste !
Pourquoi les girafes ont-elles un long cou ? Parce qu'elles ont les pieds qui sentent mauvais !
Comment appelle-t-on un chat tombé dans la peinture à Noël ? Un chat-peint de Noël !
Pourquoi les abeilles bourdonnent-elles ? Parce qu'elles ne connaissent pas les paroles !
Pourquoi les squelettes ne se battent-ils jamais ? Ils n'ont pas de tripes !
Que mange un astronaute le matin ? Des œufs en orbite !
Comment appelle-t-on un café qui n'en finit pas ? Un café long !
Quel est le comble pour un aveugle ? Ne pas voir d'inconvénient !
Que dit un bouchon à une bouteille ? Tu me lâches, là ?
Comment appelle-t-on un boomerang qui ne revient pas ? Un bâton !
Pourquoi le téléphone porte-t-il des lunettes ? Parce qu'il a perdu tous ses contacts !
Pourquoi l'ordinateur est-il allé chez le médecin ? Il avait attrapé un virus !
Comment appelle-t-on une mouche sans ailes ? Une marche !
Que dit la pluie à la fenêtre ? Laisse-moi entrer, je goutte !
Comment appelle-t-on un chat qui a tout compris ? Un chat-malin !
Pourquoi le vélo ne tient-il pas debout tout seul ? Parce qu'il est deux fois trop fatigué !

Quel est le comble pour un facteur ? Ne pas avoir d'adresse !
Quel est le comble pour un coiffeur ? Couper les cheveux en quatre !
Quel est le comble pour un marin ? Avoir le mal de mer !
Quel est le comble pour un professeur de géographie ? Perdre le Nord !
Quel est le comble pour un boulanger ? Rouler quelqu'un dans la farine !
Quel est le comble pour un dentiste ? Avoir une dent contre quelqu'un !
Quel est le comble pour un pâtissier ? Être tarte !
Quel est le comble pour un pompier ? Avoir une touche et ne pas réussir à l'allumer !
Quel est le comble pour un horloger ? Se lever à pas d'heure !
Quel est le comble pour un opticien ? Ne pas avoir de vue d'ensemble !
Quel est le comble pour un musicien ? Perdre la mesure !
Quel est le comble pour un cordonnier ? Être à côté de ses pompes !
Quel est le comble pour un fleuriste ? Se faire envoyer sur les roses !
Quel est le comble pour un pêcheur ? Avoir une touche et ne rien attraper !
Quel est le comble pour un peintre ? En faire tout un tableau !
Quel est le comble pour un comptable ? Perdre le compte de ses comptes !
Quel est le comble pour un astronome ? Ne pas décrocher la lune !
Quel est le comble pour un boxeur ? Ne pas tenir le coup !
Quel est le comble pour un chauffeur de taxi ? Ne jamais arriver à bon port !
Quel est le comble pour un menuisier ? Avoir un trou de mémoire en plein travail !
Quel est le comble pour un plombier ? Avoir un poil dans la main et le robinet qui fuit !
Quel est le comble pour un coiffeur ? Avoir une coupe et la perdre au foot !
Quel est le comble pour un jardinier ? Prendre racine au boulot !
Quel est le comble pour un électricien ? Avoir une idée lumineuse et sauter les plombs !
Quel est le comble pour un sourd ? S'entendre comme larrons en foire !

Monsieur et Madame Térieur ont un fils. Comment s'appelle-t-il ? Alain ! (à l'intérieur)
Monsieur et Madame Mauve ont un fils. Comment s'appelle-t-il ? Guy ! (guimauve)
Monsieur et Madame Tochon ont un fils. Comment s'appelle-t-il ? Paul ! (polochon)
Monsieur et Madame Croche ont une fille. Comment s'appelle-t-elle ? Anna ! (anicroche)
Monsieur et Madame Aïsé ont un fils. Comment s'appelle-t-il ? Jean ! (gêné)
Monsieur et Madame Verre ont un fils. Comment s'appelle-t-il ? Luc ! (Lucifer)
Monsieur et Madame Niçoise ont une fille. Comment s'appelle-t-elle ? Sally ! (salade niçoise)
Monsieur et Madame Cotté ont un fils. Comment s'appelle-t-il ? Boy ! (boycotté)
Monsieur et Madame Bizote ont une fille. Comment s'appelle-t-elle ? Sandra ! (ça ne se dit pas... cendre à bizote)
Monsieur et Madame Vunsthof... non, celle-là on la garde pour plus tard !

La maîtresse demande à Toto un animal d'Afrique. Toto : le lion ! Un autre ? L'autre lion !
La maîtresse : Toto, où se trouve le Canada ? Toto : Page 27 !
Toto demande à son papa ce qu'est un cannibale. Le papa : Tais-toi et mange !
La maîtresse : Toto, fais une phrase au futur. Toto : Je vais en retenue !
La maîtresse : Toto, épelle crocodile. Toto : vous m'avez dit de l'épeler, pas de l'écrire correctement !
Le papa : Toto, pourquoi tu mets de l'eau dans ton cartable ? Pour faire des études supérieures... liquides !

Comment appelle-t-on un chien magicien ? Un labra-cadabra !
Que dit une maman kangourou quand il pleut ? Zut, les petits vont jouer à l'intérieur !
Comment les poissons s'amusent-ils ? En faisant trempette !
Pourquoi les poissons détestent-ils l'ordinateur ? À cause du Net !
Pourquoi les poissons n'aiment pas le tennis ? Ils ont peur du filet !
Que fait une vache quand elle ferme les yeux ? Du lait concentré !
Quel est le comble pour une poule ? Avoir la chair de poule !
Que dit un serpent à un autre serpent ? On garde la tête froide, on n'a même pas de bras !
Comment appelle-t-on un lapin qui se répète ? Un radoteur à grandes oreilles !
Pourquoi les vaches ferment-elles les yeux quand on les trait ? Pour faire du lait concentré !
Quel animal est le plus malpoli ? Le hibou, il fait toujours hou hou !
Comment fait l'escargot pour déménager ? Il prend sa maison sur le dos et il rampe !
Pourquoi les chats n'aiment pas l'eau ? Parce que ça mouille leur réputation !

Pourquoi la tomate est-elle ronde et rouge ? Parce que sinon, ce serait un haricot !
Que dit une fleur à une autre fleur ? Pousse-toi de là !
Pourquoi les feuilles tombent-elles en automne ? Parce qu'elles n'ont plus la branche pour les retenir !
Que dit un arbre à un autre arbre ? On prend racine ici ?
Que fait un nuage quand il a mal ? Il pleut !
Pourquoi le soleil va-t-il à l'école ? Pour devenir plus brillant !
Que dit le vent aux arbres ? Accrochez-vous, ça va secouer !
Pourquoi le caillou ne rit-il jamais ? Parce qu'il est de marbre !
Que dit un volcan amoureux ? J'ai un sacré coup de chaud pour toi !
Pourquoi la rivière ne se perd-elle jamais ? Parce qu'elle suit toujours son cours !
Que se disent deux gouttes d'eau ? À nous deux, on va faire des vagues !
Que dit la mer à la plage ? Rien, elle se contente de faire des signes !
Pourquoi la montagne est-elle si fière ? Parce qu'elle a toujours le sommet de la forme !
Que dit le champignon timide ? Ne me regardez pas, je n'ai pas mis mon chapeau !
Pourquoi l'arbre est-il populaire ? Parce qu'il a beaucoup de branches d'amis !

Que se disent deux assiettes qui se rencontrent ? À table, c'est l'heure !
Quel est le comble pour un serveur ? Apporter l'addition et rester sur la note !
Que dit le sel au poivre ? Toi, tu me fais tourner la tête !
Pourquoi le citron est-il toujours de bonne humeur ? Parce qu'il prend la vie avec un zeste !
Que dit la pâte à pizza au four ? Tu me chauffes, je vais lever !
Comment appelle-t-on un repas qui raconte sa vie ? Un plat bavard !
Quel est le dessert préféré des musiciens ? Le tira-mi-sol !
Pourquoi le pain est-il toujours pressé ? Parce qu'il a peur de devenir rassis !
Que dit une frite à une autre frite ? On est dans le même bain !
Pourquoi le fromage ne joue-t-il jamais à cache-cache ? Parce qu'on le sent toujours arriver !
Que dit la casserole à la poêle ? Arrête de me chauffer !
Quel est le plat préféré du chef pressé ? Le plat du jour, parce qu'il n'a pas le temps pour celui d'hier !
Pourquoi le serveur est-il un bon danseur ? Parce qu'il sait porter le plateau sans faire un faux pas !
Que dit la fourchette au couteau ? Toi, t'es vraiment tranchant comme mec !
Pourquoi la soupe est-elle bavarde ? Parce qu'elle a toujours quelque chose à mijoter !
Que commande un informaticien au bar ? Un café... sans bug !
Pourquoi le menu rit-il tout le temps ? Parce qu'il est plein de bonnes blagues à la carte !

Pourquoi le bœuf est-il toujours zen ? Parce qu'il rumine tranquillement !
Que dit un steak timide ? Je me sens un peu saignant...
Quel est le steak préféré des informaticiens ? Le steak haché !
Que dit une côte de bœuf sur la plancha ? Ça chauffe, là-dessous !
Que commande un fantôme au restaurant ? Un steak bien transparent !
Pourquoi la vache n'entend-elle rien ? Parce que ses cornes ne sonnent pas !
Comment la vache fait-elle ses calculs ? Avec une calculatrice à meuh-moire !
Que dit un bœuf à la salle de sport ? Je travaille mon faux-filet !
Pourquoi le grill est-il toujours invité ? Parce qu'il sait mettre la braise et l'ambiance !
Que dit le boucher romantique ? Tu es la côte de mes rêves !
Pourquoi le bœuf bourguignon est-il prétentieux ? Parce qu'il a toujours la grosse côte !
Que dit la braise au steak ? Viens par ici, on va se réchauffer !
Pourquoi le rumsteck reste-t-il calme ? Parce qu'il garde son sang-froid, même saignant !
Que dit une entrecôte fière ? Je suis une vraie pièce maîtresse !
Comment la vache va-t-elle au travail ? En meuh-tro !
Pourquoi la vache part-elle en vacances ? Pour se mettre au vert !
Que dit un hamburger pressé ? Je suis dans le pain, faut que je file !
Quel est le plat préféré des taureaux ? Le steak, mais jamais à la cape !
Comment appelle-t-on un bœuf qui raconte des blagues ? Un sacré numéro à cornes !
Pourquoi le barbecue est-il un bon ami ? Parce qu'avec lui, il y a toujours de la bonne viande et de la chaleur !

Que dit une tomate coquine ? Approche, je vais te faire rougir !
Pourquoi le concombre rougit-il ? Parce qu'il a vu la salade sans son assaisonnement !
Que se disent deux spaghettis coquins ? On se fait des nœuds ce soir ?
Pourquoi la baguette est-elle gênée ? Parce qu'on l'a sortie sans son torchon !
Que dit un slip à un autre slip ? On se les gèle, ce soir !
Pourquoi les fraises rougissent-elles ? Parce que la chantilly les regarde !
Que dit la pêche au melon ? Toi, t'as une sacrée bouille !
Pourquoi le radis est-il timide ? Parce qu'il rougit dès qu'on le déshabille !
Que dit une bouteille de vin un soir d'été ? Déshabille-moi, je suis enfin à point !
Pourquoi les bananes ne se sentent jamais seules ? Parce qu'elles sortent toujours en bande !
Que se disent deux bougies un peu chaudes ? On se fait une soirée torride ?
Pourquoi la guimauve a-t-elle du succès ? Parce qu'elle est toute douce et tout en rondeurs !
Quelle est la différence entre un mari et un amant ? Quarante-cinq minutes... de cuisson !
Que dit la cerise à la crème fouettée ? Arrête, tu vas me faire monter en haut du gâteau !
Pourquoi l'aubergine fait-elle la maligne ? Parce qu'elle se trouve irrésistible !
`.split('\n').map((s) => s.trim()).filter(Boolean);

// Petite animation de fête (confettis + emojis cuisine + blague) à la validation.
// Pure vanilla, sans dépendance, retirée toute seule après ~4,2 s.
function celebrate(name) {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) { /* ignore */ }
  const layer = document.createElement('div');
  layer.className = 'celebrate-layer';
  const colors = ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#ff8fab', '#8ecae6', '#ffd166'];
  for (let i = 0; i < 40; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = (Math.random() * 100) + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = (1.6 + Math.random() * 1.3) + 's';
    c.style.animationDelay = (Math.random() * 0.6) + 's';
    layer.appendChild(c);
  }
  const emojis = ['🥩', '🔥', '🍔', '👨‍🍳', '🎉', '👏', '🧑‍🍳', '✅', '🍟', '⭐'];
  for (let i = 0; i < emojis.length; i++) {
    const e = document.createElement('span');
    e.className = 'cele-emoji';
    e.textContent = emojis[i];
    const ang = (i / emojis.length) * Math.PI * 2;
    const dist = 150 + Math.random() * 60;
    e.style.setProperty('--dx', (Math.cos(ang) * dist) + 'px');
    e.style.setProperty('--dy', (Math.sin(ang) * dist - 30) + 'px');
    e.style.setProperty('--rot', (Math.random() * 160 - 80) + 'deg');
    e.style.animationDelay = (0.04 * i) + 's';
    layer.appendChild(e);
  }
  const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
  const b = document.createElement('div');
  b.className = 'cele-bravo';
  b.innerHTML = `<div class="cele-bravo-title">${name ? 'Bravo ' + esc(name) + ' ! 🎉' : 'Bravo ! 🎉'}</div>`
    + `<div class="cele-joke">${esc(joke)}</div>`;
  layer.appendChild(b);
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 4200);
}

function render() {
  const done = session.tasks.filter((t) => t.isDone).length;
  const total = session.tasks.length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const allDone = done === total && total > 0;
  const ro = session.status === 'TERMINE';
  const progressColor = (ro || progress === 100) ? 'var(--green)' : (progress >= 50 ? 'var(--gold)' : 'var(--red)');

  const statusBox = ro
    ? `<div style="text-align:right">
         <span class="pill done" style="display:inline-block;margin-bottom:4px">✓ Terminé</span>
         ${session.completedBy ? `<p style="font-size:.72rem;color:var(--green);margin:0">Par ${esc(session.completedBy)} à ${frTime(session.completedAt)}</p>` : ''}
       </div>`
    : '<span class="pill prog">En cours</span>';

  // Les tâches cochées descendent en bas (les tâches à faire restent en haut,
  // dans leur ordre). Tri stable : non-faites d'abord, puis faites.
  const ordered = [...session.tasks.filter((t) => !t.isDone), ...session.tasks.filter((t) => t.isDone)];
  const tasksHtml = ordered.map((t, i) => {
    const cls = 'task' + (t.isDone ? ' done' : (t.isCarriedOver ? ' carried' : '')) + (ro ? ' ro' : '');
    const tag = (t.isCarriedOver && !t.isDone) ? `<span class="tagc">↩ Reporté (${esc(t.dayLabel || '')})</span>` : '';
    const at = (t.isDone && t.doneAt) ? `<p class="at">Fait à ${frTime(t.doneAt)}</p>` : '';
    return `<div class="${cls}" data-id="${esc(t.id)}">
      <div class="chk">${t.isDone ? CHECK_SVG : ''}</div>
      <div class="body"><span class="title">${esc(t.title)}</span>${tag}${at}</div>
    </div>`;
  }).join('');

  const action = ro
    ? '<button class="btn btn-grey btn-block" id="reopen">Réouvrir la check-list</button>'
    : `<button class="btn btn-red btn-block" id="finalize"${allDone ? '' : ' disabled'}>${allDone ? '✓ Finaliser la check-list' : `Encore ${total - done} tâche(s) à faire`}</button>`;

  content.innerHTML = `
    <div class="card shead">
      <div class="top">
        <div class="l"><span class="icon">${esc(session.templateIcon)}</span>
          <div><h1>${esc(session.templateName)}</h1><p class="date">${frDate(session.date)}</p></div>
        </div>${statusBox}
      </div>
      <div style="margin-top:16px">
        <div class="meta" style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:5px;color:var(--muted)">
          <span>${done}/${total} tâches effectuées</span><span style="font-weight:700;color:var(--dark)">${progress}%</span>
        </div>
        <div class="bar on-light"><i style="width:${progress}%;background:${progressColor}"></i></div>
      </div>
    </div>
    <div class="card tasklist">${tasksHtml}</div>
    <div>${action}</div>`;

  if (!ro) {
    content.querySelectorAll('.task').forEach((el) => {
      el.addEventListener('click', () => {
        const t = session.tasks.find((x) => x.id === el.dataset.id);
        if (t) toggleTask(t.id, !t.isDone);
      });
    });
    const fb = document.getElementById('finalize');
    if (fb && allDone) fb.addEventListener('click', openFinalize);
  } else {
    document.getElementById('reopen').addEventListener('click', reopen);
  }
}

function openFinalize() {
  selectedEmp = ''; customName = '';
  renderModal();
  overlay.classList.add('show');
}
function renderModal() {
  const name = selectedEmp || customName.trim();
  modal.innerHTML = `
    <h2>Finaliser</h2>
    <p class="q">Qui a effectué cette check-list ?</p>
    <div id="emp-list">${employees.map((e) => `<button class="emp-opt${selectedEmp === e.name ? ' sel' : ''}" data-name="${esc(e.name)}">${esc(e.name)}</button>`).join('')}</div>
    <div style="margin:6px 0 4px"><input type="text" id="custom" placeholder="Ou entrer un nom manuellement…" value="${esc(customName)}"></div>
    <div class="actions">
      <button class="btn btn-grey" style="flex:1" id="cancel">Annuler</button>
      <button class="btn btn-red" style="flex:1" id="confirm"${name ? '' : ' disabled'}>Confirmer</button>
    </div>`;
  modal.querySelectorAll('.emp-opt').forEach((b) => b.addEventListener('click', () => {
    selectedEmp = b.dataset.name; customName = ''; renderModal();
  }));
  const ci = modal.querySelector('#custom');
  ci.addEventListener('input', () => { customName = ci.value; selectedEmp = ''; updateConfirm(); });
  modal.querySelector('#cancel').addEventListener('click', () => overlay.classList.remove('show'));
  modal.querySelector('#confirm').addEventListener('click', finalize);
}
function updateConfirm() {
  const name = selectedEmp || customName.trim();
  const c = modal.querySelector('#confirm');
  if (c) c.disabled = !name;
}

overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('show'); });

if (!sessionId) {
  content.innerHTML = '<div class="empty">Aucune check-list indiquée.</div>';
} else {
  // Personnel proposé à la clôture : salle = salariés pointage, cuisine = cuisiniers du planning cuisine.
  fetch(STAFF_URL).then((r) => r.json()).then((e) => { employees = Array.isArray(e) ? e : []; }).catch(() => {});
  fetchSession();
}

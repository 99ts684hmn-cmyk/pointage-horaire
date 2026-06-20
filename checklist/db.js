'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Emplacement de la base check-lists. On n'utilise JAMAIS la DB_PATH du
// pointage (collision). Priorité :
//   1. CHECKLIST_DB_PATH si défini, sinon
//   2. un fichier « checklist.db » à côté de la base du pointage (même disque
//      persistant en production, dérivé de DB_PATH), sinon
//   3. checklist/data.db en local.
const DB_PATH = process.env.CHECKLIST_DB_PATH
  || (process.env.DB_PATH
    ? path.join(path.dirname(process.env.DB_PATH), 'checklist.db')
    : path.join(__dirname, 'data.db'));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migration grille COMMANDES : ancien schéma (1 case par jour) -> nouveau (jusqu'à
// 2 cases/jour via `kind` CMD/LIV). On recrée la table si la colonne manque (les
// cases n'étaient pas encore renseignées en prod -> aucune perte de données).
const _cc = db.prepare("PRAGMA table_info(commandes_cells)").all();
if (_cc.length && !_cc.some((c) => c.name === 'kind')) {
  db.exec('DROP TABLE commandes_cells');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    color      TEXT,
    icon       TEXT,
    reset_mode TEXT NOT NULL,
    ord        INTEGER NOT NULL DEFAULT 0,
    is_active  INTEGER NOT NULL DEFAULT 1,
    category   TEXT NOT NULL DEFAULT 'general',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    title       TEXT NOT NULL,
    ord         INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    day_of_week INTEGER,
    days        TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS employees (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    template_id  TEXT NOT NULL,
    date         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'EN_COURS',
    completed_by TEXT,
    completed_at TEXT,
    created_at   TEXT NOT NULL,
    UNIQUE (template_id, date),
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS completions (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    task_id       TEXT NOT NULL,
    is_done       INTEGER NOT NULL DEFAULT 0,
    done_at       TEXT,
    original_date TEXT,
    UNIQUE (session_id, task_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_tmpl     ON tasks(template_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_date  ON sessions(date);
  CREATE INDEX IF NOT EXISTS idx_compl_session  ON completions(session_id);

  -- Grille COMMANDES (cuisine) : tableau fournisseurs × jours. Chaque case a un
  -- libellé fixe (CMD matin / LIVRAISON…) ; cocher « fait » horodate checked_at.
  -- Une case est considérée « faite » tant que checked_at a moins de 3 jours
  -- (report automatique à J+3 calculé à la lecture, pas de tâche planifiée).
  CREATE TABLE IF NOT EXISTS commandes_rows (
    id        TEXT PRIMARY KEY,
    label     TEXT NOT NULL,
    sublabel  TEXT,
    ord       INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS commandes_cells (
    id         TEXT PRIMARY KEY,
    row_id     TEXT NOT NULL,
    day        INTEGER NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'CMD',
    label      TEXT NOT NULL,
    checked_at TEXT,
    UNIQUE (row_id, day, kind),
    FOREIGN KEY (row_id) REFERENCES commandes_rows(id) ON DELETE CASCADE
  );
  -- Tableaux « Menus » (cuisine) : une cellule par date (AAAA-MM-JJ) et par
  -- emplacement (slot : e1/e2/pj1/pj2/d1/d2 pour les menus, groupe pour les
  -- groupes). Clés par DATE réelle → la « semaine pro » devient « cette semaine »
  -- automatiquement la semaine suivante, et l'historique est conservé.
  CREATE TABLE IF NOT EXISTS menu_cells (
    id         TEXT PRIMARY KEY,
    date       TEXT NOT NULL,
    slot       TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (date, slot)
  );
  -- Modèles « PPP » (commandes cuisine) : textes à trous (les « ... » sont les
  -- champs à remplir). Éditables dans l'admin PPP.
  CREATE TABLE IF NOT EXISTS ppp_templates (
    key        TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    icon       TEXT,
    body       TEXT NOT NULL,
    ord        INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

// Migration de schéma : ajoute la colonne « category » sur les bases déjà
// créées avant cette version (regroupe les check-lists par onglet : general /
// manager / bar). Idempotent (n'ajoute la colonne que si elle manque).
if (!db.prepare('PRAGMA table_info(templates)').all().some((c) => c.name === 'category')) {
  db.exec("ALTER TABLE templates ADD COLUMN category TEXT NOT NULL DEFAULT 'general'");
}
// Colonne « days » (jours d'une tâche pour le mode WEEKLY_CARRY_OVER, ex. "1,3,5").
// Si NULL, on retombe sur day_of_week (compat. tâches hebdo salle existantes).
if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'days')) {
  db.exec('ALTER TABLE tasks ADD COLUMN days TEXT');
}

const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

// --- Données initiales (livrées avec l'appli) -----------------------------
// Reprises à l'identique de l'appli check-lists d'origine.

const WEEKLY_TASKS = [
  { title: 'Ramasser mégots et nettoyage des pots de fleur', dayOfWeek: 1 },
  { title: 'Étagère bar + étagère à mule', dayOfWeek: 1 },
  { title: 'Nettoyer devanture', dayOfWeek: 1 },
  { title: 'Nettoyer corbeille à pain', dayOfWeek: 1 },
  { title: 'Décaler les banquettes et balais en dessous', dayOfWeek: 2 },
  { title: 'Nettoyage sol cave et égout', dayOfWeek: 2 },
  { title: 'Nettoyer au dessus tireuse à bière', dayOfWeek: 2 },
  { title: 'Arroser pots de fleur', dayOfWeek: 2 },
  { title: 'Remonter carton du -1', dayOfWeek: 3 },
  { title: 'Nettoyer toutes les plinthes du restaurant', dayOfWeek: 3 },
  { title: 'Faire la poussière', dayOfWeek: 3 },
  { title: 'Remplir fleur de sel, sel et poivre', dayOfWeek: 3 },
  { title: 'Nettoyer chariot côté bœuf', dayOfWeek: 4 },
  { title: 'Nettoyage pied de chaise et table', dayOfWeek: 4 },
  { title: 'Nettoyer les murs entrée et sortie de cuisine', dayOfWeek: 4 },
  { title: 'Tirer les frigos et nettoyer derrière', dayOfWeek: 4 },
  { title: 'Nettoyer mur à côté de l\'entrée', dayOfWeek: 5 },
  { title: 'Vérifier les DLC soft en déco et frigo bar', dayOfWeek: 5 },
  { title: 'Produit inox cave maturation et machine à glaçon', dayOfWeek: 5 },
  { title: 'Nettoyage vestiaire perso + toilette', dayOfWeek: 5 },
  { title: 'Décaler les banquettes et balais en dessous', dayOfWeek: 6 },
  { title: 'Nettoyer les murs de la 14 à 33 et de la 36 à 32', dayOfWeek: 6 },
  { title: 'Nettoyer les réglettes au sol entrée cuisine', dayOfWeek: 6 },
  { title: 'Arroser pots de fleur', dayOfWeek: 6 },
  { title: 'Remonter carton du -1', dayOfWeek: 7 },
  { title: 'Aspirer miettes chaises', dayOfWeek: 7 },
  { title: 'Nettoyer filtre des clims', dayOfWeek: 7 },
  { title: 'Faire l\'escalier à la brosse', dayOfWeek: 7 },
  { title: 'Aiguiser les couteaux', dayOfWeek: 7 },
];

// Onglet « CL manager ouv matin »
const MANAGER_MATIN_TASKS = [
  'Vérifier que la terrasse soit bien mise, pot de fleur chaise table',
  'Vérifier que la devanture soit propre : pas de cigarette, pas de cendre',
  'Vérifier porte et fenetre propre',
  'Vérifier cave a vin bas et haut allumées X3 petites X2 grandes, + frigo',
  'Vérifier chauffage/',
  'Prendre le téléphone',
  'Vérifier les resa tombées la nuit et le matin, rentrer et placer et fermer les créneaux',
  'Faire un tour complet du restau : banquette table bord de fenêtre sol trace de doigt sur écran et bar toilette bar prêt à accueillir les clients',
  'Lancer la caisse et verifier que tout est ok',
  'Déposer cash (mardi & samedi)',
  'Vérifier les demi pour le soir et le lendemain et poster les horaires si on a le temps',
  'Mettre les bougies à charger',
  'Vérif réception pain',
  'Verifier Resa pour le soir et les jours suivants',
  'Vérifier que les téléphones et tablettes aient de la batterie et donner le tel bis au barman',
  'Stock pour le service et menu du jour et mettre a jour les autres',
  'verif clim haut allumé si besoin',
  'Vérifier les stocks : bidon ethanol stock en cave, gel flambage, verre, couvert, serviette, carte visite, carte anniversaire, rouleau tpe etc',
  'Faire le tour du restaurant y compris réserve, vestiaire, frigo, cave, placard, et faire en sorte que cela soit niquel.',
  'Faire le tour du restaurant en détail : exemple : les plinthes qui ne sont pas faite, les coins qu’on ne voit plus, chariot à viande etc.',
];

// Onglet « CL manager Hebdo »
const MANAGER_HEBDO_TASKS = [
  'Vérifier les stocks : bidon ethanol stock en cave, gel flambage, verre, couvert, serviette, carte visite, carte anniversaire, rouleau tpe etc',
  'Faire le tour du restaurant y compris réserve, vestiaire, frigo, cave, placard, et faire en sorte que cela soit niquel.',
];

// Onglet « Brief Manager 11 45 »
const BRIEF_MANAGER_TASKS = [
  'Menu du jour / Suggestion',
  'Qui prend quel rang : à définir en fonction des forces et ensuite des envies de chacun',
  'Information sur les resa de chaque rang',
  'Rupture ou plat à pousser',
  'Vin ou cocktail du moment',
  'Traduction en anglais 1 par jour',
];

// Ouverture midi (depuis « OUVERTURE MATIN 25 » — le matin = le midi).
const OUV_MIDI_TASKS = [
  'Allumer tous les compteurs du bas',
  'Prendre le téléphone avec soi',
  'Allumer les lumières du bas, celles derrière le bar du bas, les frigos',
  'Allumer os.osseur à 12h en bas',
  'Sortir la terrasse (plante / chaise / table)',
  'Repasser un petit coup de balais et vérifier les pots de fleurs mégot etc',
  'Sortir porte menu',
  'Sortir store',
  'Ouvrir parasols',
  'Allumer mur floral',
  'Allumer chauffage (l\'hiver) et clim si besoin',
  'Ensuite à l\'étage allumer compteur',
  'Allumer cave à vin et frigo',
  'Allumer lumière bar',
  'Vérifier la batterie / charger les tablettes et les téléphones',
  'Balais',
  'Vérifier miettes chaise',
  'Balais sous les banquette et sur les pieds de chaise',
  'Balais à l\'étage derrière les portes de la 30 et dans les angles',
  'Faire les olives',
  'Mise en place bar (agrume, menthe, carafe) boîte à fleur',
  'Remonter CFP Bar',
  'Mise en place paille bar',
  'Brique de lait',
  'Vérifier et remplir boîte à thé',
  'Nettoyer bord des fenêtres',
  'Allumer musique',
  'Faire et sortir panneau PJ',
  'Allumer lave-verre du haut à 11h30',
  'Nettoyer porte d\'entrée et au-dessus de la 4',
];

// Ouverture soir (depuis « Ouverture Soir »).
const OUV_SOIR_TASKS = [
  'Allumer la musique (à la stéréo dans le placard côté sortie cuisine) et sur le téléphone',
  'Les toilettes, sous les toilettes, sous le lavabo',
  'Passer balais devant restau et entrée',
  'Prendre téléphone avec soi',
  'Allumer mur floral',
  'Allumer lumières bas, derrière bar du bas, frigos',
  'Derrière le bar, sous la machine à verre',
  'Balais sous les banquettes',
  'Nettoyer et allumer le lave-verre. Y mettre 1 bouchon de produit lave-verre',
  'Faire les olives',
  'Nettoyer porte d\'entrée (vitre/poignée/tours de porte en bois)',
  'Allumer compteurs du bas',
  'Sortir porte menu',
  'Commencer par les 30, et porte pliantes',
  'Faire la carcasse si besoin',
  'Bordure devant le restaurant, et entrée extérieur',
  'Vérifier les toilettes',
  'Nettoyer allumer le lave-verre. mettre 1 bouchon de produit lave-verre',
  'Nettoyer la devanture du bar (tous les côtés et écran caisse)',
  'Remplir carafe d\'eaux (vérifier la propreté des carafes)',
  'Vérifier et nettoyer si besoin les bords de fenêtre',
  'Allumer cave à vins, cave de service (vins rouge)',
  'Allumer tous les compteurs',
  'Préparer boite de fleurs (garnish cocktails) la laisser au frais',
  'Sortir le store',
  'Balais dans les marches, dans les angles, au pied de la rambarde',
  'Brique de lait au frais',
  'Mise en place agrumes',
  'Mettre bougies sur table',
  'Vérifier mise en place boissons chaudes',
  'Mettre les tapis aux sorties de cuisine',
  'Derrière bar, sous la machine à verre',
  'Balais devant le resto, devant la porte et sur la petite avancée le long du resto',
  'Vérifier qu\'il n\'y ait pas de miettes sur les chaises',
  'Balais en bas',
  'Vérifier propreté porte menu et gel hydro',
  'Mise en place paille petite et grandes',
  'Dresser la terrasse si besoin (T94 et T96 à toujours dresser)',
  'Faire les olives',
  'Vérifier et remplir boîte à thé',
  'Sortir bouteilles d\'alcool et soft pour service',
  'Pain',
  'Allumer porte menu',
  'Allumer chauffage/clim si besoin',
  'Vérifier et nettoyer si besoin les tables, vérifier qu\'il ne manque rien, que tout est bien aligné, propre',
  'Balais',
  'Nettoyer fenêtre entre 2 et 4',
  'Marches, dans les angles, au pied de la rambarde',
  'Vérifier la batterie / charger les tablettes et les téléphones',
];

// Fermeture midi (depuis « Fermeture midi »).
const FERM_MIDI_TASKS = [
  'Vérifier la batterie ou charger téléphone et tablette et pads',
  'Nettoyer le bar (intérieur / extérieur) et tour du bar',
  'Nettoyer les écrans des caisses',
  'Machine à café / tireuse à bière',
  'Plan de travail',
  'Faire les caves (les deux à vin, soft)',
  'Ranger la caisse cfp avec les limo et purée en chambre froide cuisine',
  'Compléter les bouteilles ouvertes',
  'Mettre au frais la caisse des purées et les agrumes',
  'Bien vider les glaçons et descendre les bacs',
  'Éteindre machines lave-verre et changer l\'eau si gros service du midi / eau sale',
  'Remplir mise en place boissons chaudes (sucre / capsule simple / double / deca). S\'assurer qu\'il y a bien des tasses à allongés, cuillères etc',
  'Remplir bocal bonbons',
  'Secouer et remonter les tapis',
  'Remonter les verres',
  'Faire miettes sur chaises, banquettes, chaises du petit salon',
  'Vérifier qu\'il ne manque rien sur les tables',
  'Si des gens ont mangé en terrasse, bien nettoyer les tables/chaises et ramasser si saletés par terre (serviettes, mégot, etc)',
  'Faire toilettes',
  'Remplir bacs à couverts haut et bas, serviettes',
  'Éteindre les lumières cave frigos et caves de service',
  'Faire carcasse pour soir si besoin (voir en fonction des resas s\'il y a des choses à prévoir, eau au frais etc)',
  'Ranger, nettoyer et couvrir coin à pain',
  'Éteindre les lumières haut et bas, la guirlande lumineuse, la sono, les clips',
  'Remettre la terrasse correctement (tables chaises plantes au bon endroit)',
  'Éteindre clim/chauffage',
  'Enlever pierre du milieu évier toilette',
  'Supprimer la check-list quand on a terminé',
];

// Fermeture soir (depuis « Ferm Soir 16 »).
const FERM_SOIR_TASKS = [
  'Remplir bacs à couverts haut et bas, serviettes',
  'Secouer et remonter les tapis',
  'Faire toilettes',
  'Remonter les verres',
  'Vérifier qu\'il ne manque rien sur les tables',
  'Si des gens ont mangé en terrasse, bien nettoyer les tables/chaises et ramasser si saletés par terre (serviettes, mégot, etc)',
  'Vérifier la batterie ou charger téléphone et tablette et pads',
  'Éteindre les lumières cave frigos et caves de service',
  'Remettre la terrasse correctement (tables chaises plantes au bon endroit)',
  'Ranger, nettoyer et couvrir coin à pain',
  'Compléter les bouteilles ouvertes',
  'Éteindre les lumières haut et bas, la guirlande lumineuse, la sono, les clips',
  'Faire carcasse pour soir si besoin (voir en fonction des resas s\'il y a des choses à prévoir, eau au frais etc)',
  'Faire miettes sur chaises, banquettes, chaises du petit salon',
  'Vérifier qu\'il y ait des serviettes en haut et en bas',
  'Éteindre clim/chauffage',
  'Descendre les caisses pour le pain',
  'Éteindre et ranger bougies',
  'Enlever pierre du milieu évier toilette',
  'Supprimer la check-list quand on a terminé',
];

// Fermeture soir — bar de l'étage (haut) — photo « Fermeture bar étage ».
const BAR_FERM_SOIR_HAUT_TASKS = [
  'Nettoyer les plans de travail',
  'Nettoyer les bouteilles',
  'Ranger les bouteilles',
  'Remplir les pipettes',
  'Faire les caves',
  'Nettoyer les tapis',
  'Nettoyer la tireuse à bière',
  'Nettoyer la machine à café',
  'Nettoyer les vitres des frigos',
  'Nettoyer sol frigo',
  'Remplir les capsules KF',
  'Pastille nettoyage machine à café',
  'Remplir stock banette KF',
  'Nettoyer lave-verre extérieur',
  'Bien nettoyer les filtres de l\'osmoseur',
  'Nettoyer l\'évier',
  'Ranger caisse CFP',
  'Remplir pots à cuillère à café',
  'Nettoyer et ranger les carafes',
  'Ranger les olives et daté',
  'Ramasser les capsules au sol',
  'Vérifier que les tablettes chargent et l\'iPhone bleu',
  'Dater les produits',
  'Nettoyer intérieur extérieur poubelle',
  'Nettoyer la tête de la buse',
  'Remplir sucre en poudre et vin blanc',
  'Remplir les pailles',
  'Vérifier les clims et éteindre',
  'Bien plier les essuies verre',
  'Nettoyer les lavettes et mettre à tremper',
  'Nettoyer les bouchons des becs verseurs',
  'Éteindre les clims tt les soirs',
  'Mettre tablette en veille et débrancher chargeur le soir',
  'Faire la check-liste iPad — important !',
  'Faire le transfert des vins haut et bas',
];

// Fermeture soir — bar du bas — photo « Fermeture bas ».
const BAR_FERM_SOIR_BAS_TASKS = [
  'Faire les caves du bas et étage',
  'Nettoyer porte + poubelle intérieur/extérieur',
  'Compléter les vins (en été)',
  'Faire les caves étages',
  'Ranger les olives et les dater',
  'Nettoyer la tireuse à bière',
  'Nettoyer la machine à café',
  'Pastille nettoyage machine à café',
  'Remplir les capsules KF',
  'Ramasser les capsules au sol',
  'Remplir pots à cuillère à café',
  'Nettoyer sol frigo',
  'Nettoyer les vitres des frigos',
  'Nettoyer lave-verre intérieur/extérieur',
  'Bien nettoyer les filtres du lave-verre',
  'Laisser ouvert le lave-verre',
  'Nettoyer l\'évier',
  'Nettoyer et ranger les carafes',
  'Nettoyer les cendriers et ranger (l\'été)',
  'Dater les produits',
  'Remplir les pailles',
  'Descendre des couverts',
  'Serviette à remettre en stock',
  'Remonter les verres',
  'Enlever les tapis',
  'Ranger terrasse',
  'Balais terrasse',
  'Nettoyer les plans de travail',
  'Bien plier les essuies verre',
  'Nettoyer les lavettes et mettre à tremper',
  'Ranger caisse CFP sur le bar',
  'Remettre des bonbons',
  'Enlever les caisses devant le congel bas',
  'Remonter caisse + tablette',
  'Sortir bouteilles vins rouge frigo',
  'Attacher les parasols',
  'Débrancher tablette → brancher iPhone',
];

// Ménage de service hebdo (depuis « Ménage Max » — reset chaque lundi 8h).
const MENAGE_HEBDO_TASKS = [
  'Nettoyer les pieds de chaise + pied des tables avec lavette propre et chaude',
  'Passer le balais sous les banquettes et les nettoyer avec une lavette propre et chaude',
  'Aspirer l\'intérieur des chaises avec l\'aspirateur dyson qui se trouve dans les toilettes du perso',
  'Arroser les plantes avec l\'arrosoir (1/2 arrosoir parts pot de fleurs eau froide)',
  'Prendre gant en latex et sac poubelle, enlever toutes les saletés se trouvant dans les pots de fleurs',
  'Nettoyer l\'extérieur des pots de fleurs avec lavette chaude ainsi que les vitres des deux côtés avec sopalin et produit bleu',
  'Nettoyer le sol de la cave consigne (balais toile) mais avant décaler les caisses et les re-ranger comme il faut après',
  'Nettoyer le sol du rez-de-chaussée (balais toile), rien qui traîne au sol ; passer le balais et la toile ainsi que l\'égout à la brosse à dent et à l\'arrosoir eau très chaude',
  'Nettoyer les étagères du bar avec un sopalin et produit bleu de haut en bas',
  'Nettoyer avec une lavette chaude sous l\'évier du bar',
  'Nettoyer petite étagère à côté de l\'évier (carafe, verre à mule)',
  'Nettoyer les frigos bar intérieur (sol/porte) et extérieur (porte)',
  'Nettoyer toutes les carafes de vin avec gros sel et eau chaude',
  'Faire la marche en avant des frigos bar haut et bas',
  'Remonter les cartons si liste de cave donné en amont & les ranger',
  'Refaire carte des boissons et cartes anglaises si en stocks',
  'Faire toutes les plantes du restaurant avec une lavette chaude savonneuse',
  'Faire les toilettes clients, sol à la brosse, mur avec sopalin et produit bleu sinon lavette jetable avec produit bleu',
  'Faire devanture du restaurant moulure, rail en acier et porte avec eau chaude, savon et lavette',
  'Nettoyer tous les mercredis les toilettes du perso et vestiaire sol (balais/toile), toilette produit alcool ménagé produit bleu et sopalin',
  'Nettoyer les filtres des ventilations avec le mini souffleur qui se trouve au bar',
  'Nettoyer les étagères du bar du bas avec sopalin/lavette et produit bleu de haut en bas',
  'Nettoyer les moulures et les plinthes du bas',
  'Faire les poussières (décoration / têtes de vaches / cadres / cheminée / jar de fleurs artificielles)',
];

// --- Check-lists CUISINE (page dédiée) — d'après les photos fournies. --------
// Reset quotidien par défaut (ajustable ensuite via l'Admin).
const CUISINE_PLANCHA_TASKS = [
  'Plancha propre + tiroir',
  'Carter de plancha propre',
  'Mur derrière plancha',
  'Brûleur et grille',
  'Rangement sous plancha et sous piano',
  'Mur derrière brûleur',
  'Grilles de hottes',
  'Poubelle',
  'Pieds de plan de travail',
  'Sol sous friteuse et plancha',
  'Étagère assiettes propre',
  'Frigo tour chaud et extérieur + plan de travail',
  'Tiroir datés filmé et papiers bouchers',
  'Intérieur frigo propre et tiroir propre',
  'Sol sous frigo centrale propre',
  'Ranger chaque étage et faire FIFO',
  'Dater, filmer et nommer chaque bac',
  'Viande sous viande ou écrire sur le tableau',
  'Mettre sur tableau et WhatsApp les viandes à pousser',
  'Pain burger rangé',
  'CF du bas rangé et FIFO vérifié',
  'Sol CF du bas fait ou noter à faire',
  'Nettoyer passe et sous le passe',
  'Hélices moteur',
  'Donner couvert à la salle',
  'Mise en place',
  'Sortir grosse pièce',
];

const CUISINE_GARNITURE_TASKS = [
  'Bain-marie : eau propre ou vidée et lavée',
  'Sauces mises en bac transparent en cellule',
  'Feuille de remise au froid remplie (cellule)',
  'Friteuse huile propre ou vidée',
  'Mur côté garniture',
  'Extérieur four chaud',
  'Chauffe-assiettes intérieur/extérieur',
  'Sol sous chaud (piano, friteuse, plancha)',
  'Étagère assiettes propre',
  'Sur frigo tour chaud et extérieur',
  'Tour datés filmé et papiers bouchers',
  'Intérieur frigo propre et tiroir propre',
  'Sol sous frigo centrale propre',
  'Ranger chaque étage, datés filmé, rien au sol',
  'Micro-onde propre',
  'Étagère micro-onde propre',
  'Sol sous étagère micro-onde',
  'Hélices moteur',
  'Donner couvert à la salle',
  'Mise en place',
];

const CUISINE_FERM_FROID_TASKS = [
  'Tiroir',
  'Datés filmé, pipette nettoyée filmée',
  'Autour des assiettes',
  'Changer bac sous les poches à douilles',
  'Mur derrière tour froid',
  'Plinthe derrière tour froid',
  'Four du froid',
  'Extérieur tour froid (dessus, dessous, autour)',
  'Miettes de pain autour des plaques gastro',
  'Sous tour froid bien raclé',
  'Congélateur à glace couvercle propre',
  'Congélateur à glace pot fermé et mis en place fermé',
  'Étagère assiettes propre',
  'Échelle bâchée et bâche propre',
  'Sol sous échelle propre',
  'Côté froid rangé datés filmé',
  'Mise en place sous micro-onde filmé',
  'Chauffe pipette vidé lavé',
  'Petite friteuse éteinte',
  'Frigo et CF allumé',
  'Economa : mise en place couverte',
  'Mise en place dans Economa (DLC)',
];

// Ménage hebdo cuisine (photo IMG_1748) — mode WEEKLY_CARRY_OVER : chaque jour
// affiche les tâches programmées CE jour (cases colorées) + le report des tâches
// non faites les jours précédents. days = jours programmés ("1"=lundi … "7"=dim).
// Estimation depuis la photo (cases colorées) — à AJUSTER dans l'éditeur cuisine.
const CUISINE_MENAGE_HEBDO_TASKS = [
  { title: 'Intérieur hotte', days: '1' },
  { title: 'Ranger CF viande', days: '1,2,3,5,6' },
  { title: 'Chambre froide du bas', days: '1,3,5,6' },
  { title: 'Légumerie et sol', days: '1,3,5' },
  { title: 'Chambre froide du haut', days: '3,5,7' },
  { title: 'Local poubelle', days: '1,4' },
  { title: 'Poussière moteur des tours', days: '5' },
  { title: 'Grilles de hottes', days: '1,2,3,4,5,6,7' },
  { title: 'Coffre de la hotte', days: '6' },
  { title: 'Moteur de la chambre froide', days: '1' },
];

// Les 4 anciennes check-lists d'exemple (Ouverture, Fermeture, Nettoyage,
// Inventaire) ont été retirées : plus créées sur une base neuve, et désactivées
// sur les bases existantes (migration 3).
const DEFAULT_TEMPLATES = [];

function insertTemplate(t) {
  const id = uid();
  db.prepare('INSERT INTO templates(id,name,type,color,icon,reset_mode,ord,is_active,category,created_at) VALUES(?,?,?,?,?,?,?,1,?,?)')
    .run(id, t.name, t.type, t.color, t.icon, t.resetMode, t.order, t.category || 'general', nowISO());
  return id;
}
function insertTask(templateId, title, order, dayOfWeek, days) {
  db.prepare('INSERT INTO tasks(id,template_id,title,ord,is_active,day_of_week,days,created_at) VALUES(?,?,?,?,1,?,?,?)')
    .run(uid(), templateId, title, order, dayOfWeek ?? null, days ?? null, nowISO());
}

function ensureTemplateByType(type, build) {
  const exists = db.prepare('SELECT id FROM templates WHERE type = ?').get(type);
  if (exists) return;
  build();
}

// Version de schéma/migrations appliquée à cette base (PRAGMA user_version).
const SCHEMA_VERSION = 13;

function seedAndMigrate() {
  const count = db.prepare('SELECT COUNT(*) c FROM templates').get().c;
  const freshDb = count === 0;

  if (freshDb) {
    for (const t of DEFAULT_TEMPLATES) {
      const id = insertTemplate(t);
      t.tasks.forEach((title, i) => insertTask(id, title, i + 1));
    }
    if (db.prepare('SELECT COUNT(*) c FROM employees').get().c === 0) {
      for (const name of ['Manager', 'Chef de rang', 'Serveur(se)', 'Cuisinier(e)']) {
        db.prepare('INSERT INTO employees(id,name,is_active) VALUES(?,?,1)').run(uid(), name);
      }
    }
  }

  // Idempotent : crée les check-lists manquantes (sur base neuve ET sur base
  // existante au prochain démarrage). Ne touche jamais une check-list déjà là.
  ensureTemplateByType('HEBDOMADAIRE', () => {
    const id = insertTemplate({ name: 'Tâches hebdo salle', type: 'HEBDOMADAIRE', color: 'bg-purple-500', icon: '📅', resetMode: 'WEEKLY_CARRY_OVER', order: 11 });
    WEEKLY_TASKS.forEach((t, i) => insertTask(id, t.title, i + 1, t.dayOfWeek));
  });
  ensureTemplateByType('MANAGER_MATIN', () => {
    const id = insertTemplate({ name: 'Check Manager Matin', type: 'MANAGER_MATIN', color: 'bg-red-600', icon: '👔', resetMode: 'AUTO_DAILY', order: 6, category: 'manager' });
    MANAGER_MATIN_TASKS.forEach((title, i) => insertTask(id, title, i + 1));
  });
  ensureTemplateByType('MANAGER_HEBDO', () => {
    const id = insertTemplate({ name: 'Manager Hebdo', type: 'MANAGER_HEBDO', color: 'bg-purple-500', icon: '🗓️', resetMode: 'AUTO_DAILY', order: 7, category: 'manager' });
    MANAGER_HEBDO_TASKS.forEach((title, i) => insertTask(id, title, i + 1));
  });
  ensureTemplateByType('BRIEF_MANAGER', () => {
    const id = insertTemplate({ name: 'Brief Manager', type: 'BRIEF_MANAGER', color: 'bg-rose-600', icon: '🗣️', resetMode: 'AUTO_DAILY', order: 8, category: 'manager' });
    BRIEF_MANAGER_TASKS.forEach((title, i) => insertTask(id, title, i + 1));
  });
  // Nouvelles check-lists de service (onglet « Check-lists »), créées vides :
  // les tâches sont à ajouter ensuite via l'Admin.
  ensureTemplateByType('OUV_MIDI', () => { const id = insertTemplate({ name: 'Ouverture midi Bas', type: 'OUV_MIDI', color: 'bg-amber-400', icon: '☀️', resetMode: 'AUTO_DAILY', order: 1, category: 'general' }); OUV_MIDI_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('OUV_MIDI_HAUT', () => { const id = insertTemplate({ name: 'Ouverture midi Haut', type: 'OUV_MIDI_HAUT', color: 'bg-amber-400', icon: '☀️', resetMode: 'AUTO_DAILY', order: 2, category: 'general' }); OUV_MIDI_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('FERM_MIDI', () => { const id = insertTemplate({ name: 'Fermeture midi Bas', type: 'FERM_MIDI', color: 'bg-amber-600', icon: '🍽️', resetMode: 'AUTO_DAILY', order: 3, category: 'general' }); FERM_MIDI_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('FERM_MIDI_HAUT', () => { const id = insertTemplate({ name: 'Fermeture midi Haut', type: 'FERM_MIDI_HAUT', color: 'bg-amber-600', icon: '🍽️', resetMode: 'AUTO_DAILY', order: 4, category: 'general' }); FERM_MIDI_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('OUV_SOIR', () => { const id = insertTemplate({ name: 'Ouverture soir Bas', type: 'OUV_SOIR', color: 'bg-indigo-400', icon: '🌆', resetMode: 'AUTO_DAILY', order: 5, category: 'general' }); OUV_SOIR_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('OUV_SOIR_HAUT', () => { const id = insertTemplate({ name: 'Ouverture soir Haut', type: 'OUV_SOIR_HAUT', color: 'bg-indigo-400', icon: '🌆', resetMode: 'AUTO_DAILY', order: 6, category: 'general' }); OUV_SOIR_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('FERM_SOIR', () => { const id = insertTemplate({ name: 'Fermeture soir Bas', type: 'FERM_SOIR', color: 'bg-indigo-600', icon: '🌃', resetMode: 'AUTO_DAILY', order: 7, category: 'general' }); FERM_SOIR_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('FERM_SOIR_HAUT', () => { const id = insertTemplate({ name: 'Fermeture soir Haut', type: 'FERM_SOIR_HAUT', color: 'bg-indigo-600', icon: '🌃', resetMode: 'AUTO_DAILY', order: 8, category: 'general' }); FERM_SOIR_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  // Fermeture soir bar (bas + haut) — intégrées à l'onglet « Check-lists »
  // (catégorie general, bloc Soir). Les « Fermeture midi bar » ont été supprimées.
  ensureTemplateByType('BAR_FERM_SOIR_BAS', () => { const id = insertTemplate({ name: 'Fermeture soir bar du bas', type: 'BAR_FERM_SOIR_BAS', color: 'bg-rose-700', icon: '🍺', resetMode: 'AUTO_DAILY', order: 9, category: 'general' }); BAR_FERM_SOIR_BAS_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('BAR_FERM_SOIR_HAUT', () => { const id = insertTemplate({ name: 'Fermeture soir bar du haut', type: 'BAR_FERM_SOIR_HAUT', color: 'bg-rose-700', icon: '🍷', resetMode: 'AUTO_DAILY', order: 10, category: 'general' }); BAR_FERM_SOIR_HAUT_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  // Ménage de service hebdo — onglet « Check-lists », reset chaque lundi 8h.
  ensureTemplateByType('MENAGE_HEBDO', () => { const id = insertTemplate({ name: 'Ménage de service hebdo', type: 'MENAGE_HEBDO', color: 'bg-teal-500', icon: '🧽', resetMode: 'WEEKLY_MONDAY', order: 12, category: 'general' }); MENAGE_HEBDO_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  // Check-lists CUISINE (page dédiée, catégorie « cuisine »), reset quotidien.
  ensureTemplateByType('CUISINE_PLANCHA', () => { const id = insertTemplate({ name: 'Plancha', type: 'CUISINE_PLANCHA', color: 'bg-orange-600', icon: '🔥', resetMode: 'AUTO_DAILY', order: 1, category: 'cuisine' }); CUISINE_PLANCHA_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('CUISINE_GARNITURE', () => { const id = insertTemplate({ name: 'Poste garniture', type: 'CUISINE_GARNITURE', color: 'bg-green-600', icon: '🥗', resetMode: 'AUTO_DAILY', order: 2, category: 'cuisine' }); CUISINE_GARNITURE_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('CUISINE_FERM_FROID', () => { const id = insertTemplate({ name: 'Fermeture du froid', type: 'CUISINE_FERM_FROID', color: 'bg-sky-600', icon: '❄️', resetMode: 'AUTO_DAILY', order: 3, category: 'cuisine' }); CUISINE_FERM_FROID_TASKS.forEach((t, i) => insertTask(id, t, i + 1)); });
  ensureTemplateByType('CUISINE_MENAGE_HEBDO', () => { const id = insertTemplate({ name: 'Ménage hebdo cuisine', type: 'CUISINE_MENAGE_HEBDO', color: 'bg-teal-500', icon: '🧽', resetMode: 'WEEKLY_CARRY_OVER', order: 4, category: 'cuisine' }); CUISINE_MENAGE_HEBDO_TASKS.forEach((t, i) => insertTask(id, t.title, i + 1, null, t.days)); });
  // Check-lists « Responsable cuisine » (catégorie resp_cuisine), créées vides :
  // les tâches sont à ajouter via l'admin responsable cuisine.
  ensureTemplateByType('RESP_MENAGE', () => insertTemplate({ name: 'Ménage', type: 'RESP_MENAGE', color: 'bg-teal-500', icon: '🧽', resetMode: 'AUTO_DAILY', order: 1, category: 'resp_cuisine' }));
  ensureTemplateByType('RESP_COMMANDE', () => insertTemplate({ name: 'Commande', type: 'RESP_COMMANDE', color: 'bg-amber-600', icon: '📦', resetMode: 'AUTO_DAILY', order: 2, category: 'resp_cuisine' }));
  ensureTemplateByType('RESP_HYGIENE', () => insertTemplate({ name: 'Hygiène', type: 'RESP_HYGIENE', color: 'bg-sky-600', icon: '🧼', resetMode: 'AUTO_DAILY', order: 3, category: 'resp_cuisine' }));

  // Migration 1 : remplacer les tâches de « Check Manager Matin » par celles de
  // l'onglet « CL manager ouv matin ». Uniquement sur une base DÉJÀ existante
  // (sur base neuve, le seed ci-dessus a déjà mis les bonnes tâches). On ne
  // SUPPRIME pas : on désactive les anciennes (l'historique des sessions reste
  // intact) puis on insère les nouvelles. Exécutée une seule fois (user_version).
  const version = db.pragma('user_version', { simple: true });
  if (version < 1 && !freshDb) {
    const mm = db.prepare("SELECT id FROM templates WHERE type = 'MANAGER_MATIN'").get();
    if (mm) {
      db.prepare('UPDATE tasks SET is_active = 0 WHERE template_id = ? AND is_active = 1').run(mm.id);
      MANAGER_MATIN_TASKS.forEach((title, i) => insertTask(mm.id, title, i + 1));
    }
  }
  // Migration 2 : ranger les check-lists manager dans l'onglet « Manager »
  // (sur base existante, la colonne category vient d'être ajoutée à 'general').
  if (version < 2 && !freshDb) {
    db.prepare("UPDATE templates SET category = 'manager' WHERE type IN ('MANAGER_MATIN','MANAGER_HEBDO','BRIEF_MANAGER')").run();
  }
  // Migration 3 : retirer les 4 check-lists d'exemple (Ouverture, Fermeture,
  // Nettoyage, Inventaire). Désactivées (is_active=0) → elles disparaissent de
  // l'app ; l'historique éventuel reste en base. Réversible (réactivable).
  if (version < 3 && !freshDb) {
    db.prepare("UPDATE templates SET is_active = 0 WHERE type IN ('OUVERTURE','FERMETURE','NETTOYAGE','INVENTAIRE')").run();
  }
  // Migration 4 : ordre de l'onglet « Check-lists » (service) →
  // Ouverture midi, Fermeture midi, Ouverture soir, Fermeture soir, Tâches hebdo.
  if (version < 4 && !freshDb) {
    const setOrd = db.prepare('UPDATE templates SET ord = ? WHERE type = ?');
    setOrd.run(1, 'OUV_MIDI');
    setOrd.run(2, 'FERM_MIDI');
    setOrd.run(3, 'OUV_SOIR');
    setOrd.run(4, 'FERM_SOIR');
    setOrd.run(5, 'HEBDOMADAIRE');
  }
  // Migration 5 : remplir les check-lists de service (ouverture/fermeture
  // midi & soir) avec les tâches issues des rappels iCloud. Sur base existante
  // ces check-lists étaient vides. On désactive l'éventuel contenu actuel puis
  // on insère les tâches (remplacement). Une seule fois.
  if (version < 5 && !freshDb) {
    const fill = (type, tasks) => {
      const t = db.prepare('SELECT id FROM templates WHERE type = ?').get(type);
      if (!t) return;
      db.prepare('UPDATE tasks SET is_active = 0 WHERE template_id = ? AND is_active = 1').run(t.id);
      tasks.forEach((title, i) => insertTask(t.id, title, i + 1));
    };
    fill('OUV_MIDI', OUV_MIDI_TASKS);
    fill('OUV_SOIR', OUV_SOIR_TASKS);
    fill('FERM_MIDI', FERM_MIDI_TASKS);
    fill('FERM_SOIR', FERM_SOIR_TASKS);
  }
  // Migration 6 : remplir les fermetures SOIR du bar (haut = étage, bas) avec
  // les tâches des photos. (« Ménage de service hebdo » est créé par
  // ensureTemplateByType ci-dessus, idempotent — pas besoin ici.)
  if (version < 6 && !freshDb) {
    const fill = (type, tasks) => {
      const t = db.prepare('SELECT id FROM templates WHERE type = ?').get(type);
      if (!t) return;
      db.prepare('UPDATE tasks SET is_active = 0 WHERE template_id = ? AND is_active = 1').run(t.id);
      tasks.forEach((title, i) => insertTask(t.id, title, i + 1));
    };
    fill('BAR_FERM_SOIR_HAUT', BAR_FERM_SOIR_HAUT_TASKS);
    fill('BAR_FERM_SOIR_BAS', BAR_FERM_SOIR_BAS_TASKS);
  }
  // Migration 10 : dédoubler Fermeture midi/soir (salle) en Bas + Haut. Sur base
  // existante, l'ancienne « Fermeture midi/soir » est RENOMMÉE en « … Bas » (garde
  // son historique) ; les versions « … Haut » sont créées par ensureTemplateByType
  // ci-dessus. On réordonne aussi l'onglet général.
  if (version < 10 && !freshDb) {
    db.prepare("UPDATE templates SET name = 'Fermeture midi Bas' WHERE type = 'FERM_MIDI'").run();
    db.prepare("UPDATE templates SET name = 'Fermeture soir Bas' WHERE type = 'FERM_SOIR'").run();
    const setOrd = db.prepare('UPDATE templates SET ord = ? WHERE type = ?');
    setOrd.run(1, 'OUV_MIDI');
    setOrd.run(2, 'FERM_MIDI');
    setOrd.run(4, 'OUV_SOIR');
    setOrd.run(5, 'FERM_SOIR');
    setOrd.run(7, 'HEBDOMADAIRE');
    setOrd.run(8, 'MENAGE_HEBDO');
    // FERM_MIDI_HAUT (ord 3) et FERM_SOIR_HAUT (ord 6) reçoivent leur ordre à la
    // création via ensureTemplateByType.
  }
  // Migration 11 : dédoubler Ouverture midi (salle) en Bas + Haut. Sur base
  // existante, l'ancienne « Ouverture midi » est RENOMMÉE en « Ouverture midi Bas »
  // (garde son historique) ; « Ouverture midi Haut » est créée par
  // ensureTemplateByType ci-dessus. On réordonne l'onglet général.
  if (version < 11 && !freshDb) {
    db.prepare("UPDATE templates SET name = 'Ouverture midi Bas' WHERE type = 'OUV_MIDI'").run();
    const setOrd = db.prepare('UPDATE templates SET ord = ? WHERE type = ?');
    setOrd.run(1, 'OUV_MIDI');
    setOrd.run(3, 'FERM_MIDI');
    setOrd.run(4, 'FERM_MIDI_HAUT');
    setOrd.run(5, 'OUV_SOIR');
    setOrd.run(6, 'FERM_SOIR');
    setOrd.run(7, 'FERM_SOIR_HAUT');
    setOrd.run(8, 'HEBDOMADAIRE');
    setOrd.run(9, 'MENAGE_HEBDO');
    // OUV_MIDI_HAUT (ord 2) reçoit son ordre à la création via ensureTemplateByType.
  }
  // Migration 12 : dédoubler Ouverture soir (salle) en Bas + Haut. Sur base
  // existante, l'ancienne « Ouverture soir » est RENOMMÉE en « Ouverture soir Bas »
  // (garde son historique) ; « Ouverture soir Haut » est créée par
  // ensureTemplateByType ci-dessus. On réordonne l'onglet général.
  if (version < 12 && !freshDb) {
    db.prepare("UPDATE templates SET name = 'Ouverture soir Bas' WHERE type = 'OUV_SOIR'").run();
    const setOrd = db.prepare('UPDATE templates SET ord = ? WHERE type = ?');
    setOrd.run(5, 'OUV_SOIR');
    setOrd.run(7, 'FERM_SOIR');
    setOrd.run(8, 'FERM_SOIR_HAUT');
    setOrd.run(9, 'HEBDOMADAIRE');
    setOrd.run(10, 'MENAGE_HEBDO');
    // OUV_SOIR_HAUT (ord 6) reçoit son ordre à la création via ensureTemplateByType.
  }
  // Migration 13 : suppression des « Fermeture midi bar » et intégration des
  // « Fermeture soir bar » dans l'onglet « Check-lists » (bloc Soir). L'onglet Bar
  // disparaît. Sur base existante : on désactive les midi bar (historique conservé)
  // et on bascule les soir bar en catégorie general avec un ordre dans le bloc Soir.
  if (version < 13 && !freshDb) {
    db.prepare("UPDATE templates SET is_active = 0 WHERE type IN ('BAR_FERM_MIDI_HAUT','BAR_FERM_MIDI_BAS')").run();
    const setCatOrd = db.prepare("UPDATE templates SET category = 'general', ord = ? WHERE type = ?");
    setCatOrd.run(9, 'BAR_FERM_SOIR_BAS');
    setCatOrd.run(10, 'BAR_FERM_SOIR_HAUT');
    const setOrd = db.prepare('UPDATE templates SET ord = ? WHERE type = ?');
    setOrd.run(11, 'HEBDOMADAIRE');
    setOrd.run(12, 'MENAGE_HEBDO');
  }
  db.pragma('user_version = ' + SCHEMA_VERSION);
}

seedAndMigrate();

// Seed des fournisseurs de la grille COMMANDES (photo IMG_1747). Idempotent :
// uniquement si la table est vide (ne réécrase jamais des modifs faites ensuite
// via l'éditeur). Les cases (CMD/LIVRAISON par jour) sont à remplir/corriger
// dans l'éditeur — la photo était trop dense pour une transcription fiable.
const COMMANDES_FOURNISSEURS = [
  ['Viande Chaiseronne', 'Répondeur / tél 02 33 48 12 77'],
  ['Lesage', 'Argentine/USA/wagyu/végé — SMS 06 71 37 25 93'],
  ['Crèmerie Prodelis (Séverine)', 'SMS photo — 06 51 24 85 07'],
  ['Proapro (Julien Fauchon)', 'SMS photo — 06 22 03 34 88'],
  ['Sysco (Julien)', 'SMS photo avec validation'],
  ['Transgourmet Viandes', 'Appel 11h Nathalie — 02 28 09 17 51'],
  ['Transgourmet Viande', 'Appel 11h Linda'],
  ['Metro', 'Livraison — Application'],
  ['Roda', 'SMS photo — 06 81 05 79 55 (Stéphane)'],
  ['Sec / Good épices (Yves)', 'SMS photo — 07 62 18 25 25'],
  ['Entretien Blot (Ricardo)', 'SMS photo — 06 99 61 11 48'],
  ['Burger (Brioche Dorée)', 'SMS WhatsApp — pb quali 06 32 80 42 80'],
  ['Poisson Reynaud', 'Répondeur 02 31 83 03 14'],
  ['Pomme de terre (Manu)', 'SMS — 06 68 05 28 04'],
  ['France Boisson', 'Tél 02 31 71 23 44 — Hugo 06 31 59 44 70'],
  ['Poisson Barfleur (dépannage)', 'Répondeur 02 31 83 03 14'],
];
if (db.prepare('SELECT COUNT(*) c FROM commandes_rows').get().c === 0) {
  const insRow = db.prepare('INSERT INTO commandes_rows(id,label,sublabel,ord,is_active,created_at) VALUES(?,?,?,?,1,?)');
  COMMANDES_FOURNISSEURS.forEach((f, i) => insRow.run(uid(), f[0], f[1], i + 1, nowISO()));
}

// Modèles PPP par défaut (les « ... » = champs à remplir avant de générer/copier).
const PPP_DEFAULTS = [
  ['poisson', 'Poisson', '🐟', "Bonjour c'est le restaurant Bœuf & Cow, pour demain il nous faudrait :\n... filet de saumon\n... filet de thon\nAutres : ...\nMerci, bon courage"],
  ['pain', 'Pain', '🥖', "Bonjour c'est le restaurant Bœuf & Cow, pour demain il nous faudrait :\nTraditions : ...\nPains Burgers : ...\nAutres : ...\nMerci, bon courage"],
  ['patate', 'Patate', '🥔', "Bonjour c'est le restaurant Bœuf & Cow, pour demain il nous faudrait :\n... sacs de frites\n... sacs de patates\nMerci, bon courage"],
];
if (db.prepare('SELECT COUNT(*) c FROM ppp_templates').get().c === 0) {
  const insPpp = db.prepare('INSERT INTO ppp_templates(key,label,icon,body,ord,updated_at) VALUES(?,?,?,?,?,?)');
  PPP_DEFAULTS.forEach((p, i) => insPpp.run(p[0], p[1], p[2], p[3], i + 1, nowISO()));
}

module.exports = { db, uid, nowISO, DB_PATH };

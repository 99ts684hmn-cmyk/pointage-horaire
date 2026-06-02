# ⏱ Pointage horaire

Application web de pointage horaire pour petite entreprise (< 20 salariés).
Chaque employé pointe son arrivée et son départ en sélectionnant simplement son nom
(le code PIN a été retiré). Un espace **administrateur** permet de gérer les employés,
consulter les heures et exporter pour la paie.

Tout est autonome : **Node.js + SQLite**, aucune base de données ou service externe à installer.

## Lancement

```bash
cd pointage-horaire
npm install      # à faire une seule fois
npm start
```

Puis ouvrez dans le navigateur :

- **Écran de pointage** : http://localhost:3000/
- **Administration** : http://localhost:3000/admin.html

## Accès

- **Écran de pointage** : ouvert à tous, sans code (les salariés sélectionnent leur nom).
- **Administration** : protégée par mot de passe (`admin123` par défaut — à changer dans
  la section « Sécurité »).

## Fonctionnement du pointage

1. L'employé touche sa carte (son nom) sur l'écran de pointage.
2. Selon son état :
   - **Absent** → il saisit son **heure d'arrivée** (date + heure, dans le passé *ou* le futur). Il devient présent.
   - **Présent** → il saisit son **heure de départ** (date + heure, dans le passé *ou* le futur). La période se ferme.
3. Une pause déjeuner se traduit simplement par un départ puis une nouvelle arrivée.

La seule contrainte de cohérence : l'heure de départ doit être postérieure à l'heure d'arrivée.

### Modifier un pointage

Depuis l'écran de pointage (nom → bouton « Modifier mes pointages »), l'employé peut
corriger ses pointages des 30 derniers jours. **Un pointage de plus de 7 jours est verrouillé**
et ne peut plus être modifié.

Le temps travaillé d'une journée est la somme des périodes, **moins les pauses obligatoires**
(voir ci-dessous).

### Travail de nuit (journée de travail)

Les heures effectuées **après minuit** sont comptabilisées sur le **jour de l'arrivée** (la veille).
Concrètement, tout pointage commencé **avant 5h du matin** est rattaché à la journée de travail
de la veille. Cette heure de bascule est réglable via la constante `DAY_CUTOFF_HOUR` dans `server.js`
(5 par défaut, sans risque puisque les arrivées commencent à 9h30).

## Pauses obligatoires (déduction automatique)

Deux créneaux de pause sont **déduits automatiquement** du temps de travail
lorsque le salarié est **présent (pointé)** pendant la plage :

- **11h15 – 11h45** (30 min)
- **18h15 – 18h45** (30 min)

La déduction ne s'applique qu'à la part réellement travaillée du créneau : si le salarié
a déjà pointé une pause manuelle pendant ce créneau, rien n'est déduit en double.

Ces créneaux sont **modifiables** dans l'Administration (section « Pauses obligatoires »).
Le rapport et l'export CSV affichent le détail : **durée brute**, **pause déduite**, **durée nette**.

## Données

- Toutes les données sont stockées dans le fichier `data.db` (SQLite) à la racine du projet.
- **Sauvegarde** : il suffit de copier `data.db` (ainsi que `data.db-wal` / `data.db-shm` s'ils existent).

## Configuration (optionnel)

Variables d'environnement :

- `PORT` — port d'écoute (défaut : `3000`)
- `DB_PATH` — chemin du fichier de base de données (défaut : `./data.db`)
- `ETABLISSEMENT` — nom du site affiché dans l'interface (vide par défaut)

```bash
PORT=8080 npm start
```

## Plusieurs établissements (option A)

Chaque établissement = **une instance indépendante** de l'application, avec sa
**propre base** et son **propre nom**. Aucune donnée n'est mélangée entre les sites.

Pour lancer un second site, on démarre l'appli avec un autre port, une autre base
et un nom d'établissement :

```bash
# Site principal (par défaut)
npm start

# Second établissement (port et base distincts)
ETABLISSEMENT="Restaurant Lyon" PORT=3001 DB_PATH=./data-lyon.db npm start
```

Le nom saisi dans `ETABLISSEMENT` s'affiche en haut de l'écran de pointage et de
l'administration, pour ne pas confondre les sites. Chaque base (`data.db`,
`data-lyon.db`, …) est sauvegardée séparément.

## Héberger sur le réseau de l'entreprise

L'application écoute sur toutes les interfaces : depuis un autre poste du réseau local,
accédez-y via `http://IP-DU-SERVEUR:3000/`. Pour un usage sur Internet, placez-la
derrière un reverse-proxy avec HTTPS (nginx, Caddy…).

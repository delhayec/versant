# Harnais de non-régression

Filet de sécurité du chantier multi-ligues (livrable L00 du plan de migration).
Il vérifie qu'une modification du code ne change **aucun** résultat de jeu : classements, couronnes, points annuels, `seasonsPlayed` et résultat des prochains gels.

Le principe :
1. Une **fixture**, copie figée et anonymisée des données de prod, sert d'entrée unique.
2. On calcule une **capture de référence** avec le code d'avant toute modification.
3. Après chaque livrable, on recalcule sur la **même** fixture et on compare. La moindre différence fait échouer le test.

On compare toujours le code d'avant et le code d'après sur des entrées identiques. On ne compare jamais un recalcul aux données figées d'origine : les règles ont changé entre les saisons, et l'embuscade est aléatoire.

## Ce qui est vérifié

**Partie A — moteur front** (`lib/front.mjs`)

`public/js/config.js`, `jokers.js` et `standings-engine.js` sont chargés dans Node sans aucune modification, à une date figée. Le harnais reproduit le chargement d'`app.js`, puis calcule :

- le classement annuel et le classement général affiché (`renderFinalStandings`) ;
- le classement du round en cours, avec jokers et handicap, et la jauge en direct ;
- pour chaque saison : simulation des éliminations, points, rescapé, jauge, challenge des éliminés figé, calendrier ;
- le graphe « Évolution des points » de la page stats, avec un classement à la fin de chaque saison.

Le calcul est fait à deux dates : `capturedAt`, l'instant de la sauvegarde, et `lastFrozenEnd`, la fin du dernier round figé.

**Partie B — gel côté serveur** (`lib/back.mjs`)

Le code de `backend/` est copié dans un dossier temporaire avec la fixture, puis exécuté :

- regel de chaque round figé, isolément, dans une copie neuve des données ;
- regel du challenge des éliminés de chaque saison terminée ;
- les deux prochains gels nocturnes (`autoFreezeCompletedRounds`).

Les effets de bord sur `bonuses.json` et `pending_bonus_choices.json` sont aussi comparés.

**Partie C — API du serveur** (`lib/api.mjs`)

Le vrai `backend/server.js` est démarré sur une copie de la fixture, en mode bac à sable (livrable L01) :
- `VERSANT_DATA_DIR` pointe sur la copie ;
- `VERSANT_DISABLE_JOBS=1` coupe les tâches planifiées et le rattrapage du gel ;
- `STRAVA_API_BASE` pointe un **faux Strava local** ;
- `OPEN_METEO_URL` pointe une adresse injoignable.

Le serveur est lancé depuis le dossier du bac à sable : le `.env` du développeur n'est pas lu.

La copie reçoit des identifiants **factices**, puisque la fixture n'en contient aucun :
- un e-mail et un mot de passe connus par athlète (`harnais-<id>`) ;
- un faux token Strava pour l'athlète de la dernière activité.

Le harnais interroge d'abord en GET :
- toutes les routes publiques ;
- les routes joueur, avec une session créée pour chaque athlète ;
- les routes admin en lecture ;
- quelques accès qui doivent être refusés.

Il passe ensuite des **sondes de sécurité** : des requêtes qu'un attaquant pourrait envoyer. Chacune rapporte ce que le serveur accepte ou refuse.

| Sonde | Ce qui est observé |
|---|---|
| `webhook-github` | La route de déploiement répond-elle ? La ref envoyée ne contient jamais « master ». |
| `strava-suppression-forgee` | Suppression avec un mauvais `subscription_id`, pour une activité qui existe encore sur Strava |
| `strava-suppression-reelle` | Suppression légitime : l'activité n'existe plus sur Strava |
| `strava-suppression-autre-athlete` | Suppression de l'activité d'un autre athlète que l'émetteur |
| `snapshot-falsifie` | Un classement inventé est-il enregistré ? |
| `connexion` | Connexion acceptée ou refusée, et format du hash stocké ensuite |
| `synchro-sans-authentification` | Une synchro Strava peut-elle être lancée sans mot de passe admin ? |
| `admin-mot-de-passe-par-defaut` | Serveur relancé sans `ADMIN_PASSWORD` : `admin123` est-il accepté ? |

Les réponses de plus de 256 Ko sont réduites à leur empreinte. Les champs qui dépendent de l'instant (`lastModified`, `timestamp`) et les jetons de session sont neutralisés.

La partie C exige `npm install` dans `backend/`. Sur un code antérieur à L01, elle est sautée : démarrer le serveur sans `VERSANT_DISABLE_JOBS` lancerait le rattrapage du gel et la synchro Strava.

**Contrôle de fidélité.** La fixture contient le classement qu'un vrai navigateur a envoyé au serveur (`yearlyStandingsSnapshot`). À cet instant précis, le harnais doit retrouver exactement le même classement. Sinon, c'est le harnais qui est en défaut, pas le code testé.

**Pas encore couvert :**
- les routes d'écriture (testées par scénarios dans les livrables qui les touchent) ;
- l'isolation entre ligues (partie D, à partir de L40) ;
- le rendu HTML ;
- l'ingestion Strava réelle.

## Déterminisme

- **Fuseau horaire** : `Europe/Paris`, imposé et vérifié dans chaque calcul.
- **Horloge** : figée (`lib/clock.mjs`). Le moteur lit l'heure courante en interne.
- **Hasard** : `Math.random` remplacé par un générateur à graine fixe, réinitialisé avant chaque scénario de gel.
- **Isolation** : chaque calcul tourne dans un processus séparé. Les variables du bac à sable (`VERSANT_DATA_DIR`, etc.) sont retirées de l'environnement des parties A et B.
- **Sortie canonique** : clés triées, ordre des tableaux conservé (il porte du sens : positions, égalités, ordre des activités).

## Code extrait plutôt que recopié

`app.js`, `stats.js` et `server.js` ne s'importent pas dans Node : ils touchent au DOM, ou démarrent le serveur. Le harnais extrait donc leur source à chaque exécution et l'exécute tel quel (`lib/extract.mjs`) :

| Fichier | Extrait | Rôle |
|---|---|---|
| `public/js/app.js` | `parseActivitiesData` | Activités servies au moteur par la page d'accueil |
| `public/js/app.js` | Bloc `const enrichedStandings = …` → `enrichedStandings.forEach((e, i) => e.rank = i + 1);` | Totaux du classement général affiché |
| `public/js/stats.js` | `CHALLENGE_START`, `EXCLUDED_SPORTS`, `normalizeActivity`, `filterAndNormalize` | Activités de la page stats |
| `backend/server.js` | `normalizeJokerUsage`, `readJokerUsage`, `readJokerUsageWithFrozen` | Réponse de `/api/jokers/all` |
| `backend/server.js` | Corps de `GET /api/athletes/:leagueId` | Réponse de `/api/athletes/…` |
| `backend/server.js` | Bloc `const compact = standings.map(` | Forme du snapshot, pour le contrôle de fidélité |

Si un repère disparaît (fonction renommée, code déplacé), l'extraction échoue avec un message explicite. Le harnais doit alors être adapté **dans un commit séparé**, puis revalidé en le rejouant sur le code de référence.

Seules deux lignes d'orchestration du serveur sont reproduites. Elles se trouvent dans `lib/back.mjs`, avec leurs références :
- le filtre des athlètes de la ligue ;
- la normalisation des jokers passés au gel.

## Fixture

Une fixture contient des données personnelles (noms, activités) : elle se range **hors du dépôt git**. `make-fixture.mjs` refuse un dossier situé dans le dépôt.

Anonymisation appliquée :
- **`athletes.json`** : seuls `id`, `name`, `league_id`, `active`, `registered_at`, `active_from_round` et `active_from_season` sont conservés. Pas d'e-mail, de hash de mot de passe, de token Strava ni de profil.
- **Activités** : les traces, les coordonnées (y compris `weather.lat` et `weather.lon`), les lieux et les fréquences cardiaques sont supprimés.

`round_configs.json` n'est **pas** dans la sauvegarde `versant-data`. Il faut le fournir avec `--round-configs`. Sur le serveur, il se trouve dans `/opt/versant-api/backend/data/`. Il est aussi lisible par la route publique `GET /api/round-configs`.

### Sur le serveur

```bash
node backend/scripts/regression/make-fixture.mjs \
  --from /opt/versant-api/backend/data \
  --out ~/versant-backups/fixture-$(date +%Y%m%d-%H%M)
```

### En local, depuis une copie de versant-data

```bash
node backend/scripts/regression/make-fixture.mjs \
  --from ../versant-data-master/versant-data-master/data \
  --round-configs <round_configs.json> \
  --out ../versant-regression/fixtures/AAAA-MM-JJ
```

## Capture et comparaison

```bash
# capture (≈ 8 s)
node backend/scripts/regression/snapshot.mjs \
  --fixture ../versant-regression/fixtures/2026-10-03 \
  --out ../versant-regression/refs/apres-L20.json

# comparaison avec la référence
node backend/scripts/regression/compare.mjs \
  ../versant-regression/refs/reference-d6bce5b.json \
  ../versant-regression/refs/apres-L20.json
```

- **Code de sortie** de `compare.mjs` : 0 si les deux captures sont identiques, 1 sinon. Les chemins qui diffèrent sont listés.
- **Écart attendu** : un livrable qui change volontairement une sortie (par exemple, le retrait de l'e-mail de `/api/athletes`) liste cet écart dans sa description. On l'ignore alors avec `--ignore <chemin>`. Tout autre écart est une régression.
- **`--repo <dossier>`** : teste un autre exemplaire du code, par exemple un `git worktree` sur le tag de référence. Utile pour comparer l'ancien et le nouveau code sur une fixture toute fraîche avant un déploiement.
- **Journal** : chaque capture écrit un fichier `.log` à côté du `.json`, avec les messages de la console du code testé. Il n'entre pas dans la comparaison.

## Références en cours

Elles sont rangées hors du dépôt, dans `../versant-regression/refs/` :

| Fichier | Code | Parties | Usage |
|---|---|---|---|
| `reference-d6bce5b.json` | `d6bce5b` | A, B | État d'origine, avant toute modification |
| `reference-d6bce5b-fixbonus.json` | `d6bce5b` + retrait de kamikaze et malédiction du tirage | A, B | Seul écart avec l'origine : les choix tirés au gel du R49 |
| `reference-L01.json` | précédent + L01 | A, B, C | Première référence avec l'API |
| `reference-sondes.json` | précédent + sondes de sécurité | A, B, C | **Référence du lot sécurité** (L11 à L15) : les sondes y constatent les failles |

## Procédure du chantier multi-ligues

1. **Avant toute modification du code de prod** : création de la fixture et capture de la référence.
2. **Après chaque livrable** : capture puis comparaison en local, puis de nouveau sur le serveur avant la fusion dans master.
3. **Avant un déploiement des lots 2 et 3** :
   - créer une nouvelle fixture juste avant ;
   - capturer l'ancien code (`--repo` pointé sur le tag) et le nouveau ;
   - les deux captures doivent être identiques.
4. **Modification du harnais lui-même** : commit séparé, revalidé en le rejouant sur le code de référence.

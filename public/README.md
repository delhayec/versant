# Versant - Challenge a Elimination

Challenge sportif a elimination progressive par saisons.

## Concept

Versant est un challenge base sur le denivele positif (D+) Strava.

### Saison
- Tous les participants commencent en course
- Chaque round dure 5 jours (configurable)
- A la fin de chaque round, les 2 derniers sont elimines
- La saison se termine quand il reste 1 champion
- Points attribues, puis nouvelle saison

### Challenge des Elimines
- Les elimines accumulent du D+ jusqu'a la fin de saison
- Plus on est elimine tot, plus on accumule longtemps
- Points bonus attribues en fin de saison

### Points

Challenge Principal: 1er=15pts, 2e=12pts, 3e=10pts, 4e=8pts...

Challenge Elimines: 1er=9pts, 2e=6pts, 3e=3pts, 4e=1pt

### Jokers (usage unique sur l'annee)

- Duel: Defiez un adversaire, volez 50% de son D+ si vous gagnez
- Multiplicateur: x2 sur le D+ d'une journee
- Bouclier: Evitez l'elimination (non utilisable en finale)
- Sabotage: Divisez le D+ du leader par 2

Les jokers s'activent au round SUIVANT leur declaration.

## Lancement

```bash
python -m http.server 8000
```

Ouvrir http://localhost:8000

## Configuration

Modifier js/config.js:

- roundDurationDays: Duree d'un round
- eliminationsPerRound: Nombre d'elimines par round
- PARTICIPANTS: Liste des joueurs
- JOKER_TYPES: Types de bonus disponibles

## Debug

Le slider en haut de page permet de simuler n'importe quelle date de 2025.

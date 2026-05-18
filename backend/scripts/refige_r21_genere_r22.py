#!/usr/bin/env python3
"""
FORCE LES ÉQUIPES R22 AVEC LA COMPO CHOISIE

Proposition retenue :
  Team 1 = 105 pts : Clement D / Baptiste I / Da M
  Team 2 = 105 pts : MaxDePeuf / Rémi S / Guillaume B
  Team 3 = 101 pts : Baptiste M / Mariana S / Benjamin T
  Team 4 =  95 pts : Elodie F / Leo B / Franck P

Caractéristiques :
- 0 paire R21 reconduite (brassage maximal)
- Écart max/min : 10 pts (le plus bas possible)
- Conserve les animaux déjà tirés (Écureuil, Mammouth, Chenille, Raton)
- Backup automatique avant modification
- Idempotent : si une compo est déjà figée à ces athlètes-là, on ne la retouche pas
"""
import json
import os
import shutil
import sys
from datetime import datetime, timezone

SEASON_TEAMS_PATH = '/opt/versant-api/backend/data/season_teams.json'

TS = datetime.now().strftime('%Y%m%d_%H%M%S')
NOW_ISO = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

# Compo choisie : 4 équipes de 3 joueurs (id, name, points)
CHOSEN_R22 = [
    {
        'name': 'Team 1',
        'members': [
            {'id': '3953180',  'name': 'Clement D',  'points': 50},
            {'id': '6635902',  'name': 'Baptiste I', 'points': 52},
            {'id': '3989319',  'name': 'Da M',       'points':  3},
        ]
    },
    {
        'name': 'Team 2',
        'members': [
            {'id': '119310419', 'name': 'MaxDePeuf',   'points': 13},
            {'id': '84388438',  'name': 'Rémi S',      'points': 33},
            {'id': '87904944',  'name': 'Guillaume B', 'points': 59},
        ]
    },
    {
        'name': 'Team 3',
        'members': [
            {'id': '3762537',  'name': 'Baptiste M',  'points': 38},
            {'id': '1841009',  'name': 'Mariana S',   'points': 46},
            {'id': '45072827', 'name': 'Benjamin T',  'points': 17},
        ]
    },
    {
        'name': 'Team 4',
        'members': [
            {'id': '68391361', 'name': 'Elodie F',   'points': 16},
            {'id': '100399073','name': 'Leo B',      'points': 47},
            {'id': '5231535',  'name': 'Franck P',   'points': 32},
        ]
    },
]

# === CHARGEMENT ===
with open(SEASON_TEAMS_PATH, 'r', encoding='utf-8') as f:
    season_teams_file = json.load(f)

season_4 = season_teams_file.get('4', {})
existing_r22 = season_4.get('rounds', {}).get('22', {})

# === IDEMPOTENCE ===
if existing_r22:
    # Vérifier si la compo actuelle correspond déjà à celle choisie
    existing_ids_per_team = []
    for t in existing_r22.get('teams', []):
        existing_ids_per_team.append(sorted(m['id'] for m in t['members']))
    chosen_ids_per_team = [sorted(m['id'] for m in t['members']) for t in CHOSEN_R22]

    # Tri global pour comparer en mode "anonyme" (l'ordre des équipes peut différer)
    if sorted(existing_ids_per_team) == sorted(chosen_ids_per_team):
        print("⚠️  La compo R22 actuelle correspond déjà à la compo choisie.")
        print("    Rien à faire.")
        sys.exit(0)

# === BACKUP ===
shutil.copyfile(SEASON_TEAMS_PATH, SEASON_TEAMS_PATH + '.bak.' + TS)
print(f'✅ Backup créé : {SEASON_TEAMS_PATH}.bak.{TS}\n')

# === RÉUTILISER LES ANIMAUX EXISTANTS si possible ===
# La compo précédente avait probablement Écureuil/Mammouth/Chenille/Raton.
# On garde le même ordre d'animaux et de couleurs pour ne pas surprendre.
existing_teams = existing_r22.get('teams', [])

if existing_teams and len(existing_teams) == 4:
    animals = [t['animal'] for t in existing_teams]
    colors = [t['color'] for t in existing_teams]
    print('Animaux conservés depuis la compo précédente :')
    for i, a in enumerate(animals):
        print(f"  Team {i+1}: {a['emoji']} {a['name']}")
else:
    # Fallback : tirage par défaut (animaux non utilisés au R21)
    print('Aucune compo précédente trouvée, utilisation des animaux par défaut R22')
    animals = [
        {'id': 'ecureuil',  'emoji': '🐿️',  'name': 'Écureuil'},
        {'id': 'mammouth',  'emoji': '🦣', 'name': 'Mammouth'},
        {'id': 'chenille',  'emoji': '🐛', 'name': 'Chenille'},
        {'id': 'raton',     'emoji': '🦝', 'name': 'Raton'}
    ]
    colors = [
        {'bg': 'rgba(249, 115, 22, 0.15)', 'border': '#f97316', 'name': 'Orange'},
        {'bg': 'rgba(34, 211, 238, 0.15)', 'border': '#22d3ee', 'name': 'Cyan'},
        {'bg': 'rgba(168, 85, 247, 0.15)', 'border': '#a855f7', 'name': 'Violet'},
        {'bg': 'rgba(16, 185, 129, 0.15)', 'border': '#10b981', 'name': 'Vert'},
    ]

# === CONSTRUIRE LA NOUVELLE STRUCTURE R22 ===
new_teams = []
for i, t in enumerate(CHOSEN_R22):
    new_teams.append({
        'index': i,
        'color': colors[i],
        'animal': animals[i],
        'members': t['members'],
        'totalPoints': sum(m['points'] for m in t['members'])
    })

# === SAUVEGARDER ===
if 'rounds' not in season_4:
    season_4['rounds'] = {}

season_4['rounds']['22'] = {
    'roundNumber': 22,
    'createdAt': NOW_ISO,
    'forcedComposition': True,
    'compositionReason': 'Brassage maximal (0 paire R21 reconduite, écart 10 pts)',
    'teams': new_teams
}

with open(SEASON_TEAMS_PATH + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(season_teams_file, f, indent=2, ensure_ascii=False)
os.replace(SEASON_TEAMS_PATH + '.tmp', SEASON_TEAMS_PATH)

# === RÉCAP ===
print('\n✅ R22 enregistré avec la compo choisie :')
for t in new_teams:
    members_str = ', '.join(f"{m['name']} ({m['points']} pts)" for m in t['members'])
    print(f"  {t['animal']['emoji']} {t['animal']['name']:10s} = {t['totalPoints']:>3} pts  : {members_str}")

print()
print('⚠️  Étape suivante :')
print('   pm2 restart versant-api')
print('   (pour vider le cache mémoire des équipes)')
print()
print('Vérification :')
print('   curl -s https://versant-app.fr/api/teams/round/22 | python3 -m json.tool | head -30')
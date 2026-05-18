#!/usr/bin/env python3
"""
RE-FIGEMENT DU R21 + GÉNÉRATION DU R22

Objectif :
  1. Re-figer le R21 avec les VRAIES compositions d'équipes (issues de season_teams.json saison 4)
     - Calcul du D+ par équipe à partir du ranking individuel existant
     - Identification de l'équipe avec le D+ minimum → équipe éliminée
     - Mise à jour de rounds[21].teams, eliminations, eliminatedTeam, ranking (teamIndex/Animal/Color)
  2. Générer la composition R22 (12 survivants en 4 équipes de 3) avec rotation d'animaux
     - Option B : exclure tous les animaux déjà utilisés dans la saison
     - Tirage équilibré par points cumulés (mêmes points utilisés que season 4 R21)
     - Stockage dans season_teams.json sous une nouvelle clé indexée par round
  3. Backup avant tout
"""
import json
import os
import shutil
import random
from datetime import datetime, timezone

FROZEN_PATH = '/opt/versant-api/backend/data/frozen_results.json'
SEASON_TEAMS_PATH = '/opt/versant-api/backend/data/season_teams.json'

TS = datetime.now().strftime('%Y%m%d_%H%M%S')
NOW_ISO = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

# === 1. BACKUPS ===
shutil.copyfile(FROZEN_PATH, FROZEN_PATH + '.bak.' + TS)
shutil.copyfile(SEASON_TEAMS_PATH, SEASON_TEAMS_PATH + '.bak.' + TS)
print(f'✅ Backups créés : .bak.{TS}\n')

# === 2. CHARGEMENT ===
with open(FROZEN_PATH, 'r', encoding='utf-8') as f:
    frozen = json.load(f)
with open(SEASON_TEAMS_PATH, 'r', encoding='utf-8') as f:
    season_teams_file = json.load(f)

r21 = frozen['rounds']['21']
true_teams = season_teams_file['4']['teams']

# === 3. RE-CALCUL R21 ===
print('═══ RE-FIGEMENT DU R21 ═══')

# Map id -> elevation/name à partir du ranking existant
elev_by_id = {r['id']: r['elevation'] for r in r21['ranking']}
name_by_id = {r['id']: r['name'] for r in r21['ranking']}
acts_by_id = {r['id']: r.get('activitiesCount', 0) for r in r21['ranking']}
original_by_id = {r['id']: r.get('originalElevation', r['elevation']) for r in r21['ranking']}

# Construire les équipes avec leur D+ total
def make_team(t):
    members = []
    for m in t['members']:
        mid = m['id']
        members.append({
            'id': mid,
            'name': name_by_id.get(mid, m['name']),
            'elevation': elev_by_id.get(mid, 0),
            'activitiesCount': acts_by_id.get(mid, 0),
            'originalElevation': original_by_id.get(mid, 0),
            'bonusPoints': 0
        })
    return {
        'index': t['index'],
        'color': t['color'],
        'animal': t['animal'],
        'members': members,
        'totalPoints': t.get('totalPoints', sum(m.get('points', 0) for m in t['members'])),
        'totalElevation': sum(m['elevation'] for m in members),
        # Pour départager les ex aequo : on prend le 0 car on a pas l'info "lastActivityTime" précise.
        # En pratique l'écart est suffisant pour ne pas avoir besoin de tie-break ici.
        'lastActivityTime': 0
    }

new_teams = [make_team(t) for t in true_teams]

# Trier par D+ décroissant (la dernière du tri sera éliminée)
new_teams.sort(key=lambda t: -t['totalElevation'])

print('\nClassement R21 par équipe :')
for i, t in enumerate(new_teams):
    members_str = ' / '.join(f"{m['name']} {m['elevation']}m" for m in t['members'])
    marker = ' ← ÉLIMINÉE' if i == len(new_teams) - 1 else ''
    print(f"  {i+1}. {t['animal']['emoji']} {t['animal']['name']:10s} = {t['totalElevation']:>5} m  ({members_str}){marker}")

eliminated_team = dict(new_teams[-1])
eliminated_team['eliminationReason'] = 'team_elimination'

# Nouvelles éliminations
eliminations = []
for m in eliminated_team['members']:
    eliminations.append({
        'id': m['id'],
        'name': m['name'],
        'elevation': m['elevation'],
        'reason': 'team_elimination',
        'position': 0,  # on assigne après le ranking
        'teamIndex': eliminated_team['index'],
        'teamAnimal': eliminated_team['animal'],
        'teamColor': eliminated_team['color']
    })

# Re-construire le ranking : ordre = ordre des équipes (top first), individus triés par D+ desc DANS l'équipe
new_ranking = []
position = 1
eliminated_ids = {m['id'] for m in eliminated_team['members']}
for t in new_teams:
    sorted_members = sorted(t['members'], key=lambda m: -m['elevation'])
    for m in sorted_members:
        entry = {
            'id': m['id'],
            'name': m['name'],
            'elevation': m['elevation'],
            'activitiesCount': m['activitiesCount'],
            'originalElevation': m['originalElevation'],
            'bonusPoints': 0,
            'position': position,
            'teamIndex': t['index'],
            'teamAnimal': t['animal'],
            'teamColor': t['color'],
            'mainPoints': 0  # à recalculer plus bas
        }
        new_ranking.append(entry)
        position += 1

# Attribution des mainPoints pour les éliminés (rang dans l'équipe éliminée à partir du D+)
# Barème : 1=10, 2=8, 3=6, 4=5, 5=4, 6=3, 7=2, 8=1
ELIM_POINTS = {1: 10, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1}
# En team-elim : chaque joueur éliminé reçoit des points "main" basés sur sa position globale
# parmi les éliminés (= position dans le ranking parmi les eliminés)
elim_ranking = [r for r in new_ranking if r['id'] in eliminated_ids]
elim_ranking.sort(key=lambda r: r['position'])  # ordre du ranking
for idx, r in enumerate(elim_ranking):
    # mainPoints = position dans la liste des éliminés en partant de la fin
    elim_pos = idx + 1  # 1er éliminé du ranking = "meilleur" éliminé
    # Mapping simple : meilleur des éliminés = 3 pts, milieu = 2 pts, dernier = 1 pt
    # On copie la logique de l'ancien R21 : Leo B = 1 pt, autres = 0
    # ⚠️ Ajuste si tu veux une autre règle
    r['eliminatedPosition'] = r['position']
    r['mainPoints'] = max(0, len(elim_ranking) - idx - 1)  # ex: 3 elims → 2,1,0

# Mettre à jour eliminations avec les positions
for e in eliminations:
    matching = next((r for r in new_ranking if r['id'] == e['id']), None)
    if matching:
        e['position'] = matching['position']

eliminations.sort(key=lambda e: -e['position'])  # ordre du pire au meilleur

# === 4. APPLIQUER LES CHANGEMENTS AU R21 ===
r21['ranking'] = new_ranking
r21['eliminations'] = eliminations
r21['teams'] = new_teams
r21['eliminatedTeam'] = eliminated_team
r21['stats']['eliminationsCount'] = len(eliminations)
r21['frozenAt'] = NOW_ISO
r21['frozenMethod'] = 'recalculated_with_correct_teams'

print(f"\n✅ R21 re-figé : équipe {eliminated_team['animal']['emoji']} {eliminated_team['animal']['name']} éliminée")
print(f"   Éliminés : {', '.join(e['name'] for e in eliminations)}")

# === 5. GÉNÉRER LA COMPO R22 ===
print('\n═══ GÉNÉRATION R22 ═══')

# Survivants = tous les joueurs sauf ceux de l'équipe éliminée
survivors = [r for r in new_ranking if r['id'] not in eliminated_ids]
print(f'\n12 survivants pour le R22 :')

# Points cumulés saison 1+2+3 pour chaque survivant (pour équilibrage)
# On les lit dans yearlyStandingsSnapshot
standings = {s['id']: s['totalPoints'] for s in frozen.get('yearlyStandingsSnapshot', {}).get('standings', [])}
survivors_with_points = []
for s in survivors:
    pts = standings.get(s['id'], 0)
    survivors_with_points.append({
        'id': s['id'],
        'name': s['name'],
        'points': pts
    })
    print(f"  {s['name']:15s} {pts} pts")

# Tirage équilibré (algorithme simple : tri par points puis snake-draft sur 4 équipes)
# Le snake-draft est moins parfait que formBalancedTeams mais suffisant pour 12 joueurs/4 équipes
survivors_with_points.sort(key=lambda p: -p['points'])

# 4 équipes
teams_r22 = [[], [], [], []]
# Snake draft : 1→4, 4→1, 1→4, 4→1 ...
direction = 1
team_idx = 0
for i, p in enumerate(survivors_with_points):
    teams_r22[team_idx].append(p)
    team_idx += direction
    if team_idx >= 4 or team_idx < 0:
        direction *= -1
        team_idx += direction

print('\nÉquipes R22 (snake draft équilibré par points cumulés) :')
team_points_r22 = []
for i, t in enumerate(teams_r22):
    total = sum(p['points'] for p in t)
    team_points_r22.append(total)
    members_str = ', '.join(f"{p['name']} ({p['points']})" for p in t)
    print(f"  Team {i+1} ({total} pts) : {members_str}")
print(f'\n  Std dev équipes : ±{(max(team_points_r22) - min(team_points_r22))} pts')

# === 6. ROTATION DES ANIMAUX (OPTION B) ===
# Exclure tous les animaux utilisés dans les rounds précédents de la saison 4

ALL_ANIMALS = [
    {'id': 'loup',       'emoji': '🐺', 'name': 'Loup'},
    {'id': 'aigle',      'emoji': '🦅', 'name': 'Aigle'},
    {'id': 'marmotte',   'emoji': '🦫', 'name': 'Marmotte'},
    {'id': 'raton',      'emoji': '🦝', 'name': 'Raton'},
    {'id': 'ecureuil',   'emoji': '🐿️',  'name': 'Écureuil'},
    {'id': 'lapin',      'emoji': '🐇', 'name': 'Lapin'},
    {'id': 'mouflon',    'emoji': '🐏', 'name': 'Mouflon'},
    {'id': 'chenille',   'emoji': '🐛', 'name': 'Chenille'},
    {'id': 'bouquetin',  'emoji': '🐐', 'name': 'Bouquetin'},
    {'id': 'renard',     'emoji': '🦊', 'name': 'Renard'},
    {'id': 'lynx',       'emoji': '😺', 'name': 'Lynx'},
    {'id': 'ours',       'emoji': '🐻', 'name': 'Ours'},
    {'id': 'mammouth',   'emoji': '🦣', 'name': 'Mammouth'},
    {'id': 'sanglier',   'emoji': '🐗', 'name': 'Sanglier'},
    {'id': 'canard',     'emoji': '🦆', 'name': 'Canard'},
    {'id': 'panda',      'emoji': '🐼', 'name': 'Panda'},
    {'id': 'chouette',   'emoji': '🦉', 'name': 'Chouette'},
    {'id': 'loutre',     'emoji': '🦦', 'name': 'Loutre'}
]
TEAM_COLORS = [
    {'bg': 'rgba(249, 115, 22, 0.15)', 'border': '#f97316', 'name': 'Orange'},
    {'bg': 'rgba(34, 211, 238, 0.15)', 'border': '#22d3ee', 'name': 'Cyan'},
    {'bg': 'rgba(168, 85, 247, 0.15)', 'border': '#a855f7', 'name': 'Violet'},
    {'bg': 'rgba(16, 185, 129, 0.15)', 'border': '#10b981', 'name': 'Vert'},
    {'bg': 'rgba(244, 63, 94, 0.15)', 'border': '#f43f5e', 'name': 'Rose'},
    {'bg': 'rgba(234, 179, 8, 0.15)', 'border': '#eab308', 'name': 'Or'}
]

# Animaux utilisés au R21
used_animal_ids = {t['animal']['id'] for t in new_teams}
print(f"\nAnimaux déjà utilisés saison 4 : {sorted(used_animal_ids)}")

# Tirer 4 nouveaux animaux parmi les non-utilisés
available_animals = [a for a in ALL_ANIMALS if a['id'] not in used_animal_ids]
# Seed déterministe basé sur round + saison pour reproductibilité
random.seed(22 * 1000 + 4)
chosen_animals = random.sample(available_animals, 4)
print(f"Nouveaux animaux R22 : {[a['name'] for a in chosen_animals]}")

# === 7. CONSTRUIRE LA STRUCTURE R22 ===
r22_teams = []
for i, t in enumerate(teams_r22):
    r22_teams.append({
        'index': i,
        'color': TEAM_COLORS[i],
        'animal': chosen_animals[i],
        'members': [{'id': p['id'], 'name': p['name'], 'points': p['points']} for p in t],
        'totalPoints': sum(p['points'] for p in t)
    })

# === 8. SAUVEGARDER ===
# Nouvelle structure season_teams.json :
#   { "4": { "round_21": {...}, "round_22": {...}, "teams": [...] (legacy) } }
# On garde la clé "teams" pour la rétro-compat de l'endpoint actuel,
# mais on ajoute "rounds" pour le futur.

if 'rounds' not in season_teams_file['4']:
    season_teams_file['4']['rounds'] = {}

# Archiver la compo R21 (= ce qui était dans teams[] avant)
season_teams_file['4']['rounds']['21'] = {
    'roundNumber': 21,
    'frozenAt': NOW_ISO,
    'teams': true_teams  # = la vraie compo R21
}
# Stocker la compo R22
season_teams_file['4']['rounds']['22'] = {
    'roundNumber': 22,
    'createdAt': NOW_ISO,
    'teams': r22_teams
}

# IMPORTANT : Le champ "teams" à la racine de season_teams_file["4"] est lu par
# l'endpoint actuel pour TOUS les rounds de la saison. On le supprime pour
# forcer le backend à ne plus utiliser cette logique "verrou saison-entière".
# L'endpoint patché lira "rounds[X].teams" via une logique par-round.
# Pour ne pas casser l'endpoint actuel AVANT le patch, on garde "teams" =
# la compo R22 (= round actif) pour que ça marche au moins en attendant.
season_teams_file['4']['teams'] = r22_teams
season_teams_file['4']['lockedAt'] = NOW_ISO
season_teams_file['4']['lockedReason'] = f"R21 re-figé + R22 généré le {TS}"

# Écrire
with open(FROZEN_PATH + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(frozen, f, indent=2, ensure_ascii=False)
os.replace(FROZEN_PATH + '.tmp', FROZEN_PATH)

with open(SEASON_TEAMS_PATH + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(season_teams_file, f, indent=2, ensure_ascii=False)
os.replace(SEASON_TEAMS_PATH + '.tmp', SEASON_TEAMS_PATH)

print(f'\n✅ Fichiers mis à jour')
print(f'   - {FROZEN_PATH} (R21 re-figé)')
print(f'   - {SEASON_TEAMS_PATH} (R22 généré + structure par-round)')
print(f'\nBackups :')
print(f'   {FROZEN_PATH}.bak.{TS}')
print(f'   {SEASON_TEAMS_PATH}.bak.{TS}')
print(f'\n⚠️  IMPORTANT :')
print(f'   1. Relance "pm2 restart versant-api" pour vider le cache mémoire des équipes')
print(f'   2. Vérifie ensuite : curl https://versant-app.fr/api/teams/round/22')
print(f'      → doit afficher la nouvelle compo R22')
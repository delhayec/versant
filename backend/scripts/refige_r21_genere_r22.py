#!/usr/bin/env python3
"""
RE-FIGEMENT DU R21 (vraies équipes) + GÉNÉRATION DU R22 (4 équipes de 3 survivants)

Caractéristiques :
- IDEMPOTENT : détecte si R21 a déjà été refigé et refuse de retravailler dessus
- Lit la VRAIE compo initiale depuis season_teams.json["4"]["teams"]
  (= les 5 équipes qui ont joué le R21 selon ce que les joueurs ont vu)
- Identifie l'équipe avec le D+ MINIMUM au R21 → équipe éliminée
- Génère R22 avec exactement 4 équipes de 3 joueurs (12 survivants)
- Animaux R22 : seulement parmi ceux NON utilisés en saison 4 (option B)
- Backup avant toute modification
- Ne touche PAS au champ "teams" à la racine de season_teams_file["4"]
  pour préserver la compo R21 d'origine
"""
import json
import os
import shutil
import random
import sys
from datetime import datetime, timezone

FROZEN_PATH = '/opt/versant-api/backend/data/frozen_results.json'
SEASON_TEAMS_PATH = '/opt/versant-api/backend/data/season_teams.json'

TS = datetime.now().strftime('%Y%m%d_%H%M%S')
NOW_ISO = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

# === 1. CHARGEMENT + VÉRIFICATIONS PRÉ-EXÉCUTION ===
with open(FROZEN_PATH, 'r', encoding='utf-8') as f:
    frozen = json.load(f)
with open(SEASON_TEAMS_PATH, 'r', encoding='utf-8') as f:
    season_teams_file = json.load(f)

r21 = frozen['rounds']['21']
season_4 = season_teams_file.get('4', {})
true_teams = season_4.get('teams', [])

# === GARDE-FOUS ===
if len(true_teams) != 5:
    print(f"❌ season_teams.json['4']['teams'] doit contenir 5 équipes, trouvé {len(true_teams)}")
    sys.exit(1)
if not all(len(t['members']) == 3 for t in true_teams):
    print("❌ Toutes les équipes doivent avoir 3 membres")
    for t in true_teams:
        print(f"   {t['animal']['name']}: {len(t['members'])} membres")
    sys.exit(1)

# Idempotence : si R21 a déjà été refigé par CE script, refuser
if r21.get('frozenMethod') == 'recalculated_with_correct_teams':
    print("⚠️  R21 a déjà été refigé par ce script (frozenMethod = recalculated_with_correct_teams).")
    print("    Pour le re-traiter, restaurer manuellement le backup d'avant.")
    sys.exit(1)

# Idempotence : si R22 existe déjà dans rounds, refuser
existing_rounds = season_4.get('rounds', {})
if '22' in existing_rounds:
    print("⚠️  R22 existe déjà dans season_teams.json['4']['rounds']['22'].")
    print("    Pour le re-générer, supprimer cette entrée manuellement.")
    sys.exit(1)

# === 2. BACKUPS ===
shutil.copyfile(FROZEN_PATH, FROZEN_PATH + '.bak.' + TS)
shutil.copyfile(SEASON_TEAMS_PATH, SEASON_TEAMS_PATH + '.bak.' + TS)
print(f'✅ Backups créés : .bak.{TS}\n')

# === 3. CONSTRUIRE LE NOUVEAU R21 AVEC LES VRAIES ÉQUIPES ===
print('═══ RE-FIGEMENT DU R21 ═══')

# Map id → données du ranking individuel R21 (les D+ individuels sont corrects, juste les groupements étaient faux)
elev_by_id = {r['id']: r['elevation'] for r in r21['ranking']}
name_by_id = {r['id']: r['name'] for r in r21['ranking']}
acts_by_id = {r['id']: r.get('activitiesCount', 0) for r in r21['ranking']}
original_by_id = {r['id']: r.get('originalElevation', r['elevation']) for r in r21['ranking']}

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
        'totalPoints': t.get('totalPoints', 0),
        'totalElevation': sum(m['elevation'] for m in members),
        'lastActivityTime': 0
    }

new_teams = [make_team(t) for t in true_teams]
# Trier par D+ décroissant (la dernière = éliminée)
new_teams.sort(key=lambda t: -t['totalElevation'])

print('\nClassement R21 par équipe :')
for i, t in enumerate(new_teams):
    members_str = ' / '.join(f"{m['name']} {m['elevation']}m" for m in t['members'])
    marker = ' ← ÉLIMINÉE' if i == len(new_teams) - 1 else ''
    print(f"  {i+1}. {t['animal']['emoji']} {t['animal']['name']:10s} = {t['totalElevation']:>5} m  ({members_str}){marker}")

eliminated_team_data = new_teams[-1]
eliminated_team = dict(eliminated_team_data)
eliminated_team['eliminationReason'] = 'team_elimination'
eliminated_ids = {m['id'] for m in eliminated_team['members']}

# Re-construire le ranking : ordre = position des équipes, individus triés par D+ desc DANS l'équipe
new_ranking = []
position = 1
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
            'mainPoints': 0
        }
        new_ranking.append(entry)
        position += 1

# Attribution des mainPoints (barème ELIM classique global)
# Position 13 (1er des éliminés) = 1 pt selon le barème d'élimination historique
# Position 14 = 0 pt (puisqu'il n'est pas premier des éliminés)
# Position 15 = 0 pt
# En fait dans les saisons standards, on attribue selon le rang local des éliminés.
# Pour rester cohérent avec ce que les autres saisons font (Leo B avait 1pt au R21
# d'avant), on garde la règle "top éliminé = 1pt, autres = 0"
elim_in_ranking = [r for r in new_ranking if r['id'] in eliminated_ids]
elim_in_ranking.sort(key=lambda r: r['position'])  # le mieux placé d'abord
for idx, r in enumerate(elim_in_ranking):
    r['eliminatedPosition'] = r['position']
    r['mainPoints'] = 1 if idx == 0 else 0  # 1 pt pour le mieux classé des éliminés

# Construire eliminations
eliminations = []
for r in elim_in_ranking:
    eliminations.append({
        'id': r['id'],
        'name': r['name'],
        'elevation': r['elevation'],
        'reason': 'team_elimination',
        'position': r['position'],
        'teamIndex': eliminated_team_data['index'],
        'teamAnimal': eliminated_team_data['animal'],
        'teamColor': eliminated_team_data['color']
    })
# Trier les éliminés du PIRE au MIEUX (= position décroissante)
eliminations.sort(key=lambda e: -e['position'])

# === 4. APPLIQUER AU R21 ===
r21['ranking'] = new_ranking
r21['eliminations'] = eliminations
r21['teams'] = new_teams
r21['eliminatedTeam'] = eliminated_team
r21['stats']['eliminationsCount'] = len(eliminations)
r21['frozenAt'] = NOW_ISO
r21['frozenMethod'] = 'recalculated_with_correct_teams'

print(f"\n✅ R21 re-figé : équipe {eliminated_team['animal']['emoji']} {eliminated_team['animal']['name']} éliminée")
print(f"   Éliminés : {', '.join(e['name'] for e in eliminations)}")

# === 5. GÉNÉRER R22 (12 survivants, 4 équipes de 3) ===
print('\n═══ GÉNÉRATION R22 ═══')

# Survivants = tous sauf les 3 de l'équipe éliminée
survivors = [r for r in new_ranking if r['id'] not in eliminated_ids]
print(f'\nSurvivants pour R22 : {len(survivors)}')

if len(survivors) != 12:
    print(f"❌ Erreur : attendu 12 survivants, trouvé {len(survivors)}")
    sys.exit(1)
if len(survivors) % 3 != 0:
    print(f"❌ Erreur : {len(survivors)} survivants pas divisible par 3")
    sys.exit(1)

NUM_TEAMS = len(survivors) // 3
TEAM_SIZE = 3
print(f'   → {NUM_TEAMS} équipes de {TEAM_SIZE}')

# Points cumulés par survivant (depuis yearlyStandingsSnapshot)
standings = {s['id']: s['totalPoints'] for s in frozen.get('yearlyStandingsSnapshot', {}).get('standings', [])}
survivors_with_points = []
for s in survivors:
    pts = standings.get(s['id'], 0)
    survivors_with_points.append({'id': s['id'], 'name': s['name'], 'points': pts})

print('\nSurvivants par points cumulés :')
for p in sorted(survivors_with_points, key=lambda x: -x['points']):
    print(f"  {p['name']:15s} {p['points']:>3} pts")

# === SNAKE DRAFT amélioré ===
# Trier par points décroissants, puis distribuer 1→N, N→1, 1→N, etc.
# Garantit que chaque équipe a TEAM_SIZE joueurs (puisque len % TEAM_SIZE == 0)
sorted_survivors = sorted(survivors_with_points, key=lambda x: -x['points'])
teams_r22 = [[] for _ in range(NUM_TEAMS)]

idx = 0
direction = 1
for p in sorted_survivors:
    teams_r22[idx].append(p)
    next_idx = idx + direction
    if next_idx >= NUM_TEAMS or next_idx < 0:
        direction *= -1
        # Garde le même idx (pas de mouvement) pour le prochain tour
    else:
        idx = next_idx

# Vérification : toutes les équipes ont la bonne taille
for i, t in enumerate(teams_r22):
    if len(t) != TEAM_SIZE:
        print(f"❌ Bug snake draft : équipe {i} a {len(t)} membres au lieu de {TEAM_SIZE}")
        sys.exit(1)

print(f'\nÉquipes R22 (snake draft) :')
team_totals = []
for i, t in enumerate(teams_r22):
    total = sum(p['points'] for p in t)
    team_totals.append(total)
    members_str = ', '.join(f"{p['name']} ({p['points']})" for p in t)
    print(f"  Team {i+1} = {total:>3} pts  : {members_str}")
print(f"  Écart max/min : {max(team_totals) - min(team_totals)} pts")

# === 6. ROTATION DES ANIMAUX (option B = exclure tous ceux déjà utilisés) ===
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
print(f"\nAnimaux utilisés au R21 : {sorted(used_animal_ids)}")

# Tirer NUM_TEAMS animaux parmi les non-utilisés
available_animals = [a for a in ALL_ANIMALS if a['id'] not in used_animal_ids]
random.seed(22 * 1000 + 4)  # seed déterministe
chosen_animals = random.sample(available_animals, NUM_TEAMS)
print(f"Animaux R22 : {[a['name'] for a in chosen_animals]}")

# === 7. CONSTRUIRE LA STRUCTURE R22 ===
r22_teams = []
for i, team_members in enumerate(teams_r22):
    r22_teams.append({
        'index': i,
        'color': TEAM_COLORS[i],
        'animal': chosen_animals[i],
        'members': [{'id': p['id'], 'name': p['name'], 'points': p['points']} for p in team_members],
        'totalPoints': sum(p['points'] for p in team_members)
    })

# === 8. SAUVEGARDER ===
# ⚠️ IMPORTANT : on NE TOUCHE PAS à season_teams_file["4"]["teams"]
# qui contient toujours la compo R21 originale (source de vérité)
# On ajoute la compo R22 dans season_teams_file["4"]["rounds"]["22"]

if 'rounds' not in season_4:
    season_4['rounds'] = {}

# Archiver R21 dans rounds (pour traçabilité)
season_4['rounds']['21'] = {
    'roundNumber': 21,
    'frozenAt': NOW_ISO,
    'teams': true_teams
}
# Stocker R22
season_4['rounds']['22'] = {
    'roundNumber': 22,
    'createdAt': NOW_ISO,
    'teams': r22_teams
}

# Écrire (atomique)
with open(FROZEN_PATH + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(frozen, f, indent=2, ensure_ascii=False)
os.replace(FROZEN_PATH + '.tmp', FROZEN_PATH)

with open(SEASON_TEAMS_PATH + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(season_teams_file, f, indent=2, ensure_ascii=False)
os.replace(SEASON_TEAMS_PATH + '.tmp', SEASON_TEAMS_PATH)

print(f'\n✅ Fichiers mis à jour')
print(f'   - frozen_results.json (R21 re-figé)')
print(f'   - season_teams.json (R22 stocké dans rounds["22"])')
print(f'\nBackups :')
print(f'   {FROZEN_PATH}.bak.{TS}')
print(f'   {SEASON_TEAMS_PATH}.bak.{TS}')
print(f'\n⚠️  ATTENTION ÉTAPES SUIVANTES :')
print(f'   1. Le champ "teams" à la racine de season_teams_file["4"] EST INCHANGÉ')
print(f'      → Il contient toujours la compo R21 (Sanglier/Ours/Loup/Canard/Aigle)')
print(f'      → L\'endpoint actuel /api/teams/round/22 va donc renvoyer la compo R21 !')
print(f'   2. Tu DOIS patcher l\'endpoint pour qu\'il lise rounds["22"] en priorité.')
print(f'      C\'est le livrable 2 que je te livre juste après.')
print(f'   3. NE PAS faire "pm2 restart" tant que le patch endpoint n\'est pas déployé,')
print(f'      sinon les joueurs verront temporairement la compo R21 sur le R22.')
#!/usr/bin/env python3
"""
RE-CORRECTION DÉFINITIVE DU R21 (Option A)

Contexte :
  - Le R21 (round 1 saison 4 team) a été re-figé par erreur le 22/05 avec une
    activité DOUBLON de Pef (ID 18598933341, "Sortie vélo le matin", 1012m)
    qui a faussé le D+ de l'équipe Aigle.
  - L'activité légitime de Pef est 18542423575 ("Vélo du matin", 1356m).
  - Résultat : Aigle est passée de 4699m → 5711m, et l'équipe Loup a été
    éliminée à tort.

Ce script :
  1. Marque l'activité doublon 18598933341 comme excluded:true dans le fichier
     d'activités (exclusion permanente).
  2. Re-fige le R21 avec les VRAIES compositions (depuis season_teams.json["4"]["teams"])
     et les D+ recalculés SANS le doublon.
  3. Vérifie que l'équipe Aigle redevient la plus faible → Aigle éliminée.
  4. Marque frozenMethod = 'recalculated_correct_teams_no_dup' (immuable).

IMPORTANT : depuis le retrait de frozen_results.json du suivi Git, cette
correction est PERMANENTE (plus écrasée au deploy).

Backups automatiques avant toute modification.
"""
import json
import os
import shutil
import sys
from datetime import datetime, timezone

FROZEN_PATH = '/opt/versant-api/backend/data/frozen_results.json'
SEASON_TEAMS_PATH = '/opt/versant-api/backend/data/season_teams.json'
ACTIVITIES_PATH = '/opt/versant-api/backend/data/leagues/versant-2026_activities.json'

DUPLICATE_ACTIVITY_ID = 18598933341  # Doublon de Pef à exclure
PEF_ID = '110979265'

TS = datetime.now().strftime('%Y%m%d_%H%M%S')
NOW_ISO = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

R21_START = datetime.fromisoformat('2026-05-13T00:00:00+00:00').timestamp()
R21_END = datetime.fromisoformat('2026-05-17T23:59:59+00:00').timestamp()

# === BACKUPS ===
for p in (FROZEN_PATH, SEASON_TEAMS_PATH, ACTIVITIES_PATH):
    shutil.copyfile(p, p + '.bak.' + TS)
print(f'✅ Backups créés (.bak.{TS})\n')

# === 1. EXCLURE LE DOUBLON DANS LE FICHIER D'ACTIVITÉS ===
with open(ACTIVITIES_PATH, 'r', encoding='utf-8') as f:
    activities = json.load(f)

found = False
for a in activities:
    if a.get('id') == DUPLICATE_ACTIVITY_ID:
        a['excluded'] = True
        a['exclusionReason'] = 'doublon manuel (re-upload partiel) - faussait le D+ R21'
        found = True
        print(f"✅ Activité doublon {DUPLICATE_ACTIVITY_ID} marquée excluded:true")
        print(f"   \"{a.get('name')}\" {a.get('total_elevation_gain')}m")
        break

if not found:
    print(f"⚠️ Activité {DUPLICATE_ACTIVITY_ID} introuvable (déjà supprimée ?). On continue quand même.")

with open(ACTIVITIES_PATH + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(activities, f, ensure_ascii=False)
os.replace(ACTIVITIES_PATH + '.tmp', ACTIVITIES_PATH)

# === 2. RECALCULER LE D+ PAR ATHLÈTE AU R21 (sans le doublon) ===
VALID_SPORTS = {
    'Run', 'TrailRun', 'Ride', 'MountainBikeRide', 'GravelRide',
    'Hike', 'Walk', 'Snowshoe', 'BackcountrySki', 'NordicSki'
}

elev_by_athlete = {}
acts_by_athlete = {}
for a in activities:
    if a.get('excluded'):
        continue
    sport = a.get('sport_type') or a.get('type')
    if sport not in VALID_SPORTS:
        continue
    # Fenêtre R21 (basée sur la fin d'activité, comme le backend)
    start = datetime.fromisoformat(a['start_date'].replace('Z', '+00:00')).timestamp()
    elapsed = (a.get('elapsed_time') or 0)
    act_end = start + elapsed
    if act_end < R21_START or act_end > R21_END:
        continue
    aid = str(a.get('athlete', {}).get('id') or a.get('athlete_id'))
    elev = a.get('total_elevation_gain') or 0
    elev_by_athlete[aid] = elev_by_athlete.get(aid, 0) + elev
    acts_by_athlete[aid] = acts_by_athlete.get(aid, 0) + 1

print(f"\nPef D+ R21 recalculé (sans doublon) : {round(elev_by_athlete.get(PEF_ID, 0))}m")

# === 3. CHARGER LES VRAIES ÉQUIPES + RE-FIGER ===
with open(FROZEN_PATH, 'r', encoding='utf-8') as f:
    frozen = json.load(f)
with open(SEASON_TEAMS_PATH, 'r', encoding='utf-8') as f:
    season_teams = json.load(f)

r21 = frozen['rounds']['21']
true_teams = season_teams['4']['teams']

# Noms depuis le ranking existant (fallback sur season_teams)
name_by_id = {r['id']: r['name'] for r in r21.get('ranking', [])}
for t in true_teams:
    for m in t['members']:
        name_by_id.setdefault(m['id'], m['name'])

def make_team(t):
    members = []
    for m in t['members']:
        mid = m['id']
        elev = round(elev_by_athlete.get(mid, 0))
        members.append({
            'id': mid,
            'name': name_by_id.get(mid, m['name']),
            'elevation': elev,
            'activitiesCount': acts_by_athlete.get(mid, 0),
            'originalElevation': elev,
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
new_teams.sort(key=lambda t: -t['totalElevation'])

print('\nClassement R21 recalculé :')
for i, t in enumerate(new_teams):
    members_str = ' / '.join(f"{m['name']} {m['elevation']}m" for m in t['members'])
    marker = ' ← ÉLIMINÉE' if i == len(new_teams) - 1 else ''
    print(f"  {i+1}. {t['animal']['emoji']} {t['animal']['name']:10s} = {t['totalElevation']:>5}m  ({members_str}){marker}")

eliminated_team_data = new_teams[-1]

# Garde-fou : confirmer que c'est bien Aigle (Option A)
if eliminated_team_data['animal']['id'] != 'aigle':
    print(f"\n⚠️ ATTENTION : l'équipe éliminée est {eliminated_team_data['animal']['name']}, pas Aigle !")
    print("   Le recalcul ne donne pas Aigle comme plus faible. Vérifier les données.")
    print("   Le script continue mais VÉRIFIE le résultat ci-dessus.")
    resp = input("   Continuer quand même ? (oui/non) : ")
    if resp.strip().lower() not in ('oui', 'o', 'yes', 'y'):
        print("   Annulé. Backups conservés.")
        sys.exit(1)

eliminated_team = dict(eliminated_team_data)
eliminated_team['eliminationReason'] = 'team_elimination'
eliminated_ids = {m['id'] for m in eliminated_team['members']}

# Re-construire le ranking
new_ranking = []
position = 1
for t in new_teams:
    for m in sorted(t['members'], key=lambda m: -m['elevation']):
        new_ranking.append({
            'id': m['id'], 'name': m['name'], 'elevation': m['elevation'],
            'activitiesCount': m['activitiesCount'], 'originalElevation': m['originalElevation'],
            'bonusPoints': 0, 'position': position,
            'teamIndex': t['index'], 'teamAnimal': t['animal'], 'teamColor': t['color'],
            'mainPoints': 0
        })
        position += 1

# mainPoints éliminés : 1 pt pour le mieux classé des éliminés, 0 pour les autres
elim_in_ranking = sorted([r for r in new_ranking if r['id'] in eliminated_ids], key=lambda r: r['position'])
for idx, r in enumerate(elim_in_ranking):
    r['eliminatedPosition'] = r['position']
    r['mainPoints'] = 1 if idx == 0 else 0

eliminations = []
for r in elim_in_ranking:
    eliminations.append({
        'id': r['id'], 'name': r['name'], 'elevation': r['elevation'],
        'reason': 'team_elimination', 'position': r['position'],
        'teamIndex': eliminated_team_data['index'],
        'teamAnimal': eliminated_team_data['animal'],
        'teamColor': eliminated_team_data['color']
    })
eliminations.sort(key=lambda e: -e['position'])

# Appliquer
r21['ranking'] = new_ranking
r21['eliminations'] = eliminations
r21['teams'] = new_teams
r21['eliminatedTeam'] = eliminated_team
r21['stats']['eliminationsCount'] = len(eliminations)
r21['stats']['totalElevation'] = sum(t['totalElevation'] for t in new_teams)
r21['frozenAt'] = NOW_ISO
r21['frozenMethod'] = 'recalculated_correct_teams_no_dup'

with open(FROZEN_PATH + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(frozen, f, indent=2, ensure_ascii=False)
os.replace(FROZEN_PATH + '.tmp', FROZEN_PATH)

print(f"\n✅ R21 re-figé : équipe {eliminated_team['animal']['emoji']} {eliminated_team['animal']['name']} éliminée")
print(f"   Éliminés : {', '.join(e['name'] for e in eliminations)}")
print(f"\n⚠️  Étapes suivantes :")
print(f"   1. pm2 restart versant-api  (recharger les données en mémoire)")
print(f"   2. Vérifier l'affichage du challenge éliminés sur le site")
print(f"   3. Lancer /opt/versant-api/scripts/versant-backup-data.sh pour archiver")
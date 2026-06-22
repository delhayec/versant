#!/bin/bash
# Purge les sessions expirées et déduplique par athlete_id
# (garde uniquement la session la plus récente non-expirée par utilisateur)

set -e

SESSIONS_FILE="/opt/versant-api/backend/data/sessions.json"
LOG_FILE="/var/log/versant-sessions-purge.log"

if [ ! -f "$SESSIONS_FILE" ]; then
  echo "$(date -Iseconds) Fichier sessions.json introuvable" >> "$LOG_FILE"
  exit 1
fi

# Backup au cas où
cp "$SESSIONS_FILE" "$SESSIONS_FILE.bak"

python3 << EOF >> "$LOG_FILE" 2>&1
import json
from datetime import datetime, timezone
from collections import defaultdict

with open("$SESSIONS_FILE") as f:
    sessions = json.load(f)

before = len(sessions)
now = datetime.now(timezone.utc)

# Étape 1 : filtrer les sessions expirées
active = [s for s in sessions if datetime.fromisoformat(s['expires_at'].replace('Z', '+00:00')) > now]

# Étape 2 : garder uniquement la plus récente par athlete_id
by_athlete = defaultdict(list)
for s in active:
    by_athlete[s['athlete_id']].append(s)

deduplicated = []
for aid, sess_list in by_athlete.items():
    # Trier par created_at descendant, garder la première
    sess_list.sort(key=lambda x: x['created_at'], reverse=True)
    deduplicated.append(sess_list[0])

after = len(deduplicated)
removed = before - after

print(f"[{datetime.now(timezone.utc).isoformat()}] Purge sessions : {before} → {after} (-{removed})")

with open("$SESSIONS_FILE", 'w') as f:
    json.dump(deduplicated, f, indent=2)
EOF

# Si tout s'est bien passé, supprimer le backup
if [ $? -eq 0 ]; then
  rm "$SESSIONS_FILE.bak"
fi
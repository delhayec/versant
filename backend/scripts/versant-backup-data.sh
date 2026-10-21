#!/bin/bash
#
# versant-backup-data.sh — sauvegarde nocturne de backend/data vers le dépôt
# privé versant-data (cron : /opt/versant-api/scripts/versant-backup-data.sh).
#
# Copie TOUT le dossier des données, quelle que soit son organisation (fichiers
# à la racine, ou activities/ et leagues/<ligue>/editions/<édition>/ depuis la
# bascule L32), sauf les sessions et les journaux de webhooks. L'ancienne
# version copiait une liste fixe de fichiers : elle oubliait round_configs.json,
# season_planning.json et special_rules.json, et n'aurait plus rien sauvegardé
# après la bascule.
#
# --delete : data/ dans le dépôt reflète exactement la source ; les versions
# précédentes restent dans l'historique git.
#
set -euo pipefail

SOURCE_DIR="/opt/versant-api/backend/data"
BACKUP_REPO="/opt/versant-data"

if [ ! -d "$BACKUP_REPO/.git" ]; then
  echo "❌ Le repo de backup n'existe pas à $BACKUP_REPO"
  exit 1
fi

echo "📂 Copie du dossier des données..."
mkdir -p "$BACKUP_REPO/data"
rsync -a --delete \
  --exclude 'sessions.json' \
  --exclude 'webhook_log.json' \
  --exclude 'failed_webhooks.json' \
  --exclude '*.tmp' \
  --exclude 'retour-sauvegarde-*/' \
  "$SOURCE_DIR/" "$BACKUP_REPO/data/"

cd "$BACKUP_REPO"
git add -A

if git diff --cached --quiet; then
  echo "✅ Aucun changement réel à archiver ($(date '+%Y-%m-%d %H:%M'))"
  exit 0
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
git commit -q -m "backup: données du $TIMESTAMP"
git push -q origin master

echo "✅ Backup poussé vers versant-data ($TIMESTAMP) : $(git show --stat --format= HEAD | tail -1)"

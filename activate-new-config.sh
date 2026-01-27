#!/bin/bash
# ============================================
# VERSANT - Script d'activation nouvelle configuration
# ============================================
# Ce script sauvegarde les anciennes configs et active les nouvelles

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JS_DIR="$SCRIPT_DIR/public/js"
BACKUP_DIR="$SCRIPT_DIR/backup_$(date +%Y%m%d_%H%M%S)"

echo "🔄 Activation de la nouvelle architecture de configuration Versant"
echo "=================================================="

# Créer le dossier de backup
mkdir -p "$BACKUP_DIR"
echo "📁 Dossier de backup créé: $BACKUP_DIR"

# Sauvegarder les anciens fichiers
echo ""
echo "💾 Sauvegarde des anciens fichiers..."

if [ -f "$JS_DIR/config.js" ]; then
    cp "$JS_DIR/config.js" "$BACKUP_DIR/config.js.bak"
    echo "   ✓ config.js sauvegardé"
fi

if [ -f "$JS_DIR/config-2026.js" ]; then
    cp "$JS_DIR/config-2026.js" "$BACKUP_DIR/config-2026.js.bak"
    echo "   ✓ config-2026.js sauvegardé"
fi

# Activer les nouvelles configurations
echo ""
echo "🚀 Activation des nouvelles configurations..."

if [ -f "$JS_DIR/config.js.new" ]; then
    cp "$JS_DIR/config.js.new" "$JS_DIR/config.js"
    echo "   ✓ config.js.new → config.js"
fi

# La config-demo.js est déjà en place

echo ""
echo "✅ Configuration activée avec succès !"
echo ""
echo "📋 Fichiers actifs:"
echo "   - league-config.js (configuration de base partagée)"
echo "   - config.js (production 2025)"
echo "   - config-demo.js (démo 2026)"
echo ""
echo "🔙 Pour revenir à l'ancienne config:"
echo "   cp $BACKUP_DIR/config.js.bak $JS_DIR/config.js"
echo ""
echo "🧪 Pensez à tester les fonctionnalités:"
echo "   1. Page d'accueil / Classement"
echo "   2. Interface admin - Section Jokers"
echo "   3. Inscription d'un nouvel athlète"

# Versant - Refactorisation Configuration & Système de Jokers

## 📋 Résumé des modifications

### 1. Architecture de Configuration Partagée

**Nouveau fichier : `/public/js/league-config.js`**
- Configuration de base partagée entre production et démo
- Types de saisons (standard, distance, équipes)
- Types de jokers avec règles
- Règles de rounds spéciaux (pentes raides, hors bitume, etc.)
- Fonctions utilitaires (dates, affichage bonus)

**Fichiers de config refactorisés :**
- `config.js` → Importe league-config.js + settings 2025
- `config-demo.js` → Importe league-config.js + settings démo 2026

### 2. Système de Jokers/Bonus Amélioré

**Nouveau module : `/backend/jokers-routes.js`**

**Stock initial par athlète :** 2 de chaque type

**Types de jokers :**

| Joker | Effet | Restrictions |
|-------|-------|--------------|
| ⚔️ Duel | Vole 25% du D+ de l'adversaire si victoire | Pas utilisable le dernier jour du round |
| ✖️ Multiplicateur | ×2 sur le D+ d'un jour choisi | - |
| 🛡️ Bouclier | Protection contre l'élimination | Pas utilisable en finale |
| 💣 Sabotage | Retire 250m fixe à un adversaire | - |

**Routes API ajoutées :**
- `GET /api/admin/jokers/:leagueId` - Voir tous les stocks
- `PUT /api/admin/jokers/:athleteId` - Modifier un stock (admin)
- `POST /api/admin/jokers/reset/:leagueId` - Reset tous les jokers
- `POST /api/jokers/use-v2` - Utiliser un joker (auth requise)
- `GET /api/jokers/active/:roundNumber` - Jokers actifs d'un round
- `POST /api/admin/jokers/resolve/:usageId` - Résoudre après round

### 3. Interface Admin Enrichie

**Modifications dans `/public/admin.html` :**
- Nouvelle section "🃏 Gestion des Bonus / Jokers"
- Affichage des règles visuellement
- Tableau éditable du stock par athlète
- Historique d'utilisation des jokers
- Boutons Rafraîchir et Reset global

### 4. Styles CSS pour les Bonus

**Ajouts dans `/public/css/style.css` :**
- `.elevation-bonuses` - Détails des bonus sous le D+
- `.bonus-detail.multiplier/.duel-won/.duel-lost/.sabotage` - Badges colorés
- `.duel-icon` avec `.duel-tooltip` - Icône et info-bulle duel
- `.ranking-row.has-multiplier/.sabotaged` - Lignes mises en valeur
- `.joker-editor` - Interface d'édition admin
- `.activity-map-container` - Carte avec zones comptées

### 5. Affichage Visuel des Effets

**Exemple d'affichage D+ avec bonus :**
```
2500 m
(dont 500 ×2 • dont 300 volés à Baptiste • dont 250 sabotés par Thomas)
```

**Indicateurs dans le classement :**
- ⚔️ entre deux athlètes en duel
- Badge "×2" pour multiplicateur actif
- Lignes colorées selon les bonus actifs

## 📁 Fichiers créés/modifiés

### Nouveaux fichiers :
- `/public/js/league-config.js`
- `/public/js/config.js.new`
- `/public/js/config-demo.js`
- `/backend/jokers-routes.js`
- `/activate-new-config.sh`

### Fichiers modifiés :
- `/backend/server.js` (import + intégration routes jokers)
- `/public/admin.html` (section jokers + JS handlers)
- `/public/css/style.css` (styles bonus/jokers)

## 🚀 Activation

```bash
# Depuis le dossier versant/
chmod +x activate-new-config.sh
./activate-new-config.sh
```

## 🧪 Tests à effectuer

1. **Admin - Jokers**
   - [ ] Section jokers visible
   - [ ] Liste des athlètes avec stocks
   - [ ] Modification d'un stock
   - [ ] Reset global

2. **Configuration**
   - [ ] Classement s'affiche correctement
   - [ ] Dates des rounds OK
   - [ ] Types de sports reconnus

3. **Intégration**
   - [ ] Serveur démarre sans erreur
   - [ ] Routes API jokers répondent

## 📝 Notes importantes

- Le fichier `jokers_usage.json` stocke l'historique des utilisations
- Les stocks sont dans `athletes.json` champ `jokers_stock`
- Le module utilise le pattern factory pour l'injection de dépendances
- Les routes v2 des jokers coexistent avec les anciennes (migration progressive)

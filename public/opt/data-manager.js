/**
 * ============================================
 * VERSANT API - GESTION DES DONNÉES
 * ============================================
 * 
 * Lecture et écriture des fichiers JSON
 * avec gestion des erreurs et backups
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// Assurer que le dossier data existe
const dataDir = path.dirname(config.paths.tokens);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('📁 Dossier data/ créé');
}

/**
 * Lit un fichier JSON de manière sécurisée
 */
function readJSON(filepath) {
  try {
    if (!fs.existsSync(filepath)) {
      return null;
    }
    const content = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`❌ Erreur lecture ${filepath}:`, error.message);
    return null;
  }
}

/**
 * Écrit un fichier JSON avec backup automatique
 */
function writeJSON(filepath, data) {
  try {
    // Créer un backup si le fichier existe
    if (fs.existsSync(filepath)) {
      const backupPath = filepath.replace('.json', `.backup.json`);
      fs.copyFileSync(filepath, backupPath);
    }
    
    // Écrire les nouvelles données
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error(`❌ Erreur écriture ${filepath}:`, error.message);
    return false;
  }
}

// ============================================
// TOKENS (OAuth Strava)
// ============================================

/**
 * Récupère tous les tokens stockés
 * Structure: { "athlete_id": { access_token, refresh_token, expires_at, athlete } }
 */
function getTokens() {
  return readJSON(config.paths.tokens) || {};
}

/**
 * Récupère le token d'un athlète spécifique
 */
function getAthleteToken(athleteId) {
  const tokens = getTokens();
  return tokens[String(athleteId)] || null;
}

/**
 * Sauvegarde/met à jour le token d'un athlète
 */
function saveAthleteToken(athleteId, tokenData) {
  const tokens = getTokens();
  tokens[String(athleteId)] = {
    ...tokenData,
    updated_at: new Date().toISOString()
  };
  return writeJSON(config.paths.tokens, tokens);
}

/**
 * Supprime le token d'un athlète
 */
function removeAthleteToken(athleteId) {
  const tokens = getTokens();
  delete tokens[String(athleteId)];
  return writeJSON(config.paths.tokens, tokens);
}

// ============================================
// ACTIVITÉS
// ============================================

/**
 * Récupère toutes les activités stockées
 */
function getActivities() {
  return readJSON(config.paths.activities) || [];
}

/**
 * Sauvegarde les activités
 */
function saveActivities(activities) {
  return writeJSON(config.paths.activities, activities);
}

/**
 * Ajoute ou met à jour des activités pour un athlète
 * (évite les doublons par activity_id)
 */
function mergeActivities(newActivities) {
  const existing = getActivities();
  const existingIds = new Set(existing.map(a => a.id));
  
  let added = 0;
  let updated = 0;
  
  newActivities.forEach(activity => {
    if (existingIds.has(activity.id)) {
      // Mettre à jour l'activité existante
      const index = existing.findIndex(a => a.id === activity.id);
      existing[index] = activity;
      updated++;
    } else {
      // Ajouter la nouvelle activité
      existing.push(activity);
      added++;
    }
  });
  
  saveActivities(existing);
  return { added, updated, total: existing.length };
}

// ============================================
// JOKERS
// ============================================

/**
 * Récupère tous les jokers
 */
function getJokers() {
  return readJSON(config.paths.jokers) || {};
}

/**
 * Sauvegarde les jokers
 */
function saveJokers(jokers) {
  return writeJSON(config.paths.jokers, jokers);
}

/**
 * Récupère les jokers d'un athlète
 */
function getAthleteJokers(athleteId) {
  const jokers = getJokers();
  return jokers[String(athleteId)] || { pending: [], active: [], used: [] };
}

/**
 * Met à jour les jokers d'un athlète
 */
function saveAthleteJokers(athleteId, data) {
  const jokers = getJokers();
  jokers[String(athleteId)] = data;
  return saveJokers(jokers);
}

// ============================================
// EXPORT
// ============================================

module.exports = {
  // Générique
  readJSON,
  writeJSON,
  
  // Tokens
  getTokens,
  getAthleteToken,
  saveAthleteToken,
  removeAthleteToken,
  
  // Activités
  getActivities,
  saveActivities,
  mergeActivities,
  
  // Jokers
  getJokers,
  saveJokers,
  getAthleteJokers,
  saveAthleteJokers
};

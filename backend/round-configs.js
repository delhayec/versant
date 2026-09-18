/**
 * Module de gestion des configurations de round.
 * Permet à l'admin de surcharger le comportement par défaut d'un round :
 * - nbEliminations : nombre d'éliminations forcées (minimum 2 normalement,
 *   override la règle "tous les inactifs" SAUF si nb_inactifs > nbEliminations)
 * - type : 'standard' | 'finale' | 'bonus_round' | 'no_eliminations'
 * - specialRule : alias de SPECIAL_RULES (handicap, combinado, etc.)
 *
 * Rounds sans config explicite suivent le comportement standard (rétrocompatibilité).
 */

const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIGS_FILE = path.join(DATA_DIR, 'round_configs.json');

const VALID_TYPES = ['standard', 'finale', 'bonus_round', 'no_eliminations'];

// Règles réellement implémentées côté calcul. Sans cette liste, une faute de
// frappe dans l'admin produirait une règle sans aucun effet, silencieusement :
// getSpecialRuleForRound() renverrait { id: 'handicpa' } sans paramètres.
const VALID_SPECIAL_RULES = ['standard', 'handicap', 'no_bonus', 'pluie_qui_mouille'];

async function loadRoundConfigs() {
  try {
    const content = await fs.readFile(CONFIGS_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

async function getRoundConfig(roundNumber) {
  const configs = await loadRoundConfigs();
  return configs[String(roundNumber)] || null;
}

async function saveRoundConfig(roundNumber, config) {
  const configs = await loadRoundConfigs();
  const key = String(roundNumber);

  if (config === null) {
    delete configs[key];
  } else {
    const validated = {};
    if (typeof config.nbEliminations === 'number' && config.nbEliminations >= 0) {
      validated.nbEliminations = config.nbEliminations;
    }
    if (typeof config.type === 'string' && VALID_TYPES.includes(config.type)) {
      validated.type = config.type;
    }
    if (typeof config.specialRule === 'string') {
      if (!VALID_SPECIAL_RULES.includes(config.specialRule)) {
        throw new Error('Règle spéciale inconnue: ' + config.specialRule);
      }
      validated.specialRule = config.specialRule;
    }
    configs[key] = validated;
  }

  await fs.writeFile(CONFIGS_FILE, JSON.stringify(configs, null, 2));
  return configs[key] || null;
}

async function deleteRoundConfig(roundNumber) {
  return await saveRoundConfig(roundNumber, null);
}

module.exports = {
  loadRoundConfigs,
  getRoundConfig,
  saveRoundConfig,
  deleteRoundConfig,
  VALID_TYPES,
  VALID_SPECIAL_RULES
};
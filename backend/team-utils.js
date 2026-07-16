/**
 * ============================================
 * VERSANT - UTILITAIRES SAISON ÉQUIPES
 * ============================================
 * Fonctions backend pour la gestion des saisons en mode équipe (saison 4
 * notamment).
 *
 * formBalancedTeams / seededRandom / TEAM_COLORS proviennent désormais du
 * module partagé public/shared/team-formation.js (source unique consommée
 * aussi par le frontend), afin que backend et frontend voient EXACTEMENT les
 * mêmes équipes pour un même seed. Ce module ne conserve que la logique
 * spécifique backend : noms d'animaux et assignTeamAnimals.
 */

const {
  TEAM_COLORS,
  seededRandom,
  formBalancedTeams
} = require('../public/shared/team-formation.js');

// ============================================
// NOMS D'ÉQUIPES (animaux de montagne)
// ============================================
const TEAM_ANIMALS = [
  { id: 'loup',       emoji: '🐺', name: 'Loup' },
  { id: 'aigle',      emoji: '🦅', name: 'Aigle' },
  { id: 'marmotte',   emoji: '🦫', name: 'Marmotte' },
  { id: 'raton',      emoji: '🦝', name: 'Raton' },
  { id: 'ecureuil',   emoji: '🐿️',  name: 'Écureuil' },
  { id: 'lapin',      emoji: '🐇', name: 'Lapin' },
  { id: 'mouflon',    emoji: '🐏', name: 'Mouflon' },
  { id: 'chenille',   emoji: '🐛', name: 'Chenille' },
  { id: 'bouquetin',  emoji: '🐐', name: 'Bouquetin' },
  { id: 'renard',     emoji: '🦊', name: 'Renard' },
  { id: 'lynx',       emoji: '😺', name: 'Lynx' },
  { id: 'ours',       emoji: '🐻', name: 'Ours' },
  { id: 'mammouth',   emoji: '🦣', name: 'Mammuth' },
  { id: 'sanglier',   emoji: '🐗', name: 'Sanglier' },
  { id: 'canard',     emoji: '🦆', name: 'Canard' },
  { id: 'panda',      emoji: '🐼', name: 'Panda' },
  { id: 'chouette',   emoji: '🦉', name: 'Chouette' },
  { id: 'loutre',     emoji: '🦦', name: 'Loutre' }
];

// ============================================
// ASSIGN ANIMAL NAMES TO TEAMS
// ============================================
/**
 * Attribue un nom d'animal unique à chaque équipe d'un round, en évitant
 * les noms déjà utilisés dans les rounds précédents de la même saison.
 *
 * @param {Array} teams - Équipes du round courant (issues de formBalancedTeams)
 * @param {Set<string>} usedAnimalIds - IDs d'animaux déjà attribués cette saison
 * @param {number} seed - Pour le tirage reproductible
 * @returns {Array} Équipes enrichies avec { animal: { id, name, emoji } }
 */
function assignTeamAnimals(teams, usedAnimalIds, seed = 0) {
  const random = seededRandom(seed * 31 + 7); // décalage pour différer du seed équipes
  const available = TEAM_ANIMALS.filter(a => !usedAnimalIds.has(a.id));

  // Mélange Fisher-Yates
  const pool = [...available];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return teams.map((team, idx) => ({
    ...team,
    animal: pool[idx] || TEAM_ANIMALS[idx % TEAM_ANIMALS.length] // fallback safety
  }));
}

module.exports = {
  TEAM_ANIMALS,
  TEAM_COLORS,
  formBalancedTeams,
  assignTeamAnimals,
  seededRandom
};
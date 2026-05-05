/**
 * ============================================
 * VERSANT - UTILITAIRES SAISON ÉQUIPES
 * ============================================
 * Fonctions backend pour la gestion des saisons en mode équipe (saison 4
 * notamment). Mirror des fonctions frontend public/js/config.js.
 *
 * IMPORTANT : la fonction formBalancedTeams doit produire EXACTEMENT le même
 * résultat que la version frontend pour un même `seed` afin que le backend
 * et le frontend voient les mêmes équipes.
 */

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
  { id: 'canard',     emoji: '🪿', name: 'Canard' },
  { id: 'panda',      emoji: '🐼', name: 'Panda' },
  { id: 'chouette',   emoji: '🦉', name: 'Chouette' },
  { id: 'loutre',     emoji: '🦦', name: 'Loutre' }
];

// ============================================
// COULEURS
// ============================================
const TEAM_COLORS = [
  { bg: 'rgba(249, 115, 22, 0.15)', border: '#f97316', name: 'Orange' },
  { bg: 'rgba(34, 211, 238, 0.15)', border: '#22d3ee', name: 'Cyan' },
  { bg: 'rgba(168, 85, 247, 0.15)', border: '#a855f7', name: 'Violet' },
  { bg: 'rgba(16, 185, 129, 0.15)', border: '#10b981', name: 'Vert' },
  { bg: 'rgba(244, 63, 94, 0.15)', border: '#f43f5e', name: 'Rose' },
  { bg: 'rgba(234, 179, 8, 0.15)', border: '#eab308', name: 'Or' }
];

// ============================================
// PRNG REPRODUCTIBLE (LCG)
// ============================================
function seededRandom(s) {
  let state = (s | 0) || 1;
  return function() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

// ============================================
// EVALUATION : écart-type des sommes de points
// ============================================
function evaluateStdDev(teams) {
  const sums = teams.map(t => t.reduce((s, p) => s + (p.points || 0), 0));
  const mean = sums.reduce((s, v) => s + v, 0) / sums.length;
  const variance = sums.reduce((s, v) => s + (v - mean) ** 2, 0) / sums.length;
  return Math.sqrt(variance);
}

// ============================================
// FORME DES ÉQUIPES ÉQUILIBRÉES
// ============================================
/**
 * Forme des équipes équilibrées par points du classement général.
 * Brute-force exhaustif pour ≤12 joueurs, échantillonnage pour 13+.
 *
 * Cas spécial 14/16 joueurs (5 équipes dont 1 à 4 joueurs) :
 *   On forme N-1 équipes de 3 et 1 équipe de 4 (ou des variations selon n%3).
 *   La 4e personne va dans l'équipe avec le plus grand écart-type des points
 *   internes (= équipe la moins homogène, donc bénéficie de l'apport).
 *
 * @param {Array} athletes - Liste des athlètes actifs [{id, name, ...}]
 * @param {Object} pointsMap - Points par athlète {id: points}
 * @param {number} seed - Graine pour le tirage (basé sur le round number)
 * @param {number} teamSize - Taille cible des équipes (défaut 3)
 * @returns {Array} Équipes [{ index, color, members: [{id, name, points}], totalPoints }]
 */
function formBalancedTeams(athletes, pointsMap, seed = 0, teamSize = 3) {
  const n = athletes.length;
  if (n < 2) {
    return [{
      index: 0,
      color: TEAM_COLORS[0],
      members: athletes.map(a => ({ ...a, points: pointsMap[a.id] || 0 })),
      totalPoints: 0
    }];
  }

  // STRATÉGIE :
  //   - Si n % teamSize === 0 : k équipes parfaites de teamSize.
  //   - Sinon : on identifie les `n % teamSize` joueurs avec LE MOINS de points
  //     (= les plus faibles au classement annuel) comme "extras". On les met
  //     de côté, on équilibre les autres en équipes de teamSize, puis on
  //     distribue les extras dans l'équipe ayant le plus grand écart-type
  //     interne (= équipe la moins homogène). Cela respecte la règle métier :
  //     "celle qui regroupe les plus mauvais au classement général".
  const teamsOfFull = Math.floor(n / teamSize);
  const remainder = n % teamSize;

  const players = athletes.map(a => ({ ...a, points: pointsMap[a.id] || 0 }));
  const random = seededRandom(seed);

  // Identifier les `remainder` joueurs avec le moins de points (extras forcés).
  // On trie une copie pour ne pas modifier l'ordre des athlètes.
  let forcedExtras = [];
  let baseTeamPlayers = [...players];
  if (remainder > 0) {
    const sortedByPoints = [...players].sort((a, b) => (a.points || 0) - (b.points || 0));
    forcedExtras = sortedByPoints.slice(0, remainder);
    const extraIds = new Set(forcedExtras.map(p => p.id));
    baseTeamPlayers = players.filter(p => !extraIds.has(p.id));
  }

  function teamStdDev(team) {
    if (team.length <= 1) return 0;
    const sum = team.reduce((s, p) => s + (p.points || 0), 0);
    const mean = sum / team.length;
    const variance = team.reduce((s, p) => s + ((p.points || 0) - mean) ** 2, 0) / team.length;
    return Math.sqrt(variance);
  }

  function buildTeams(arr) {
    const teams = [];
    let idx = 0;
    for (let t = 0; t < teamsOfFull; t++) {
      teams.push(arr.slice(idx, idx + teamSize));
      idx += teamSize;
    }
    return teams;
  }

  // Distribue les forcedExtras sur les équipes en visant celles avec le
  // plus grand écart-type interne. Modifie `teams` en place.
  // Règle : un extra par équipe maximum (donc remainder doit être <= teams.length).
  function distributeExtras(teams) {
    if (forcedExtras.length === 0) return;
    const remaining = [...forcedExtras];
    const usedTeams = new Set();
    while (remaining.length > 0) {
      const candidatesIdx = teams
        .map((t, i) => ({ idx: i, sd: teamStdDev(t) }))
        .filter(c => !usedTeams.has(c.idx));
      if (candidatesIdx.length === 0) {
        // Plus de cibles uniques (ne devrait pas arriver si remainder <= teams.length)
        // Fallback : distribuer dans la moins peuplée
        candidatesIdx.push(...teams.map((t, i) => ({ idx: i, sd: 1 / t.length })));
      }
      candidatesIdx.sort((a, b) => b.sd - a.sd);
      const targetIdx = candidatesIdx[0].idx;
      teams[targetIdx].push(remaining.shift());
      usedTeams.add(targetIdx);
    }
  }

  let candidates = [];

  if (baseTeamPlayers.length <= 12) {
    // BRUTE FORCE sur les baseTeamPlayers
    function* allCombosOfK(arr, k) {
      if (k === 0) { yield []; return; }
      if (k > arr.length) return;
      for (let i = 0; i <= arr.length - k; i++) {
        for (const sub of allCombosOfK(arr.slice(i + 1), k - 1)) {
          yield [i, ...sub.map(j => j + i + 1)];
        }
      }
    }

    function* generatePartitions(remaining, teams, fullLeft) {
      if (remaining.length === 0) {
        if (fullLeft === 0) yield teams.map(t => [...t]);
        return;
      }
      const first = remaining[0];
      const rest = remaining.slice(1);

      if (fullLeft > 0 && rest.length >= teamSize - 1) {
        const indices = Array.from({ length: rest.length }, (_, i) => i);
        for (const picks of allCombosOfK(indices, teamSize - 1)) {
          const team = [first, ...picks.map(i => rest[i])];
          const newRemaining = rest.filter((_, k) => !picks.includes(k));
          yield* generatePartitions(newRemaining, [...teams, team], fullLeft - 1);
        }
      }
    }

    for (const partition of generatePartitions(baseTeamPlayers, [], teamsOfFull)) {
      const teams = partition.map(t => [...t]);
      distributeExtras(teams);
      const stdDev = evaluateStdDev(teams);
      candidates.push({ teams, stdDev });
    }
  } else {
    // ÉCHANTILLONNAGE pour 13+ joueurs base (donc 13/14/16+ joueurs total)
    const NUM_SAMPLES = 50000;
    for (let sample = 0; sample < NUM_SAMPLES; sample++) {
      const shuffled = [...baseTeamPlayers];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const teams = buildTeams(shuffled);
      distributeExtras(teams);
      const stdDev = evaluateStdDev(teams);
      candidates.push({ teams, stdDev });
    }
  }

  candidates.sort((a, b) => a.stdDev - b.stdDev);
  const KEEP_BEST = Math.min(16, candidates.length);
  const best = candidates.slice(0, KEEP_BEST);
  const chosen = best[Math.floor(random() * best.length)];

  return chosen.teams.map((members, teamIdx) => ({
    index: teamIdx,
    color: TEAM_COLORS[teamIdx % TEAM_COLORS.length],
    members: members.sort((a, b) => (b.points || 0) - (a.points || 0)),
    totalPoints: members.reduce((s, p) => s + (p.points || 0), 0)
  }));
}

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
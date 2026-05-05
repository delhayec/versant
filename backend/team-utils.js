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
  { id: 'chevreuil',  emoji: '🦌', name: 'Chevreuil' },
  { id: 'ecureuil',   emoji: '🐿️',  name: 'Écureuil' },
  { id: 'lapin',      emoji: '🐰', name: 'Lapin' },
  { id: 'mouflon',    emoji: '🐏', name: 'Mouflon' },
  { id: 'dahu',       emoji: '🦬', name: 'Dahu' },
  { id: 'bouquetin',  emoji: '🐐', name: 'Bouquetin' },
  { id: 'renard',     emoji: '🦊', name: 'Renard' },
  { id: 'lynx',       emoji: '😺', name: 'Lynx' },
  { id: 'ours',       emoji: '🐻', name: 'Ours' },
  { id: 'chamois',    emoji: '🐑', name: 'Chamois' },
  { id: 'sanglier',   emoji: '🐗', name: 'Sanglier' },
  { id: 'hermine',    emoji: '🪿', name: 'Hermine' },
  { id: 'cerf',       emoji: '🦌', name: 'Cerf' },
  { id: 'chouette',   emoji: '🦉', name: 'Chouette' },
  { id: 'castor',     emoji: '🦫', name: 'Castor' }
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

  // Déterminer la structure des équipes selon n
  // Règle : on vise des équipes de teamSize. Si n%teamSize !== 0 :
  //   - Si reste = teamSize-1 : on a (k-1) équipes de teamSize + 2 équipes de (teamSize-1)
  //     (ex: n=14, teamSize=3 → 4 équipes de 3 + 2 de 2... non on veut différent)
  //
  // POUR L'INSTANT : équipes uniformes de teamSize, avec gestion 14/16:
  //   n=14 (teamSize=3) → 4 équipes de 3 + 1 équipe de 2 → après ajustement : 4 équipes,
  //                       on ajoute le 5e joueur à l'équipe la moins homogène
  //                       Mais c'est le commit B (algo + tie-break + animaux).
  //
  // Pour le commit A, on garde le comportement actuel: equipes de 3 + reste en équipes de 2.
  // (15 joueurs → 5x3 = OK pour cette saison)

  let teamsOfFull = Math.floor(n / teamSize);
  let teamsOfShort = 0;
  const remainder = n % teamSize;

  if (remainder === 1) {
    teamsOfFull -= 1;
    teamsOfShort = 2; // 2 équipes de teamSize-1 (= 2)
  } else if (remainder === 2) {
    teamsOfShort = 1; // 1 équipe de teamSize-1 (= 2)
  }

  const players = athletes.map(a => ({ ...a, points: pointsMap[a.id] || 0 }));
  const random = seededRandom(seed);

  function buildTeams(arr) {
    const teams = [];
    let idx = 0;
    for (let t = 0; t < teamsOfFull; t++) { teams.push(arr.slice(idx, idx + teamSize)); idx += teamSize; }
    for (let t = 0; t < teamsOfShort; t++) { teams.push(arr.slice(idx, idx + (teamSize - 1))); idx += (teamSize - 1); }
    return teams;
  }

  let candidates = [];

  if (n <= 12) {
    // BRUTE FORCE : énumérer toutes les partitions
    function* generatePartitions(remaining, teams, fullLeft, shortLeft) {
      if (remaining.length === 0) {
        yield teams.map(t => [...t]);
        return;
      }
      const first = remaining[0];
      const rest = remaining.slice(1);

      if (fullLeft > 0) {
        // Former une équipe de teamSize
        const indices = [];
        function* combos(start, depth, picked) {
          if (depth === teamSize - 1) {
            yield picked;
            return;
          }
          for (let i = start; i < rest.length; i++) {
            yield* combos(i + 1, depth + 1, [...picked, i]);
          }
        }
        for (const picks of combos(0, 0, [])) {
          const team = [first, ...picks.map(i => rest[i])];
          const newRemaining = rest.filter((_, k) => !picks.includes(k));
          yield* generatePartitions(newRemaining, [...teams, team], fullLeft - 1, shortLeft);
        }
      }

      if (shortLeft > 0) {
        // Former une équipe de teamSize-1
        for (let i = 0; i < rest.length; i++) {
          const team = [first, rest[i]];
          const newRemaining = rest.filter((_, k) => k !== i);
          yield* generatePartitions(newRemaining, [...teams, team], fullLeft, shortLeft - 1);
        }
      }
    }

    for (const partition of generatePartitions(players, [], teamsOfFull, teamsOfShort)) {
      const stdDev = evaluateStdDev(partition);
      candidates.push({ teams: partition, stdDev });
    }
  } else {
    // ÉCHANTILLONNAGE pour 13+ joueurs
    const NUM_SAMPLES = 50000;
    for (let sample = 0; sample < NUM_SAMPLES; sample++) {
      const shuffled = [...players];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const teams = buildTeams(shuffled);
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
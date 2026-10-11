/**
 * VERSANT - PLANIFICATEUR DES SAISONS DEADLINE
 *
 * Une saison Deadline doit se terminer (finale comprise) à une date fixée.
 * Le planificateur choisit le nombre de rounds, la durée de chacun et le nombre
 * d'éliminations, dans les bornes du type de saison (3 à 7 jours, 1 à 4
 * éliminations), en restant le plus près possible du rythme habituel
 * (5 jours, 2 éliminations).
 *
 * Fonction pure : la lecture des données et l'écriture de round_configs.json
 * sont faites par frozen-results.js (replanDeadlineSeason).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Nombre de jours calendaires de `start` (inclus) à la date 'YYYY-MM-DD' (incluse). */
function daysUntilDeadline(start, deadline) {
  const [y, m, d] = String(deadline).split('-').map(Number);
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - startDay) / DAY_MS) + 1;
}

/**
 * Répartit `total` en `count` entiers aussi égaux que possible. Le surplus va
 * aux premiers éléments (fromEnd = false) ou aux derniers (fromEnd = true).
 */
function spread(total, count, fromEnd = false) {
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, i) => {
    const rank = fromEnd ? count - 1 - i : i;
    return base + (rank < extra ? 1 : 0);
  });
}

/**
 * @param {Object} p
 * @param {number} p.actives         joueurs encore en course au premier round planifié
 * @param {Date}   p.startDate       début du premier round planifié
 * @param {string} p.deadline        'YYYY-MM-DD', dernier jour de la finale
 * @param {number} p.finalists       joueurs visés en finale (CHALLENGE_CONFIG.finalistsCount)
 * @param {{min,max}} p.durationRange
 * @param {{min,max}} p.eliminationsRange
 * @param {number} [p.minFirstDuration] durée minimale du premier round (s'il a déjà commencé)
 * @param {number} [p.targetDuration=5]
 * @param {number} [p.targetEliminations=2]
 * @returns {{ rounds: Array<{durationDays, nbEliminations, isFinale}>, availableDays, plannedDays, exact, warning }}
 */
function planDeadlineRounds({
  actives, startDate, deadline, finalists,
  durationRange, eliminationsRange,
  minFirstDuration = durationRange.min,
  targetDuration = 5, targetEliminations = 2
}) {
  const availableDays = daysUntilDeadline(startDate, deadline);
  const toEliminate = Math.max(0, actives - finalists);
  const dMin = durationRange.min;
  const dMax = durationRange.max;

  // Nombre de rounds d'élimination possibles (la finale s'y ajoute)
  const kMin = toEliminate === 0 ? 0 : Math.ceil(toEliminate / eliminationsRange.max);
  const kMax = toEliminate === 0 ? 0 : Math.floor(toEliminate / eliminationsRange.min);

  let best = null;
  for (let k = kMin; k <= kMax; k++) {
    const roundsCount = k + 1;
    const minDays = dMin * roundsCount + Math.max(0, minFirstDuration - dMin);
    const maxDays = dMax * roundsCount;
    // Écart de jours à combler si la deadline est hors d'atteinte avec k rounds
    const daysGap = availableDays < minDays ? minDays - availableDays
      : availableDays > maxDays ? availableDays - maxDays : 0;
    const cost = daysGap * 100
      + Math.abs(availableDays / roundsCount - targetDuration)
      + (k > 0 ? Math.abs(toEliminate / k - targetEliminations) : 0);
    if (!best || cost < best.cost) best = { k, roundsCount, cost, daysGap, minDays, maxDays };
  }

  const { k, roundsCount } = best;
  const plannedDays = Math.min(Math.max(availableDays, best.minDays), best.maxDays);

  // Durées : réparties au plus égal, surplus sur les derniers rounds (finale
  // comprise) ; le premier round respecte sa durée minimale s'il a commencé.
  let durations = spread(plannedDays, roundsCount, true);
  if (durations[0] < minFirstDuration) {
    const firstDuration = minFirstDuration;
    durations = [firstDuration, ...spread(plannedDays - firstDuration, roundsCount - 1, true)];
  }
  const eliminations = k > 0 ? spread(toEliminate, k) : [];

  const rounds = durations.map((durationDays, i) => ({
    durationDays,
    nbEliminations: i < k ? eliminations[i] : null,
    isFinale: i === roundsCount - 1
  }));

  let warning = null;
  if (plannedDays < availableDays) {
    warning = `Deadline trop lointaine : la saison finira ${availableDays - plannedDays} jour(s) avant (rounds de ${dMax} jours maximum).`;
  } else if (plannedDays > availableDays) {
    warning = `Deadline trop proche : la saison finira ${plannedDays - availableDays} jour(s) après (rounds de ${dMin} jours minimum).`;
  }

  return { rounds, availableDays, plannedDays, exact: plannedDays === availableDays, warning };
}

module.exports = { planDeadlineRounds, daysUntilDeadline };

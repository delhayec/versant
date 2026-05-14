/**
 * ============================================
 * VERSANT - APPLICATION PRINCIPALE
 * ============================================
 * Logique métier uniquement :
 * - Chargement des données
 * - Calculs (classements, stats, éliminations)
 * - Orchestration des modules
 *
 * PAS DE HTML NI CSS ICI
 */

import {
  CHALLENGE_CONFIG, PARTICIPANTS, ROUND_RULES, JOKER_TYPES, BONUS_TYPES,
  SEASON_TYPES, SEASON_PLANNING, TEAM_COLORS,
  getParticipantById, getRoundDates, getSeasonNumber, getSeasonDates,
  getRoundInSeason, getGlobalRoundNumber, isFinaleRound, isValidSport,
  getRoundsPerSeason, getRoundsForSeason, getSeasonStartRound, getSeasonType,
  getMainChallengePoints, getEliminatedChallengePoints,
  getAthleteColor, getAthleteInitials, loadParticipants,
  getEligibleParticipants, getLateRegistrations, wasRegisteredBeforeStart,
  formBalancedTeams, loadSpecialRulesOverrides, getSpecialRuleForRound
} from './config.js';

import {
  initializeJokersState, useJoker as jokerUse,
  addJoker, removeJoker, applyJokerEffects,
  getJokerStock, getActiveJokersForRound, getPendingJokersForNextRound, getJokerStatusForRound
} from './jokers.js';

import {
  formatElevation, formatPosition,
  renderCombinedBanner, renderRanking,
  renderJokersGuide, renderArsenal, showNotification,
  showContextMenu, hideContextMenu, showTargetSelectionModal
} from './ui.js';

import { getCurrentDate, setSimulatedDate, initDemoMode } from './demo.js';

import {
  // Bonus helpers
  getBonusesUsedInRound,
  getArchivedBonusesForAthlete,
  getAllBonusesForAthlete,
  getEphemeralBonusEffectsForActiveAthlete,
  getEphemeralBonusEffectsForEliminatedAthlete,
  getSeasonalBonusEffectsForEliminatedAthlete,
  // Frozen helpers
  getFrozenRound,
  getRescapeFromPreviousRound,
  calculateRescapePointsForSeason,
  getRescapeInfoForRound,
  // Activity helpers
  getActivityEndTime,
  filterByPeriod,
  filterByParticipant,
  calculateStats,
  calculateRanking,
  applyHandicapRule,
  // Simulations
  simulateTeamSeasonEliminations,
  simulateSeasonEliminations,
  // Elim challenge
  calculateEliminatedChallenge,
  getCachedEliminatedChallengeRanking,
  countEliminationsBeforeRound,
  // Standings orchestrators
  calculateYearlyStandings,
  calculatePointsFromFrozenResults,
  calculatePointsForSeason,
  // Eliminated athlete helpers
  getRoundElevation,
  getEligibleActivitiesForBonus,
  findCoEliminated,
  getEliminatedElevationSince,
  getEliminatedActivities
} from './standings-engine.js';

// ============================================
// ÉTAT GLOBAL
// ============================================
let allActivities = [];
let currentRoundNumber = 1;
let currentSeasonNumber = 1;
let seasonData = null;
let yearlyStandingsCache = null;
let isAdminMode = false;
let frozenResultsCache = null; // Cache des résultats figés
let bonusesCache = []; // Cache des bonus éphémères
let seasonBonusesCache = {}; // Cache des bonus archivés par saison (depuis frozen_results)

// ============================================
// SYNC SNAPSHOT YEARLY STANDINGS → BACKEND
// ============================================
let _snapshotTimer = null;
let _snapshotLastSent = 0;
const SNAPSHOT_DEBOUNCE_MS = 2000;
const SNAPSHOT_MIN_INTERVAL_MS = 30000; // au plus 1 envoi/30s

function sendYearlyStandingsSnapshot(standings) {
  if (!Array.isArray(standings) || standings.length === 0) return;
  // Débouncer + rate limiter pour ne pas spammer le backend
  if (_snapshotTimer) clearTimeout(_snapshotTimer);
  _snapshotTimer = setTimeout(async () => {
    const now = Date.now();
    if (now - _snapshotLastSent < SNAPSHOT_MIN_INTERVAL_MS) return;
    _snapshotLastSent = now;
    try {
      await fetch('/api/standings/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ standings })
      });
    } catch (e) {
      // Échec non bloquant
    }
  }, SNAPSHOT_DEBOUNCE_MS);
}

// ============================================
// CHARGEMENT DES RÉSULTATS FIGÉS
// ============================================
async function loadFrozenResults() {
  try {
    const response = await fetch('/api/frozen-results');
    if (response.ok) {
      frozenResultsCache = await response.json();
      // Charger les bonus archivés dans frozen_results
      seasonBonusesCache = frozenResultsCache.seasonBonuses || {};
    }
  } catch (error) {
    console.warn('⚠️ Impossible de charger les résultats figés:', error);
    frozenResultsCache = { rounds: {} };
  }
}

/**
 * Charge tous les bonus éphémères depuis l'API
 */
async function loadBonuses() {
  try {
    const response = await fetch('/api/bonuses/all');
    if (response.ok) {
      bonusesCache = await response.json();
    }
  } catch (error) {
    console.warn('⚠️ Impossible de charger les bonus:', error);
    bonusesCache = [];
  }
}

/**
 * Génère la description d'un bonus pour l'historique
 */
function getBonusHistoryDescription(bonus) {
  const bonusType = BONUS_TYPES?.[bonus.bonus_id];
  const icon = bonusType?.icon || '🎁';
  const athleteName = bonus.athlete_name || 'Joueur';
  const targetName = bonus.target_athlete_name;
  const effectResult = bonus.effect_result;

  // Helper pour formater avec "m D+"
  const fmtElev = (val) => `${Math.round(val).toLocaleString('fr-FR')} m D+`;

  switch (bonus.bonus_id) {
    case 'embuscade':
      const stolenAmount = effectResult?.stolenElevation || effectResult?.amount || 0;
      return `${icon} ${athleteName} a tendu une embuscade à ${targetName} (${stolenAmount > 0 ? '-' + fmtElev(stolenAmount) : 'aucune activité volée'})`;
    case 'ravitaillement':
      const bonusAmount = effectResult?.bonusElevation || effectResult?.amount || 0;
      return `${icon} ${athleteName} a ravitaillé ${targetName || 'un joueur'} (+${fmtElev(bonusAmount)})`;
    case 'duel':
      const duelResult = effectResult?.won ? 'gagné' : 'perdu';
      const duelAmount = effectResult?.amount || 0;
      return `${icon} ${athleteName} a défié ${targetName} en duel (${duelResult}${duelAmount > 0 ? ', ' + fmtElev(duelAmount) + ' volés' : ''})`;
    case 'brouillard':
      return `${icon} ${athleteName} a activé le brouillard (D+ masqué)`;
    case 'marquage':
      // Affichage marquage selon résultat
      if (effectResult?.targetEliminated === true) {
        return `${icon} Marquage réussi : ${athleteName} avait marqué ${targetName} (éliminé) → +1 pt`;
      } else if (effectResult && Object.keys(effectResult).length > 0) {
        return `${icon} Marquage raté : ${athleteName} avait marqué ${targetName} qui a survécu ce round`;
      } else {
        return `${icon} ${athleteName} a marqué ${targetName} (+1 pt si éliminé ce round)`;
      }
    case 'trap':
      const trapAmount = effectResult?.stolenElevation || effectResult?.amount || 0;
      return `${icon} ${athleteName} a piégé ${targetName} (${trapAmount > 0 ? '-' + fmtElev(trapAmount) : 'piège déclenché'})`;
    case 'second_souffle':
      const savedFrom = effectResult?.savedFromElimination ? 'sauvé de l\'élimination' : 'protection active';
      return `${icon} ${athleteName} a utilisé son second souffle (${savedFrom})`;
    case 'kamikaze':
      const kamikazeAmount = effectResult?.targetPenalty || effectResult?.amount || 0;
      return `${icon} ${athleteName} a lancé une attaque kamikaze sur ${targetName} (-${fmtElev(kamikazeAmount)} chacun)`;
    case 'malediction':
      const curseAmount = effectResult?.stolenThisRound || 0;
      return `${icon} ${athleteName} a maudit ${targetName} (${curseAmount > 0 ? '-' + fmtElev(curseAmount) + ' ce round' : 'malédiction active'})`;
    default:
      return `${icon} ${athleteName} a utilisé ${bonusType?.name || bonus.bonus_id}${targetName ? ' sur ' + targetName : ''}`;
  }
}

// ============================================
// ÉCRAN D'ATTENTE AVANT LE CHALLENGE
// ============================================

function renderWaitingScreen(startDate) {
  const now = getCurrentDate();
  const daysUntilStart = Math.ceil((startDate - now) / (1000 * 60 * 60 * 24));
  const formattedDate = startDate.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  // Masquer le loader
  const loadingScreen = document.getElementById('loadingScreen');
  if (loadingScreen) {
    loadingScreen.style.display = 'none';
  }

  // Générer la liste des participants
  const participantsListHtml = PARTICIPANTS.map(p => `
    <div class="waiting-participant">
      <div class="participant-avatar-small" style="background:linear-gradient(135deg,${getAthleteColor(p.id)},${getAthleteColor(p.id)}88)">
        ${getAthleteInitials(p.id)}
      </div>
      <span class="participant-name-small">${p.name}</span>
    </div>
  `).join('');

  // Afficher l'écran d'attente dans les conteneurs principaux
  const banner = document.getElementById('seasonBanner');
  const ranking = document.getElementById('rankingContainer');
  const eliminated = document.getElementById('eliminatedChallengeContainer');
  const standings = document.getElementById('finalStandingsContainer');
  const participantsContainer = document.getElementById('participantsContainer');

  const waitingHtml = `
    <div class="waiting-screen">
      <div class="waiting-icon">◭️</div>
      <h2 class="waiting-title">Challenge Versant ${CHALLENGE_CONFIG.dataYear}</h2>
      <div class="waiting-countdown">
        <span class="countdown-number">${daysUntilStart}</span>
        <span class="countdown-label">jour${daysUntilStart > 1 ? 's' : ''} avant le départ</span>
      </div>
      <p class="waiting-date">Début le <strong>${formattedDate}</strong></p>
      <p class="waiting-info">Préparez-vous ! Le 1ᵉʳ round débutera à cette date.</p>
      <div class="waiting-participants">
        <span class="participants-count">${PARTICIPANTS.length}</span> participants inscrits
      </div>
    </div>
  `;

  const participantsGridHtml = `
    <div class="waiting-participants-section">
      <h3 class="waiting-section-title"> Participants inscrits</h3>
      <div class="waiting-participants-grid">
        ${participantsListHtml}
      </div>
      <p class="waiting-inscription-cta">
        <a href="inscription.html" class="btn-inscription">Pas encore inscrit ? Rejoignez le challenge !</a>
      </p>
    </div>
  `;

  if (banner) {
    banner.innerHTML = `
      <div class="banner-waiting">
        <span class="banner-icon"></span>
        <span class="banner-text">Challenge ${CHALLENGE_CONFIG.dataYear} • Début le ${startDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</span>
        <span class="banner-countdown">${daysUntilStart}j</span>
      </div>
    `;
  }

  if (ranking) {
    ranking.innerHTML = waitingHtml;
  }

  if (eliminated) {
    eliminated.innerHTML = participantsGridHtml;
  }

  if (standings) {
    standings.innerHTML = '<div class="empty-state"><p>Le classement sera disponible après le début du challenge</p></div>';
  }

  // Si la section participants existe, y afficher aussi la grille
  if (participantsContainer) {
    participantsContainer.innerHTML = participantsGridHtml;
  }

}

// ============================================
// CHARGEMENT DES DONNÉES
// ============================================

async function loadActivities() {
  // Déterminer le mode (démo vs production)
  const isDemo = CHALLENGE_CONFIG.isDemo || window.location.pathname.includes('demo');
  const dataFile = '/data/all_activities_2025.json';
  const leagueId = CHALLENGE_CONFIG.leagueId;


  // En mode DEMO, charger directement le fichier local 2025
  if (isDemo) {
    try {
      const localResponse = await fetch(dataFile);
      if (localResponse.ok) {
        const localData = await localResponse.json();
        allActivities = parseActivitiesData(localData);

        if (allActivities.length > 0) {
          const dates = allActivities.map(a => a.start_date?.substring(0, 10)).filter(Boolean);
          const uniqueDates = [...new Set(dates)].sort().reverse();
        }
        return allActivities;
      } else {
        console.error(`❌ Fichier démo introuvable: ${dataFile}`);
      }
    } catch (e) {
      console.error('❌ Erreur chargement fichier démo:', e);
    }
    return allActivities;
  }

  // Mode PRODUCTION: charger depuis l'API
  try {
    const response = await fetch(`/api/activities/${leagueId}`);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    allActivities = parseActivitiesData(data);

    // Debug: afficher les dates des activités
    if (allActivities.length > 0) {
      const dates = allActivities.map(a => a.start_date?.substring(0, 10)).filter(Boolean);
      const uniqueDates = [...new Set(dates)].sort().reverse();

      // Vérifier les activités du round actuel
      const today = new Date();
      const roundStart = new Date(CHALLENGE_CONFIG.yearStartDate);

      const recentActivities = allActivities.filter(a => {
        const d = new Date(a.start_date);
        return d >= roundStart;
      });
    } else {
      console.warn('⚠️ Aucune activité dans la réponse API');
    }

    return allActivities;
  } catch (error) {
    console.warn('⚠️ Erreur chargement API:', error.message);
    console.warn('⚠️ Tentative fichier local: /data/classement.json');
    try {
      const localResponse = await fetch('/data/classement.json');
      if (localResponse.ok) {
        const localData = await localResponse.json();
        allActivities = parseActivitiesData(localData);
        console.warn('⚠️ ATTENTION: Données locales utilisées, pas l\'API!');
      }
    } catch (e) {
      console.error('❌ Impossible de charger les données:', e);
    }
    return allActivities;
  }
}

/**
 * Parse différents formats de données d'activités
 * Supporte: tableau direct, {activities: []}, {ranking: [{activities: []}]}
 */
function parseActivitiesData(data) {
  // Si c'est déjà un tableau
  if (Array.isArray(data)) {
    return data.filter(a => !a.sport_type || isValidSport(a.sport_type));
  }

  // Si c'est {activities: [...]}
  if (data.activities && Array.isArray(data.activities)) {
    return data.activities.filter(a => !a.sport_type || isValidSport(a.sport_type));
  }

  // Si c'est {ranking: [{id, activities: [...]}]} (format classement.json)
  if (data.ranking && Array.isArray(data.ranking)) {
    const activities = [];
    for (const participant of data.ranking) {
      if (participant.activities && Array.isArray(participant.activities)) {
        for (const activity of participant.activities) {
          activities.push({
            ...activity,
            // Normaliser les champs pour compatibilité
            start_date: activity.date || activity.start_date,
            total_elevation_gain: activity.elevation || activity.total_elevation_gain,
            distance: activity.distance,
            // Si pas de sport_type, assumer que c'est valide (données pré-filtrées)
            sport_type: activity.sport_type || 'Run',
            // Ajouter les infos athlète pour le filtrage
            athlete: {
              id: participant.id,
              firstname: participant.name?.split(' ')[0] || '',
              lastname: participant.name?.split(' ').slice(1).join(' ') || ''
            }
          });
        }
      }
    }
    // Pour les données classement.json, pas besoin de re-filtrer par sport
    return activities;
  }

  console.warn('⚠️ Format de données non reconnu');
  return [];
}

// ============================================
// FILTRAGE DES ACTIVITÉS
// ============================================

// ============================================
// CALCULS STATISTIQUES
// ============================================

// ============================================
// SIMULATION DES ÉLIMINATIONS
// ============================================

// ============================================
// CHALLENGE DES ÉLIMINÉS
// ============================================
// ============================================
// CLASSEMENT ANNUEL
// ============================================

// ============================================
// RÉSUMÉ DE SAISON (pour l'historique)
// ============================================

function getSeasonSummary(activities, seasonNumber, currentDate) {
  const seasonDates = getSeasonDates(seasonNumber);
  const sData = simulateSeasonEliminations(activities, seasonNumber, currentDate, frozenResultsCache, yearlyStandingsCache);
  const rounds = [];
  const roundsPerSeason = getRoundsPerSeason();

  for (let r = 1; r <= roundsPerSeason; r++) {
    const globalRound = (seasonNumber - 1) * roundsPerSeason + r;
    const roundDates = getRoundDates(globalRound);
    if (currentDate < roundDates.start) break;

    const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
    // Filtrer les participants actifs à ce round (ceux qui n'ont pas été éliminés AVANT ce round)
    const activeAtRound = PARTICIPANTS.filter(p =>
      !sData.eliminated.some(e => e.eliminatedRound < r && e.id === p.id)
    );
    const ranking = calculateRanking(roundActivities, activeAtRound);

    rounds.push({
      roundInSeason: r,
      globalRound,
      dates: roundDates,
      winner: ranking[0]?.participant,
      winnerElevation: ranking[0]?.totalElevation || 0,
      // Filtrer par eliminatedRound (round dans la saison)
      eliminated: sData.eliminated.filter(e => e.eliminatedRound === r).map(e => e.name)
    });
  }

  // Calculer le classement du challenge des éliminés
  // Pour les saisons terminées ET figées, on lit directement le cache
  // (Phase 2/3 : eliminatedChallengeRankings). Sinon recalcul dynamique.
  const cachedElim = getCachedEliminatedChallengeRanking(seasonNumber, frozenResultsCache);
  let eliminatedRanking;

  if (cachedElim) {
    // Adapter le format cache vers le format attendu par l'historique (participant: {id, name, ...})
    eliminatedRanking = cachedElim.map(e => ({
      ...e,
      participant: e.participant || { id: e.id, name: e.name }
    }));
  } else {
    // Calcul dynamique : saison en cours OU saison finie mais pas encore figée
    eliminatedRanking = calculateEliminatedChallenge(
      activities, sData.eliminated, seasonDates,
      sData.seasonComplete ? seasonDates.end : currentDate
    );

    // Appliquer les bonus éphémères (embuscade, marquage, malédiction, kamikaze)
    // sur le classement des éliminés — identique à ce que fait renderEliminatedChallenge()
    const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
    const seasonEndRound = seasonNumber * roundsPerSeason;

    eliminatedRanking.forEach(e => {
      let gained = 0, lost = 0;
      const details = [];
      for (let roundNum = seasonStartRound; roundNum <= seasonEndRound; roundNum++) {
        const roundEffects = getEphemeralBonusEffectsForEliminatedAthlete(e.participant.id, roundNum, bonusesCache, seasonBonusesCache);
        gained += roundEffects.gained;
        lost += roundEffects.lost;
        details.push(...roundEffects.details);
      }
      // Ajouter les bonus saisonniers (second souffle, trap, etc.) UNE SEULE FOIS
      const seasonalEffects = getSeasonalBonusEffectsForEliminatedAthlete(e.participant.id, bonusesCache, seasonBonusesCache, allActivities, frozenResultsCache?.rounds, seasonNumber);
      gained += seasonalEffects.gained;
      lost += seasonalEffects.lost;
      details.push(...seasonalEffects.details);

      const netBonus = gained - lost;
      if (netBonus !== 0) {
        e.rawElevation = e.totalElevation;
        e.totalElevation = Math.max(0, e.totalElevation + netBonus);
      }
      e.bonusEffects = { gained, lost, details };
    });

    // Re-trier et re-assigner les positions/points après application des bonus
    eliminatedRanking.sort((a, b) => b.totalElevation - a.totalElevation);
    eliminatedRanking.forEach((e, i) => {
      e.position = i + 1;
      e.points = getEliminatedChallengePoints(e.position);
    });
  }

  return {
    seasonNumber,
    dates: seasonDates,
    isComplete: sData.seasonComplete,
    winner: sData.winner,
    rounds,
    eliminatedRanking
  };
}

// ============================================
// RENDU PRINCIPAL
// ============================================

async function renderAll() {
  try {
    const today = getCurrentDate();

    // Vérifier si le challenge a commencé
    const challengeStart = new Date(CHALLENGE_CONFIG.yearStartDate);
    if (today < challengeStart) {
      renderWaitingScreen(challengeStart);
      return;
    }

    // Passer frozenResultsCache pour détection robuste de la saison
    // (basée sur les saisons figées dans eliminatedChallengeRankings)
    currentSeasonNumber = getSeasonNumber(today, frozenResultsCache);

    currentRoundNumber = getGlobalRoundNumber(today);

    seasonData = simulateSeasonEliminations(allActivities, currentSeasonNumber, today, frozenResultsCache, yearlyStandingsCache);

    yearlyStandingsCache = calculateYearlyStandings(allActivities, today, frozenResultsCache, bonusesCache, seasonBonusesCache);

    // Snapshot vers backend (non bloquant, débouncé en cas de re-render rapide).
    // Permet au backend (saison team) et au script de tests de connaître les
    // points exacts du classement général sans dupliquer la logique de calcul.
    sendYearlyStandingsSnapshot(yearlyStandingsCache);

    // Detect special rule for current round
    const bannerSpecialRule = getSpecialRuleForRound(currentRoundNumber);
    const bannerRuleDetails = bannerSpecialRule ? (ROUND_RULES[bannerSpecialRule] || null) : null;

    // Banner
    const seasonBanner = document.getElementById('seasonBanner');
    if (seasonBanner) {
      renderCombinedBanner(seasonBanner, {
        currentSeasonNumber,
        currentRoundNumber,
        seasonData,
        currentDate: today,
        specialRule: bannerSpecialRule,
        specialRuleDetails: bannerRuleDetails
      });
    }

    // Classement
    const rankingContainer = document.getElementById('rankingContainer');
    if (rankingContainer) {
      const seasonType = getSeasonType(currentSeasonNumber);

      if (seasonType?.isTeamBased) {
        // MODE ÉQUIPE : récupérer les équipes depuis le backend (single source of truth)
        // Le backend gère le tirage équilibré + les noms d'animaux + le cache 30s.
        rankingContainer.innerHTML = '<div class="empty-state"><p>Chargement des équipes...</p></div>';
        try {
          const resp = await fetch(`/api/teams/round/${currentRoundNumber}`);
          if (resp.ok) {
            const teamData = await resp.json();
            if (Array.isArray(teamData.teams) && teamData.teams.length > 0) {
              // Enrichir chaque équipe avec le D+ courant des membres si pas déjà figé
              if (!teamData.frozen) {
                const roundDates = getRoundDates(currentRoundNumber);
                const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
                const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
                teamData.teams = teamData.teams.map(team => {
                  const membersWithElev = team.members.map(m => {
                    const acts = roundActivities.filter(a =>
                      String(a.athlete?.id || a.athlete_id) === String(m.id) && !a.excluded
                    );
                    const elev = acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
                    return { ...m, elevation: Math.round(elev), activitiesCount: acts.length };
                  });
                  return {
                    ...team,
                    members: membersWithElev,
                    totalElevation: membersWithElev.reduce((s, m) => s + m.elevation, 0)
                  };
                });
              }
              renderTeamRanking(rankingContainer, {
                teams: teamData.teams,
                seasonData,
                currentSeasonNumber,
                currentRoundNumber,
                isFrozen: !!teamData.frozen
              });
            } else {
              rankingContainer.innerHTML = '<div class="empty-state"><p>En attente des données d\'équipe...</p></div>';
            }
          } else {
            rankingContainer.innerHTML = '<div class="empty-state"><p>Erreur chargement équipes</p></div>';
          }
        } catch (e) {
          console.error('Erreur fetch teams:', e);
          rankingContainer.innerHTML = '<div class="empty-state"><p>Erreur réseau</p></div>';
        }
      } else {
        // MODE STANDARD : rendu classique
        const roundDates = getRoundDates(currentRoundNumber);
        const endDate = today < new Date(roundDates.end) ? today : roundDates.end;

      // DEBUG: Afficher les dates exactes

      const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);

      // DEBUG: Si pas d'activités, montrer pourquoi
      if (roundActivities.length === 0 && allActivities.length > 0) {
        const sampleDates = allActivities.slice(0, 5).map(a => a.start_date?.substring(0,10));
        console.warn('⚠️ Aucune activité dans la période! Exemples de dates disponibles:', sampleDates);
      }

      let ranking = calculateRanking(roundActivities, seasonData?.active || []);

      ranking = applyJokerEffects(ranking, currentRoundNumber);

      // Détecter la règle spéciale du round courant
      const currentRule = getSpecialRuleForRound(currentRoundNumber);
      const currentRuleDetails = currentRule ? (ROUND_RULES[currentRule] || null) : null;

      // Appliquer le handicap si actif
      if (currentRule === 'handicap' && yearlyStandingsCache) {
        ranking = applyHandicapRule(ranking, yearlyStandingsCache);
      }

      // Stats saison pour chaque participant
      const seasonDates = getSeasonDates(currentSeasonNumber);
      const seasonStats = {};
      PARTICIPANTS.forEach(p => {
        const pActivities = filterByParticipant(
          filterByPeriod(allActivities, seasonDates.start, endDate),
          p.id
        );
        seasonStats[p.id] = calculateStats(pActivities);
      });

      // Marquer la zone de danger (prend en compte l'override d'éliminations du handicap)
      const elimCount = currentRuleDetails?.parameters?.eliminationsOverride || CHALLENGE_CONFIG.eliminationsPerRound;
      ranking.forEach((e, i) => {
        e.isInDangerZone = i >= ranking.length - elimCount;
        if (e.jokerEffects?.hasShield && e.isInDangerZone) {
          e.isProtected = true;
          e.isInDangerZone = false;
        }
      });

      // Calculer le rescapé du round précédent (depuis frozen results)
      const rescapeId = getRescapeFromPreviousRound(currentRoundNumber, frozenResultsCache);

      // Calculer les effets des bonus éphémères pour chaque participant ACTIF
      const ephemeralEffects = {};
      ranking.forEach(e => {
        ephemeralEffects[e.participant.id] = getEphemeralBonusEffectsForActiveAthlete(e.participant.id, currentRoundNumber, bonusesCache, seasonBonusesCache);
      });

      renderRanking(rankingContainer, {
        ranking,
        seasonData,
        currentSeasonNumber,
        seasonStats,
        eliminationsCount: elimCount,
        currentRoundNumber,
        rescapeId,
        ephemeralEffects,
        specialRule: currentRule,
        specialRuleDetails: currentRuleDetails
      });
      } // fin else mode standard
    }

    // Arsenal (Jokers & Bonus)
    const arsenalContainer = document.getElementById('arsenalContainer');
    if (arsenalContainer) {
      renderArsenalSection(arsenalContainer, currentRoundNumber);
    }

    // Challenge des Éliminés
    const eliminatedContainer = document.getElementById('eliminatedChallengeContainer');
    if (eliminatedContainer) {
      renderEliminatedChallenge(eliminatedContainer);
    }

    // Classement Général
    const finalStandingsContainer = document.getElementById('finalStandingsContainer');
    if (finalStandingsContainer) {
      renderFinalStandings(finalStandingsContainer);
    }

    // Historique
    const historyTimeline = document.getElementById('historyTimeline');
    if (historyTimeline) {
      renderHistorySection(historyTimeline);
    }

    // Guide des jokers
    const jokersGuide = document.getElementById('jokersGuide');
    if (jokersGuide) {
      renderJokersGuide(jokersGuide);
    }

    // Ticker des activités récentes
    renderActivityTicker();

    // Récap saison précédente (visible 36h après début R1 saison suivante)
    checkAndShowRecapButton();


    // Masquer le loader avec transition - méthode robuste pour mobile
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      // Utiliser la classe CSS pour la transition
      loadingScreen.classList.add('hidden');
      // Fallback: forcer le masquage après la transition
      setTimeout(() => {
        loadingScreen.style.display = 'none';
        loadingScreen.style.visibility = 'hidden';
        loadingScreen.style.pointerEvents = 'none';
      }, 600);
    } else {
      console.warn('⚠️ loadingScreen non trouvé');
    }

  } catch (error) {
    console.error('❌ Erreur renderAll:', error);

    // Afficher l'erreur dans le loader
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      loadingScreen.innerHTML = '<div class="loading-content"><div class="loading-icon" style="font-size:64px">⚠️</div><div class="loading-title">Erreur</div><div class="loading-text">'+error.message+'</div></div>';
    }
  }
}

// ============================================
// RENDU: CHALLENGE DES ÉLIMINÉS
// ============================================
// RENDU: CLASSEMENT ÉQUIPES
// ============================================

function renderTeamRanking(container, data) {
  const { teams, seasonData, currentSeasonNumber, currentRoundNumber, isFrozen } = data;

  if (!teams || teams.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Aucune équipe formée</p></div>';
    return;
  }

  // Trier les équipes par D+ total décroissant
  const sortedTeams = [...teams].sort((a, b) => b.totalElevation - a.totalElevation);
  const lastTeamIdx = sortedTeams.length - 1;

  // Détecter le type de round (finale principale = 2 équipes restantes)
  const isFinalePrincipale = sortedTeams.length === 2;
  const headerLabel = isFinalePrincipale
    ? `🏆 Finale Saison Équipes`
    : `🤝 Saison Équipes — Round ${getRoundInSeason(getCurrentDate())}`;

  let html = `
    <div class="team-ranking">
      <div class="team-ranking-header">
        <span>${headerLabel}</span>
      </div>
  `;

  sortedTeams.forEach((team, teamPosition) => {
    const isLastTeam = teamPosition === lastTeamIdx;
    const teamColor = team.color || TEAM_COLORS[team.index % TEAM_COLORS.length];
    const animal = team.animal || null;
    const position = teamPosition + 1;

    // Médaille pour le top 3
    const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : '';

    // Nom équipe = animal en priorité, sinon couleur (fallback)
    const teamLabel = animal
      ? `${animal.emoji} ${animal.name}`
      : `Équipe ${teamColor.name}`;

    // Badge danger : "ÉLIMINÉE" si round figé, "ZONE D'ÉLIMINATION" sinon
    const dangerBadge = isLastTeam
      ? (isFrozen
          ? (isFinalePrincipale
              ? '<span class="team-danger-badge">FINALISTE VAINCU</span>'
              : '<span class="team-danger-badge">⛔ ÉLIMINÉE</span>')
          : '<span class="team-danger-badge">⚠️ Zone d\'élimination</span>')
      : (isFinalePrincipale && teamPosition === 0 && isFrozen
          ? '<span class="team-winner-badge">🏆 VAINQUEUR</span>'
          : '');

    html += `
      <div class="team-block ${isLastTeam ? 'team-danger' : ''}" style="border-left: 4px solid ${teamColor.border}; background: ${teamColor.bg};">
        <div class="team-block-header">
          <span class="team-position">${medal || '#' + position}</span>
          <span class="team-name">${teamLabel}</span>
          <span class="team-total-elevation">${formatElevation(team.totalElevation)}</span>
          ${dangerBadge}
        </div>
        <div class="team-members">
    `;

    // Membres triés par D+ décroissant
    const membersSorted = [...team.members].sort((a, b) => (b.elevation || 0) - (a.elevation || 0));
    membersSorted.forEach((member, memberIdx) => {
      const participant = getParticipantById(member.id);
      const name = participant?.name || member.name || '?';
      const color = getAthleteColor(member.id);
      const initials = getAthleteInitials(member.id);

      html += `
          <div class="team-member-row ${isLastTeam ? 'in-danger' : ''}">
            <div class="team-member-info">
              <div class="athlete-avatar-small" style="background:linear-gradient(135deg,${color},${color}88)">${initials}</div>
              <span class="team-member-name">${name}</span>
            </div>
            <span class="team-member-elevation">${formatElevation(member.elevation || 0)}</span>
          </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  html += '</div>';
  container.innerHTML = html;
}

// ============================================
// RENDU: CHALLENGE DES ÉLIMINÉS
// ============================================

function renderEliminatedChallenge(container) {
  if (!seasonData?.eliminated?.length) {
    container.innerHTML = '<div class="empty-state"><p>Aucun éliminé cette saison</p></div>';
    return;
  }

  const seasonDates = getSeasonDates(currentSeasonNumber);
  const ranking = calculateEliminatedChallenge(allActivities, seasonData.eliminated, seasonDates, getCurrentDate());

  if (ranking.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Les éliminés n\'ont pas encore d\'activités depuis leur élimination</p></div>';
    return;
  }

  // Déterminer qui a reçu un bonus éphémère (meilleur des 2 éliminés de chaque round)
  const bonusRecipients = getBonusRecipientsForSeason(currentSeasonNumber);

  // Calculer les effets de bonus pour chaque éliminé (cumulés sur toute la saison)
  const bonusEffectsByAthlete = {};
  for (const eliminated of seasonData.eliminated) {
    const effects = { gained: 0, lost: 0, details: [] };
    // Parcourir tous les rounds de la saison pour cumuler les effets par-round
    const roundsPerSeason = getRoundsPerSeason();
    const seasonStartRound = (currentSeasonNumber - 1) * roundsPerSeason + 1;
    const seasonEndRound = currentSeasonNumber * roundsPerSeason;
    for (let roundNum = seasonStartRound; roundNum <= seasonEndRound; roundNum++) {
      const roundEffects = getEphemeralBonusEffectsForEliminatedAthlete(eliminated.id, roundNum, bonusesCache, seasonBonusesCache);
      effects.gained += roundEffects.gained;
      effects.lost += roundEffects.lost;
      effects.details.push(...roundEffects.details);
    }
    // Ajouter les bonus saisonniers (second souffle, trap, etc.) UNE SEULE FOIS
    const seasonalEffects = getSeasonalBonusEffectsForEliminatedAthlete(eliminated.id, bonusesCache, seasonBonusesCache, allActivities, frozenResultsCache?.rounds, currentSeasonNumber);
    effects.gained += seasonalEffects.gained;
    effects.lost += seasonalEffects.lost;
    effects.details.push(...seasonalEffects.details);

    bonusEffectsByAthlete[eliminated.id] = effects;
  }

  // Appliquer les bonus éphémères au D+ total des éliminés
  ranking.forEach(e => {
    const bonusEffects = bonusEffectsByAthlete[e.participant.id] || { gained: 0, lost: 0 };
    const netBonus = bonusEffects.gained - bonusEffects.lost;
    if (netBonus !== 0) {
      e.totalElevation = Math.max(0, e.totalElevation + netBonus);
    }
  });

  // Re-trier et re-assigner les positions après application des bonus
  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.points = getEliminatedChallengePoints(e.position);
  });

  let html = '<div class="ranking-header"><div>Pos.</div><div>Athlète</div><div>D+ cumulé</div><div>Éliminé</div><div>Points</div></div>';
  ranking.forEach(e => {
    const hasBonus = bonusRecipients.has(String(e.participant.id));
    const bonusBadge = hasBonus ? '<span class="bonus-badge" title="Meilleur des 2 éliminés - A reçu un bonus éphémère">🎁</span>' : '';

    // Calculer les pilules de bonus éphémères
    const bonusEffects = bonusEffectsByAthlete[e.participant.id] || { gained: 0, lost: 0, details: [] };
    let bonusPills = '';

    // Générer une pilule descriptive par type de bonus
    for (const detail of (bonusEffects.details || [])) {
      switch (detail.type) {
        case 'embuscade_gain':
          bonusPills += `<span class="bonus-tag ephemeral-gained" title="Embuscade sur ${detail.from}">🏹 dont ${formatElevation(detail.amount, false)} m volés</span>`;
          break;
        case 'trap_gain':
          bonusPills += `<span class="bonus-tag ephemeral-gained" title="Piège déclenché sur ${detail.from}">🪤 dont ${formatElevation(detail.amount, false)} m piégés</span>`;
          break;
        case 'second_souffle':
          bonusPills += `<span class="bonus-tag ephemeral-gained" title="Second Souffle : x2 sur ${detail.activityName}">🔥 dont ${formatElevation(detail.amount, false)} m (second souffle)</span>`;
          break;
        case 'malediction_gain':
          bonusPills += `<span class="bonus-tag ephemeral-gained" title="Malédiction sur ${detail.from}">🪬 dont ${formatElevation(detail.amount, false)} m maudits</span>`;
          break;
        case 'marquage':
          bonusPills += `<span class="bonus-tag ephemeral-stolen" title="Marqué par ${detail.by}">🎯 -${formatElevation(detail.amount, false)} m</span>`;
          break;
        case 'malediction_victim':
          bonusPills += `<span class="bonus-tag ephemeral-stolen" title="Maudit par ${detail.by}">🪬 -${formatElevation(detail.amount, false)} m</span>`;
          break;
        case 'kamikaze_victim':
          bonusPills += `<span class="bonus-tag ephemeral-stolen" title="Kamikaze par ${detail.by}">💣 -${formatElevation(detail.amount, false)} m</span>`;
          break;
        case 'kamikaze_self':
          bonusPills += `<span class="bonus-tag ephemeral-stolen" title="Kamikaze (auto)">💣 -${formatElevation(detail.amount, false)} m</span>`;
          break;
        case 'duel':
          bonusPills += `<span class="bonus-tag ephemeral-info" title="Duel en cours">⚔️ Duel</span>`;
          break;
        case 'brouillard':
          bonusPills += `<span class="bonus-tag ephemeral-info" title="D+ masqué">🌫️ Brouillard</span>`;
          break;
      }
    }

    html += `<div class="ranking-row">
      <div class="ranking-position">${e.position}</div>
      <div class="ranking-athlete">
        <div class="athlete-avatar" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
        <div class="athlete-info">
          <span class="athlete-name">${e.participant.name} ${bonusBadge}</span>
          <span class="athlete-status eliminated">${e.daysSinceElimination}j depuis élim.</span>
        </div>
      </div>
      <div class="ranking-elevation">
        ${formatElevation(e.totalElevation, false)} <span class="elevation-unit">m</span>
        ${bonusPills ? `<div class="elevation-bonuses">${bonusPills}</div>` : ''}
      </div>
      <div class="ranking-round">R${e.eliminatedRound}</div>
      <div class="ranking-points"><span class="points-badge">${e.points} pts</span></div>
    </div>`;
  });
  container.innerHTML = html;
}

/**
 * Détermine qui a reçu un bonus éphémère pour une saison donnée
 * Le meilleur des 2 éliminés (celui avec le plus de D+ pendant le round) reçoit un bonus
 * Sauf si les 2 ont le même D+ (y compris 0)
 * @returns {Set} IDs des joueurs ayant reçu un bonus
 */
function getBonusRecipientsForSeason(seasonNumber) {
  const recipients = new Set();
  const roundsPerSeason = getRoundsPerSeason();
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  const seasonEndRound = seasonNumber * roundsPerSeason;

  if (!frozenResultsCache?.rounds) return recipients;

  for (let roundNum = seasonStartRound; roundNum <= seasonEndRound; roundNum++) {
    const roundData = frozenResultsCache.rounds[String(roundNum)];
    if (!roundData?.frozen || !roundData.eliminations || roundData.eliminations.length < 2) continue;

    // Trier les éliminés par D+ décroissant
    const sortedElims = [...roundData.eliminations].sort((a, b) => (b.elevation || 0) - (a.elevation || 0));
    const best = sortedElims[0];
    const second = sortedElims[1];

    // Le meilleur reçoit un bonus seulement s'il a plus de D+ que le second et que son D+ > 0
    if ((best.elevation || 0) > 0 && (best.elevation || 0) > (second.elevation || 0)) {
      recipients.add(String(best.id));
    }
  }

  return recipients;
}

// ============================================
// RENDU: CLASSEMENT GÉNÉRAL
// ============================================

function renderFinalStandings(container) {
  const activeIds = new Set((seasonData?.active || []).map(p => p.id));

  // Calculer les points depuis les résultats figés pour plus de précision
  const frozenPoints = calculatePointsFromFrozenResults(frozenResultsCache);

  // Calculer les points de la saison précédente
  const previousSeasonPoints = calculatePointsForSeason(currentSeasonNumber - 1, allActivities, getCurrentDate(), frozenResultsCache, bonusesCache, seasonBonusesCache);

  // Calculer les points de la saison actuelle (jusqu'au dernier round figé)
  const currentSeasonPoints = calculatePointsForSeason(currentSeasonNumber, allActivities, getCurrentDate(), frozenResultsCache, bonusesCache, seasonBonusesCache);

  // Utiliser yearlyStandingsCache mais l'enrichir avec les données figées
  const standings = yearlyStandingsCache || [];

  // Enrichir les standings avec les points figés et recalculer
  const enrichedStandings = standings.map(e => {
    const id = String(e.participant.id);
    const frozen = frozenPoints[id] || { mainPoints: 0, elimPoints: 0, bonusPoints: 0, wins: 0 };
    const prevSeason = previousSeasonPoints[id] || { mainPoints: 0, elimPoints: 0, rescapePoints: 0, total: 0 };
    const currSeason = currentSeasonPoints[id] || { mainPoints: 0, elimPoints: 0, rescapePoints: 0, total: 0 };

    // Utiliser les points figés s'ils sont supérieurs (plus fiables)
    const mainPts = Math.max(e.totalMainPoints || 0, frozen.mainPoints);
    const elimPts = e.totalEliminatedPoints || 0;
    const rescapePts = e.totalRescapePoints || 0;
    const bonusPts = frozen.bonusPoints || 0;
    const wins = Math.max(e.wins || 0, frozen.wins);

    return {
      ...e,
      totalMainPoints: mainPts,
      totalEliminatedPoints: elimPts,
      totalRescapePoints: rescapePts,
      bonusPoints: bonusPts,
      totalPoints: mainPts + elimPts + rescapePts + bonusPts,
      wins: wins,
      previousSeasonTotal: prevSeason.total,
      currentSeasonMain: currSeason.mainPoints,
      currentSeasonElim: currSeason.elimPoints,
      currentSeasonRescape: currSeason.rescapePoints,
      currentSeasonTotal: currSeason.total
    };
  });

  // Re-trier par points totaux
  enrichedStandings.sort((a, b) => b.totalPoints - a.totalPoints || b.wins - a.wins || b.totalMainPoints - a.totalMainPoints);
  enrichedStandings.forEach((e, i) => e.rank = i + 1);

  // HTML avec colonnes améliorées
  let html = `
    <div class="standings-header">
      <div>Rang</div>
      <div>Athlète</div>
      <div class="hide-mobile" title="Points des saisons précédentes">Saisons préc.</div>
      <div class="hide-mobile" title="Points de la saison actuelle"><span class="header-main">Principal</span> · <span class="header-elim">Éliminé</span></div>
      <div>Total</div>
    </div>`;

  enrichedStandings.forEach(e => {
    const isActive = activeIds.has(e.participant.id);
    const wins = e.wins > 0 ? `<span class="wins-badge">🏆×${e.wins}</span>` : '';
    const isCurrentSeasonEliminated = seasonData?.eliminated?.some(el => el.id === e.participant.id);

    let statusBadge = '';
    if (isActive) {
      statusBadge = '<span class="active-badge">En course</span>';
    } else if (isCurrentSeasonEliminated) {
      const elimData = seasonData.eliminated.find(el => el.id === e.participant.id);
      statusBadge = `<span class="elim-badge">Élim. R${elimData?.eliminatedRound || '?'}</span>`;
    }

    // Colonne saison actuelle : valeurs colorées texte (pas de fond)
    const currentSeasonParts = [];
    if (e.currentSeasonMain > 0) {
      currentSeasonParts.push(`<span class="pts-text-main">${e.currentSeasonMain}</span>`);
    }
    if (e.currentSeasonRescape > 0) {
      currentSeasonParts.push(`<span class="pts-text-rescape">+${e.currentSeasonRescape}</span>`);
    }
    if (e.currentSeasonElim > 0) {
      currentSeasonParts.push(`<span class="pts-text-elim">+${e.currentSeasonElim}</span>`);
    }
    const currentSeasonHtml = currentSeasonParts.length > 0
      ? `<span class="season-pts-detail">${currentSeasonParts.join(' ')}</span>`
      : `<span class="pts-zero">-</span>`;

    // Détail du total en hover uniquement
    const hoverParts = [];
    if (e.totalMainPoints > 0) hoverParts.push(`Principal: ${e.totalMainPoints}`);
    if (e.totalRescapePoints > 0) hoverParts.push(`Rescapé: +${e.totalRescapePoints}`);
    if (e.totalEliminatedPoints > 0) hoverParts.push(`Éliminé: +${e.totalEliminatedPoints}`);
    if (e.bonusPoints > 0) hoverParts.push(`Bonus: +${e.bonusPoints}`);
    const hoverTitle = hoverParts.length > 1 ? hoverParts.join(' \u00B7 ') : '';

    html += `<div class="standings-row ${isActive ? '' : 'eliminated'}">
      <div class="standings-rank">${e.rank}</div>
      <div class="standings-athlete">
        <div class="athlete-avatar-small" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
        <span>${e.participant.name}</span>${wins}${statusBadge}
      </div>
      <div class="standings-points prev hide-mobile">${e.previousSeasonTotal || '-'}</div>
      <div class="standings-points current hide-mobile">${currentSeasonHtml}</div>
      <div class="standings-total"${hoverTitle ? ` title="${hoverTitle}"` : ''}>${e.totalPoints}</div>
    </div>`;
  });

  container.innerHTML = html;
}

// ============================================
// RENDU: SECTION ARSENAL (JOKERS & BONUS)
// ============================================

async function renderArsenalSection(container, roundNumber) {
  const today = getCurrentDate();
  const currentRoundDates = getRoundDates(roundNumber);
  const previousRoundNumber = roundNumber - 1;

  // Calculer si on est dans la période "récap" (1 jour après fin du round précédent)
  let showPreviousRoundEffects = false;
  let previousRoundEffects = { jokers: [], bonuses: [] };

  if (previousRoundNumber >= 1) {
    const previousRoundDates = getRoundDates(previousRoundNumber);
    const daysSinceEnd = Math.floor((today - previousRoundDates.end) / (1000 * 60 * 60 * 24));

    // Afficher les effets du round précédent pendant 1 jour après sa fin
    if (daysSinceEnd >= 0 && daysSinceEnd <= 1) {
      showPreviousRoundEffects = true;

      // Récupérer les jokers du round précédent
      const prevJokers = getActiveJokersForRound(previousRoundNumber);
      previousRoundEffects.jokers = prevJokers.map(joker => {
        // Même bug fix que pour les jokers du round courant : `joker.athleteId`
        // n'existe pas en camelCase, l'objet a `athlete_id` ou `participantId`.
        const athleteId = joker.athleteId || joker.athlete_id || joker.participantId;
        const targetId  = joker.targetId  || joker.target_athlete_id;
        const athlete = getParticipantById(athleteId);
        const target = targetId ? getParticipantById(targetId) : null;
        return {
          ...joker,
          joker_id: joker.jokerId,
          athlete_name: athlete?.name || joker.athlete_name || joker.participantName || 'Joueur',
          target_athlete_name: target?.name || joker.target_athlete_name || null
        };
      });

      // Récupérer les bonus utilisés au round précédent
      previousRoundEffects.bonuses = getBonusesUsedInRound(previousRoundNumber, bonusesCache, seasonBonusesCache).map(b => {
        const bonusType = BONUS_TYPES?.[b.bonus_id];
        return {
          ...b,
          bonus_name: bonusType?.name || b.bonus_id,
          icon: bonusType?.icon || '🎁',
          description: getBonusHistoryDescription(b)
        };
      });
    }
  }

  // Récupérer les jokers actifs ce round
  const activeJokers = getActiveJokersForRound(roundNumber);

  // Calculer le ranking avec effets pour avoir les montants (voleur, sabotage, etc.)
  const roundDates = getRoundDates(roundNumber);
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
  const ranking = calculateRanking(roundActivities, seasonData?.active || []);
  const rankingWithEffects = applyJokerEffects(ranking, roundNumber, roundActivities);

  // Enrichir avec les noms des joueurs et les montants d'effets
  const enrichedJokers = activeJokers.map(joker => {
    // BUG fix: getActiveJokersForRound renvoie un objet avec les champs
    // `athlete_id` (snake_case, vient de jokers_usage.json via ...u) ET
    // `participantId` (rajouté), mais PAS `athleteId` (camelCase). Sans ce
    // fallback, athlete?.name devenait undefined et tous les jokers affichaient
    // "Joueur" comme nom (visible surtout sur le bouclier dans l'arsenal).
    const athleteId = joker.athleteId || joker.athlete_id || joker.participantId;
    const targetId  = joker.targetId  || joker.target_athlete_id;
    const athlete = getParticipantById(athleteId);
    const target = targetId ? getParticipantById(targetId) : null;

    // Récupérer les montants d'effets depuis le ranking calculé
    let effectAmount = 0;
    if (joker.jokerId === 'voleur' && targetId) {
      const targetEntry = rankingWithEffects.find(e => String(e.participant.id) === String(targetId));
      effectAmount = targetEntry?.jokerEffects?.bonuses?.stolen?.amount || 0;
    } else if (joker.jokerId === 'sabotage' && targetId) {
      const targetEntry = rankingWithEffects.find(e => String(e.participant.id) === String(targetId));
      effectAmount = targetEntry?.jokerEffects?.bonuses?.sabotaged?.amount || 0;
    } else if (joker.jokerId === 'multiplicateur') {
      const participantEntry = rankingWithEffects.find(e => String(e.participant.id) === String(athleteId));
      effectAmount = participantEntry?.jokerEffects?.bonuses?.multiplier?.amount || 0;
    }

    return {
      ...joker,
      joker_id: joker.jokerId,
      // Préférer le nom déjà calculé en amont (athlete_name ou participantName) à un fallback générique
      athlete_name: athlete?.name || joker.athlete_name || joker.participantName || 'Joueur',
      target_athlete_name: target?.name || joker.target_athlete_name || null,
      effectAmount
    };
  });

  // Récupérer les bonus éphémères ACTIFS (non utilisés ou utilisés ce round)
  // Exclure les bonus de saisons précédentes (leur elimination_round est dans une saison terminée)
  let bonuses = [];
  try {
    const res = await fetch('/api/bonuses/all');
    if (res.ok) {
      const allBonuses = await res.json();
      const currentSeasonStartRound = getSeasonStartRound(currentSeasonNumber);
      // Filtrer: garder uniquement les bonus de la saison courante, non utilisés OU utilisés ce round
      bonuses = allBonuses
        .filter(b => {
          // Exclure les bonus dont le round d'élimination est avant la saison courante
          if (b.elimination_round && b.elimination_round < currentSeasonStartRound) return false;
          return !b.used_in_round || b.used_in_round === roundNumber;
        })
        .map(b => {
          const athlete = getParticipantById(b.athlete_id);
          const target = b.target_athlete_id ? getParticipantById(b.target_athlete_id) : null;
          const bonusType = BONUS_TYPES?.[b.bonus_id];

          // Calculer les infos supplémentaires pour le hover
          const hoverInfo = calculateBonusHoverInfo(b, athlete, target, currentRoundNumber);

          return {
            ...b,
            athlete_name: athlete?.name || 'Joueur',
            target_athlete_name: target?.name || null,
            bonus_name: bonusType?.name || b.bonus_id,
            icon: bonusType?.icon || '🎁',
            status: b.used_at ? 'used' : b.activated_at ? 'active' : 'available',
            hoverInfo
          };
        });
    }
  } catch (e) {
    console.warn('Impossible de charger les bonus:', e);
  }

  // Récupérer les choix en attente
  try {
    const res = await fetch('/api/bonuses/active');
    if (res.ok) {
      const pendingData = await res.json();
      // Ajouter les joueurs qui doivent encore choisir
      if (pendingData.pendingChoices) {
        Object.entries(pendingData.pendingChoices).forEach(([playerId, choices]) => {
          const athlete = getParticipantById(playerId);
          if (!bonuses.some(b => String(b.athlete_id) === String(playerId))) {
            bonuses.push({
              athlete_id: playerId,
              athlete_name: athlete?.name || 'Joueur',
              icon: '🎁',
              status: 'pending'
            });
          }
        });
      }
    }
  } catch (e) {
    // Ignorer
  }

  // Récupérer les jokers programmés pour le prochain round
  const pendingJokers = getPendingJokersForNextRound(roundNumber);
  const enrichedPendingJokers = pendingJokers.map(joker => {
    // Même bug fix que pour activeJokers ci-dessus.
    const athleteId = joker.athleteId || joker.athlete_id || joker.participantId;
    const targetId  = joker.targetId  || joker.target_athlete_id;
    const athlete = getParticipantById(athleteId);
    const target = targetId ? getParticipantById(targetId) : null;
    return {
      ...joker,
      joker_id: joker.jokerId,
      athlete_name: athlete?.name || joker.athlete_name || joker.participantName || 'Joueur',
      target_athlete_name: target?.name || joker.target_athlete_name || null
    };
  });

  renderArsenal(container, {
    activeJokers: enrichedJokers,
    pendingJokers: enrichedPendingJokers,
    bonuses,
    currentRoundNumber: roundNumber,
    showPreviousRoundEffects,
    previousRoundEffects,
    previousRoundNumber
  });
}

/**
 * Calcule les informations supplémentaires pour le hover d'un bonus
 */
function calculateBonusHoverInfo(bonus, athlete, target, roundNumber) {
  const bonusId = bonus.bonus_id;
  if (!bonusId || bonus.status === 'pending') return null;

  const athleteId = bonus.athlete_id;
  const targetId = bonus.target_athlete_id;
  const effectRound = bonus.used_in_round || roundNumber;

  switch (bonusId) {
    case 'embuscade': {
      if (!targetId) return null;
      const targetActivities = getEligibleActivitiesForBonus(targetId, effectRound, allActivities);
      if (targetActivities.length === 0) return "Aucune activité éligible";
      const elevations = targetActivities.map(a => a.total_elevation_gain || 0);
      const minElev = Math.min(...elevations);
      const maxElev = Math.max(...elevations);
      return `Entre ${formatElevation(minElev, false)} et ${formatElevation(maxElev, false)} m D+ potentiellement volés`;
    }

    case 'ravitaillement': {
      // Calculer le D+ potentiel des activités de l'éliminé
      const athleteActivities = getEligibleActivitiesForBonus(athleteId, effectRound, allActivities);
      if (athleteActivities.length === 0) return "Aucune activité éligible";
      const elevations = athleteActivities.map(a => a.total_elevation_gain || 0);
      const minElev = Math.min(...elevations);
      const maxElev = Math.max(...elevations);
      const targetName = target?.name || 'la cible';
      return `Entre ${formatElevation(minElev, false)} et ${formatElevation(maxElev, false)} m D+ donnés à ${targetName}`;
    }

    case 'duel': {
      // Calculer l'avance/retard sur le co-éliminé
      const coEliminatedId = findCoEliminated(athleteId, bonus.elimination_round, frozenResultsCache);
      if (!coEliminatedId) return null;
      const coEliminated = getParticipantById(coEliminatedId);
      const athleteElev = getEliminatedElevationSince(athleteId, bonus.elimination_round, allActivities);
      const coElimElev = getEliminatedElevationSince(coEliminatedId, bonus.elimination_round, allActivities);
      const diff = athleteElev - coElimElev;
      if (diff > 0) {
        return `${formatElevation(diff, false)} m d'avance sur ${coEliminated?.name || 'son adversaire'}`;
      } else if (diff < 0) {
        return `${formatElevation(Math.abs(diff), false)} m de retard sur ${coEliminated?.name || 'son adversaire'}`;
      } else {
        return `Égalité avec ${coEliminated?.name || 'son adversaire'}`;
      }
    }

    case 'marquage': {
      // Pas d'info sur la cible pour ne pas influencer
      const athleteName = athlete?.name || 'Le joueur';
      return `${athleteName} a marqué un joueur actif. S'il est éliminé → +1 point`;
    }

    case 'trap': {
      // Si déjà déclenché, montrer le D+ gagné
      if (bonus.effect_result?.elevation_gained) {
        const victimName = bonus.effect_result.victim_name || 'un joueur';
        return `+${formatElevation(bonus.effect_result.elevation_gained, false)} m gagnés grâce à ${victimName}`;
      }
      return "Piège actif, en attente d'un éliminé...";
    }

    case 'second_souffle': {
      // Trouver le round d'élimination (depuis le bonus ou les données de saison)
      let elimRound = bonus.elimination_round;
      if (!elimRound && seasonData?.eliminated) {
        const elimEntry = seasonData.eliminated.find(e => String(e.id) === String(athleteId));
        if (elimEntry) {
          const roundsPerSeason2 = getRoundsPerSeason();
          elimRound = (elimEntry.eliminatedSeason - 1) * roundsPerSeason2 + elimEntry.eliminatedRound;
        }
      }
      if (!elimRound) return "Aucune donnée d'élimination";
      // Trouver l'activité la plus faible
      const activities = getEliminatedActivities(athleteId, elimRound, allActivities);
      if (activities.length === 0) return "Aucune activité depuis l'élimination";
      const minActivity = activities.reduce((min, a) =>
        (a.total_elevation_gain || 0) < (min.total_elevation_gain || 0) ? a : min
      );
      const minElev = minActivity.total_elevation_gain || 0;
      const activityName = minActivity.name || 'Activité';
      return `x2 sur "${activityName}" = +${formatElevation(minElev, false)} m bonus`;
    }

    case 'kamikaze': {
      // Calculer le D+ du round actuel pour les deux joueurs
      if (!targetId) return "Cible non définie";
      const roundDates = getRoundDates(effectRound);

      // D+ du round de l'éliminé (celui qui utilise le bonus)
      const athleteRoundElev = getRoundElevation(athleteId, roundDates, allActivities);
      const targetRoundElev = getRoundElevation(targetId, roundDates, allActivities);

      const athleteLoss = Math.round(athleteRoundElev * 0.25);
      const targetLoss = Math.round(targetRoundElev * 0.25);
      const targetName = target?.name || 'la cible';

      return `💣 -${formatElevation(athleteLoss, false)} m pour toi, -${formatElevation(targetLoss, false)} m pour ${targetName}`;
    }

    case 'malediction': {
      // Calculer le D+ volé ce round et le cumul
      if (!targetId) return "Cible non définie";
      const roundDates = getRoundDates(effectRound);

      const targetRoundElev = getRoundElevation(targetId, roundDates, allActivities);
      const stolenThisRound = Math.round(targetRoundElev * 0.10);
      const targetName = target?.name || 'la cible';

      // Cumul total volé (si disponible dans effect_result)
      const totalStolen = bonus.effect_result?.total_stolen || 0;

      if (totalStolen > 0) {
        return `🪬 ${formatElevation(stolenThisRound, false)} m volés ce round à ${targetName} (total: ${formatElevation(totalStolen, false)} m)`;
      }
      return `🪬 ${formatElevation(stolenThisRound, false)} m seront volés à ${targetName} ce round`;
    }

    default:
      return null;
  }
}

// ============================================
// RENDU: HISTORIQUE
// ============================================

function renderHistorySection(container) {
  const completedSeasons = [];
  for (let s = 1; s < currentSeasonNumber; s++) {
    const summary = getSeasonSummary(allActivities, s, getCurrentDate());
    if (summary.isComplete) completedSeasons.push(summary);
  }

  container.innerHTML = `<div class="history-controls">
    <label>Saison : </label>
    <select id="seasonSelect" class="season-select">
      <option value="current">Saison ${currentSeasonNumber} (en cours)</option>
      ${completedSeasons.map(s => `<option value="${s.seasonNumber}">Saison ${s.seasonNumber} - ${s.winner?.name || 'N/A'} 🏆</option>`).join('')}
    </select>
  </div>
  <div id="historyContent"></div>`;

  const select = document.getElementById('seasonSelect');
  const content = document.getElementById('historyContent');

  const renderSeasonHistory = (seasonNum) => {
    if (seasonNum === 'current') {
      renderCurrentSeasonHistory(content);
    } else {
      const summary = getSeasonSummary(allActivities, parseInt(seasonNum), getCurrentDate());
      renderCompletedSeasonHistory(content, summary);
    }
  };

  select.addEventListener('change', (e) => renderSeasonHistory(e.target.value));
  renderSeasonHistory('current');
}

/**
 * Affiche l'historique de la saison en cours avec détails
 * Utilise les résultats figés (frozen_results) comme source de vérité
 */
function renderCurrentSeasonHistory(container) {
  if (!seasonData?.eliminated?.length && !seasonData?.roundResults?.length) {
    container.innerHTML = '<div class="history-item"><div class="history-title">Aucune élimination encore</div></div>';
    return;
  }

  const roundsPerSeason = getRoundsPerSeason();
  let html = '';

  // Parcourir les rounds terminés
  for (let r = 1; r <= roundsPerSeason; r++) {
    const globalRound = (currentSeasonNumber - 1) * roundsPerSeason + r;
    const roundDates = getRoundDates(globalRound);
    const today = getCurrentDate();

    // Round pas encore terminé ?
    if (today <= roundDates.end) continue;

    // Récupérer les éliminés de ce round (pour savoir s'il y en a)
    const roundEliminated = seasonData.eliminated.filter(e => e.eliminatedRound === r);
    if (roundEliminated.length === 0) continue;

    // Essayer d'utiliser les données figées (source de vérité)
    const frozenRound = getFrozenRound(globalRound, frozenResultsCache);

    if (frozenRound && frozenRound.frozen) {
      // Utiliser les données figées
      html += renderFrozenRoundHistory(r, frozenRound);
    } else {
      // Fallback: recalculer (uniquement si pas de frozen results)
      html += renderCalculatedRoundHistory(r, globalRound, roundDates, roundEliminated);
    }
  }

  if (!html) {
    html = '<div class="history-item"><div class="history-title">Aucune élimination encore</div></div>';
  }

  container.innerHTML = html;
}

/**
 * Fallback: génère le HTML en recalculant (utilisé uniquement si frozen results non disponible)
 */
function renderCalculatedRoundHistory(roundInSeason, globalRound, roundDates, roundEliminated) {
  // Calculer le classement de ce round pour avoir les D+
  const roundActivities = filterByPeriod(allActivities, roundDates.start, roundDates.end);
  const activeAtRound = PARTICIPANTS.filter(p =>
    !seasonData.eliminated.some(e => e.eliminatedRound < roundInSeason && e.id === p.id)
  );
  const ranking = calculateRanking(roundActivities, activeAtRound);
  const rankingWithEffects = applyJokerEffects(ranking, globalRound, roundActivities);

  // Trouver le DERNIER non-éliminé (celui qui s'est maintenu de justesse)
  const nonEliminatedEntries = rankingWithEffects.filter(e =>
    !roundEliminated.some(elim => elim.id === e.participant.id)
  );
  const lastSurvivor = nonEliminatedEntries[nonEliminatedEntries.length - 1];
  const lastSurvivorElevation = lastSurvivor?.totalElevation || 0;

  // Construire la liste des éliminés avec leur écart par rapport au maintien
  const eliminatedDetails = roundEliminated.map(elim => {
    const elimEntry = rankingWithEffects.find(e => e.participant.id === elim.id);
    const elimElevation = elimEntry?.totalElevation || 0;
    const gap = lastSurvivorElevation - elimElevation;
    const isZeroElim = elimElevation === 0;
    return {
      name: elim.name,
      elevation: elimElevation,
      gap: gap,
      isZeroElim: isZeroElim
    };
  }).sort((a, b) => b.elevation - a.elevation);

  // Compter les éliminations à 0 D+
  const zeroElimCount = eliminatedDetails.filter(e => e.isZeroElim).length;

  // Récupérer les jokers actifs ce round
  const activeJokers = getActiveJokersForRound(globalRound);

  // Identifier le rescapé
  const rescapeIdx = rankingWithEffects.length - roundEliminated.length - 1;
  const isFinale = roundInSeason === getRoundsPerSeason();

  // Calculer les mainPoints pour les éliminés de ce round
  const elimsBeforeThisRound = seasonData.eliminated.filter(e => e.eliminatedRound < roundInSeason).length;
  const activeAtRoundStart = PARTICIPANTS.length - elimsBeforeThisRound;

  // Générer le HTML du classement pour le dropdown
  const rankingHtml = rankingWithEffects.map((entry, idx) => {
    const isEliminated = roundEliminated.some(e => e.id === entry.participant.id);
    const position = idx + 1;
    const isRescape = (idx === rescapeIdx) && !isFinale && roundEliminated.length > 0;

    // Calculer les points pour les éliminés
    let mainPts = 0;
    if (isEliminated) {
      const sameRoundElims = roundEliminated;
      const elimIdx = sameRoundElims.findIndex(e => e.id === entry.participant.id);
      const elimPosition = activeAtRoundStart - elimIdx;
      mainPts = getMainChallengePoints(Math.max(1, Math.min(elimPosition, PARTICIPANTS.length)));
    } else if (isFinale && position <= 3) {
      mainPts = getMainChallengePoints(position);
    }

    let pointsBadges = '';
    if (mainPts > 0) {
      pointsBadges += `<span class="history-pts-badge" title="Points challenge principal">${mainPts} pts</span>`;
    }
    if (isRescape) {
      const rescapeInfo = getRescapeInfoForRound(globalRound, frozenResultsCache);
      if (rescapeInfo) {
        const streak = rescapeInfo.consecutive;
        const rescPts = rescapeInfo.points;
        if (streak === 1) {
          pointsBadges += `<span class="history-rescape-badge" title="1er jeton rescapé (pas de points encore)">🎫 rescapé</span>`;
        } else {
          pointsBadges += `<span class="history-rescape-badge has-points" title="Rescapé ×${streak} consécutif : +${rescPts} pts">🎫 rescapé ×${streak} (+${rescPts})</span>`;
        }
      } else {
        pointsBadges += `<span class="history-rescape-badge">🎫 rescapé</span>`;
      }
    }

    return `
      <div class="history-ranking-row ${isEliminated ? 'eliminated' : ''} ${isRescape ? 'rescape' : ''}">
        <span class="history-rank">${position}</span>
        <span class="history-name">${entry.participant.name}</span>
        <span class="history-elevation">${formatElevation(entry.totalElevation, false)}</span>
        ${isEliminated ? '<span class="history-elim-badge">Éliminé</span>' : ''}
        ${pointsBadges}
      </div>
    `;
  }).join('');

  // Construire le HTML
  let html = `<div class="history-item" data-round="${globalRound}">
    <div class="history-round-header" onclick="toggleRoundDetails(${globalRound})">
      <div class="history-round">Round ${roundInSeason}</div>
      <span class="history-toggle-icon">▼</span>
    </div>
    <div class="history-eliminated">
      <span class="history-label">Éliminé(s) :</span>
      ${eliminatedDetails.map(e => {
        if (e.isZeroElim) {
          return `<span class="eliminated-name eliminated-zero">${e.name}</span> <span class="eliminated-gap">(0 D+ - inactif)</span>`;
        } else {
          return `<span class="eliminated-name">${e.name}</span> <span class="eliminated-gap">(à ${formatElevation(e.gap, false)} du maintien)</span>`;
        }
      }).join(', ')}
    </div>
    ${zeroElimCount > 0 ? `<div class="history-zero-warning">⚠️ ${zeroElimCount} joueur${zeroElimCount > 1 ? 's' : ''} éliminé${zeroElimCount > 1 ? 's' : ''} pour inactivité (0 D+)</div>` : ''}`;

  // Afficher les jokers utilisés
  if (activeJokers.length > 0) {
    const jokerDescriptions = activeJokers.map(joker => {
      const targetEntry = joker.targetId ? rankingWithEffects.find(e => e.participant.id === joker.targetId) : null;

      switch(joker.jokerId) {
        case 'sabotage':
          const sabotageAmount = targetEntry?.jokerEffects?.bonuses?.sabotaged?.amount || 0;
          return `${joker.jokerIcon} ${joker.participantName} a saboté ${joker.targetName} (-${formatElevation(sabotageAmount, false)})`;
        case 'voleur':
          const stolenAmount = targetEntry?.jokerEffects?.bonuses?.stolen?.amount || 0;
          return `${joker.jokerIcon} ${joker.participantName} a volé ${joker.targetName} (-${formatElevation(stolenAmount, false)})`;
        case 'multiplicateur':
          const bonusAmount = rankingWithEffects.find(e => e.participant.id === joker.participantId)?.jokerEffects?.bonuses?.multiplier?.amount || 0;
          return `${joker.jokerIcon} ${joker.participantName} a utilisé le multiplicateur (+${formatElevation(bonusAmount, false)})`;
        case 'bouclier':
          return `${joker.jokerIcon} ${joker.participantName} a utilisé le bouclier (protection)`;
        default:
          return `${joker.jokerIcon} ${joker.participantName} a utilisé ${joker.jokerName}`;
      }
    });

    html += `<div class="history-jokers">
      <span class="history-label">Jokers :</span> ${jokerDescriptions.join(' • ')}
    </div>`;
  }

  // Afficher les bonus éphémères utilisés ce round
  const bonusesUsed = getBonusesUsedInRound(globalRound, bonusesCache, seasonBonusesCache);
  if (bonusesUsed.length > 0) {
    const bonusDescriptions = bonusesUsed.map(bonus => getBonusHistoryDescription(bonus));

    html += `<div class="history-bonuses">
      <span class="history-label">Bonus éphémères :</span> ${bonusDescriptions.join(' • ')}
    </div>`;
  }

  // Note indiquant que ce sont des données recalculées
  html += `<div class="history-note" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 8px; font-style: italic;">
    ⚡ Données recalculées (round non figé)
  </div>`;

  // Ajouter le dropdown du classement (caché par défaut)
  html += `
    <div class="history-ranking-dropdown" id="ranking-${globalRound}" style="display: none;">
      <div class="history-ranking-title">📊 Classement du round</div>
      <div class="history-ranking-list">
        ${rankingHtml}
      </div>
    </div>
  </div>`;

  return html;
}

/**
 * Génère le HTML pour le classement final du Challenge des Éliminés (saisons terminées)
 */
function renderCompletedEliminatedChallenge(summary) {
  // Utiliser eliminatedRanking qui est déjà calculé par getSeasonSummary
  if (!summary.eliminatedRanking?.length) return '';

  const seasonNumber = summary.seasonNumber;

  // Générer le HTML
  let html = `
    <div class="history-item history-eliminated-challenge">
      <div class="history-round-header" onclick="toggleRoundDetails('eliminated-s${seasonNumber}')">
        <div class="history-round">👻 Challenge des Éliminés - Classement Final</div>
        <span class="history-toggle-icon">▼</span>
      </div>
      <div class="history-ranking-dropdown" id="ranking-eliminated-s${seasonNumber}" style="display: block;">
        <div class="history-ranking-list eliminated-challenge-list">
  `;

  summary.eliminatedRanking.forEach((entry, idx) => {
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';
    const rankClass = idx < 3 ? 'top-three' : '';
    const name = entry.participant?.name || 'Inconnu';
    const elimRound = entry.eliminatedRound || '?';
    const elevation = entry.totalElevation || 0;
    const points = entry.points || 0;

    // Générer les descriptions de bonus pour ce joueur
    const bonusEffects = entry.bonusEffects || { gained: 0, lost: 0, details: [] };
    let bonusHtml = '';

    for (const detail of (bonusEffects.details || [])) {
      if (detail.amount === 0 && detail.type !== 'duel' && detail.type !== 'brouillard') continue;

      let desc = '';
      const fmtAmt = formatElevation(detail.amount, false);
      switch (detail.type) {
        case 'embuscade_gain':
          desc = `<span class="history-bonus-detail gained">🏹 <span class="bonus-long">+${fmtAmt} m volés à ${detail.from}</span><span class="bonus-short">+embuscade : ${fmtAmt} m</span></span>`;
          break;
        case 'trap_gain':
          desc = `<span class="history-bonus-detail gained">🪤 <span class="bonus-long">+${fmtAmt} m piégés sur ${detail.from}</span><span class="bonus-short">+piège : ${fmtAmt} m</span></span>`;
          break;
        case 'second_souffle':
          desc = `<span class="history-bonus-detail gained">🔥 <span class="bonus-long">+${fmtAmt} m (second souffle : x2 sur "${detail.activityName}")</span><span class="bonus-short">+second souffle : ${fmtAmt} m</span></span>`;
          break;
        case 'malediction_gain':
          desc = `<span class="history-bonus-detail gained">🪬 <span class="bonus-long">+${fmtAmt} m maudits à ${detail.from}</span><span class="bonus-short">+malédiction : ${fmtAmt} m</span></span>`;
          break;
        case 'marquage':
          desc = `<span class="history-bonus-detail lost">🎯 <span class="bonus-long">-${fmtAmt} m (marqué par ${detail.by})</span><span class="bonus-short">-marquage : ${fmtAmt} m</span></span>`;
          break;
        case 'malediction_victim':
          desc = `<span class="history-bonus-detail lost">🪬 <span class="bonus-long">-${fmtAmt} m (maudit par ${detail.by})</span><span class="bonus-short">-malédiction : ${fmtAmt} m</span></span>`;
          break;
        case 'kamikaze_victim':
          desc = `<span class="history-bonus-detail lost">💣 <span class="bonus-long">-${fmtAmt} m (kamikaze par ${detail.by})</span><span class="bonus-short">-kamikaze : ${fmtAmt} m</span></span>`;
          break;
        case 'kamikaze_self':
          desc = `<span class="history-bonus-detail lost">💣 <span class="bonus-long">-${fmtAmt} m (kamikaze auto)</span><span class="bonus-short">-kamikaze : ${fmtAmt} m</span></span>`;
          break;
        case 'duel':
          desc = `<span class="history-bonus-detail info">⚔️ <span class="bonus-long">Duel en cours</span><span class="bonus-short">Duel</span></span>`;
          break;
        case 'brouillard':
          desc = `<span class="history-bonus-detail info">🌫️ <span class="bonus-long">Brouillard actif</span><span class="bonus-short">Brouillard</span></span>`;
          break;
      }
      if (desc) bonusHtml += desc;
    }

    html += `
      <div class="history-ranking-row eliminated-row ${rankClass}">
        <span class="history-rank">${medal || (idx + 1)}</span>
        <div class="history-name-block">
          <span class="history-name">${name}</span>
          <span class="history-elim-round">Éliminé R${elimRound}</span>
          ${bonusHtml ? `<div class="history-bonus-list">${bonusHtml}</div>` : ''}
        </div>
        <span class="history-elevation">${formatElevation(elevation, false)}</span>
        <span class="history-points ${points > 0 ? 'has-points' : ''}">${points > 0 ? `+${points} pts` : '-'}</span>
      </div>
    `;
  });

  html += `
        </div>
      </div>
    </div>
  `;

  return html;
}

/**
 * Affiche l'historique d'une saison terminée (avec tous les détails)
 * Utilise les résultats figés (frozen_results) comme source de vérité
 */
function renderCompletedSeasonHistory(container, summary) {
  const roundsPerSeason = getRoundsPerSeason();


  let html = `<div class="history-season-summary"><h3>🏆 Champion : ${summary.winner?.name || 'N/A'}</h3></div>`;

  summary.rounds.forEach(r => {
    const globalRound = r.globalRound;

    // Essayer de récupérer les données figées
    const frozenRound = getFrozenRound(globalRound, frozenResultsCache);

    if (frozenRound && frozenRound.frozen) {
      // Utiliser les données figées (source de vérité)
      html += renderFrozenRoundHistory(r.roundInSeason, frozenRound);
    } else {
      // Fallback: pas de données figées, affichage minimal
      if (!r.eliminated.length) {
        html += `<div class="history-item">
          <div class="history-round">Round ${r.roundInSeason}</div>
          <div class="history-title">Aucun éliminé</div>
        </div>`;
      } else {
        html += `<div class="history-item">
          <div class="history-round">Round ${r.roundInSeason}</div>
          <div class="history-eliminated">
            <span class="history-label">Éliminé(s) :</span> ${r.eliminated.join(', ')}
          </div>
          <div class="history-note" style="font-size: 0.8rem; color: var(--text-muted); margin-top: 8px;">
            ⚠️ Détails non disponibles (round non figé)
          </div>
        </div>`;
      }
    }
  });

  // Ajouter le classement final du Challenge des Éliminés
  if (summary.eliminatedRanking?.length > 0) {
    html += renderCompletedEliminatedChallenge(summary);
  }

  container.innerHTML = html;
}

/**
 * Génère le HTML pour un round à partir des données figées
 */
/**
 * Rendu de l'historique d'un round ÉQUIPE figé
 */
function renderFrozenTeamRoundHistory(roundInSeason, frozenRound) {
  const globalRound = frozenRound.roundNumber;
  const teams = frozenRound.teams || [];
  const eliminations = frozenRound.eliminations || [];
  const eliminatedIds = new Set(eliminations.map(e => e.id));

  // Trouver l'équipe éliminée
  const eliminatedTeam = teams.find(t => t.members.some(m => eliminatedIds.has(m.id)));
  const eliminatedTeamLabel = eliminatedTeam?.animal
    ? `${eliminatedTeam.animal.emoji} ${eliminatedTeam.animal.name}`
    : (eliminatedTeam?.color?.name || 'Dernière');

  // Construire le HTML du classement par équipe
  const sortedTeams = [...teams].sort((a, b) => b.totalElevation - a.totalElevation);

  const rankingHtml = sortedTeams.map((team, idx) => {
    const isElimTeam = team === eliminatedTeam || (eliminatedTeam && team.index === eliminatedTeam.index);
    const teamColor = team.color || TEAM_COLORS[idx % TEAM_COLORS.length];
    const animal = team.animal || null;
    const position = idx + 1;
    const teamLabel = animal
      ? `${animal.emoji} ${animal.name}`
      : `Équipe ${teamColor.name}`;

    const membersHtml = team.members
      .sort((a, b) => (b.elevation || 0) - (a.elevation || 0))
      .map(m => {
        const isElim = eliminatedIds.has(m.id);
        const pts = m.mainPoints || 0;
        const ptsHtml = pts > 0 ? ` <span class="history-pts-badge">${pts} pts</span>` : '';
        return `<div class="history-ranking-row ${isElim ? 'eliminated' : ''}" style="padding-left: 24px;">
          <span class="history-name">${m.name || '?'}</span>
          <span class="history-elevation">${formatElevation(m.elevation || 0, false)}</span>
          ${isElim ? '<span class="history-elim-badge">Éliminé</span>' : ''}${ptsHtml}
        </div>`;
      }).join('');

    return `<div class="history-team-block ${isElimTeam ? 'eliminated' : ''}" style="border-left: 3px solid ${teamColor.border};">
      <div class="history-team-header">
        <span class="history-rank">#${position}</span>
        <span style="color: ${teamColor.border}; font-weight: 600;">${teamLabel}</span>
        <span class="history-elevation">${formatElevation(team.totalElevation || 0, false)}</span>
        ${isElimTeam ? '<span class="history-elim-badge">Éliminée</span>' : ''}
      </div>
      ${membersHtml}
    </div>`;
  }).join('');

  let html = `<div class="history-item" data-round="${globalRound}">
    <div class="history-round-header" onclick="toggleRoundDetails(${globalRound})">
      <div class="history-round">🤝 Round ${roundInSeason}</div>
      <span class="history-toggle-icon">▼</span>
    </div>
    <div class="history-eliminated">
      <span class="history-label">Équipe éliminée :</span>
      <span class="eliminated-name">${eliminatedTeamLabel}</span>
      <span class="eliminated-gap">(${eliminations.map(e => e.name).join(', ')})</span>
    </div>
    <div class="history-ranking-dropdown" id="ranking-${globalRound}" style="display: none;">
      <div class="history-ranking-title">📊 Classement des équipes</div>
      <div class="history-ranking-list">
        ${rankingHtml}
      </div>
    </div>
  </div>`;

  return html;
}

function renderFrozenRoundHistory(roundInSeason, frozenRound) {
  const globalRound = frozenRound.roundNumber;

  // Si c'est un round de saison équipe avec des données teams, afficher en mode équipe
  if (frozenRound.teams && frozenRound.teams.length > 0) {
    return renderFrozenTeamRoundHistory(roundInSeason, frozenRound);
  }

  // Extraire les données du frozen round
  const ranking = frozenRound.ranking || [];
  const eliminations = frozenRound.eliminations || [];
  const jokersUsed = frozenRound.jokersUsed || [];

  if (eliminations.length === 0) {
    return `<div class="history-item">
      <div class="history-round">Round ${roundInSeason}</div>
      <div class="history-title">Aucun éliminé</div>
    </div>`;
  }

  // Trouver le dernier survivant (pour calculer l'écart)
  const eliminatedIds = new Set(eliminations.map(e => e.id));
  const survivors = ranking.filter(r => !eliminatedIds.has(r.id));
  const lastSurvivor = survivors[survivors.length - 1];
  const lastSurvivorElevation = lastSurvivor?.elevation || 0;

  // Construire les détails des éliminés
  const eliminatedDetails = eliminations.map(elim => {
    const gap = lastSurvivorElevation - (elim.elevation || 0);
    const isZeroElim = elim.zeroElimination || elim.elevation === 0;
    return {
      name: elim.name,
      elevation: elim.elevation || 0,
      gap: gap,
      isZeroElim: isZeroElim
    };
  }).sort((a, b) => b.elevation - a.elevation);

  // Compter les éliminations à 0 D+
  const zeroElimCount = eliminatedDetails.filter(e => e.isZeroElim).length;

  // Récupérer les bonus utilisés ce round pour calculer les effets
  const roundBonuses = getBonusesUsedInRound(globalRound, bonusesCache, seasonBonusesCache);

  // Identifier le rescapé = dernier survivant (dernier non-éliminé du classement)
  const survivorEntries = ranking.filter(e => !eliminatedIds.has(e.id));
  const rescapeEntry = survivorEntries.length > 0 ? survivorEntries[survivorEntries.length - 1] : null;
  const rescapeId = rescapeEntry ? String(rescapeEntry.id) : null;
  const isFinaleRound = frozenRound.roundInSeason === getRoundsPerSeason();
  const rescapeInfo = getRescapeInfoForRound(globalRound, frozenResultsCache);

  // Générer le HTML du classement pour le dropdown avec pilules bonus
  const rankingHtml = ranking.map((entry, idx) => {
    const isEliminated = eliminatedIds.has(entry.id);
    const position = idx + 1;
    const isRescape = (String(entry.id) === rescapeId) && !isFinaleRound && eliminations.length > 0;

    // Points gagnés par cet athlète dans ce round
    const mainPts = entry.mainPoints || 0;

    // Construire les badges de points
    let pointsBadges = '';
    if (mainPts > 0) {
      pointsBadges += `<span class="history-pts-badge" title="Points challenge principal">${mainPts} pts</span>`;
    }
    if (isRescape && rescapeInfo) {
      const streak = rescapeInfo.consecutive;
      const rescPts = rescapeInfo.points;
      if (streak === 1) {
        pointsBadges += `<span class="history-rescape-badge" title="1er jeton rescapé (pas de points encore)">🎫 rescapé</span>`;
      } else {
        pointsBadges += `<span class="history-rescape-badge has-points" title="Rescapé ×${streak} consécutif : +${rescPts} pts">🎫 rescapé ×${streak} (+${rescPts})</span>`;
      }
    } else if (isRescape) {
      pointsBadges += `<span class="history-rescape-badge">🎫 rescapé</span>`;
    }

    // Calculer les pilules de bonus éphémères pour ce joueur
    let bonusPills = '';
    for (const bonus of roundBonuses) {
      const result = bonus.effect_result;
      if (!result) continue;

      const entryId = String(entry.id);

      // Dans l'historique du challenge principal, on affiche les effets sur les ACTIFS

      // Embuscade - la victime (joueur actif) perd du D+
      if (bonus.bonus_id === 'embuscade' && String(bonus.target_athlete_id) === entryId) {
        const amount = result.stolenElevation || 0;
        if (amount > 0) {
          bonusPills += `<span class="bonus-tag ephemeral-stolen" title="Embuscade par ${bonus.athlete_name}">🏹 -${formatElevation(amount, false)} m</span>`;
        }
      }

      // Ravitaillement - la cible (joueur actif) gagne du D+
      if (bonus.bonus_id === 'ravitaillement' && String(bonus.target_athlete_id) === entryId) {
        const amount = result.bonusElevation || 0;
        if (amount > 0) {
          bonusPills += `<span class="bonus-tag ephemeral-gained" title="Ravitaillement de ${bonus.athlete_name}">🍖 +${formatElevation(amount, false)} m</span>`;
        }
      }

      // Note: marquage, malédiction, kamikaze sont entre éliminés, pas dans le challenge principal
    }

    return `
      <div class="history-ranking-row ${isEliminated ? 'eliminated' : ''} ${isRescape ? 'rescape' : ''}">
        <span class="history-rank">${position}</span>
        <span class="history-name">${entry.name}</span>
        <span class="history-elevation">${formatElevation(entry.elevation || 0, false)}${bonusPills ? ` ${bonusPills}` : ''}</span>
        ${isEliminated ? '<span class="history-elim-badge">Éliminé</span>' : ''}
        ${pointsBadges}
      </div>
    `;
  }).join('');

  // Construire le HTML complet
  let html = `<div class="history-item" data-round="${globalRound}">
    <div class="history-round-header" onclick="toggleRoundDetails(${globalRound})">
      <div class="history-round">Round ${roundInSeason}</div>
      <span class="history-toggle-icon">▼</span>
    </div>
    <div class="history-eliminated">
      <span class="history-label">Éliminé(s) :</span>
      ${eliminatedDetails.map(e => {
        if (e.isZeroElim) {
          return `<span class="eliminated-name eliminated-zero">${e.name}</span> <span class="eliminated-gap">(0 D+ - inactif)</span>`;
        } else {
          return `<span class="eliminated-name">${e.name}</span> <span class="eliminated-gap">(à ${formatElevation(e.gap, false)} du maintien)</span>`;
        }
      }).join(', ')}
    </div>
    ${zeroElimCount > 0 ? `<div class="history-zero-warning">⚠️ ${zeroElimCount} joueur${zeroElimCount > 1 ? 's' : ''} éliminé${zeroElimCount > 1 ? 's' : ''} pour inactivité</div>` : ''}`;

  // Afficher les jokers utilisés
  if (jokersUsed.length > 0) {
    const jokerDescriptions = jokersUsed.map(joker => {
      const jokerType = JOKER_TYPES[joker.jokerId];
      const jokerIcon = jokerType?.icon || '🃏';
      const participantName = joker.athleteName || joker.participantName || 'Inconnu';
      const targetName = joker.targetName || 'Inconnu';

      // Chercher les effets dans le ranking
      const targetEntry = ranking.find(e => e.id === joker.targetId);
      const participantEntry = ranking.find(e => e.id === joker.athleteId);

      switch(joker.jokerId) {
        case 'sabotage':
          const sabotageAmount = targetEntry?.sabotageReceived?.amount || 0;
          return `${jokerIcon} ${participantName} a saboté ${targetName} (-${formatElevation(sabotageAmount, false)})`;
        case 'voleur':
          const stolenAmount = targetEntry?.theftReceived?.amount || 0;
          return `${jokerIcon} ${participantName} a volé ${targetName} (-${formatElevation(stolenAmount, false)})`;
        case 'multiplicateur':
          const bonusAmount = participantEntry?.multiplierBonus || 0;
          return `${jokerIcon} ${participantName} a utilisé le multiplicateur (+${formatElevation(bonusAmount, false)})`;
        case 'bouclier':
          return `${jokerIcon} ${participantName} a utilisé le bouclier (protection)`;
        default:
          return `${jokerIcon} ${participantName} a utilisé un joker`;
      }
    });

    html += `<div class="history-jokers">
      <span class="history-label">Jokers :</span> ${jokerDescriptions.join(' • ')}
    </div>`;
  }

  // Afficher les bonus éphémères utilisés ce round
  const bonusesUsed = getBonusesUsedInRound(globalRound, bonusesCache, seasonBonusesCache);
  if (bonusesUsed.length > 0) {
    const bonusDescriptions = bonusesUsed.map(bonus => getBonusHistoryDescription(bonus));

    html += `<div class="history-bonuses">
      <span class="history-label">Bonus éphémères :</span> ${bonusDescriptions.join(' • ')}
    </div>`;
  }

  // Ajouter le dropdown du classement (caché par défaut)
  html += `
    <div class="history-ranking-dropdown" id="ranking-${globalRound}" style="display: none;">
      <div class="history-ranking-title">📊 Classement du round</div>
      <div class="history-ranking-list">
        ${rankingHtml}
      </div>
    </div>
  </div>`;

  return html;
}

// ============================================
// GESTION DES ÉVÉNEMENTS JOKERS
// ============================================

// ============================================
// INITIALISATION
// ============================================

// État du polling
let lastActivitiesCount = 0;
let lastModified = null;
let pollingInterval = null;

async function init() {

  const loadingScreen = document.getElementById('loadingScreen');

  try {
    // Charger les participants depuis l'API (mode 2026) ou utiliser la liste statique (mode démo)
    await loadParticipants();

    if (PARTICIPANTS.length === 0) {
      console.error('❌ Aucun participant chargé !');
      if (loadingScreen) {
        loadingScreen.innerHTML = `
          <div class="loading-content">
            <div class="loading-icon">⚠️</div>
            <div class="loading-title">Aucun participant</div>
            <div class="loading-text">Aucun participant inscrit pour le moment.<br>Inscrivez-vous sur la page d'inscription.</div>
            <a href="inscription.html" style="margin-top:20px;color:var(--accent-primary);text-decoration:none;padding:10px 20px;border:1px solid var(--accent-primary);border-radius:8px;">→ S'inscrire</a>
            <button onclick="location.reload()" style="margin-top:12px;background:transparent;border:1px solid rgba(255,255,255,0.3);color:white;padding:8px 16px;border-radius:6px;cursor:pointer;">↻ Réessayer</button>
          </div>
        `;
      }
      return;
    }


    // Charger les résultats figés AVANT tout calcul
    await loadFrozenResults();

    // Charger les règles spéciales manuelles
    await loadSpecialRulesOverrides();

    // Charger les bonus éphémères
    await loadBonuses();

    // Initialiser les jokers (AWAIT AJOUTÉ - important pour charger avant le calcul)
    await initializeJokersState();

    // Charger les données
    await loadActivities();

    // Initialiser le compteur pour le polling
    lastActivitiesCount = allActivities.length;

    // Initialiser le mode démo si slider présent
    if (document.getElementById('dateSliderContainer')) {
      initDemoMode({
        onDateChange: () => renderAll(),
        showSlider: true,
        enableRightClick: false // Géré séparément pour les jokers
      });
    }

    // Premier rendu
    renderAll();

    // Démarrer le polling automatique (sauf en mode démo)
    if (!CHALLENGE_CONFIG.isDemo) {
      startAutoRefresh();
    }


  } catch (error) {
    console.error('❌ Erreur d\'initialisation:', error);
    if (loadingScreen) {
      loadingScreen.innerHTML = `
        <div class="loading-content">
          <div class="loading-icon">❌</div>
          <div class="loading-title">Erreur de connexion</div>
          <div class="loading-text">Impossible de charger les données.<br>Vérifiez votre connexion internet.</div>
          <button onclick="location.reload()" style="margin-top:20px;background:var(--accent-primary);border:none;color:white;padding:12px 24px;border-radius:8px;cursor:pointer;font-weight:600;">↻ Réessayer</button>
        </div>
      `;
    }
  }
}

/**
 * Polling automatique pour détecter les nouvelles activités
 */
function startAutoRefresh() {
  const POLLING_INTERVAL = 180000; //3 min


  pollingInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/activities-status/${CHALLENGE_CONFIG.leagueId}`);
      if (!response.ok) return;

      const status = await response.json();

      // Vérifier si les données ont changé
      if (status.count !== lastActivitiesCount || status.lastModified !== lastModified) {

        // Afficher une notification si nouvelle activité
        if (status.count > lastActivitiesCount && status.lastActivity) {
          updateTickerWithNewActivity(status.lastActivity);
        }

        // Mettre à jour les compteurs
        lastActivitiesCount = status.count;
        lastModified = status.lastModified;

        // Recharger les données et rafraîchir
        await loadActivities();
        renderAll();

      }
    } catch (error) {
      // Silencieux - on ne veut pas spammer la console
    }
  }, POLLING_INTERVAL);
}

/**
 * Affiche le bandeau ticker des activités récentes (aujourd'hui + hier)
 * Desktop: en bas de page (fixed)
 * Mobile: dans la nav sticky
 */
function renderActivityTicker() {
  // Récupérer les activités des dernières 48h
  const now = getCurrentDate();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const recentActivities = allActivities
    .filter(a => {
      const actDate = new Date(a.start_date_local || a.start_date);
      return actDate >= yesterday;
    })
    .sort((a, b) => new Date(b.start_date_local || b.start_date) - new Date(a.start_date_local || a.start_date));

  // Ajouter les styles du ticker
  injectTickerStyles();

  // Générer le contenu du ticker
  let tickerContent = '';

  if (recentActivities.length === 0) {
    tickerContent = `
      <div class="ticker-track">
        <span class="ticker-item ticker-no-activity">Aucune activité dans les dernières 48h • En attente de nouvelles sorties...</span>
      </div>
    `;
  } else {
    // Générer les items du ticker
    const tickerItems = recentActivities.map(activity => {
      const date = new Date(activity.start_date_local || activity.start_date);
      const isToday = date.toDateString() === now.toDateString();
      const dateStr = isToday ? "Auj." : "Hier";
      const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const athleteName = activity.athlete_name || getParticipantById(activity.athlete_id)?.name || 'Inconnu';
      const sportIcon = getSportIcon(activity.sport_type || activity.type);
      const elevation = Math.round(activity.total_elevation_gain || 0);

      return `<span class="ticker-item">
        <span class="ticker-date">${dateStr} ${timeStr}</span>
        <span class="ticker-sep">•</span>
        <span class="ticker-athlete">${athleteName}</span>
        <span class="ticker-sep">•</span>
        <span class="ticker-activity">${truncateText(activity.name, 20)}</span>
        <span class="ticker-sep">•</span>
        <span class="ticker-sport">${sportIcon}</span>
        <span class="ticker-elev">+${elevation}m</span>
        <span class="ticker-div">│</span>
      </span>`;
    }).join('');

    // Tripler le contenu pour boucle infinie seamless
    const fullContent = tickerItems + tickerItems + tickerItems;
    tickerContent = `<div class="ticker-track">${fullContent}</div>`;
  }

  // Appliquer aux deux tickers (mobile et desktop)
  const tickerMobile = document.getElementById('activityTickerMobile');
  const tickerDesktop = document.getElementById('activityTickerDesktop');

  if (tickerMobile) tickerMobile.innerHTML = tickerContent;
  if (tickerDesktop) tickerDesktop.innerHTML = tickerContent;

  // Calculer la durée d'animation
  const itemCount = recentActivities.length;
  const duration = Math.max(30, itemCount * 8);

  // Appliquer la durée aux deux tracks
  [tickerMobile, tickerDesktop].forEach(ticker => {
    if (ticker) {
      const track = ticker.querySelector('.ticker-track');
      if (track) track.style.animationDuration = `${duration}s`;
    }
  });
}

/**
 * Tronque un texte à une longueur maximale
 */
function truncateText(text, maxLength) {
  if (!text) return '';
  return text.length > maxLength ? text.substring(0, maxLength) + '…' : text;
}

/**
 * Retourne l'icône correspondant au type de sport
 * Modifie cette fonction pour changer les emojis
 */
function getSportIcon(sportType) {
  const icons = {
    'Run': '👟',
    'TrailRun': '⛰️',
    'Hike': '🥾',
    'Walk': '🚶',
    'Ride': '🚴',
    'MountainBikeRide': '🚵',
    'GravelRide': '🚴',
    'BackcountrySki': '⛷️',
    'NordicSki': '🎿',
    'Snowshoe': '❄️'
  };
  return icons[sportType] || '👟';
}

/**
 * Injecte les styles CSS du ticker
 */
function injectTickerStyles() {
  if (document.getElementById('ticker-styles')) return;

  const style = document.createElement('style');
  style.id = 'ticker-styles';
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');

    /* Base commune */
    .activity-ticker {
      width: 100%;
      height: 22px;
      background: #0a0a0a;
      overflow: hidden;
      font-family: 'VT323', 'Courier New', monospace;
      display: flex;
      align-items: center;
    }

    /* Desktop: fixed en bas de page */
    .activity-ticker-desktop {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 9999;
      border-top: 1px solid #f97316;
    }

    /* Mobile: dans la nav, caché par défaut sur desktop */
    .activity-ticker-mobile {
      border-bottom: 1px solid #f97316;
      display: none;
    }

    /* Responsive: inverser l'affichage sur mobile */
    @media (max-width: 768px) {
      .activity-ticker-desktop {
        display: none;
      }

      .activity-ticker-mobile {
        display: flex;
        height: 20px;
      }
    }

    /* Padding body pour ne pas cacher le contenu par le ticker desktop */
    @media (min-width: 769px) {
      body {
        padding-bottom: 24px;
      }
    }

    .ticker-track {
      display: inline-flex;
      align-items: center;
      height: 100%;
      white-space: nowrap;
      animation: ticker-scroll 60s linear infinite;
      transform: translateX(-25%);
      line-height: 22px;
    }

    @keyframes ticker-scroll {
      0% {
        transform: translateX(-25%);
      }
      100% {
        transform: translateX(-58.33%);
      }
    }

    .ticker-track:hover {
      animation-play-state: paused;
    }

    .ticker-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 14px;
      letter-spacing: 0.3px;
      line-height: 1;
    }

    .ticker-date {
      color: #f97316;
      font-weight: bold;
    }

    .ticker-sep {
      color: #555;
      margin: 0 2px;
    }

    .ticker-athlete {
      color: #22d3ee;
      font-weight: bold;
    }

    .ticker-activity {
      color: #d4d4d4;
    }

    .ticker-sport {
      font-size: 11px;
      line-height: 1;
    }

    .ticker-elev {
      color: #10b981;
      font-weight: bold;
    }

    .ticker-div {
      color: #333;
      margin: 0 10px;
      font-size: 14px;
    }

    .ticker-no-activity {
      color: #666;
      padding: 0 20px;
      font-size: 13px;
    }

    /* Mobile adjustments */
    @media (max-width: 768px) {
      .ticker-track {
        line-height: 20px;
      }

      .ticker-item {
        font-size: 12px;
        gap: 3px;
      }

      .ticker-div {
        margin: 0 6px;
      }

      .ticker-sport {
        font-size: 10px;
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Met à jour le ticker quand de nouvelles activités arrivent
 */
function updateTickerWithNewActivity(activity) {
  // Simplement re-render le ticker complet
  renderActivityTicker();
}

// ============================================
// ÉVÉNEMENTS DOM
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  init();

  document.getElementById('loginBtn')?.addEventListener('click', () => {
    window.location.href = 'login.html';
  });

  // ============================================
  // TOGGLE Classement Principal / Éliminé
  // ============================================
  // Au refresh, on revient au tableau Principal par défaut (pas de persistance).
  setupRankingToggle();
});

function setupRankingToggle() {
  const buttons = document.querySelectorAll('.ranking-toggle-btn');
  if (buttons.length === 0) return;

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      if (!targetId) return;

      // Mettre à jour l'état actif des boutons
      buttons.forEach(b => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });

      // Afficher/masquer les containers
      const principalContainer = document.getElementById('rankingContainer');
      const eliminatedContainer = document.getElementById('eliminatedChallengeContainer');
      if (principalContainer && eliminatedContainer) {
        const showPrincipal = targetId === 'rankingContainer';
        principalContainer.classList.toggle('ranking-container-hidden', !showPrincipal);
        eliminatedContainer.classList.toggle('ranking-container-hidden', showPrincipal);
      }
    });
  });
}

// ============================================
// BOUTON RÉCAP SAISON PRÉCÉDENTE (achievements)
// ============================================
// Visible uniquement dans les 36 premières heures du R1 de la saison suivante,
// quand la saison précédente est figée dans eliminatedChallengeRankings.
// Au clic : toggle le panneau d'achievements (rempli par renderSeasonRecap).
async function checkAndShowRecapButton() {
  const wrapper = document.getElementById('recapWrapper');
  const btn = document.getElementById('recapToggleBtn');
  const panel = document.getElementById('recapPanel');
  const label = document.getElementById('recapToggleLabel');
  if (!wrapper || !btn || !panel) return;

  try {
    // Récupérer l'état frozen actuel
    const frozen = frozenResultsCache || {};
    const elimRankings = frozen.eliminatedChallengeRankings || {};
    const frozenSeasons = Object.keys(elimRankings)
      .map(Number)
      .filter(n => !isNaN(n))
      .sort((a, b) => b - a);
    if (frozenSeasons.length === 0) return;

    const lastFrozenSeason = frozenSeasons[0];
    const currentSeason = lastFrozenSeason + 1;

    // Trouver la date de début du R1 de la saison courante
    const firstRoundOfCurrent = findFirstRoundOfSeason(currentSeason, frozen);
    if (!firstRoundOfCurrent) return;
    const r1Start = new Date(firstRoundOfCurrent.dates?.start || firstRoundOfCurrent.startDate);
    if (isNaN(r1Start.getTime())) return;

    // Fenêtre de 36h après le début du R1
    const now = getCurrentDate ? getCurrentDate() : new Date();
    const cutoff = new Date(r1Start.getTime() + 36 * 60 * 60 * 1000);
    if (now > cutoff || now < r1Start) return; // hors fenêtre

    // Afficher le bouton
    if (label) label.textContent = `Récap saison ${lastFrozenSeason}`;
    wrapper.style.display = '';

    // Gestion du toggle (idempotent : safe si rappelé)
    if (!btn.dataset.recapBound) {
      btn.addEventListener('click', () => {
        const isOpen = panel.style.display !== 'none';
        panel.style.display = isOpen ? 'none' : 'block';
        btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        btn.querySelector('.recap-toggle-chevron').textContent = isOpen ? '▼' : '▲';
        // Premier affichage : rendre le contenu
        if (!isOpen && !panel.dataset.rendered) {
          renderSeasonRecap(panel, lastFrozenSeason, frozen);
          panel.dataset.rendered = '1';
        }
      });
      btn.dataset.recapBound = '1';
    }
  } catch (e) {
    console.warn('Erreur checkAndShowRecapButton:', e);
  }
}

/**
 * Trouve le premier round (chronologiquement) d'une saison donnée.
 * Pour la saison "courante" (non encore figée), on ne le trouve PAS dans
 * frozen.rounds, donc on calcule à partir du dernier round figé de la
 * saison précédente.
 */
function findFirstRoundOfSeason(seasonNumber, frozen) {
  const rounds = frozen?.rounds || {};
  // 1. Chercher dans les rounds figés un round.seasonNumber === seasonNumber
  for (const [k, r] of Object.entries(rounds)) {
    if (Number(r?.seasonNumber) === Number(seasonNumber) && r.roundInSeason === 1) {
      return r;
    }
  }
  // 2. Sinon : calculer depuis le dernier round de la saison précédente
  const prevSeasonRounds = Object.values(rounds)
    .filter(r => Number(r?.seasonNumber) === seasonNumber - 1)
    .sort((a, b) => (b.roundNumber || 0) - (a.roundNumber || 0));
  if (prevSeasonRounds.length === 0) return null;
  const lastPrevEnd = new Date(prevSeasonRounds[0].dates?.end);
  if (isNaN(lastPrevEnd.getTime())) return null;
  // Le R1 de la saison N+1 commence à end + 1ms (en pratique le lendemain à 00h00)
  return {
    dates: { start: new Date(lastPrevEnd.getTime() + 1).toISOString() }
  };
}

/**
 * Rend le contenu du panneau d'achievements pour une saison figée.
 * Affiche : podium finale + ranking éliminés + 5 achievements (top D+,
 * top usage jokers, top ciblé, surperformance, sous-performance).
 *
 * @param {HTMLElement} panel - Container du panneau
 * @param {number} seasonNumber - Saison figée à récapituler
 * @param {Object} frozen - Cache complet de frozen_results.json
 */
function renderSeasonRecap(panel, seasonNumber, frozen) {
  const recap = computeSeasonRecap(seasonNumber, frozen);
  if (!recap) {
    panel.innerHTML = `<div class="recap-empty">Données indisponibles pour la saison ${seasonNumber}.</div>`;
    return;
  }

  // Saison team : podium et classement éliminés présentés par équipe
  const isTeam = recap.seasonType === 'team';

  panel.innerHTML = `
    <div class="recap-grid">
      <!-- Podium finale principale -->
      ${isTeam ? renderTeamFinalePodium(recap.finaleTeams) : renderIndividualFinalePodium(recap.finalePodium)}

      <!-- Classement éliminés (span 2 rows sur desktop) -->
      ${isTeam ? renderTeamEliminatedRanking(recap.eliminatedTeams) : renderIndividualEliminatedRanking(recap.eliminatedRanking)}

      <!-- D+ ligue saison -->
      ${renderLeagueStatsCard(recap.leagueStats, recap.seasonNumber)}

      <!-- Round le plus chaud -->
      ${renderHottestRoundCard(recap.hottestByElev, recap.hottestByActs)}

      <!-- Plus grosse activité solo -->
      ${renderBiggestActivityCard(recap.biggestActivity)}

      <!-- Total points -->
      ${renderAchievementCard('💯', 'Total points saison', recap.topTotalPoints, '', 'pts')}

      <!-- Top D+ saison -->
      ${renderAchievementCard('🏔️', 'Top D+ saison', recap.topElevation, 'm')}

      <!-- Efficacité D+/pts -->
      ${renderEfficiencyCard(recap.topEfficiency, recap.flopEfficiency)}

      <!-- Sport le plus pratiqué -->
      ${renderTopSportsCard(recap.topSports)}

      <!-- Top usage jokers/bonus -->
      ${renderAchievementCard('🃏', 'Top usage jokers/bonus', recap.topJokerUsage, '', 'fois')}

      <!-- Top ciblé -->
      ${renderAchievementCard('🎯', 'Plus ciblé par jokers/bonus', recap.topTargeted, '', 'fois')}

      <!-- Surperformance -->
      ${renderAchievementCard('📈', 'Plus grosse surperformance', recap.topSurperf, '', 'pl.', true)}

      <!-- Sous-performance -->
      ${renderAchievementCard('📉', 'Plus grosse sous-performance', recap.topSousperf, '', 'pl.', true)}
    </div>
  `;
}

/** Podium finale en mode individuel (saisons standard) */
function renderIndividualFinalePodium(podium) {
  return `
    <div class="recap-card recap-card-finale">
      <h3 class="recap-card-title">🏆 Podium finale principale</h3>
      <ol class="recap-podium">
        ${podium.map((p, i) => `
          <li class="recap-podium-row ${i === 0 ? 'gold' : i === 1 ? 'silver' : 'bronze'}">
            <span class="recap-medal">${['🥇','🥈','🥉'][i]}</span>
            <span class="recap-podium-name">${p.name}</span>
            <span class="recap-podium-value">${formatElevation(p.elevation, false)} m • ${p.mainPoints} pts</span>
          </li>
        `).join('')}
      </ol>
    </div>
  `;
}

/** Podium finale en mode team (saison 4+) : équipe gagnante vs équipe vaincue */
function renderTeamFinalePodium(finaleTeams) {
  if (!finaleTeams || finaleTeams.length === 0) {
    return `<div class="recap-card recap-card-finale">
      <h3 class="recap-card-title">🏆 Podium finale principale</h3>
      <div class="recap-empty">Aucune équipe finaliste</div>
    </div>`;
  }
  return `
    <div class="recap-card recap-card-finale">
      <h3 class="recap-card-title">🏆 Finale principale (équipes)</h3>
      <div class="recap-team-finale">
        ${finaleTeams.map((t, i) => `
          <div class="recap-team-block ${i === 0 ? 'winner' : 'loser'}" style="border-left-color:${t.color?.border || '#fbbf24'};">
            <div class="recap-team-header">
              <span class="recap-team-medal">${i === 0 ? '🥇 Vainqueur' : '⚔️ Finaliste vaincu'}</span>
              <span class="recap-team-name">${t.animal?.emoji || ''} ${t.animal?.name || t.color?.name || 'Équipe'}</span>
              <span class="recap-team-elev">${formatElevation(t.totalElevation || 0, false)} m</span>
            </div>
            <ol class="recap-team-members">
              ${(t.members || []).map(m => `
                <li>
                  <span class="recap-team-member-name">${m.name}</span>
                  <span class="recap-team-member-value">${formatElevation(m.elevation || 0, false)} m • ${m.mainPoints || 0} pts</span>
                </li>
              `).join('')}
            </ol>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/** Classement éliminés individuel (saisons standard) */
function renderIndividualEliminatedRanking(ranking) {
  return `
    <div class="recap-card recap-card-eliminated">
      <h3 class="recap-card-title">👻 Challenge éliminés</h3>
      <ol class="recap-list">
        ${ranking.map((e, i) => `
          <li class="recap-list-row">
            <span class="recap-pos">#${i + 1}</span>
            <span class="recap-name">${e.name}</span>
            <span class="recap-value">${formatElevation(e.totalElevation, false)} m • ${e.points} pts</span>
          </li>
        `).join('')}
      </ol>
    </div>
  `;
}

/** Classement éliminés par équipes (saison team) */
function renderTeamEliminatedRanking(teams) {
  if (!teams || teams.length === 0) {
    return `<div class="recap-card">
      <h3 class="recap-card-title">👻 Challenge éliminés (équipes)</h3>
      <div class="recap-empty">Aucune équipe éliminée</div>
    </div>`;
  }
  return `
    <div class="recap-card">
      <h3 class="recap-card-title">👻 Challenge éliminés (équipes)</h3>
      <ol class="recap-team-list">
        ${teams.map((t, i) => `
          <li class="recap-team-row" style="border-left-color:${t.color?.border || '#888'};">
            <div class="recap-team-row-header">
              <span class="recap-pos">#${i + 1}</span>
              <span class="recap-team-name-inline">${t.animal?.emoji || ''} ${t.animal?.name || t.color?.name || 'Équipe'}</span>
              <span class="recap-value">${formatElevation(t.totalElevation || 0, false)} m</span>
            </div>
            <div class="recap-team-row-members">
              ${(t.members || []).map(m =>
                `<span class="recap-team-member-pill">${m.name} <em>${formatElevation(m.elevation || 0, false)}m</em> · ${m.points || 0} pts</span>`
              ).join('')}
            </div>
          </li>
        `).join('')}
      </ol>
    </div>
  `;
}

/**
 * Carte d'achievement : top 1 visible par défaut, hover = top 5 en dropdown.
 */
function renderAchievementCard(icon, title, leaderboard, unitBefore = '', unitAfter = '', isPosition = false) {
  if (!leaderboard || leaderboard.length === 0) {
    return `<div class="recap-card">
      <h3 class="recap-card-title">${icon} ${title}</h3>
      <div class="recap-empty">Aucune donnée</div>
    </div>`;
  }

  const formatVal = (v) => {
    if (isPosition) return (v > 0 ? '+' : '') + v + ' ' + unitAfter;
    if (unitBefore === 'm') return formatElevation(v, false) + ' m';
    return v + (unitAfter ? ' ' + unitAfter : '');
  };

  const top1 = leaderboard[0];
  const top5 = leaderboard.slice(0, 5);

  return `
    <div class="recap-card recap-achievement" tabindex="0">
      <h3 class="recap-card-title">${icon} ${title}</h3>
      <div class="recap-top1">
        <span class="recap-top1-name">${top1.name}</span>
        <span class="recap-top1-value">${formatVal(top1.value)}</span>
      </div>
      <div class="recap-top5">
        <div class="recap-top5-title">Top 5</div>
        <ol class="recap-top5-list">
          ${top5.map((e, i) => `
            <li>
              <span class="recap-top5-pos">${i + 1}.</span>
              <span class="recap-top5-name">${e.name}</span>
              <span class="recap-top5-value">${formatVal(e.value)}</span>
            </li>
          `).join('')}
        </ol>
      </div>
    </div>
  `;
}

/**
 * Calcule tous les achievements d'une saison à partir des données figées.
 * Retourne null si impossible (saison non figée, données manquantes).
 */
/** Carte "D+ ligue saison" : total absolu + par jour + comparaison saison N-1 */
function renderLeagueStatsCard(stats, seasonNumber) {
  if (!stats) return '';
  const cmp = stats.comparison;
  const deltaIcon = cmp ? (cmp.deltaTotal > 0 ? '📈' : cmp.deltaTotal < 0 ? '📉' : '➡️') : '';
  return `
    <div class="recap-card">
      <h3 class="recap-card-title">🌍 D+ ligue saison</h3>
      <div class="recap-league-stats">
        <div class="recap-league-row">
          <span class="recap-league-label">Total</span>
          <span class="recap-league-value">${formatElevation(stats.total, false)} m</span>
        </div>
        <div class="recap-league-row">
          <span class="recap-league-label">Par jour (${stats.daysInSeason} j)</span>
          <span class="recap-league-value">${formatElevation(stats.perDay, false)} m/j</span>
        </div>
        ${cmp ? `
          <div class="recap-league-comparison">
            <div class="recap-league-cmp-title">vs Saison ${cmp.previousSeason}</div>
            <div class="recap-league-row">
              <span class="recap-league-label">${deltaIcon} Total</span>
              <span class="recap-league-value ${cmp.deltaTotal >= 0 ? 'positive' : 'negative'}">
                ${cmp.deltaTotal >= 0 ? '+' : ''}${formatElevation(cmp.deltaTotal, false)} m (${cmp.deltaTotalPercent >= 0 ? '+' : ''}${cmp.deltaTotalPercent}%)
              </span>
            </div>
            <div class="recap-league-row">
              <span class="recap-league-label">Par jour</span>
              <span class="recap-league-value ${cmp.deltaPerDay >= 0 ? 'positive' : 'negative'}">
                ${cmp.deltaPerDay >= 0 ? '+' : ''}${formatElevation(cmp.deltaPerDay, false)} m/j (${cmp.deltaPerDayPercent >= 0 ? '+' : ''}${cmp.deltaPerDayPercent}%)
              </span>
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/** Carte "Round le plus chaud" (par D+ et par activités) */
function renderHottestRoundCard(byElev, byActs) {
  if (!byElev && !byActs) return '';
  return `
    <div class="recap-card">
      <h3 class="recap-card-title">🔥 Round le plus chaud</h3>
      <div class="recap-hottest">
        ${byElev ? `
          <div class="recap-hottest-row">
            <div class="recap-hottest-label">Plus de D+</div>
            <div class="recap-hottest-value">Round ${byElev.roundInSeason || byElev.roundNumber}</div>
            <div class="recap-hottest-detail">${formatElevation(byElev.totalElevation, false)} m</div>
          </div>
        ` : ''}
        ${byActs && byActs.roundNumber !== byElev?.roundNumber ? `
          <div class="recap-hottest-row">
            <div class="recap-hottest-label">Plus d'activités</div>
            <div class="recap-hottest-value">Round ${byActs.roundInSeason || byActs.roundNumber}</div>
            <div class="recap-hottest-detail">${byActs.totalActivities} activités</div>
          </div>
        ` : byActs ? `
          <div class="recap-hottest-row">
            <div class="recap-hottest-label">Activités</div>
            <div class="recap-hottest-detail">${byActs.totalActivities} activités</div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/** Carte "Plus grosse activité solo" */
function renderBiggestActivityCard(act) {
  if (!act) {
    return `<div class="recap-card">
      <h3 class="recap-card-title">⛰️ Plus grosse activité</h3>
      <div class="recap-empty">Aucune donnée</div>
    </div>`;
  }
  const date = new Date(act.date);
  const dateStr = isNaN(date.getTime()) ? '' : date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  return `
    <div class="recap-card">
      <h3 class="recap-card-title">⛰️ Plus grosse activité</h3>
      <div class="recap-biggest-act">
        <div class="recap-biggest-elev">${formatElevation(act.elevation, false)} m</div>
        <div class="recap-biggest-name">${act.name}</div>
        <div class="recap-biggest-meta">${act.athleteName} • ${dateStr}</div>
      </div>
    </div>
  `;
}

/** Carte "Sport le plus pratiqué" */
function renderTopSportsCard(sports) {
  if (!sports || sports.length === 0) {
    return `<div class="recap-card">
      <h3 class="recap-card-title">🏃 Sport préféré</h3>
      <div class="recap-empty">Aucune donnée</div>
    </div>`;
  }
  const total = sports.reduce((s, x) => s + x.value, 0);
  // Mapping des noms anglais → français + emoji
  const sportLabels = {
    Ride: '🚴 Vélo route',
    MountainBikeRide: '🚵 VTT',
    GravelRide: '🚲 Gravel',
    EBikeRide: '🚴‍♂️ E-Bike',
    EMountainBikeRide: '🚵 E-VTT',
    VirtualRide: '🎮 Home trainer',
    Run: '🏃 Course',
    TrailRun: '🏃‍♂️ Trail',
    Hike: '🥾 Rando',
    Walk: '🚶 Marche',
    BackcountrySki: '⛷️ Ski rando',
    NordicSki: '🎿 Ski nordique',
    Snowshoe: '❄️ Raquettes'
  };
  return `
    <div class="recap-card">
      <h3 class="recap-card-title">🏃 Sport le plus pratiqué</h3>
      <ol class="recap-sport-list">
        ${sports.slice(0, 5).map(s => {
          const pct = total > 0 ? Math.round(s.value / total * 100) : 0;
          return `<li class="recap-sport-row">
            <span class="recap-sport-name">${sportLabels[s.name] || s.name}</span>
            <span class="recap-sport-value">${s.value} (${pct}%)</span>
          </li>`;
        }).join('')}
      </ol>
    </div>
  `;
}

/** Carte "Efficacité D+/pts" : top 3 (les efficaces) + flop 3 (les bosseurs) */
function renderEfficiencyCard(top3, flop3) {
  if ((!top3 || top3.length === 0) && (!flop3 || flop3.length === 0)) {
    return `<div class="recap-card">
      <h3 class="recap-card-title">⚖️ Efficacité D+/pts</h3>
      <div class="recap-empty">Aucune donnée</div>
    </div>`;
  }
  return `
    <div class="recap-card">
      <h3 class="recap-card-title">⚖️ Efficacité D+/pts</h3>
      <div class="recap-efficiency">
        ${top3.length > 0 ? `
          <div class="recap-eff-group">
            <div class="recap-eff-title">🎯 Plus efficaces (peu de D+ / pt)</div>
            <ol class="recap-eff-list">
              ${top3.map((e, i) => `
                <li><span>${i+1}. ${e.name}</span>
                  <span class="recap-eff-value">${formatElevation(e.value, false)} m/pt</span>
                </li>
              `).join('')}
            </ol>
          </div>
        ` : ''}
        ${flop3.length > 0 ? `
          <div class="recap-eff-group">
            <div class="recap-eff-title">💪 Travailleurs (gros D+ / peu de pts)</div>
            <ol class="recap-eff-list">
              ${flop3.map((e, i) => `
                <li><span>${i+1}. ${e.name}</span>
                  <span class="recap-eff-value">${formatElevation(e.value, false)} m/pt</span>
                </li>
              `).join('')}
            </ol>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function computeSeasonRecap(seasonNumber, frozen) {
  const elimSeason = frozen?.eliminatedChallengeRankings?.[String(seasonNumber)];
  if (!elimSeason) return null;

  const rounds = frozen.rounds || {};
  const seasonRounds = Object.entries(rounds)
    .filter(([k, r]) => Number(r?.seasonNumber) === Number(seasonNumber))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, r]) => ({ roundNumber: Number(k), ...r }));

  if (seasonRounds.length === 0) return null;

  // Détecter si saison team (= au moins un round avec seasonType: 'team')
  const isTeamSeason = seasonRounds.some(r => r.seasonType === 'team' || r.isTeamSeasonRound);

  // ===== Pour saison TEAM : podium = round finale principale (isFinalePrincipale) =====
  // Pour saison STANDARD : podium = top 3 du dernier round
  let finalePodium = [];
  let finaleTeams = [];
  let eliminatedRanking = [];
  let eliminatedTeams = [];

  if (isTeamSeason) {
    const finalePrincipaleRound = seasonRounds.find(r => r.isFinalePrincipale === true);
    if (finalePrincipaleRound?.teams) {
      // Trier les 2 équipes par totalElevation décroissant
      finaleTeams = [...finalePrincipaleRound.teams]
        .sort((a, b) => (b.totalElevation || 0) - (a.totalElevation || 0))
        .map(t => ({
          color: t.color,
          animal: t.animal,
          totalElevation: t.totalElevation || 0,
          members: (t.members || []).map(m => {
            // Récupérer mainPoints depuis le ranking du round
            const rankingEntry = (finalePrincipaleRound.ranking || []).find(r => String(r.id) === String(m.id));
            return {
              id: m.id,
              name: m.name,
              elevation: m.elevation || 0,
              mainPoints: rankingEntry?.mainPoints || 0
            };
          })
        }));
    }
    // Pour le challenge éliminés team : on présente par équipes
    eliminatedTeams = (elimSeason.teams || [])
      .sort((a, b) => (b.totalElevation || 0) - (a.totalElevation || 0))
      .map(t => ({
        color: t.color,
        animal: t.animal,
        totalElevation: t.totalElevation || 0,
        members: (t.members || []).map(m => {
          // Récupérer les points depuis le ranking individuel
          const entry = (elimSeason.ranking || []).find(r => String(r.id) === String(m.id));
          return {
            id: m.id,
            name: m.name,
            elevation: m.elevation || 0,
            points: entry?.points || 0
          };
        })
      }));
  } else {
    // ===== STANDARD : podium top 3 du dernier round =====
    const finalRound = seasonRounds[seasonRounds.length - 1];
    finalePodium = (finalRound.ranking || [])
      .slice(0, 3)
      .map(r => ({
        id: r.id,
        name: r.name,
        elevation: r.elevation || 0,
        mainPoints: r.mainPoints || 0,
        isWinner: r.isWinner === true
      }));

    // === Fix bug "vainqueur 0 pts" ===
    // Si la finale s'est jouée mais qu'aucun joueur n'a `isWinner: true`,
    // on détecte le vainqueur : c'est le seul survivant non-éliminé du
    // dernier round. Il reçoit les 24 pts de la 1re place du barème principal.
    const hasExplicitWinner = finalePodium.some(p => p.isWinner);
    if (!hasExplicitWinner) {
      const nonEliminated = (finalRound.ranking || []).filter(r => r.eliminatedPosition == null);
      if (nonEliminated.length === 1) {
        // 1 seul survivant : c'est le vainqueur. Lui attribuer 24 pts.
        const winnerId = String(nonEliminated[0].id);
        const winnerEntry = finalePodium.find(p => String(p.id) === winnerId);
        if (winnerEntry) {
          winnerEntry.mainPoints = 24;
          winnerEntry.isWinner = true;
        }
      }
    }

    // Classement éliminés : tous ceux avec des points > 0
    eliminatedRanking = (elimSeason.ranking || [])
      .filter(r => (r.points || 0) > 0)
      .map(r => ({
        id: r.id || r.participant?.id,
        name: r.name || r.participant?.name,
        totalElevation: r.totalElevation || 0,
        points: r.points || 0
      }));
  }

  // ===== 3. TOP D+ SAISON =====
  // Somme : D+ principal (tous les rounds de la saison) + D+ challenge éliminés
  const elevByAthlete = {};
  for (const r of seasonRounds) {
    for (const entry of (r.ranking || [])) {
      const id = String(entry.id);
      if (!elevByAthlete[id]) elevByAthlete[id] = { id, name: entry.name, value: 0 };
      elevByAthlete[id].value += (entry.elevation || 0);
    }
  }
  for (const entry of (elimSeason.ranking || [])) {
    const id = String(entry.id || entry.participant?.id);
    const name = entry.name || entry.participant?.name;
    if (!elevByAthlete[id]) elevByAthlete[id] = { id, name, value: 0 };
    elevByAthlete[id].value += (entry.totalElevation || 0);
  }
  const topElevation = Object.values(elevByAthlete)
    .map(e => ({ ...e, value: Math.round(e.value) }))
    .sort((a, b) => b.value - a.value);

  // ===== 4. TOP USAGE JOKERS + BONUS =====
  const usageByAthlete = {};
  const incrUsage = (athleteId, athleteName) => {
    const id = String(athleteId);
    if (!usageByAthlete[id]) usageByAthlete[id] = { id, name: athleteName, value: 0 };
    usageByAthlete[id].value++;
  };
  for (const r of seasonRounds) {
    for (const j of (r.jokersUsed || [])) {
      if (j.athleteId) incrUsage(j.athleteId, j.athleteName);
    }
    for (const b of (r.bonusesUsed || [])) {
      if (b.athlete_id) incrUsage(b.athlete_id, b.athlete_name);
    }
  }
  // Compter aussi les bonus saisonniers (qui sont archivés dans seasonBonuses)
  const seasonBonuses = frozen.seasonBonuses?.[String(seasonNumber)] || [];
  for (const b of seasonBonuses) {
    // Éviter de double-compter avec bonusesUsed des rounds : un bonus avec used_in_round
    // a déjà été compté ci-dessus.
    if (b.used_in_round) continue;
    if (b.athlete_id) incrUsage(b.athlete_id, b.athlete_name);
  }
  const topJokerUsage = Object.values(usageByAthlete).sort((a, b) => b.value - a.value);

  // ===== 5. TOP CIBLÉ =====
  const targetedByAthlete = {};
  const incrTarget = (targetId, targetName) => {
    if (!targetId) return;
    const id = String(targetId);
    if (!targetedByAthlete[id]) targetedByAthlete[id] = { id, name: targetName, value: 0 };
    targetedByAthlete[id].value++;
  };
  for (const r of seasonRounds) {
    for (const j of (r.jokersUsed || [])) {
      if (j.targetId) incrTarget(j.targetId, j.targetName);
    }
    for (const b of (r.bonusesUsed || [])) {
      if (b.target_athlete_id) incrTarget(b.target_athlete_id, b.target_athlete_name);
    }
  }
  for (const b of seasonBonuses) {
    if (b.used_in_round) continue;
    if (b.target_athlete_id) incrTarget(b.target_athlete_id, b.target_athlete_name);
  }
  const topTargeted = Object.values(targetedByAthlete).sort((a, b) => b.value - a.value);

  // ===== 6. SUR/SOUS-PERFORMANCE =====
  // Comparer 2 classements :
  //   A. Classement général AVANT la saison (= yearlyStandings au moment où la saison N-1 s'est terminée)
  //   B. Classement des points reçus PENDANT la saison (= main + eliminated)
  //
  // Score = positionAvantSaison - positionPointsSaison.
  //   Positif → surperf (parti bas, fini haut)
  //   Négatif → sous-perf
  const perf = computePerformanceLeaderboard(seasonNumber, frozen, seasonRounds, elimSeason);
  const topSurperf = perf.filter(p => p.value > 0).sort((a, b) => b.value - a.value);
  const topSousperf = perf.filter(p => p.value < 0).sort((a, b) => a.value - b.value);

  // ===== 7. TOTAL POINTS SAISON (principal + éliminé + rescapé + marquage/duel réussis) =====
  const totalPointsByAthlete = {};
  const addPts = (id, name, n) => {
    if (!id || !n) return;
    const k = String(id);
    if (!totalPointsByAthlete[k]) totalPointsByAthlete[k] = { id: k, name, value: 0 };
    totalPointsByAthlete[k].value += n;
  };
  // Points principal
  for (const r of seasonRounds) {
    for (const entry of (r.ranking || [])) {
      addPts(entry.id, entry.name, entry.mainPoints || 0);
    }
    // Si winner détecté côté frontend (24 pts vainqueur), corriger
    if (r.ranking?.length) {
      const nonElim = r.ranking.filter(x => x.eliminatedPosition == null);
      if (nonElim.length === 1) {
        const w = nonElim[0];
        // Ajouter 24 - mainPoints existant pour pas double-compter
        const adjust = 24 - (w.mainPoints || 0);
        if (adjust > 0) addPts(w.id, w.name, adjust);
      }
    }
  }
  // Points éliminés
  for (const entry of (elimSeason.ranking || [])) {
    addPts(entry.id || entry.participant?.id, entry.name || entry.participant?.name, entry.points || 0);
  }
  // Points rescapé : présents dans rescapeInfo de chaque round
  for (const r of seasonRounds) {
    if (r.rescapeInfo?.points) {
      addPts(r.rescapeInfo.athleteId, r.rescapeInfo.athleteName, r.rescapeInfo.points);
    }
  }
  // Points marquage réussi (+1 par marquage où targetEliminated)
  const allBonuses = (frozen.seasonBonuses?.[String(seasonNumber)] || []).concat(
    seasonRounds.flatMap(r => r.bonusesUsed || [])
  );
  const seenBonusIds = new Set();
  for (const b of allBonuses) {
    if (b.id && seenBonusIds.has(b.id)) continue;
    if (b.id) seenBonusIds.add(b.id);
    if (b.bonus_id === 'marquage' && b.effect_result?.targetEliminated === true) {
      addPts(b.athlete_id, b.athlete_name, b.effect_result.pointsAwarded || 1);
    }
    if (b.bonus_id === 'duel' && b.effect_result?.won === true) {
      addPts(b.athlete_id, b.athlete_name, b.effect_result.pointsAwarded || 1);
    }
  }
  const topTotalPoints = Object.values(totalPointsByAthlete).sort((a, b) => b.value - a.value);

  // ===== 8. RATIO D+/PTS =====
  // Top 3 = meilleur ratio points par D+ (efficaces, peu de D+ pour beaucoup de pts)
  // Flop 3 = pire ratio (gros bosseurs sans récompense)
  // Pour éviter division par 0 : on n'inclut que les athlètes avec >= 100m ET >= 1 pt
  const ratioList = [];
  for (const elev of topElevation) {
    const pts = totalPointsByAthlete[elev.id]?.value || 0;
    if (elev.value < 100) continue; // exclure ceux qui n'ont presque rien fait
    const ratio = elev.value / Math.max(pts, 0.5); // m par pt
    ratioList.push({
      id: elev.id,
      name: elev.name,
      value: Math.round(ratio),
      elevation: elev.value,
      points: pts
    });
  }
  // Top efficacité = ratio le PLUS BAS (peu de m par pt = efficace)
  const topEfficiency = [...ratioList].sort((a, b) => a.value - b.value).slice(0, 3);
  // Flop = ratio le PLUS HAUT (beaucoup de m pour peu de pts)
  const flopEfficiency = [...ratioList].sort((a, b) => b.value - a.value).slice(0, 3);

  // ===== 9. D+ LIGUE SAISON (absolu + normalisé par jour) =====
  let totalLeagueElev = 0;
  for (const r of seasonRounds) {
    totalLeagueElev += r.stats?.totalElevation || 0;
  }
  // Ajouter les D+ challenge éliminés (rawElevation = sans bonus, pour éviter double-comptage)
  let totalEliminatedElev = 0;
  for (const entry of (elimSeason.ranking || [])) {
    totalEliminatedElev += entry.rawElevation || 0;
  }
  const leagueTotal = totalLeagueElev + totalEliminatedElev;
  // Nombre de jours de la saison
  const firstRound = seasonRounds[0];
  const lastRound = seasonRounds[seasonRounds.length - 1];
  let daysInSeason = 0;
  if (firstRound?.dates?.start && lastRound?.dates?.end) {
    const startMs = new Date(firstRound.dates.start).getTime();
    const endMs = new Date(lastRound.dates.end).getTime();
    daysInSeason = Math.max(1, Math.round((endMs - startMs) / 86400000));
  } else {
    daysInSeason = seasonRounds.length * 5;
  }
  const leagueDPerDay = Math.round(leagueTotal / daysInSeason);

  // Comparaison saison précédente
  let leagueComparison = null;
  if (seasonNumber > 1) {
    const prevSeasonRounds = Object.values(frozen.rounds || {}).filter(r => r.seasonNumber === seasonNumber - 1);
    if (prevSeasonRounds.length > 0) {
      let prevTotal = 0;
      for (const r of prevSeasonRounds) prevTotal += r.stats?.totalElevation || 0;
      const prevElim = frozen.eliminatedChallengeRankings?.[String(seasonNumber - 1)];
      if (prevElim) {
        for (const e of (prevElim.ranking || [])) prevTotal += e.rawElevation || 0;
      }
      const prevFirst = prevSeasonRounds[0];
      const prevLast = prevSeasonRounds[prevSeasonRounds.length - 1];
      let prevDays = prevSeasonRounds.length * 5;
      if (prevFirst?.dates?.start && prevLast?.dates?.end) {
        prevDays = Math.max(1, Math.round((new Date(prevLast.dates.end).getTime() - new Date(prevFirst.dates.start).getTime()) / 86400000));
      }
      const prevPerDay = Math.round(prevTotal / prevDays);
      leagueComparison = {
        previousSeason: seasonNumber - 1,
        previousTotal: Math.round(prevTotal),
        previousPerDay: prevPerDay,
        deltaTotal: Math.round(leagueTotal - prevTotal),
        deltaPerDay: leagueDPerDay - prevPerDay,
        deltaTotalPercent: prevTotal > 0 ? Math.round((leagueTotal - prevTotal) / prevTotal * 100) : 0,
        deltaPerDayPercent: prevPerDay > 0 ? Math.round((leagueDPerDay - prevPerDay) / prevPerDay * 100) : 0
      };
    }
  }
  const leagueStats = {
    total: Math.round(leagueTotal),
    perDay: leagueDPerDay,
    daysInSeason,
    comparison: leagueComparison
  };

  // ===== 10. ROUND LE PLUS CHAUD (= plus de D+ ou plus d'activités) =====
  const roundsHeat = seasonRounds.map(r => ({
    roundNumber: r.roundNumber,
    roundInSeason: r.roundInSeason,
    totalElevation: r.stats?.totalElevation || 0,
    totalActivities: r.stats?.totalActivities || 0
  }));
  const hottestByElev = [...roundsHeat].sort((a, b) => b.totalElevation - a.totalElevation)[0];
  const hottestByActs = [...roundsHeat].sort((a, b) => b.totalActivities - a.totalActivities)[0];

  // ===== 11. SPORT LE PLUS PRATIQUÉ + 12. PLUS GROSSE ACTIVITÉ SOLO =====
  // Nécessite l'accès à allActivities. Filtrer celles qui sont dans la fenêtre saison.
  const sportCounts = {};
  let biggestActivity = null;
  if (firstRound?.dates?.start && lastRound?.dates?.end && Array.isArray(allActivities)) {
    const startMs = new Date(firstRound.dates.start).getTime();
    const endMs = new Date(lastRound.dates.end).getTime();
    for (const a of allActivities) {
      const ts = new Date(a.start_date).getTime();
      if (isNaN(ts) || ts < startMs || ts > endMs) continue;
      if (a.excluded) continue;
      const sport = a.sport_type || a.type || 'Other';
      sportCounts[sport] = (sportCounts[sport] || 0) + 1;
      // Plus grosse activité
      const elev = a.total_elevation_gain || 0;
      if (!biggestActivity || elev > biggestActivity.elevation) {
        biggestActivity = {
          name: a.name || 'Activité',
          athleteName: a.athlete?.firstname ? `${a.athlete.firstname} ${a.athlete.lastname || ''}`.trim() : (a.athlete_name || 'Inconnu'),
          elevation: Math.round(elev),
          sport,
          date: a.start_date
        };
      }
    }
  }
  const topSports = Object.entries(sportCounts)
    .map(([sport, count]) => ({ name: sport, value: count }))
    .sort((a, b) => b.value - a.value);

  return {
    seasonType: isTeamSeason ? 'team' : 'standard',
    seasonNumber,
    finalePodium,
    finaleTeams,
    eliminatedRanking,
    eliminatedTeams,
    topElevation,
    topJokerUsage,
    topTargeted,
    topSurperf,
    topSousperf,
    // Nouveaux insights
    topTotalPoints,
    topEfficiency,
    flopEfficiency,
    leagueStats,
    hottestByElev,
    hottestByActs,
    topSports,
    biggestActivity
  };
}

/**
 * Construit le classement des performances :
 * - positionAvant = rang du joueur dans le classement général au début de la saison
 * - positionAprès = rang dans le classement des points gagnés CETTE saison uniquement
 * - value = positionAvant - positionAprès (positif = surperf)
 */
function computePerformanceLeaderboard(seasonNumber, frozen, seasonRounds, elimSeason) {
  // 1. Points gagnés PENDANT la saison (main + eliminated)
  const pointsBySeason = {};
  for (const r of seasonRounds) {
    for (const entry of (r.ranking || [])) {
      const id = String(entry.id);
      if (!pointsBySeason[id]) pointsBySeason[id] = { id, name: entry.name, value: 0 };
      pointsBySeason[id].value += (entry.mainPoints || 0);
    }
  }
  for (const entry of (elimSeason.ranking || [])) {
    const id = String(entry.id || entry.participant?.id);
    const name = entry.name || entry.participant?.name;
    if (!pointsBySeason[id]) pointsBySeason[id] = { id, name, value: 0 };
    pointsBySeason[id].value += (entry.points || 0);
  }
  const pointsRanking = Object.values(pointsBySeason).sort((a, b) => b.value - a.value);
  const positionAfter = {};
  pointsRanking.forEach((entry, idx) => { positionAfter[entry.id] = idx + 1; });

  // 2. Classement général AVANT la saison
  // = somme de tous les rounds des saisons < seasonNumber + leur challenge éliminés
  const standingsBefore = {};
  const rounds = frozen.rounds || {};
  const prevRounds = Object.values(rounds).filter(r => Number(r?.seasonNumber) < Number(seasonNumber));
  for (const r of prevRounds) {
    for (const entry of (r.ranking || [])) {
      const id = String(entry.id);
      if (!standingsBefore[id]) standingsBefore[id] = { id, name: entry.name, value: 0 };
      standingsBefore[id].value += (entry.mainPoints || 0);
    }
  }
  const prevElimSeasons = Object.entries(frozen.eliminatedChallengeRankings || {})
    .filter(([k]) => Number(k) < Number(seasonNumber));
  for (const [, season] of prevElimSeasons) {
    for (const entry of (season.ranking || [])) {
      const id = String(entry.id || entry.participant?.id);
      const name = entry.name || entry.participant?.name;
      if (!standingsBefore[id]) standingsBefore[id] = { id, name, value: 0 };
      standingsBefore[id].value += (entry.points || 0);
    }
  }
  const standingsRanking = Object.values(standingsBefore).sort((a, b) => b.value - a.value);
  const positionBefore = {};
  standingsRanking.forEach((entry, idx) => { positionBefore[entry.id] = idx + 1; });

  // 3. Calculer le différentiel pour chaque athlète présent dans positionAfter
  const result = [];
  for (const entry of pointsRanking) {
    const id = entry.id;
    const before = positionBefore[id];
    const after = positionAfter[id];
    if (before == null || after == null) continue;
    result.push({
      id,
      name: entry.name,
      value: before - after, // positif = surperf
      positionBefore: before,
      positionAfter: after,
      pointsSeason: entry.value
    });
  }
  return result;
}

// ============================================
// API PUBLIQUE
// ============================================

export function setAdminMode(enabled) {
  isAdminMode = enabled;
}

// Fonction pour toggle le dropdown du classement d'un round
function toggleRoundDetails(globalRound) {
  const dropdown = document.getElementById(`ranking-${globalRound}`);
  const historyItem = dropdown?.closest('.history-item');
  const toggleIcon = historyItem?.querySelector('.history-toggle-icon');

  if (dropdown) {
    const isVisible = dropdown.style.display !== 'none';
    dropdown.style.display = isVisible ? 'none' : 'block';

    if (toggleIcon) {
      toggleIcon.textContent = isVisible ? '▼' : '▲';
      toggleIcon.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(180deg)';
    }
  }
}

// Exposer globalement pour les onclick dans le HTML
window.toggleRoundDetails = toggleRoundDetails;

window.versant = {
  getCurrentDate,
  setSimulatedDate,
  refresh: renderAll,
  useJoker: jokerUse,
  addJoker,
  removeJoker,
  getJokerStock,
  setAdminMode,
  getActiveJokersForRound,
  toggleRoundDetails
};
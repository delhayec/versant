/**
 * Achievements : calcul partagé par la page stats, l'accueil (étiquettes de
 * changement de leader) et le dashboard (podiums du joueur).
 * Lecture seule : rien ici n'entre dans un score.
 */
import { SPORT_SETTINGS, isValidSport, getRoundDates, getGlobalRoundNumber, CHALLENGE_CONFIG } from './config.js';

const SPORT_CATEGORY = SPORT_SETTINGS.validSports;
const EXCLUDED_SPORTS = new Set(SPORT_SETTINGS.excludedSports);

export function mapSportName(sportType) {
  return SPORT_CATEGORY[sportType] || 'Autre';
}

export function formatElevationCompact(v) {
  if (v == null) return '0';
  if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}

/** Même tri que la page stats : sports valides, depuis le début de l'année, sans doublon. */
export function cleanActivities(raw) {
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const seen = new Set();
  const out = [];
  for (const a of raw || []) {
    if (!a || !a.sport_type || EXCLUDED_SPORTS.has(a.sport_type) || !isValidSport(a.sport_type) || !a.start_date) continue;
    const d = new Date(a.start_date);
    if (isNaN(d.getTime()) || d < start) continue;
    if (a.id != null) { if (seen.has(a.id)) continue; seen.add(a.id); }
    out.push(a.athlete_id != null ? a : { ...a, athlete_id: a.athlete?.id });
  }
  return out;
}

export function computeAthleteStats(data, frozenResults = null) {
  const stats = new Map();

  for (const a of data) {
    const id = a.athlete_id;
    if (!stats.has(id)) {
      stats.set(id, {
        athlete_id: id,
        total_elevation: 0,
        activity_count: 0,
        total_distance: 0,
        total_time: 0,
        best_activity: null,
        elevation_by_sport: {},
        elevation_by_day: {},
        elevation_by_round: {},   // map roundNumber -> { elevation, dateStart }
        activities_without_elevation: 0,
        activities_low_elevation: 0,  // < 100m de D+ (inclut activities_without_elevation)
        night_activities: 0,
        morning_activities: 0,
        weekend_activities: 0,
        max_speed: 0,
        longest_activity_time: 0,
        sports_used: new Set(),
        total_kudos: 0
      });
    }
    const s = stats.get(id);
    s.total_elevation += a.total_elevation_gain || 0;
    s.activity_count++;
    s.total_distance += a.distance || 0;
    s.total_time += a.moving_time || 0;

    const day = a.start_date.substring(0, 10);
    s.elevation_by_day[day] = (s.elevation_by_day[day] || 0) + (a.total_elevation_gain || 0);
    s.sports_used.add(a.sport_type);

    const sport = mapSportName(a.sport_type);
    s.elevation_by_sport[sport] = (s.elevation_by_sport[sport] || 0) + (a.total_elevation_gain || 0);

    // Bin par round (calendrier réel : la durée des rounds peut varier)
    try {
      const actDate = new Date(a.start_date);
      if (actDate >= getRoundDates(1).start) {
        const roundNum = getGlobalRoundNumber(actDate);
        if (!s.elevation_by_round[roundNum]) {
          s.elevation_by_round[roundNum] = { elevation: 0 };
        }
        s.elevation_by_round[roundNum].elevation += a.total_elevation_gain || 0;
      }
    } catch (e) { /* ignore date parse errors */ }

    if (!s.best_activity || (a.total_elevation_gain || 0) > s.best_activity.elevation) {
      s.best_activity = {
        id: a.id,
        elevation: a.total_elevation_gain || 0,
        date: a.start_date,
        name: a.name || 'Activité'
      };
    }

    if (!a.total_elevation_gain || a.total_elevation_gain === 0) s.activities_without_elevation++;
    if ((a.total_elevation_gain || 0) < 100) s.activities_low_elevation++;

    const localTime = a.start_date_local || a.start_date;
    const hour = parseInt(localTime.substring(11, 13));
    if (hour >= 20 || hour < 5) s.night_activities++;
    if (hour >= 4 && hour < 7) s.morning_activities++;

    const dt = new Date(a.start_date);
    if (dt.getDay() === 0 || dt.getDay() === 6) s.weekend_activities++;

    if (a.max_speed && a.max_speed > s.max_speed) s.max_speed = a.max_speed;
    if (a.moving_time && a.moving_time > s.longest_activity_time) s.longest_activity_time = a.moving_time;

    s.total_kudos += a.kudos_count || 0;
  }

  // Lookup points totaux par athlète depuis yearlyStandingsSnapshot
  const pointsByAthlete = {};
  const mainPointsByAthlete = {};
  const elimPointsByAthlete = {};
  const winsByAthlete = {};
  if (frozenResults?.yearlyStandingsSnapshot?.standings) {
    for (const e of frozenResults.yearlyStandingsSnapshot.standings) {
      const id = String(e.id);
      pointsByAthlete[id] = e.totalPoints || 0;
      mainPointsByAthlete[id] = e.totalMainPoints || 0;
      elimPointsByAthlete[id] = e.totalEliminatedPoints || 0;
      winsByAthlete[id] = e.wins || 0;
    }
  }

  const gameStats = computeGameStats(frozenResults);

  return [...stats.values()].map(s => {
    const best24h = Object.entries(s.elevation_by_day).reduce(
      (acc, [day, el]) => el > acc.elevation ? { day, elevation: el } : acc,
      { day: null, elevation: 0 }
    );
    // Plus gros round
    const bestRound = Object.entries(s.elevation_by_round).reduce(
      (acc, [r, info]) => info.elevation > acc.elevation
        ? { roundNumber: parseInt(r, 10), elevation: info.elevation }
        : acc,
      { roundNumber: null, elevation: 0 }
    );
    const totalPoints = pointsByAthlete[String(s.athlete_id)] || 0;
    const mainPoints = mainPointsByAthlete[String(s.athlete_id)] || 0;
    const eliminatedPoints = elimPointsByAthlete[String(s.athlete_id)] || 0;
    const seasonsWon = winsByAthlete[String(s.athlete_id)] || 0;
    // Rapport D+ / points (= combien de m de D+ pour 1 point)
    // Plus c'est bas, plus c'est efficace
    const elevationPerPoint = totalPoints > 0 ? Math.round(s.total_elevation / totalPoints) : 0;
    return {
      ...s,
      elevation_per_distance: s.total_distance > 0 ? (s.total_elevation / (s.total_distance / 1000)).toFixed(1) : 0,
      elevation_per_time: s.total_time > 0 ? (s.total_elevation / (s.total_time / 3600)).toFixed(1) : 0,
      elevation_per_activity: s.activity_count > 0 ? (s.total_elevation / s.activity_count).toFixed(0) : 0,
      best_elevation: s.best_activity ? s.best_activity.elevation : 0,
      best_24h_elevation: best24h.elevation,
      best_24h_day: best24h.day,
      best_round_elevation: bestRound.elevation,
      best_round_number: bestRound.roundNumber,
      num_sports: s.sports_used.size,
      total_points: totalPoints,
      main_points: mainPoints,
      eliminated_points: eliminatedPoints,
      seasons_won: seasonsWon,
      elevation_per_point: elevationPerPoint,
      ...(gameStats[String(s.athlete_id)] || EMPTY_GAME_STATS)
    };
  });
}

const RICRAC_MIN_ROUNDS = 5; // en dessous, la moyenne n'a pas de sens
const EMPTY_GAME_STATS = {
  elim_margin_avg: null, elim_margin_rounds: 0, close_calls: 0,
  finals_played: 0, jokers_used: 0, times_targeted: 0
};

/**
 * Statistiques « de jeu » par athlète, lues dans les rounds figés :
 * - marge moyenne au-dessus de la zone d'élimination, sur les rounds survécus
 *   (rounds individuels avec éliminations, hors finale) : nombre de places
 *   au-dessus du premier éliminé
 * - nombre de rounds sauvés à une place près, finales jouées
 * - jokers utilisés, nombre de fois ciblé par un joker ou un bonus
 */
function computeGameStats(frozenResults) {
  const out = {};
  const get = id => (out[String(id)] ||= { ...EMPTY_GAME_STATS, margin_sum: 0 });

  for (const round of Object.values(frozenResults?.rounds || {})) {
    if (!round?.frozen) continue;
    const ranking = round.ranking || [];

    if (round.isFinalePrincipale) {
      ranking.forEach(e => { get(e.id).finals_played++; });
    }
    for (const j of round.jokersUsed || []) {
      if (j.athleteId) get(j.athleteId).jokers_used++;
      if (j.targetId) get(j.targetId).times_targeted++;
    }
    for (const b of round.bonusesUsed || []) {
      if (b.target_athlete_id) get(b.target_athlete_id).times_targeted++;
    }

    const isTeamRound = round.seasonType === 'team' || round.isTeamSeasonRound;
    const eliminations = round.eliminations || [];
    if (isTeamRound || round.isFinalePrincipale || eliminations.length === 0) continue;

    const eliminatedIds = new Set(eliminations.map(e => String(e.id)));
    const elimPositions = ranking.filter(e => eliminatedIds.has(String(e.id))).map(e => e.position);
    if (elimPositions.length === 0) continue;
    const firstElimPosition = Math.min(...elimPositions);

    for (const entry of ranking) {
      // Les rounds où le joueur est éliminé ne comptent pas
      if (eliminatedIds.has(String(entry.id))) continue;
      const g = get(entry.id);
      // Un joueur sous la barre sauvé par un bouclier compte comme marge nulle
      const margin = Math.max(0, firstElimPosition - entry.position);
      g.margin_sum += margin;
      g.elim_margin_rounds++;
      if (margin === 1) g.close_calls++;
    }
  }

  for (const g of Object.values(out)) {
    g.elim_margin_avg = g.elim_margin_rounds >= RICRAC_MIN_ROUNDS ? g.margin_sum / g.elim_margin_rounds : null;
    delete g.margin_sum;
  }
  return out;
}


export const ACHIEVEMENTS = [
  // === PALMARÈS ===
  { id: 'champion', emoji: '🥇', name: 'Champion', desc: 'Saisons remportées', type: 'legendary',
    getValue: s => s.seasons_won, format: v => `${v} saison${v > 1 ? 's' : ''}` },
  { id: 'points_king', emoji: '🏆', name: 'Roi des Points', desc: 'Plus de points au challenge principal', type: 'legendary',
    getValue: s => s.main_points, format: v => `${v} pts` },
  { id: 'elim_prince', emoji: '👻', name: 'Prince des Éliminés', desc: 'Plus de points au challenge éliminés', type: 'legendary',
    getValue: s => s.eliminated_points, format: v => `${v} pts` },
  { id: 'finalist', emoji: '🏁', name: 'Habitué des Finales', desc: 'Finales disputées', type: 'normal',
    getValue: s => s.finals_played, format: v => `${v} finale${v > 1 ? 's' : ''}` },

  // === DÉNIVELÉ ET RECORDS ===
  { id: 'king', activity: true, emoji: '👑', name: 'Roi du D+', desc: 'Le plus de dénivelé total', type: 'legendary',
    getValue: s => s.total_elevation, format: v => `${formatElevationCompact(v)} m` },
  { id: 'biggestAct', activity: true, emoji: '⛰️', name: 'Sortie Légende', desc: 'La plus grosse sortie unique', type: 'legendary',
    getValue: s => s.best_elevation, format: v => `${formatElevationCompact(v)} m` },
  { id: 'best24h', activity: true, emoji: '🔥', name: 'Journée de Feu', desc: 'Le plus gros D+ en 24h', type: 'legendary',
    getValue: s => s.best_24h_elevation, format: v => `${formatElevationCompact(v)} m` },
  { id: 'bestRound', activity: true, emoji: '⚡', name: 'Round de Folie', desc: 'Le plus gros D+ sur un round (5j)', type: 'legendary',
    getValue: s => s.best_round_elevation, format: v => `${formatElevationCompact(v)} m` },

  // === SURVIE ET JEU (rounds figés) ===
  { id: 'untouchable', emoji: '🧘', name: 'Intouchable', desc: 'La plus grande marge moyenne sur la zone d’élimination', type: 'normal',
    getValue: s => s.elim_margin_avg ?? 0,
    format: v => `${v.toFixed(2)} pl.`,
    formatWinner: s => `${s.elim_margin_avg.toFixed(2)} pl. (${s.elim_margin_rounds} rounds)` },
  { id: 'ricrac', emoji: '🦎', name: 'RicRac', desc: 'Survit au plus près de l’élimination (places au-dessus de la zone, en moyenne sur les rounds survécus)', type: 'fun',
    lowerIsBetter: true,
    getValue: s => s.elim_margin_avg,
    format: v => `${v.toFixed(2)} pl.`,
    formatWinner: s => `${s.elim_margin_avg.toFixed(2)} pl. (${s.elim_margin_rounds} rounds)` },
  { id: 'jokers', emoji: '🃏', name: 'Joker Addict', desc: 'Le plus de jokers utilisés', type: 'fun',
    getValue: s => s.jokers_used, format: v => `${v} joker${v > 1 ? 's' : ''}` },
  { id: 'target', emoji: '🎯', name: 'Cible n°1', desc: 'Le plus ciblé par les jokers et bonus', type: 'fun',
    getValue: s => s.times_targeted, format: v => `${v} fois` },

  // === STYLE ===
  { id: 'efficient', activity: true, emoji: '⚡', name: 'Efficace', desc: 'Le plus de D+ par sortie', type: 'normal',
    getValue: s => parseFloat(s.elevation_per_activity), format: v => `${formatElevationCompact(v)} m/sortie` },
  { id: 'lost', activity: true, emoji: '🤷', name: 'A pas compris', desc: 'Plus de sorties pour peu de D+ (moins de D+ par sortie)', type: 'fun',
    // Critère inversé : on prend le plus haut "déficit" en m/sortie.
    // getValue retourne (1000 - elevation_per_activity) pour qu'un faible m/sortie
    // donne une valeur élevée (= "champion" du concept).
    // On ne montre que ceux avec >= 10 activités pour éviter de pénaliser les peu actifs.
    getValue: s => s.activity_count >= 10 ? Math.max(0, 1000 - parseFloat(s.elevation_per_activity)) : 0,
    format: (_v, s) => `${s ? s.elevation_per_activity : 0} m/sortie`,
    formatWinner: s => `${s.elevation_per_activity} m/sortie (${s.activity_count} act.)` },
  { id: 'steep', activity: true, emoji: '🧗', name: 'Accro à la Pente', desc: 'Le plus de D+ par km', type: 'normal',
    getValue: s => parseFloat(s.elevation_per_distance), format: v => `${v} m/km` },
  { id: 'flat', activity: true, emoji: '🪜', name: 'Plat Pays', desc: 'Activités à moins de 100 m de D+', type: 'fun',
    getValue: s => s.activities_low_elevation, format: v => `${v} activités` },
  { id: 'worker', emoji: '💪', name: 'Le Travailleur', desc: 'Le plus de D+ pour 1 point', type: 'normal',
    getValue: s => s.total_points > 0 ? s.elevation_per_point : 0,
    format: v => `${formatElevationCompact(v)} m/pt` },

  // === VOLUMES ===
  { id: 'distance', activity: true, emoji: '🛣️', name: 'Forrest Gump', desc: 'La plus grande distance', type: 'normal',
    getValue: s => s.total_distance, format: v => `${(v/1000).toFixed(0)} km` },
  { id: 'marathoner', activity: true, emoji: '⏱️', name: 'Marathonien', desc: 'Plus longue activité', type: 'normal',
    getValue: s => s.longest_activity_time, format: v => `${(v/3600).toFixed(1)} h` },

  // === HABITUDES ===
  { id: 'earlybird', activity: true, emoji: '🐓', name: 'Lève-tôt', desc: 'Activités 4h-7h', type: 'normal',
    getValue: s => s.morning_activities, format: v => `${v} sorties` },
  { id: 'nightowl', activity: true, emoji: '🦉', name: 'Oiseau de Nuit', desc: 'Activités après 20h', type: 'fun',
    getValue: s => s.night_activities, format: v => `${v} sorties` },
  { id: 'weekend', activity: true, emoji: '🏖️', name: 'Weekend Warrior', desc: 'Activités le weekend', type: 'fun',
    getValue: s => s.weekend_activities, format: v => `${v} sorties` },

  // === SPORTS (ordre des sports du site) ===
  { id: 'runner', activity: true, emoji: '🏃', name: 'Crapahute', desc: 'Le plus de D+ en trail/run', type: 'normal',
    getValue: s => s.elevation_by_sport['Run'] || 0, format: v => `${formatElevationCompact(v)} m` },
  { id: 'cyclist', activity: true, emoji: '🚴', name: 'Roi de la Pédale', desc: 'Le plus de D+ à vélo', type: 'normal',
    getValue: s => s.elevation_by_sport['Bike'] || 0, format: v => `${formatElevationCompact(v)} m` },
  { id: 'hiker', activity: true, emoji: '🥾', name: 'Randonneur', desc: 'Le plus de D+ en rando', type: 'normal',
    getValue: s => s.elevation_by_sport['Hike'] || 0, format: v => `${formatElevationCompact(v)} m` },
  { id: 'skier', activity: true, emoji: '⛷️', name: 'Collant Pipette', desc: 'Le plus de D+ en ski', type: 'normal',
    getValue: s => s.elevation_by_sport['Ski'] || 0, format: v => `${formatElevationCompact(v)} m` }
];

/** Classe les athlètes pour un badge. lowerIsBetter : la plus petite valeur
 *  gagne (0 compris), les valeurs null (non classé) sont écartées. */
export function rankAchievement(ach, stats) {
  if (ach.lowerIsBetter) {
    return stats.filter(s => ach.getValue(s) != null).sort((a, b) => ach.getValue(a) - ach.getValue(b));
  }
  return stats.filter(s => ach.getValue(s) > 0).sort((a, b) => ach.getValue(b) - ach.getValue(a));
}

export function achievementValueText(ach, s) {
  return ach.formatWinner ? ach.formatWinner(s) : ach.format(ach.getValue(s), s);
}

/**
 * Achievements (reposant sur les activités) dont le leader a changé à cause
 * d'une sortie des dernières 24 h : leader avec toutes les sorties contre
 * leader sans les sorties de la fenêtre. Le nouveau leader doit avoir une
 * sortie dans la fenêtre. Rend [{ ach, athleteId, previousId }].
 */
export function achievementLeaderChanges(acts, now = new Date(), windowMs = 24 * 3600 * 1000) {
  const cut = new Date(now.getTime() - windowMs);
  const upToNow = acts.filter(a => new Date(a.start_date) <= now);
  const recentBy = new Set(upToNow.filter(a => new Date(a.start_date) >= cut).map(a => String(a.athlete_id)));
  if (!recentBy.size) return [];
  const statsNow = computeAthleteStats(upToNow);
  const statsBefore = computeAthleteStats(upToNow.filter(a => new Date(a.start_date) < cut));
  const out = [];
  for (const ach of ACHIEVEMENTS) {
    if (!ach.activity) continue;
    const lead = rankAchievement(ach, statsNow)[0];
    if (!lead || !recentBy.has(String(lead.athlete_id))) continue;
    const prev = rankAchievement(ach, statsBefore)[0];
    if (prev && String(prev.athlete_id) === String(lead.athlete_id)) continue;
    out.push({ ach, athleteId: String(lead.athlete_id), previousId: prev ? String(prev.athlete_id) : null });
  }
  return out;
}

/** Achievements où l'athlète est dans le top 3 : [{ ach, rank, text, leaderId }]. */
export function athletePodiums(stats, athleteId) {
  const out = [];
  for (const ach of ACHIEVEMENTS) {
    const sorted = rankAchievement(ach, stats);
    const i = sorted.slice(0, 3).findIndex(s => String(s.athlete_id) === String(athleteId));
    if (i < 0) continue;
    out.push({ ach, rank: i + 1, text: achievementValueText(ach, sorted[i]), leaderId: String(sorted[0].athlete_id) });
  }
  return out.sort((x, y) => x.rank - y.rank);
}

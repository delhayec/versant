/**
 * ============================================
 * VERSANT - PAGE STATS (GEEKS)
 * ============================================
 * Data-viz complète du challenge, adaptée depuis Récap du Million.
 *
 * Architecture:
 *   - Chargement des activités via /api/activities/versant-2026 avec cache sessionStorage
 *   - Filtrage temporel strict : activités >= yearStartDate (2026-02-02)
 *   - Détection à la volée des sorties de groupe (match horaire + GPS polyline)
 *   - 9 visualisations (ECharts, Leaflet, D3)
 *
 * Performance: tous les libs lourdes (ECharts/Leaflet/D3) sont chargés
 * uniquement sur cette page, JAMAIS dans index.html.
 */

import {
  CHALLENGE_CONFIG,
  PARTICIPANTS,
  SPORT_SETTINGS,
  isValidSport,
  getRoundDates,
  getRoundDuration,
  getDayInRound,
  getGlobalRoundNumber,
  getRoundsForSeason,
  getSeasonNumber,
  getSeasonStartRound,
  setFrozenCache,
  loadParticipants,
  getAthleteColor as configAthleteColor
} from './config.js';

// Moteur de calcul du classement (fidèle à app.js)
import {
  computeFinalStandings,
  computeStandingsAtEndOfSeason,
  calculatePointsForSeason
} from './standings-engine.js';

// DA « Atelier » : graphiques dessinés à la main (présentation seule)
import { isDA, cssVar } from './da-sketch.js?v=20261116a';
import { picto, medal as medalPicto } from './pictos.js?v=20261119a';
import {
  ACHIEVEMENTS, rankAchievement, computeAthleteStats, formatElevationCompact, mapSportName
} from './achievements.js?v=20261115a';
import {
  SPORT_STYLE, styleSocialDA, drawSportBand, drawRankingBars, drawCalendarDots,
  drawCompare, drawPoints, drawMoneyTime, drawRidgeline
} from './stats-da.js?v=20261119g';

// ============================================
// CONSTANTES & HELPERS
// ============================================

const CHALLENGE_START = new Date(CHALLENGE_CONFIG.yearStartDate);
const CHALLENGE_YEAR = CHALLENGE_CONFIG.dataYear;

// Une entrée par édition (L50) : l'onglet peut passer d'une édition à l'autre
const CACHE_KEY = `versant_stats_activities_v2_${CHALLENGE_CONFIG.leagueId}`;
const CACHE_DATE_KEY = `versant_stats_activities_date_v2_${CHALLENGE_CONFIG.leagueId}`;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Comparaison avec les activités de versant en 2025 (section 10) : sans objet
// pour une autre ligue, la section est masquée (L52)
const HAS_2025_COMPARISON = CHALLENGE_CONFIG.leagueId === 'versant-2026';
if (!HAS_2025_COMPARISON) {
  const hideComparison = () => {
    const section = document.getElementById('compareSection');
    if (section) section.style.display = 'none';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideComparison);
  else hideComparison();
}

// Sports exclus (jamais affichés même si l'API les renvoie)
const EXCLUDED_SPORTS = new Set(SPORT_SETTINGS.excludedSports);

// Mapping vers catégorie "sport" pour le Sankey/Pie/etc.
const SPORT_CATEGORY = SPORT_SETTINGS.validSports;
const SPORT_COLORS = SPORT_SETTINGS.sportColors;


function getSportColor(sportOrCategory) {
  // Si on nous passe un type brut (TrailRun, BackcountrySki...), on mappe
  const cat = SPORT_COLORS[sportOrCategory] ? sportOrCategory : SPORT_CATEGORY[sportOrCategory];
  // DA : couleurs de la palette (tokens.css), lues au moment du rendu
  if (isDA()) return cssVar('--sport-' + String(cat).toLowerCase()) || cssVar('--sub');
  return SPORT_COLORS[cat] || '#888888';
}

function getAthleteName(id) {
  const p = PARTICIPANTS.find(x => String(x.id) === String(id));
  return p ? p.name : `Athlète ${id}`;
}

function getAthleteColor(id) {
  // Réutilise le système de couleurs de config.js pour cohérence
  return configAthleteColor(String(id));
}


function formatDateFr(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  const day = d.getDate();
  const month = d.toLocaleDateString('fr-FR', { month: 'long' });
  const year = d.getFullYear();
  const dayStr = day === 1 ? '1er' : day.toString();
  return `${dayStr} ${month} ${year}`;
}

function getISOWeek(date) {
  // ISO-8601 week number (lundi = start)
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = d - firstThursday;
  return Math.round(diff / (7 * 24 * 3600 * 1000)) + 1;
}

function decodePolyline(encoded) {
  if (!encoded) return [];
  const decoded = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    decoded.push([lat / 1e5, lng / 1e5]);
  }
  return decoded;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================
// CHARGEMENT DES DONNÉES
// ============================================

let allActivities = [];

async function loadActivities() {
  const loadingText = document.getElementById('loadingText');
  const setStatus = msg => { if (loadingText) loadingText.textContent = msg; };

  // 1. Cache sessionStorage
  try {
    const cachedDate = sessionStorage.getItem(CACHE_DATE_KEY);
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached && cachedDate) {
      const age = Date.now() - parseInt(cachedDate, 10);
      if (age < CACHE_TTL_MS) {
        const data = JSON.parse(cached);
        console.log(`Activités depuis cache (${data.length}, ${Math.round(age / 1000)}s)`);
        return data;
      }
    }
  } catch (e) {
    console.warn('Cache illisible, rechargement', e);
  }

  // 2. API backend
  setStatus('Chargement des activités…');
  const leagueId = CHALLENGE_CONFIG.leagueId;
  const url = `/api/activities/${leagueId}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error ${response.status}`);
  const raw = await response.json();
  if (!Array.isArray(raw)) throw new Error('Format de réponse API invalide');
  console.log(`${raw.length} activités brutes reçues de l'API`);

  // 3. Sauvegarde cache
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(raw));
    sessionStorage.setItem(CACHE_DATE_KEY, Date.now().toString());
  } catch (e) {
    console.warn('sessionStorage plein, on continue sans cache');
  }

  return raw;
}

/**
 * Normalise une activité brute API Strava vers format utilisé par les charts.
 * - athlete_id à plat
 * - start_date filtrable par date
 * - sport_type conservé
 * - map.summary_polyline conservé
 */
function normalizeActivity(a) {
  return {
    activity_id: a.id,
    id: a.id,
    athlete_id: a.athlete_id || a.athlete?.id,
    athlete_name: a.athlete_name || a.athlete_full_name || null,
    name: a.name,
    sport_type: a.sport_type,
    type: a.type,
    start_date: a.start_date,
    start_date_local: a.start_date_local,
    moving_time: a.moving_time || 0,
    elapsed_time: a.elapsed_time || 0,
    distance: a.distance || 0,
    total_elevation_gain: a.total_elevation_gain || 0,
    athlete_count: a.athlete_count || 1,
    map: a.map || null,
    start_latlng: a.start_latlng || null,
    end_latlng: a.end_latlng || null,
    max_speed: a.max_speed || 0,
    average_speed: a.average_speed || 0,
    kudos_count: a.kudos_count || 0,
    achievement_count: a.achievement_count || 0,
    timezone: a.timezone || null,
    location_country: a.location_country || null,
    location_state: a.location_state || null,
    location_city: a.location_city || null
  };
}

/**
 * Filtre et normalise les activités :
 *   - >= CHALLENGE_START (2026-02-02)
 *   - sport valide (selon SPORT_SETTINGS.validSports)
 *   - pas de doublon (dédup par id)
 */
function filterAndNormalize(rawActivities) {
  const seen = new Set();
  const out = [];
  for (const a of rawActivities) {
    if (!a) continue;
    const sport = a.sport_type;
    if (!sport) continue;
    if (EXCLUDED_SPORTS.has(sport)) continue;
    if (!isValidSport(sport)) continue;
    if (!a.start_date) continue;

    const d = new Date(a.start_date);
    if (isNaN(d.getTime())) continue;
    if (d < CHALLENGE_START) continue;

    const id = a.id;
    if (id != null && seen.has(id)) continue;
    if (id != null) seen.add(id);

    out.push(normalizeActivity(a));
  }
  return out;
}

// ============================================
// DÉTECTION DES SORTIES DE GROUPE (portage JS fidèle du Python)
// ============================================

const GROUP_DETECTION = {
  MAX_START_TIME_DIFF_MIN: 60,
  MAX_DURATION_DIFF_S: 7200,
  POLYLINE_CORRIDOR_M: 150,
  POLYLINE_MIN_SIMILARITY: 0.5,
  POLYLINE_SAMPLE_RATE: 30,
  MAX_DISTANCE_DEVIATION: 0.20,
  MAX_ELEVATION_DEVIATION: 0.20,
  STRICT_TIME_DIFF_MIN: 15,
  STRICT_DURATION_DIFF_S: 600,
  STRICT_DISTANCE_DEVIATION: 0.10,
  MIN_GROUP_SIZE: 2
};

function comparePolylines(poly1, poly2) {
  if (!poly1 || !poly2 || poly1.length < 2 || poly2.length < 2) return 0;
  const sampleRate = Math.max(
    1,
    Math.floor(Math.min(poly1.length, poly2.length) / GROUP_DETECTION.POLYLINE_SAMPLE_RATE)
  );
  const s1 = [];
  const s2 = [];
  for (let i = 0; i < poly1.length; i += sampleRate) s1.push(poly1[i]);
  for (let i = 0; i < poly2.length; i += sampleRate) s2.push(poly2[i]);
  if (s1.length === 0 || s2.length === 0) return 0;

  // Optimisation : bucketing spatial de s2 pour éviter O(N²).
  // Bucket size ≈ corridor width en degrés (1° lat ≈ 111km, donc 150m ≈ 0.00135°).
  // On prend 0.002° (~220m) pour qu'un point soit toujours dans un bucket adjacent.
  const BUCKET_DEG = 0.002;
  const CORRIDOR_M = GROUP_DETECTION.POLYLINE_CORRIDOR_M;
  const bucketsS2 = new Map();
  for (const p of s2) {
    const kLat = Math.floor(p[0] / BUCKET_DEG);
    const kLon = Math.floor(p[1] / BUCKET_DEG);
    const key = `${kLat},${kLon}`;
    if (!bucketsS2.has(key)) bucketsS2.set(key, []);
    bucketsS2.get(key).push(p);
  }

  // Early-exit : calculer le nombre min de matches nécessaires pour atteindre MIN_SIMILARITY
  const minMatchesNeeded = Math.ceil(s1.length * GROUP_DETECTION.POLYLINE_MIN_SIMILARITY);
  const earlyExitThreshold = s1.length - minMatchesNeeded; // nb max de non-matches tolérés

  let matches = 0;
  let nonMatches = 0;
  for (let idx = 0; idx < s1.length; idx++) {
    const p1 = s1[idx];
    const kLat = Math.floor(p1[0] / BUCKET_DEG);
    const kLon = Math.floor(p1[1] / BUCKET_DEG);

    // Ne tester que les 9 buckets environnants (3x3)
    let found = false;
    outer:
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const bucket = bucketsS2.get(`${kLat + dLat},${kLon + dLon}`);
        if (!bucket) continue;
        for (const p2 of bucket) {
          if (haversine(p1[0], p1[1], p2[0], p2[1]) <= CORRIDOR_M) {
            found = true;
            break outer;
          }
        }
      }
    }

    if (found) matches++;
    else {
      nonMatches++;
      // Si on a déjà accumulé trop de non-matches, la similarité finale sera sous le seuil.
      // On peut sortir tôt si l'appelant se contente de savoir si ≥ POLYLINE_MIN_SIMILARITY.
      // Pour garder un retour précis (le fallback strict utilise 0.2), on sort seulement
      // si on est vraiment sous 0.2 (seuil le plus permissif).
      const MIN_USABLE_SIM = 0.2;
      const minUsableMatches = Math.ceil(s1.length * MIN_USABLE_SIM);
      const remaining = s1.length - (idx + 1);
      if (matches + remaining < minUsableMatches) {
        return matches / s1.length; // aucun espoir, on sort
      }
    }
  }
  return matches / s1.length;
}

// Cache des polylines décodées (perf)
const polylineCache = new WeakMap();
function getDecodedPolyline(activity) {
  if (!activity.map || !activity.map.summary_polyline) return null;
  if (polylineCache.has(activity)) return polylineCache.get(activity);
  const decoded = decodePolyline(activity.map.summary_polyline);
  polylineCache.set(activity, decoded);
  return decoded;
}

function activitiesMatch(a1, a2) {
  // Même catégorie de sport
  if (mapSportName(a1.sport_type) !== mapSportName(a2.sport_type)) return false;

  const t1 = new Date(a1.start_date).getTime();
  const t2 = new Date(a2.start_date).getTime();
  const timeDiffMin = Math.abs(t1 - t2) / 60000;

  const dur1 = a1.moving_time || 0;
  const dur2 = a2.moving_time || 0;
  const durDiff = Math.abs(dur1 - dur2);

  const dist1 = a1.distance || 0;
  const dist2 = a2.distance || 0;
  const avgDist = (dist1 + dist2) / 2;
  const distDeviation = avgDist > 0 ? Math.abs(dist1 - dist2) / avgDist : 0;

  const el1 = a1.total_elevation_gain || 0;
  const el2 = a2.total_elevation_gain || 0;
  const avgEl = (el1 + el2) / 2;
  const elDeviation = avgEl > 0 ? Math.abs(el1 - el2) / avgEl : 0;

  // Critères de base rapides (sort avant de décoder les polylines)
  if (timeDiffMin > GROUP_DETECTION.MAX_START_TIME_DIFF_MIN) return false;
  if (durDiff > GROUP_DETECTION.MAX_DURATION_DIFF_S) return false;

  // Pré-filtre géographique rapide : si les points de départ sont à plus de
  // (distance moyenne parcourue + 2km marge) l'un de l'autre, ce n'est
  // certainement PAS la même sortie. Exemple : départ à Chamonix vs Grenoble
  // (200km) → la polyline ne peut pas tenir dans le corridor de 150m.
  // On ne fait ce pré-filtre que si les 2 activités ont un start_latlng valide.
  if (a1.start_latlng && a2.start_latlng &&
      a1.start_latlng.length >= 2 && a2.start_latlng.length >= 2) {
    const startDist = haversine(
      a1.start_latlng[0], a1.start_latlng[1],
      a2.start_latlng[0], a2.start_latlng[1]
    );
    // Distance "raisonnable" entre 2 points de départ d'une même sortie :
    // max(2km, distance moyenne parcourue). Au-delà, pas la même sortie.
    // On utilise dist/2 car on pourrait démarrer aux 2 extrémités d'une boucle.
    const maxStartDistM = Math.max(2000, avgDist / 2 + 2000);
    if (startDist > maxStartDistM) return false;
  }

  // Comparaison polylines si dispo (coûteux, on y arrive seulement après les pré-filtres)
  const p1 = getDecodedPolyline(a1);
  const p2 = getDecodedPolyline(a2);

  if (p1 && p2 && p1.length > 1 && p2.length > 1) {
    const sim = comparePolylines(p1, p2);
    if (sim >= GROUP_DETECTION.POLYLINE_MIN_SIMILARITY) return true;
    // Fallback strict si similarité partielle
    if (sim >= 0.2) {
      return (
        timeDiffMin <= GROUP_DETECTION.STRICT_TIME_DIFF_MIN &&
        durDiff <= GROUP_DETECTION.STRICT_DURATION_DIFF_S &&
        distDeviation <= GROUP_DETECTION.STRICT_DISTANCE_DEVIATION
      );
    }
    return false;
  } else {
    // Sans polyline, on se rabat sur distance + D+
    if (avgDist > 0 && distDeviation > GROUP_DETECTION.MAX_DISTANCE_DEVIATION) return false;
    if (avgEl > 0 && elDeviation > GROUP_DETECTION.MAX_ELEVATION_DEVIATION) return false;
  }
  return true;
}

/**
 * Détecte les sorties de groupe. O(N²) par jour, tourne en ~300-1000ms
 * pour plusieurs centaines d'activités. Appelé via requestIdleCallback.
 */
function detectGroupActivities(activities) {
  // Grouper par jour pour ne comparer que les activités du même jour
  const byDay = new Map();
  for (const a of activities) {
    const day = a.start_date.substring(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(a);
  }

  // Pré-compute: timestamps pour tous les actes (évite les re-parse)
  for (const [, dayActs] of byDay) {
    for (const a of dayActs) {
      if (a._ts === undefined) a._ts = new Date(a.start_date).getTime();
    }
    // Trier par heure de départ croissante pour permettre l'early-break
    dayActs.sort((a, b) => a._ts - b._ts);
  }

  const MAX_TIME_DIFF_MS = GROUP_DETECTION.MAX_START_TIME_DIFF_MIN * 60 * 1000;
  const groups = [];
  let totalComparisons = 0;
  let skippedByTime = 0;
  let skippedBySport = 0;

  for (const [day, dayActs] of byDay.entries()) {
    if (dayActs.length < GROUP_DETECTION.MIN_GROUP_SIZE) continue;

    // Pour chaque activité, collecter ses matches
    const matches = new Map();
    for (let i = 0; i < dayActs.length; i++) {
      const a1 = dayActs[i];
      const a1Sport = mapSportName(a1.sport_type);
      for (let j = i + 1; j < dayActs.length; j++) {
        const a2 = dayActs[j];
        // Early-break : activités triées par heure, donc si la diff dépasse la fenêtre,
        // toutes les suivantes seront encore plus éloignées
        if (a2._ts - a1._ts > MAX_TIME_DIFF_MS) {
          skippedByTime += dayActs.length - j;
          break;
        }
        if (a1.athlete_id === a2.athlete_id) continue;
        // Filtre sport rapide avant tout autre calcul
        if (a1Sport !== mapSportName(a2.sport_type)) { skippedBySport++; continue; }
        totalComparisons++;
        if (activitiesMatch(a1, a2)) {
          if (!matches.has(a1.activity_id)) matches.set(a1.activity_id, new Set());
          if (!matches.has(a2.activity_id)) matches.set(a2.activity_id, new Set());
          matches.get(a1.activity_id).add(a2.activity_id);
          matches.get(a2.activity_id).add(a1.activity_id);
        }
      }
    }

    const byId = new Map(dayActs.map(a => [a.activity_id, a]));
    const usedInGroup = new Set();

    // Trier par nb de matches décroissant pour former les plus gros groupes d'abord
    const sortedMatches = [...matches.entries()].sort((a, b) => b[1].size - a[1].size);

    for (const [aId, matchSet] of sortedMatches) {
      if (usedInGroup.has(aId)) continue;

      const groupIds = new Set([aId]);
      for (const mId of matchSet) {
        if (usedInGroup.has(mId)) continue;
        // Vérifier que mId matche avec TOUS les membres actuels du groupe
        let compatible = true;
        for (const gId of groupIds) {
          if (gId === mId) continue;
          const gMatches = matches.get(gId);
          if (!(gMatches && gMatches.has(mId))) {
            // Re-vérifier directement (double-check)
            if (!activitiesMatch(byId.get(gId), byId.get(mId))) {
              compatible = false;
              break;
            }
          }
        }
        if (compatible) groupIds.add(mId);
      }

      if (groupIds.size < GROUP_DETECTION.MIN_GROUP_SIZE) continue;

      const members = [...groupIds].map(id => byId.get(id));
      const n = members.length;
      groups.push({
        id: `grp_${day}_${groups.length}`,
        date: day,
        athletes: members.map(m => m.athlete_id),
        activity_ids: [...groupIds],
        sport_type: members[0].sport_type,
        sport_category: mapSportName(members[0].sport_type),
        name: members[0].name || 'Sortie en groupe',
        elevation: Math.round(members.reduce((s, m) => s + (m.total_elevation_gain || 0), 0) / n),
        distance: Math.round(members.reduce((s, m) => s + (m.distance || 0), 0) / n),
        duration: Math.round(members.reduce((s, m) => s + (m.moving_time || 0), 0) / n),
        athlete_count: n
      });
      for (const gid of groupIds) usedInGroup.add(gid);
    }
  }

  // Log de perf (debug)
  console.log(
    `Détection groupes: ${totalComparisons} comparaisons effectives, ` +
    `${skippedByTime} skip-temps, ${skippedBySport} skip-sport`
  );

  return groups;
}

// ============================================
// FILTRAGE (athlète + sport)
// ============================================

function getFilteredData() {
  const athleteId = document.getElementById('athleteSelect').value;
  const sport = document.getElementById('sportSelect').value;
  let data = allActivities;
  if (sport) data = data.filter(a => a.sport_type === sport);
  if (athleteId) data = data.filter(a => String(a.athlete_id) === String(athleteId));
  return data;
}

// ============================================
// VUE D'ENSEMBLE : Stats cards
// ============================================

function updateOverviewStats(data) {
  const totalEl = data.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
  const totalAct = data.length;
  const totalDist = data.reduce((s, a) => s + (a.distance || 0), 0) / 1000;
  const totalTime = data.reduce((s, a) => s + (a.moving_time || 0), 0) / 3600;

  document.getElementById('totalElevation').textContent = Math.round(totalEl).toLocaleString('fr-FR');
  document.getElementById('totalActivities').textContent = totalAct.toLocaleString('fr-FR');
  document.getElementById('totalDistance').textContent = Math.round(totalDist).toLocaleString('fr-FR');
  document.getElementById('totalTime').textContent = Math.round(totalTime).toLocaleString('fr-FR');

  const bd = findBestDay(data);
  document.getElementById('bestDay').textContent = bd
    ? `${bd.dateLabel}\n(${bd.elevation.toLocaleString('fr-FR')} m)`
    : '-';

  const bw = findBestWeek(data);
  document.getElementById('bestWeek').textContent = bw
    ? `${bw.period}\n(${bw.elevation.toLocaleString('fr-FR')} m)`
    : '-';
}

function findBestDay(data) {
  if (!data.length) return null;
  const daily = new Map();
  for (const a of data) {
    const d = a.start_date.substring(0, 10);
    daily.set(d, (daily.get(d) || 0) + (a.total_elevation_gain || 0));
  }
  let bestDate = null, bestEl = 0;
  for (const [d, el] of daily) if (el > bestEl) { bestEl = el; bestDate = d; }
  if (!bestDate) return null;
  return { dateLabel: formatDateFr(bestDate), elevation: Math.round(bestEl) };
}

function findBestWeek(data) {
  if (!data.length) return null;
  const weekly = new Map();
  const weeklyDates = new Map();
  for (const a of data) {
    const d = new Date(a.start_date);
    const week = getISOWeek(d);
    const year = d.getFullYear();
    const key = `${year}-${week}`;
    weekly.set(key, (weekly.get(key) || 0) + (a.total_elevation_gain || 0));
    if (!weeklyDates.has(key)) weeklyDates.set(key, { min: d, max: d });
    else {
      const r = weeklyDates.get(key);
      if (d < r.min) r.min = d;
      if (d > r.max) r.max = d;
    }
  }
  let bestKey = null, bestEl = 0;
  for (const [k, v] of weekly) if (v > bestEl) { bestEl = v; bestKey = k; }
  if (!bestKey) return null;
  const r = weeklyDates.get(bestKey);
  return {
    period: `${formatDateShort(r.min)} - ${formatDateShort(r.max)}`,
    elevation: Math.round(bestEl)
  };
}

function formatDateShort(d) {
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// ============================================
// SPORT PIE CHART
// ============================================

let sportPieChart = null;
function renderSportPieChart(data) {
  const dom = document.getElementById('sportPieChart');
  if (!dom) return;
  if (sportPieChart) { sportPieChart.dispose(); sportPieChart = null; }

  const bySport = {};
  for (const a of data) {
    const s = mapSportName(a.sport_type);
    bySport[s] = (bySport[s] || 0) + (a.total_elevation_gain || 0);
  }

  const pieData = Object.entries(bySport)
    .map(([name, value]) => ({ name, value, itemStyle: { color: getSportColor(name) } }))
    .sort((a, b) => b.value - a.value);

  if (isDA()) { drawSportBand(dom, pieData.map(p => ({ name: p.name, value: p.value }))); return; }
  sportPieChart = echarts.init(dom);
  sportPieChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(10,10,15,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif", fontSize: 12 },
      formatter: p => `${p.name}<br/>↑ ${formatElevationCompact(p.value)} m (${p.percent.toFixed(1)}%)`
    },
    series: [{
      type: 'pie',
      radius: ['45%', '75%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 6, borderColor: '#1a1a24', borderWidth: 2 },
      label: {
        show: true, position: 'outside',
        formatter: '{b}',
        color: 'rgba(255,255,255,0.7)',
        fontSize: 10,
        fontFamily: "'Inter',sans-serif"
      },
      labelLine: { show: true, length: 8, length2: 8, lineStyle: { color: 'rgba(255,255,255,0.3)' } },
      emphasis: {
        itemStyle: { shadowBlur: 20, shadowColor: 'rgba(249,115,22,0.5)' },
        label: { fontWeight: 'bold' }
      },
      data: pieData,
      animationType: 'expansion',
      animationDuration: 1200
    }]
  });
}

// ============================================
// MINI RANKING SLIDER
// ============================================

function renderMiniRanking(data) {
  const slider = document.getElementById('miniRankingSlider');
  const dotsContainer = document.getElementById('rankingDots');
  const prevBtn = document.getElementById('rankingPrev');
  const nextBtn = document.getElementById('rankingNext');
  if (!slider) return;

  const byAthlete = new Map();
  for (const a of data) {
    const id = a.athlete_id;
    byAthlete.set(id, (byAthlete.get(id) || 0) + (a.total_elevation_gain || 0));
  }
  const stats = [...byAthlete.entries()]
    .map(([id, el]) => ({ id, total_elevation: el }))
    .sort((a, b) => b.total_elevation - a.total_elevation);

  if (isDA()) { drawRankingBars(slider, stats, getAthleteName); return; }

  const maxEl = stats[0]?.total_elevation || 1;

  slider.innerHTML = stats.map((s, i) => {
    const pct = (s.total_elevation / maxEl) * 100;
    const posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    return `
      <div class="mini-rank-item">
        <div class="mini-rank-position ${posClass}">${i + 1}</div>
        <div class="mini-rank-info">
          <div class="mini-rank-name" style="color:${getAthleteColor(s.id)}">${getAthleteName(s.id)}</div>
          <div class="mini-rank-value">${formatElevationCompact(s.total_elevation)} m</div>
        </div>
        <div class="mini-rank-bar">
          <div class="mini-rank-bar-fill" style="width:${pct}%;background:${getAthleteColor(s.id)}"></div>
        </div>
      </div>`;
  }).join('');

  const totalPages = Math.min(4, Math.max(1, stats.length));
  let currentPage = 0;

  if (dotsContainer) {
    dotsContainer.innerHTML = Array.from({ length: totalPages }, (_, i) =>
      `<div class="ranking-dot ${i === 0 ? 'active' : ''}" data-page="${i}"></div>`
    ).join('');
    dotsContainer.querySelectorAll('.ranking-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        currentPage = parseInt(dot.dataset.page);
        updateSlider();
      });
    });
  }

  function updateSlider() {
    const maxScroll = slider.scrollWidth - slider.clientWidth;
    const pos = totalPages > 1 ? (currentPage / (totalPages - 1)) * maxScroll : 0;
    slider.scrollTo({ left: pos, behavior: 'smooth' });
    if (dotsContainer) {
      dotsContainer.querySelectorAll('.ranking-dot').forEach((d, i) =>
        d.classList.toggle('active', i === currentPage));
    }
  }

  if (prevBtn) prevBtn.onclick = () => { currentPage = Math.max(0, currentPage - 1); updateSlider(); };
  if (nextBtn) nextBtn.onclick = () => { currentPage = Math.min(totalPages - 1, currentPage + 1); updateSlider(); };
}

// ============================================
// CARTE (Leaflet)
// ============================================

let map = null;
let polylineLayers = [];

function initMap() {
  if (map) { map.invalidateSize(); return; }
  map = L.map('map', { center: [46.5, 2.5], zoom: 5 });
  // Fond sombre Esri : utilisable sans clé API (les fonds CARTO en exigent
  // désormais une et affichaient « API KEY REQUIRED »).
  // DA : fond gris clair, blanchi ou passé au bleu de cyanotype en CSS (css/da/stats.css)
  const base = isDA() ? 'World_Light_Gray_Base' : 'World_Dark_Gray_Base';
  L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${base}/MapServer/tile/{z}/{y}/{x}`, {
    attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    maxZoom: 16
  }).addTo(map);
  setTimeout(() => map.invalidateSize(), 200);
}

// Coupe les longues lignes droites (trajets GPS sautés, téléportations) pour
// ne pas tracer de traits parasites à travers la carte.
// Longueurs cumulées en préfixe : chaque test de rectitude est en O(1) au lieu
// de re-sommer le chemin (le calcul bloquait plusieurs secondes sur la saison).
function filterStraightLines(points, minStraightDist) {
  if (!points || points.length < 3) return points ? [points] : [];
  const cumul = new Float64Array(points.length);
  for (let k = 1; k < points.length; k++) {
    cumul[k] = cumul[k - 1] + haversine(points[k - 1][0], points[k - 1][1], points[k][0], points[k][1]);
  }
  const isStraight = (a, b) => {
    const path = cumul[b] - cumul[a];
    return path > 0 && haversine(points[a][0], points[a][1], points[b][0], points[b][1]) / path > 0.99;
  };

  const segments = [];
  let current = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    let straightEnd = -1;
    for (let j = i + 2; j < Math.min(i + 50, points.length); j++) {
      // Le chemin est toujours ≥ la distance directe : inutile de tester
      // la rectitude tant qu'il ne dépasse pas le seuil.
      if (cumul[j] - cumul[i] <= minStraightDist) continue;
      const d = haversine(points[i][0], points[i][1], points[j][0], points[j][1]);
      if (d > minStraightDist && isStraight(i, j)) straightEnd = j;
    }
    if (straightEnd > 0) {
      current.push(points[i]);
      if (current.length > 1) segments.push(current);
      current = [points[straightEnd]];
      i = straightEnd;
    } else {
      current.push(points[i]);
    }
  }
  current.push(points[points.length - 1]);
  if (current.length > 1) segments.push(current);
  return segments.length > 0 ? segments : [points];
}

function renderMap(data, athleteSelected) {
  if (!map) initMap();
  setTimeout(() => map && map.invalidateSize(), 100);

  polylineLayers.forEach(p => map.removeLayer(p));
  polylineLayers = [];

  const colorMode = athleteSelected ? 'sport' : 'athlete';
  renderMapLegend(data, colorMode);

  for (const act of data) {
    if (!act.map || !act.map.summary_polyline) continue;
    const pts = decodePolyline(act.map.summary_polyline);
    if (pts.length === 0) continue;

    const color = athleteSelected
      ? getSportColor(mapSportName(act.sport_type))
      : getAthleteColor(act.athlete_id);

    const segments = filterStraightLines(pts, 20000);
    for (const seg of segments) {
      if (seg.length < 2) continue;
      const pl = L.polyline(seg, { color, weight: 2.5, opacity: 0.8 }).addTo(map);
      const date = new Date(act.start_date).toLocaleDateString('fr-FR');
      pl.bindPopup(`
        <strong>${act.name || 'Activité'}</strong><br>
        ${date} · ${mapSportName(act.sport_type)}<br>
        ↑ ${formatElevationCompact(act.total_elevation_gain)} m D+
      `);
      polylineLayers.push(pl);
    }
  }

  if (polylineLayers.length > 0) {
    const group = L.featureGroup(polylineLayers);
    map.fitBounds(group.getBounds(), { padding: [30, 30], maxZoom: 6 });
    setTimeout(() => map.invalidateSize(), 300);
  }
}

function renderMapLegend(activities, colorMode) {
  const legendContainer = document.getElementById('legendContainer');
  const countryContainer = document.getElementById('countryStatsContainer');
  if (!legendContainer || !countryContainer) return;

  // Compter les activités avec/sans trace GPS
  const totalActs = activities.length;
  const withPolyline = activities.filter(a => a.map && a.map.summary_polyline).length;
  const withoutPolyline = totalActs - withPolyline;

  const gpsCounterHTML = withoutPolyline > 0
    ? `<div class="gps-counter">
         <span class="gps-counter-main">${withPolyline} traces GPS</span>
         <span class="gps-counter-sub">sur ${totalActs} activités</span>
         <div class="gps-counter-info">Les ${withoutPolyline} activité${withoutPolyline > 1 ? 's' : ''} manuelle${withoutPolyline > 1 ? 's' : ''} (sans GPS) ne ${withoutPolyline > 1 ? 'sont' : 'est'} pas visible${withoutPolyline > 1 ? 's' : ''} sur la carte.</div>
       </div>`
    : '';

  legendContainer.innerHTML = '<h3>Légende</h3>' + gpsCounterHTML;

  if (colorMode === 'sport') {
    const sports = new Set();
    const countBySport = new Map();
    for (const a of activities) {
      const s = mapSportName(a.sport_type);
      sports.add(s);
      countBySport.set(s, (countBySport.get(s) || 0) + 1);
    }
    for (const s of sports) {
      const count = countBySport.get(s);
      legendContainer.insertAdjacentHTML('beforeend', `
        <div class="legend-item">
          <div class="legend-color" style="background:${getSportColor(s)}"></div>
          <div class="legend-text">${s} (${count})</div>
        </div>`);
    }
  } else {
    const athletes = new Map();
    for (const a of activities) {
      athletes.set(a.athlete_id, (athletes.get(a.athlete_id) || 0) + 1);
    }
    const sorted = [...athletes.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id, count] of sorted) {
      legendContainer.insertAdjacentHTML('beforeend', `
        <div class="legend-item">
          <div class="legend-color" style="background:${getAthleteColor(id)}"></div>
          <div class="legend-text">${getAthleteName(id)} (${count})</div>
        </div>`);
    }
  }

  // Panneau "Top zones" : regroupement par pays/région
  // On utilise le champ timezone quand disponible (format "(GMT+01:00) Europe/Paris")
  // et on fallback sur une détection approximative par coordonnées GPS.
  const TZ_TO_COUNTRY = {
    'Europe/Paris': '🇫🇷 France',
    'Europe/London': '🇬🇧 Royaume-Uni',
    'Europe/Madrid': '🇪🇸 Espagne',
    'Europe/Rome': '🇮🇹 Italie',
    'Europe/Berlin': '🇩🇪 Allemagne',
    'Europe/Zurich': '🇨🇭 Suisse',
    'Europe/Vienna': '🇦🇹 Autriche',
    'Europe/Amsterdam': '🇳🇱 Pays-Bas',
    'Europe/Brussels': '🇧🇪 Belgique',
    'Europe/Oslo': '🇳🇴 Norvège',
    'Europe/Stockholm': '🇸🇪 Suède',
    'Europe/Lisbon': '🇵🇹 Portugal',
    'Africa/Algiers': '🇩🇿 Algérie',
    'Africa/Casablanca': '🇲🇦 Maroc',
    'America/New_York': '🇺🇸 USA (Est)',
    'America/Denver': '🇺🇸 USA (Ouest)',
    'America/Los_Angeles': '🇺🇸 USA (Ouest)',
  };

  // Fallback : devine le pays par coordonnées (boîtes grossières)
  const guessCountryFromCoords = (lat, lon) => {
    if (lat >= 42 && lat <= 51.5 && lon >= -5 && lon <= 8.5) return '🇫🇷 France';
    if (lat >= 36 && lat <= 44 && lon >= -9.5 && lon <= 3.5) return '🇪🇸 Espagne';
    if (lat >= 36 && lat <= 47.5 && lon >= 6.5 && lon <= 18.5) return '🇮🇹 Italie';
    if (lat >= 45.5 && lat <= 47.9 && lon >= 5.5 && lon <= 10.6) return '🇨🇭 Suisse';
    if (lat >= 49 && lat <= 55 && lon >= 5.5 && lon <= 15) return '🇩🇪 Allemagne';
    if (lat >= 49 && lat <= 58 && lon >= -8 && lon <= 2) return '🇬🇧 Royaume-Uni';
    if (lat >= 58 && lat <= 71.5 && lon >= 4 && lon <= 31) return '🇳🇴 Norvège';
    if (lat >= 35 && lat <= 42 && lon >= -6 && lon <= 10) return '🇲🇦 Maghreb';
    return null;
  };

  const countryBuckets = new Map();
  let unknownLocationCount = 0;

  for (const a of activities) {
    // Extraire la timezone en enlevant "(GMT±HH:MM) " s'il est présent
    let country = null;
    if (a.timezone) {
      const match = a.timezone.match(/(?:\([^)]+\)\s*)?(.+)$/);
      const tz = match ? match[1].trim() : a.timezone.trim();
      country = TZ_TO_COUNTRY[tz] || null;
    }

    // Fallback: deviner par coordonnées
    if (!country && a.start_latlng && a.start_latlng.length >= 2) {
      country = guessCountryFromCoords(a.start_latlng[0], a.start_latlng[1]);
    }

    if (!country) {
      unknownLocationCount++;
      continue;
    }

    if (!countryBuckets.has(country)) {
      countryBuckets.set(country, { count: 0, elevation: 0, distance: 0, athletes: new Set() });
    }
    const r = countryBuckets.get(country);
    r.count++;
    r.elevation += a.total_elevation_gain || 0;
    r.distance += a.distance || 0;
    r.athletes.add(a.athlete_id);
  }

  const topCountries = [...countryBuckets.entries()]
    .sort((a, b) => b[1].elevation - a[1].elevation);

  countryContainer.innerHTML = '<h3>Zones actives</h3>';
  topCountries.forEach(([country, r], i) => {
    countryContainer.insertAdjacentHTML('beforeend', `
      <div class="country-item">
        <div class="country-name">
          <span class="country-badge">${i + 1}</span>
          ${country}
        </div>
        <div class="country-stats-line">↑ ${formatElevationCompact(r.elevation)} m D+</div>
        <div class="country-stats-line">◉ ${r.count} activités</div>
        <div class="country-stats-line">${r.athletes.size} athlète${r.athletes.size > 1 ? 's' : ''}</div>
      </div>`);
  });

  if (unknownLocationCount > 0) {
    countryContainer.insertAdjacentHTML('beforeend', `
      <div class="country-summary">
        ${countryBuckets.size} pays identifié${countryBuckets.size > 1 ? 's' : ''}
        · ${unknownLocationCount} activité${unknownLocationCount > 1 ? 's' : ''} sans localisation
      </div>`);
  } else {
    countryContainer.insertAdjacentHTML('beforeend', `
      <div class="country-summary">${countryBuckets.size} pays identifié${countryBuckets.size > 1 ? 's' : ''}</div>`);
  }
}

// ============================================
// SANKEY
// ============================================

let sankeyChart = null;
function renderSankey(data) {
  const dom = document.getElementById('sankeyChart');
  if (!dom) return;
  if (sankeyChart) sankeyChart.dispose();
  sankeyChart = echarts.init(dom);

  const athletes = [...new Set(data.map(a => a.athlete_id))];
  const sports = [...new Set(data.map(a => mapSportName(a.sport_type)))];

  const totalGlobal = data.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);

  const athleteTotals = {};
  athletes.forEach(id => {
    athleteTotals[id] = data
      .filter(a => a.athlete_id === id)
      .reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
  });

  const sportTotals = {};
  sports.forEach(s => {
    sportTotals[s] = data
      .filter(a => mapSportName(a.sport_type) === s)
      .reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
  });

  const nodes = [];
  const nodeSet = new Set();

  athletes.forEach(id => {
    const name = getAthleteName(id);
    if (!nodeSet.has(name)) {
      nodes.push({
        name,
        itemStyle: { color: getAthleteColor(id) },
        total: athleteTotals[id],
        percentage: totalGlobal > 0 ? ((athleteTotals[id] / totalGlobal) * 100).toFixed(1) : '0'
      });
      nodeSet.add(name);
    }
  });

  sports.forEach(s => {
    if (!nodeSet.has(s)) {
      nodes.push({
        name: s,
        itemStyle: { color: getSportColor(s) },
        total: sportTotals[s],
        percentage: totalGlobal > 0 ? ((sportTotals[s] / totalGlobal) * 100).toFixed(1) : '0'
      });
      nodeSet.add(s);
    }
  });

  const linkMap = {};
  for (const act of data) {
    const source = getAthleteName(act.athlete_id);
    const target = mapSportName(act.sport_type);
    const key = `${source}>${target}`;
    if (!linkMap[key]) linkMap[key] = { source, target, value: 0 };
    linkMap[key].value += act.total_elevation_gain || 0;
  }
  const links = Object.values(linkMap).filter(l => l.value > 0);

  if (nodes.length === 0 || links.length === 0) {
    dom.innerHTML = '<div class="chart-loading">Aucune donnée</div>';
    return;
  }

  // DA : couleurs d'origine, un trait d'encre très fin autour des nœuds et des flux
  const ink = isDA() ? cssVar('--ink') : null;
  if (ink) nodes.forEach(n => { n.itemStyle = { ...n.itemStyle, borderColor: ink, borderWidth: 0.8 }; });

  sankeyChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(10,10,15,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif" },
      formatter: params => {
        if (params.dataType === 'edge') {
          return `${params.data.source} → ${params.data.target}<br/>↑ ${formatElevationCompact(params.data.value)} m`;
        }
        const node = nodes.find(n => n.name === params.name);
        if (node) return `<strong>${params.name}</strong><br/>↑ ${formatElevationCompact(node.total)} m<br/>${node.percentage}% du total`;
        return params.name;
      }
    },
    series: [{
      type: 'sankey',
      layout: 'none',
      emphasis: { focus: 'adjacency' },
      nodeAlign: 'left',
      data: nodes,
      links,
      label: isDA()
        ? { color: cssVar('--ink'), fontFamily: "'JetBrains Mono',monospace", fontSize: 11, fontWeight: 700, formatter: p => (SPORT_STYLE[p.name]?.label || p.name).toUpperCase() }
        : { color: '#fff', fontFamily: "'Inter',sans-serif", fontSize: 12 },
      lineStyle: ink
        ? { color: 'gradient', curveness: 0.5, opacity: 0.5, borderColor: ink, borderWidth: 0.5 }
        : { color: 'gradient', curveness: 0.5, opacity: 0.4 },
      itemStyle: ink ? {} : { borderWidth: 0 }
    }]
  });
}

// ============================================
// CALENDAR HEATMAP + BARRES PERF
// ============================================

/**
 * Calendrier : le round et la saison où l'on a le plus grimpé (jours locaux,
 * comme les rounds). Rounds et saisons terminés ou en cours, jamais à venir.
 */
function calendarHighlights(dailyEl) {
  const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = key(new Date());
  const sum = (a, b) => { let t = 0; for (const [k, v] of Object.entries(dailyEl)) if (k >= a && k <= b) t += v; return t; };
  const nowRound = getGlobalRoundNumber(new Date());
  let round = null, season = null;
  for (let sn = 1; sn <= getSeasonNumber(new Date()); sn++) {
    const first = getSeasonStartRound(sn), n = getRoundsForSeason(sn);
    if (first > nowRound) break;
    for (let r = first; r < first + n && r <= nowRound; r++) {
      const { start, end } = getRoundDates(r), a = key(start), b = key(end) > today ? today : key(end), v = sum(a, b);
      if (v > 0 && (!round || v > round.v)) round = { a, b, v, label: `round ${r - first + 1} de la saison ${sn}` };
    }
    const a = key(getRoundDates(first).start), last = key(getRoundDates(first + n - 1).end), b = last > today ? today : last, v = sum(a, b);
    if (v > 0 && (!season || v > season.v)) season = { a, b, v, label: `saison ${sn}` };
  }
  return { round, season };
}

let calendarChart = null;
function renderCalendar(data) {
  const dom = document.getElementById('calendarHeatmap');
  if (!dom) return;
  if (calendarChart) { calendarChart.dispose(); calendarChart = null; }

  const year = CHALLENGE_YEAR;
  const dailyEl = {};
  for (const a of data) {
    const d = a.start_date.substring(0, 10);
    dailyEl[d] = (dailyEl[d] || 0) + (a.total_elevation_gain || 0);
  }

  const calendarData = Object.entries(dailyEl).map(([date, v]) => [date, v]);
  const maxValue = Math.max(...calendarData.map(d => d[1]), 1);

  // range du calendrier : début du challenge → fin d'année
  const startStr = CHALLENGE_CONFIG.yearStartDate;
  const endStr = `${year}-12-31`;

  if (isDA()) {
    drawCalendarDots(dom, dailyEl, startStr, endStr, calendarHighlights(dailyEl));
    return;
  }
  calendarChart = echarts.init(dom);
  calendarChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: 'rgba(10,10,15,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif" },
      formatter: p => {
        const d = new Date(p.data[0]).toLocaleDateString('fr-FR', {
          weekday: 'long', day: 'numeric', month: 'long'
        });
        return `${d}<br/>↑ ${formatElevationCompact(p.data[1])} m D+`;
      }
    },
    visualMap: {
      show: false,
      min: 0,
      max: maxValue,
      inRange: { color: ['#1a1a24', '#f97316'] }
    },
    calendar: {
      top: 20, left: 50, right: 20, bottom: 10,
      cellSize: ['auto', 15],
      range: [startStr, endStr],
      itemStyle: { borderWidth: 2, borderColor: '#0a0a0f' },
      yearLabel: { show: false },
      monthLabel: {
        color: 'rgba(255,255,255,0.5)',
        fontFamily: "'Space Mono',monospace",
        fontSize: 10,
        nameMap: ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc']
      },
      dayLabel: {
        firstDay: 1,
        color: 'rgba(255,255,255,0.3)',
        fontFamily: "'Space Mono',monospace",
        fontSize: 9,
        nameMap: ['D', 'L', 'M', 'M', 'J', 'V', 'S']
      },
      splitLine: { show: false }
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: calendarData }]
  });

}


// ============================================
// RIDGELINE : par sport
// ============================================

function calculateHourlyDistribution(data, groupBy) {
  const distrib = {};
  for (const act of data) {
    const dateStr = act.start_date_local || act.start_date;
    const hourPart = parseInt(dateStr.substring(11, 13));
    const minPart = parseInt(dateStr.substring(14, 16));
    const hour = hourPart + minPart / 60;
    const duration = (act.moving_time || 0) / 3600;

    let key;
    if (groupBy === 'athlete') key = getAthleteName(act.athlete_id);
    else if (groupBy === 'roundDay') {
      const d = new Date(act.start_date);
      const globalRound = getGlobalRoundNumber(d);
      const dayOfRound = Math.min(getRoundDuration(globalRound), Math.max(1, getDayInRound(d, globalRound)));
      key = `J${dayOfRound}`;
    } else {
      key = mapSportName(act.sport_type);
    }

    if (!distrib[key]) distrib[key] = [];
    for (let i = 0; i < duration; i += 0.25) {
      distrib[key].push((hour + i) % 24);
    }
  }
  return distrib;
}

let ridgelineChart = null;
function renderRidgelineBySport(data) {
  const dom = document.getElementById('ridgelineChart');
  if (!dom) return;
  if (ridgelineChart) { ridgelineChart.dispose(); ridgelineChart = null; }

  const distrib = calculateHourlyDistribution(data, 'sport');
  const sports = Object.keys(distrib);
  if (sports.length === 0) { dom.innerHTML = '<div class="chart-loading">Aucune donnée</div>'; return; }
  if (isDA()) {
    // Comme la première version : un motif et un crayon par sport
    const RIDGE = { Run: { motif: 0, crayon: '--sport-run' }, Bike: { motif: 6, crayon: '--sport-bike' }, Hike: { motif: 2, crayon: '--sport-hike' }, Ski: { motif: 4, crayon: '--sport-ski' } };
    renderRidgelineDA(dom, distrib, sports, true, s => RIDGE[s] || { motif: 9, crayon: '--sub' }, s => (SPORT_STYLE[s] || { label: s }).label);
    return;
  }
  ridgelineChart = echarts.init(dom);

  renderRidgeline(ridgelineChart, distrib, sports, {
    sortByVolume: true,
    getColor: s => getSportColor(s),
    title: null
  });
}

function renderRidgelineByRoundDay(data) {
  const dom = document.getElementById('roundRidgelineChart');
  if (!dom) return;
  if (window.roundRidgeChart) { window.roundRidgeChart.dispose(); window.roundRidgeChart = null; }

  const distrib = calculateHourlyDistribution(data, 'roundDay');
  // Trier explicitement J1 → J5
  const keys = ['J1', 'J2', 'J3', 'J4', 'J5'].filter(k => distrib[k]);
  if (keys.length === 0) { dom.innerHTML = '<div class="chart-loading">Aucune donnée</div>'; return; }
  if (isDA()) {
    // Du J1 au J5, des motifs de plus en plus serrés (comme le money time)
    const DAY = { J1: { motif: 4, crayon: '--sub' }, J2: { motif: 9, crayon: '--sub' }, J3: { motif: 5, crayon: '--ink' }, J4: { motif: 1, crayon: '--ink' }, J5: { motif: 0, crayon: '--accent' } };
    renderRidgelineDA(dom, distrib, keys, false, k => DAY[k], k => 'Jour ' + k.slice(1));
    return;
  }
  window.roundRidgeChart = echarts.init(dom);

  // Couleurs graduées du J1 (plus clair) au J5 (accent danger rouge)
  const dayColors = {
    'J1': '#22d3ee', // cyan clair
    'J2': '#10b981', // vert
    'J3': '#fbbf24', // jaune
    'J4': '#f97316', // orange
    'J5': '#ef4444'  // rouge (effet "deadline")
  };

  renderRidgeline(window.roundRidgeChart, distrib, keys, {
    sortByVolume: false,
    getColor: k => dayColors[k] || '#888',
    title: null
  });
}

/** DA : mêmes tranches de 15 min que le moteur ECharts, dessinées à la main */
function renderRidgelineDA(dom, distributions, orderedKeys, sortByVolume, styleOf, labelOf) {
  const keys = [...orderedKeys];
  if (sortByVolume) keys.sort((a, b) => distributions[a].length - distributions[b].length);
  const slots = [];
  for (let h = 0; h < 24; h += 0.25) slots.push(h);
  const vals = {};
  for (const k of keys) vals[k] = slots.map(h => distributions[k].filter(x => x >= h && x < h + 0.25).length * 0.25);
  drawRidgeline(dom, keys, vals, styleOf, labelOf, (k, i) => {
    const h = slots[i], hInt = Math.floor(h), mins = Math.round((h - hInt) * 60);
    const time = `${String(hInt).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    return `<b>${time}</b><br>${labelOf(k)} : ${Math.round(vals[k][i] * 60)} min`;
  });
}

/**
 * Moteur ridgeline générique.
 */
function renderRidgeline(chart, distributions, orderedKeys, opts) {
  const { sortByVolume, getColor } = opts;
  let keys = [...orderedKeys];

  if (sortByVolume) {
    const volumes = {};
    keys.forEach(k => { volumes[k] = distributions[k].length * 0.25; });
    keys.sort((a, b) => volumes[a] - volumes[b]);
  }

  const xAxisData = [];
  for (let h = 0; h < 24; h += 0.25) xAxisData.push(h);

  const rawByKey = {};
  const allData = {};
  let maxHours = 0;
  for (const k of keys) {
    const vals = xAxisData.map(h => {
      const count = distributions[k].filter(x => x >= h && x < h + 0.25).length;
      return count * 0.25;
    });
    allData[k] = vals;
    rawByKey[k] = vals;
    const localMax = Math.max(...vals);
    if (localMax > maxHours) maxHours = localMax;
  }

  const GAP = 0.15;
  const series = keys.map((k, i) => ({
    name: k,
    type: 'line',
    data: allData[k].map(v => v + i * (maxHours * GAP)),
    smooth: true,
    symbol: 'none',
    lineStyle: { width: 2, color: getColor(k) },
    areaStyle: {
      origin: i * (maxHours * GAP),
      color: {
        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: getColor(k) + 'CC' },
          { offset: 1, color: getColor(k) + '20' }
        ]
      }
    },
    emphasis: { focus: 'series' },
    itemStyle: { color: getColor(k) }
  }));

  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(10,10,15,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif" },
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(249,115,22,0.5)', width: 1 } },
      formatter: params => {
        const h = params[0].axisValue;
        const hInt = Math.floor(h);
        const mins = Math.round((h - hInt) * 60);
        const timeStr = `${String(hInt).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        let out = `<strong>${timeStr}</strong><br/>`;
        const dataIndex = params[0].dataIndex;
        params.forEach(p => {
          const vals = rawByKey[p.seriesName][dataIndex];
          if (vals > 0) {
            out += `${p.marker}${p.seriesName}: ${Math.round(vals * 60)}min<br/>`;
          }
        });
        return out;
      }
    },
    legend: {
      data: keys,
      textStyle: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontFamily: "'Inter',sans-serif" },
      top: 10, left: 'center'
    },
    grid: { left: '3%', right: '4%', top: 60, bottom: '10%', containLabel: true },
    xAxis: {
      type: 'category',
      data: xAxisData,
      boundaryGap: false,
      axisLabel: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 10,
        fontFamily: "'Space Mono',monospace",
        formatter: v => (Math.floor(v) % 2 === 0 && v % 1 === 0) ? Math.floor(v) + 'h' : ''
      },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
      splitLine: { show: true, lineStyle: { color: 'rgba(255,255,255,0.04)' } }
    },
    yAxis: { type: 'value', show: false },
    series
  });
}

// ============================================
// SORTIES EN GROUPE (Chord diagram D3)
// ============================================

let detectedGroups = null;

function renderSocialGraph(groups) {
  const container = document.getElementById('socialGraph');
  if (!container) return;
  container.innerHTML = '';

  if (!groups || groups.length === 0) {
    container.innerHTML = '<div class="social-empty">Aucune sortie de groupe détectée<br><span style="font-size:0.75rem;opacity:0.7;margin-top:8px;display:block;">(détection par horaire + GPS requiert au moins 2 activités similaires le même jour)</span></div>';
    renderSocialLegend([]);
    renderSocialStats([], [], []);
    return;
  }

  // Collecter athlètes uniques
  const athleteSet = new Set();
  groups.forEach(g => g.athletes.forEach(id => athleteSet.add(id)));
  const athleteIds = [...athleteSet];
  const n = athleteIds.length;
  if (n < 2) {
    container.innerHTML = '<div class="social-empty">Pas assez d\'athlètes pour un graphe</div>';
    renderSocialLegend([]);
    renderSocialStats([], [], []);
    return;
  }

  const totalMatrix = Array.from({ length: n }, () => new Array(n).fill(0));
  const idx = new Map(athleteIds.map((id, i) => [id, i]));
  const individualLinks = [];
  const sportsUsed = new Set();

  for (const g of groups) {
    const sportCat = g.sport_category || mapSportName(g.sport_type);
    sportsUsed.add(sportCat);

    for (let i = 0; i < g.athletes.length; i++) {
      for (let j = i + 1; j < g.athletes.length; j++) {
        const a1 = g.athletes[i];
        const a2 = g.athletes[j];
        const i1 = idx.get(a1);
        const i2 = idx.get(a2);
        if (i1 == null || i2 == null) continue;
        totalMatrix[i1][i2] += g.elevation;
        totalMatrix[i2][i1] += g.elevation;
        individualLinks.push({
          source: i1, target: i2,
          value: g.elevation,
          sport: sportCat,
          name: g.name,
          date: g.date,
          athleteIds: [a1, a2]
        });
      }
    }
  }

  const width = container.clientWidth || 800;
  const height = container.clientHeight || 550;
  const outerRadius = Math.min(width, height) * 0.4;
  const innerRadius = outerRadius - 25;

  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .append('g')
    .attr('transform', `translate(${width/2},${height/2})`);

  const tooltip = d3.select(container)
    .append('div')
    .attr('class', 'social-tip')
    .style('position', 'fixed')
    .style('background', 'rgba(10,10,15,0.98)')
    .style('border', '1px solid rgba(255,255,255,0.15)')
    .style('border-radius', '10px')
    .style('padding', '12px 16px')
    .style('pointer-events', 'none')
    .style('z-index', '1000')
    .style('font-size', '12px')
    .style('color', '#fff')
    .style('box-shadow', '0 4px 20px rgba(0,0,0,0.5)')
    .style('opacity', 0)
    .style('transition', 'opacity 0.15s')
    .style('max-width', '300px');

  const chord = d3.chord().padAngle(0.05).sortSubgroups(d3.descending);
  const chords = chord(totalMatrix);
  const arc = d3.arc().innerRadius(innerRadius).outerRadius(outerRadius);
  const ribbon = d3.ribbon().radius(innerRadius - 2);

  let selectedIndex = null;

  // Ribbons individuels
  const linksByPair = new Map();
  for (const link of individualLinks) {
    const key = `${Math.min(link.source, link.target)}-${Math.max(link.source, link.target)}`;
    if (!linksByPair.has(key)) linksByPair.set(key, []);
    linksByPair.get(key).push(link);
  }

  const ribbonData = [];
  for (const [pairKey, links] of linksByPair) {
    const [srcIdx, tgtIdx] = pairKey.split('-').map(Number);
    const sg = chords.groups.find(g => g.index === srcIdx);
    const tg = chords.groups.find(g => g.index === tgtIdx);
    if (!sg || !tg) continue;
    const totalVal = links.reduce((s, l) => s + l.value, 0);
    if (totalVal === 0) continue;
    const srcAngleWidth = (sg.endAngle - sg.startAngle) * (totalVal / sg.value);
    const tgtAngleWidth = (tg.endAngle - tg.startAngle) * (totalVal / tg.value);
    let srcOffset = sg.startAngle;
    let tgtOffset = tg.startAngle;
    for (const link of links) {
      const lsw = srcAngleWidth * (link.value / totalVal);
      const ltw = tgtAngleWidth * (link.value / totalVal);
      ribbonData.push({
        ...link,
        sourceStartAngle: srcOffset,
        sourceEndAngle: srcOffset + lsw,
        targetStartAngle: tgtOffset,
        targetEndAngle: tgtOffset + ltw
      });
      srcOffset += lsw;
      tgtOffset += ltw;
    }
  }

  const ribbons = svg.append('g')
    .selectAll('path')
    .data(ribbonData)
    .join('path')
    .attr('class', 'soc-ribbon')
    .attr('d', d => ribbon({
      source: { startAngle: d.sourceStartAngle, endAngle: d.sourceEndAngle },
      target: { startAngle: d.targetStartAngle, endAngle: d.targetEndAngle }
    }))
    .attr('fill', d => getSportColor(d.sport))
    .attr('stroke', 'rgba(255,255,255,0.1)')
    .attr('stroke-width', 0.5)
    .style('opacity', 0.65)
    .style('cursor', 'pointer')
    .on('mouseover', function(event, d) {
      if (selectedIndex !== null && d.source !== selectedIndex && d.target !== selectedIndex) return;
      d3.select(this).style('opacity', 0.95).attr('stroke-width', 1);
      const a1 = athleteIds[d.source];
      const a2 = athleteIds[d.target];
      const date = new Date(d.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
      tooltip.html(`
        <div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#f97316">${date}</div>
        <div style="font-size:14px;margin-bottom:6px;font-weight:500">${d.name}</div>
        <div style="display:flex;gap:12px;font-size:11px;color:rgba(255,255,255,0.8)">
          <div><span style="color:rgba(255,255,255,0.5)">Sport:</span> ${d.sport}</div>
          <div><span style="color:rgba(255,255,255,0.5)">D+:</span> ${formatElevationCompact(d.value)} m</div>
        </div>
        <div style="font-size:10px;color:rgba(255,255,255,0.5);margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1)">
          ${getAthleteName(a1)} · ${getAthleteName(a2)}
        </div>`)
        .style('left', (event.clientX + 15) + 'px')
        .style('top', (event.clientY - 10) + 'px')
        .style('opacity', 1);
    })
    .on('mouseout', function() {
      if (selectedIndex !== null) { d3.select(this).style('opacity', 0.9).attr('stroke-width', 0.5); tooltip.style('opacity', 0); return; }
      d3.select(this).style('opacity', 0.65).attr('stroke-width', 0.5);
      tooltip.style('opacity', 0);
    });

  // Arcs d'athlètes
  const groupArcs = svg.append('g')
    .selectAll('path')
    .data(chords.groups)
    .join('path')
    .attr('class', 'soc-arc')
    .attr('d', arc)
    .attr('fill', d => getAthleteColor(athleteIds[d.index]))
    .attr('stroke', '#0a0a0f')
    .attr('stroke-width', 1)
    .style('opacity', 0.9)
    .style('cursor', 'pointer')
    .on('mouseover', function(event, d) {
      if (selectedIndex !== null) return;
      d3.select(this).style('opacity', 1);
      const athleteId = athleteIds[d.index];
      const grpCount = groups.filter(g => g.athletes.includes(athleteId)).length;
      const partners = new Set();
      let totalEl = 0;
      groups.forEach(g => {
        if (g.athletes.includes(athleteId)) {
          g.athletes.forEach(id => { if (id !== athleteId) partners.add(id); });
          totalEl += g.elevation;
        }
      });
      tooltip.html(`
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="width:14px;height:14px;border-radius:50%;background:${getAthleteColor(athleteId)}"></span>
          <span style="font-weight:600;font-size:14px">${getAthleteName(athleteId)}</span>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.7)">
          ${grpCount} sortie${grpCount > 1 ? 's' : ''} en groupe<br>
          ${partners.size} partenaire${partners.size > 1 ? 's' : ''}<br>
          ↑ ${formatElevationCompact(totalEl)} m en groupe
        </div>`)
        .style('left', (event.clientX + 15) + 'px')
        .style('top', (event.clientY - 10) + 'px')
        .style('opacity', 1);
    })
    .on('mouseout', function() {
      if (selectedIndex !== null) return;
      d3.select(this).style('opacity', 0.9);
      tooltip.style('opacity', 0);
    });

  // Labels
  const labels = svg.append('g')
    .selectAll('text')
    .data(chords.groups)
    .join('text')
    .attr('class', 'soc-label')
    .attr('dy', '.35em')
    .attr('transform', d => {
      const angle = (d.startAngle + d.endAngle) / 2;
      const rotate = angle * 180 / Math.PI - 90;
      const flip = angle > Math.PI;
      return `rotate(${rotate}) translate(${outerRadius + 10}) ${flip ? 'rotate(180)' : ''}`;
    })
    .attr('text-anchor', d => ((d.startAngle + d.endAngle) / 2) > Math.PI ? 'end' : 'start')
    .attr('fill', '#fff')
    .attr('font-size', '11px')
    .attr('font-weight', '500')
    .style('text-shadow', '0 1px 3px rgba(0,0,0,0.8)')
    .text(d => getAthleteName(athleteIds[d.index]));

  // Clic sur un nom (ou son arc) : ses sorties ressortent, le reste passe en grisé.
  // Nouveau clic, ou clic dans le vide : tout revient.
  const linked = d => d.source === selectedIndex || d.target === selectedIndex;
  const partnerOf = i => i === selectedIndex || ribbonData.some(r => linked(r) && (r.source === i || r.target === i));
  const applySelection = () => {
    const on = selectedIndex !== null;
    ribbons.style('opacity', d => !on ? 0.65 : linked(d) ? 0.9 : 0.05);
    groupArcs.style('opacity', d => !on || partnerOf(d.index) ? 0.9 : 0.18);
    labels.style('opacity', d => !on || partnerOf(d.index) ? 1 : 0.25)
      .style('font-weight', d => on && d.index === selectedIndex ? '700' : null);
  };
  const toggle = (event, d) => {
    event.stopPropagation();
    selectedIndex = selectedIndex === d.index ? null : d.index;
    tooltip.style('opacity', 0);
    applySelection();
  };
  groupArcs.on('click', toggle);
  labels.style('cursor', 'pointer').on('click', toggle);
  d3.select(container).select('svg').on('click', () => {
    if (selectedIndex === null) return;
    selectedIndex = null;
    applySelection();
  });

  if (isDA()) styleSocialDA(container, athleteIds);
  renderSocialLegend([...sportsUsed]);
  renderSocialStats(athleteIds, individualLinks, groups);
}

function renderSocialLegend(sports) {
  const legendContainer = document.getElementById('socialLegendItems');
  if (!legendContainer) return;
  if (!sports || sports.length === 0) {
    legendContainer.innerHTML = '<span style="color:rgba(255,255,255,0.5);font-size:0.8rem">Aucune donnée</span>';
    return;
  }
  legendContainer.innerHTML = sports.map(s => `
    <div class="social-legend-item">
      <div class="social-legend-color" style="background:${getSportColor(s)}"></div>
      <span>${isDA() ? (SPORT_STYLE[s]?.label || s) : s}</span>
    </div>`).join('');
}

function renderSocialStats(athleteIds, links, groups) {
  const container = document.getElementById('socialStats');
  if (!container) return;

  if (!groups || groups.length === 0) {
    container.innerHTML = `<h4>Statistiques</h4><div class="social-stat-item"><span>Aucune sortie détectée</span></div>`;
    return;
  }

  const totalGroups = groups.length;
  const totalEl = links.reduce((s, l) => s + l.value, 0);

  const pairCounts = new Map();
  for (const link of links) {
    const key = [link.athleteIds[0], link.athleteIds[1]].sort().join('-');
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }
  let topPair = null, topCount = 0;
  for (const [k, c] of pairCounts) if (c > topCount) { topCount = c; topPair = k; }

  const socialCounts = {};
  for (const g of groups) {
    for (const id of g.athletes) socialCounts[id] = (socialCounts[id] || 0) + 1;
  }
  const mostSocial = Object.entries(socialCounts).sort((a, b) => b[1] - a[1])[0];
  const bigGroups = groups.filter(g => g.athletes.length >= 3).length;

  let topPairNames = '';
  if (topPair) {
    const [id1, id2] = topPair.split('-');
    topPairNames = `${getAthleteName(id1)} & ${getAthleteName(id2)}`;
  }

  container.innerHTML = `
    <h4>Statistiques</h4>
    <div class="social-stat-item"><span>Sorties en groupe</span><span class="social-stat-value">${totalGroups}</span></div>
    <div class="social-stat-item"><span>D+ en groupe</span><span class="social-stat-value">${formatElevationCompact(totalEl)} m</span></div>
    ${bigGroups > 0 ? `<div class="social-stat-item"><span>Sorties à 3+</span><span class="social-stat-value">${bigGroups}</span></div>` : ''}
    ${topPairNames ? `<div class="social-stat-item"><span>Duo le + actif</span><span class="social-stat-value" style="font-size:0.7rem">${topPairNames} (${topCount})</span></div>` : ''}
    ${mostSocial ? `<div class="social-stat-item"><span>Le + social</span><span class="social-stat-value">${getAthleteName(mostSocial[0])}</span></div>` : ''}
  `;
}

// ============================================
// ÉVOLUTION DES POINTS SAISON PAR SAISON
// ============================================
// Utilise standings-engine.js (même moteur que la page index)
// pour garantir que les points affichés sont identiques à ceux du classement général.

let pointsChart = null;
let pointsMode = 'cumulative'; // 'cumulative' (line) ou 'bump' (rang)
let frozenResultsCache = null;
let bonusesCache = [];

async function loadFrozenResults() {
  if (frozenResultsCache !== null) return frozenResultsCache;
  try {
    const response = await fetch('/api/frozen-results');
    if (response.ok) {
      frozenResultsCache = await response.json();
    } else {
      frozenResultsCache = { rounds: {} };
    }
  } catch (e) {
    frozenResultsCache = { rounds: {} };
  }
  // Propager le cache aux helpers de config.js
  setFrozenCache(frozenResultsCache);
  return frozenResultsCache;
}

async function loadBonuses() {
  try {
    const response = await fetch('/api/bonuses/all');
    if (response.ok) {
      bonusesCache = await response.json();
    }
  } catch (e) {
    bonusesCache = [];
  }
  return bonusesCache;
}

/**
 * Calcule l'évolution des points saison par saison pour tous les athlètes.
 * - Pour chaque saison complétée : snapshot du classement à la fin de la saison
 * - Pour la saison en cours : snapshot du classement actuel
 * Utilise le même moteur que la page index (standings-engine.js).
 */
async function computePointsEvolution() {
  const frozen = await loadFrozenResults();
  await loadBonuses();

  const rounds = frozen.rounds || {};
  const roundNumbers = Object.keys(rounds).map(n => parseInt(n, 10)).sort((a, b) => a - b);
  if (roundNumbers.length === 0) return null;

  // Déterminer les saisons à afficher : uniquement les saisons TERMINÉES
  // (un round finale figé avec `isWinner: true` dans le ranking).
  // La saison en cours n'est pas affichée car ses points évoluent en continu
  // et peuvent être trompeurs.
const today = new Date();
  const seasons = [];
  // Détection robuste : on s'appuie sur les saisons figées de
  // eliminatedChallengeRankings, pas sur un calcul théorique basé sur la date.
  const maxSeason = getSeasonNumber(today, frozen);
  for (let s = 1; s <= maxSeason; s++) {
    // Trouver la finale de cette saison : on accepte 3 marqueurs
    //   1. Un joueur avec isWinner: true dans le ranking (cas backend "propre")
    //   2. eliminatedChallengeRankings[s] existe et est figé (= saison clôturée)
    //   3. Fallback : tous les rounds attendus de la saison sont figés ET
    //      le dernier round n'a qu'un survivant (= finale jouée)
    const roundsOfSeason = Object.values(rounds)
      .filter(r => r && Number(r.seasonNumber) === s)
      .sort((a, b) => (a.roundInSeason || 0) - (b.roundInSeason || 0));

    const hasExplicitWinner = roundsOfSeason.some(r =>
      r.frozen && Array.isArray(r.ranking) && r.ranking.some(e => e.isWinner)
    );
    const elimRankingExists = !!frozen?.eliminatedChallengeRankings?.[String(s)];
    const lastRound = roundsOfSeason[roundsOfSeason.length - 1];
    const lastRoundHasSingleSurvivor = lastRound?.frozen &&
      ((lastRound.activeParticipants?.length || 0) - (lastRound.eliminations?.length || 0)) <= 1;

    if (hasExplicitWinner || elimRankingExists || lastRoundHasSingleSurvivor) {
      seasons.push(s);
    }
  }

  if (seasons.length === 0) return null;

  // Pour chaque saison, calculer le classement à sa fin
  // (snapshot cumulatif : contient les points de toutes les saisons jusqu'à celle-là incluse)
  const byAthlete = {};
  PARTICIPANTS.forEach(p => {
    byAthlete[String(p.id)] = {
      name: p.name,
      cumulative: [],        // [{season, points, breakdown}]
      ranks: [],             // [{season, rank}]
      seasonBreakdown: [],   // [{season, mainRank, mainPoints, elimRank, elimPoints, rescapePoints}]
      eliminatedAtSeason: null
    };
  });

  const baseParams = {
    activities: allActivities,
    frozenResults: frozen,
    bonuses: bonusesCache
  };

  for (const s of seasons) {
    // Utiliser la VRAIE date de fin de saison (fin du round finale figé)
    // plutôt que getSeasonDates() qui dépend de PARTICIPANTS.length et peut diverger
    // si le nombre d'athlètes en prod ≠ nombre utilisé pour le calcul.
    const seasonRounds = Object.values(rounds)
      .filter(r => r && Number(r.seasonNumber) === s && r.frozen)
      .sort((a, b) => (a.roundInSeason || 0) - (b.roundInSeason || 0));
    const finale = seasonRounds[seasonRounds.length - 1];
    const snapshotDate = finale?.dates?.end
      ? new Date(finale.dates.end)
      : null;

    if (!snapshotDate) {
      console.warn(`Pas de date de fin pour la saison ${s}, snapshot ignoré`);
      continue;
    }

    const standings = computeFinalStandings({
      ...baseParams,
      currentDate: snapshotDate
    });

    // DEBUG — affichage console pour diagnostiquer les valeurs du graphe.
    // Retire ce bloc quand les chiffres sont validés.
    console.group(`Évolution — Fin Saison ${s} (snapshot = ${snapshotDate.toISOString()})`);
    const sorted = [...standings].sort((a, b) => b.totalPoints - a.totalPoints);
    console.table(sorted.map(e => ({
      rank: e.rank,
      name: e.participant.name,
      total: e.totalPoints,
      main: e.totalMainPoints,
      elim: e.totalEliminatedPoints,
      rescape: e.totalRescapePoints,
      bonus: e.bonusPoints,
      wins: e.wins
    })));
    console.groupEnd();

    for (const entry of standings) {
      const id = String(entry.participant.id);
      if (!byAthlete[id]) continue;
      byAthlete[id].cumulative.push({
        season: s,
        points: entry.totalPoints,
        breakdown: {
          main: entry.totalMainPoints,
          elim: entry.totalEliminatedPoints,
          rescape: entry.totalRescapePoints,
          bonus: entry.bonusPoints
        }
      });
      byAthlete[id].ranks.push({ season: s, rank: entry.rank });
    }

    // Points gagnés SUR CETTE SAISON (pas cumulés) + rang par catégorie ce round-là,
    // pour l'affichage détaillé "Challenge principal : 7ème (+8pts)" dans le tooltip.
    const seasonPoints = calculatePointsForSeason(
      s, allActivities, snapshotDate, frozen, bonusesCache, frozen?.seasonBonuses || {}
    );
    const mainRankOrder = Object.entries(seasonPoints)
      .sort((a, b) => b[1].mainPoints - a[1].mainPoints);
    const mainRankMap = {};
    mainRankOrder.forEach(([id], idx) => { mainRankMap[id] = idx + 1; });
    const elimRankOrder = Object.entries(seasonPoints)
      .sort((a, b) => b[1].elimPoints - a[1].elimPoints);
    const elimRankMap = {};
    elimRankOrder.forEach(([id], idx) => { elimRankMap[id] = idx + 1; });

    for (const id in seasonPoints) {
      if (!byAthlete[id]) continue;
      byAthlete[id].seasonBreakdown = byAthlete[id].seasonBreakdown || [];
      byAthlete[id].seasonBreakdown.push({
        season: s,
        mainRank: mainRankMap[id],
        mainPoints: seasonPoints[id].mainPoints,
        elimRank: elimRankMap[id],
        elimPoints: seasonPoints[id].elimPoints,
        rescapePoints: seasonPoints[id].rescapePoints
      });
    }
  }

  // Marquer les athlètes éliminés dans chaque saison (pour le style en pointillé)
  for (const s of seasons) {
    const startRound = getSeasonStartRound(s);
    const roundsPerSeason = getRoundsForSeason(s);
    for (let r = startRound; r < startRound + roundsPerSeason; r++) {
      const round = rounds[String(r)];
      if (!round?.frozen) continue;
      for (const elim of (round.eliminations || [])) {
        const id = String(elim.id);
        if (byAthlete[id] && byAthlete[id].eliminatedAtSeason === null) {
          // ne marquer que la PREMIÈRE élimination (pour la ligne pointillée)
          // noter que les éliminés rejouent aux saisons suivantes (active = [...PARTICIPANTS] à chaque saison)
          // donc on n'utilise pas ce flag pour déterminer la présence, juste pour le style.
        }
      }
    }
  }

  return { seasons, byAthlete };
}

async function renderPointsChart() {
  const dom = document.getElementById('pointsChart');
  if (!dom) return;

  const data = await computePointsEvolution();
  if (!data || data.seasons.length === 0) {
    dom.innerHTML = '<div class="chart-loading">Aucune saison terminée</div>';
    return;
  }

  if (pointsChart) { pointsChart.dispose(); pointsChart = null; }

  const { seasons, byAthlete } = data;

  // Filtre : si on a sélectionné un athlète, on met en surbrillance les autres
  const selectedAthleteId = document.getElementById('athleteSelect').value;

  if (isDA()) {
    // Mêmes informations que les infobulles ECharts ci-dessous
    const ordinal = n => n === 1 ? '1er' : `${n}ème`;
    const tipFor = (id, i) => {
      const info = byAthlete[id];
      const head = `<b>${info.name}</b> — Saison ${seasons[i]}<br>`;
      if (pointsMode !== 'cumulative') {
        const r = info.ranks[i]?.rank;
        return head + `${r}<sup>${r === 1 ? 'er' : 'e'}</sup> au classement`;
      }
      const c = info.cumulative[i], bd = c?.breakdown, sb = info.seasonBreakdown?.[i];
      const lines = [];
      if (sb?.mainPoints > 0) lines.push(`Challenge principal : ${ordinal(sb.mainRank)} (+${sb.mainPoints}pts)`);
      if (sb?.elimPoints > 0) lines.push(`Challenge des Éliminés : ${ordinal(sb.elimRank)} (+${sb.elimPoints}pts)`);
      if (sb?.rescapePoints > 0) lines.push(`Jeton rescapé (+${sb.rescapePoints}pts)`);
      return head + `<b>${c?.points}</b> pts cumulés` +
        (bd ? `<br><small>Principal : ${bd.main} • Éliminés : ${bd.elim} • Rescapé : ${bd.rescape} • Bonus : ${bd.bonus}</small>` : '') +
        (lines.length ? `<br>${lines.join('<br>')}` : '');
    };
    drawPoints(dom, seasons, byAthlete, pointsMode, selectedAthleteId, tipFor);
    return;
  }
  pointsChart = echarts.init(dom);

  if (pointsMode === 'cumulative') {
    // Line chart cumulatif (points totaux saison par saison)
    const series = Object.entries(byAthlete).map(([id, info]) => {
      const isHighlighted = !selectedAthleteId || String(id) === String(selectedAthleteId);
      return {
        name: info.name,
        type: 'line',
        data: info.cumulative.map(e => e.points),
        smooth: false,
        symbol: 'circle',
        symbolSize: 8,
        lineStyle: {
          width: isHighlighted ? 3 : 1,
          color: getAthleteColor(id),
          opacity: isHighlighted ? 1 : 0.15
        },
        itemStyle: {
          color: getAthleteColor(id),
          opacity: isHighlighted ? 1 : 0.15
        },
        emphasis: { focus: 'series', lineStyle: { width: 5 } }
      };
    });

    pointsChart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(10,10,15,0.95)',
        borderColor: 'rgba(255,255,255,0.08)',
        textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif" },
        formatter: p => {
          // p est un objet (pas un tableau) quand trigger = 'item'
          const athleteInfo = Object.values(byAthlete).find(a => a.name === p.seriesName);
          const bd = athleteInfo?.cumulative[p.dataIndex]?.breakdown;
          const season = seasons[p.dataIndex];
          const bdStr = bd
            ? `<div style="opacity:0.7;font-size:11px;margin-top:4px">Principal : ${bd.main} • Éliminés : ${bd.elim} • Rescapé : ${bd.rescape} • Bonus : ${bd.bonus}</div>`
            : '';

          // Détail des points gagnés SUR cette saison (pas cumulés), avec rang par catégorie
          const sb = athleteInfo?.seasonBreakdown?.[p.dataIndex];
          const ordinal = n => n === 1 ? '1er' : `${n}ème`;
          const seasonLines = [];
          if (sb) {
            if (sb.mainPoints > 0) {
              seasonLines.push(`Challenge principal : ${ordinal(sb.mainRank)} (+${sb.mainPoints}pts)`);
            }
            if (sb.elimPoints > 0) {
              seasonLines.push(`Challenge des Éliminés : ${ordinal(sb.elimRank)} (+${sb.elimPoints}pts)`);
            }
            if (sb.rescapePoints > 0) {
              seasonLines.push(`Jeton rescapé (+${sb.rescapePoints}pts)`);
            }
          }
          const seasonStr = seasonLines.length
            ? `<div style="opacity:0.9;font-size:11px;margin-top:6px;line-height:1.6">${seasonLines.join('<br/>')}</div>`
            : '';

          return `<strong>${p.seriesName}</strong> — Saison ${season}<br/>` +
                 `${p.marker}<strong>${p.value}</strong> pts cumulés${bdStr}${seasonStr}`;
        }
      },
      legend: {
        type: 'scroll',
        data: Object.values(byAthlete).map(a => a.name),
        textStyle: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
        top: 10
      },
      grid: { left: 60, right: 40, top: 60, bottom: 50 },
      xAxis: {
        type: 'category',
        data: seasons.map(s => `Saison ${s}`),
        axisLabel: { color: 'rgba(255,255,255,0.6)', fontFamily: "'Space Mono',monospace" },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } }
      },
      yAxis: {
        type: 'value',
        name: 'Points cumulés',
        nameTextStyle: { color: 'rgba(255,255,255,0.6)', fontSize: 11 },
        axisLabel: { color: 'rgba(255,255,255,0.6)', fontFamily: "'Space Mono',monospace" },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }
      },
      series
    });
  } else {
    // Bump chart (rang saison par saison)
    const nAthletes = PARTICIPANTS.length;
    const series = Object.entries(byAthlete).map(([id, info]) => {
      const isHighlighted = !selectedAthleteId || String(id) === String(selectedAthleteId);
      return {
        name: info.name,
        type: 'line',
        data: info.ranks.map(r => r.rank),
        smooth: true,
        symbol: 'circle',
        symbolSize: 14,
        lineStyle: {
          width: isHighlighted ? 3.5 : 1.5,
          color: getAthleteColor(id),
          opacity: isHighlighted ? 1 : 0.15
        },
        itemStyle: {
          color: getAthleteColor(id),
          opacity: isHighlighted ? 1 : 0.15
        },
        emphasis: { focus: 'series', lineStyle: { width: 5 } },
        label: {
          show: isHighlighted,
          position: 'right',
          formatter: params => params.dataIndex === info.ranks.length - 1 ? info.name : '',
          color: getAthleteColor(id),
          fontSize: 11,
          fontWeight: 600
        }
      };
    });

    pointsChart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(10,10,15,0.95)',
        borderColor: 'rgba(255,255,255,0.08)',
        textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif" },
        formatter: p => {
          const suffix = p.value === 1 ? 'er' : 'e';
          const season = seasons[p.dataIndex];
          return `<strong>${p.seriesName}</strong> — Saison ${season}<br/>` +
                 `${p.marker}${p.value}<sup>${suffix}</sup> au classement`;
        }
      },
      legend: { show: false },
      grid: { left: 60, right: 150, top: 30, bottom: 40 },
      xAxis: {
        type: 'category',
        data: seasons.map(s => `Saison ${s}`),
        axisLabel: { color: 'rgba(255,255,255,0.6)', fontFamily: "'Space Mono',monospace" },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } }
      },
      yAxis: {
        type: 'value',
        inverse: true,
        min: 1,
        max: nAthletes,
        name: 'Rang',
        nameTextStyle: { color: 'rgba(255,255,255,0.6)', fontSize: 11 },
        axisLabel: { color: 'rgba(255,255,255,0.6)', fontFamily: "'Space Mono',monospace", formatter: v => v + 'e' },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }
      },
      series
    });
  }
}

// ============================================
// MONEY TIME — répartition du D+ dans un round
// ============================================
// Pour chaque athlète, on calcule la part de son D+ total réalisée :
//   - J1, J2, J3, J4 (jours 1 à 4 du round)
//   - J5 avant 19h (le dernier jour, avant la dernière ligne droite)
//   - "Money Time" : J5 à partir de 19h (les dernières heures)
// Affiché en barres horizontales stackées, normalisées à 100 % par athlète.

let moneyTimeChart = null;

async function computeMoneyTime() {
  const frozen = await loadFrozenResults();
  const rounds = frozen.rounds || {};
  const roundNumbers = Object.keys(rounds).map(n => parseInt(n, 10)).sort((a, b) => a - b);
  if (roundNumbers.length === 0) return null;

  // Structure : par athlète, 6 buckets (en m de D+)
  const byAthlete = {};
  PARTICIPANTS.forEach(p => {
    byAthlete[String(p.id)] = {
      name: p.name,
      buckets: [0, 0, 0, 0, 0, 0] // J1, J2, J3, J4, J5-avant19, MoneyTime
    };
  });

  // Pour chaque round figé, calculer les limites de chaque jour et répartir les activités
  for (const r of roundNumbers) {
    if (!rounds[r]?.frozen) continue;
    const roundDates = getRoundDates(r);
    // 5 jours du round. J1 = roundDates.start, J5 = roundDates.end
    const dayStarts = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(roundDates.start);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      dayStarts.push(d.getTime());
    }
    // J5 19h — seuil du money time
    const j5End = new Date(dayStarts[4]);
    j5End.setHours(19, 0, 0, 0);
    const j5MoneyTimeStart = j5End.getTime();
    const roundEndMs = roundDates.end.getTime();

    // Filtrer les activités qui se terminent dans ce round
    for (const a of allActivities) {
      const end = new Date(a.start_date).getTime() + (a.elapsed_time || 0) * 1000;
      if (end < dayStarts[0] || end > roundEndMs) continue;

      const id = String(a.athlete_id);
      if (!byAthlete[id]) continue;

      const elev = a.total_elevation_gain || 0;
      if (elev <= 0) continue;

      // Déterminer le bucket via l'heure de fin
      let bucket = 0;
      if (end >= j5MoneyTimeStart) bucket = 5;            // Money Time
      else if (end >= dayStarts[4]) bucket = 4;           // J5 avant 19h
      else if (end >= dayStarts[3]) bucket = 3;           // J4
      else if (end >= dayStarts[2]) bucket = 2;           // J3
      else if (end >= dayStarts[1]) bucket = 1;           // J2
      else bucket = 0;                                    // J1

      byAthlete[id].buckets[bucket] += elev;
    }
  }

  // Ne garder que les athlètes qui ont du D+ et normaliser à 100 %
  const entries = Object.entries(byAthlete)
    .map(([id, info]) => {
      const total = info.buckets.reduce((s, v) => s + v, 0);
      if (total === 0) return null;
      const pct = info.buckets.map(v => (v / total) * 100);
      return { id, name: info.name, buckets: info.buckets, pct, total };
    })
    .filter(Boolean);

  // Trier par % Money Time décroissant (les plus "procrastinateurs" en haut)
  entries.sort((a, b) => b.pct[5] - a.pct[5]);

  return entries;
}

async function renderMoneyTimeChart() {
  const dom = document.getElementById('moneyTimeChart');
  if (!dom) return;

  const entries = await computeMoneyTime();
  if (!entries || entries.length === 0) {
    dom.innerHTML = '<div class="chart-loading">Aucune donnée disponible</div>';
    return;
  }

  if (moneyTimeChart) { moneyTimeChart.dispose(); moneyTimeChart = null; }

  const labels = ['J1', 'J2', 'J3', 'J4', 'J5 (avant 19h)', 'Money Time (J5 ≥ 19h)'];
  if (isDA()) {
    const short = ['J1', 'J2', 'J3', 'J4', 'J5 avant 19h', 'Money time'];
    drawMoneyTime(dom, entries, short, (e, i) =>
      `<b>${e.name}</b><br>${labels[i]} : <b>${e.pct[i].toFixed(1)}%</b> (${formatElevationCompact(e.buckets[i])} m)`);
    return;
  }
  moneyTimeChart = echarts.init(dom);
  const colors = ['#22d3ee', '#10b981', '#fbbf24', '#f97316', '#ef4444', '#ce2828'];

  // Construire les séries : une par bucket
  const series = labels.map((label, i) => ({
    name: label,
    type: 'bar',
    stack: 'total',
    data: entries.map(e => ({
      value: e.pct[i].toFixed(1),
      rawElev: e.buckets[i]
    })),
    itemStyle: { color: colors[i] },
    emphasis: { focus: 'series' },
    label: i === 5 ? {
      show: true,
      position: 'insideRight',
      formatter: params => params.value >= 8 ? `${params.value}%` : '',
      color: '#fff',
      fontWeight: 700,
      fontSize: 11
    } : { show: false }
  }));

  moneyTimeChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: 'rgba(10,10,15,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif" },
      formatter: params => {
        const name = params[0].name;
        let html = `<strong>${name}</strong><br/>`;
        params.forEach(p => {
          const raw = p.data?.rawElev ?? 0;
          html += `${p.marker}${p.seriesName} : <strong>${p.value}%</strong> (${formatElevationCompact(raw)} m)<br/>`;
        });
        return html;
      }
    },
    legend: { show: false },
    grid: { left: 120, right: 60, top: 20, bottom: 40 },
    xAxis: {
      type: 'value',
      max: 100,
      axisLabel: {
        color: 'rgba(255,255,255,0.6)',
        fontFamily: "'Space Mono',monospace",
        formatter: '{value}%'
      },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }
    },
    yAxis: {
      type: 'category',
      data: entries.map(e => e.name),
      axisLabel: {
        color: 'rgba(255,255,255,0.85)',
        fontSize: 12,
        fontFamily: "'Inter',sans-serif"
      },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } }
    },
    series
  });
}


// ============================================
// COMPARAISON 2025 vs 2026
// ============================================
let compareChart = null;
let elevation2025Cache = null;

async function loadElevation2025() {
  if (elevation2025Cache !== null) return elevation2025Cache;
  try {
    const response = await fetch('/data/elevation_2025.json', { cache: 'force-cache' });
    if (response.ok) {
      elevation2025Cache = await response.json();
    } else {
      elevation2025Cache = { byAthlete: {} };
    }
  } catch (e) {
    elevation2025Cache = { byAthlete: {} };
  }
  return elevation2025Cache;
}

/**
 * Construit la série cumulative pour une année donnée.
 * Renvoie [{ x: 'MM-DD', y: cumElevation }, ...] où x est le jour de l'année (au format MM-DD)
 * pour pouvoir aligner 2025 et 2026 sur le même axe X.
 *
 * IMPORTANT : densifie en ajoutant des points pour les jours intermédiaires sans activité
 * (= la courbe reste plate ces jours-là). Sinon avec peu d'activités (vue 1 athlète),
 * echarts trace des segments qui sautent les jours vides → visuel saccadé.
 */
function buildCumulativeSeries(byDate) {
  const dates = Object.keys(byDate);
  if (dates.length === 0) return [];
  dates.sort();
  const firstDate = dates[0];
  // Borne supérieure : aujourd'hui pour 2026, sinon dernière activité
  const today = new Date();
  const currentYearStr = today.toISOString().substring(0, 10);
  const firstYear = firstDate.substring(0, 4);
  const lastDate = (firstYear === currentYearStr.substring(0, 4))
    ? currentYearStr
    : dates[dates.length - 1];

  const series = [];
  let cum = 0;
  let d = new Date(firstDate + 'T00:00:00Z');
  const end = new Date(lastDate + 'T00:00:00Z');
  while (d <= end) {
    const dateStr = d.toISOString().substring(0, 10);
    cum += byDate[dateStr] || 0;
    series.push({ x: dateStr.substring(5), y: Math.round(cum) });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return series;
}

async function renderCompareChart() {
  const dom = document.getElementById('compareChart');
  if (!dom) return;
  if (!HAS_2025_COMPARISON) return;

  const data2025 = await loadElevation2025();
  const data2026 = getFilteredData(); // activités 2026 (déjà filtrées par athlète si sélection)

  if (compareChart) { compareChart.dispose(); compareChart = null; }

  const selectedAthleteId = document.getElementById('athleteSelect')?.value;
  const isFilteredByAthlete = !!selectedAthleteId;

  // === Construire byDate 2025 ===
  let byDate2025 = {};
  let title2025 = 'Ligue 2025';
  if (isFilteredByAthlete) {
    // Mode 1 athlète : prendre uniquement ses données 2025 (si dispo)
    const athleteData = data2025.byAthlete?.[String(selectedAthleteId)];
    if (athleteData?.byDate) {
      byDate2025 = athleteData.byDate;
      title2025 = `${getAthleteName(selectedAthleteId)} 2025`;
    } else {
      // Pas de données 2025 pour cet athlète (= nouveau participant)
      title2025 = `${getAthleteName(selectedAthleteId)} 2025 (aucune donnée)`;
    }
  } else {
    // Mode global : somme de tous les athlètes 2025
    for (const [, info] of Object.entries(data2025.byAthlete || {})) {
      for (const [date, elev] of Object.entries(info.byDate || {})) {
        byDate2025[date] = (byDate2025[date] || 0) + elev;
      }
    }
  }

  // === Construire byDate 2026 ===
  const byDate2026 = {};
  for (const a of data2026) {
    const date = a.start_date.substring(0, 10);
    byDate2026[date] = (byDate2026[date] || 0) + (a.total_elevation_gain || 0);
  }
  const title2026 = isFilteredByAthlete
    ? `${getAthleteName(selectedAthleteId)} 2026`
    : 'Ligue 2026';

  const s2025 = buildCumulativeSeries(byDate2025);
  const s2026 = buildCumulativeSeries(byDate2026);

  // === Couleur 2026 : si athlète sélectionné, sa couleur sinon orange Versant ===
  const color2026 = isFilteredByAthlete ? getAthleteColor(selectedAthleteId) : '#f97316';
  const color2025 = '#94a3b8';

  // Stops du gradient pour 2026
  const rgb2026 = hexToRgba(color2026, 0.3);
  const rgb2026Transparent = hexToRgba(color2026, 0);

  if (isDA()) {
    drawCompare(dom, s2025, s2026, title2025, title2026, isFilteredByAthlete ? selectedAthleteId : '');
    return;
  }
  compareChart = echarts.init(dom);
  compareChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(10,10,15,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff' },
      formatter: params => {
        return params.map(p => {
          const v = typeof p.value === 'object' ? p.value[1] : p.value;
          const display = v >= 1000 ? `${(v/1000).toFixed(1)} km` : `${v} m`;
          return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color}"></span>
            <span>${p.seriesName}: <strong>${display} D+</strong></span>
          </div>`;
        }).join('');
      }
    },
    legend: {
      bottom: 0,
      textStyle: { color: 'rgba(255,255,255,0.85)' }
    },
    grid: { left: 60, right: 30, top: 30, bottom: 60 },
    xAxis: {
      type: 'category',
      name: 'Jour de l\'année',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { color: 'rgba(255,255,255,0.5)' },
      axisLabel: { color: 'rgba(255,255,255,0.6)', interval: 30 },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } }
    },
    yAxis: {
      type: 'value',
      name: isFilteredByAthlete ? 'D+ cumulé (m)' : 'D+ total ligue (m)',
      nameTextStyle: { color: 'rgba(255,255,255,0.5)' },
      axisLabel: {
        color: 'rgba(255,255,255,0.6)',
        formatter: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v
      },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }
    },
    series: [
      {
        name: title2025,
        type: 'line',
        smooth: false,
        symbol: 'none',
        data: s2025.map(p => [p.x, p.y]),
        lineStyle: { color: color2025, width: 2.5, type: 'dashed' },
        itemStyle: { color: color2025 }
      },
      {
        name: title2026,
        type: 'line',
        smooth: false,
        symbol: 'none',
        data: s2026.map(p => [p.x, p.y]),
        lineStyle: { color: color2026, width: 3 },
        itemStyle: { color: color2026 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: rgb2026 },
              { offset: 1, color: rgb2026Transparent }
            ]
          }
        }
      }
    ]
  });
}

/**
 * Helper : convertir un hex (#rrggbb) en rgba avec alpha.
 * Pour les couleurs d'athlètes qui sont en hex.
 */
function hexToRgba(hex, alpha) {
  if (!hex) return `rgba(249, 115, 22, ${alpha})`;
  // Si déjà rgba/rgb, on retourne tel quel
  if (hex.startsWith('rgb')) return hex;
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}


// ============================================
// TABLE DÉTAILLÉE + ACHIEVEMENTS
// ============================================

function renderRankingTable(stats) {
  const tbody = document.getElementById('rankingTableBody');
  if (!tbody) return;

  stats.sort((a, b) => b.total_elevation - a.total_elevation);

  const render = () => {
    tbody.innerHTML = stats.map(s => {
      const recordDate = s.best_activity
        ? new Date(s.best_activity.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
        : '-';
      const stravaLink = s.best_activity ? `https://www.strava.com/activities/${s.best_activity.id}` : '#';
      const elevPerPt = s.total_points > 0 ? s.elevation_per_point.toLocaleString('fr-FR') : '-';
      const wins = s.seasons_won > 0 ? picto('couronne', '🏆', 'Saison gagnée').repeat(Math.min(s.seasons_won, 5)) : '-';
      return `<tr>
        <td style="color:${getAthleteColor(s.athlete_id)}">${getAthleteName(s.athlete_id)}</td>
        <td>${Math.round(s.total_elevation).toLocaleString('fr-FR')}</td>
        <td>${s.total_points || 0}</td>
        <td>${elevPerPt}</td>
        <td>${wins}</td>
        <td>${s.activity_count}</td>
        <td>${(s.total_distance / 1000).toFixed(0)}</td>
        <td>${Math.round(s.total_time / 3600)}</td>
        <td>${s.elevation_per_distance}</td>
        <td>${s.elevation_per_time}</td>
        <td>${s.elevation_per_activity}</td>
        <td data-sort-value="${s.best_elevation}">
          ${s.best_activity ? `
            <a href="${stravaLink}" target="_blank" rel="noopener" class="record-link" title="${s.best_activity.name}">
              <span class="record-elevation">↑ ${formatElevationCompact(s.best_activity.elevation)} m</span>
              <span class="record-date">${recordDate}</span>
              <span class="record-strava">Strava →</span>
            </a>` : '-'}
        </td></tr>`;
    }).join('');
  };
  render();

  document.querySelectorAll('#rankingTable th').forEach(th => {
    const clone = th.cloneNode(true);
    th.parentNode.replaceChild(clone, th);
    clone.addEventListener('click', () => {
      const key = clone.dataset.sort;
      if (!key) return;
      const isAsc = clone.classList.contains('sorted-asc');
      document.querySelectorAll('#rankingTable th').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      stats.sort((a, b) => {
        const va = parseFloat(a[key]) || (a[key] || '');
        const vb = parseFloat(b[key]) || (b[key] || '');
        if (typeof va === 'string' || typeof vb === 'string') {
          return isAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
        }
        return isAsc ? va - vb : vb - va;
      });
      clone.classList.add(isAsc ? 'sorted-desc' : 'sorted-asc');
      render();
    });
  });
}

function renderAchievements(stats) {
  const grid = document.getElementById('achievementsGrid');
  if (!grid) return;

  const achievements = ACHIEVEMENTS;

  // Tooltip custom
  let tooltipEl = document.getElementById('achievement-tooltip');
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'achievement-tooltip';
    tooltipEl.style.cssText = `
      position:fixed;background:rgba(10,10,15,0.98);
      border:1px solid rgba(255,255,255,0.1);border-radius:12px;
      padding:12px 16px;pointer-events:none;z-index:10000;
      font-family:'Inter',sans-serif;font-size:12px;color:#fff;
      max-width:280px;box-shadow:0 4px 20px rgba(0,0,0,0.5);
      opacity:0;transition:opacity .15s ease;
    `;
    document.body.appendChild(tooltipEl);
  }

  const rankForAchievement = (ach) => rankAchievement(ach, stats);

  const cards = [];
  achievements.forEach((ach, aIdx) => {
    const sorted = rankForAchievement(ach);
    if (sorted.length === 0) return;
    const winner = sorted[0];
    const top3 = sorted.slice(0, 3);

    const winnerText = ach.formatWinner ? ach.formatWinner(winner) : ach.format(ach.getValue(winner));
    cards.push(`
      <div class="achievement-card" data-idx="${aIdx}">
        <div class="achievement-badge ${ach.type}">${picto('succes-' + ach.id, ach.emoji)}</div>
        <div class="achievement-info">
          <div class="achievement-name">${ach.name}</div>
          <div class="achievement-desc">${ach.desc}</div>
          <div class="achievement-winner">
            <div class="achievement-winner-color" style="background:${getAthleteColor(winner.athlete_id)}"></div>
            <span class="achievement-winner-name">${getAthleteName(winner.athlete_id)}</span>
            <span class="achievement-winner-value">${winnerText}</span>
          </div>
        </div>
      </div>
    `);

    // Store top3 on DOM after render
  });

  grid.innerHTML = cards.join('');

  document.querySelectorAll('.achievement-card').forEach(card => {
    const idx = parseInt(card.dataset.idx, 10);
    const ach = achievements[idx];
    if (!ach) return;
    const sorted = rankForAchievement(ach).slice(0, 3);

    card.addEventListener('mouseenter', () => {
      let html = `<div style="font-weight:600;margin-bottom:10px;font-size:13px">${picto('succes-' + ach.id, ach.emoji)} ${ach.name}</div>`;
      sorted.forEach((s, i) => {
        const medal = medalPicto(i + 1);
        const txt = ach.formatWinner ? ach.formatWinner(s) : ach.format(ach.getValue(s));
        html += `
          <div style="display:flex;align-items:center;gap:8px;margin:6px 0">
            <span>${medal}</span>
            <span style="width:10px;height:10px;border-radius:50%;background:${getAthleteColor(s.athlete_id)};flex-shrink:0"></span>
            <span style="color:rgba(255,255,255,0.9)">${getAthleteName(s.athlete_id)}</span>
            <span style="color:rgba(255,255,255,0.5);margin-left:auto">${txt}</span>
          </div>`;
      });
      tooltipEl.innerHTML = html;
      tooltipEl.style.opacity = '1';
    });
    card.addEventListener('mousemove', e => {
      tooltipEl.style.left = (e.clientX + 15) + 'px';
      tooltipEl.style.top = (e.clientY - 10) + 'px';
    });
    card.addEventListener('mouseleave', () => { tooltipEl.style.opacity = '0'; });
  });
}

// ============================================
// ORCHESTRATION
// ============================================

let rankingVisible = false;

function fillDropdowns(data) {
  const athleteSelect = document.getElementById('athleteSelect');
  const sportSelect = document.getElementById('sportSelect');

  // Remplir athlètes (triés par D+ descending)
  const byAthlete = new Map();
  for (const a of data) {
    byAthlete.set(a.athlete_id, (byAthlete.get(a.athlete_id) || 0) + (a.total_elevation_gain || 0));
  }
  const athletes = [...byAthlete.entries()].sort((a, b) => b[1] - a[1]);

  athletes.forEach(([id]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = getAthleteName(id);
    athleteSelect.appendChild(opt);
  });

  // Remplir sports
  const sports = [...new Set(data.map(a => a.sport_type))].sort();
  sports.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sportSelect.appendChild(opt);
  });
}

function refreshFilteredViews() {
  const filtered = getFilteredData();
  const athleteSelected = document.getElementById('athleteSelect').value;

  updateOverviewStats(filtered);
  renderSportPieChart(filtered);
  renderMiniRanking(allActivities); // le classement reste global
  renderMap(filtered, athleteSelected);
  renderSankey(filtered);
  renderCalendar(filtered);
  renderRidgelineBySport(filtered);
  renderRidgelineByRoundDay(filtered);
  // Re-rendre la comparaison 2025 vs 2026 quand le filtre athlète change
  renderCompareChart();

  // Si tableau détaillé visible, le re-rendre
  if (rankingVisible) renderRankingAndAchievements(filtered);
}

// Points et badges « jeu » lisent les rounds figés : attendre leur chargement,
// sinon un clic rapide sur « Tableau détaillé » les affiche vides.
async function renderRankingAndAchievements(filtered) {
  const frozen = await loadFrozenResults();
  renderRankingTable(computeAthleteStats(filtered, frozen));
}

// Achievements (section 06) : titres de l'année, sur toutes les activités
// (le filtre athlète ferait de lui le leader de tous les badges)
async function renderAchievementsSection() {
  const frozen = await loadFrozenResults();
  renderAchievements(computeAthleteStats(allActivities, frozen));
}

function toggleRankingSection() {
  rankingVisible = !rankingVisible;
  const section = document.getElementById('rankingStatsSection');
  const btn = document.getElementById('btnToggleRanking');
  if (!section) return;

  section.style.display = rankingVisible ? 'block' : 'none';
  btn.classList.toggle('active', rankingVisible);

  if (rankingVisible) {
    renderRankingAndAchievements(getFilteredData());
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function setupPointsToggle() {
  document.querySelectorAll('.points-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === pointsMode) return;
      pointsMode = mode;
      document.querySelectorAll('.points-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderPointsChart();
    });
  });
}

async function init() {
  const loader = document.getElementById('loadingScreen');
  const loadingText = document.getElementById('loadingText');
  const setStatus = (m) => { if (loadingText) loadingText.textContent = m; };

  try {
    setStatus('Chargement des participants…');
    await loadParticipants();

    setStatus('Récupération des activités…');
    const raw = await loadActivities();

    setStatus('Filtrage et normalisation…');
    allActivities = filterAndNormalize(raw);
    console.log(`${allActivities.length} activités après filtrage (>= ${CHALLENGE_CONFIG.yearStartDate})`);

    if (allActivities.length === 0) {
      document.body.innerHTML = `
        <div class="stats-error">
          <div class="stats-error-title">Aucune activité trouvée</div>
          <div class="stats-error-text">Le challenge démarre le ${formatDateFr(CHALLENGE_START)}. Les stats apparaîtront dès les premières activités.</div>
          <a href="index.html" class="stats-error-retry" style="text-decoration:none;display:inline-block;">Retour au classement</a>
        </div>`;
      return;
    }

    // Remplir les dropdowns
    fillDropdowns(allActivities);

    // Initialiser la carte (après que l'UI soit visible)
    initMap();

    // Setup listeners
    document.getElementById('athleteSelect').addEventListener('change', refreshFilteredViews);
    document.getElementById('sportSelect').addEventListener('change', refreshFilteredViews);
    document.getElementById('btnToggleRanking').addEventListener('click', toggleRankingSection);
    setupPointsToggle();

    // Afficher les filtres
    document.getElementById('statsFilters').style.display = 'block';

    setStatus('Presque prêt…');

    // Masquer le loader AVANT de rendre les graphiques lourds (UX plus rapide)
    loader.classList.add('hidden');

    // Petit délai pour laisser l'UI se stabiliser
    await new Promise(r => setTimeout(r, 50));

    // Rendre les graphiques rapides en premier
    requestAnimationFrame(() => {
      updateOverviewStats(allActivities);
      renderSportPieChart(allActivities);
      renderMiniRanking(allActivities);

      // Graphiques plus lourds en différé (pour ne pas bloquer)
      requestAnimationFrame(() => {
        renderSankey(allActivities);
        renderCalendar(allActivities);
        renderRidgelineBySport(allActivities);
        renderRidgelineByRoundDay(allActivities);

        // Carte
        requestAnimationFrame(() => {
          renderMap(allActivities, '');

          // Points chart (nécessite fetch)
          renderPointsChart();

          // Achievements (nécessite les rounds figés)
          renderAchievementsSection();

          // Money Time (nécessite fetch aussi)
          renderMoneyTimeChart();

          // Comparaison 2025 vs 2026 (nécessite fetch elevation_2025.json)
          renderCompareChart();

          // Sorties de groupe : le PLUS LOURD → on le fait via requestIdleCallback si dispo
          const ric = window.requestIdleCallback || function(cb) { return setTimeout(cb, 100); };
          ric(() => {
            const t0 = performance.now();
            detectedGroups = detectGroupActivities(allActivities);
            const elapsed = performance.now() - t0;
            console.log(`${detectedGroups.length} sorties en groupe détectées en ${elapsed.toFixed(0)}ms`);
            renderSocialGraph(detectedGroups);
          });
        });
      });
    });

    // DA : le sankey (canvas) suit le thème clair / cyanotype
    if (isDA()) {
      new MutationObserver(() => renderSankey(getFilteredData()))
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    // Resize handler global
    window.addEventListener('resize', () => {
      [sportPieChart, sankeyChart, calendarChart, ridgelineChart, pointsChart, moneyTimeChart, compareChart].forEach(c => {
        if (c) c.resize();
      });
      if (window.roundRidgeChart) window.roundRidgeChart.resize();
    });

  } catch (err) {
    console.error('Erreur init:', err);
    document.body.innerHTML = `
      <div class="stats-error">
        <div class="stats-error-title">Erreur de chargement</div>
        <div class="stats-error-text">${err.message || 'Impossible de charger les données.'}</div>
        <button class="stats-error-retry" onclick="location.reload()">Réessayer</button>
      </div>`;
  }
}

init();
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
  getGlobalRoundNumber,
  getRoundsForSeason,
  getSeasonNumber,
  getSeasonStartRound,
  loadParticipants,
  getAthleteColor as configAthleteColor
} from './config.js';

// ============================================
// CONSTANTES & HELPERS
// ============================================

const CHALLENGE_START = new Date(CHALLENGE_CONFIG.yearStartDate);
const CHALLENGE_YEAR = CHALLENGE_CONFIG.dataYear;

const CACHE_KEY = 'versant_stats_activities_v2';
const CACHE_DATE_KEY = 'versant_stats_activities_date_v2';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Sports exclus (jamais affichés même si l'API les renvoie)
const EXCLUDED_SPORTS = new Set(SPORT_SETTINGS.excludedSports);

// Mapping vers catégorie "sport" pour le Sankey/Pie/etc.
const SPORT_CATEGORY = SPORT_SETTINGS.validSports;
const SPORT_COLORS = SPORT_SETTINGS.sportColors;

function mapSportName(sportType) {
  return SPORT_CATEGORY[sportType] || 'Autre';
}

function getSportColor(sportOrCategory) {
  // Si on nous passe un type brut (TrailRun, BackcountrySki...), on mappe
  const cat = SPORT_COLORS[sportOrCategory] ? sportOrCategory : SPORT_CATEGORY[sportOrCategory];
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

function formatElevation(v) {
  if (v == null) return '0';
  if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
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
        console.log(`✅ Activités depuis cache (${data.length}, ${Math.round(age / 1000)}s)`);
        return data;
      }
    }
  } catch (e) {
    console.warn('⚠️ Cache illisible, rechargement', e);
  }

  // 2. API backend
  setStatus('Chargement des activités…');
  const leagueId = CHALLENGE_CONFIG.leagueId;
  const url = `/api/activities/${leagueId}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error ${response.status}`);
  const raw = await response.json();
  if (!Array.isArray(raw)) throw new Error('Format de réponse API invalide');
  console.log(`📦 ${raw.length} activités brutes reçues de l'API`);

  // 3. Sauvegarde cache
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(raw));
    sessionStorage.setItem(CACHE_DATE_KEY, Date.now().toString());
  } catch (e) {
    console.warn('⚠️ sessionStorage plein, on continue sans cache');
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
    achievement_count: a.achievement_count || 0
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
    `📊 Détection groupes: ${totalComparisons} comparaisons effectives, ` +
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
  if (sportPieChart) { sportPieChart.dispose(); }
  sportPieChart = echarts.init(dom);

  const bySport = {};
  for (const a of data) {
    const s = mapSportName(a.sport_type);
    bySport[s] = (bySport[s] || 0) + (a.total_elevation_gain || 0);
  }

  const pieData = Object.entries(bySport)
    .map(([name, value]) => ({ name, value, itemStyle: { color: getSportColor(name) } }))
    .sort((a, b) => b.value - a.value);

  sportPieChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(10,10,15,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif", fontSize: 12 },
      formatter: p => `${p.name}<br/>↑ ${formatElevation(p.value)} m (${p.percent.toFixed(1)}%)`
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

  const maxEl = stats[0]?.total_elevation || 1;

  slider.innerHTML = stats.map((s, i) => {
    const pct = (s.total_elevation / maxEl) * 100;
    const posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    return `
      <div class="mini-rank-item">
        <div class="mini-rank-position ${posClass}">${i + 1}</div>
        <div class="mini-rank-info">
          <div class="mini-rank-name" style="color:${getAthleteColor(s.id)}">${getAthleteName(s.id)}</div>
          <div class="mini-rank-value">${formatElevation(s.total_elevation)} m</div>
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
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19
  }).addTo(map);
  setTimeout(() => map.invalidateSize(), 200);
}

function isSegmentStraight(points, startIdx, endIdx) {
  if (endIdx - startIdx < 2) return false;
  const s = points[startIdx];
  const e = points[endIdx];
  const direct = haversine(s[0], s[1], e[0], e[1]);
  let path = 0;
  for (let i = startIdx; i < endIdx; i++) {
    path += haversine(points[i][0], points[i][1], points[i+1][0], points[i+1][1]);
  }
  return path > 0 ? direct / path > 0.99 : false;
}

function filterStraightLines(points, minStraightDist) {
  if (!points || points.length < 3) return points ? [points] : [];
  const segments = [];
  let current = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    let straightEnd = -1;
    for (let j = i + 2; j < Math.min(i + 50, points.length); j++) {
      const d = haversine(points[i][0], points[i][1], points[j][0], points[j][1]);
      if (d > minStraightDist && isSegmentStraight(points, i, j)) straightEnd = j;
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
        ↑ ${formatElevation(act.total_elevation_gain)} m D+
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

  legendContainer.innerHTML = '<h3>Légende</h3>';

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

  // Panneau "Top zones" : on regroupe par centaine de km² (buckets lat/lon grossiers)
  // Pas de géocodage online : on liste les régions GPS les plus denses
  const regionBuckets = new Map();
  for (const a of activities) {
    if (!a.start_latlng || a.start_latlng.length < 2) continue;
    const [lat, lon] = a.start_latlng;
    // bucket approximatif ~50km
    const key = `${Math.round(lat * 2) / 2},${Math.round(lon * 2) / 2}`;
    if (!regionBuckets.has(key)) {
      regionBuckets.set(key, { lat, lon, count: 0, elevation: 0, athletes: new Set() });
    }
    const r = regionBuckets.get(key);
    r.count++;
    r.elevation += a.total_elevation_gain || 0;
    r.athletes.add(a.athlete_id);
  }

  const topRegions = [...regionBuckets.values()]
    .sort((a, b) => b.elevation - a.elevation)
    .slice(0, 10);

  countryContainer.innerHTML = '<h3>Zones actives</h3>';
  topRegions.forEach((r, i) => {
    countryContainer.insertAdjacentHTML('beforeend', `
      <div class="country-item">
        <div class="country-name">
          <span class="country-badge">${i + 1}</span>
          ${r.lat.toFixed(2)}°, ${r.lon.toFixed(2)}°
        </div>
        <div class="country-stats-line">↑ ${formatElevation(r.elevation)} m D+</div>
        <div class="country-stats-line">◉ ${r.count} activités</div>
        <div class="country-stats-line">👥 ${r.athletes.size} athlète${r.athletes.size > 1 ? 's' : ''}</div>
      </div>`);
  });
  countryContainer.insertAdjacentHTML('beforeend', `
    <div class="country-summary">${regionBuckets.size} zones distinctes</div>`);
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

  sankeyChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(10,10,15,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif" },
      formatter: params => {
        if (params.dataType === 'edge') {
          return `${params.data.source} → ${params.data.target}<br/>↑ ${formatElevation(params.data.value)} m`;
        }
        const node = nodes.find(n => n.name === params.name);
        if (node) return `<strong>${params.name}</strong><br/>↑ ${formatElevation(node.total)} m<br/>${node.percentage}% du total`;
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
      label: { color: '#fff', fontFamily: "'Inter',sans-serif", fontSize: 12 },
      lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.4 },
      itemStyle: { borderWidth: 0 }
    }]
  });
}

// ============================================
// CALENDAR HEATMAP + BARRES PERF
// ============================================

let calendarChart = null;
function renderCalendar(data) {
  const dom = document.getElementById('calendarHeatmap');
  if (!dom) return;
  if (calendarChart) calendarChart.dispose();
  calendarChart = echarts.init(dom);

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
        return `${d}<br/>↑ ${formatElevation(p.data[1])} m D+`;
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

  // Barres hebdo/mensuelles
  renderWeeklyBars(data, year);
  renderMonthlyBars(data, year);
}

function renderWeeklyBars(data, year) {
  const container = document.getElementById('weeklyBars');
  if (!container) return;

  // Objectif annuel de D+ : on se base sur le D+ total des participants × facteur indicatif
  // Plutôt que 1M/52 comme recapmillion, on fait un target proportionnel à la moyenne actuelle
  // ou simplement : target = percentile 50 des semaines non vides × 1.2
  const weeklyData = new Map();
  for (const a of data) {
    const d = new Date(a.start_date);
    if (d.getFullYear() !== year) continue;
    const w = getISOWeek(d);
    weeklyData.set(w, (weeklyData.get(w) || 0) + (a.total_elevation_gain || 0));
  }

  const allWeeks = [];
  for (let i = 1; i <= 52; i++) {
    allWeeks.push({ week: `S${i}`, value: weeklyData.get(i) || 0 });
  }

  const nonZero = allWeeks.filter(w => w.value > 0).map(w => w.value).sort((a, b) => a - b);
  const median = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length / 2)] : 0;
  const target = median * 1.2 || 5000;
  const maxValue = Math.max(...allWeeks.map(w => w.value), target * 1.2);
  const objectiveHeight = (target / maxValue) * 100;

  const barsHTML = allWeeks.map((w, i) => {
    const height = (w.value / maxValue) * 100;
    const weekNum = i + 1;
    const showLabel = weekNum % 4 === 1;
    const diff = w.value - target;
    const diffSign = diff >= 0 ? '+' : '';
    const diffClass = diff >= 0 ? 'positive' : 'negative';
    return `
      <div class="perf-bar" style="height:${Math.max(height, 2)}%;transition:height .5s ease-out ${i * 15}ms">
        <div class="perf-bar-tooltip">
          <strong>S${weekNum}</strong><br>
          ↑ ${formatElevation(w.value)} m<br>
          <span class="diff-${diffClass}">${diffSign}${formatElevation(diff)} m</span>
        </div>
        ${showLabel ? `<span class="perf-bar-label">${weekNum}</span>` : ''}
      </div>`;
  }).join('');

  container.innerHTML = barsHTML + `
    <div class="objective-line" style="bottom:${objectiveHeight}%">
      <span class="objective-label">Médiane × 1.2 = ${formatElevation(target)} m</span>
    </div>`;
}

function renderMonthlyBars(data, year) {
  const container = document.getElementById('monthlyBars');
  if (!container) return;

  const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
  const monthlyData = new Array(12).fill(0);
  for (const a of data) {
    const d = new Date(a.start_date);
    if (d.getFullYear() !== year) continue;
    monthlyData[d.getMonth()] += a.total_elevation_gain || 0;
  }

  const nonZero = monthlyData.filter(v => v > 0).sort((a, b) => a - b);
  const median = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length / 2)] : 0;
  const target = median * 1.2 || 20000;
  const maxValue = Math.max(...monthlyData, target * 1.2);
  const objectiveHeight = (target / maxValue) * 100;

  const barsHTML = monthlyData.map((v, i) => {
    const height = (v / maxValue) * 100;
    const diff = v - target;
    const diffSign = diff >= 0 ? '+' : '';
    const diffClass = diff >= 0 ? 'positive' : 'negative';
    return `
      <div class="perf-bar" style="height:${Math.max(height, 2)}%;transition:height .6s ease-out ${i * 50}ms">
        <div class="perf-bar-tooltip">
          <strong>${monthNames[i]}</strong><br>
          ↑ ${formatElevation(v)} m<br>
          <span class="diff-${diffClass}">${diffSign}${formatElevation(diff)} m</span>
        </div>
        <span class="perf-bar-label">${monthNames[i]}</span>
      </div>`;
  }).join('');

  container.innerHTML = barsHTML + `
    <div class="objective-line" style="bottom:${objectiveHeight}%">
      <span class="objective-label">Médiane × 1.2 = ${formatElevation(target)} m</span>
    </div>`;
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
      const roundDates = getRoundDates(globalRound);
      const dayOfRound = Math.min(5, Math.max(1, Math.floor((d - roundDates.start) / (1000 * 60 * 60 * 24)) + 1));
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
  if (ridgelineChart) ridgelineChart.dispose();
  ridgelineChart = echarts.init(dom);

  const distrib = calculateHourlyDistribution(data, 'sport');
  const sports = Object.keys(distrib);
  if (sports.length === 0) { dom.innerHTML = '<div class="chart-loading">Aucune donnée</div>'; return; }

  renderRidgeline(ridgelineChart, distrib, sports, {
    sortByVolume: true,
    getColor: s => getSportColor(s),
    title: null
  });
}

function renderRidgelineByRoundDay(data) {
  const dom = document.getElementById('roundRidgelineChart');
  if (!dom) return;
  if (window.roundRidgeChart) window.roundRidgeChart.dispose();
  window.roundRidgeChart = echarts.init(dom);

  const distrib = calculateHourlyDistribution(data, 'roundDay');
  // Trier explicitement J1 → J5
  const keys = ['J1', 'J2', 'J3', 'J4', 'J5'].filter(k => distrib[k]);
  if (keys.length === 0) { dom.innerHTML = '<div class="chart-loading">Aucune donnée</div>'; return; }

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
      if (selectedIndex !== null) return;
      d3.select(this).style('opacity', 0.95).attr('stroke-width', 1);
      const a1 = athleteIds[d.source];
      const a2 = athleteIds[d.target];
      const date = new Date(d.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
      tooltip.html(`
        <div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#f97316">${date}</div>
        <div style="font-size:14px;margin-bottom:6px;font-weight:500">${d.name}</div>
        <div style="display:flex;gap:12px;font-size:11px;color:rgba(255,255,255,0.8)">
          <div><span style="color:rgba(255,255,255,0.5)">Sport:</span> ${d.sport}</div>
          <div><span style="color:rgba(255,255,255,0.5)">D+:</span> ${formatElevation(d.value)} m</div>
        </div>
        <div style="font-size:10px;color:rgba(255,255,255,0.5);margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1)">
          ${getAthleteName(a1)} · ${getAthleteName(a2)}
        </div>`)
        .style('left', (event.clientX + 15) + 'px')
        .style('top', (event.clientY - 10) + 'px')
        .style('opacity', 1);
    })
    .on('mouseout', function() {
      if (selectedIndex !== null) return;
      d3.select(this).style('opacity', 0.65).attr('stroke-width', 0.5);
      tooltip.style('opacity', 0);
    });

  // Arcs d'athlètes
  const groupArcs = svg.append('g')
    .selectAll('path')
    .data(chords.groups)
    .join('path')
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
          ↑ ${formatElevation(totalEl)} m en groupe
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
  svg.append('g')
    .selectAll('text')
    .data(chords.groups)
    .join('text')
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
      <span>${s}</span>
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
    <div class="social-stat-item"><span>D+ en groupe</span><span class="social-stat-value">${formatElevation(totalEl)} m</span></div>
    ${bigGroups > 0 ? `<div class="social-stat-item"><span>Sorties à 3+</span><span class="social-stat-value">${bigGroups}</span></div>` : ''}
    ${topPairNames ? `<div class="social-stat-item"><span>Duo le + actif</span><span class="social-stat-value" style="font-size:0.7rem">${topPairNames} (${topCount})</span></div>` : ''}
    ${mostSocial ? `<div class="social-stat-item"><span>Le + social</span><span class="social-stat-value">${getAthleteName(mostSocial[0])}</span></div>` : ''}
  `;
}

// ============================================
// ÉVOLUTION DES POINTS PAR ROUND
// ============================================

let pointsChart = null;
let pointsMode = 'cumulative'; // 'cumulative' ou 'bump'
let frozenResultsCache = null;

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
  return frozenResultsCache;
}

/**
 * Calcule la série de points (cumulatifs) pour chaque athlète, round par round.
 *
 * Logique backend (voir backend/frozen-results.js) :
 *   - ranking[round] contient TOUS les participants actifs au début du round
 *     (triés par D+ décroissant, positions 1 à N)
 *   - seuls les ÉLIMINÉS du round reçoivent mainPoints > 0 (via getMainPoints)
 *   - les non-éliminés ont mainPoints = 0
 *   - exception finale : le gagnant (seul non-éliminé) reçoit getMainPoints(1)
 *   - le champ `mainPoints` est AUTORITATIF dans frozen_results.json, on le lit tel quel
 *
 * Challenge éliminés (fin de saison) : pas encore présent dans les données,
 * on l'intégrera quand le backend le produira.
 */
async function computePointsEvolution() {
  const frozen = await loadFrozenResults();
  const rounds = frozen.rounds || {};
  const roundNumbers = Object.keys(rounds).map(n => parseInt(n, 10)).sort((a, b) => a - b);

  if (roundNumbers.length === 0) return null;

  const byAthlete = {};
  PARTICIPANTS.forEach(p => {
    byAthlete[String(p.id)] = {
      name: p.name,
      cumulative: [],    // série cumulative [{round, points}]
      ranks: [],         // série classement [{round, rank}]
      eliminated: false,
      eliminatedAtRound: null
    };
  });

  const cumulativeByAthlete = {};
  PARTICIPANTS.forEach(p => { cumulativeByAthlete[String(p.id)] = 0; });

  for (const r of roundNumbers) {
    const round = rounds[r];
    if (!round || !round.ranking) continue;

    // Lecture directe des mainPoints depuis le JSON (source de vérité).
    // Le backend y stocke : 0 pour les survivants, > 0 pour les éliminés/vainqueurs.
    round.ranking.forEach(entry => {
      const id = String(entry.id);
      if (!byAthlete[id]) return;
      cumulativeByAthlete[id] += entry.mainPoints || 0;
    });

    // Marquer les athlètes éliminés ce round (pour le style de ligne en pointillé)
    const eliminationsThisRound = round.eliminations || [];
    for (const elim of eliminationsThisRound) {
      const id = String(elim.id);
      if (byAthlete[id]) {
        byAthlete[id].eliminated = true;
        byAthlete[id].eliminatedAtRound = r;
      }
    }

    // Challenge éliminés (futur) : si le JSON stocke un jour un champ `eliminatedPoints`
    // sur chaque entry, il sera lu ici :
    round.ranking.forEach(entry => {
      const id = String(entry.id);
      if (!byAthlete[id]) return;
      if (typeof entry.eliminatedPoints === 'number') {
        cumulativeByAthlete[id] += entry.eliminatedPoints;
      }
    });

    // Snapshot des totaux pour ce round
    PARTICIPANTS.forEach(p => {
      const id = String(p.id);
      byAthlete[id].cumulative.push({
        round: r,
        points: cumulativeByAthlete[id]
      });
    });

    // Snapshot des rangs à la fin de ce round
    // Tri secondaire stable par id pour éviter que les athlètes à égalité (ex. tous à 0)
    // ne sautillent entre les rangs d'un round à l'autre
    const snapshot = PARTICIPANTS
      .map(p => ({ id: String(p.id), pts: cumulativeByAthlete[String(p.id)] }))
      .sort((a, b) => (b.pts - a.pts) || a.id.localeCompare(b.id));
    snapshot.forEach((s, i) => {
      byAthlete[s.id].ranks.push({ round: r, rank: i + 1 });
    });
  }

  return { roundNumbers, byAthlete };
}

async function renderPointsChart() {
  const dom = document.getElementById('pointsChart');
  if (!dom) return;

  const data = await computePointsEvolution();
  if (!data || data.roundNumbers.length === 0) {
    dom.innerHTML = '<div class="chart-loading">Aucun round terminé pour l\'instant</div>';
    return;
  }

  if (pointsChart) pointsChart.dispose();
  pointsChart = echarts.init(dom);

  const { roundNumbers, byAthlete } = data;

  if (pointsMode === 'cumulative') {
    // Line chart cumulatif
    const series = Object.entries(byAthlete).map(([id, info]) => ({
      name: info.name,
      type: 'line',
      data: info.cumulative.map(e => e.points),
      smooth: true,
      symbol: info.eliminated ? 'emptyCircle' : 'circle',
      symbolSize: 6,
      lineStyle: {
        width: 2.5,
        color: getAthleteColor(id),
        type: info.eliminated ? 'dashed' : 'solid'
      },
      itemStyle: { color: getAthleteColor(id) },
      emphasis: { focus: 'series', lineStyle: { width: 4 } }
    }));

    pointsChart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(10,10,15,0.95)',
        borderColor: 'rgba(255,255,255,0.08)',
        textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif" },
        formatter: params => {
          params.sort((a, b) => b.value - a.value);
          const round = params[0].axisValue;
          let html = `<strong>Round ${round}</strong><br/>`;
          for (const p of params.slice(0, 8)) {
            html += `${p.marker}${p.seriesName} : <strong>${p.value}</strong> pts<br/>`;
          }
          if (params.length > 8) html += `<em>… et ${params.length - 8} autres</em>`;
          return html;
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
        data: roundNumbers.map(r => `R${r}`),
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
    // Bump chart (rank évolution)
    const nAthletes = PARTICIPANTS.length;
    const series = Object.entries(byAthlete).map(([id, info]) => ({
      name: info.name,
      type: 'line',
      data: info.ranks.map(r => r.rank),
      smooth: true,
      symbol: 'circle',
      symbolSize: 12,
      lineStyle: {
        width: 3,
        color: getAthleteColor(id),
        type: info.eliminated ? 'dashed' : 'solid'
      },
      itemStyle: { color: getAthleteColor(id) },
      emphasis: { focus: 'series', lineStyle: { width: 5 } },
      label: {
        show: true,
        position: 'right',
        formatter: params => params.dataIndex === info.ranks.length - 1 ? info.name : '',
        color: getAthleteColor(id),
        fontSize: 11,
        fontWeight: 600
      }
    }));

    pointsChart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(10,10,15,0.95)',
        borderColor: 'rgba(255,255,255,0.08)',
        textStyle: { color: '#fff', fontFamily: "'Inter',sans-serif" },
        formatter: params => {
          params.sort((a, b) => a.value - b.value);
          const round = params[0].axisValue;
          let html = `<strong>${round}</strong><br/>`;
          for (const p of params.slice(0, 8)) {
            html += `${p.marker}${p.seriesName} : ${p.value}<sup>${p.value === 1 ? 'er' : 'e'}</sup><br/>`;
          }
          return html;
        }
      },
      legend: { show: false },
      grid: { left: 60, right: 150, top: 30, bottom: 40 },
      xAxis: {
        type: 'category',
        data: roundNumbers.map(r => `R${r}`),
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
// TABLE DÉTAILLÉE + ACHIEVEMENTS
// ============================================

function computeAthleteStats(data) {
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
        activities_without_elevation: 0,
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

    if (!s.best_activity || (a.total_elevation_gain || 0) > s.best_activity.elevation) {
      s.best_activity = {
        id: a.id,
        elevation: a.total_elevation_gain || 0,
        date: a.start_date,
        name: a.name || 'Activité'
      };
    }

    if (!a.total_elevation_gain || a.total_elevation_gain === 0) s.activities_without_elevation++;

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

  return [...stats.values()].map(s => {
    const best24h = Object.entries(s.elevation_by_day).reduce(
      (acc, [day, el]) => el > acc.elevation ? { day, elevation: el } : acc,
      { day: null, elevation: 0 }
    );
    return {
      ...s,
      elevation_per_distance: s.total_distance > 0 ? (s.total_elevation / (s.total_distance / 1000)).toFixed(1) : 0,
      elevation_per_time: s.total_time > 0 ? (s.total_elevation / (s.total_time / 3600)).toFixed(1) : 0,
      elevation_per_activity: s.activity_count > 0 ? (s.total_elevation / s.activity_count).toFixed(0) : 0,
      best_elevation: s.best_activity ? s.best_activity.elevation : 0,
      best_24h_elevation: best24h.elevation,
      best_24h_day: best24h.day,
      num_sports: s.sports_used.size
    };
  });
}

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
      return `<tr>
        <td style="color:${getAthleteColor(s.athlete_id)}">${getAthleteName(s.athlete_id)}</td>
        <td>${Math.round(s.total_elevation).toLocaleString('fr-FR')}</td>
        <td>${s.activity_count}</td>
        <td>${(s.total_distance / 1000).toFixed(0)}</td>
        <td>${Math.round(s.total_time / 3600)}</td>
        <td>${s.elevation_per_distance}</td>
        <td>${s.elevation_per_time}</td>
        <td>${s.elevation_per_activity}</td>
        <td data-sort-value="${s.best_elevation}">
          ${s.best_activity ? `
            <a href="${stravaLink}" target="_blank" rel="noopener" class="record-link" title="${s.best_activity.name}">
              <span class="record-elevation">↑ ${formatElevation(s.best_activity.elevation)} m</span>
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

  const achievements = [
    { id: 'king', emoji: '👑', name: 'Roi du D+', desc: 'Le plus de dénivelé total', type: 'legendary',
      getValue: s => s.total_elevation, format: v => `${formatElevation(v)} m` },
    { id: 'best24h', emoji: '🔥', name: 'Journée de Feu', desc: 'Le plus gros D+ en 24h', type: 'legendary',
      getValue: s => s.best_24h_elevation, format: v => `${formatElevation(v)} m` },
    { id: 'polyvalent', emoji: '🎯', name: 'Polyvalent', desc: 'Le plus de sports différents', type: 'normal',
      getValue: s => s.num_sports, format: v => `${v} sports` },
    { id: 'efficient', emoji: '⚡', name: 'Efficace', desc: 'Le plus de D+ par sortie', type: 'normal',
      getValue: s => parseFloat(s.elevation_per_activity), format: v => `${formatElevation(v)} m/sortie` },
    { id: 'steep', emoji: '🧗', name: 'Accro à la Pente', desc: 'Le plus de D+ par km', type: 'normal',
      getValue: s => parseFloat(s.elevation_per_distance), format: v => `${v} m/km` },
    { id: 'nightowl', emoji: '🦉', name: 'Oiseau de Nuit', desc: 'Activités après 20h', type: 'fun',
      getValue: s => s.night_activities, format: v => `${v} sorties` },
    { id: 'earlybird', emoji: '🐓', name: 'Lève-tôt', desc: 'Activités 4h-7h', type: 'normal',
      getValue: s => s.morning_activities, format: v => `${v} sorties` },
    { id: 'weekend', emoji: '🏖️', name: 'Weekend Warrior', desc: 'Activités le weekend', type: 'fun',
      getValue: s => s.weekend_activities, format: v => `${v} sorties` },
    { id: 'distance', emoji: '🛣️', name: 'Forrest Gump', desc: 'La plus grande distance', type: 'normal',
      getValue: s => s.total_distance, format: v => `${(v/1000).toFixed(0)} km` },
    { id: 'marathoner', emoji: '⏱️', name: 'Marathonien', desc: 'Plus longue activité', type: 'normal',
      getValue: s => s.longest_activity_time, format: v => `${(v/3600).toFixed(1)} h` },
    { id: 'flat', emoji: '🤷', name: 'A pas compris', desc: "Activités sans D+", type: 'fun',
      getValue: s => s.activities_without_elevation, format: v => `${v} activités` },
    { id: 'cyclist', emoji: '🚴', name: 'Roi de la Pédale', desc: 'Le plus de D+ à vélo', type: 'normal',
      getValue: s => s.elevation_by_sport['Bike'] || 0, format: v => `${formatElevation(v)} m` },
    { id: 'runner', emoji: '🏃', name: 'Crapahute', desc: 'Le plus de D+ en trail/run', type: 'normal',
      getValue: s => s.elevation_by_sport['Run'] || 0, format: v => `${formatElevation(v)} m` },
    { id: 'skier', emoji: '⛷️', name: 'Collant Pipette', desc: 'Le plus de D+ en ski', type: 'normal',
      getValue: s => s.elevation_by_sport['Ski'] || 0, format: v => `${formatElevation(v)} m` },
    { id: 'hiker', emoji: '🥾', name: 'Randonneur', desc: 'Le plus de D+ en rando', type: 'normal',
      getValue: s => s.elevation_by_sport['Hike'] || 0, format: v => `${formatElevation(v)} m` }
  ];

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

  const cards = [];
  achievements.forEach((ach, aIdx) => {
    const valid = stats.filter(s => ach.getValue(s) > 0);
    if (valid.length === 0) return;
    const sorted = [...valid].sort((a, b) => ach.getValue(b) - ach.getValue(a));
    const winner = sorted[0];
    const top3 = sorted.slice(0, 3);

    cards.push(`
      <div class="achievement-card" data-idx="${aIdx}">
        <div class="achievement-badge ${ach.type}">${ach.emoji}</div>
        <div class="achievement-info">
          <div class="achievement-name">${ach.name}</div>
          <div class="achievement-desc">${ach.desc}</div>
          <div class="achievement-winner">
            <div class="achievement-winner-color" style="background:${getAthleteColor(winner.athlete_id)}"></div>
            <span class="achievement-winner-name">${getAthleteName(winner.athlete_id)}</span>
            <span class="achievement-winner-value">${ach.format(ach.getValue(winner))}</span>
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
    const valid = stats.filter(s => ach.getValue(s) > 0);
    const sorted = [...valid].sort((a, b) => ach.getValue(b) - ach.getValue(a)).slice(0, 3);

    card.addEventListener('mouseenter', () => {
      let html = `<div style="font-weight:600;margin-bottom:10px;font-size:13px">${ach.emoji} ${ach.name}</div>`;
      sorted.forEach((s, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
        html += `
          <div style="display:flex;align-items:center;gap:8px;margin:6px 0">
            <span>${medal}</span>
            <span style="width:10px;height:10px;border-radius:50%;background:${getAthleteColor(s.athlete_id)};flex-shrink:0"></span>
            <span style="color:rgba(255,255,255,0.9)">${getAthleteName(s.athlete_id)}</span>
            <span style="color:rgba(255,255,255,0.5);margin-left:auto">${ach.format(ach.getValue(s))}</span>
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

  // Si tableau détaillé visible, le re-rendre
  if (rankingVisible) {
    const stats = computeAthleteStats(filtered);
    renderRankingTable(stats);
    renderAchievements(stats);
  }
}

function toggleRankingSection() {
  rankingVisible = !rankingVisible;
  const section = document.getElementById('rankingStatsSection');
  const btn = document.getElementById('btnToggleRanking');
  if (!section) return;

  section.style.display = rankingVisible ? 'block' : 'none';
  btn.classList.toggle('active', rankingVisible);

  if (rankingVisible) {
    const filtered = getFilteredData();
    const stats = computeAthleteStats(filtered);
    renderRankingTable(stats);
    renderAchievements(stats);
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
    console.log(`✅ ${allActivities.length} activités après filtrage (>= ${CHALLENGE_CONFIG.yearStartDate})`);

    if (allActivities.length === 0) {
      document.body.innerHTML = `
        <div class="stats-error">
          <div class="stats-error-icon">📭</div>
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

          // Sorties de groupe : le PLUS LOURD → on le fait via requestIdleCallback si dispo
          const ric = window.requestIdleCallback || function(cb) { return setTimeout(cb, 100); };
          ric(() => {
            const t0 = performance.now();
            detectedGroups = detectGroupActivities(allActivities);
            const elapsed = performance.now() - t0;
            console.log(`🔍 ${detectedGroups.length} sorties en groupe détectées en ${elapsed.toFixed(0)}ms`);
            renderSocialGraph(detectedGroups);
          });
        });
      });
    });

    // Resize handler global
    window.addEventListener('resize', () => {
      [sportPieChart, sankeyChart, calendarChart, ridgelineChart, pointsChart].forEach(c => {
        if (c) c.resize();
      });
      if (window.roundRidgeChart) window.roundRidgeChart.resize();
    });

  } catch (err) {
    console.error('❌ Erreur init:', err);
    document.body.innerHTML = `
      <div class="stats-error">
        <div class="stats-error-icon">⚠️</div>
        <div class="stats-error-title">Erreur de chargement</div>
        <div class="stats-error-text">${err.message || 'Impossible de charger les données.'}</div>
        <button class="stats-error-retry" onclick="location.reload()">Réessayer</button>
      </div>`;
  }
}

init();
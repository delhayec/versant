/**
 * ============================================
 * VERSANT - HARNAIS : FORME CANONIQUE
 * ============================================
 * Sérialisation stable : clés d'objets triées, ORDRE DES TABLEAUX CONSERVÉ
 * (il est porteur de sens : positions, ordre des activités, égalités).
 *
 * Les valeurs que JSON écrase sont rendues visibles : NaN, Infinity et
 * « Invalid Date » deviennent des chaînes, pour qu'un NaN ne se confonde pas
 * avec un null.
 */

export function canonicalize(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '__InvalidDate__' : value.toISOString();
  }
  if (value instanceof Set) return [...value].map(canonicalize);
  if (value instanceof Map) return canonicalize(Object.fromEntries(value));

  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? value : `__${String(value)}__`;
    case 'bigint':
      return `${value}n`;
    case 'object': {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        const v = value[key];
        if (v === undefined || typeof v === 'function') continue;
        out[key] = canonicalize(v);
      }
      return out;
    }
    default:
      return value;
  }
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value), null, 2) + '\n';
}

/**
 * Allège un résultat sans perdre d'information utile à la comparaison :
 * les tableaux d'activités complètes (ex. `activities` d'une entrée de
 * calculateRanking) sont remplacés par la liste ordonnée de leurs ids.
 */
export function slim(value) {
  if (Array.isArray(value)) return value.map(slim);
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'activities' && Array.isArray(v) && v.every(isActivityLike)) {
      out.activityIds = v.map(a => a.id);
    } else {
      out[key] = slim(v);
    }
  }
  return out;
}

function isActivityLike(a) {
  return a && typeof a === 'object' && 'start_date' in a && 'id' in a;
}

/**
 * Pictos dessinés des jokers et bonus (DA « Atelier »). Présentation seule.
 *
 * L'émoji d'origine reste dans la page : la DA le masque et affiche le dessin
 * (css/da/components.css, section PICTOS) ; sans la DA (?da=off), on voit l'émoji comme avant.
 * Ne renvoie du HTML : à n'utiliser ni dans un attribut title, ni dans une
 * notification en texte brut.
 */
const DRAWN = new Set([
  'bouclier', 'multiplicateur', 'voleur', 'sabotage',
  'embuscade', 'ravitaillement', 'brouillard', 'marquage', 'trap', 'second_souffle', 'kamikaze', 'malediction', 'duel',
  // repères génériques : cible, cadeau (bonus), baguette (jokers)
  'cible', 'cadeau', 'jokers', 'couronne',
  // jeu : médailles, évolution, récap, validé / refusé, challenge des éliminés
  'medaille', 'hausse', 'baisse', 'stable', 'recap', 'valide', 'refuse', 'elimines',
  // succès de la page Stats (Roi de la Pédale n'a pas de dessin)
  ...['king', 'points_king', 'elim_prince', 'champion', 'ricrac', 'untouchable', 'finalist',
    'jokers', 'target', 'best24h', 'bestRound', 'biggestAct', 'efficient', 'lost', 'steep', 'worker',
    'nightowl', 'earlybird', 'weekend', 'distance', 'marathoner', 'flat', 'runner', 'skier', 'hiker'].map(id => 'succes-' + id),
  // animaux des équipes, panda et chenille pour les anciennes saisons
  ...['loup', 'renard', 'lynx', 'ours', 'sanglier', 'mammouth', 'marmotte', 'loutre', 'raton', 'ecureuil', 'lapin', 'chouette', 'bouquetin', 'chamois', 'aigle', 'mouflon', 'cerf', 'corbeau', 'panda', 'chenille'].map(id => 'animal-' + id),
]);

/** Picto d'un joker ou bonus par son identifiant (ex. 'bouclier'), avec son émoji de repli. */
export function picto(id, emoji = '', label = '') {
  if (!DRAWN.has(id)) return emoji;
  const a11y = label ? ` role="img" aria-label="${label}"` : '';
  return `<span class="picto picto--${id}"${a11y}><span class="picto__emoji" aria-hidden="true">${emoji}</span></span>`;
}

/** Dessin de l'animal d'une équipe, ou son émoji si l'animal n'a pas de dessin (canard des anciennes saisons). */
export function animalIcon(animal) {
  if (!animal) return '';
  return DRAWN.has('animal-' + animal.id) ? picto('animal-' + animal.id, animal.emoji || '') : (animal.emoji || '');
}

/** Médaille du rang 1, 2 ou 3 (rosette dessinée, rang écrit dessus) ; '' au-delà. */
export function medal(rank) {
  const emoji = ['🥇', '🥈', '🥉'][rank - 1];
  if (!emoji) return '';
  return `<span class="da-medal" data-n="${rank}">${picto('medaille', emoji, `${rank}${rank === 1 ? 'er' : 'e'}`)}</span>`;
}

/** Picto d'une définition JOKER_TYPES / BONUS_TYPES ({ id, icon, name }). */
export function pictoOf(def, fallback = '') {
  return def ? picto(def.id, def.icon || fallback, def.name) : fallback;
}

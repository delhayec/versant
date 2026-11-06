/**
 * Motif et couleur de crayon de chaque joueur (DA « Atelier »). Présentation seule.
 *
 * Le rang du joueur dans PARTICIPANTS donne un motif (16) et une couleur (6) :
 * toujours les mêmes pour lui, d'une page à l'autre, et deux joueurs ne
 * partagent la même paire qu'au-delà de 48 inscrits. Les motifs sont dessinés
 * dans css/da/components.css (section MOTIFS) ; sans la DA, rien ne change.
 */
import { PARTICIPANTS } from './config.js';

const MOTIF_COUNT = 16;
const COLOR_COUNT = 6;

/** Classes à ajouter à une pastille d'athlète (vide si l'athlète est inconnu). */
export function motifClass(athleteId) {
  const i = PARTICIPANTS.findIndex(p => String(p.id) === String(athleteId));
  if (i < 0) return '';
  return `da-motif da-motif--${i % MOTIF_COUNT} da-crayon--${i % COLOR_COUNT}`;
}

/**
 * Les mêmes motifs, pour les graphiques de la page Stats : tracés d'une tuile
 * de 24 × 24 (identiques à components.css). d = traits, dots = points pleins.
 */
export const MOTIF_SHAPES = [
  { d: 'M-2 8 L8 -2 M-2 20 L20 -2 M4 26 L26 4 M16 26 L26 16' },                                         // hachures
  { d: 'M-2 8 L8 -2 M-2 20 L20 -2 M4 26 L26 4 M16 26 L26 16 M-2 16 L8 26 M-2 4 L20 26 M4 -2 L26 20 M16 -2 L26 8' }, // contre-hachures
  { d: 'M-1 7 Q5 2 12 7 T25 7 M-1 19 Q5 14 12 19 T25 19' },                                             // vagues
  { d: 'M-1 9 L5 3 L11 9 L17 3 L23 9 M-1 21 L5 15 L11 21 L17 15 L23 21' },                              // zigzag
  { dots: [[6, 6, 1.8], [18, 18, 1.8], [17, 5, 1.2], [6, 17, 1.2]] },                                    // points
  { d: 'M5 1 L5.6 23 M12 2 L11.6 22 M19 1 L19.4 23' },                                                   // traits verticaux
  { d: 'M0 6 L24 6.6 M0 18 L24 17.4 M6 0 L6.6 24 M18 0 L17.4 24' },                                      // quadrillage
  { d: 'M18.5 12 A6.5 6.5 0 1 1 5.5 12 A6.5 6.5 0 1 1 18.5 12', dots: [[12, 12, 1.6]] },                 // cercles
  { d: 'M4 4 H11 V11 H4 Z M14 14 H20 V20 H14 Z' },                                                       // petits carrés
  { d: 'M3 5 L7 3 M15 4 L17 8 M5 15 L4 19 M14 16 L19 18 M20 11 L22 9 M9 10 L11 12' },                   // tirets épars
  { d: 'M-1 12 C3 4 9 4 7 10 C5 16 12 16 13 10 C14 4 21 5 25 12' },                                     // boucles
  { d: 'M12 12 m-1 0 a1.5 1.5 0 1 1 3 0 a3.5 3.5 0 1 1 -6 -1 a6 6 0 1 1 9 6' },                          // spirales
  { d: 'M6 3 L6 9 M3 6 L9 6 M18 15 L18 21 M15 18 L21 18' },                                              // croix
  { d: 'M2 9 L8 4 L14 9 M10 20 L16 15 L22 20' },                                                         // chevrons
  { d: 'M2 14 C4 4 9 20 11 9 C13 0 16 22 19 10 C21 3 23 13 22 16' },                                    // gribouillis
  { d: 'M-2 10 L10 -2 M-2 26 L26 -2 M14 26 L26 14', w: 4.5 },                                           // rayures épaisses
];
/** Variables CSS des 6 crayons (même ordre que .da-crayon--N). */
export const CRAYONS = ['--crayon-0', '--crayon-1', '--crayon-2', '--crayon-3', '--crayon-4', '--crayon-5'];

/** Motif et crayon d'un joueur : { motif, crayon } (null si inconnu). */
export function motifOf(athleteId) {
  const i = PARTICIPANTS.findIndex(p => String(p.id) === String(athleteId));
  return i < 0 ? null : { motif: i % MOTIF_COUNT, crayon: i % COLOR_COUNT };
}

import * as H from './da-hand.js';

/**
 * DA : note manuscrite sur ta place dans le round, d'après les versions
 * dessinées dans design/editeur-manic.html. Une version par jour quand
 * plusieurs conviennent. wasRank : ta place à minuit (null le 1er jour).
 */
export function roundSituationNote(round, myIdx, cut, wasRank, date = new Date()) {
  const e = round[myIdx];
  const rankNow = myIdx + 1;
  const moved = wasRank && wasRank !== rankNow;
  // place de la veille rayée, nouvelle place à côté
  const rk = (alts = [], eAlt = '') => moved ? `${H.strike(H.rank(wasRank))} ${H.rank(rankNow, alts, eAlt)}` : H.rank(rankNow, alts, eAlt);

  if (e.isProtected) return `à l'abri derrière ton ${H.under('bouclier', 'trait-T', 'sub', true)}`;

  if (myIdx === 0 && round.length > 1) {
    const lead = e.totalElevation - round[1].totalElevation;
    if (moved) return `${H.strike(H.rankWord(wasRank))} ${H.accent('PREMIER')}`;
    if (lead < 150) return `${H.hv('Premier', { 0: 'A3', 1: '1' })} ! ${H.muted(H.small('(pour le moment)'))}`;
    if (wasRank === 1 && lead >= 1000) return H.circle(H.hv('MACHINE'), 'circle-06');
    if (lead >= 400) return `${H.small('SOLIDE')} ${H.under(H.hv('Premier', { 0: '', 1: '1', 2: '1', 6: '2' }), 'emphasis-02')}`;
    return `${H.hv('Tu', { 0: '1' })} mènes le ${H.under(`${H.hv('ROUND', { 0: 'A3', 2: '1', 3: '2', 4: '2' })} ${H.hv('!', { 0: '1' })}`, 'trait-S', '', true)}`;
  }

  // pas de coupe à ce round (sans élimination) : ta place, ou la blague du ventre mou
  if (cut <= 0) {
    const n = round.length;
    const versions = [
      () => `${rk(['1'], 'A3')} du Round`,
      () => H.under(`${rk(['2'])} du r${H.hv('o', { 0: '2' })}und`, 'line-02', '', true),
    ];
    // ventre mou : ni dans le premier ni dans le dernier quart
    if (!moved && n >= 8 && rankNow > n / 4 && rankNow <= (3 * n) / 4) {
      versions.push(() => `exactement entre ${H.rank(rankNow - 1)} et ${H.rank(rankNow + 1)}`);
      versions.push(() => `${H.mathJoke(rankNow, rankNow)} ${H.muted(H.small('(fais le calcul)'))}`);
    }
    return H.dailyPick(versions, 'rang', date)();
  }

  if (e.isInDangerZone) {
    const gap = round[cut - 1].totalElevation - e.totalElevation;
    return H.dailyPick([
      () => `${rk()} : il te manque ${H.circle(H.meters(gap))} pour passer le round`,
      () => `${rk(['2'])} : il te manque ${H.under(H.meters(gap, ['1'], 'A3', 1.3), 'emphasis-02')} pour passer le round`,
      () => `${rk(['2'])} : il te manque ${H.under(H.meters(gap, ['1'], 'A3', 1.3), 'emphasis-02')} pour passer la coupe`,
    ], 'sous-coupe', date)();
  }
  const ahead = e.totalElevation - round[cut].totalElevation;
  return H.dailyPick([
    () => `${rk()} : ${H.meters(ahead, ['A1', '3', 'A3'])} d'avance sur la coupe`,
    () => `${rk()} : ${H.meters(ahead, ['A1', 'A1', ''])} d'av${H.hv('a', { 0: '1' })}nce sur la ${H.under(H.hv('coupe', { 1: '3', 3: '1', 4: '1' }), 'line-01', '', true)}`,
  ], 'sur-coupe', date)();
}

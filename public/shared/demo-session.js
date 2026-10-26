/**
 * ============================================
 * VERSANT - DÉMO STATIQUE (L52)
 * ============================================
 * Chargé en premier par demo.html (script classique, dans <head>).
 *
 * La démo rejoue les activités de 2025 (/data/all_activities_2025.json) avec
 * le curseur de date. Elle ne doit rien lire des ligues en cours : depuis D4
 * (tout privé), leurs routes exigent une session, et leurs résultats figés
 * se mélangeaient aux activités de 2025. Chaque appel à /api/… reçoit donc
 * ici une réponse vide fixe : aucun round figé, aucun joker ni bonus, aucune
 * configuration de round. Le moteur calcule tout à partir des activités,
 * comme le faisait la démo d'origine. Le code des pages ne change pas.
 */
(function (window) {
  'use strict';

  // [route, réponse] : la première dont l'expression correspond
  const STATIC_RESPONSES = [
    [/^\/api\/frozen-results(\/.*)?$/, { rounds: {} }],
    [/^\/api\/round-configs$/, {}],
    [/^\/api\/special-rules$/, {}],
    [/^\/api\/season-planning$/, {}],
    [/^\/api\/bonuses\/(all|active)$/, []],
    [/^\/api\/jokers\/(all|round\/[^/]+)$/, []],
    [/^\/api\/activities-status\/.+$/, null],
    [/^\/api\/teams\/round\/[^/]+$/, null]
  ];

  const realFetch = window.fetch.bind(window);
  const json = (body, status = 200) => new window.Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

  window.fetch = function (input, init) {
    if (typeof input !== 'string' && !(input instanceof window.URL)) return realFetch(input, init);
    const url = new window.URL(String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const match = STATIC_RESPONSES.find(([pattern]) => pattern.test(url.pathname));
    // Rien d'autre n'est servi à la démo : réponse 404, sans appel au serveur
    if (!match || match[1] === null) return Promise.resolve(json({ error: 'Indisponible en démo' }, 404));
    return Promise.resolve(json(match[1]));
  };
})(window);

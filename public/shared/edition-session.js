/**
 * ============================================
 * VERSANT - SESSION ET ÉDITION AFFICHÉE (L50)
 * ============================================
 * Chargé en premier (script classique, dans <head>) par les pages joueurs :
 * index, stats, dashboard, rules.
 *
 * - Connexion obligatoire (D4) : sans session valide, retour à login.html,
 *   qui ramène ensuite sur la page demandée (?next=).
 * - Édition affichée : ?ligue=…&edition=… dans l'adresse, sinon celle du
 *   joueur (/api/me).
 * - Chaque appel du front à une route historique (/api/frozen-results,
 *   /api/athletes/versant-2026…) part vers la route de l'édition
 *   (/api/leagues/:ligue/editions/:édition/…), avec la session du joueur.
 *   Le code des pages et du moteur ne change pas : c'est le pendant, côté
 *   navigateur, du fetch du moteur serveur (backend/engine-worker.mjs).
 *
 * La table ci-dessous est la copie de READ_ROUTES et PLAYER_ROUTES
 * (backend/routes/editions.js) ; le harnais vérifie qu'elles sont identiques.
 * Requis côté Node (harnais) via require : on n'y exporte que la table et la
 * traduction des adresses.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;              // harnais (CommonJS)
  } else {
    api.install(root);                 // navigateur
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [chemin sous l'édition, route historique] ; {id} = identifiant de
  // l'édition dans les routes historiques, {n} = paramètre :n
  const EDITION_ROUTES = [
    ['/config', '/api/config'],
    ['/participants', '/api/athletes/{id}'],
    ['/activities', '/api/activities/{id}'],
    ['/activities-status', '/api/activities-status/{id}'],
    ['/weather-coverage', '/api/weather-coverage/{id}'],
    ['/frozen-results', '/api/frozen-results'],
    ['/frozen-results/round/:n', '/api/frozen-results/round/{n}'],
    ['/frozen-results/check/:n', '/api/frozen-results/check/{n}'],
    ['/round-configs', '/api/round-configs'],
    ['/special-rules', '/api/special-rules'],
    ['/season-planning', '/api/season-planning'],
    ['/season-bonuses/:n', '/api/season-bonuses/{n}'],
    ['/teams/round/:n', '/api/teams/round/{n}'],
    ['/jokers', '/api/jokers/all'],
    ['/jokers/round/:n', '/api/jokers/round/{n}'],
    ['/bonuses', '/api/bonuses/all'],
    ['/bonuses/active', '/api/bonuses/active'],
    // Routes du joueur (sa session)
    ['/jokers/my', '/api/jokers/my'],
    ['/jokers/use', '/api/jokers/use'],
    ['/bonuses/my', '/api/bonuses/my'],
    ['/bonuses/choices', '/api/bonuses/choices'],
    ['/bonuses/assign', '/api/bonuses/assign'],
    ['/bonuses/use', '/api/bonuses/use']
  ];

  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Route historique → expression ; {id} peut contenir « / » (« ligue/édition »)
  const COMPILED = EDITION_ROUTES.map(([route, legacy]) => {
    const names = [];
    const source = legacy.split(/(\{\w+\})/).map(part => {
      const m = part.match(/^\{(\w+)\}$/);
      if (!m) return escape(part);
      names.push(m[1]);
      return m[1] === 'id' ? '(.+)' : '([^/]+)';
    }).join('');
    return { route, names, regex: new RegExp(`^${source}$`) };
  });

  /**
   * Adresse de l'édition pour une route historique (chemin + requête),
   * ou null si la route n'a pas d'équivalent par édition.
   */
  function toEditionUrl(url, edition) {
    const cut = url.indexOf('?');
    const pathname = cut === -1 ? url : url.slice(0, cut);
    const query = cut === -1 ? '' : url.slice(cut);
    for (const { route, names, regex } of COMPILED) {
      const m = pathname.match(regex);
      if (!m) continue;
      const values = {};
      names.forEach((name, i) => { values[name] = m[i + 1]; });
      const sub = route.replace(/:(\w+)/g, (_, name) => values[name]);
      return `/api/leagues/${encodeURIComponent(edition.leagueId)}/editions/${encodeURIComponent(edition.editionId)}${sub}${query}`;
    }
    return null;
  }

  /** Navigateur : session obligatoire, choix de l'édition, fetch redirigé. */
  function install(window) {
    const { document, location, localStorage } = window;
    const script = document.currentScript;
    // data-auth="optional" (rules.html) : la page reste lisible sans connexion
    const optional = script?.dataset?.auth === 'optional';
    const params = new URLSearchParams(location.search);
    const token = localStorage.getItem('versant_token');
    const realFetch = window.fetch.bind(window);
    const never = new Promise(() => {});
    let redirecting = false;
    let blocked = false;

    function goLogin() {
      if (redirecting) return;
      redirecting = true;
      localStorage.removeItem('versant_token');
      localStorage.removeItem('versant_athlete_id');
      const next = location.pathname.replace(/^.*\//, '') + location.search;
      location.replace(`login.html?next=${encodeURIComponent(next || 'index.html')}`);
    }

    /**
     * Remplace la page par un message (aucune donnée affichable) ;
     * withJoinForm : formulaire du code d'invitation (compte sans ligue, L51).
     */
    function block(message, withJoinForm = false, withAdminLink = false, withHomeLink = false) {
      if (blocked) return;
      blocked = true;
      const show = () => {
        const box = document.createElement('div');
        box.id = 'editionBlocked';
        box.setAttribute('style', 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;text-align:center');
        box.innerHTML = '<div style="max-width:460px;width:100%"><p style="font-size:1.1rem;line-height:1.5;margin:0 0 20px"></p>'
          // Admin d'une ligue en préparation (L59) : il la règle depuis l'admin
          + (withAdminLink
            ? '<p style="margin:0 0 20px"><a id="editionAdminLink" href="admin.html" style="display:inline-block;padding:12px 20px;border-radius:8px;background:linear-gradient(135deg,#f97316,#f43f5e);color:#fff;font-weight:600;text-decoration:none">Régler ma ligue</a></p>'
            : '')
          // Adresse vers une autre ligue ou une édition inconnue : retour à la sienne
          + (withHomeLink
            ? '<p style="margin:0 0 20px"><a id="editionHomeLink" href="' + location.pathname.replace(/^.*\//, '') + '" style="display:inline-block;padding:12px 20px;border-radius:8px;background:linear-gradient(135deg,#f97316,#f43f5e);color:#fff;font-weight:600;text-decoration:none">Revenir à ma ligue</a></p>'
            : '')
          + (withJoinForm
            ? '<form id="joinLeagueForm" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:0 0 12px">'
              + '<input id="joinLeagueCode" autocomplete="off" autocapitalize="characters" placeholder="ABCD-EFGH" aria-label="Code d’invitation" required '
              + 'style="flex:1 1 160px;min-width:0;padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.3);color:inherit;font-size:1rem;letter-spacing:.1em;text-align:center">'
              + '<button type="submit" style="padding:12px 20px;border:0;border-radius:8px;background:linear-gradient(135deg,#f97316,#f43f5e);color:#fff;font-weight:600;font-size:1rem;cursor:pointer">Rejoindre</button>'
              + '</form><p id="joinLeagueError" role="alert" style="color:#f87171;min-height:1.5em;margin:0 0 12px"></p>'
            : '')
          + '<a href="login.html" style="color:#f97316">Se connecter avec un autre compte</a></div>';
        box.querySelector('p').textContent = message;
        box.querySelector('a[href="login.html"]').addEventListener('click', () => {
          localStorage.removeItem('versant_token');
          localStorage.removeItem('versant_athlete_id');
        });
        if (withJoinForm) setupJoinForm(box);
        document.body.appendChild(box);
      };
      if (document.body) show();
      else document.addEventListener('DOMContentLoaded', show);
    }

    /** Code d'invitation (prérempli par ?invitation=) : adhésion, puis la page se recharge. */
    function setupJoinForm(box) {
      const form = box.querySelector('#joinLeagueForm');
      const input = box.querySelector('#joinLeagueCode');
      const error = box.querySelector('#joinLeagueError');
      if (params.get('invitation')) input.value = params.get('invitation');
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('button');
        button.disabled = true;
        error.textContent = '';
        try {
          const res = await realFetch('/api/leagues/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ code: input.value })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
          const clean = new URLSearchParams(location.search);
          clean.delete('invitation');
          location.replace(location.pathname + (clean.toString() ? `?${clean}` : ''));
        } catch (e) {
          error.textContent = e.message;
          button.disabled = false;
        }
      });
    }

    function chooseEdition(me) {
      const league = params.get('ligue');
      const edition = params.get('edition');
      if (league && edition) return { leagueId: league, editionId: edition };
      if (league && me.edition?.leagueId !== league) {
        block("Précise l'édition à afficher dans l'adresse (&edition=…).");
        return never;
      }
      if (me.edition) return { leagueId: me.edition.leagueId, editionId: me.edition.editionId };
      if (optional) return null;
      // Ligue en préparation (L59) : inscrit, en attente de la première édition
      if (me.waiting && me.league) {
        const admin = (me.adminLeagues || []).some(l => l.id === me.league.id);
        block(admin
          ? `Tu es admin de la ligue ${me.league.name}. Choisis ses dates et lance sa première édition : les joueurs déjà inscrits y entreront automatiquement.`
          : `Tu as bien rejoint la ligue ${me.league.name}. Elle démarrera quand son admin aura fixé la date de début : tu y seras inscrit automatiquement.`, false, admin);
        return never;
      }
      block("Tu ne fais partie d'aucune ligue pour l'instant. Entre le code d'invitation que t'a donné l'admin de la ligue.", true);
      return never;
    }

    let ready;
    if (!token) {
      if (optional) ready = Promise.resolve(null);
      else { goLogin(); ready = never; }
    } else {
      ready = realFetch('/api/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        .then(async res => {
          if (res.status === 401 || res.status === 404) {
            if (optional) return null;
            goLogin();
            return never;
          }
          if (!res.ok) throw new Error(`/api/me : ${res.status}`);
          return chooseEdition(await res.json());
        })
        .catch(error => {
          console.error('Session :', error);
          if (optional) return null;
          block('Serveur injoignable. Réessaie dans un instant.');
          return never;
        });
    }

    window.fetch = async function (input, init) {
      if (typeof input !== 'string' && !(input instanceof window.URL)) return realFetch(input, init);
      const url = new window.URL(String(input), location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);

      const edition = await ready;
      const headers = new window.Headers(init?.headers || {});
      if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      const target = (edition && toEditionUrl(url.pathname + url.search, edition)) || url.pathname + url.search;
      const res = await realFetch(target, { ...(init || {}), headers });
      if (edition && res.status === 401 && !optional) goLogin();
      // Édition choisie dans l'adresse dont le joueur ne fait pas partie, ou qui
      // n'existe pas : un message plutôt qu'une page vide
      const fromAddress = !!params.get('ligue');
      if (edition && res.status === 403) block("Tu ne participes pas à cette édition.", false, false, fromAddress);
      if (edition && res.status === 404 && target !== url.pathname + url.search) {
        const body = await res.clone().json().catch(() => ({}));
        if (body.error === 'Édition introuvable') block("Cette ligue ou cette édition n'existe pas.", false, false, fromAddress);
      }
      return res;
    };

    // Édition choisie dans l'adresse : les liens entre pages la conservent
    if (params.get('ligue')) {
      document.addEventListener('DOMContentLoaded', () => {
        const keep = new URLSearchParams();
        for (const key of ['ligue', 'edition']) if (params.get(key)) keep.set(key, params.get(key));
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href');
          if (/^(index|stats|dashboard|rules)\.html(#.*)?$/.test(href)) {
            const [page, hash] = href.split('#');
            a.setAttribute('href', `${page}?${keep}${hash ? `#${hash}` : ''}`);
          }
        }
      });
    }

    window.VersantEdition = { ready, toEditionUrl };
  }

  return { EDITION_ROUTES, toEditionUrl, install };
});

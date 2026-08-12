#!/usr/bin/env node
/**
 * check-rendu.js : audit de rendu des pages générées (géométrie et accessibilité).
 * ------------------------------------------------------------------------------
 * Runtime     : Node.js >= 22 (WebSocket natif)
 * Dépendances : AUCUNE (http, child_process, fs, path natifs + un Chrome/Edge
 *               déjà installé sur la machine, piloté via le protocole DevTools)
 * Exécution   : node site/check-rendu.js [options]
 *   --largeurs 375,768,1280   largeurs à tester (défaut : ces trois-là)
 *   --toutes                  auditer les 66 pages et pas les seuls gabarits
 *   --page /outils/           auditer une seule page
 *   --verbeux                 afficher aussi les pages sans problème
 *
 * POURQUOI CE SCRIPT : check-links.js et check-seo.js lisent le HTML, ils ne
 * voient donc jamais un défaut de mise en page. Deux bugs bien visibles à l'œil
 * (champs de formulaire en escalier, légende à cheval sur son cadre) sont passés
 * au travers de ces deux contrôles. Celui-ci mesure la page réellement rendue.
 *
 * CE QU'IL NE FAIT PAS : juger l'esthétique. Un champ mal aligné sous son
 * libellé est géométriquement « correct ». Un coup d'œil humain reste
 * nécessaire, ce script attrape les régressions, pas les maladresses.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const DIST = path.join(__dirname, 'dist');

/* Règle générale de ce fichier : un garde-fou doit se déclencher sur l'INCONNU,
 * pas seulement sur le faux. Une option mal formée qui retombe en silence sur
 * sa valeur par défaut fait auditer autre chose que ce qui a été demandé, et le
 * « OK » final porte alors sur la mauvaise cible. */
const arg = (nom, def) => {
  const i = process.argv.indexOf(nom);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`✗ l'option ${nom} attend une valeur.`);
    process.exit(1);
  }
  return v;
};
const LARGEURS = arg('--largeurs', '375,768,1280').split(',').map(s => Number(s.trim()));
if (!LARGEURS.length || LARGEURS.some(n => !Number.isInteger(n) || n < 200 || n > 3840)) {
  console.error('✗ --largeurs attend des entiers entre 200 et 3840 séparés par des virgules (ex. 375,768,1280).');
  process.exit(1);
}
const VERBEUX = process.argv.includes('--verbeux');
const UNE_PAGE = arg('--page', null);

/* Un gabarit par type de rendu : auditer les 66 pages n'apporterait rien de
 * plus, les pages d'un même gabarit partagent leur mise en page. --toutes pour
 * les balayer quand même (utile après une refonte du CSS). */
const GABARITS = [
  '/', '/etudiant/', '/guides/', '/guides/visale/',
  '/guides/siao-115-hebergement-urgence/', '/guides/plafond-ressources-logement-social/',
  '/guides/encadrement-des-loyers-paris/', '/outils/', '/diagnostic/', '/recherche/',
  '/annuaire/', '/residences-crous/', '/residences-crous/paris-75/',
  '/logement-social/chiffres/', '/logement-social/chiffres/seine-et-marne-77/',
  '/logement-social/delais/', '/mentions-legales/', '/presse/', '/404.html',
  '/en/', '/en/guides/', '/en/guides/visale-guarantee/',
];

/* Pages dont le contenu utile est CONSTRUIT PAR JS et non présent dans le HTML.
 * Il faut vérifier qu'il est bien arrivé : un script qui échoue en silence (un
 * `if (!mount) return` sur un sélecteur renommé, par exemple) laisse une page
 * vide, qui n'a évidemment aucun défaut géométrique à signaler. Le contrôle
 * annoncerait alors « champs alignés, cibles ≥ 24 px » sur une page sans aucun
 * champ ni bouton. Les simulateurs n'y figurent pas : leurs champs sont dans le
 * HTML statique, seul le verdict est injecté. */
const ATTENDUS = {
  '/diagnostic/': { sel: '.diag-opt', min: 2, quoi: 'les options de la première question' },
};

/* ------------------------- Le script d'audit -------------------------
 * Évalué DANS la page. Renvoie la liste des problèmes constatés. */
const AUDIT = `(() => {
  const pbs = [], add = (g, q, d) => pbs.push({ g, q, d });
  const R = el => el.getBoundingClientRect();
  const nom = el => el.tagName.toLowerCase() +
    (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const vw = window.innerWidth;

  /* 1. Scroll horizontal involontaire : le défaut le plus visible sur mobile. */
  if (document.documentElement.scrollWidth > vw + 1) {
    const c = [...document.querySelectorAll('body *')]
      .filter(e => { const r = R(e); return r.width > 0 && r.right > vw + 1 && getComputedStyle(e).position !== 'fixed'; })
      .slice(0, 4).map(nom);
    add('BLOQUANT', 'scroll horizontal', document.documentElement.scrollWidth + ' > ' + vw + ' (suspects : ' + (c.join(', ') || 'non identifiés') + ')');
  }

  /* 2. Élément qui sort de son conteneur. Une marge négative est volontaire
   *    (elle compense un padding pour élargir une zone cliquable) : ignorée. */
  const scrollables = [...document.querySelectorAll('*')].filter(e => /auto|scroll/.test(getComputedStyle(e).overflowX));
  [...document.querySelectorAll('main *')].forEach(e => {
    const r = R(e); if (!r.width || !r.height) return;
    const p = e.parentElement; if (!p || p === document.body) return;
    if (scrollables.some(s => s.contains(e))) return;
    if (getComputedStyle(p).overflow !== 'visible') return;
    const cs = getComputedStyle(e);
    if (parseFloat(cs.marginLeft) < 0 || parseFloat(cs.marginRight) < 0) return;
    const rp = R(p); if (!rp.width) return;
    if (r.right > rp.right + 2 || r.left < rp.left - 2) {
      add('IMPORTANT', 'hors conteneur', nom(e) + ' déborde de ' + nom(p) + ' de ' + Math.round(Math.max(r.right - rp.right, rp.left - r.left)) + ' px');
    }
  });

  /* 3. Cible d'interaction sous 24 px (critère WCAG 2.5.8, niveau AA).
   *    Les liens en ligne dans du texte en sont exemptés par la norme. */
  const petites = [...document.querySelectorAll('a,button,input,select,summary,[role="button"]')].filter(e => {
    const r = R(e); if (!r.width || !r.height) return false;
    if (e.closest('nav.breadcrumb,.site-footer,p,li,td,.maj,.pl-aide,.sources')) return false;
    return r.height < 24 || r.width < 24;
  }).slice(0, 5).map(e => nom(e) + ' ' + Math.round(R(e).width) + '×' + Math.round(R(e).height));
  if (petites.length) add('IMPORTANT', 'cible sous 24 px', petites.join(' · '));

  /* 4. Blocs de premier niveau qui se recouvrent. */
  const blocs = [...document.querySelectorAll('main > section, main > div, main > header, article > section')].filter(e => R(e).height > 0);
  for (let i = 0; i < blocs.length - 1; i++) {
    const a = R(blocs[i]), b = R(blocs[i + 1]);
    if (b.top < a.bottom - 3 && b.left < a.right && a.left < b.right) {
      add('IMPORTANT', 'chevauchement', nom(blocs[i]) + ' et ' + nom(blocs[i + 1]) + ' se recouvrent de ' + Math.round(a.bottom - b.top) + ' px');
    }
  }

  /* 5. Texte coupé par une hauteur fixe. */
  [...document.querySelectorAll('main h1,main h2,main h3,main p,main li,main td')].forEach(e => {
    if (e.scrollHeight > e.clientHeight + 3 && getComputedStyle(e).overflow === 'hidden') {
      add('IMPORTANT', 'texte tronqué', nom(e) + ' : « ' + e.textContent.trim().slice(0, 40) + ' »');
    }
  });

  /* 6. Champs d'une même rangée de formulaire décalés verticalement : c'est le
   *    défaut « en escalier » quand les libellés font un nombre de lignes différent. */
  document.querySelectorAll('.tool-form').forEach(f => {
    const rangs = {};
    [...f.children].forEach(c => {
      const ch = c.querySelector('input,select,textarea'); if (!ch) return;
      const t = Math.round(R(c).top);
      (rangs[t] = rangs[t] || []).push(Math.round(R(ch).top));
    });
    Object.entries(rangs).forEach(([t, tops]) => {
      if (new Set(tops).size > 1) add('IMPORTANT', 'champs désalignés', 'rangée à ' + t + ' px : champs à ' + [...new Set(tops)].join(', '));
    });
  });

  /* 7. Région live sans aria-atomic : un lecteur d'écran n'annoncerait que la
   *    portion modifiée, donc un résultat tronqué. Vécu sur le simulateur. */
  document.querySelectorAll('[aria-live]').forEach(e => {
    if (e.getAttribute('aria-atomic') !== 'true') add('IMPORTANT', 'région live sans aria-atomic', nom(e));
    if (e.hasAttribute('hidden') || getComputedStyle(e).display === 'none') add('IMPORTANT', 'région live masquée', nom(e) + ' (le contenu ne serait pas annoncé)');
  });

  /* 8. Légende de fieldset à cheval sur la bordure de son cadre (rendu natif
   *    du navigateur, disgracieux dès que le cadre a un fond contrasté). */
  document.querySelectorAll('fieldset > legend').forEach(l => {
    const rl = R(l), rf = R(l.parentElement);
    if (rl.top < rf.top + 1) add('IMPORTANT', 'légende à cheval sur le cadre', nom(l.parentElement));
  });

  return { url: location.pathname, vw, pbs, attendus: window.__ATTENDU ? document.querySelectorAll(window.__ATTENDU).length : null };
})()`;

/* ------------------------ Serveur statique local ----------------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
/* Le serveur mémorise ce qu'il n'a pas trouvé. Sans cela, une ressource
 * manquante (CSS, JS, index.html d'une page renommée) est invisible : le 404
 * est servi en text/html, Chrome en fait un document valide, et l'audit d'une
 * page vide ne trouve évidemment aucun défaut. */
function serveur() {
  return new Promise((resolve) => {
    const manquants = new Set();
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      let f = path.join(DIST, p);
      if (p.endsWith('/')) f = path.join(f, 'index.html');
      if (!f.startsWith(DIST)) { res.writeHead(403).end(); return; }
      fs.readFile(f, (e, buf) => {
        if (e) { manquants.add(p); res.writeHead(404, { 'Content-Type': 'text/html' }).end('404'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(buf);
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, manquants, stop: () => s.close() }));
  });
}

/* ------------------------ Navigateur (protocole DevTools) --------------- */
function trouverNavigateur() {
  const candidats = process.platform === 'win32'
    ? [
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const c of candidats) if (c && fs.existsSync(c)) return c;
  for (const n of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { const p = execSync(`which ${n}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); if (p) return p; } catch { /* absent */ }
  }
  return null;
}

const getJson = (port, chemin, methode = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: chemin, method: methode }, (r) => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  });
  req.on('error', reject); req.end();
});

/** Onglet réellement pilotable : Chrome expose aussi des cibles internes
 * (page de service, extensions). En prendre une au hasard fait auditer le
 * vide en silence, ce qui est arrivé lors de la mise au point de ce script. */
async function onglet(port) {
  /* /json/new exige PUT sur les Chrome récents ; GET renvoie une erreur. */
  try {
    const t = await getJson(port, '/json/new?about:blank', 'PUT');
    if (t && t.webSocketDebuggerUrl) return t;
  } catch { /* on tente la liste existante */ }
  const liste = await getJson(port, '/json/list');
  const p = liste.find(t => t.type === 'page' && !/^(devtools|chrome-extension|chrome):/.test(t.url || ''));
  if (!p) throw new Error("aucun onglet pilotable (cibles vues : " + liste.map(t => t.type + ':' + (t.url || '').slice(0, 30)).join(', ') + ')');
  return p;
}

async function attendre(port, essais = 60) {
  for (let i = 0; i < essais; i++) {
    try { await getJson(port, '/json/version'); return true; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  return false;
}

/** Client minimal du protocole DevTools sur la WebSocket native de Node. */
function client(url) {
  const ws = new WebSocket(url);
  let id = 0; const attente = new Map(); const surEvenement = new Map(); const permanents = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && attente.has(m.id)) { attente.get(m.id)(m.result); attente.delete(m.id); return; }
    if (!m.method) return;
    if (permanents.has(m.method)) permanents.get(m.method)(m.params || {});
    if (surEvenement.has(m.method)) { surEvenement.get(m.method)(); surEvenement.delete(m.method); }
  });
  return {
    pret: new Promise(r => ws.addEventListener('open', r)),
    envoyer: (method, params = {}) => new Promise(r => { const n = ++id; attente.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }),
    attendreEvenement: (m, ms = 12000) => new Promise(r => { surEvenement.set(m, r); setTimeout(r, ms); }),
    sur: (m, cb) => permanents.set(m, cb),
    fermer: () => ws.close(),
  };
}

/* ------------------------------- Main ---------------------------------- */
(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error("✗ site/dist est vide : lancez d'abord node site/build.js");
    process.exit(1);
  }
  if (typeof WebSocket === 'undefined') {
    console.error(`✗ Node ${process.versions.node} : WebSocket natif requis (Node 22+).`);
    process.exit(1);
  }
  const exe = trouverNavigateur();
  if (!exe) {
    console.error('✗ Aucun navigateur Chromium trouvé (Chrome ou Edge).');
    console.error("  Ce contrôle a besoin d'un moteur de rendu ; les autres contrôles (check-links, check-seo) fonctionnent sans.");
    process.exit(1);
  }

  const fichierDe = (p) => (p.endsWith('/') ? path.join(DIST, p, 'index.html') : path.join(DIST, p));

  /* Git Bash réécrit « /guides/x/ » en « C:/Program Files/Git/guides/x/ » : on
   * retire les segments de tête jusqu'à retrouver une page qui existe vraiment.
   * ⚠️ La version précédente cherchait un gabarit dont le chemin demandé était
   * le suffixe. Comme « / » (l'accueil) est un gabarit, TOUT chemin terminé par
   * un slash lui correspondait : « --page /guides/visal/ » (faute de frappe)
   * auditait l'accueil et annonçait « OK ». Un rapprochement approximatif n'a
   * pas sa place dans un contrôle : il faut une page réelle ou une erreur. */
  const normaliser = (p) => {
    if (!p) return p;
    p = p.replace(/\\/g, '/');
    if (p.startsWith('/') && fs.existsSync(fichierDe(p))) return p;
    const seg = p.split('/').filter(Boolean);
    for (let i = 0; i < seg.length; i++) {
      const cand = '/' + seg.slice(i).join('/') + (p.endsWith('/') ? '/' : '');
      if (fs.existsSync(fichierDe(cand))) return cand;
    }
    return p.startsWith('/') ? p : '/' + p; // introuvable : la barrière d'existence tranchera
  };

  const pages = UNE_PAGE ? [normaliser(UNE_PAGE)]
    : process.argv.includes('--toutes')
      ? (function liste(d, base = '') {
        return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory()
          ? liste(path.join(d, e.name), base + '/' + e.name)
          : e.name === 'index.html' ? [base + '/'] : e.name.endsWith('.html') ? [base + '/' + e.name] : []);
      })(DIST)
      : GABARITS;

  /* Une page absente du disque doit faire ÉCHOUER le contrôle, jamais être
   * auditée. Le serveur local répond 404 en text/html, Chrome en fait un
   * document valide dont le pathname est celui demandé : sans cette barrière,
   * une faute de frappe dans --page ou un slug renommé dans GABARITS ressort
   * en « OK : aucun défaut ». C'est le mode de panne historique de ce script,
   * sous une autre forme. */
  const absentes = pages.filter(p => !fs.existsSync(fichierDe(p)));
  if (absentes.length) {
    console.error(`✗ page(s) introuvable(s) dans site/dist : ${absentes.join(', ')}`);
    console.error("  Un contrôle ne peut pas certifier une page qui n'existe pas.");
    console.error('  Rebuildez (node site/build.js), ou corrigez --page / la liste GABARITS.');
    process.exit(1);
  }

  const srv = await serveur();
  const profil = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tta-rendu-'));
  const portCdp = 9222 + Math.floor(Math.random() * 500);
  const nav = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${portCdp}`, `--user-data-dir=${profil}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--disable-extensions', '--mute-audio', 'about:blank',
  ], { stdio: 'ignore' });

  const nettoyer = () => {
    try { nav.kill(); } catch { /* déjà arrêté */ }
    srv.stop();
    try { fs.rmSync(profil, { recursive: true, force: true }); } catch { /* laissé au système */ }
  };
  process.on('exit', nettoyer);

  if (!await attendre(portCdp)) { console.error('✗ Le navigateur n\'a pas répondu.'); nettoyer(); process.exit(1); }

  const cible = await onglet(portCdp);
  const c = client(cible.webSocketDebuggerUrl);
  await c.pret;
  await c.envoyer('Page.enable');
  /* Les pages les plus fragiles du site sont celles dont le contenu est injecté
   * par du JS inline (/diagnostic/, /recherche/, les simulateurs). Si un de ces
   * scripts jette, la page reste au squelette : aucun champ, aucune région
   * live, donc aucun défaut géométrique à constater. Sans écoute des exceptions
   * de la page, le contrôle est le plus silencieux là où le risque est le plus
   * élevé. Vérifié : casser le sélecteur de /diagnostic/ donnait un « OK ». */
  await c.envoyer('Runtime.enable');
  await c.envoyer('Log.enable');
  let erreursPage = [];
  c.sur('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    erreursPage.push((d.exception && d.exception.description) || d.text || 'exception inconnue');
  });
  c.sur('Log.entryAdded', (p) => {
    const e = p.entry || {};
    /* Plus d'exception pour /favicon.ico : le fichier existe désormais et
     * toutes les pages le référencent, donc une erreur réseau dessus est un
     * vrai défaut. Une exception qui survit à son motif finit par masquer
     * exactement ce que le contrôle est censé attraper. */
    if (e.level === 'error') {
      erreursPage.push(`[${e.source}] ${e.text}`);
    }
  });

  const resultats = [];
  for (const largeur of LARGEURS) {
    await c.envoyer('Emulation.setDeviceMetricsOverride', {
      width: largeur, height: 900, deviceScaleFactor: 1, mobile: largeur < 700,
    });
    for (const p of pages) {
      erreursPage = []; srv.manquants.clear();
      const charge = c.attendreEvenement('Page.loadEventFired');
      await c.envoyer('Page.navigate', { url: `http://127.0.0.1:${srv.port}${p}` });
      await charge;
      await new Promise(r => setTimeout(r, 160)); // laisser les scripts inline s'appliquer
      const att = ATTENDUS[p];
      if (att) await c.envoyer('Runtime.evaluate', { expression: `window.__ATTENDU=${JSON.stringify(att.sel)}` });
      const r = await c.envoyer('Runtime.evaluate', { expression: AUDIT, returnByValue: true, awaitPromise: true });
      if (r && r.exceptionDetails) {
        console.error(`✗ ${p} (${largeur}px) : l'audit a échoué dans la page : ${(r.exceptionDetails.exception || {}).description || r.exceptionDetails.text}`);
        process.exitCode = 1; continue;
      }
      const v = r && r.result && r.result.value;
      /* Garde-fou : un audit qui ne s'exécute pas doit ÉCHOUER, jamais passer
       * pour un succès. Sans cette vérification, ce script a un temps audité
       * une page interne du navigateur en annonçant « aucun défaut ». */
      if (!v || typeof v.pbs === 'undefined') {
        console.error(`✗ ${p} (${largeur}px) : aucun résultat d'audit renvoyé.`);
        process.exitCode = 1; continue;
      }
      const attendu = p.replace(/index\.html$/, '');
      if (v.url !== attendu && v.url + '/' !== attendu && v.url !== p) {
        console.error(`✗ page auditée inattendue : « ${v.url} » au lieu de « ${p} ».`);
        process.exitCode = 1; continue;
      }
      if (!Number.isFinite(v.vw) || Math.abs(v.vw - largeur) > 1) {
        console.error(`✗ largeur appliquée inattendue sur ${p} : ${v.vw} px au lieu de ${largeur}.`);
        process.exitCode = 1; continue;
      }
      /* Une ressource manquante ou une exception du site invalident la mesure :
       * la page auditée n'est pas celle que le visiteur verra. */
      if (srv.manquants.size) {
        console.error(`✗ ${p} (${largeur}px) : ressource(s) introuvable(s) : ${[...srv.manquants].join(', ')}`);
        process.exitCode = 1; continue;
      }
      if (erreursPage.length) {
        console.error(`✗ ${p} (${largeur}px) : la page a produit une erreur JS, son rendu n'est pas fiable :`);
        for (const m of erreursPage.slice(0, 3)) console.error(`    ${String(m).split('\n')[0]}`);
        process.exitCode = 1; continue;
      }
      /* Contenu construit par JS : absent, il n'y a rien à mesurer, et un audit
       * sur du vide ne vaut pas un audit réussi. */
      if (att && !(v.attendus >= att.min)) {
        console.error(`✗ ${p} (${largeur}px) : contenu injecté manquant : ${att.quoi} (${att.sel} : ${v.attendus} trouvé(s), ${att.min} attendu(s)).`);
        process.exitCode = 1; continue;
      }
      if (v.pbs.length) resultats.push({ largeur, page: p, pbs: v.pbs });
      else if (VERBEUX) console.log(`  ok   ${largeur}px ${p}`);
    }
  }
  c.fermer(); nettoyer(); process.removeAllListeners('exit');

  const total = pages.length * LARGEURS.length;
  console.log(`${pages.length} page(s) × ${LARGEURS.length} largeur(s) = ${total} rendus audités (${LARGEURS.join(', ')} px)`);
  /* Un audit qui n'a pas pu tourner ne vaut pas un audit réussi : on sort en
   * erreur sans annoncer « aucun défaut », qui serait mensonger. */
  if (process.exitCode === 1) {
    console.error("\n✗ L'audit n'a pas pu s'exécuter sur tous les rendus (voir ci-dessus) : résultat non concluant.");
    process.exit(1);
  }
  if (!resultats.length) {
    console.log('\nOK : aucun défaut de rendu : pas de scroll horizontal, pas de débordement, pas de chevauchement, pas de texte tronqué, champs alignés, cibles ≥ 24 px.');
    process.exit(0);
  }
  const bloquants = resultats.filter(r => r.pbs.some(p => p.g === 'BLOQUANT')).length;
  console.error(`\n${resultats.length} rendu(s) en défaut${bloquants ? `, dont ${bloquants} bloquant(s)` : ''} :`);
  for (const r of resultats) {
    console.error(`\n  ${r.page}  (${r.largeur} px)`);
    for (const p of r.pbs) console.error(`    [${p.g}] ${p.q} : ${p.d}`);
  }
  process.exit(1);
})().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });

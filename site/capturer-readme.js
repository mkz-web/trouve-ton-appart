#!/usr/bin/env node
/**
 * capturer-readme.js : captures réelles du site EN PRODUCTION pour le README du dépôt,
 * plus le logo servi, rangés dans .github/readme/.
 *
 * Exécution      : node site/capturer-readme.js [--origine=https://trouve-ton-appart.fr] [--qualite=82]
 * Runtime minimal : Node 22+ (WebSocket et fetch natifs).
 * Dépendances    : aucune.
 *
 * EXCEPTION documentée : comme check-rendu.js, ce script pilote un Chrome ou Edge DÉJÀ
 * installé sur le poste par le protocole DevTools. C'est un outil de fabrication du dépôt,
 * jamais une dépendance du site ni d'un livrable.
 *
 * Ce qu'il produit :
 *   .github/readme/accueil-1280.webp        accueil, 1 280 px CSS, DPR 1,25 (1 600 px de large)
 *   .github/readme/accueil-375.webp         accueil, 375 px CSS, DPR 2 (une colonne, menu burger)
 *   .github/readme/observatoire-1280.webp   l'Observatoire des délais, 1 280 px CSS, DPR 1,25
 *   .github/readme/logo.svg                 /favicon.svg tel que servi en production
 *   .github/readme/captures.json            relevé daté de chaque capture (contrôlable au commit)
 *
 * Pourquoi la production et pas dist/ : une image de README promet ce que le visiteur voit.
 * Le build est déterministe, mais c'est l'URL servie qui fait foi, et le relevé le prouve.
 *
 * Pourquoi le consentement est posé AVANT le chargement : le bandeau de consentement s'ouvre
 * de lui-même sur le domaine de production tant qu'aucun choix n'est enregistré (localStorage
 * `tta-consent`, voir CONSENT_JS dans build.js). On enregistre un REFUS par
 * Page.addScriptToEvaluateOnNewDocument, donc le bandeau reste fermé, aucun script de mesure ne
 * part, et la capture montre la page, pas le bandeau. Un cookie ne suffirait pas : le choix vit
 * dans localStorage.
 *
 * Pourquoi WebP par Chrome et pas une conversion à part : Page.captureScreenshot sait écrire du
 * WebP directement, avec sa qualité, sans rastériseur ni convertisseur.
 *
 * Garde-fous (règle du projet : un contrôle se déclenche sur l'INCONNU, pas seulement sur le
 * faux) : innerWidth doit valoir la largeur demandée, le H1 doit être celui attendu, le bandeau
 * de consentement doit être masqué, aucune image de la page ne doit être en échec, et une
 * capture de moins de 5 Ko est refusée (page vide). Le moindre écart sort en code 2 sans écrire.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RACINE = path.resolve(__dirname, '..');
const SORTIE = path.join(RACINE, '.github', 'readme');
const CLE_CONSENTEMENT = 'tta-consent';

const opts = { origine: 'https://trouve-ton-appart.fr', qualite: 82 };
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/);
  if (!m) { console.error('Argument inconnu : ' + a); process.exit(1); }
  if (m[1] === 'origine') opts.origine = m[2].replace(/\/$/, '');
  else if (m[1] === 'qualite') opts.qualite = Number(m[2]);
  else { console.error('Option inconnue : --' + m[1]); process.exit(1); }
}
if (!(opts.qualite >= 1 && opts.qualite <= 100)) { console.error('--qualite entre 1 et 100'); process.exit(1); }

/* Les captures : URL, largeur CSS, hauteur CSS, DPR, H1 attendu (mot pour mot, mesuré sur le
 * build : un H1 différent veut dire qu'on ne capture pas la page qu'on croit). */
const CAPTURES = [
  { fichier: 'accueil-1280.webp', chemin: '/', largeur: 1280, hauteur: 800, dpr: 1.25,
    h1: 'Le logement en Île-de-France, enfin dans le bon ordre.' },
  { fichier: 'accueil-375.webp', chemin: '/', largeur: 375, hauteur: 812, dpr: 2, mobile: true,
    h1: 'Le logement en Île-de-France, enfin dans le bon ordre.' },
  { fichier: 'observatoire-1280.webp', chemin: '/logement-social/delais/', largeur: 1280, hauteur: 800, dpr: 1.25,
    h1: "L'Observatoire des délais du logement social en Île-de-France" },
];

function trouverNavigateur() {
  const candidats = process.platform === 'win32'
    ? [process.env.CHROME_PATH,
      (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    : [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidats.filter(Boolean).find((c) => fs.existsSync(c)) || null;
}

const dodo = (ms) => new Promise((r) => setTimeout(r, ms));

function clientCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const attentes = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && attentes.has(msg.id)) {
      const { resolve, reject } = attentes.get(msg.id);
      attentes.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  });
  const ouvert = new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return {
    ouvert,
    envoyer: (method, params = {}) => new Promise((resolve, reject) => {
      const i = ++id; attentes.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params }));
    }),
    fermer: () => ws.close(),
  };
}

async function capturer(port, spec) {
  const url = opts.origine + spec.chemin;
  const cible = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const c = clientCdp(cible.webSocketDebuggerUrl);
  await c.ouvert;
  await c.envoyer('Page.enable');
  /* Refus de consentement enregistré avant tout script de la page. */
  await c.envoyer('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem(${JSON.stringify(CLE_CONSENTEMENT)},JSON.stringify({c:'denied',t:Date.now()}))}catch(e){}`,
  });
  await c.envoyer('Emulation.setDeviceMetricsOverride', {
    width: spec.largeur, height: spec.hauteur, deviceScaleFactor: spec.dpr, mobile: !!spec.mobile,
  });
  if (spec.mobile) {
    await c.envoyer('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
    });
  }
  await c.envoyer('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await c.envoyer('Page.navigate', { url });
  let pret = false;
  for (let i = 0; i < 120 && !pret; i++) {
    await dodo(250);
    const r = await c.envoyer('Runtime.evaluate', {
      expression: "document.readyState === 'complete' && document.fonts.status === 'loaded'", returnByValue: true,
    });
    pret = r.result.value === true;
  }
  if (!pret) throw new Error('page non chargée après 30 s : ' + url);
  await dodo(2500); /* animations d'entrée terminées (le hero en a) */
  const r = await c.envoyer('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      h1: (document.querySelector('h1') || {}).innerText || null,
      bandeau: (function(b){ if(!b) return 'absent'; var r=b.getBoundingClientRect(); return (b.hidden || r.height === 0) ? 'masque' : 'VISIBLE'; })(document.getElementById('consent')),
      imagesEnEchec: [...document.images].filter(i => !(i.complete && i.naturalWidth > 0)).length,
      clarity: typeof window.clarity,
    })`,
  });
  const releve = JSON.parse(r.result.value);
  const defauts = [];
  if (releve.innerWidth !== spec.largeur) defauts.push(`innerWidth ${releve.innerWidth} au lieu de ${spec.largeur}`);
  if (releve.scrollWidth > spec.largeur) defauts.push(`débordement horizontal : scrollWidth ${releve.scrollWidth}`);
  if (releve.h1 !== spec.h1) defauts.push(`H1 « ${releve.h1} » au lieu de « ${spec.h1} »`);
  if (releve.bandeau !== 'masque') defauts.push('bandeau de consentement ' + releve.bandeau);
  if (releve.imagesEnEchec > 0) defauts.push(releve.imagesEnEchec + ' image(s) non chargée(s)');
  if (releve.clarity !== 'undefined') defauts.push('un script de mesure a été chargé malgré le refus');
  if (defauts.length) throw new Error(`${spec.fichier} : ${defauts.join(' ; ')}`);

  const shot = await c.envoyer('Page.captureScreenshot', {
    format: 'webp', quality: opts.qualite, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: spec.largeur, height: spec.hauteur, scale: 1 },
  });
  const octets = Buffer.from(shot.data, 'base64');
  if (octets.length < 5000) throw new Error(`${spec.fichier} : ${octets.length} octets, capture vide`);
  c.fermer();
  return { octets, releve: { ...releve, url, largeurCss: spec.largeur, hauteurCss: spec.hauteur, dpr: spec.dpr } };
}

(async () => {
  if (typeof WebSocket === 'undefined') {
    console.error(`Node ${process.versions.node} : WebSocket natif requis (Node 22+).`);
    process.exit(1);
  }
  const navigateur = trouverNavigateur();
  if (!navigateur) { console.error('Aucun Chrome ni Edge trouvé (CHROME_PATH pour en désigner un).'); process.exit(1); }

  const port = 9700 + Math.floor(Math.random() * 200);
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-readme-'));
  const proc = spawn(navigateur, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profil}`,
    '--window-size=1280,800', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  let code = 0;
  const resultats = [];
  try {
    let vivant = false;
    for (let i = 0; i < 60 && !vivant; i++) {
      try { vivant = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch (e) { /* pas prêt */ }
      if (!vivant) await dodo(250);
    }
    if (!vivant) throw new Error('le navigateur ne répond pas sur le port ' + port);

    /* Tout est capturé et contrôlé AVANT la première écriture : pas de dossier à moitié refait. */
    for (const spec of CAPTURES) resultats.push({ spec, ...(await capturer(port, spec)) });
    const rep = await fetch(opts.origine + '/favicon.svg');
    if (!rep.ok) throw new Error('/favicon.svg en ' + rep.status);
    const logo = await rep.text();
    if (!/^<svg[\s>]/.test(logo.trim())) throw new Error('/favicon.svg ne sert pas un SVG');

    fs.mkdirSync(SORTIE, { recursive: true });
    const journal = { date: new Date().toISOString(), origine: opts.origine, qualite: opts.qualite, captures: [] };
    for (const { spec, octets, releve } of resultats) {
      fs.writeFileSync(path.join(SORTIE, spec.fichier), octets);
      journal.captures.push({ fichier: spec.fichier, octets: octets.length, ...releve });
      console.log(`${spec.fichier} : ${spec.largeur}x${spec.hauteur} px CSS, DPR ${spec.dpr}, ${octets.length} octets, H1 « ${releve.h1} », bandeau ${releve.bandeau}`);
    }
    fs.writeFileSync(path.join(SORTIE, 'logo.svg'), logo.trim() + '\n');
    fs.writeFileSync(path.join(SORTIE, 'captures.json'), JSON.stringify(journal, null, 2) + '\n');
    console.log(`logo.svg : ${Buffer.byteLength(logo)} octets, servi par ${opts.origine}/favicon.svg`);
    console.log(`Relevé écrit : ${path.relative(RACINE, path.join(SORTIE, 'captures.json'))}`);
  } catch (e) {
    console.error('Échec, rien d\'écrit : ' + e.message);
    code = 2;
  } finally {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill();
    try { fs.rmSync(profil, { recursive: true, force: true }); } catch (e) { /* profil temporaire */ }
  }
  process.exit(code);
})();

#!/usr/bin/env node
/**
 * check-liens-maps.js : chaque lien « voir sur Google Maps » ouvre-t-il le bon lieu ?
 * ------------------------------------------------------------------
 * Exécution   : node site/check-liens-maps.js [--jeu=crous|fjt|residences-autonomie] [--limite=N] [--concurrence=N] [--verbeux]
 * Runtime     : Node.js >= 22 (WebSocket natif) · Dépendances : AUCUNE
 *               Pilote un Chrome ou Edge DÉJÀ INSTALLÉ par le protocole DevTools, sans rien
 *               télécharger (même mécanique que check-rendu.js). Réseau requis, donc HORS de
 *               check-tout.js : à lancer à la demande.
 * Entrée      : site/dist/ (les 24 pages d'annuaire) et site/data/place-ids.json
 * Sortie 0    : chaque lien ouvre la fiche attendue (identifiant) ou l'adresse attendue ;
 *               sortie 1 : au moins un lien ouvre autre chose (liste de résultats, autre
 *               lieu, page sans titre), listé avec sa page et ce que Google a affiché.
 * ------------------------------------------------------------------
 *
 * Pourquoi (10/09/2026) : un lien Google Maps répond toujours 200, un contrôle HTTP ne
 * prouve rien. Ce qui compte, c'est ce que Google AFFICHE au visiteur : le titre de la
 * fiche (h1). Mesuré ce jour sur 9 résidences, une requête par nom envoyait un visiteur
 * sur trois vers un autre établissement ; d'où la requête par adresse, plus l'identifiant
 * de fiche vérifié (query_place_id) quand il existe. Ce script rejoue CHAQUE lien servi et
 * lit le h1 rendu :
 *   - lien avec identifiant : le h1 doit être le titre de la fiche appariée (place-ids.json),
 *     à la casse et aux accents près, ou en partager la majorité des mots (Google retouche
 *     parfois un titre) ;
 *   - lien par adresse : le h1 doit porter le numéro et un mot de la voie de l'adresse
 *     affichée (Google abrège les types de voie : « R. », « Av. », « Bd », « All. »).
 *   Tout le reste (« Résultats », « Sponsorisé », un autre nom, pas de h1) est un échec.
 * La page de consentement Google s'ouvre une fois par profil : le script clique « Tout
 * refuser » (le choix le plus protecteur) et continue. Google limite le trafic automatisé :
 * 3 onglets au plus, une pause entre deux ouvertures ; en cas de page « trafic inhabituel »
 * le script s'arrête et le dit, plutôt que de compter des échecs qui n'en sont pas.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const DIST = path.join(__dirname, 'dist');
const PLACE_IDS = path.join(__dirname, 'data', 'place-ids.json');
const ARGS = process.argv.slice(2);
const opt = (n) => { const a = ARGS.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const VERBEUX = ARGS.includes('--verbeux');
const JEU = opt('jeu');
const IDS = opt('ids') ? new Set(opt('ids').split(',').map((x) => x.trim()).filter(Boolean)) : null; // --ids=1268,750064826 : rejouer des résidences précises
const LIMITE = opt('limite') ? Number(opt('limite')) : null;
const CONCURRENCE = opt('concurrence') ? Number(opt('concurrence')) : 3;
if (opt('limite') && !(LIMITE > 0)) { console.error('--limite doit être un entier positif'); process.exit(2); }
if (!(CONCURRENCE >= 1 && CONCURRENCE <= 3)) { console.error('--concurrence entre 1 et 3 (au-delà, Google bloque)'); process.exit(2); }
const DOSSIERS = { crous: 'residences-crous', fjt: 'foyers-jeunes-travailleurs', 'residences-autonomie': 'residences-autonomie' };
if (JEU && !DOSSIERS[JEU]) { console.error('--jeu : crous, fjt ou residences-autonomie'); process.exit(2); }

/* ---------- collecte des liens servis ---------- */
const DIACRITIQUES = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
// Les ligatures ne se décomposent pas par NFD : « Bœufs » resterait différent de « Boeufs ».
const normaliser = (s) => String(s || '').replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/Œ/g, 'Oe').replace(/Æ/g, 'Ae').normalize('NFD').replace(DIACRITIQUES, '').toLowerCase().replace(/[’']/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const dec = (t) => t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
/* « paris » n'y figure pas : « rue de Paris » est une voie fréquente en banlieue, et la ville
   est déjà retirée avec le code postal. */
const TYPES_VOIE = new Set(['rue', 'avenue', 'boulevard', 'allee', 'square', 'place', 'chemin', 'impasse', 'route', 'quai', 'cours', 'passage', 'voie', 'cite', 'villa', 'sente', 'promenade', 'esplanade', 'mail', 'bis', 'ter', 'les', 'des', 'de', 'du', 'la', 'le', 'et', 'saint', 'sainte']);
/* Google corrige l'orthographe des voies (Collette en Colette, Leibnitz en Leibniz, Desnoyez
   en Denoyez, Damien en Damiens, Mocquet en Môquet : 10 cas sur 728 le 10/09/2026) : deux
   mots de voie concordent s'ils sont égaux, à une lettre près, ou sur leurs cinq premières
   lettres. */
const levenshtein = (a, b) => { const m = a.length, n = b.length; if (Math.abs(m - n) > 1) return 2; const d = Array.from({ length: m + 1 }, (_, i) => [i]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; };
const motsProches = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.slice(0, 5) === b.slice(0, 5) || levenshtein(a, b) <= 1));
const motsVoie = (adresseNormalisee) => adresseNormalisee.replace(/\b(7[58]|77|9[12345])\s?\d{3}\b.*$/, '').split(' ').filter((x) => (x.length > 3 || /^\d{4}$/.test(x)) && !TYPES_VOIE.has(x) && !/^\d{1,3}$/.test(x));
const numeroDe = (adresseNormalisee) => (/^\D*?(\d{1,4})\b/.exec(adresseNormalisee) || [])[1] || null;
/** Le texte (titre ou libellé d'adresse rendu par Google) porte-t-il le numéro et la voie ? */
function porteAdresse(texte, adresse) {
  const h = normaliser(texte); if (!h) return { num: false, voie: false };
  const adr = normaliser(adresse);
  const num = numeroDe(adr);
  const mots = motsVoie(adr), motsH = h.split(' ');
  const voie = mots.some((x) => motsH.some((y) => motsProches(x, y)));
  const numOk = !num || new RegExp('(^|\\s|/)' + num + '([a-d]|bis|ter)?(\\s|$|/|-)').test(h);
  return { num: numOk, voie, sansNumero: !num };
}

const pid = JSON.parse(fs.readFileSync(PLACE_IDS, 'utf8'));
const titreAttendu = new Map(pid.items.filter((it) => it.verdict === 'accepte').map((it) => [it.placeId, it.titreGoogle]));

const liens = [];
for (const [jeu, dossier] of Object.entries(DOSSIERS)) {
  if (JEU && jeu !== JEU) continue;
  const base = path.join(DIST, dossier);
  if (!fs.existsSync(base)) { console.error(`site/dist/${dossier}/ absent : lancer node site/build.js`); process.exit(2); }
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const page = `/${dossier}/${e.name}/`;
    const s = fs.readFileSync(path.join(base, e.name, 'index.html'), 'utf8');
    const re = /<li class="dir-item" id="r-([^"]+)">([\s\S]*?)<\/li>/g;
    let m;
    while ((m = re.exec(s))) {
      const corps = m[2];
      const nom = dec((corps.match(/<h3>([^<]*)<\/h3>/) || [])[1] || '');
      const l = /<a href="(https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=[^"]*)" rel="noopener" target="_blank">voir sur Google Maps<\/a>/.exec(corps);
      if (!l) { console.error(`carte sans lien Google Maps : ${page} ${m[1]}`); process.exit(2); }
      const url = dec(l[1]);
      const u = new URL(url);
      liens.push({ jeu, id: m[1], page, nom, url, adresse: u.searchParams.get('query'), placeId: u.searchParams.get('query_place_id') });
    }
  }
}
const filtres = IDS ? liens.filter((l) => IDS.has(l.id)) : liens;
const cibles = LIMITE ? filtres.slice(0, LIMITE) : filtres;
if (!cibles.length) { console.error('aucun lien à vérifier'); process.exit(2); }

/* ---------- jugement ---------- */
/**
 * Ce que Google a affiché : le h1 (titre de la fiche, ou l'adresse elle-même pour un repère
 * d'adresse) et, quand une fiche s'ouvre, son libellé d'adresse (bouton « Adresse : … »).
 * Une requête par adresse peut ouvrir une FICHE (Google connaît un établissement à ce
 * numéro) : c'est juste si l'adresse rendue par la fiche est la nôtre.
 */
const MOTS_GENERIQUES = new Set(['residence', 'residences', 'autonomie', 'fjt', 'foyer', 'sociale', 'social', 'universitaire', 'crous', 'jeunes', 'travailleurs', 'centre', 'cite', 'maison', 'les', 'des', 'saint', 'sainte']);
const motsNom = (s) => normaliser(s).split(' ').filter((x) => x.length >= 4 && !MOTS_GENERIQUES.has(x));
function juger(lien, rendu) {
  const { h1, adresseRendue, enTete, corps } = rendu;
  const h = normaliser(h1);
  // Exception à coordonnées (data/maps-exceptions.json) : Google titre le repère en degrés
  // (« 48°33'54.7"N 2°25'40.5"E ») ; on vérifie que ce sont bien nos coordonnées.
  if (/^-?\d+\.\d+,-?\d+\.\d+$/.test(lien.adresse || '')) {
    const [la, lo] = lien.adresse.split(',').map(Number);
    const deg = (v) => Math.floor(Math.abs(v)) + '°';
    if (h1.includes(deg(la)) && h1.includes(deg(lo)) && /[NS]/.test(h1) && /[EW]/.test(h1)) return { verdict: 'coordonnees', motif: h1 };
    return { verdict: 'echec', motif: `titre « ${h1} » au lieu d'un repère à ${lien.adresse}` };
  }
  // Sans h1, Google a pu rendre un repère d'adresse dans un panneau sans titre (vu sur un
  // code postal écrit « 75 012 ») : le panneau porte alors l'adresse en clair, on la lit.
  const parCorps = porteAdresse((corps || '').slice(0, 300), lien.adresse);
  if (!h) {
    if (parCorps.num && parCorps.voie && !/correspondance partielle|partial match/i.test(corps || '')) return { verdict: 'adresse', motif: `repère sans titre, panneau « ${(corps || '').replace(/^\s*(Enregistré|Récents|Obtenir l'appli)\s*/g, '').slice(0, 90)} »` };
    return { verdict: 'echec', motif: `aucun titre rendu (page : « ${(corps || '').slice(0, 160)} »)` };
  }
  if (/^(resultats|sponsorise|google maps)$/.test(h)) return { verdict: 'echec', motif: `liste de résultats (« ${h1} »)` };
  if (/trafic inhabituel|unusual traffic|captcha/i.test(h1)) return { verdict: 'bloque', motif: 'Google bloque le trafic automatisé' };
  const parTitre = porteAdresse(h1, lien.adresse);
  const parEnTete = porteAdresse(enTete || '', lien.adresse);
  const parFiche = porteAdresse(adresseRendue || '', lien.adresse);
  // Google coupe parfois le titre d'un repère au numéro (« 47/53 ») : la voie est alors dans
  // le panneau, juste sous le titre.
  const adresseOk = (parTitre.num && parTitre.voie) || (parEnTete.num && parEnTete.voie) || (parFiche.num && parFiche.voie) || (parTitre.num && parCorps.voie);
  // Une requête par adresse ouvre parfois directement la fiche de l'établissement (Google
  // connaît un lieu à ce numéro) : juste si son titre porte le nom de NOTRE résidence.
  const mots = motsNom(lien.nom), motsH = new Set(motsNom(h1));
  const nomOk = mots.length > 0 && mots.filter((x) => [...motsH].some((y) => motsProches(x, y))).length / mots.length >= 0.5;
  if (lien.placeId) {
    const attendu = titreAttendu.get(lien.placeId);
    if (!attendu) return { verdict: 'echec', motif: 'identifiant servi absent des fiches acceptées' };
    const a = normaliser(attendu);
    if (h === a) return { verdict: 'fiche', motif: h1 };
    const motsA = a.split(' ').filter((x) => x.length > 2), motsH = new Set(h.split(' '));
    const communs = motsA.filter((x) => motsH.has(x)).length;
    if (motsA.length && communs / motsA.length >= 0.5) return { verdict: 'fiche', motif: `${h1} (attendu « ${attendu} »)` };
    if (adresseOk) return { verdict: 'fiche', motif: `${h1} (titre retouché par Google, adresse rendue « ${adresseRendue} »)` };
    return { verdict: 'echec', motif: `titre « ${h1} » au lieu de « ${attendu} »` };
  }
  if (adresseOk) return { verdict: (parTitre.num && (parTitre.voie || parCorps.voie)) || (parEnTete.num && parEnTete.voie) ? 'adresse' : 'fiche', motif: h1 + (adresseRendue ? ` (adresse rendue « ${adresseRendue} »)` : '') };
  if (nomOk) return { verdict: 'fiche', motif: `${h1} (fiche ouverte par l'adresse, nom concordant${adresseRendue ? ', adresse rendue « ' + adresseRendue + ' »' : ''})` };
  return { verdict: 'echec', motif: `titre « ${h1} »${adresseRendue ? ', adresse rendue « ' + adresseRendue + ' »' : ''} ne porte pas ${parTitre.num || parEnTete.num || parFiche.num ? 'la voie' : 'le numéro'} de « ${lien.adresse} »` };
}

/* ---------- navigateur (protocole DevTools, repris de check-rendu.js) ---------- */
function trouverNavigateur() {
  const candidats = process.platform === 'win32'
    ? [process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
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
  const req = http.request({ host: '127.0.0.1', port, path: chemin, method: methode }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end();
});
async function nouvelOnglet(port) {
  const t = await getJson(port, '/json/new?about:blank', 'PUT');
  if (!t || !t.webSocketDebuggerUrl) throw new Error('impossible d\'ouvrir un onglet');
  return t;
}
async function attendre(port, essais = 60) {
  for (let i = 0; i < essais; i++) { try { await getJson(port, '/json/version'); return true; } catch { await dodo(250); } }
  return false;
}
function client(url) {
  const ws = new WebSocket(url);
  let id = 0; const attente = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && attente.has(m.id)) { attente.get(m.id)(m.result); attente.delete(m.id); } });
  return {
    pret: new Promise((r) => ws.addEventListener('open', r)),
    envoyer: (method, params = {}) => new Promise((r) => { const n = ++id; attente.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }),
    fermer: () => ws.close(),
  };
}
const dodo = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluer = async (c, expr) => { const r = await c.envoyer('Runtime.evaluate', { expression: expr, returnByValue: true }); return r && r.result ? r.result.value : undefined; };

/** Ouvre l'URL, passe le consentement s'il se présente, attend un h1, le rend avec l'URL finale. */
async function ouvrir(c, url) {
  await c.envoyer('Page.navigate', { url });
  for (let i = 0; i < 40; i++) { // 12 s au plus
    await dodo(300);
    // Le libellé d'adresse d'une fiche (bouton « Adresse : … ») arrive un peu après le h1 :
    // on le relit une fois de plus quand le h1 est là.
    // enTete : le bloc qui entoure le h1 (pour un repère d'adresse, Google coupe parfois le
    // titre au numéro, « 47/53 », et met la voie sur la ligne suivante) ; corps : les 300
    // premiers caractères visibles, pour diagnostiquer une page sans titre.
    const lire = '(function(){var h=document.querySelector("h1");var a=document.querySelector(\'button[data-item-id="address"]\');var e=h&&h.parentElement?h.parentElement.innerText:"";return JSON.stringify({host:location.host,href:location.href,h1:h?h.textContent:null,titre:document.title,adresse:a?(a.getAttribute("aria-label")||a.textContent).replace(/^\\s*Adresse\\s*:\\s*/i,""):null,enTete:(e||"").slice(0,200),corps:(document.body.innerText||"").replace(/\\s+/g," ").slice(0,300)})})()';
    const etat = await evaluer(c, lire);
    if (!etat) continue;
    let e = JSON.parse(etat);
    if (/consent\.google/.test(e.host)) {
      await evaluer(c, '(function(){var b=[...document.querySelectorAll("button")].find(function(x){return /tout refuser|reject all/i.test(x.textContent)});if(b){b.click();return true}return false})()');
      await dodo(1500);
      continue;
    }
    if (/sorry\/index|unusual traffic/i.test(e.href + ' ' + e.titre)) return { h1: 'trafic inhabituel', href: e.href };
    if (e.h1 && e.h1.trim()) {
      for (let k = 0; k < 4 && !e.adresse; k++) { await dodo(700); const bis = await evaluer(c, lire); if (bis) e = JSON.parse(bis); }
      return { h1: (e.h1 || '').trim(), href: e.href, adresseRendue: (e.adresse || '').trim(), enTete: e.enTete || '', corps: e.corps || '' };
    }
  }
  const final = JSON.parse((await evaluer(c, '(function(){return JSON.stringify({href:location.href,titre:document.title,corps:(document.body.innerText||"").replace(/\\s+/g," ").slice(0,300)})})()')) || '{}');
  return { h1: '', href: final.href || url, titre: final.titre, adresseRendue: '', enTete: '', corps: final.corps || '' };
}

/* ---------- main ---------- */
(async () => {
  if (typeof WebSocket === 'undefined') { console.error(`Node ${process.versions.node} : WebSocket natif requis (Node 22+).`); process.exit(1); }
  const exe = trouverNavigateur();
  if (!exe) { console.error('Aucun navigateur Chromium trouvé (Chrome ou Edge).'); process.exit(1); }
  const profil = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tta-maps-'));
  const port = 9222 + Math.floor(Math.random() * 500);
  const nav = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profil}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-extensions', '--mute-audio', '--lang=fr-FR', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  const nettoyer = () => { try { nav.kill(); } catch { /* déjà arrêté */ } try { fs.rmSync(profil, { recursive: true, force: true }); } catch { /* laissé au système */ } };
  process.on('exit', nettoyer);
  if (!await attendre(port)) { console.error('Le navigateur n\'a pas répondu.'); process.exit(1); }

  console.log(`${cibles.length} lien(s) Google Maps à rejouer${JEU ? ' (' + JEU + ')' : ''}, ${CONCURRENCE} onglet(s)`);
  // Le consentement se règle une fois, dans le premier onglet, avant d'ouvrir les autres :
  // deux onglets qui le rencontrent en même temps se marchent dessus.
  const resultats = new Array(cibles.length);
  let i = 0, faits = 0, bloque = false;
  const t0 = Date.now();
  const travailler = async (c) => {
    while (i < cibles.length && !bloque) {
      const k = i++;
      const lien = cibles[k];
      const r = await ouvrir(c, lien.url);
      const j = juger(lien, r);
      if (j.verdict === 'bloque') bloque = true;
      resultats[k] = { ...lien, ...j, h1: r.h1, href: r.href };
      faits++;
      if (faits % 50 === 0) console.log(`  ${faits}/${cibles.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
      await dodo(400);
    }
  };
  const premier = client((await nouvelOnglet(port)).webSocketDebuggerUrl); await premier.pret; await premier.envoyer('Page.enable');
  if (cibles.length) { const r0 = await ouvrir(premier, cibles[0].url); const j0 = juger(cibles[0], r0); resultats[0] = { ...cibles[0], ...j0, h1: r0.h1, href: r0.href }; i = 1; faits = 1; if (j0.verdict === 'bloque') bloque = true; }
  const onglets = [premier];
  for (let n = 1; n < CONCURRENCE; n++) { const c = client((await nouvelOnglet(port)).webSocketDebuggerUrl); await c.pret; await c.envoyer('Page.enable'); onglets.push(c); }
  await Promise.all(onglets.map((c) => travailler(c)));
  for (const c of onglets) c.fermer();

  const faitsL = resultats.filter(Boolean);
  const comptes = {};
  for (const r of faitsL) { comptes[r.jeu] = comptes[r.jeu] || {}; comptes[r.jeu][r.verdict] = (comptes[r.jeu][r.verdict] || 0) + 1; }
  console.log('\nVerdicts par annuaire :', JSON.stringify(comptes));
  const echecs = faitsL.filter((r) => r.verdict === 'echec');
  if (echecs.length) {
    console.log(`\nÉCHECS (${echecs.length}) :`);
    for (const r of echecs) console.log(`  - ${r.page} [${r.jeu} ${r.id}] ${r.nom}\n      ${r.motif}\n      ${r.url}`);
  }
  if (VERBEUX) for (const r of faitsL.filter((x) => x.verdict !== 'echec')) console.log(`  ok ${r.verdict} | ${r.nom} → ${r.h1}`);
  if (bloque) { console.log(`\nARRÊT : Google a bloqué le trafic automatisé après ${faitsL.length} lien(s). Relancer plus tard, avec --limite ou --jeu.`); process.exit(1); }
  console.log(`\n${faitsL.length} lien(s) rejoué(s) en ${Math.round((Date.now() - t0) / 1000)} s : ${faitsL.filter((r) => r.verdict === 'fiche').length} fiche(s), ${faitsL.filter((r) => r.verdict === 'adresse').length} adresse(s), ${faitsL.filter((r) => r.verdict === 'coordonnees').length} repère(s) à coordonnées (exceptions), ${echecs.length} échec(s).`);
  process.exit(echecs.length ? 1 : 0);
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });

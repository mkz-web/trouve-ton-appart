#!/usr/bin/env node
/**
 * check-liens-externes.js : les liens SORTANTS du site répondent-ils encore ?
 * ------------------------------------------------------------------
 * Exécution   : node site/check-liens-externes.js [--page=/chemin/] [--inclure-maps] [--concurrence=N] [--verbeux]
 * Runtime     : Node.js >= 14 · Dépendances : AUCUNE (réseau requis : c'est le but)
 * Entrée      : site/dist/ (lancer node site/build.js avant)
 * Sortie 0    : aucun lien sortant mort ; sortie 1 : au moins un lien mort, listé avec les
 *               pages qui le portent.
 * ------------------------------------------------------------------
 *
 * Pourquoi (10/09/2026) : check-links.js ne regarde que les liens INTERNES. Les liens
 * sortants, eux, meurent sans rien casser chez nous : le champ de candidature du jeu CNOUS
 * pointait 107 pages régionales en 404 (76 Paris, 30 Versailles, 1 Créteil), servies sous
 * « Demander un logement » depuis le 11/06/2026, signalé par Mickaël sur Versailles. Ce
 * contrôle est HORS de check-tout.js (barrière sans réseau, déterministe) : le lancer à la
 * demande, avant une publication qui touche aux annuaires ou aux sources des guides, et
 * périodiquement.
 *
 * Ce qui est jugé mort : 404, 410, 5xx, hôte introuvable, connexion refusée, délai dépassé
 * (après un second essai), et un 200 dont le titre dit « page introuvable » (soft-404).
 * Ce qui n'est PAS jugé : 403 et 429, qui viennent d'un anti-robot (Légifrance sert un
 * 403 Datadome à tout script, Action Logement aussi) : listés en « non mesurable », à
 * vérifier au navigateur, jamais comptés comme morts ni comme vivants. Les 728 liens
 * Google Maps des annuaires sont exclus par défaut (dynamiques, tous construits par le même
 * gabarit : un échantillon se rejoue au navigateur), --inclure-maps les ajoute.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIST = path.join(__dirname, 'dist');
const ARGS = process.argv.slice(2);
const opt = (n) => { const a = ARGS.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const VERBEUX = ARGS.includes('--verbeux');
const INCLURE_MAPS = ARGS.includes('--inclure-maps');
const PAGE = opt('page');
const CONCURRENCE = opt('concurrence') ? Number(opt('concurrence')) : 8;
if (!(CONCURRENCE >= 1 && CONCURRENCE <= 30)) { console.error('--concurrence doit être entre 1 et 30'); process.exit(2); }
const HOTES_DU_SITE = new Set(['trouve-ton-appart.fr', 'www.trouve-ton-appart.fr']);
/* Liens de la barre « résumer avec l'IA » (barreIa() de build.js) : cinq assistants par guide,
   tous construits par le même gabarit, tous en 403 pour un script (anti-robot) et mesurés au
   navigateur par le skill barre-resume-ia. 120 « non mesurables » qui noieraient le rapport :
   exclus, comme Google Maps. */
const HOTES_BARRE_IA = new Set(['claude.ai', 'chatgpt.com', 'www.perplexity.ai', 'chat.mistral.ai']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const RE_SOFT_404 = /page (not found|introuvable)|page n'existe|erreur 404|\b404\b/i;

if (!fs.existsSync(DIST)) { console.error('site/dist/ absent : lancer node site/build.js d\'abord'); process.exit(2); }

/* ---------- collecte ---------- */
const pages = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.html')) pages.push(p);
  }
})(DIST);
const cheminDe = (p) => '/' + path.relative(DIST, p).split(path.sep).join('/').replace(/index\.html$/, '');
const liens = new Map(); // url -> Set(pages)
const decoder = (h) => h.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
for (const p of pages) {
  const chemin = cheminDe(p);
  if (PAGE && chemin !== PAGE) continue;
  const s = fs.readFileSync(p, 'utf8');
  const re = /href="(https?:\/\/[^"]+)"/g;
  let m;
  while ((m = re.exec(s))) {
    const u = decoder(m[1]);
    let hote; try { hote = new URL(u).hostname; } catch (e) { continue; }
    if (HOTES_DU_SITE.has(hote) || HOTES_BARRE_IA.has(hote)) continue;
    if (!INCLURE_MAPS && /^https:\/\/www\.google\.com\/maps\//.test(u)) continue;
    if (!liens.has(u)) liens.set(u, new Set());
    liens.get(u).add(chemin);
  }
}
if (!liens.size) { console.error(PAGE ? `aucun lien sortant sur ${PAGE} (page inconnue ?)` : 'aucun lien sortant trouvé : dist vide ?'); process.exit(2); }

/* ---------- mesure ---------- */
function get(u, sauts) {
  return new Promise((res) => {
    let url; try { url = new URL(u); } catch (e) { return res({ etat: 'mort', detail: 'URL invalide' }); }
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.get(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, timeout: 20000 }, (r) => {
      const code = r.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && r.headers.location) {
        r.resume();
        if (sauts >= 5) return res({ etat: 'mort', detail: 'boucle de redirections' });
        return res(get(new URL(r.headers.location, url).href, sauts + 1).then((x) => ({ ...x, final: x.final || new URL(r.headers.location, url).href })));
      }
      let b = '';
      r.on('data', (c) => { if (b.length < 100000) b += c; });
      r.on('end', () => {
        const titre = ((b.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim();
        if (code >= 200 && code < 300) return res(RE_SOFT_404.test(titre) ? { etat: 'mort', detail: `${code} mais titre « ${titre.slice(0, 60)} » (soft-404)` } : { etat: 'ok', detail: String(code) });
        if (code === 403 || code === 429) return res({ etat: 'non mesurable', detail: `${code} (anti-robot probable)` });
        if (code === 404 || code === 410 || code >= 500) return res({ etat: 'mort', detail: `${code}${titre ? ' « ' + titre.slice(0, 60) + ' »' : ''}` });
        return res({ etat: 'attention', detail: String(code) });
      });
    });
    req.on('timeout', () => { req.destroy(); res({ etat: 'delai', detail: 'délai de 20 s dépassé' }); });
    // Node ne va pas chercher un certificat intermédiaire manquant (les navigateurs si, par
    // AIA) : UNABLE_TO_VERIFY_LEAF_SIGNATURE n'est pas un lien mort mais une chaîne incomplète
    // côté serveur (france-renov.gouv.fr et monprojet.anah.gouv.fr le 10/09/2026, ouverts sans
    // avertissement au navigateur). Un certificat expiré, lui, reste un défaut réel.
    req.on('error', (e) => res(e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ? { etat: 'non mesurable', detail: 'chaîne de certificats incomplète pour Node (vérifier au navigateur)' } : { etat: 'mort', detail: 'erreur ' + (e.code || e.message) }));
  });
}
async function mesurer(u) {
  let r = await get(u, 0);
  if (r.etat === 'delai' || (r.etat === 'mort' && /^erreur/.test(r.detail))) r = await get(u, 0); // second essai sur panne réseau
  if (r.etat === 'delai') r = { etat: 'mort', detail: r.detail };
  return r;
}

(async () => {
  const urls = [...liens.keys()].sort();
  console.log(`${urls.length} lien(s) sortant(s) distinct(s) sur ${PAGE ? PAGE : pages.length + ' pages'}${INCLURE_MAPS ? ' (Google Maps inclus)' : ''}`);
  const resultats = new Map();
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCE }, async () => {
    while (i < urls.length) { const u = urls[i++]; resultats.set(u, await mesurer(u)); }
  }));
  const comptes = {};
  for (const r of resultats.values()) comptes[r.etat] = (comptes[r.etat] || 0) + 1;
  const lister = (etat, titre) => {
    const l = urls.filter((u) => resultats.get(u).etat === etat);
    if (!l.length) return;
    console.log(`\n${titre} (${l.length}) :`);
    for (const u of l) { const p = [...liens.get(u)]; console.log(`  - ${u}\n      ${resultats.get(u).detail} | ${p.length} page(s) : ${p.slice(0, 3).join(', ')}${p.length > 3 ? ', …' : ''}`); }
  };
  lister('mort', 'MORTS');
  lister('attention', 'À REGARDER (code inattendu)');
  lister('non mesurable', 'NON MESURABLES (anti-robot : vérifier au navigateur)');
  if (VERBEUX) lister('ok', 'OK');
  console.log(`\nBilan : ${comptes.ok || 0} ok, ${comptes.mort || 0} mort(s), ${comptes.attention || 0} à regarder, ${comptes['non mesurable'] || 0} non mesurable(s).`);
  if (comptes.mort) { console.log('ÉCHEC : au moins un lien sortant est mort.'); process.exit(1); }
  console.log('OK : aucun lien sortant mort.');
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });

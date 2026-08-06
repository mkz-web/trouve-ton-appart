#!/usr/bin/env node
/* indexnow.js : soumet les URLs du site aux moteurs participant au protocole
 * IndexNow (Bing, Seznam, Naver, Yandex...) via le relais api.indexnow.org.
 * Google n'y participe pas : l'indexation Google reste le circuit GSC
 * (sitemap + inspection). L'intérêt GEO du ping : l'index Bing alimente
 * ChatGPT Search.
 *
 * Commande :
 *   node site/indexnow.js                          → toutes les URLs du sitemap de PROD
 *   node site/indexnow.js /guides/visale/ ...      → URLs ciblées
 *
 * À lancer APRÈS chaque publication vérifiée : le script lit le sitemap de
 * PRODUCTION, jamais le dist local, on ne soumet que ce qui est réellement
 * en ligne. Fail-closed : il vérifie d'abord que la clé est servie en prod
 * (sinon les moteurs rejetteraient le lot en silence).
 *
 * Runtime minimal : Node >= 14 (https natif). Dépendances : aucune.
 */
'use strict';
const https = require('https');
const CLE = require('./indexnow-cle.js');
const HOTE = 'trouve-ton-appart.fr';

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error(`HTTP ${r.statusCode} sur ${url}`)); }
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

(async () => {
  const args = process.argv.slice(2);
  let urls;
  if (args.length) {
    urls = args.map(u => u.startsWith('http') ? u : `https://${HOTE}${u}`);
  } else {
    const xml = await get(`https://${HOTE}/sitemap.xml`);
    urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    if (!urls.length) throw new Error('sitemap de production vide ou illisible : rien à soumettre');
  }

  const cleServie = await get(`https://${HOTE}/${CLE}.txt`);
  if (cleServie.trim() !== CLE) throw new Error(`la clé servie en prod ne correspond pas à ${CLE}.txt : déployer d'abord`);

  const corps = JSON.stringify({
    host: HOTE,
    key: CLE,
    keyLocation: `https://${HOTE}/${CLE}.txt`,
    urlList: urls,
  });
  const code = await new Promise((res, rej) => {
    const q = https.request({
      hostname: 'api.indexnow.org',
      path: '/indexnow',
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corps) },
    }, r => { r.resume(); r.on('end', () => res(r.statusCode)); });
    q.on('error', rej);
    q.end(corps);
  });
  /* 200 = reçu, 202 = reçu (clé en cours de vérification côté moteur). */
  if (code !== 200 && code !== 202) throw new Error(`api.indexnow.org a répondu HTTP ${code}`);
  console.log(`OK : ${urls.length} URL(s) soumises à IndexNow (HTTP ${code}), clé vérifiée en prod.`);
})().catch(e => { console.error('ÉCHEC :', e.message); process.exit(1); });

/*
 * check-seo.js — vérification SEO/GEO programmatique du dist/ généré.
 * Exécution : node site/check-seo.js [chemin dist]   (défaut : site/dist)
 * Dépendances : aucune. Node 14+ natif.
 *
 * Contrôles (règles MKZ / décisions projet du 12/06/2026) :
 *  1. <title> ≤ 65 caractères, meta description ≤ 160, présents sur chaque page.
 *  2. Chaque bloc <script type="application/ld+json"> reparse en JSON.parse
 *     (après dé-échappement <) :
 *     - ItemList : chaque itemListElement DOIT porter un objet item complet
 *       (@type concret + name + url), sinon erreur GSC « Champ item manquant ».
 *     - BreadcrumbList : item requis sur tous les maillons SAUF le dernier,
 *       name requis partout.
 * Sort avec exit(1) à la moindre violation : à passer avant chaque publication.
 */
const fs = require('fs');
const path = require('path');

const dist = process.argv[2] || path.join(__dirname, 'dist');
if (!fs.existsSync(dist)) { console.error(`Introuvable : ${dist} (lancer node site/build.js d'abord)`); process.exit(1); }

const htmlFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) htmlFiles.push(p);
  }
})(dist);

const errors = [];
let nTitles = 0, nMetas = 0, nLd = 0, maxTitle = ['', 0], maxMeta = ['', 0];
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');

for (const f of htmlFiles) {
  const rel = '/' + path.relative(dist, f).replace(/\\/g, '/');
  const html = fs.readFileSync(f, 'utf8');

  const tm = html.match(/<title>([^<]*)<\/title>/);
  if (!tm) errors.push(`${rel} : pas de <title>`);
  else {
    nTitles++;
    const t = unesc(tm[1]);
    if (t.length > maxTitle[1]) maxTitle = [`${rel} « ${t} »`, t.length];
    if (t.length > 65) errors.push(`${rel} : title ${t.length} car. > 65 : « ${t} »`);
  }

  const mm = html.match(/<meta name="description" content="([^"]*)"/);
  if (!mm) errors.push(`${rel} : pas de meta description`);
  else {
    nMetas++;
    const m = unesc(mm[1]);
    if (m.length > maxMeta[1]) maxMeta = [`${rel} (${m.length})`, m.length];
    if (m.length > 160) errors.push(`${rel} : meta ${m.length} car. > 160`);
  }

  const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let mLd;
  while ((mLd = ldRe.exec(html))) {
    nLd++;
    let obj;
    try { obj = JSON.parse(mLd[1].replace(/\\u003c/gi, '<')); }
    catch (e) { errors.push(`${rel} : JSON-LD invalide (${e.message})`); continue; }
    for (const node of Array.isArray(obj) ? obj : [obj]) checkLd(rel, node);
  }
}

function checkLd(rel, node) {
  if (!node || typeof node !== 'object') return;
  if (node['@type'] === 'ItemList' && Array.isArray(node.itemListElement)) {
    node.itemListElement.forEach((el, i) => {
      const it = el && el.item;
      if (!it || typeof it !== 'object') errors.push(`${rel} : ItemList[${i}] sans objet item`);
      else if (!it['@type'] || !it.name || !it.url) errors.push(`${rel} : ItemList[${i}] item incomplet (@type/name/url)`);
    });
  }
  if (node['@type'] === 'BreadcrumbList' && Array.isArray(node.itemListElement)) {
    const n = node.itemListElement.length;
    node.itemListElement.forEach((el, i) => {
      if (!el.name) errors.push(`${rel} : BreadcrumbList[${i}] sans name`);
      if (i < n - 1 && !el.item) errors.push(`${rel} : BreadcrumbList[${i}] (non-final) sans item`);
    });
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(x => checkLd(rel, x));
    else if (v && typeof v === 'object') checkLd(rel, v);
  }
}

console.log(`${htmlFiles.length} pages · ${nTitles} titles · ${nMetas} metas · ${nLd} blocs JSON-LD`);
console.log(`Title le plus long  : ${maxTitle[1]} car. → ${maxTitle[0]}`);
console.log(`Meta la plus longue : ${maxMeta[1]} car. → ${maxMeta[0]}`);
if (errors.length) { console.error(`\n${errors.length} ERREUR(S) :`); errors.forEach(e => console.error('  - ' + e)); process.exit(1); }
console.log('\nOK — tout est conforme (titles ≤ 65, metas ≤ 160, JSON-LD valides, règles ItemList/BreadcrumbList respectées).');

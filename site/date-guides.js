#!/usr/bin/env node
/* date-guides.js : dates réelles de publication et de modification par guide.
 * La carte site/data/dates-guides.json fait foi : elle porte, par slug FR et
 * EN, la date de première publication, la date de dernière modification DE
 * FOND et l'empreinte du contenu qui la justifie. L'empreinte couvre les
 * champs de substance (titre, méta, h1, intro, sections, faq, sources) et
 * EXCLUT le tldr : un résumé se corrige avec son guide, jamais l'inverse.
 *
 * Deux usages :
 *   - module : build.js appelle controle() et REFUSE de construire si un
 *     guide a changé sans mise à jour de sa date (fail-closed : pas de
 *     « Mis à jour le » mensonger, ni en page, ni en JSON-LD, ni au sitemap) ;
 *   - commande : node site/date-guides.js [AAAA-MM-JJ] recalcule les
 *     empreintes et date les guides nouveaux ou modifiés (au jour donné,
 *     sinon aujourd'hui), à lancer avant commit après toute édition de
 *     guides.json ou en.json.
 *
 * Runtime minimal : Node >= 14 (fs, path, crypto natifs). Dépendances : aucune. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FICHIER = path.join(__dirname, 'data', 'dates-guides.json');
const CHAMPS = ['title', 'metaDescription', 'h1', 'intro', 'sections', 'faq', 'sourcesOfficielles'];

const empreinte = (g) => crypto.createHash('sha256')
  .update(JSON.stringify(CHAMPS.map(c => g[c] === undefined ? null : g[c])))
  .digest('hex').slice(0, 16);

function controle(guidesFr, guidesEn) {
  if (!fs.existsSync(FICHIER)) {
    throw new Error('dates-guides.json absent : lancer node site/date-guides.js');
  }
  const carte = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
  const rates = [];
  for (const [langue, liste] of [['fr', guidesFr], ['en', guidesEn]]) {
    for (const g of liste) {
      const e = (carte[langue] || {})[g.slug];
      if (!e) rates.push(`${langue}/${g.slug} : absent de dates-guides.json`);
      else if (e.empreinte !== empreinte(g)) rates.push(`${langue}/${g.slug} : contenu modifié sans mise à jour de sa date`);
    }
  }
  if (rates.length) {
    throw new Error(`dates-guides.json désynchronisé :\n  - ${rates.join('\n  - ')}\n  → lancer : node site/date-guides.js`);
  }
  return carte;
}

module.exports = { empreinte, controle, FICHIER };

if (require.main === module) {
  const G = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'guides.json'), 'utf8'));
  const EN = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'en.json'), 'utf8')).guides;
  const carte = fs.existsSync(FICHIER) ? JSON.parse(fs.readFileSync(FICHIER, 'utf8')) : { fr: {}, en: {} };
  const jour = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date().toISOString().slice(0, 10);
  let changements = 0;
  for (const [langue, liste] of [['fr', G], ['en', EN]]) {
    carte[langue] = carte[langue] || {};
    for (const g of liste) {
      const e = empreinte(g);
      const actuel = carte[langue][g.slug];
      if (!actuel) { carte[langue][g.slug] = { publie: jour, modifie: jour, empreinte: e }; changements++; console.log(`nouveau  ${langue}/${g.slug} → ${jour}`); }
      else if (actuel.empreinte !== e) { actuel.modifie = jour; actuel.empreinte = e; changements++; console.log(`modifié  ${langue}/${g.slug} → ${jour}`); }
    }
    for (const slug of Object.keys(carte[langue])) {
      if (!liste.some(g => g.slug === slug)) { delete carte[langue][slug]; changements++; console.log(`retiré   ${langue}/${slug}`); }
    }
  }
  fs.writeFileSync(FICHIER, JSON.stringify(carte, null, 2) + '\n');
  console.log(changements ? `dates-guides.json mis à jour (${changements} entrée(s)).` : 'Aucun changement de contenu : dates inchangées.');
}

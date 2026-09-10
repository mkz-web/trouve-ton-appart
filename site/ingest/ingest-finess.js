#!/usr/bin/env node
/**
 * ingest-finess.js : FJT et résidences autonomie d'Île-de-France (FINESS).
 * ------------------------------------------------------------------
 * Exécution   : node ingest-finess.js [--force]
 * Runtime     : Node.js >= 14 · Dépendances : AUCUNE
 * Source      : FINESS « Extraction du fichier des établissements »
 *               (ministère des Solidarités et de la Santé / ANS) via le
 *               permalink data.gouv.fr (~48 Mo, national, re-téléchargé
 *               dans .cache/ ; --force pour rafraîchir).
 *               Format : CSV ';' SANS en-tête, 2 sections mélangées
 *               (lignes « structureet » puis « geolocalisation »),
 *               coordonnées Lambert-93 (EPSG:2154).
 * Licence     : Licence Ouverte (Etalab).
 * Sorties     : site/data/open/fjt.json (catégorie 257)
 *               site/data/open/residences-autonomie.json (catégorie 202)
 * ⚠ Le flux « extraction stock » doit être remplacé à l'été 2026 par les
 *   datasets finess-structures de l'ANS : prévoir la migration.
 * ------------------------------------------------------------------
 */
'use strict';

const { getCached, lambert93ToWgs84, frenchTitleCase, parseCsv, cleanCedex, writeDataset, DEPS_IDF } = require('./lib');

const URL_FINESS = 'https://www.data.gouv.fr/fr/datasets/r/98f3161f-79ff-4f16-8f6a-6d571a80fea2';

const CATEGORIES = {
  257: { dataset: 'fjt', label: 'Foyer de jeunes travailleurs' },
  202: { dataset: 'residences-autonomie', label: 'Résidence autonomie' },
};

/* Types de voie FINESS (abréviations) → libellés. */
const TYPVOIE = {
  R: 'rue', AV: 'avenue', BD: 'boulevard', PL: 'place', RTE: 'route', CHE: 'chemin',
  IMP: 'impasse', ALL: 'allée', SQ: 'square', CRS: 'cours', QU: 'quai', QUAI: 'quai',
  PROM: 'promenade', CITE: 'cité', RPT: 'rond-point', SEN: 'sente', SENT: 'sentier',
  PAS: 'passage', PSG: 'passage', VOI: 'voie', VOIE: 'voie', RLE: 'ruelle', GR: 'grande rue',
  HAM: 'hameau', CAR: 'carrefour', ESP: 'esplanade', DOM: 'domaine', RES: 'résidence',
  LOT: 'lotissement', FG: 'faubourg', CHS: 'chaussée', MAIL: 'mail', PARC: 'parc', ZAC: 'ZAC',
};

/* Sigles à conserver en capitales après mise en casse française. */
const SIGLES = new Set(['fjt', 'ftm', 'chrs', 'aljt', 'adef', 'arpej', 'cllaj', 'urhaj', 'alfi', 'snl', 'oph', 'hlm', 'cpcv', 'mgel', 'ccas', 'apf', 'arfo', 'arefo', 'clous']);
/* FINESS est en capitales NON accentuées : on restaure les accents des mots fréquents. */
const ACCENTS = { residence: 'résidence', etablissement: 'établissement', hopital: 'hôpital', aines: 'aînés', age: 'âge', agees: 'âgées' };
function nomPropre(s) {
  return frenchTitleCase(s).replace(/[A-Za-zà-ÿ]+/g, (w) => {
    const lo = w.toLowerCase();
    if (SIGLES.has(lo)) return w.toUpperCase();
    if (ACCENTS[lo]) return w[0] === w[0].toUpperCase() ? ACCENTS[lo][0].toUpperCase() + ACCENTS[lo].slice(1) : ACCENTS[lo];
    return w;
  });
}

const telFr = (t) => (t && /^\d{10}$/.test(t) ? t.match(/\d{2}/g).join(' ') : t || null);

(async () => {
  console.log('FINESS : FJT et résidences autonomie Île-de-France');
  const buf = await getCached(URL_FINESS, 'finess-etablissements.csv');
  const lines = buf.toString('utf8').split('\n');
  console.log(`  ${lines.length} lignes nationales`);

  /* Adresses FINESS fausses, corrigées sur preuve (10/09/2026) : pour chacune, la Base Adresse
     Nationale résout l'adresse corrigée à 0 m du point FINESS, et l'adresse d'origine n'existe
     pas (Google Maps rendait une liste de résultats ou un « correspondance partielle »). */
  const CORRECTIONS = {
    '750064826': { adresse: '8 rue Laure Diebold' },   // « Laurie Liebold » : coquille, BAN score 0,97
    '910018670': { adresse: '1 avenue du Canal' },     // « allée du Canal » : type de voie faux, BAN score 0,65
  };
  const kept = new Map(); // nofinesset → record en cours
  const geo = new Map();  // nofinesset → {lat, lon}

  for (const line of lines) {
    // FINESS ne met pas de guillemets en pratique : split simple, et repli
    // sur le vrai parseur CSV pour les rares lignes qui en contiendraient.
    const c = line.includes('"') ? (parseCsv(line, ';')[0] || []) : line.split(';');
    if (c[0] === 'structureet') {
      const dep = c[13], cat = c[18];
      if (!DEPS_IDF.includes(dep) || !CATEGORIES[cat]) continue;
      const [cpBrut, ...villeParts] = (c[15] || '').split(' ');
      const { cp, commune } = cleanCedex(/^\d{5}$/.test(cpBrut) ? cpBrut : null, villeParts.join(' '));
      const adresse = [c[7], TYPVOIE[c[8]] || (c[8] || '').toLowerCase(), frenchTitleCase(c[9] || '', false)]
        .filter(Boolean).join(' ').trim();
      kept.set(c[1], {
        finess: c[1],
        categorie: cat,
        nom: nomPropre(c[3] || c[4]),
        adresse: (CORRECTIONS[c[1]] && CORRECTIONS[c[1]].adresse) || adresse || null,
        cp,
        commune: commune ? frenchTitleCase(commune) : null,
        dep,
        tel: telFr(c[16]),
        ouverture: (c[28] || '').slice(0, 4) || null,
        lat: null, lon: null,
      });
    } else if (c[0] === 'geolocalisation') {
      const x = Number(c[2]), y = Number(c[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && x > 0) geo.set(c[1], { x, y });
    }
  }

  for (const [finess, { x, y }] of geo) {
    const r = kept.get(finess);
    if (!r) continue;
    const { lat, lon } = lambert93ToWgs84(x, y);
    // Garde-fou : un point IdF est dans [48,49.4] × [1.4,3.6].
    if (lat > 47.5 && lat < 50 && lon > 1 && lon < 4) { r.lat = +lat.toFixed(6); r.lon = +lon.toFixed(6); }
  }

  for (const [cat, { dataset, label }] of Object.entries(CATEGORIES)) {
    const records = [...kept.values()].filter((r) => r.categorie === cat)
      .map(({ categorie, ...r }) => r)
      .sort((a, b) => a.dep.localeCompare(b.dep) || (a.cp || '').localeCompare(b.cp || '') || a.nom.localeCompare(b.nom, 'fr'));
    const geoles = records.filter((r) => r.lat != null).length;
    console.log(`  ${label} : ${records.length} en IdF (${geoles} géolocalisées)`);
    writeDataset(dataset, records, {
      source: `FINESS : extraction des établissements, catégorie ${cat} (${label})`,
      sourceUrl: URL_FINESS,
      portal: 'data.gouv.fr',
      license: 'Licence Ouverte / Open Licence (Etalab)',
      attribution: 'Source : FINESS, ministère des Solidarités et de la Santé / ANS, via data.gouv.fr (Licence Ouverte)',
    });
  }
})().catch((e) => { console.error('ÉCHEC ingest-finess :', e.message); process.exit(1); });

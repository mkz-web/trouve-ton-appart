#!/usr/bin/env node
/**
 * ingest-encadrement.js : loyers de référence parisiens (encadrement).
 * ------------------------------------------------------------------
 * Exécution   : node ingest-encadrement.js [--force]
 * Runtime     : Node.js >= 14 · Dépendances : AUCUNE
 * Source      : Ville de Paris (Direction du Logement et de l'Habitat),
 *               opendata.paris.fr, dataset logement-encadrement-des-loyers.
 *               Export allégé (sans geo_shape) filtré sur le dernier millésime.
 * Licence     : ODbL, attribution obligatoire « Ville de Paris / opendata.paris.fr ».
 * Sortie      : site/data/open/encadrement-loyers-paris.json
 * ------------------------------------------------------------------
 */
'use strict';

const { getJson, writeDataset } = require('./lib');

const BASE = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/logement-encadrement-des-loyers';
const SELECT = 'select=annee%2Cid_zone%2Cid_quartier%2Cnom_quartier%2Cpiece%2Cepoque%2Cmeuble_txt%2Cref%2Cmax%2Cmin';

(async () => {
  console.log('Encadrement des loyers : Paris');
  // Détermine le millésime le plus récent réellement disponible (annee est une STRING).
  const years = await getJson(`${BASE}/records?select=annee&group_by=annee&order_by=annee%20desc&limit=20`);
  const annee = years.results[0].annee;
  console.log(`  millésime le plus récent : ${annee}`);

  const raw = await getJson(`${BASE}/exports/json?where=annee%3D%22${annee}%22&${SELECT}`);

  const records = raw.map((r) => ({
    quartierId: r.id_quartier,
    quartier: r.nom_quartier,
    zone: r.id_zone,
    pieces: r.piece,           // 1, 2, 3, 4 (= 4 et plus)
    epoque: r.epoque,          // "Avant 1946" | "1946-1970" | "1971-1990" | "Apres 1990"
    meuble: r.meuble_txt === 'meublé',
    ref: r.ref,                // loyer de référence €/m² hors charges
    refMajore: r.max,          // plafond légal (+20 %)
    refMinore: r.min,          // plancher (-30 %)
  })).sort((a, b) => a.quartierId - b.quartierId || a.pieces - b.pieces || a.epoque.localeCompare(b.epoque) || (a.meuble ? 1 : 0) - (b.meuble ? 1 : 0));

  // Garde-fous : 80 quartiers × 4 pièces × 4 époques × 2 (meublé) = 2 560.
  const quartiers = new Set(records.map((r) => r.quartierId));
  if (records.length !== 2560 || quartiers.size !== 80) {
    console.log(`  ! attendu 2560 records / 80 quartiers, obtenu ${records.length} / ${quartiers.size}, vérifier le dataset`);
  }

  writeDataset('encadrement-loyers-paris', records, {
    source: 'Ville de Paris, Logement : encadrement des loyers',
    sourceUrl: `${BASE}/exports/json?where=annee%3D%22${annee}%22&${SELECT}`,
    portal: 'opendata.paris.fr',
    license: 'Open Database License (ODbL)',
    attribution: 'Source : Ville de Paris, opendata.paris.fr, sous licence ODbL',
    millesime: annee,
  });
})().catch((e) => { console.error('ÉCHEC ingest-encadrement :', e.message); process.exit(1); });

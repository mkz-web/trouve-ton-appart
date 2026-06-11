#!/usr/bin/env node
/**
 * ingest-rpls.js — Parc locatif social par commune en Île-de-France.
 * ------------------------------------------------------------------
 * Exécution   : node ingest-rpls.js [--force]
 * Runtime     : Node.js >= 14 · Dépendances : AUCUNE
 * Sources (3, jointes sur le code INSEE commune) :
 *   1. INSEE « RPLS au 1er janvier 2024 » (ZIP → data_RPLS2024_COM.csv) :
 *      parc, vacance, rotation, loyers €/m². ⚠️ ne couvre que les communes
 *      ayant ≥ 1 IRIS ; Paris y figure en double (75056 + arrondissements).
 *   2. data.gouv.fr « Communes et inventaire SRU » (CSV, Windows-1252) :
 *      logements retenus SRU, taux SRU, statut déficitaire/carencé.
 *      ⚠️ décompte SRU ≠ décompte RPLS (assiettes différentes).
 *   3. data.iledefrance.fr « Zonage ABC » : zone Abis/A/B1/B2/C par commune
 *      (+ noms de communes en casse propre, absents du fichier INSEE).
 * Licence     : Licence Ouverte v2.0 (Etalab) pour les trois.
 * Sortie      : site/data/open/logement-social-communes.json
 * ------------------------------------------------------------------
 */
'use strict';

const { getCached, getJson, unzipEntry, csvToObjects, numFr, writeDataset, DEPS_IDF } = require('./lib');

const URL_INSEE = 'https://www.insee.fr/fr/statistiques/fichier/8736658/RPLS_01-01-2024_Iris.zip';
const URL_SRU = 'https://www.data.gouv.fr/fr/datasets/r/59379519-0fa6-4510-be06-a97d02fdef18';
const URL_ZONAGE = 'https://data.iledefrance.fr/api/explore/v2.1/catalog/datasets/logement-liste-des-communes-selon-le-zonage-abc/exports/json?select=codgeo%2Cdep%2Clibgeo%2Czonage_en_vigueur_depuis_le_5_septembre_2025';

const isIdf = (code) => DEPS_IDF.includes(String(code).slice(0, 2));
/** 75101 → « Paris 1ᵉʳ » … 75120 → « Paris 20ᵉ ». */
const arrName = (code) => {
  const n = Number(String(code).slice(3));
  return `Paris ${n}${n === 1 ? 'er' : 'e'}`;
};

/* Communes du RPLS 2024 absentes des référentiels 2025 (fusions de communes) :
 * le zonage ABC et l'inventaire SRU suivent la géographie 2025, le RPLS la
 * géographie 2024. Sans repli, leurs logements disparaîtraient des agrégats. */
const GEO_REPLI = {
  93059: {
    nom: 'Pierrefitte-sur-Seine',
    zoneDe: '93066',
    note: 'Commune fusionnée avec Saint-Denis au 1ᵉʳ janvier 2025 ; chiffres RPLS au 1ᵉʳ janvier 2024, comptés séparément (géographie 2024).',
  },
};

(async () => {
  console.log('RPLS / SRU / zonage — logement social par commune Île-de-France');

  /* 1. INSEE RPLS agrégé commune (ZIP) */
  const zip = await getCached(URL_INSEE, 'RPLS_01-01-2024_Iris.zip');
  const csv = unzipEntry(zip, /data_RPLS2024_COM\.csv$/i).data.toString('utf8');
  const insee = csvToObjects(csv, ';').filter((r) => isIdf(r.CodGeo));
  console.log(`  INSEE RPLS : ${insee.length} lignes IdF (dont Paris + arrondissements)`);

  /* 2. Inventaire SRU (CSV Windows-1252 ≈ latin1, en-têtes irréguliers) */
  const sruBuf = await getCached(URL_SRU, 'inventaire-sru.csv');
  const sruAll = csvToObjects(sruBuf.toString('latin1'), ';');
  // L'en-tête « Nombre_lls_ Inventaire_au_01_01_2024 » contient un espace : on
  // retrouve les colonnes par motif plutôt que par nom exact.
  const keys = Object.keys(sruAll[0]);
  const kLls = keys.find((k) => /Nombre_lls/i.test(k));
  const kTaux = keys.find((k) => /Taux_SRU_au/i.test(k));
  const kPop = keys.find((k) => /Population_municipale/i.test(k));
  const sru = sruAll.filter((r) => DEPS_IDF.includes(r.Code_Departement));
  console.log(`  SRU : ${sru.length} communes IdF`);

  /* 3. Zonage ABC + noms de communes */
  const zonage = (await getJson(URL_ZONAGE)).filter((r) => isIdf(r.codgeo));
  const nomDe = new Map(zonage.map((r) => [r.codgeo, r.libgeo]));
  const zoneDe = new Map(zonage.map((r) => [r.codgeo, r.zonage_en_vigueur_depuis_le_5_septembre_2025]));
  console.log(`  Zonage ABC : ${zonage.length} communes IdF`);

  /* Jointure : une entrée par commune (codes arrondissements 751xx inclus, marqués) */
  const communes = new Map();
  const entry = (code) => {
    if (!communes.has(code)) {
      const repli = GEO_REPLI[code] || {};
      communes.set(code, {
        code,
        nom: code.startsWith('751') && code !== '75056' ? arrName(code) : (nomDe.get(code) || repli.nom || null),
        dep: code.startsWith('751') ? '75' : code.slice(0, 2),
        arrondissement: code.startsWith('751') && code !== '75056',
        zone: zoneDe.get(code) || (code.startsWith('751') ? zoneDe.get('75056') : null) || (repli.zoneDe ? zoneDe.get(repli.zoneDe) : null) || null,
        ...(repli.note ? { note: repli.note } : {}),
        nbLogementsSociaux: null, misesEnService: null, txVacance: null, txRotation: null,
        loyerMoyen: null, loyerMedian: null,
        llsSRU: null, tauxSRU: null, population: null, deficitaire: null, carencee: null,
      });
    }
    return communes.get(code);
  };

  for (const r of insee) {
    const e = entry(r.CodGeo);
    e.nbLogementsSociaux = numFr(r.nbLsPls);
    e.misesEnService = numFr(r.nbLsMes);
    e.txVacance = numFr(r.txVac);
    e.txRotation = numFr(r.txRot);
    e.loyerMoyen = numFr(r.moyLoy);
    e.loyerMedian = numFr(r.medLoy);
  }
  for (const r of sru) {
    const e = entry(r.Code_INSEE_commune);
    e.llsSRU = numFr(r[kLls]);
    e.tauxSRU = numFr(r[kTaux]);
    e.population = numFr(r[kPop]);
    e.deficitaire = r.commune_deficitaire === '1';
    e.carencee = r['Commune_carencée'] === '1' || r['Commune_carencee'] === '1';
  }

  const records = [...communes.values()]
    .filter((e) => e.nom) // sans nom = code inconnu du zonage ET du repli (sécurité)
    .sort((a, b) => a.code.localeCompare(b.code));

  const ecartees = [...communes.values()].filter((e) => !e.nom);
  if (ecartees.length) {
    const parcPerdu = ecartees.reduce((s, e) => s + (e.nbLogementsSociaux || 0), 0);
    console.log(`  ! ${ecartees.length} code(s) écarté(s) faute de nom : ${ecartees.map((e) => e.code).join(', ')} — ${parcPerdu} logements RPLS perdus`);
    if (parcPerdu > 0) {
      console.error('  ÉCHEC : perte de parc non nulle — compléter GEO_REPLI (fusion de communes ?)');
      process.exit(1);
    }
  }

  writeDataset('logement-social-communes', records, {
    source: 'INSEE–SDES RPLS 01/01/2024 (parc, vacance, loyers) ; Ministère de la Transition écologique, inventaire SRU au 01/01/2024, fichier publié 2025 (llsSRU, tauxSRU) ; zonage ABC du 5 septembre 2025',
    sourceUrl: [URL_INSEE, URL_SRU, URL_ZONAGE].join(' | '),
    license: 'Licence Ouverte / Open Licence v2.0 (Etalab)',
    attribution: 'Sources : Insee–SDES, RPLS au 1ᵉʳ janvier 2024 · Ministère de la Transition écologique, inventaire SRU au 1ᵉʳ janvier 2024 · Zonage ABC (arrêté du 5 septembre 2025) — Licence Ouverte',
    millesime: 'RPLS 01/01/2024 · SRU 01/01/2024 · zonage 05/09/2025',
    avertissement: 'nbLogementsSociaux (RPLS) et llsSRU (inventaire SRU) reposent sur des assiettes différentes : ne pas les additionner ni les comparer terme à terme. Paris : la ligne 75056 porte le total communal (sans loyers) ; le détail par arrondissement est porté par les codes 75101-75120 (arrondissement: true).',
  });
})().catch((e) => { console.error('ÉCHEC ingest-rpls :', e.message); process.exit(1); });

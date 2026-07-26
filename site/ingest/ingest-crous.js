#!/usr/bin/env node
/**
 * ingest-crous.js : résidences universitaires CROUS d'Île-de-France.
 * ------------------------------------------------------------------
 * Exécution   : node ingest-crous.js [--force]
 * Runtime     : Node.js >= 14 · Dépendances : AUCUNE
 * Source      : CNOUS via data.enseignementsup-recherche.gouv.fr,
 *               dataset fr_crous_logement_france_entiere (flux officiel
 *               qui alimente trouverunlogement.lescrous.fr).
 * Licence     : Licence Ouverte / Open Licence (Etalab), citer le CNOUS.
 * Sortie      : site/data/open/crous-residences.json
 * ------------------------------------------------------------------
 */
'use strict';

const { getJson, writeDataset, stripHtml, frenchTitleCase, httpsify, cleanCedex, DEPS_IDF } = require('./lib');

const URL_EXPORT = 'https://data.enseignementsup-recherche.gouv.fr/api/explore/v2.1/catalog/datasets/fr_crous_logement_france_entiere/exports/json?where=regions%3D%22%C3%8Ele-de-France%22';

/* Secours pour les adresses sans code postal exploitable : zone CROUS → département. */
const ZONE_DEP = {
  ESSONNE: '91', YVELINES: '78', 'SEINE-ET-MARNE': '77', 'VAL D\'OISE': '95', 'VAL-D\'OISE': '95',
};

function parseAddress(address) {
  // CP francilien, y compris avec espace interne (« 78 990 Élancourt »).
  const m = String(address || '').match(/\b(7[58]|77|9[12345])\s?(\d{3})\b/);
  if (!m) return null;
  const reste = String(address).slice(m.index + m[0].length).replace(/^[\s,.-]+/, '').trim();
  // CEDEX : suffixe retiré de la commune, CP non géographique annulé.
  const { cp, commune } = cleanCedex(m[1] + m[2], frenchTitleCase(reste));
  return { cp, dep: m[1], commune };
}

/* Compléments manuels pour les adresses CNOUS inexploitables (id → champs). */
const COMPLEMENTS = {
  1293: { cp: '91440', commune: 'Bures-sur-Yvette' }, // « Rives de l'Yvette » : adresse sans ville ni CP
  1267: { commune: 'Paris' },                          // « Alésia » : adresse finissant par « 75014 » sans ville
};

(async () => {
  console.log('CROUS : résidences universitaires Île-de-France');
  const raw = await getJson(URL_EXPORT);

  const records = [];
  const rejected = [];
  for (const r of raw) {
    const addr = parseAddress(r.address);
    const zoneDep = ZONE_DEP[String(r.zone || '').toUpperCase().trim()];
    const dep = addr ? addr.dep : zoneDep;
    if (!dep || !DEPS_IDF.includes(dep)) { rejected.push(`${r.id} ${r.title} (${r.address})`); continue; }

    let services = [];
    try {
      const hs = typeof r.house_services === 'string' ? JSON.parse(r.house_services) : r.house_services;
      const list = hs && hs.house_service;
      if (Array.isArray(list)) services = list.map((s) => stripHtml(typeof s === 'string' ? s : (s.label || s.title || ''))).filter(Boolean);
    } catch { /* house_services malformé : tant pis, champ optionnel */ }

    const fix = COMPLEMENTS[r.id] || {};
    records.push({
      id: r.id,
      nom: stripHtml(r.title),
      adresse: stripHtml(r.address),
      cp: (addr && addr.cp) || fix.cp || null,
      commune: (addr && addr.commune) || fix.commune || null,
      dep,
      zone: r.zone || null,
      lat: r.geocalisation ? r.geocalisation.lat : null,
      lon: r.geocalisation ? r.geocalisation.lon : null,
      tel: r.phone || null,
      mail: r.mail || null,
      url: httpsify(r.interneturl || r.crousandgourl),
      bookingUrl: httpsify(r.bookingurl),
      services: services.slice(0, 8),
    });
  }
  records.sort((a, b) => a.dep.localeCompare(b.dep) || (a.cp || '').localeCompare(b.cp || '') || a.nom.localeCompare(b.nom, 'fr'));

  if (rejected.length) console.log(`  ! ${rejected.length} hors Île-de-France exclue(s) : ${rejected.join(' · ')}`);
  writeDataset('crous-residences', records, {
    source: 'CNOUS : Logements CROUS (fr_crous_logement_france_entiere)',
    sourceUrl: URL_EXPORT,
    portal: 'data.enseignementsup-recherche.gouv.fr',
    license: 'Licence Ouverte / Open Licence v2.0 (Etalab)',
    attribution: 'Source : CNOUS, data.enseignementsup-recherche.gouv.fr (Licence Ouverte)',
  });
})().catch((e) => { console.error('ÉCHEC ingest-crous :', e.message); process.exit(1); });

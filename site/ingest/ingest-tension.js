#!/usr/bin/env node
/**
 * ingest-tension.js : tension et délais de la demande de logement social en IdF.
 * ------------------------------------------------------------------------------
 * Runtime     : Node.js >= 14
 * Dépendances : AUCUNE (lib.js maison : https, zlib natifs)
 * Exécution   : node site/ingest/ingest-tension.js [--force]
 * Sortie      : site/data/open/tension-communes.json
 *
 * Source : DRIHL Île-de-France, « socle de données demandes et attributions de
 * logements sociaux », millésime 2025 (Infocentre SNE, traitements DRIHL/SOEE).
 * Licence Ouverte Etalab 2.0, attribution DRIHL obligatoire à l'affichage.
 * Publication annuelle fin juin (millésime N publié en N+1).
 *
 * PIÈGES CÂBLÉS ICI (voir aussi CLAUDE.md) :
 *  - Secret statistique : « - » quand moins de 10 demandes ou attributions → null.
 *  - Le « nombre total de demandes » (tous ordres de choix) contient des doublons
 *    et le producteur interdit de le sommer : on ne retient QUE le choix 1.
 *  - La tension est REPRISE telle quelle (jamais recalculée) pour ne pas diverger
 *    de la méthode officielle.
 *  - Tension = un ratio, PAS une durée. Le délai est une colonne distincte.
 *  - Paris : la ligne commune 75056 est un reliquat « arrondissement non précisé »
 *    (demandes sans localisation fine, 0 attribution) → on lui substitue la ligne
 *    de niveau Département, et les 20 arrondissements gardent leurs valeurs.
 *  - Assiette : le champ des attributions réglementées n'est comparable ni à RPLS
 *    ni à l'inventaire SRU. Ne jamais croiser les dénominateurs.
 */
'use strict';

const lib = require('./lib');

/* Millésime surchargeable pour le baromètre annuel : à la publication du
 * socle N (fin juin N+1), relancer avec --millesime=N. Les libellés de
 * colonnes qui embarquent l'année suivent automatiquement. */
const ARG_MILLESIME = (process.argv.find((a) => a.startsWith('--millesime=')) || '').split('=')[1];
const MILLESIME = ARG_MILLESIME ? Number(ARG_MILLESIME) : 2025;
if (!Number.isInteger(MILLESIME) || MILLESIME < 2024 || MILLESIME > 2100) {
  console.error(`✗ millésime invalide : ${ARG_MILLESIME}`); process.exit(1);
}
const URL = `https://www.drihl.ile-de-france.developpement-durable.gouv.fr/IMG/xlsx/socle_demandes_attributions_${MILLESIME}.xlsx`;
const PAGE = 'https://www.drihl.ile-de-france.developpement-durable.gouv.fr/socle-de-donnees-demandes-et-attributions-de-a1510.html';

/* Colonnes repérées par leur libellé normalisé : résiste à un décalage de
 * colonnes d'un millésime à l'autre, contrairement à un index en dur. */
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const COLS = {
  niveau: 'niveau geographique',
  code: 'code',
  nom: 'nom',
  dep: 'code dep',
  demandes: 'nombre de demandes ciblant le territoire en choix 1 au 31/12/' + MILLESIME,
  attributions: "nombre d'attributions en " + MILLESIME,
  tension: 'nombre de demandes pour une attribution',
  delai: "delai median d'attribution (en mois)",
  anc5ans: 'part des menages ayant depose leur demande il y a au moins 5 ans',
  t1: 'nombre de demandes pour une attribution - t1',
  t3: 'nombre de demandes pour une attribution - t3',
};

/** Valeur numérique d'une cellule, en neutralisant le secret statistique. */
const val = (cells, i) => {
  if (i == null) return null;
  const raw = String(cells[i] ?? '').trim();
  if (raw === '' || raw === '-' || /secret/i.test(raw)) return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

async function main() {
  console.log('Tension de la demande de logement social (DRIHL / Infocentre SNE)');
  const buf = await lib.getCached(URL, `socle-drihl-${MILLESIME}.xlsx`);
  const rows = lib.parseXlsx(buf, 'Ensemble');
  if (rows.length < 100) throw new Error(`Onglet Ensemble trop court (${rows.length} lignes)`);

  /* Ligne d'en-têtes : celle qui contient « Niveau géographique ». */
  const hIdx = rows.findIndex((r) => r.some((c) => norm(c) === COLS.niveau));
  if (hIdx < 0) throw new Error('En-têtes introuvables (« Niveau géographique » absent)');
  const header = rows[hIdx].map(norm);
  const idx = {};
  for (const [key, label] of Object.entries(COLS)) {
    const i = header.indexOf(label);
    idx[key] = i >= 0 ? i : null;
    if (i < 0) console.warn(`  ⚠ colonne « ${label} » introuvable (${key})`);
  }
  for (const req of ['niveau', 'code', 'nom', 'demandes', 'attributions', 'tension', 'delai']) {
    if (idx[req] == null) throw new Error(`Colonne obligatoire manquante : ${req}`);
  }

  const body = rows.slice(hIdx + 1).filter((r) => r[idx.code]);
  const ligne = (r, niveauForce) => ({
    code: String(r[idx.code]).trim(),
    nom: String(r[idx.nom] ?? '').trim(),
    niveau: niveauForce || String(r[idx.niveau] ?? '').trim(),
    dep: idx.dep != null ? String(r[idx.dep] ?? '').trim() || null : null,
    demandes: val(r, idx.demandes),
    attributions: val(r, idx.attributions),
    tension: round(val(r, idx.tension), 1),
    delaiMois: round(val(r, idx.delai), 0),
    /* Valeur non arrondie, réservée au TRI des classements : deux communes
     * affichées « 42 mois » ne sont pas à égalité réelle, et trier sur
     * l'arrondi publierait un ordre démontrablement faux. */
    delaiMoisExact: round(val(r, idx.delai), 3),
    /* La source donne une proportion (0,17) ; on stocke un pourcentage (17 %),
     * cohérent avec les autres taux du site (vacance, SRU). */
    partAnc5ans: round(val(r, idx.anc5ans) == null ? null : val(r, idx.anc5ans) * 100, 1),
    tensionT1: round(val(r, idx.t1), 1),
    tensionT3: round(val(r, idx.t3), 1),
  });

  const communes = body.filter((r) => String(r[idx.niveau]).trim() === 'Commune').map((r) => ligne(r));
  const deps = body.filter((r) => String(r[idx.niveau]).trim() === 'Département').map((r) => ligne(r));
  const regionRow = body.find((r) => /gion/i.test(String(r[idx.niveau])));
  const region = regionRow ? ligne(regionRow, 'Région') : null;

  if (!region) throw new Error('Ligne Région introuvable');
  if (deps.length !== 8) throw new Error(`8 départements attendus, ${deps.length} trouvés`);
  if (communes.length < 1000) throw new Error(`Trop peu de communes (${communes.length})`);

  /* Paris : la ligne communale est un reliquat sans attribution ; on lui
   * substitue la ligne départementale (les 20 arrondissements sont intacts). */
  const paris = communes.find((c) => c.code === '75056');
  const dep75 = deps.find((d) => d.code === '75');
  if (paris && dep75) {
    Object.assign(paris, {
      demandes: dep75.demandes, attributions: dep75.attributions,
      tension: dep75.tension, delaiMois: dep75.delaiMois,
      partAnc5ans: dep75.partAnc5ans, tensionT1: dep75.tensionT1, tensionT3: dep75.tensionT3,
      nom: 'Paris',
      note: "Valeurs de l'ensemble de la commune de Paris (niveau départemental du socle) : la ligne communale du fichier ne porte que les demandes sans arrondissement précisé.",
    });
  }

  const avecTension = communes.filter((c) => c.tension != null).length;
  const avecDelai = communes.filter((c) => c.delaiMois != null).length;
  console.log(`  ${communes.length} communes · ${avecTension} avec tension · ${avecDelai} avec délai médian`);
  console.log(`  Région : ${region.tension} demandes pour une attribution, délai médian ${region.delaiMois} mois`);

  lib.writeDataset('tension-communes', communes, {
    source: 'DRIHL Île-de-France : socle de données demandes et attributions de logements sociaux (Infocentre SNE, traitements DRIHL/SOEE)',
    sourceUrl: PAGE,
    fileUrl: URL,
    license: 'Licence Ouverte Etalab 2.0',
    attribution: `DRIHL Île-de-France, socle de données demandes et attributions de logements sociaux, millésime ${MILLESIME} (Infocentre SNE, traitements DRIHL/SOEE)`,
    millesime: MILLESIME,
    dateReference: `Demandes au 31/12/${MILLESIME}, attributions de l'année ${MILLESIME}`,
    avertissement: "Le champ des attributions réglementées n'est comparable ni au parc RPLS ni à l'inventaire SRU (article 55) : ne jamais additionner ni croiser ces dénominateurs. La tension est un ratio (demandes en choix 1 rapportées aux attributions de l'année), pas une durée d'attente.",
    secretStatistique: 'Valeurs masquées par la source lorsque moins de 10 demandes ou attributions (null ici).',
    region,
    departements: deps,
  });

  /* Archive par millésime : la mémoire du baromètre annuel. Sans elle,
   * impossible de dire en N+1 « l'attente a augmenté de X mois à Y » :
   * le snapshot courant est écrasé à chaque ingestion. L'archive est un
   * COPIE CONFORME du snapshot écrit ci-dessus (même collectedAt), committée
   * comme lui. Comparaisons N vs N-1 : joindre par code INSEE, ne comparer
   * que les communes classables dans LES DEUX millésimes, et gare aux
   * fusions de communes (précédent Pierrefitte 93059 → Saint-Denis). */
  const fs = require('fs');
  const path = require('path');
  const openDir = path.join(__dirname, '..', 'data', 'open');
  const archDir = path.join(openDir, 'archives');
  fs.mkdirSync(archDir, { recursive: true });
  fs.copyFileSync(
    path.join(openDir, 'tension-communes.json'),
    path.join(archDir, `tension-communes-${MILLESIME}.json`)
  );
  console.log(`  ✓ archive millésime : archives/tension-communes-${MILLESIME}.json`);
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * ingest-encadrement-arrete.js : grille des loyers de référence parisiens,
 * lue dans le PDF de l'arrêté préfectoral lui-même.
 * ------------------------------------------------------------------
 * Exécution   : node site/ingest/ingest-encadrement-arrete.js [--force]
 *               node site/ingest/ingest-encadrement-arrete.js --recette
 *               options : --pdf=<chemin local> --url=<url> --sortie=<nom>
 * Runtime     : Node.js >= 14 · Dépendances : AUCUNE (lib.js + pdf.js du dépôt)
 * Source      : arrêté préfectoral n° IDF-2026-06-12-00003 du 12 juin 2026,
 *               recueil des actes administratifs IDF-039-2026-06 du 15 juin 2026,
 *               publié par la Ville de Paris (cdn.paris.fr).
 * Sortie      : site/data/open/encadrement-loyers-paris.json (grille servie)
 *               + site/data/open/archives/encadrement-loyers-paris-2026.json
 * ------------------------------------------------------------------
 * POURQUOI CE SCRIPT EXISTE
 * Le jeu `logement-encadrement-des-loyers` d'opendata.paris.fr est figé au
 * 17/06/2025 et s'arrête au millésime 2025, alors que l'arrêté du 12 juin 2026
 * s'applique depuis le 1er juillet 2026. La grille en vigueur n'existe donc
 * qu'en PDF, et c'est ce PDF qui fait foi.
 *
 * CE QUE PUBLIE L'ARRÊTÉ, ET CE QUE PRODUIT LE SCRIPT
 * L'arrêté publie 14 tableaux, un par SECTEUR géographique, de 16 lignes
 * (4 nombres de pièces x 4 époques) et 7 colonnes. Les 2 560 enregistrements
 * du jeu open data en sont le dépliage sur les 80 quartiers : la valeur ne
 * dépend que du secteur, ce qui a été vérifié sur le millésime 2025 (448
 * combinaisons, 0 conflit). Le script refait ce dépliage, avec la table
 * quartier vers secteur lue dans l'annexe 1 de l'arrêté.
 *
 * COMMENT ON SAIT QUE LA LECTURE EST JUSTE (contrôles tous fail-closed)
 *  1. structure : 14 secteurs distincts, 16 lignes par tableau, 7 nombres par
 *     ligne, colonnes alignées, ordre des colonnes prouvé par les en-têtes,
 *     séquence des époques, étiquette de pièces tombant dans son groupe ;
 *  2. conservation des glyphes : chaque signe dessiné dans la zone des valeurs
 *     se retrouve dans une cellule, une fois et une seule ;
 *  3. arithmétique : majoré = ref x 1,2 et minoré = ref x 0,7 (arrondi au
 *     dixième, demi-haut, en entiers), et ref meublé = ref vide + majoration
 *     unitaire, soit 1 120 vérifications ;
 *  4. falsification : les 45 échanges de chiffres possibles sont rejoués, et
 *     chacun doit casser au moins 20 vérifications, sinon le contrôle 3 ne
 *     prouverait rien ;
 *  5. recette (--recette) : le même code appliqué au PDF de l'arrêté du
 *     16 juin 2025 doit rendre EXACTEMENT la grille publiée en données
 *     ouvertes pour ce millésime (1 344 valeurs + 80 quartiers).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const { extraireTexte, lignes, mots } = require('./pdf');

const TOL_Y = 2.0;      // tolérance de regroupement en lignes, en points PDF
const FUSION = 0.35;    // écart max entre deux glyphes d'un même mot, en fraction de corps

const ARRETE = {
  numero: 'IDF-2026-06-12-00003',
  nom: "arrêté du 12 juin 2026",
  millesime: '2026',
  debut: '1er juillet 2026',
  fin: '24 novembre 2026',
  url: 'https://cdn.paris.fr/paris/2026/06/17/arrete-prefectoral-encadrement-des-loyers-12-06-2026-publie-n4wk.pdf',
  page: 'https://www.paris.fr/pages/l-encadrement-des-loyers-comprendre-le-dispositif-29091',
};
/* Millésime précédent : sert de recette, sa grille est publiée en open data. */
const RECETTE = {
  millesime: '2025',
  url: 'https://cdn.paris.fr/paris/2026/04/24/arrete-prefectoral-encadrement-des-loyers-16-06-2025-publie-T0tx.pdf',
};

const EPOQUES = [
  { motif: /^<1946$/, label: 'Avant 1946' },
  { motif: /^1946-1970$/, label: '1946-1970' },
  { motif: /^1971-1990$/, label: '1971-1990' },
  { motif: /^>1990$/, label: 'Apres 1990' },
];

function erreur(msg) { throw new Error(msg); }
const pageMots = (items) => lignes(items, TOL_Y).map((rw) => ({ y: rw.y, mots: mots(rw, FUSION) }));
const texte = (r) => r.mots.map((m) => m.s).join(' ');
const nombre = (s) => (/^[0-9]{1,3},[0-9]$/.test(s) ? parseFloat(s.replace(',', '.')) : null);

/* Arrondis de l'arrêté, en arithmétique entière sur des dixièmes d'euro.
 * En virgule flottante, 31,5 x 0,7 vaut 22,049999... et donne 22,0 là où
 * l'arrêté publie 22,1 : 39 valeurs du millésime 2025 en dépendent. */
const dix = (v) => Math.round(v * 10);
const majoreDe = (refDix) => Math.floor((refDix * 12 + 5) / 10);
const minoreDe = (refDix) => Math.floor((refDix * 7 + 5) / 10);

/* ---------- annexe 1 : quartier vers secteur géographique ---------- */
function lireAnnexeQuartiers(pagesItems) {
  const quartiers = [];
  for (const items of pagesItems) {
    for (const r of pageMots(items)) {
      const num = r.mots.filter((m) => m.x < 115 && /^[0-9]{1,2}$/.test(m.s));
      const sec = r.mots.filter((m) => m.x > 440 && /^[0-9]{1,2}$/.test(m.s));
      if (num.length !== 1 || sec.length !== 1) continue;
      quartiers.push({
        numero: parseInt(num[0].s, 10),
        nom: r.mots.filter((m) => m.x >= 115 && m.x < 345).map((m) => m.s).join(' ').trim(),
        arrondissement: r.mots.filter((m) => m.x >= 345 && m.x <= 440).map((m) => m.s).join('').trim(),
        secteur: parseInt(sec[0].s, 10),
      });
    }
  }
  if (quartiers.length !== 80) erreur(`annexe 1 : ${quartiers.length} quartiers lus au lieu de 80`);
  const vus = quartiers.map((q) => q.numero).sort((a, b) => a - b);
  for (let i = 0; i < 80; i++) if (vus[i] !== i + 1) erreur(`annexe 1 : numéro de quartier manquant ou en double (attendu ${i + 1}, lu ${vus[i]})`);
  for (const q of quartiers) {
    if (!q.nom) erreur(`annexe 1 : quartier ${q.numero} sans nom`);
    if (!(q.secteur >= 1 && q.secteur <= 14)) erreur(`annexe 1 : quartier ${q.numero}, secteur ${q.secteur} hors de 1 à 14`);
  }
  return quartiers.sort((a, b) => a.numero - b.numero);
}

/* ---------- annexe 2 : une page, un secteur géographique ---------- */
function lireTableSecteur(items, noPage) {
  const rows = pageMots(items);
  const plat = [].concat(...rows.map((r) => r.mots));

  /* Le mot qui SUIT immédiatement « Locations » sur la même ligne tranche
   * entre les deux en-têtes. Chercher « meublées » n'importe où à droite
   * désignerait le premier « Locations », qui est celui des locations vides. */
  const suivant = (m) => plat.filter((n) => Math.abs(n.y - m.y) < 1 && n.x > m.x).sort((a, b) => a.x - b.x)[0];
  const locations = plat.filter((m) => /^Locations$/.test(m.s));
  const hVides = locations.find((m) => { const n = suivant(m); return n && /^vides$/.test(n.s); });
  const hMeubles = locations.find((m) => { const n = suivant(m); return n && /^meubl/.test(n.s); });
  if (!hVides || !hMeubles) erreur(`page ${noPage} : en-tête « Locations vides / meublées » introuvable`);
  if (!(hVides.x < hMeubles.x)) erreur(`page ${noPage} : « Locations meublées » n'est pas à droite de « Locations vides »`);

  /* Lignes de données : celles qui portent exactement 7 nombres à droite de la
   * colonne des époques. Une ligne qui en porte un autre nombre arrête tout. */
  const dataRows = [];
  for (const r of rows) {
    const nums = r.mots.filter((m) => m.x > 330 && nombre(m.s) !== null);
    if (!nums.length) continue;
    if (nums.length !== 7) erreur(`page ${noPage} : ligne y=${r.y.toFixed(1)} porte ${nums.length} nombres au lieu de 7 (${r.mots.map((m) => m.s).join('|')})`);
    dataRows.push({ y: r.y, nums: nums.sort((a, b) => a.x - b.x), mots: r.mots });
  }
  if (dataRows.length !== 16) erreur(`page ${noPage} : ${dataRows.length} lignes de données au lieu de 16`);

  const xcol = dataRows[0].nums.map((m) => m.x);
  for (const r of dataRows) {
    r.nums.forEach((m, i) => { if (Math.abs(m.x - xcol[i]) > 12) erreur(`page ${noPage} : colonne ${i + 1} désalignée (${m.x.toFixed(1)} contre ${xcol[i].toFixed(1)})`); });
  }
  const yBas = Math.min(...dataRows.map((r) => r.y)), yHaut = Math.max(...dataRows.map((r) => r.y));

  /* Ordre des colonnes prouvé par les en-têtes, jamais supposé. Attendu, de
   * gauche à droite : minoré, référence, majoré, majoration unitaire, puis
   * minoré, référence, majoré pour le meublé. La bande d'en-tête exclut le
   * titre de l'annexe, qui porte lui aussi « majorés » et « minorés ». */
  const hauts = plat.filter((m) => m.y > yHaut && m.y < yHaut + 70);
  const minores = hauts.filter((m) => /^minoré$/.test(m.s)).sort((a, b) => a.x - b.x);
  const majores = hauts.filter((m) => /^majoré$/.test(m.s)).sort((a, b) => a.x - b.x);
  const majoration = hauts.find((m) => /^Majoration$/.test(m.s));
  if (minores.length !== 2 || majores.length !== 2 || !majoration) {
    erreur(`page ${noPage} : en-têtes attendus introuvables (minoré x${minores.length}, majoré x${majores.length}, Majoration ${majoration ? 'présent' : 'absent'})`);
  }
  const ordre = [minores[0].x, xcol[1], majores[0].x, majoration.x, minores[1].x, xcol[5], majores[1].x];
  for (let i = 1; i < ordre.length; i++) if (!(ordre[i] > ordre[i - 1])) erreur(`page ${noPage} : ordre des colonnes non conforme aux en-têtes`);
  if (!(xcol[3] < hMeubles.x && xcol[4] > hMeubles.x)) erreur(`page ${noPage} : la coupure vides / meublées ne tombe pas entre la 4e et la 5e colonne`);

  /* Numéro de secteur : colonne de gauche, au niveau des lignes de données. */
  const secteurs = plat.filter((m) => m.x < 180 && m.y > yBas - 5 && m.y < yHaut + 5 && /^[0-9]{1,2}$/.test(m.s));
  if (secteurs.length !== 1) erreur(`page ${noPage} : ${secteurs.length} numéros de secteur trouvés`);
  const secteur = parseInt(secteurs[0].s, 10);

  dataRows.sort((a, b) => b.y - a.y);
  const out = [];
  for (const r of dataRows) {
    const ep = r.mots.filter((m) => m.x >= 250 && m.x < 330).map((m) => m.s).join('');
    const trouve = EPOQUES.find((e) => e.motif.test(ep));
    if (!trouve) erreur(`page ${noPage} : époque illisible « ${ep} » (ligne y=${r.y.toFixed(1)})`);
    out.push({ y: r.y, epoque: trouve.label, v: r.nums.map((m) => nombre(m.s)) });
  }
  for (let g = 0; g < 4; g++) {
    for (let k = 0; k < 4; k++) {
      if (out[g * 4 + k].epoque !== EPOQUES[k].label) erreur(`page ${noPage} : séquence d'époques rompue au groupe ${g + 1}, rang ${k + 1} (${out[g * 4 + k].epoque})`);
    }
  }

  /* Nombre de pièces : une étiquette par groupe de 4 lignes, dont l'ordonnée
   * doit tomber dans l'étendue verticale de son groupe. */
  const etiq = [];
  for (const r of rows) {
    const m = r.mots.filter((w) => w.x >= 185 && w.x < 250);
    if (!m.length) continue;
    const s = m.map((w) => w.s).join(' ');
    if (/^[1-3]$/.test(s)) etiq.push({ p: parseInt(s, 10), y: r.y });
    else if (/^4 et \+$/.test(s)) etiq.push({ p: 4, y: r.y });
  }
  if (etiq.length !== 4) erreur(`page ${noPage} : ${etiq.length} étiquettes « nombre de pièces » au lieu de 4`);
  etiq.sort((a, b) => b.y - a.y);
  for (let g = 0; g < 4; g++) {
    const groupe = out.slice(g * 4, g * 4 + 4);
    if (etiq[g].p !== g + 1) erreur(`page ${noPage} : étiquette de pièces ${etiq[g].p} au rang ${g + 1}`);
    if (!(etiq[g].y <= groupe[0].y && etiq[g].y >= groupe[3].y)) {
      erreur(`page ${noPage} : étiquette « ${etiq[g].p} pièce(s) » hors de son groupe (y=${etiq[g].y.toFixed(1)}, groupe ${groupe[3].y.toFixed(1)} à ${groupe[0].y.toFixed(1)})`);
    }
    groupe.forEach((l) => { l.pieces = g + 1; });
  }

  /* Conservation des glyphes : un chiffre perdu ou dédoublé par le
   * regroupement en mots serait invisible aux contrôles arithmétiques si le
   * hasard préservait les rapports. toFixed(1) et non String() : « 5 » au lieu
   * de « 5,0 » ferait manquer deux signes et accuserait à tort l'extraction. */
  const glyphes = items.filter((it) => it.x > 330 && it.y >= yBas - 1 && it.y <= yHaut + 1);
  const attendus = out.reduce((n, l) => n + l.v.map((x) => x.toFixed(1).replace('.', ',')).join('').length, 0);
  const dessines = glyphes.reduce((n, it) => n + it.s.replace(/\s/g, '').length, 0);
  if (dessines !== attendus) erreur(`page ${noPage} : ${dessines} signes dessinés dans la zone des valeurs contre ${attendus} restitués`);

  return {
    secteur,
    glyphes: dessines,
    /* Polices en présence : observation, pas invariant. L'arrêté de 2025
     * compose un « 0 » isolé en LiberationSans au milieu de cellules en
     * Marianne, et le numéro de secteur est en gras. */
    polices: [...new Set(glyphes.map((it) => it.police))],
    lignes: out.map((l) => ({
      pieces: l.pieces, epoque: l.epoque,
      minoreVide: l.v[0], refVide: l.v[1], majoreVide: l.v[2], majorationMeuble: l.v[3],
      minoreMeuble: l.v[4], refMeuble: l.v[5], majoreMeuble: l.v[6],
    })),
  };
}

/* ---------- lecture complète d'un arrêté ---------- */
function lireArrete(buf, etiquette) {
  const pages = extraireTexte(buf);
  const rows = pages.map(pageMots);
  const estTable = rows.map((r) => r.some((l) => /Locations\s+vides/.test(texte(l))) && r.some((l) => /Locations\s+meubl/.test(texte(l))));
  const estAnnexe = rows.map((r, i) => !estTable[i]
    && r.some((l) => /QUARTIER|GÉOGRAPHIQUE/.test(texte(l)))
    && r.filter((l) => l.mots.some((m) => m.x < 115 && /^[0-9]{1,2}$/.test(m.s))).length > 10);

  const iTables = estTable.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const iAnnexe = estAnnexe.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  console.log(`  ${etiquette} : ${pages.length} pages, tableaux ${iTables.map((i) => i + 1).join(', ')}, annexe quartiers ${iAnnexe.map((i) => i + 1).join(', ')}`);
  if (!iAnnexe.length) erreur(`${etiquette} : annexe des quartiers introuvable`);

  const quartiers = lireAnnexeQuartiers(iAnnexe.map((i) => pages[i]));
  const secteurs = iTables.map((i) => lireTableSecteur(pages[i], i + 1));
  if (secteurs.length !== 14) erreur(`${etiquette} : ${secteurs.length} tableaux de secteur au lieu de 14`);
  const vus = secteurs.map((t) => t.secteur).sort((a, b) => a - b);
  for (let i = 0; i < 14; i++) if (vus[i] !== i + 1) erreur(`${etiquette} : secteur manquant ou en double (attendu ${i + 1}, lu ${vus[i]})`);
  secteurs.sort((a, b) => a.secteur - b.secteur);

  /* Arithmétique de l'arrêté : 5 relations par ligne, 224 lignes. */
  const ecarts = [];
  for (const t of secteurs) {
    for (const l of t.lignes) {
      const rv = dix(l.refVide), rm = dix(l.refMeuble);
      const ou = `secteur ${t.secteur}, ${l.pieces} pièce(s), ${l.epoque}`;
      if (majoreDe(rv) !== dix(l.majoreVide)) ecarts.push(`${ou} : majoré vide ${l.majoreVide} au lieu de ${majoreDe(rv) / 10}`);
      if (minoreDe(rv) !== dix(l.minoreVide)) ecarts.push(`${ou} : minoré vide ${l.minoreVide} au lieu de ${minoreDe(rv) / 10}`);
      if (majoreDe(rm) !== dix(l.majoreMeuble)) ecarts.push(`${ou} : majoré meublé ${l.majoreMeuble} au lieu de ${majoreDe(rm) / 10}`);
      if (minoreDe(rm) !== dix(l.minoreMeuble)) ecarts.push(`${ou} : minoré meublé ${l.minoreMeuble} au lieu de ${minoreDe(rm) / 10}`);
      if (rv + dix(l.majorationMeuble) !== rm) ecarts.push(`${ou} : ${l.refVide} + ${l.majorationMeuble} ne fait pas ${l.refMeuble}`);
    }
  }
  console.log(`  contrôles arithmétiques : 1 120 vérifications, ${ecarts.length} écart(s)`);
  ecarts.slice(0, 20).forEach((e) => console.log('    ! ' + e));
  if (ecarts.length) erreur(`${etiquette} : la grille lue ne respecte pas les rapports de l'arrêté`);

  /* Falsification : un contrôle qui ne sait pas voir l'erreur ne prouve rien.
   * On rejoue les 1 120 vérifications sur une grille où deux chiffres ont été
   * échangés partout, pour les 45 paires possibles. */
  const permuter = (v, a, b) => parseFloat(v.toFixed(1).split('').map((c) => (c === a ? b : c === b ? a : c)).join(''));
  const aveugles = [];
  let minDetections = Infinity;
  for (let a = 0; a <= 9; a++) {
    for (let b = a + 1; b <= 9; b++) {
      let vues = 0;
      for (const t of secteurs) {
        for (const l of t.lignes) {
          const p = (x) => permuter(x, String(a), String(b));
          const rv = dix(p(l.refVide)), rm = dix(p(l.refMeuble));
          if (majoreDe(rv) !== dix(p(l.majoreVide))) vues++;
          if (minoreDe(rv) !== dix(p(l.minoreVide))) vues++;
          if (majoreDe(rm) !== dix(p(l.majoreMeuble))) vues++;
          if (minoreDe(rm) !== dix(p(l.minoreMeuble))) vues++;
          if (rv + dix(p(l.majorationMeuble)) !== rm) vues++;
        }
      }
      minDetections = Math.min(minDetections, vues);
      if (vues < 20) aveugles.push(`${a} contre ${b} : ${vues} détection(s)`);
    }
  }
  console.log(`  test de falsification : 45 paires de chiffres rejouées, au minimum ${minDetections} détections, ${aveugles.length} angle(s) mort(s)`);
  aveugles.forEach((x) => console.log('    ! ' + x));
  if (aveugles.length) erreur(`${etiquette} : les contrôles arithmétiques ne discriminent pas tous les chiffres`);

  return { quartiers, secteurs };
}

/* ---------- dépliage sur les 80 quartiers ---------- */
function deplier(lu, nomsServis) {
  const parSecteur = new Map(lu.secteurs.map((t) => [t.secteur, t]));
  const records = [];
  for (const q of lu.quartiers) {
    const t = parSecteur.get(q.secteur);
    if (!t) erreur(`quartier ${q.numero} : secteur ${q.secteur} sans tableau`);
    for (const l of t.lignes) {
      for (const meuble of [false, true]) {
        const nomServi = nomsServis.get(q.numero) || q.nom;
        const rec = {
          quartierId: q.numero,
          quartier: nomServi,
          zone: q.secteur,
          pieces: l.pieces,
          epoque: l.epoque,
          meuble,
          ref: meuble ? l.refMeuble : l.refVide,
          refMajore: meuble ? l.majoreMeuble : l.majoreVide,
          refMinore: meuble ? l.minoreMeuble : l.minoreVide,
          majorationMeuble: l.majorationMeuble,
        };
        /* Le nom de l'arrêté n'est porté que là où il diffère du nom servi
         * (3 quartiers sur 80) : lossless sans alourdir 2 560 enregistrements. */
        if (nomServi !== q.nom) rec.quartierArrete = q.nom;
        rec.arrondissement = q.arrondissement;
        records.push(rec);
      }
    }
  }
  if (records.length !== 2560) erreur(`dépliage : ${records.length} enregistrements au lieu de 2 560`);
  const cles = new Set(records.map((r) => `${r.quartierId}|${r.pieces}|${r.epoque}|${r.meuble ? 1 : 0}`));
  if (cles.size !== 2560) erreur(`dépliage : ${cles.size} combinaisons distinctes au lieu de 2 560`);
  return records.sort((a, b) => a.quartierId - b.quartierId || a.pieces - b.pieces || a.epoque.localeCompare(b.epoque) || (a.meuble ? 1 : 0) - (b.meuble ? 1 : 0));
}

function snapshotOpenData() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'open', 'encadrement-loyers-paris.json'), 'utf8')); }
  catch (e) { return null; }
}

/* ---------- recette : le millésime 2025 contre les données ouvertes ---------- */
async function recette() {
  const od = snapshotOpenData();
  if (!od) erreur('recette : snapshot open data encadrement-loyers-paris.json absent');
  if (od._meta.millesime !== RECETTE.millesime) {
    erreur(`recette : le snapshot open data est au millésime ${od._meta.millesime}, la recette attend ${RECETTE.millesime}`);
  }
  console.log(`Recette : arrêté du 16 juin 2025 contre le jeu open data millésime ${od._meta.millesime}`);
  const buf = await lib.getCached(RECETTE.url, `arrete-encadrement-${RECETTE.millesime}.pdf`);
  const lu = lireArrete(buf, `arrêté ${RECETTE.millesime}`);

  const zones = new Map(od.records.map((r) => [r.quartierId, r.zone]));
  let ecartsMap = 0;
  for (const q of lu.quartiers) {
    if (zones.get(q.numero) !== q.secteur) { ecartsMap++; console.log(`    ! quartier ${q.numero} : open data zone ${zones.get(q.numero)}, arrêté secteur ${q.secteur}`); }
  }
  console.log(`  table quartier vers secteur : 80 quartiers, ${ecartsMap} écart(s)`);

  const cle = (z, p, e, m) => `${z}|${p}|${e}|${m}`;
  const ref = new Map(od.records.map((r) => [cle(r.zone, r.pieces, r.epoque, r.meuble ? 1 : 0), r]));
  let n = 0; const ecarts = [];
  for (const t of lu.secteurs) {
    for (const l of t.lignes) {
      for (const [m, valeur, majore, minore] of [[0, l.refVide, l.majoreVide, l.minoreVide], [1, l.refMeuble, l.majoreMeuble, l.minoreMeuble]]) {
        const o = ref.get(cle(t.secteur, l.pieces, l.epoque, m));
        if (!o) { ecarts.push(`combinaison absente des données ouvertes : ${cle(t.secteur, l.pieces, l.epoque, m)}`); continue; }
        n += 3;
        if (dix(o.ref) !== dix(valeur)) ecarts.push(`référence ${cle(t.secteur, l.pieces, l.epoque, m)} : PDF ${valeur}, open data ${o.ref}`);
        if (dix(o.refMajore) !== dix(majore)) ecarts.push(`majoré ${cle(t.secteur, l.pieces, l.epoque, m)} : PDF ${majore}, open data ${o.refMajore}`);
        if (dix(o.refMinore) !== dix(minore)) ecarts.push(`minoré ${cle(t.secteur, l.pieces, l.epoque, m)} : PDF ${minore}, open data ${o.refMinore}`);
      }
    }
  }
  console.log(`  valeurs : ${n} comparaisons, ${ecarts.length} écart(s)`);
  ecarts.slice(0, 20).forEach((e) => console.log('    ! ' + e));
  if (ecartsMap || ecarts.length) erreur('RECETTE EN ÉCHEC : la lecture du PDF ne reproduit pas la grille publiée en données ouvertes');
  console.log('  RECETTE OK : le même code reproduit exactement la grille officielle du millésime précédent.');
}

/* ------------------------------ pilote ------------------------------ */
(async () => {
  const arg = (nom) => {
    const a = process.argv.find((x) => x.startsWith(`--${nom}=`));
    return a ? a.slice(nom.length + 3) : null;
  };
  if (process.argv.includes('--recette')) { await recette(); return; }

  const url = arg('url') || ARRETE.url;
  const local = arg('pdf');
  const sortie = arg('sortie') || 'encadrement-loyers-paris';

  console.log(`Encadrement des loyers : ${ARRETE.nom} (millésime ${ARRETE.millesime})`);
  const buf = local ? fs.readFileSync(local) : await lib.getCached(url, `arrete-encadrement-${ARRETE.millesime}.pdf`);
  console.log(`  PDF : ${buf.length} octets`);
  const lu = lireArrete(buf, `arrêté ${ARRETE.millesime}`);

  /* Noms d'affichage : ceux du jeu open data, pour ne pas changer ce que le
   * site affiche le jour où cette grille remplacera la précédente. Les noms
   * de l'arrêté sont conservés là où ils diffèrent. */
  const od = snapshotOpenData();
  const nomsServis = new Map(od ? od.records.map((r) => [r.quartierId, r.quartier]) : []);
  const differents = lu.quartiers.filter((q) => nomsServis.has(q.numero) && nomsServis.get(q.numero) !== q.nom);
  if (differents.length) {
    console.log(`  noms de quartier différents du jeu open data : ${differents.length}`);
    differents.forEach((q) => console.log(`    ${q.numero} : « ${nomsServis.get(q.numero)} » servi, « ${q.nom} » dans l'arrêté`));
  }

  const records = deplier(lu, nomsServis);
  const majores = records.map((r) => r.refMajore);
  console.log(`  ${records.length} enregistrements, plafond de ${Math.min(...majores)} à ${Math.max(...majores)} euros par mètre carré`);

  /* Archive du millésime servi jusqu'ici, avant de l'écraser. Sans elle, la
   * grille précédente disparaît du dépôt et toute comparaison d'un millésime
   * à l'autre devient impossible. Même convention que ingest-tension.js. */
  const openDir = path.join(__dirname, '..', 'data', 'open');
  const archDir = path.join(openDir, 'archives');
  const canonique = path.join(openDir, `${sortie}.json`);
  fs.mkdirSync(archDir, { recursive: true });
  if (fs.existsSync(canonique)) {
    const ancien = JSON.parse(fs.readFileSync(canonique, 'utf8'));
    const m = ancien._meta && ancien._meta.millesime;
    if (m && m !== ARRETE.millesime) {
      fs.copyFileSync(canonique, path.join(archDir, `${sortie}-${m}.json`));
      console.log(`  archive du millésime précédent : archives/${sortie}-${m}.json`);
    }
  }

  lib.writeDataset(sortie, records, {
    source: `Préfecture de la région d'Île-de-France, ${ARRETE.nom} (n° ${ARRETE.numero})`,
    sourceUrl: url,
    portal: 'cdn.paris.fr',
    /* Un arrêté préfectoral n'est pas publié sous licence ouverte : c'est un
     * acte administratif, information publique librement réutilisable. Ce
     * libellé n'existe pas dans LICENSE_URLS de build.js : si un jour une page
     * émet un JSON-LD Dataset sur ce jeu, le build échouera (fail-closed) et
     * il faudra ajouter l'entrée. */
    license: 'Acte administratif (arrêté préfectoral)',
    attribution: `Source : ${ARRETE.nom} fixant les loyers de référence à Paris (n° ${ARRETE.numero}), préfecture de la région d'Île-de-France`,
    millesime: ARRETE.millesime,
    arrete: ARRETE.nom,
    applicableDu: ARRETE.debut,
    applicableAu: ARRETE.fin,
    pageOfficielle: ARRETE.page,
    controles: {
      secteurs: lu.secteurs.length,
      lignesLues: lu.secteurs.length * 16,
      glyphesRestitues: lu.secteurs.reduce((n, t) => n + t.glyphes, 0),
      verificationsArithmetiques: 1120,
      ecartsArithmetiques: 0,
      pairesDeChiffresRejouees: 45,
      recette: 'node site/ingest/ingest-encadrement-arrete.js --recette',
    },
  });

  /* Archive du millésime produit : copie conforme du snapshot écrit ci-dessus. */
  fs.copyFileSync(canonique, path.join(archDir, `${sortie}-${ARRETE.millesime}.json`));
  console.log(`  archive millésime : archives/${sortie}-${ARRETE.millesime}.json`);
})().catch((e) => { console.error('ÉCHEC ingest-encadrement-arrete :', e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * atelier-correction.js : applique un lot de corrections de contenu, déroule la chaîne
 * de répercussion du projet, passe la barrière, et S'ARRÊTE avant toute publication.
 *
 * Exécution : node site/atelier-correction.js --lot _veille/lots/mon-lot.json
 *             node site/atelier-correction.js --lot ... --sans-ecrire   (balayage seul)
 *             node site/atelier-correction.js --autotest
 * Runtime minimal : Node >= 14 natif (fs, path, child_process). Dépendances : aucune.
 *
 * Pourquoi ce script existe : dans ce projet une correction ne vit jamais seule. Un
 * montant corrigé dans guides.json survit dans son tldr, dans une carte de
 * diagnostic.json, dans la jumelle anglaise et dans la page /rentree/, et c'est
 * exactement ce qu'aucun humain ne revérifie à 23 h. Le balayage de répercussion
 * est le coeur de l'outil : il cherche les valeurs PÉRIMÉES partout et dit où elles
 * subsistent, au lieu de faire confiance à une liste de fichiers touchés.
 *
 * Ce qu'il ne fait jamais : git add, commit, push, deploy, IndexNow, GSC. Il prépare
 * et il rend un diff. La publication engage le client, elle reste une décision humaine.
 *
 * Format du lot (JSON) :
 * {
 *   "titre": "Visale : plafond de loyer en Île-de-France",
 *   "source": { "url": "https://...", "consultee": "2026-09-04", "statut": "CONFIRME" },
 *   "remplacements": [ { "fichier": "site/data/guides.json", "old": "...", "new": "..." } ],
 *   "perimes": ["1 500 €", "1 300 €"]
 * }
 * `perimes` : les valeurs qui ne doivent plus exister nulle part après correction.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RACINE = path.resolve(__dirname, '..');

/* Chaîne de répercussion du projet : tout fichier qui peut porter un fait
 * périssable. L'ordre est celui du CLAUDE.md, il sert à l'affichage. */
const CHAINE = [
  ['site/data/guides.json', 'contenu des guides FR (corps, FAQ, sources, tldr)'],
  ['site/data/diagnostic.json', 'cartes du diagnostic qui citent un dispositif'],
  ['site/data/en.json', 'guides EN jumelés'],
  ['site/build.js', 'pages construites en dur, dont /rentree/'],
  ['site/data/parcours.json', 'étapes des hubs de parcours'],
  ['site/data/plafonds.json', 'barèmes du simulateur'],
];

/* Espaces qui séparent les milliers selon la source : espace ordinaire, insécable,
 * insécable étroite. Nommées par leur code, jamais écrites en clair : en littéral
 * elles sont invisibles à la relecture et se perdent au premier outil traversé. */
const ESPACE_INSEC = String.fromCharCode(0x00a0);
const ESPACE_ETROITE = String.fromCharCode(0x202f);

const arg = (nom, defaut) => {
  const i = process.argv.indexOf('--' + nom);
  return i === -1 ? defaut : (process.argv[i + 1] || true);
};
const a = nom => process.argv.includes('--' + nom);

/* ---------------------- primitives, testées par --autotest ---------------------- */

/** Compte les occurrences exactes, sans expression régulière : un motif de contenu
 *  contient souvent des caractères qui ont un sens en regex. */
function occurrences(texte, motif) {
  if (!motif) return 0;
  return texte.split(motif).length - 1;
}

/** Fin de ligne dominante. Un fichier CRLF fait échouer tout remplacement
 *  multi-lignes écrit en LF, panne payée le 03/09/2026 sur build.js. */
function finDeLigne(texte) {
  const crlf = (texte.match(/\r\n/g) || []).length;
  const lf = (texte.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? 'CRLF' : 'LF';
}

/** Applique un lot sur un contenu, en normalisant les fins de ligne le temps de
 *  l'édition. Refuse si un `old` n'apparaît pas EXACTEMENT une fois : absent, on
 *  corrigerait un fichier qui a changé sous nos pieds ; multiple, on ne sait pas
 *  laquelle des occurrences était visée. */
function appliquer(contenu, entrees) {
  const eol = finDeLigne(contenu);
  let t = eol === 'CRLF' ? contenu.replace(/\r\n/g, '\n') : contenu;
  const refus = [];
  for (const e of entrees) {
    const vieux = e.old.replace(/\r\n/g, '\n');
    const n = occurrences(t, vieux);
    if (n !== 1) { refus.push({ old: e.old, vu: n }); continue; }
    t = t.replace(vieux, e.new.replace(/\r\n/g, '\n'));
  }
  if (refus.length) return { refus, contenu: null, eol };
  return { refus: [], contenu: eol === 'CRLF' ? t.replace(/\n/g, '\r\n') : t, eol };
}

/** Groupe les chiffres par milliers avec le séparateur demandé, sans regex. */
function grouperMilliers(chiffres, sep) {
  let out = '';
  for (let i = 0; i < chiffres.length; i++) {
    const restant = chiffres.length - i;
    if (i > 0 && restant % 3 === 0) out += sep;
    out += chiffres[i];
  }
  return out;
}

/** Un même montant s'écrit de plusieurs façons selon la langue et l'espace employé :
 *  « 1 940 » en français avec une insécable, « 1,940 » ou « 1940 » côté anglais. Un
 *  balayage littéral rate donc la jumelle traduite, qui est précisément la
 *  répercussion qu'on cherche. Mesuré le 04/09/2026 sur le plafond Visale, écrit
 *  « €1,940 » dans en.json et invisible à la forme française. */
function variantes(valeur) {
  const out = new Set([valeur]);
  const chiffres = valeur.replace(/[^0-9]/g, '');
  if (chiffres.length >= 3) {
    out.add(chiffres);
    for (const sep of [' ', ESPACE_INSEC, ESPACE_ETROITE, ',', '.']) out.add(grouperMilliers(chiffres, sep));
  }
  return [...out].filter(Boolean);
}

/** Cherche des valeurs périmées dans un ensemble de fichiers, toutes variantes
 *  d'écriture comprises, avec un extrait pour que le lecteur juge sur pièce
 *  plutôt que sur un compteur. */
function balayer(fichiers, valeurs) {
  const trouves = [];
  for (const fichier of fichiers) {
    const abs = path.join(RACINE, fichier);
    if (!fs.existsSync(abs)) continue;
    const texte = fs.readFileSync(abs, 'utf8');
    for (const v of valeurs) {
      for (const forme of variantes(v)) {
        const n = occurrences(texte, forme);
        if (!n) continue;
        const i = texte.indexOf(forme);
        trouves.push({
          fichier, valeur: v, forme, n,
          extrait: texte.slice(Math.max(0, i - 70), i + forme.length + 70).replace(/\s+/g, ' '),
        });
      }
    }
  }
  return trouves;
}

/** Invariant maison : tout nombre d'un tldr doit exister dans le corps de son
 *  guide. Un résumé qui porte un chiffre absent du corps est un fait nouveau
 *  non sourcé, exactement ce que la règle des tldr interdit. */
function tldrSansFaitNeuf(guide) {
  if (!guide || !guide.tldr || !guide.tldr.length) return [];
  const aplati = s => String(s).split(ESPACE_INSEC).join(' ').split(ESPACE_ETROITE).join(' ');
  const corps = aplati(JSON.stringify({ intro: guide.intro, sections: guide.sections, faq: guide.faq }));
  const manquants = [];
  for (const phrase of guide.tldr) {
    for (const nb of (aplati(phrase).match(/\d[\d ]*(?:[.,]\d+)?/g) || [])) {
      const propre = nb.trim();
      if (propre.length < 2) continue;
      if (!corps.includes(propre) && !corps.includes(propre.split(' ').join(''))) manquants.push({ phrase, nombre: propre });
    }
  }
  return manquants;
}

/* --------------------------------- autotest --------------------------------- */

function autotest() {
  const cas = [];
  const ok = (nom, vrai) => { cas.push([nom, vrai]); console.log('  [' + (vrai ? 'OK ' : 'RATE') + '] ' + nom); };

  ok('occurrences compte sans regex', occurrences('a (b) c (b)', '(b)') === 2);
  ok('occurrences sur motif absent', occurrences('abc', 'zzz') === 0);
  ok('finDeLigne repere CRLF', finDeLigne('a\r\nb\r\nc') === 'CRLF');
  ok('finDeLigne repere LF', finDeLigne('a\nb\nc') === 'LF');

  const r1 = appliquer('ligne1\r\nvaleur 1 500 EUR\r\nligne3', [{ old: 'valeur 1 500 EUR', new: 'valeur 1 940 EUR' }]);
  ok('remplacement dans un fichier CRLF', r1.contenu === 'ligne1\r\nvaleur 1 940 EUR\r\nligne3' && r1.eol === 'CRLF');
  const r2 = appliquer('x\ny\nz', [{ old: 'x\ny', new: 'x\nY' }]);
  ok('remplacement multi-lignes en LF', r2.contenu === 'x\nY\nz');
  const r3 = appliquer('aaa', [{ old: 'a', new: 'b' }]);
  ok('refus si le motif apparait 3 fois', r3.refus.length === 1 && r3.refus[0].vu === 3 && r3.contenu === null);
  const r4 = appliquer('abc', [{ old: 'zzz', new: 'b' }]);
  ok('refus si le motif est absent', r4.refus.length === 1 && r4.refus[0].vu === 0);
  const r5 = appliquer('abc def', [{ old: 'abc', new: 'ABC' }, { old: 'zzz', new: '!' }]);
  ok('un seul refus annule tout le fichier', r5.contenu === null);

  const vs = variantes('1 940');
  ok('variantes couvre la forme sans separateur', vs.includes('1940'));
  ok('variantes couvre la forme anglaise a virgule', vs.includes('1,940'));
  ok('variantes couvre l espace insecable', vs.includes('1' + ESPACE_INSEC + '940'));
  ok('variantes garde la forme d origine', vs.includes('1 940'));
  ok('variantes ignore un texte sans chiffre', variantes('DALO').length === 1);
  ok('grouperMilliers sur 7 chiffres', grouperMilliers('1234567', ' ') === '1 234 567');

  const g1 = { tldr: ['Le plafond atteint 1 940 EUR par mois.'], intro: 'plafond de 1 940 EUR', sections: [], faq: [] };
  ok('tldr accepte un chiffre present dans le corps', tldrSansFaitNeuf(g1).length === 0);
  const g2 = { tldr: ['Le plafond atteint 2 500 EUR par mois.'], intro: 'plafond de 1 940 EUR', sections: [], faq: [] };
  ok('tldr denonce un chiffre absent du corps', tldrSansFaitNeuf(g2).length === 1);
  const g3 = { tldr: ['Jusqu a 1' + ESPACE_INSEC + '940 euros.'], intro: 'plafond de 1 940 euros', sections: [], faq: [] };
  ok('tldr tolere les espaces insecables', tldrSansFaitNeuf(g3).length === 0);

  const rates = cas.filter(c => !c[1]).length;
  console.log('\n' + (rates === 0
    ? 'Autotest vert : ' + cas.length + ' cas.'
    : 'AUTOTEST EN ECHEC : ' + rates + ' cas sur ' + cas.length + '.'));
  return rates ? 1 : 0;
}

/* ----------------------------------- CLI ----------------------------------- */

function main() {
  if (a('autotest')) process.exit(autotest());

  const cheminLot = arg('lot', null);
  if (!cheminLot || cheminLot === true) {
    console.error('Usage : node site/atelier-correction.js --lot chemin/lot.json [--sans-ecrire]');
    console.error('        node site/atelier-correction.js --autotest');
    process.exit(1);
  }
  const absLot = path.isAbsolute(cheminLot) ? cheminLot : path.join(RACINE, cheminLot);
  if (!fs.existsSync(absLot)) { console.error('Lot introuvable : ' + absLot); process.exit(1); }

  let lot;
  try { lot = JSON.parse(fs.readFileSync(absLot, 'utf8').replace(/^﻿/, '')); }
  catch (e) { console.error('Lot illisible : ' + e.message); process.exit(1); }

  const remplacements = lot.remplacements || [];
  const perimes = lot.perimes || [];
  if (!remplacements.length && !perimes.length) { console.error('Lot vide : ni remplacements, ni perimes.'); process.exit(1); }

  console.log('Atelier de correction : ' + (lot.titre || path.basename(absLot)));
  if (lot.source) console.log('Source : ' + (lot.source.url || '?') + ' (consultée le ' + (lot.source.consultee || '?') + ', statut ' + (lot.source.statut || '?') + ')');
  console.log('');

  const tousFichiers = CHAINE.map(c => c[0]);

  /* 1. Balayage AVANT : où vivent les valeurs périmées aujourd'hui. */
  if (perimes.length) {
    const avant = balayer(tousFichiers, perimes);
    console.log('1/6  Valeurs périmées présentes avant correction : ' + avant.length);
    for (const t of avant) {
      console.log('       ' + t.fichier + ' (' + t.n + ' fois) « ' + t.forme + ' »' + (t.forme === t.valeur ? '' : '   [variante de « ' + t.valeur + ' »]'));
    }
    console.log('');
  }

  if (a('sans-ecrire')) { console.log('Mode balayage seul : rien n\'a été écrit.'); return; }

  /* 2. Contrôle préalable de TOUS les remplacements, avant d'écrire quoi que ce soit. */
  const parFichier = new Map();
  for (const r of remplacements) {
    if (!r.fichier || !r.old || r.new === undefined) { console.error('Entrée mal formée : ' + JSON.stringify(r).slice(0, 120)); process.exit(1); }
    if (!parFichier.has(r.fichier)) parFichier.set(r.fichier, []);
    parFichier.get(r.fichier).push(r);
  }
  const projets = [];
  let refuse = 0;
  for (const [f, entrees] of parFichier) {
    const abs = path.join(RACINE, f);
    if (!fs.existsSync(abs)) { console.error('Fichier absent : ' + f); refuse++; continue; }
    const original = fs.readFileSync(abs, 'utf8');
    const res = appliquer(original, entrees);
    if (res.refus.length) {
      refuse += res.refus.length;
      for (const r of res.refus) console.error('  REFUS  ' + f + ' : motif vu ' + r.vu + ' fois (1 attendu) : « ' + r.old.slice(0, 80).replace(/\s+/g, ' ') + ' »');
      continue;
    }
    projets.push({ fichier: f, abs, original, contenu: res.contenu, eol: res.eol, n: entrees.length });
  }
  console.log('2/6  Contrôle préalable : ' + projets.length + ' fichier(s) prêt(s), ' + refuse + ' refus');
  if (refuse) { console.error('\nRien n\'a été écrit. Corriger le lot, puis relancer.'); process.exit(1); }

  /* 3. Écriture, avec l'original gardé en mémoire pour restauration. */
  for (const p of projets) fs.writeFileSync(p.abs, p.contenu, 'utf8');
  console.log('3/6  Écriture : ' + projets.map(p => p.fichier + ' (' + p.n + ', ' + p.eol + ')').join(', '));
  const restaurer = () => { for (const p of projets) fs.writeFileSync(p.abs, p.original, 'utf8'); };

  try {
    /* 4. Balayage APRÈS : ce qui subsiste est une répercussion oubliée. */
    let survivants = [];
    if (perimes.length) {
      survivants = balayer(tousFichiers, perimes);
      console.log('4/6  Répercussion : ' + (survivants.length ? survivants.length + ' survivance(s) de valeur périmée' : 'aucune valeur périmée ne subsiste'));
      for (const t of survivants) {
        const quoi = (CHAINE.find(c => c[0] === t.fichier) || [, ''])[1];
        console.log('       ATTENTION ' + t.fichier + ' (' + t.n + ' fois, forme « ' + t.forme + ' ») ' + quoi);
        console.log('         ...' + t.extrait.slice(0, 150) + '...');
      }
    } else {
      console.log('4/6  Répercussion : aucune valeur périmée déclarée dans le lot (champ « perimes »)');
    }

    if (parFichier.has('site/data/guides.json')) {
      const g = JSON.parse(fs.readFileSync(path.join(RACINE, 'site/data/guides.json'), 'utf8'));
      const arr = Array.isArray(g) ? g : (g.guides || []);
      const fautifs = [];
      for (const guide of arr) for (const m of tldrSansFaitNeuf(guide)) fautifs.push(guide.slug + ' : « ' + m.nombre + ' » absent du corps');
      console.log('       tldr : ' + (fautifs.length ? fautifs.length + ' chiffre(s) sans appui dans le corps' : 'tous les chiffres des tldr sont dans leur corps'));
      for (const f of fautifs) console.log('       ATTENTION ' + f);
    }

    /* 5. Datation puis barrière. Toute erreur restaure l'état d'origine. */
    console.log('5/6  Datation des guides...');
    execFileSync(process.execPath, [path.join(RACINE, 'site/date-guides.js')], { cwd: RACINE, stdio: 'pipe' });
    console.log('     barrière check-tout.js...');
    const sortie = execFileSync(process.execPath, [path.join(RACINE, 'site/check-tout.js')], { cwd: RACINE, stdio: 'pipe' }).toString();
    console.log('     ' + (sortie.trim().split('\n').pop() || 'ok'));

    /* 6. Diff à relire, et arrêt net. */
    let diff = '';
    try { diff = execFileSync('git', ['diff', '--stat'], { cwd: RACINE, stdio: 'pipe' }).toString(); } catch (e) {}
    console.log('\n6/6  Prêt à relire. Rien n\'a été commité, poussé ni publié.\n');
    console.log(diff.trim() || '(git indisponible : relire les fichiers touchés à la main)');
    console.log('\nRelire le diff, puis publier à la main : commit, push, vérification de la prod par le contenu, IndexNow, GSC.');
    if (survivants.length) {
      console.log('\nATTENTION : ' + survivants.length + ' survivance(s) de valeur périmée, à traiter avant de publier.');
      process.exit(2);
    }
  } catch (e) {
    restaurer();
    console.error('\nÉCHEC après écriture : ' + String(e.stdout || e.message).trim().split('\n').slice(-6).join('\n'));
    console.error('Les fichiers ont été RESTAURÉS dans leur état d\'origine.');
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { occurrences, finDeLigne, appliquer, balayer, variantes, grouperMilliers, tldrSansFaitNeuf };

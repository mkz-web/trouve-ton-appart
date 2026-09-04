#!/usr/bin/env node
/**
 * resoudre-lot.js : transforme les CONSTATS d'un rapport de veille en REMPLACEMENTS
 * exacts, utilisables par site/atelier-correction.js.
 *
 * Exécution : node site/resoudre-lot.js _veille/lots/brouillon.json [--sortie lot.json]
 *             node site/resoudre-lot.js --autotest
 * Runtime minimal : Node >= 14 natif (fs, path). Dépendances : aucune.
 *
 * Pourquoi ce script existe : la routine de veille ne voit que la page RENDUE, jamais
 * la source. La phrase qu'elle cite, « l'aide Mobili-Jeune prend en charge », s'écrit
 * dans build.js « L'<a href="...">aide Mobili-Jeune</a> prend en charge&nbsp;: ». Lui
 * demander un `old` exact reviendrait à lui demander de deviner le balisage : elle se
 * tromperait, et l'atelier refuserait le lot sans dire pourquoi. Ici elle constate,
 * et ce script retrouve la phrase dans la source, balisage compris.
 *
 * Il ne devine jamais le remplacement : si la nouvelle phrase n'est pas un simple
 * ajout à la fin de l'ancienne, il laisse `new` vide avec un TODO, et l'atelier
 * refusera de tourner tant qu'un humain ne l'a pas écrit.
 *
 * Format du brouillon :
 * {
 *   "titre": "...",
 *   "constats": [{
 *     "page": "/rentree/",
 *     "phrase_publiee": "texte VU sur la page, verbatim",
 *     "nouvelle_phrase": "texte tel qu'il doit se lire après correction",
 *     "source": { "url": "...", "consultee": "2026-09-04", "statut": "CONFIRME" }
 *   }],
 *   "perimes": ["1 500 €"]
 * }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const NBSP = String.fromCharCode(0x00a0);
const NNBSP = String.fromCharCode(0x202f);

/* Fichiers où peut vivre une phrase publiée, du plus probable au moins probable. */
const SOURCES = [
  'site/data/guides.json',
  'site/data/en.json',
  'site/data/parcours.json',
  'site/data/diagnostic.json',
  'site/build.js',
];

/**
 * Construit une vue normalisée du texte source ET la table qui ramène chaque
 * caractère normalisé à sa position d'origine. Sans cette table, on saurait qu'une
 * phrase est présente sans pouvoir en extraire la forme exacte, qui est justement
 * ce dont l'atelier a besoin.
 */
function indexer(src) {
  let norm = '';
  const map = [];
  let i = 0;
  const pousser = (c, pos) => { norm += c; map.push(pos); };
  while (i < src.length) {
    const c = src[i];
    // Balise HTML : disparaît de la vue normalisée.
    if (c === '<') {
      const fin = src.indexOf('>', i);
      if (fin !== -1 && fin - i < 400) { i = fin + 1; continue; }
    }
    // Entités d'espace insécable.
    if (c === '&') {
      const suite = src.slice(i, i + 8).toLowerCase();
      const ent = ['&nbsp;', '&#160;', '&#xa0;'].find(e => suite.startsWith(e));
      if (ent) { if (norm[norm.length - 1] !== ' ') pousser(' ', i); i += ent.length; continue; }
    }
    // Lien markdown [libellé](url) : seul le libellé est visible.
    if (c === '[') {
      const f = src.indexOf(']', i);
      if (f !== -1 && src[f + 1] === '(') {
        const g = src.indexOf(')', f);
        if (g !== -1 && g - f < 300) {
          for (let k = i + 1; k < f; k++) pousser(src[k], k);
          i = g + 1;
          continue;
        }
      }
    }
    // Guillemet échappé dans un JSON lu en texte brut.
    if (c === '\\' && src[i + 1] === '"') { pousser('"', i); i += 2; continue; }
    // Espaces de toute nature, réduits à une seule espace.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === NBSP || c === NNBSP) {
      if (norm[norm.length - 1] !== ' ') pousser(' ', i);
      i++;
      continue;
    }
    pousser(c, i);
    i++;
  }
  return { norm, map };
}

/** Même normalisation, sans table : pour la phrase cherchée. */
function normaliser(texte) {
  return indexer(texte).norm.trim();
}

/**
 * Retrouve une phrase publiée dans les sources. Retourne la forme EXACTE telle
 * qu'elle est écrite dans le fichier, balisage compris, ou l'ambiguïté constatée.
 */
function localiser(phrase, fichiers) {
  const cible = normaliser(phrase);
  if (cible.length < 25) return { statut: 'trop-court', cible };
  const trouves = [];
  for (const f of fichiers) {
    const abs = path.join(RACINE, f);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const { norm, map } = indexer(src);
    let depuis = 0, pos;
    while ((pos = norm.indexOf(cible, depuis)) !== -1) {
      const debut = map[pos];
      const fin = map[pos + cible.length - 1];
      trouves.push({ fichier: f, old: src.slice(debut, fin + 1) });
      depuis = pos + 1;
    }
  }
  if (!trouves.length) return { statut: 'absent', cible };
  if (trouves.length > 1) return { statut: 'ambigu', cible, trouves };
  return { statut: 'ok', cible, ...trouves[0] };
}

/* --------------------------------- autotest --------------------------------- */

function autotest() {
  const cas = [];
  const ok = (nom, vrai) => { cas.push([nom, vrai]); console.log('  [' + (vrai ? 'OK ' : 'RATE') + '] ' + nom); };

  ok('la balise HTML disparait', normaliser('L<a href="/x">aide</a> vaut') === 'Laide vaut');
  ok('l entite insecable devient une espace', normaliser('sous 120&nbsp;% du SMIC') === 'sous 120 % du SMIC');
  ok('le lien markdown garde son libelle', normaliser('voir [le guide](/guides/x/) ici') === 'voir le guide ici');
  ok('les espaces multiples se reduisent', normaliser('a   b\n\nc') === 'a b c');
  ok('l espace insecable devient ordinaire', normaliser('100' + NBSP + 'euros') === '100 euros');
  ok('le guillemet echappe est rendu', normaliser('il dit \\"oui\\" ici') === 'il dit "oui" ici');

  // La table de correspondance doit rendre la forme SOURCE, balisage compris.
  const src = 'xx L\'<a href="/g/">aide Mobili</a> prend&nbsp;: 10&nbsp;€ yy';
  const { norm, map } = indexer(src);
  const cible = normaliser("L'aide Mobili prend : 10 €");
  const pos = norm.indexOf(cible);
  const exact = pos === -1 ? '' : src.slice(map[pos], map[pos + cible.length - 1] + 1);
  ok('la phrase rendue retrouve sa forme source', exact === 'L\'<a href="/g/">aide Mobili</a> prend&nbsp;: 10&nbsp;€');

  ok('une phrase trop courte est refusee', localiser('trop court', SOURCES).statut === 'trop-court');

  const rates = cas.filter(c => !c[1]).length;
  console.log('\n' + (rates === 0 ? 'Autotest vert : ' + cas.length + ' cas.' : 'AUTOTEST EN ECHEC : ' + rates + ' cas.'));
  return rates ? 1 : 0;
}

/* ----------------------------------- CLI ----------------------------------- */

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--autotest')) process.exit(autotest());

  const entree = args.find(x => !x.startsWith('--'));
  if (!entree) {
    console.error('Usage : node site/resoudre-lot.js brouillon.json [--sortie lot.json]');
    console.error('        node site/resoudre-lot.js --autotest');
    process.exit(1);
  }
  const abs = path.isAbsolute(entree) ? entree : path.join(RACINE, entree);
  if (!fs.existsSync(abs)) { console.error('Brouillon introuvable : ' + abs); process.exit(1); }
  const brouillon = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
  const constats = brouillon.constats || [];
  if (!constats.length) { console.error('Aucun constat dans le brouillon.'); process.exit(1); }

  console.log('Résolution de ' + constats.length + ' constat(s)\n');
  const remplacements = [];
  let bloquants = 0, aEcrire = 0;

  constats.forEach((c, n) => {
    const etiquette = '[' + (n + 1) + '] ' + (c.page || '?');
    const r = localiser(c.phrase_publiee || '', SOURCES);
    if (r.statut === 'trop-court') { console.log(etiquette + ' : REFUS, phrase publiée trop courte pour être localisée sans ambiguïté'); bloquants++; return; }
    if (r.statut === 'absent') {
      console.log(etiquette + ' : INTROUVABLE dans les sources. La page a peut-être déjà été corrigée, ou la citation n\'est pas verbatim.');
      console.log('        cherché : ' + r.cible.slice(0, 120));
      bloquants++; return;
    }
    if (r.statut === 'ambigu') {
      console.log(etiquette + ' : AMBIGU, ' + r.trouves.length + ' emplacements (' + [...new Set(r.trouves.map(t => t.fichier))].join(', ') + '). Allonger la citation.');
      bloquants++; return;
    }
    // Le remplacement n'est deviné que dans le cas sûr : un ajout en fin de phrase.
    const ancienNorm = normaliser(r.old);
    const nouveauNorm = normaliser(c.nouvelle_phrase || '');
    let neuf = '';
    if (nouveauNorm && nouveauNorm.startsWith(ancienNorm)) {
      neuf = r.old + (c.nouvelle_phrase || '').slice(-(nouveauNorm.length - ancienNorm.length)).replace(/^\s*/, ' ');
      console.log(etiquette + ' : résolu dans ' + r.fichier + ' (ajout en fin de phrase, remplacement proposé)');
    } else {
      neuf = 'TODO ecrire le remplacement a partir de : ' + r.old;
      aEcrire++;
      console.log(etiquette + ' : résolu dans ' + r.fichier + ', mais le remplacement est à écrire à la main (ce n\'est pas un simple ajout)');
    }
    remplacements.push({ fichier: r.fichier, old: r.old, new: neuf });
  });

  const lot = {
    titre: brouillon.titre || 'Lot résolu',
    source: (constats[0] && constats[0].source) || brouillon.source || null,
    remplacements,
    perimes: brouillon.perimes || [],
  };
  const sortieArg = args.indexOf('--sortie');
  const sortie = sortieArg === -1 ? abs.replace(/\.json$/, '') + '.resolu.json' : args[sortieArg + 1];
  fs.writeFileSync(path.isAbsolute(sortie) ? sortie : path.join(RACINE, sortie), JSON.stringify(lot, null, 2) + '\n', 'utf8');

  console.log('\n' + remplacements.length + ' remplacement(s) écrits dans ' + sortie);
  if (aEcrire) console.log(aEcrire + ' remplacement(s) portent un TODO : les écrire avant de lancer l\'atelier.');
  if (bloquants) { console.log(bloquants + ' constat(s) non résolus, à traiter à la main.'); process.exit(2); }
}

if (require.main === module) main();
module.exports = { indexer, normaliser, localiser };

#!/usr/bin/env node
/**
 * check-links.js : vérifie que tous les liens internes de dist/ pointent vers
 * une page existante, ET qu'aucun fichier publié n'est orphelin.
 * Dépendances : aucune. Node 14+.
 * Exécution : node check-links.js
 *
 * Les deux contrôles sont les deux sens de la même question. Un lien cassé
 * envoie le visiteur nulle part ; un fichier orphelin est du poids déployé que
 * personne ne demande, et il passe inaperçu des années (24 Ko de /style.css
 * servis à personne depuis le passage au CSS inline, repérés à l'œil en
 * juillet 2026, jamais par un contrôle).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, 'dist');

/* Fichiers atteints sans qu'aucune page ne les cite : ce sont des conventions
 * du web, réclamées par le navigateur ou le robot à une URL fixe. Tout ajout
 * ici doit être une convention documentée, jamais un fichier qu'on n'arrive
 * plus à rattacher. La clé IndexNow en fait partie : les moteurs la
 * réclament à la racine pour accepter les pings (voir indexnow-cle.js). */
const INDEXNOW_KEY = require('./indexnow-cle.js');
const CONVENTIONS = new Set(['/404.html', '/robots.txt', `/${INDEXNOW_KEY}.txt`]);

const fichiers = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else fichiers.push(p);
  }
})(DIST);

const url = (p) => '/' + path.relative(DIST, p).split(path.sep).join('/');

let errs = 0, links = 0;

/* 1. Liens internes : chaque href absolu doit résoudre sur un fichier existant. */
for (const p of fichiers.filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(p, 'utf8');
  for (const m of html.matchAll(/href="(\/[^"]*)"/g)) {
    links++;
    const u = m[1].split('#')[0];
    if (!u) continue;
    /* Une URL à extension (/favicon.ico, /apple-touch-icon.png…) désigne un
     * fichier ; sinon c'est une page, donc un dossier + index.html. Toutes les
     * pages du site sont en URL à slash final, jamais à extension. */
    const t = /\.[a-z0-9]{2,5}$/i.test(u) ? path.join(DIST, u) : path.join(DIST, u, 'index.html');
    if (!fs.existsSync(t)) { console.log('CASSÉ dans ' + p.replace(DIST, '') + ' -> ' + u); errs++; }
  }
}

/* 2. Orphelins : tout fichier publié qui n'est ni une page, ni une convention,
 * doit être cité quelque part dans le texte servi (href, src, fetch, sitemap,
 * robots.txt…). On cherche l'URL ET le nom de fichier : une ressource chargée
 * par un chemin construit en JS reste ainsi détectée. */
const corpus = fichiers
  .filter((f) => /\.(html|css|js|txt|xml|json)$/.test(f))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

let orphelins = 0;
for (const p of fichiers) {
  const u = url(p);
  if (u.endsWith('/index.html') || CONVENTIONS.has(u)) continue;
  const nom = path.basename(p);
  /* Le fichier se contient lui-même : on retire ses propres occurrences. */
  const propre = /\.(html|css|js|txt|xml|json)$/.test(p) ? fs.readFileSync(p, 'utf8') : '';
  const cite = (corpus.split(u).length - 1) - (propre.split(u).length - 1)
    + (corpus.split(nom).length - 1) - (propre.split(nom).length - 1);
  if (cite === 0) {
    console.log('ORPHELIN : ' + u + ' (' + (fs.statSync(p).size / 1024).toFixed(1) + ' Ko) publié mais cité nulle part');
    orphelins++; errs++;
  }
}

console.log(links + ' liens internes vérifiés, ' + (errs - orphelins) + ' cassé(s) ; '
  + (fichiers.length - orphelins) + ' fichiers publiés, ' + orphelins + ' orphelin(s)');
process.exit(errs ? 1 : 0);

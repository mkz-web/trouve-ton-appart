#!/usr/bin/env node
/**
 * check-links.js — Vérifie que tous les liens internes de dist/ pointent
 * vers une page existante. Dépendances : aucune. Node 14+.
 * Exécution : node check-links.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, 'dist');

let errs = 0, links = 0;
function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.html')) {
      const html = fs.readFileSync(p, 'utf8');
      for (const m of html.matchAll(/href="(\/[^"]*)"/g)) {
        links++;
        const u = m[1].split('#')[0];
        if (!u) continue;
        const t = /\.(css|xml|txt)$/.test(u) ? path.join(DIST, u) : path.join(DIST, u, 'index.html');
        if (!fs.existsSync(t)) { console.log('CASSÉ dans ' + p.replace(DIST, '') + ' -> ' + u); errs++; }
      }
    }
  }
}
walk(DIST);
console.log(links + ' liens internes vérifiés, ' + errs + ' cassé(s)');
process.exit(errs ? 1 : 0);

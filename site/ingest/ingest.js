#!/usr/bin/env node
/**
 * ingest.js — Orchestrateur d'ingestion open data (Phase 2).
 * ------------------------------------------------------------------
 * Exécution   : node ingest.js [--force]   (--force : ignore .cache/)
 * Runtime     : Node.js >= 14 · Dépendances : AUCUNE
 * Lance les 5 ingestions et résume. Les sorties vont dans
 * site/data/open/*.json (committées : le build Cloudflare Pages ne fait
 * AUCUN appel réseau, il régénère depuis ces snapshots).
 * ------------------------------------------------------------------
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPTS = ['ingest-crous.js', 'ingest-encadrement.js', 'ingest-rpls.js', 'ingest-finess.js', 'ingest-tension.js'];

let failed = 0;
for (const s of SCRIPTS) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, s), ...process.argv.slice(2)], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}
console.log(failed ? `\n${failed} ingestion(s) en échec` : '\nIngestion complète OK — données dans site/data/open/');
process.exit(failed ? 1 : 0);

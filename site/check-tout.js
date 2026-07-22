#!/usr/bin/env node
/**
 * check-tout.js — La barrière avant publication : build + les trois contrôles.
 * ---------------------------------------------------------------------------
 * Runtime     : Node.js >= 22 (imposé par check-rendu.js)
 * Dépendances : AUCUNE (child_process, path natifs)
 * Exécution   : node site/check-tout.js [--toutes]
 *   --toutes   passe toutes les pages au contrôle de rendu au lieu des seuls
 *              gabarits (à réserver aux refontes de CSS : ~4 min contre ~12 s)
 *
 * POURQUOI CE SCRIPT : un contrôle qu'on peut oublier finit par être oublié.
 * Les trois contrôles existants ne servent à rien s'ils ne sont pas lancés, et
 * ils n'ont de sens que sur un dist FRAÎCHEMENT généré : vérifier un build
 * périmé revient à certifier autre chose que ce qui sera publié. D'où le build
 * en première étape, non négociable.
 *
 * Il s'arrête à la PREMIÈRE étape en échec : les suivantes porteraient sur un
 * état déjà connu comme faux, et leur « OK » brouillerait le diagnostic.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOUTES = process.argv.includes('--toutes');

const ETAPES = [
  { script: 'build.js', args: [], titre: 'Génération du site' },
  { script: 'check-links.js', args: [], titre: 'Liens internes' },
  { script: 'check-rendu.js', args: TOUTES ? ['--toutes'] : [], titre: 'Rendu (géométrie et accessibilité)' },
  { script: 'check-seo.js', args: [], titre: 'SEO / GEO (titles, metas, JSON-LD)' },
];

/* Un maillon absent doit faire ÉCHOUER la chaîne, jamais être sauté en
 * silence : une barrière incomplète qui annonce « tout est vert » est pire
 * qu'une absence de barrière. Même règle que dans check-rendu.js. */
const manquants = ETAPES.filter(e => !fs.existsSync(path.join(__dirname, e.script)));
if (manquants.length) {
  console.error(`✗ script(s) de contrôle introuvable(s) : ${manquants.map(e => e.script).join(', ')}`);
  process.exit(1);
}

console.log(`Barrière avant publication — ${ETAPES.length} étapes${TOUTES ? ' (rendu : toutes les pages)' : ''}\n`);

const debutTotal = Date.now();
for (let i = 0; i < ETAPES.length; i++) {
  const e = ETAPES[i];
  const debut = Date.now();
  process.stdout.write(`  ${i + 1}/${ETAPES.length}  ${e.titre}… `);

  /* process.execPath : le Node qui exécute ce script, jamais un « node » du
   * PATH qui pourrait être une autre version (check-rendu exige la 22+). */
  const r = spawnSync(process.execPath, [path.join(__dirname, e.script), ...e.args], { encoding: 'utf8' });
  const secondes = ((Date.now() - debut) / 1000).toFixed(1);

  /* status null = le processus n'a pas pu démarrer ou a été tué : c'est un
   * échec, pas un succès silencieux. */
  if (r.status !== 0) {
    console.log(`échec (${secondes} s)\n`);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status === null) console.error(`\n✗ ${e.script} ne s'est pas exécuté${r.error ? ` : ${r.error.message}` : ''}.`);
    console.error(`\n✗ Étape « ${e.titre} » en échec : NE PAS PUBLIER.`);
    console.error('  Corrigez, puis relancez node site/check-tout.js.');
    process.exit(1);
  }
  console.log(`ok (${secondes} s)`);
}

console.log(`\n✓ Les ${ETAPES.length} étapes passent (${((Date.now() - debutTotal) / 1000).toFixed(1)} s au total). Publication possible.`);
if (!TOUTES) console.log('  (rendu vérifié sur les gabarits de check-rendu.js ; après une refonte du CSS, relancer avec --toutes)');

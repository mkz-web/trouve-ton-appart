#!/usr/bin/env node
/**
 * ingest-contours.js : contours communaux d'Île-de-France (fond de carte).
 * ------------------------------------------------------------------
 * Exécution   : node ingest-contours.js [--force]
 * Runtime     : Node.js >= 14 · Dépendances : AUCUNE
 * Source      : API Géo (geo.api.gouv.fr, Etalab), géométries Admin Express
 *               IGN/Insee, une requête GeoJSON par département francilien.
 * Sortie      : site/data/open/contours-communes-idf.json
 *
 * Les contours servent UNIQUEMENT de fond à la carte des délais générée par
 * build.js : ils sont simplifiés (Douglas-Peucker) et arrondis à 4 décimales
 * (~11 m), ce qui est largement suffisant pour une carte régionale et divise
 * le poids par ~10. Ne jamais utiliser ces géométries pour un calcul
 * d'adjacence ou de surface : pour ça, repartir des contours IGN natifs
 * (précédent : la liste « Paris et communes limitrophes » du simulateur de
 * plafonds a été vérifiée sur les contours IGN non simplifiés, pas ceux-ci).
 * ------------------------------------------------------------------
 */
'use strict';

const { getCached, writeDataset, DEPS_IDF } = require('./lib');

/* Tolérance de simplification en degrés : 0.0012° ≈ 90-130 m, soit moins
 * d'un pixel sur une carte régionale de 1 000 px de large. */
const TOLERANCE = 0.0012;

/* ---------------- Douglas-Peucker (distance perpendiculaire) ------------ */

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function douglasPeucker(points, tol) {
  if (points.length <= 2) return points.slice();
  let maxD = 0, idx = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [a, b];
  const left = douglasPeucker(points.slice(0, idx + 1), tol);
  const right = douglasPeucker(points.slice(idx), tol);
  return left.slice(0, -1).concat(right);
}

/* Simplifie un anneau GeoJSON (fermé : premier point = dernier). */
function simplifyRing(ring, tol) {
  const open = ring.slice(0, -1);
  if (open.length < 4) return null;
  /* L'ancrage premier/dernier de Douglas-Peucker est arbitraire sur un
   * anneau ; suffisant pour un fond de carte. */
  const simplified = douglasPeucker(open, tol);
  if (simplified.length < 3) return null;
  const rounded = simplified.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]);
  /* L'arrondi peut créer des doublons consécutifs : on les retire. */
  const out = [];
  for (const p of rounded) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  if (out.length < 3) return null;
  return out;
}

/* Anneaux d'une géométrie Polygon ou MultiPolygon, à plat (le rendu SVG en
 * fill-rule evenodd restitue les trous sans distinguer les polygones). */
function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

(async () => {
  console.log('Contours communaux IdF (API Géo, Etalab)');
  const records = [];
  let pointsIn = 0, pointsOut = 0;
  for (const dep of DEPS_IDF) {
    const url = `https://geo.api.gouv.fr/communes?codeDepartement=${dep}&format=geojson&geometry=contour`;
    const geojson = JSON.parse(await getCached(url, `contours-${dep}.geojson`));
    let n = 0;
    for (const f of geojson.features || []) {
      const code = f.properties && f.properties.code;
      const nom = f.properties && f.properties.nom;
      if (!code || !nom) continue;
      const rings = [];
      for (const ring of ringsOf(f.geometry)) {
        pointsIn += ring.length;
        const s = simplifyRing(ring, TOLERANCE);
        if (s) { rings.push(s); pointsOut += s.length; }
      }
      if (!rings.length) {
        console.error(`  ⚠ ${code} ${nom} : géométrie vide après simplification`);
        continue;
      }
      records.push({ code, nom, dep, rings });
      n++;
    }
    console.log(`  ${dep} : ${n} communes`);
  }
  if (records.length < 1200) {
    console.error(`ÉCHEC : ${records.length} communes seulement (attendu ~1288), sortie non écrite.`);
    process.exit(1);
  }
  console.log(`  simplification : ${pointsIn} points → ${pointsOut} (tolérance ${TOLERANCE}°, arrondi 4 décimales)`);
  writeDataset('contours-communes-idf', records, {
    source: "Contours communaux Admin Express (IGN-Insee) via l'API Géo (geo.api.gouv.fr, Etalab)",
    sourceUrl: 'https://geo.api.gouv.fr/communes?codeDepartement={dep}&format=geojson&geometry=contour',
    license: 'Licence Ouverte Etalab 2.0',
    attribution: "Fond de carte : contours communaux Admin Express (IGN-Insee), API Géo (Etalab)",
    simplification: `Douglas-Peucker ${TOLERANCE}°, coordonnées arrondies à 4 décimales : fond de carte uniquement, impropre à tout calcul géométrique`,
  });
})().catch((e) => { console.error('ÉCHEC contours :', e.message); process.exit(1); });

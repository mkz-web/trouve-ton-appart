#!/usr/bin/env node
/**
 * lib.js : boîte à outils commune des scripts d'ingestion open data.
 * ------------------------------------------------------------------
 * Runtime     : Node.js >= 14
 * Dépendances : AUCUNE (modules natifs : https, http, zlib, fs, path)
 * Usage       : const lib = require('./lib');
 * ------------------------------------------------------------------
 */
'use strict';

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const UA = 'TrouveTonAppart-ingest/1.0 (site statique; contact@mkz-consulting.fr)';

/* ------------------------------ HTTP -------------------------------- */

/** GET avec suivi des redirections (max 5), décompression gzip/deflate, timeout. */
function get(url, { timeout = 300000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate', Accept: '*/*' },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return reject(new Error(`Trop de redirections : ${url}`));
        const next = new URL(res.headers.location, url).toString();
        return resolve(get(next, { timeout, maxRedirects: maxRedirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} sur ${url}`));
      }
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout (${timeout} ms) sur ${url}`)));
    req.on('error', reject);
  });
}

async function getText(url, opts = {}) {
  const buf = await get(url, opts);
  return buf.toString(opts.encoding || 'utf8');
}
async function getJson(url, opts) { return JSON.parse(await getText(url, opts)); }

/** Télécharge dans .cache/ (gitignoré) et réutilise si déjà présent (--force pour re-télécharger). */
async function getCached(url, cacheName, opts) {
  const dir = path.join(__dirname, '.cache');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, cacheName);
  if (fs.existsSync(file) && !process.argv.includes('--force')) {
    console.log(`  (cache) ${cacheName}`);
    return fs.readFileSync(file);
  }
  console.log(`  ↓ ${url}`);
  const buf = await get(url, opts);
  fs.writeFileSync(file, buf);
  return buf;
}

/* ------------------------------ ZIP --------------------------------- */

/**
 * Extrait un fichier d'une archive ZIP (méthodes store et deflate uniquement),
 * en lisant le répertoire central, pur Node (zlib.inflateRawSync).
 */
function unzipEntry(zipBuf, nameRegex) {
  // Localise la fin du répertoire central (EOCD, signature 0x06054b50).
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65558); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP invalide : EOCD introuvable');
  const count = zipBuf.readUInt16LE(eocd + 10);
  let off = zipBuf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zipBuf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP invalide : entrée centrale corrompue');
    const method = zipBuf.readUInt16LE(off + 10);
    const compSize = zipBuf.readUInt32LE(off + 20);
    const nameLen = zipBuf.readUInt16LE(off + 28);
    const extraLen = zipBuf.readUInt16LE(off + 30);
    const commentLen = zipBuf.readUInt16LE(off + 32);
    const localOff = zipBuf.readUInt32LE(off + 42);
    const name = zipBuf.toString('utf8', off + 46, off + 46 + nameLen);
    if (nameRegex.test(name)) {
      // En-tête local : tailles de nom/extra peuvent différer du central.
      const lNameLen = zipBuf.readUInt16LE(localOff + 26);
      const lExtraLen = zipBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = zipBuf.slice(dataStart, dataStart + compSize);
      if (method === 0) return { name, data };
      if (method === 8) return { name, data: zlib.inflateRawSync(data) };
      throw new Error(`ZIP : méthode de compression ${method} non gérée (${name})`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP : aucune entrée ne correspond à ${nameRegex}`);
}

/* ------------------------------ XLSX -------------------------------- */

/** Décode les entités XML d'un texte de cellule. */
function xmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // en dernier : &amp;lt; doit donner &lt; et non <
}

/** "BT" → 71 (index de colonne 0-based, notation tableur). */
function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Lit un onglet d'un classeur XLSX et renvoie un tableau de lignes (tableaux
 * de chaînes), cellules vides comprises (position déduite de l'attribut r).
 * Pur Node : le XLSX est un ZIP de XML, on réutilise unzipEntry.
 * Gère les chaînes partagées, les chaînes en ligne et les nombres.
 * Ne gère pas les dates sérielles (aucun besoin ici) ni les formules calculées.
 */
function parseXlsx(zipBuf, sheetName) {
  const readXml = (re) => { try { return unzipEntry(zipBuf, re).data.toString('utf8'); } catch { return null; } };

  /* Chaînes partagées : chaque <si> peut contenir plusieurs <t> (texte enrichi). */
  const shared = [];
  const ssXml = readXml(/^xl\/sharedStrings\.xml$/);
  if (ssXml) {
    for (const si of ssXml.split(/<si[\s>]/).slice(1)) {
      const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => xmlDecode(m[1]));
      shared.push(parts.join(''));
    }
  }

  /* Onglet demandé : workbook.xml donne le r:id, les rels donnent le fichier. */
  const wbXml = readXml(/^xl\/workbook\.xml$/);
  if (!wbXml) throw new Error('XLSX invalide : xl/workbook.xml introuvable');
  const sheets = [...wbXml.matchAll(/<sheet[^>]*\/?>/g)].map(m => m[0]);
  const wanted = sheets.find(s => xmlDecode((/name="([^"]*)"/.exec(s) || [])[1] || '') === sheetName);
  if (!wanted) {
    const noms = sheets.map(s => xmlDecode((/name="([^"]*)"/.exec(s) || [])[1] || ''));
    throw new Error(`XLSX : onglet « ${sheetName} » introuvable (présents : ${noms.join(', ')})`);
  }
  const rid = (/r:id="([^"]*)"/.exec(wanted) || [])[1];
  const relsXml = readXml(/^xl\/_rels\/workbook\.xml\.rels$/) || '';
  const rel = [...relsXml.matchAll(/<Relationship[^>]*\/?>/g)].map(m => m[0])
    .find(r => (/Id="([^"]*)"/.exec(r) || [])[1] === rid);
  let target = rel ? (/Target="([^"]*)"/.exec(rel) || [])[1] : null;
  if (!target) throw new Error(`XLSX : cible introuvable pour ${rid}`);
  target = target.replace(/^\/?(xl\/)?/, '');
  const sheetXml = readXml(new RegExp('^xl/' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  if (!sheetXml) throw new Error(`XLSX : feuille xl/${target} illisible`);

  /* Lignes : les cellules vides sont omises, on se cale sur l'attribut r. */
  const rows = [];
  for (const rowXml of sheetXml.split(/<row[\s>]/).slice(1)) {
    const cells = [];
    for (const m of rowXml.matchAll(/<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1], body = m[3] || '';
      const idx = colIndex((/r="([A-Z]+)\d+"/.exec(attrs) || [])[1] || 'A');
      const type = (/t="([^"]*)"/.exec(attrs) || [])[1] || 'n';
      let val = '';
      if (type === 's') {
        const i = +(/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        val = shared[i] ?? '';
      } else if (type === 'inlineStr') {
        val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => xmlDecode(x[1])).join('');
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        val = v == null ? '' : xmlDecode(v);
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows;
}

/* ------------------------------ CSV --------------------------------- */

/** Parseur CSV complet : champs entre guillemets, guillemets doublés, \r\n. */
function parseCsv(text, sep = ';') {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV → tableau d'objets clé/valeur d'après la ligne d'en-tête. */
function csvToObjects(text, sep = ';') {
  const rows = parseCsv(text, sep);
  const header = rows[0].map((h) => h.trim().replace(/^﻿/, ''));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/* --------------------------- Conversions ---------------------------- */

/** "23,10%" / "8,12" / "0,00 €" / "" → nombre ou null. */
function numFr(s) {
  if (s == null) return null;
  const t = String(s).replace(/[%€\s ]/g, '').replace(',', '.');
  if (t === '' || t.toLowerCase() === 'nr' || t.toLowerCase() === 'na') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lambert-93 (EPSG:2154) → WGS84. Formules IGN de la projection conique
 * conforme de Lambert, ellipsoïde GRS80. Précision < 1 m.
 */
const lambert93ToWgs84 = (() => {
  const a = 6378137, f = 1 / 298.257222101;
  const e = Math.sqrt(2 * f - f * f);
  const d2r = Math.PI / 180;
  const phi0 = 46.5 * d2r, phi1 = 44 * d2r, phi2 = 49 * d2r, lambda0 = 3 * d2r;
  const X0 = 700000, Y0 = 6600000;
  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) ** 2);
  const t = (phi) => Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const n = (Math.log(m(phi1)) - Math.log(m(phi2))) / (Math.log(t(phi1)) - Math.log(t(phi2)));
  const F = m(phi1) / (n * t(phi1) ** n);
  const rho0 = a * F * t(phi0) ** n;
  return (X, Y) => {
    const dx = X - X0, dy = rho0 - (Y - Y0);
    const rho = Math.sign(n) * Math.sqrt(dx * dx + dy * dy);
    const theta = Math.atan2(dx, dy);
    const lon = (theta / n + lambda0) / d2r;
    const tInv = (rho / (a * F)) ** (1 / n);
    let phi = Math.PI / 2 - 2 * Math.atan(tInv);
    for (let i = 0; i < 8; i++) {
      phi = Math.PI / 2 - 2 * Math.atan(tInv * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
    }
    return { lat: phi / d2r, lon };
  };
})();

/* ------------------------------ Texte ------------------------------- */

/** "SAINT-MAUR-DES-FOSSÉS" → "Saint-Maur-des-Fossés" (casse française).
 *  capFirst=false : les particules restent minuscules même en tête
 *  (noms de voies : "DE CHARTRES" → "de Chartres"). */
function frenchTitleCase(s, capFirst = true) {
  const minor = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'sur', 'sous', 'en', 'au', 'aux', 'et', 'lès', 'lez', 'à']);
  let first = capFirst;
  return String(s).toLowerCase().replace(/[a-zà-ÿ]+/g, (w, i, str) => {
    const beforeApos = (str[i + w.length] === "'" || str[i + w.length] === '’') && (w === 'l' || w === 'd');
    const keep = !first && (minor.has(w) || beforeApos); // Val-d'Oise, Saint-Maur-des-Fossés
    first = false;
    if (keep) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

/** Slug ASCII : "Val-d'Oise" → "val-d-oise". */
function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** http:// → https:// (les sources officielles servent toutes le TLS). */
const httpsify = (u) => (u ? String(u).trim().replace(/^http:\/\//i, 'https://') : null);

/**
 * Neutralise les mentions CEDEX : suffixe retiré de la commune, et CP déclaré
 * non géographique (null) quand il accompagne un CEDEX sans finir par 0
 * (les CP communaux franciliens finissent par 0 ; les codes CEDEX rarement).
 */
function cleanCedex(cp, commune) {
  const hadCedex = /\bcedex\b/i.test(commune || '');
  const out = { cp: cp || null, commune: (commune || '').replace(/\s*cedex\s*\d*\s*$/i, '').trim() || null };
  if (out.cp && hadCedex && !/0$/.test(out.cp)) out.cp = null;
  return out;
}

/** Supprime balises HTML et entités courantes (champs CROUS). */
function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>(\s*)/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/* ----------------------------- Sortie ------------------------------- */

/**
 * Écrit un dataset normalisé dans site/data/open/<nom>.json, enveloppé dans
 * des métadonnées de traçabilité (source, licence, date de collecte, compte).
 */
function writeDataset(name, records, meta) {
  const dir = path.join(__dirname, '..', 'data', 'open');
  fs.mkdirSync(dir, { recursive: true });
  const out = {
    _meta: {
      dataset: name,
      collectedAt: new Date().toISOString(),
      recordCount: Array.isArray(records) ? records.length : undefined,
      ...meta, // { source, sourceUrl, license, attribution, millesime… }
    },
    records,
  };
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`  ✓ ${name}.json : ${out._meta.recordCount ?? '?'} enregistrements (${(fs.statSync(file).size / 1024).toFixed(0)} Ko)`);
  return file;
}

/* --------------------------- Référentiels --------------------------- */

/** Les 8 départements franciliens. */
const DEPS_IDF = ['75', '77', '78', '91', '92', '93', '94', '95'];
const DEP_NOMS = {
  75: 'Paris', 77: 'Seine-et-Marne', 78: 'Yvelines', 91: 'Essonne',
  92: 'Hauts-de-Seine', 93: 'Seine-Saint-Denis', 94: 'Val-de-Marne', 95: "Val-d'Oise",
};
const DEP_SLUGS = Object.fromEntries(DEPS_IDF.map((d) => [d, `${slugify(DEP_NOMS[d])}-${d}`]));

module.exports = {
  get, getText, getJson, getCached, unzipEntry, parseXlsx, parseCsv, csvToObjects,
  numFr, lambert93ToWgs84, frenchTitleCase, slugify, stripHtml, httpsify, cleanCedex, writeDataset,
  DEPS_IDF, DEP_NOMS, DEP_SLUGS,
};

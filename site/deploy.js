#!/usr/bin/env node
/**
 * deploy.js — Déploiement direct upload de site/dist/ vers Cloudflare Pages.
 *
 * Exécution : node site/deploy.js
 * Prérequis : variable d'environnement CLOUDFLARE_API_TOKEN_TTA (token API du projet)
 *             et avoir buildé avant : node site/build.js
 * Dépendances : aucune. Node 18+ natif (https, fs, path, crypto).
 *
 * Flux (identique à wrangler pages deploy, sans wrangler) :
 *   1. GET  /pages/projects/{name}/upload-token        → JWT d'upload
 *   2. POST /pages/assets/check-missing  (Bearer JWT)  → hashes manquants
 *   3. POST /pages/assets/upload         (Bearer JWT)  → upload base64
 *   4. POST /pages/assets/upsert-hashes  (Bearer JWT)
 *   5. POST /pages/projects/{name}/deployments (multipart manifest) → déploiement
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const ACCOUNT_ID = '4ff7ffbc3e0113654d9b826146097d27';
const PROJECT = 'trouve-ton-appart';
const DIST = path.join(__dirname, 'dist');
const TOKEN = process.env.CLOUDFLARE_API_TOKEN_TTA;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base + '/' + entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// Hash de contenu : 32 hex. Wrangler utilise blake3(base64+ext) ; le backend
// traite le hash comme une clé de cache — sha256 tronqué fonctionne aussi.
function hashFile(b64, ext) {
  return crypto.createHash('sha256').update(b64 + ext).digest('hex').slice(0, 32);
}

async function main() {
  if (!TOKEN) throw new Error('Variable CLOUDFLARE_API_TOKEN_TTA absente');
  if (!fs.existsSync(DIST)) throw new Error('site/dist/ introuvable — lancer node site/build.js');

  const files = walk(DIST).map((rel) => {
    const ext = path.extname(rel);
    const content = fs.readFileSync(path.join(DIST, rel));
    const b64 = content.toString('base64');
    return {
      rel,
      b64,
      hash: hashFile(b64, ext.replace('.', '')),
      contentType: CONTENT_TYPES[ext] || 'application/octet-stream',
    };
  });
  console.log(`${files.length} fichiers dans dist/`);

  // 1. JWT d'upload
  const jwtRes = await request(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT}/upload-token`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  const jwt = JSON.parse(jwtRes.body).result?.jwt;
  if (!jwt) throw new Error('upload-token: ' + jwtRes.body);
  const jwtHeaders = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

  // 2. Hashes manquants
  const missingRes = await request('https://api.cloudflare.com/client/v4/pages/assets/check-missing', {
    method: 'POST',
    headers: jwtHeaders,
    body: JSON.stringify({ hashes: files.map((f) => f.hash) }),
  });
  const missing = new Set(JSON.parse(missingRes.body).result || []);
  console.log(`${missing.size} fichiers à uploader`);

  // 3. Upload
  if (missing.size) {
    const payload = files
      .filter((f) => missing.has(f.hash))
      .map((f) => ({ key: f.hash, value: f.b64, metadata: { contentType: f.contentType }, base64: true }));
    const upRes = await request('https://api.cloudflare.com/client/v4/pages/assets/upload', {
      method: 'POST',
      headers: jwtHeaders,
      body: JSON.stringify(payload),
    });
    const up = JSON.parse(upRes.body);
    if (!up.success) throw new Error('upload: ' + upRes.body);
    console.log('Upload OK');
  }

  // 4. Upsert
  await request('https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes', {
    method: 'POST',
    headers: jwtHeaders,
    body: JSON.stringify({ hashes: files.map((f) => f.hash) }),
  });

  // 5. Déploiement (multipart : champ manifest)
  const manifest = {};
  for (const f of files) manifest[f.rel] = f.hash;
  const boundary = '----mkzdeploy' + crypto.randomBytes(8).toString('hex');
  const mp = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="manifest"',
    '',
    JSON.stringify(manifest),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const depRes = await request(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT}/deployments`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: mp,
    }
  );
  const dep = JSON.parse(depRes.body);
  if (!dep.success) throw new Error('deployment: ' + depRes.body);
  console.log(`Déploiement créé: ${dep.result.id}`);
  console.log(`URL: ${dep.result.url}`);
}

main().catch((e) => {
  console.error('ERREUR:', e.message);
  process.exit(1);
});

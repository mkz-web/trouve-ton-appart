#!/usr/bin/env node
/**
 * generate-og.js — Génère site/static/og-image.png (1200×630) pour les
 * partages sociaux (Open Graph / Twitter Cards).
 *
 * Méthode : carte HTML aux couleurs de la DA, capturée par Edge ou Chrome
 * en headless (--screenshot). Rien à installer : on utilise le navigateur
 * Chromium déjà présent sur l'OS.
 *
 * Exécution : node site/generate-og.js   (une fois ; le PNG est versionné,
 * le build Cloudflare le copie ensuite tel quel via site/static/)
 * Dépendances : aucune. Node 14+ natif + Edge/Chrome installé.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const OUT = path.join(__dirname, 'static', 'og-image.png');

const browser = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));
if (!browser) { console.error('Aucun navigateur Chromium trouvé'); process.exit(1); }

/* Carte 1200×630 : marque + accroche + skyline (mêmes formes que le hero du site) */
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;font-family:"Segoe UI",system-ui,Arial,sans-serif;
background:linear-gradient(160deg,#e8f1f9 0%,#ffffff 70%);overflow:hidden;position:relative}
.bar{position:absolute;top:0;left:0;right:0;height:14px;background:linear-gradient(90deg,#1f4e79 60%,#e07a5f)}
.txt{position:absolute;left:80px;top:130px;max-width:640px}
h1{font-size:64px;color:#1f4e79;letter-spacing:-1px;line-height:1.1}
p{font-size:30px;color:#5b6770;margin-top:26px;line-height:1.4}
.tag{display:inline-block;margin-top:34px;background:#c2563c;color:#fff;font-size:26px;font-weight:600;
padding:14px 30px;border-radius:12px}
svg{position:absolute;right:40px;bottom:0;width:430px}
</style></head><body>
<div class="bar"></div>
<div class="txt">
  <h1>Trouve Ton Appart</h1>
  <p>Le bon guichet du logement en Île-de-France, selon votre profil&nbsp;: étudiant, logement social, mobilité pro.</p>
  <span class="tag">trouve-ton-appart.fr</span>
</div>
<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg">
  <circle cx="566" cy="54" r="26" fill="#e07a5f"/>
  <g fill="#cfe3f4"><polygon points="92,28 98,28 122,238 68,238"/><rect x="70" y="118" width="50" height="7" rx="3"/><rect x="78" y="170" width="35" height="6" rx="3"/><rect x="91" y="14" width="8" height="18" rx="2"/></g>
  <g><rect x="150" y="104" width="92" height="134" fill="#2e74b5"/><polygon points="150,104 242,104 232,82 160,82" fill="#1f4e79"/><rect x="188" y="206" width="18" height="32" rx="2" fill="#e07a5f"/></g>
  <g><rect x="256" y="64" width="106" height="174" fill="#9fc1e0"/><polygon points="256,64 362,64 350,40 268,40" fill="#2e74b5"/><rect x="296" y="210" width="20" height="28" rx="2" fill="#1f4e79"/></g>
  <g><rect x="376" y="118" width="96" height="120" fill="#4a7fae"/><polygon points="376,118 472,118 462,96 386,96" fill="#1f4e79"/><rect x="408" y="206" width="18" height="32" rx="2" fill="#faf7f2"/></g>
  <g><rect x="486" y="92" width="88" height="146" fill="#1f4e79"/><polygon points="486,92 574,92 564,70 496,70" fill="#163a5c"/></g>
  <rect x="0" y="236" width="640" height="5" rx="2.5" fill="#cfe3f4"/>
</svg>
</body></html>`;

const stamp = `og-${Date.now()}`;
const tmpHtml = path.join(os.tmpdir(), `${stamp}.html`);
const tmpProfile = path.join(os.tmpdir(), `${stamp}-profile`);
fs.writeFileSync(tmpHtml, html);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const res = spawnSync(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${tmpProfile}`, '--hide-scrollbars',
  '--window-size=1200,630', `--screenshot=${OUT}`,
  `file:///${tmpHtml.replace(/\\/g, '/')}`,
], { timeout: 60000 });

try { fs.unlinkSync(tmpHtml); } catch (e) { /* ignore */ }
try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch (e) { /* ignore */ }

if (!fs.existsSync(OUT)) { console.error('Échec capture', res.status); process.exit(1); }
console.log(`OK — ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} Ko)`);

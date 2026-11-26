#!/usr/bin/env node
/**
 * serve.js : serveur statique de développement pour dist/.
 * Dépendances : aucune. Node 14+. Exécution : node serve.js [port]
 * (Outil de dev local uniquement, la production est servie par l'hébergeur statique.)
 * Écoute 127.0.0.1 seulement : sans hôte, Node écoute toutes les interfaces et
 * le site de dev serait joignable depuis le réseau local (durcissement du 25/10/2026).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.argv[2]) || 8787;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.xml': 'application/xml', '.txt': 'text/plain', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* Redirections de dist/_redirects (liens partenaires /go/<id>/), servies comme
 * Cloudflare Pages le fait en production : sans elles, tout contrôle local
 * voyait ces liens en 404. Relu à chaque requête : un build n'exige pas de
 * relancer le serveur. */
function redirection(urlPath) {
  const f = path.join(DIST, '_redirects');
  if (!fs.existsSync(f)) return null;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    const [source, destination, code] = l.trim().split(/\s+/);
    if (source === urlPath && destination) return { destination, code: Number(code) || 302 };
  }
  return null;
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const r = redirection(urlPath);
  if (r) { res.writeHead(r.code, { Location: r.destination }); return res.end(); }
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end('Forbidden'); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Serveur de dev : http://localhost:${PORT}`));

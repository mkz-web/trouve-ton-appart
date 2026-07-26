#!/usr/bin/env node
/**
 * generate-favicon.js : génère les fichiers d'icône binaires du site.
 *   site/static/favicon.ico          (16, 32 et 48 px dans un même fichier)
 *   site/static/apple-touch-icon.png (180 px, opaque, écran d'accueil iOS)
 *
 * Le pendant vectoriel (dist/favicon.svg) est écrit par build.js à partir de
 * la constante FAVICON_SVG : même dessin, même palette. Ce script reproduit ce
 * dessin en pixels ; à relancer si le dessin ou la palette changent dans
 * build.js. Les deux fichiers produits sont versionnés et copiés tels quels
 * dans dist/ par le build (comme og-image.png).
 *
 * Méthode : rastériseur maison (16 sous-échantillons par pixel pour l'anticrénelage),
 * encodeur PNG maison (zlib natif) et conteneur ICO écrit octet par octet
 * (entrées BMP 32 bits, le format que lisent tous les navigateurs et crawlers).
 *
 * Exécution : node site/generate-favicon.js
 * Runtime minimal : Node 14+.  Dépendances : aucune.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ─── Dessin, décrit dans le repère 32×32 du SVG (viewBox="0 0 32 32") ─── */

const BLEU = [0x1f, 0x4e, 0x79];   // PAL.bleu : fond de la tuile
const BLANC = [0xff, 0xff, 0xff];  // maison
const ACCENT = [0xe0, 0x7a, 0x5f]; // PAL.accent : porte

/* path "M16 7l10 8h-3v9h-5.2v-6h-3.6v6H9v-9H6z" déplié en polygone */
const MAISON = [
  [16, 7], [26, 15], [23, 15], [23, 24], [17.8, 24],
  [17.8, 18], [14.2, 18], [14.2, 24], [9, 24], [9, 15], [6, 15],
];
/* path "M19.5 18h2.5v6h-2.5z" */
const PORTE = [[19.5, 18], [22, 18], [22, 24], [19.5, 24]];
const RAYON = 7; // rx du <rect> de fond

const dansPolygone = (pts, x, y) => {
  let dedans = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
};

const dansCarreArrondi = (x, y, cote, r) => {
  if (x < 0 || y < 0 || x > cote || y > cote) return false;
  const dx = Math.min(x, cote - x);
  const dy = Math.min(y, cote - y);
  if (dx >= r || dy >= r) return true;
  return (r - dx) ** 2 + (r - dy) ** 2 <= r * r;
};

/* Rastérisation : 4×4 sous-échantillons par pixel. La couleur du pixel est la
 * moyenne des sous-échantillons couverts, son alpha le taux de couverture :
 * c'est ce qui donne des bords lisses aux petites tailles. */
function rasteriser(taille, rayon) {
  const S = 4;
  const rgba = Buffer.alloc(taille * taille * 4); // transparent par défaut
  for (let py = 0; py < taille; py++) {
    for (let px = 0; px < taille; px++) {
      let r = 0, g = 0, b = 0, couverts = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = ((px + (sx + 0.5) / S) / taille) * 32;
          const y = ((py + (sy + 0.5) / S) / taille) * 32;
          if (!dansCarreArrondi(x, y, 32, rayon)) continue;
          const c = dansPolygone(PORTE, x, y) ? ACCENT
            : dansPolygone(MAISON, x, y) ? BLANC : BLEU;
          r += c[0]; g += c[1]; b += c[2]; couverts++;
        }
      }
      if (!couverts) continue;
      const i = (py * taille + px) * 4;
      rgba[i] = Math.round(r / couverts);
      rgba[i + 1] = Math.round(g / couverts);
      rgba[i + 2] = Math.round(b / couverts);
      rgba[i + 3] = Math.round((couverts / (S * S)) * 255);
    }
  }
  return rgba;
}

/* ─── Encodeur PNG (signature + IHDR + IDAT + IEND) ─── */

const TABLE_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function morceau(type, data) {
  const taille = Buffer.alloc(4);
  taille.writeUInt32BE(data.length, 0);
  const corps = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corps), 0);
  return Buffer.concat([taille, corps, crc]);
}

function encoderPng(taille, rgba) {
  const pas = taille * 4 + 1; // 1 octet de filtre par ligne
  const brut = Buffer.alloc(taille * pas);
  for (let y = 0; y < taille; y++) {
    brut[y * pas] = 0; // filtre None
    rgba.copy(brut, y * pas + 1, y * taille * 4, (y + 1) * taille * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(taille, 0);
  ihdr.writeUInt32BE(taille, 4);
  ihdr[8] = 8;  // 8 bits par canal
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    morceau('IHDR', ihdr),
    morceau('IDAT', zlib.deflateSync(brut, { level: 9 })),
    morceau('IEND', Buffer.alloc(0)),
  ]);
}

/* ─── Conteneur ICO : entrées BMP 32 bits (BITMAPINFOHEADER + BGRA + masque) ─── */

function entreeBmp(taille, rgba) {
  const enTete = Buffer.alloc(40);
  enTete.writeUInt32LE(40, 0);            // biSize
  enTete.writeInt32LE(taille, 4);         // biWidth
  enTete.writeInt32LE(taille * 2, 8);     // biHeight = image + masque AND
  enTete.writeUInt16LE(1, 12);            // biPlanes
  enTete.writeUInt16LE(32, 14);           // biBitCount

  const xor = Buffer.alloc(taille * taille * 4);
  for (let y = 0; y < taille; y++) {
    for (let x = 0; x < taille; x++) {
      const src = ((taille - 1 - y) * taille + x) * 4; // BMP : lignes du bas vers le haut
      const dst = (y * taille + x) * 4;
      xor[dst] = rgba[src + 2];     // B
      xor[dst + 1] = rgba[src + 1]; // G
      xor[dst + 2] = rgba[src];     // R
      xor[dst + 3] = rgba[src + 3]; // A
    }
  }
  /* Masque AND à zéro : la transparence est portée par le canal alpha. */
  const masque = Buffer.alloc(Math.ceil(taille / 8 / 4) * 4 * taille);
  enTete.writeUInt32LE(xor.length + masque.length, 20); // biSizeImage
  return Buffer.concat([enTete, xor, masque]);
}

function encoderIco(images) {
  const entete = Buffer.alloc(6);
  entete.writeUInt16LE(1, 2); // type 1 = icône
  entete.writeUInt16LE(images.length, 4);
  const repertoire = Buffer.alloc(16 * images.length);
  let offset = entete.length + repertoire.length;
  images.forEach((img, i) => {
    const e = i * 16;
    repertoire[e] = img.taille === 256 ? 0 : img.taille;
    repertoire[e + 1] = img.taille === 256 ? 0 : img.taille;
    repertoire.writeUInt16LE(1, e + 4);   // plans
    repertoire.writeUInt16LE(32, e + 6);  // bits par pixel
    repertoire.writeUInt32LE(img.data.length, e + 8);
    repertoire.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([entete, repertoire, ...images.map((i) => i.data)]);
}

/* ─── Écriture ─── */

const STATIC = path.join(__dirname, 'static');
fs.mkdirSync(STATIC, { recursive: true });

const ico = encoderIco([16, 32, 48].map((taille) => ({
  taille, data: entreeBmp(taille, rasteriser(taille, RAYON)),
})));
fs.writeFileSync(path.join(STATIC, 'favicon.ico'), ico);

/* iOS applique lui-même son masque arrondi et ne gère pas la transparence :
 * l'icône Apple est donc pleine page (rayon 0) et 100 % opaque. */
const apple = encoderPng(180, rasteriser(180, 0));
fs.writeFileSync(path.join(STATIC, 'apple-touch-icon.png'), apple);

console.log(`OK : favicon.ico (16+32+48 px, ${(ico.length / 1024).toFixed(1)} Ko) `
  + `et apple-touch-icon.png (180 px, ${(apple.length / 1024).toFixed(1)} Ko) dans site/static/`);

#!/usr/bin/env node
/**
 * build.js — Générateur de site statique « Trouve Ton Appart »
 * ------------------------------------------------------------------
 * Exécution   : node build.js
 * Runtime     : Node.js >= 14
 * Dépendances : AUCUNE (modules natifs : fs, path)
 * Entrées     : data/site.json, data/guides.json, data/parcours.json,
 *               data/annuaire.json
 * Sortie      : dist/ (HTML statique + sitemap.xml + robots.txt + CSS)
 * ------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

const SITE = read('site.json');
const GUIDES = read('guides.json');
const PARCOURS = read('parcours.json');
const ANNUAIRE = read('annuaire.json');

/* ---- Snapshots open data (Phase 2, produits par ingest/ingest.js) ----
 * Optionnels : si un snapshot manque, les pages correspondantes sont
 * simplement omises et le reste du site se construit normalement. */
const readOpen = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'open', `${f}.json`), 'utf8')); }
  catch { return null; }
};
const CROUS = readOpen('crous-residences');
const FJT = readOpen('fjt');
const RES_AUTONOMIE = readOpen('residences-autonomie');
const LS_COMMUNES = readOpen('logement-social-communes');
const ENCADREMENT = readOpen('encadrement-loyers-paris');

const DEPS_IDF = ['75', '77', '78', '91', '92', '93', '94', '95'];
const DEP_NOMS = {
  75: 'Paris', 77: 'Seine-et-Marne', 78: 'Yvelines', 91: 'Essonne',
  92: 'Hauts-de-Seine', 93: 'Seine-Saint-Denis', 94: 'Val-de-Marne', 95: "Val-d'Oise",
};
const DEP_SLUGS = {
  75: 'paris-75', 77: 'seine-et-marne-77', 78: 'yvelines-78', 91: 'essonne-91',
  92: 'hauts-de-seine-92', 93: 'seine-saint-denis-93', 94: 'val-de-marne-94', 95: 'val-d-oise-95',
};
const fmt = (n, dec = 0) => (n == null ? '—' : n.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const dateFrOf = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
/* Époques de construction de l'encadrement, dans l'ordre canonique du dataset
 * (« Apres 1990 » sans accent : clé de données, pas un libellé d'affichage). */
const EPOQUES = ['Avant 1946', '1946-1970', '1971-1990', 'Apres 1990'];

/* Index de la recherche client-side : alimenté par chaque constructeur de
 * page, écrit dans dist/search-index.json. */
const SEARCH_INDEX = [];
const pushIndex = (t, u, d, c) => SEARCH_INDEX.push({ t, u, d, c });
/* Catégories « données » de l'index (vs pages éditoriales). */
const DATA_SEARCH_CATS = ['Résidence CROUS', 'FJT', 'Résidence autonomie', 'Commune'];

/* Liens sortants issus de l'open data : seuls les schémas sûrs passent. */
const safeUrl = (u) => (/^(https?:|mailto:)/i.test(String(u || '')) ? u : '#');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* Liens [label](url) dans les contenus de guides, transformés APRÈS échappement.
 * Autorisés : chemins internes (/…) et https:// uniquement — tout le reste reste du texte. */
const inline = (s) => esc(s).replace(/\[([^\]]+)\]\((\/[^\s)]*|https:\/\/[^\s)]+)\)/g,
  (m, label, url) => (url.startsWith('/')
    ? `<a href="${url}">${label}</a>`
    : `<a href="${url}" rel="noopener" target="_blank">${label}</a>`));

/* Illustrations Gemini des pages piliers (site/static/illu-*.webp, recadrées
 * du watermark). Rendu vide si le fichier manque : le build n'en dépend pas. */
function illu(name, alt, h = 952) {
  if (!fs.existsSync(path.join(ROOT, 'static', `${name}.webp`))) return '';
  return `<img class="page-illu" src="/${name}.webp" alt="${esc(alt)}" width="1024" height="${h}" loading="lazy">`;
}
const ILLUS = {
  etudiant: illu('illu-etudiant', 'Illustration : une étudiante avec ses cartons devant une résidence étudiante parisienne', 732),
  'logement-social': illu('illu-logement-social', 'Illustration : une famille reçoit les clés de son logement'),
  mobilite: illu('illu-mobilite', 'Illustration : un professionnel en mobilité arrive à Paris avec sa valise'),
};

/* ------------------------ Direction artistique ----------------------- */
/* Palette : bleu confiance (institutionnel) + terracotta (chaleur, CTA)
 * + vert sauge. Un thème couleur par parcours pour le repérage visuel.
 * Toutes les images sont des SVG inline générés ici : zéro requête réseau,
 * zéro asset binaire, couleurs pilotées par la palette. */

const PAL = {
  bleu: '#1f4e79', bleu2: '#2e74b5', bleuClair: '#9fc1e0',
  ciel: '#cfe3f4', cielClair: '#e8f1f9',
  creme: '#faf7f2', blanc: '#ffffff', encre: '#1c2733',
  accent: '#e07a5f', accentFonce: '#c2563c', sauge: '#3d8b6e', saugeClair: '#e9f4ef',
};

/* Thème par parcours : c = couleur pleine, txt = variante texte (contraste AA
 * sur fond clair), bg = fond pâle, soft = ombre teintée (rgba précalculée —
 * changer une couleur de thème ⇒ régénérer sa rgba soft). */
const THEMES = {
  'etudiant':        { c: PAL.bleu2,       txt: PAL.bleu2,   bg: PAL.cielClair, soft: 'rgba(46,116,181,.30)' },
  'logement-social': { c: PAL.sauge,       txt: '#2e7050',   bg: PAL.saugeClair, soft: 'rgba(61,139,110,.28)' },
  'mobilite':        { c: PAL.accentFonce, txt: '#a8492f',   bg: '#fbeee9',     soft: 'rgba(194,86,60,.28)' },
};
const themeOf = (slug) => THEMES[slug] || { c: PAL.bleu, txt: PAL.bleu2, bg: PAL.cielClair, soft: 'rgba(31,78,121,.30)' };
const themeStyle = (t) => `--t:${t.c};--ttx:${t.txt};--tbg:${t.bg};--ts:${t.soft}`;

/* Pictogrammes 48×48, flat, deux tons (couleur du thème + accent). */
function icon(name, c) {
  const A = PAL.accent;
  const shapes = {
    etudiant: `<polygon points="24,9 42,17 24,25 6,17" fill="${c}"/><path d="M14 21v8c0 2.8 4.5 5 10 5s10-2.2 10-5v-8l-10 4.4z" fill="${c}" opacity=".55"/><line x1="40" y1="18" x2="40" y2="30" stroke="${A}" stroke-width="2.5" stroke-linecap="round"/><circle cx="40" cy="33" r="2.6" fill="${A}"/>`,
    'logement-social': `<rect x="11" y="18" width="26" height="22" rx="2" fill="${c}"/><polygon points="24,6 40,19 8,19" fill="${c}" opacity=".7"/>${[0, 1].map(r => [0, 1, 2].map(col => `<rect x="${15.5 + col * 6.5}" y="${23 + r * 7.5}" width="4" height="4.5" rx="1" fill="#fff"/>`).join('')).join('')}<path d="M24 45.5c-4.5-3-7.5-5.4-7.5-8.2 0-2 1.6-3.4 3.6-3.4 1.6 0 2.9.8 3.9 2.2 1-1.4 2.3-2.2 3.9-2.2 2 0 3.6 1.4 3.6 3.4 0 2.8-3 5.2-7.5 8.2z" fill="${A}"/>`,
    mobilite: `<rect x="9" y="17" width="30" height="22" rx="3.5" fill="${c}"/><path d="M19 17v-3.5a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3V17h-3v-3h-4v3z" fill="${c}" opacity=".7"/><line x1="19" y1="20" x2="19" y2="36" stroke="#fff" stroke-width="2" opacity=".5"/><line x1="29" y1="20" x2="29" y2="36" stroke="#fff" stroke-width="2" opacity=".5"/><line x1="2" y1="23" x2="6" y2="23" stroke="${A}" stroke-width="2.5" stroke-linecap="round"/><line x1="0" y1="29" x2="6" y2="29" stroke="${A}" stroke-width="2.5" stroke-linecap="round" opacity=".7"/><line x1="3" y1="35" x2="6" y2="35" stroke="${A}" stroke-width="2.5" stroke-linecap="round" opacity=".45"/>`,
    visale: `<path d="M24 5l15 5v11c0 9.5-6.4 17.3-15 21-8.6-3.7-15-11.5-15-21V10z" fill="${c}"/><path d="M16.5 24.5l5 5 10-10.5" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    'demande-logement-social': `<rect x="12" y="6" width="22" height="32" rx="2.5" fill="${c}"/>${[14, 19.5, 25].map(y => `<line x1="17" y1="${y}" x2="29" y2="${y}" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".75"/>`).join('')}<path d="M28 41.5l3-9 7.5 2.5-3 9-4.6 1.5z" fill="${A}"/>`,
    'bail-mobilite': `<rect x="8" y="10" width="32" height="30" rx="3" fill="${c}"/><rect x="8" y="10" width="32" height="8" rx="3" fill="${c}" style="filter:brightness(.78)"/><line x1="17" y1="6" x2="17" y2="13" stroke="${c}" stroke-width="3" stroke-linecap="round"/><line x1="31" y1="6" x2="31" y2="13" stroke="${c}" stroke-width="3" stroke-linecap="round"/><circle cx="20" cy="29" r="4.5" fill="none" stroke="${A}" stroke-width="2.5"/><line x1="24" y1="29" x2="33" y2="29" stroke="${A}" stroke-width="2.5" stroke-linecap="round"/><line x1="30" y1="29" x2="30" y2="33" stroke="${A}" stroke-width="2.5" stroke-linecap="round"/>`,
    'garant-location': `<circle cx="17" cy="16" r="6.5" fill="${c}"/><path d="M5 40c0-7.5 5.4-12 12-12s12 4.5 12 12z" fill="${c}"/><circle cx="34" cy="18" r="5" fill="${A}"/><path d="M25 40c.6-6.5 4.4-10 9-10 4.7 0 8.5 3.5 9 10z" fill="${A}"/>`,
    'aide-logement-etudiant': `${[34, 29, 24].map((y, i) => `<ellipse cx="18" cy="${y}" rx="11" ry="4.5" fill="${c}" opacity="${1 - i * 0.22}"/>`).join('')}<circle cx="35" cy="15" r="9.5" fill="${A}"/><text x="35" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="system-ui,Arial">€</text>`,
    'logement-intermediaire': `<rect x="5" y="24" width="11" height="17" rx="1.5" fill="${c}" opacity=".5"/><rect x="32" y="24" width="11" height="17" rx="1.5" fill="${c}" opacity=".5"/><rect x="18" y="13" width="12" height="28" rx="1.5" fill="${A}"/>${[17, 23, 29].map(y => `<rect x="21.5" y="${y}" width="5" height="3.5" rx="1" fill="#fff" opacity=".85"/>`).join('')}`,
    annuaire: `<circle cx="24" cy="24" r="18" fill="${c}"/><circle cx="24" cy="24" r="13" fill="#fff"/><polygon points="24,13.5 27.5,24 24,34.5 20.5,24" fill="${A}"/><circle cx="24" cy="24" r="2.4" fill="${c}"/>`,
    dossierfacile: `<path d="M6 13a3 3 0 0 1 3-3h9l4 4h13a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" fill="${c}"/><circle cx="33" cy="31" r="8" fill="${A}"/><path d="M29.5 31l2.5 2.5 5-5.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    'recours-dalo': `<rect x="22.8" y="8" width="2.4" height="28" rx="1.2" fill="${c}"/><rect x="8" y="12" width="32" height="2.6" rx="1.3" fill="${c}"/><path d="M8 24a6 6 0 0 0 12 0l-6-10zM8.8 23h10.4" fill="${c}" opacity=".75"/><path d="M28 24a6 6 0 0 0 12 0l-6-10z" fill="${A}" opacity=".9"/><rect x="16" y="36" width="16" height="3.5" rx="1.75" fill="${c}"/><circle cx="24" cy="11" r="3" fill="${A}"/>`,
    'aide-mobili-jeune': `<polygon points="19,8 34,20 4,20" fill="${c}" opacity=".75"/><rect x="7" y="20" width="24" height="19" rx="2" fill="${c}"/><rect x="15" y="28" width="8" height="11" rx="1.5" fill="#fff" opacity=".85"/><circle cx="37" cy="32" r="9.5" fill="${A}"/><text x="37" y="37" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="system-ui,Arial">€</text>`,
    'avance-loca-pass': `<rect x="6" y="14" width="30" height="22" rx="4" fill="${c}"/><path d="M6 20h30v5H6z" fill="#fff" opacity=".25"/><rect x="26" y="22" width="10" height="8" rx="2.5" fill="#fff" opacity=".85"/><circle cx="38" cy="18" r="8.5" fill="${A}"/><text x="38" y="22.5" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="system-ui,Arial">0%</text>`,
    'fonds-solidarite-logement': `<circle cx="24" cy="24" r="17" fill="${c}"/><circle cx="24" cy="24" r="8" fill="#fff"/>${[0, 45, 90, 135].map(a => `<rect x="22.6" y="4" width="2.8" height="7" rx="1.4" fill="#fff" opacity=".6" transform="rotate(${a} 24 24)"/><rect x="22.6" y="37" width="2.8" height="7" rx="1.4" fill="#fff" opacity=".6" transform="rotate(${a} 24 24)"/>`).join('')}<circle cx="24" cy="24" r="4" fill="${A}"/>`,
    'foyer-jeune-travailleur': `<rect x="12" y="8" width="26" height="31" rx="2" fill="${c}"/>${[13, 20, 27].map(y => [17, 25.5].map(x => `<rect x="${x}" y="${y}" width="5" height="4.5" rx="1" fill="#fff" opacity=".8"/>`).join('')).join('')}<circle cx="11" cy="27" r="4.5" fill="${A}"/><path d="M3.5 41c.5-5.5 3.6-8.5 7.5-8.5s7 3 7.5 8.5z" fill="${A}"/>`,
    'encadrement-des-loyers-paris': `<path d="M8 10a3 3 0 0 1 3-3h12l17 17a3 3 0 0 1 0 4.2L29.2 39a3 3 0 0 1-4.2 0L8 22z" fill="${c}"/><circle cx="16" cy="15" r="3" fill="#fff"/><text x="27" y="29" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" font-family="system-ui,Arial">€</text><line x1="40" y1="8" x2="40" y2="20" stroke="${A}" stroke-width="2.5" stroke-linecap="round"/><path d="M36 16l4 5 4-5" fill="none" stroke="${A}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    'siao-115-hebergement-urgence': `<path d="M24 6L43 23h-5v15a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V23H5z" fill="${c}"/><rect x="19.5" y="28" width="9" height="12" rx="1.5" fill="#fff" opacity=".85"/><circle cx="38" cy="34" r="9.5" fill="${A}"/><text x="38" y="38" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fff" font-family="system-ui,Arial">115</text>`,
    solibail: `<path d="M24 6L43 23h-5v15a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V23H5z" fill="${c}"/><rect x="19.5" y="28" width="9" height="12" rx="1.5" fill="#fff" opacity=".85"/><circle cx="38" cy="34" r="9.5" fill="${A}"/><path d="M33.5 34l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    'residence-sociale': `<rect x="10" y="8" width="24" height="31" rx="2" fill="${c}"/>${[13, 20, 27].map(y => [15, 23.5].map(x => `<rect x="${x}" y="${y}" width="5" height="4.5" rx="1" fill="#fff" opacity=".8"/>`).join('')).join('')}<path d="M38 45.5c-4.5-3-7.5-5.4-7.5-8.2 0-2 1.6-3.4 3.6-3.4 1.6 0 2.9.8 3.9 2.2 1-1.4 2.3-2.2 3.9-2.2 2 0 3.6 1.4 3.6 3.4 0 2.8-3 5.2-7.5 8.2z" fill="${A}"/>`,
    'logement-fonctionnaire': `<rect x="8" y="12" width="26" height="27" rx="2" fill="${c}"/><polygon points="8,12 34,12 31,5 11,5" fill="${c}" opacity=".7"/>${[17, 24].map(y => [13, 21].map(x => `<rect x="${x}" y="${y}" width="5" height="4.5" rx="1" fill="#fff" opacity=".8"/>`).join('')).join('')}<circle cx="38" cy="33" r="9.5" fill="${A}"/><text x="38" y="37.5" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" font-family="system-ui,Arial">RF</text>`,
  };
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${shapes[name] || shapes.annuaire}</svg>`;
}

/* Skyline parisienne du hero : façades haussmanniennes stylisées,
 * tour Eiffel en silhouette, soleil terracotta. La porte terracotta
 * s'éclaire au survol du CTA principal (même langage que la marque).
 * Deux plans (ciel lointain / façades) pour la parallaxe au scroll ;
 * le drift des nuages vit sur le g interne, jamais sur le wrapper
 * (deux animations sur le même élément se neutraliseraient). */
function skyline() {
  let wi = 0;
  /* 1 fenêtre sur 3 reçoit un rect jumeau « allumé » (crème chaud), délai
   * calculé de bas en haut : la ville s'habite dans l'ordre, une fois,
   * puis reste allumée. Délais déterministes : build reproductible. */
  const win = (x0, y0, cols, rows, fill, w = 8, h = 11, gx = 16, gy = 19) => {
    let s = '';
    for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
      const base = `x="${x0 + col * gx}" y="${y0 + r * gy}" width="${w}" height="${h}" rx="1.5"`;
      s += `<rect ${base} fill="${fill}"/>`;
      if (wi % 3 === 0) {
        const del = (0.9 + (rows - 1 - r) * 0.18 + ((wi * 37) % 120) / 1000).toFixed(2);
        s += `<rect class="w-lit" style="animation-delay:${del}s" ${base} fill="#ffdfae"/>`;
      }
      wi++;
    }
    return s;
  };
  return `<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" class="illo-skyline">
  <g class="plan-ciel">
  <circle class="soleil-halo" cx="566" cy="54" r="34" fill="${PAL.accent}" opacity=".22"/>
  <circle class="soleil" cx="566" cy="54" r="26" fill="${PAL.accent}"/>
  <g fill="#fff" opacity=".9"><ellipse cx="120" cy="44" rx="34" ry="11"/><ellipse cx="148" cy="38" rx="22" ry="9"/><ellipse cx="448" cy="70" rx="30" ry="10"/></g>
  </g>
  <g class="plan-facades">
  <g fill="${PAL.ciel}"><polygon points="92,28 98,28 122,238 68,238"/><rect x="70" y="118" width="50" height="7" rx="3"/><rect x="78" y="170" width="35" height="6" rx="3"/><rect x="91" y="14" width="8" height="18" rx="2"/></g>
  <g><rect x="150" y="104" width="92" height="134" fill="${PAL.bleu2}"/><polygon points="150,104 242,104 232,82 160,82" fill="${PAL.bleu}"/><rect x="168" y="70" width="7" height="16" fill="${PAL.bleu}"/>${win(162, 116, 5, 5, PAL.cielClair)}<rect class="porte" x="188" y="206" width="18" height="32" rx="2" fill="${PAL.accent}"/><ellipse class="porte-lueur" cx="197" cy="239" rx="18" ry="4" fill="${PAL.accent}"/></g>
  <g><rect x="256" y="64" width="106" height="174" fill="${PAL.bleuClair}"/><polygon points="256,64 362,64 350,40 268,40" fill="${PAL.bleu2}"/><rect x="282" y="28" width="7" height="16" fill="${PAL.bleu2}"/>${win(268, 76, 6, 7, PAL.blanc)}<rect x="296" y="210" width="20" height="28" rx="2" fill="${PAL.bleu}"/></g>
  <g><rect x="376" y="118" width="96" height="120" fill="#4a7fae"/><polygon points="376,118 472,118 462,96 386,96" fill="${PAL.bleu}"/>${win(388, 130, 5, 4, PAL.cielClair)}<rect x="408" y="206" width="18" height="32" rx="2" fill="${PAL.creme}"/></g>
  <g><rect x="486" y="92" width="88" height="146" fill="${PAL.bleu}"/><polygon points="486,92 574,92 564,70 496,70" fill="#163a5c"/><rect x="540" y="58" width="7" height="16" fill="#163a5c"/>${win(497, 104, 5, 5, PAL.ciel)}</g>
  <g><circle cx="606" cy="206" r="18" fill="${PAL.sauge}"/><rect x="603" y="216" width="6" height="22" rx="2" fill="#7a5c43"/></g>
  <g><circle cx="38" cy="212" r="14" fill="${PAL.sauge}"/><rect x="35.5" y="220" width="5" height="18" rx="2" fill="#7a5c43"/></g>
  <rect x="0" y="236" width="640" height="5" rx="2.5" fill="${PAL.ciel}"/>
  </g>
</svg>`;
}

/* Icône d'un guide = thème de son premier parcours ; picto dédié par slug. */
const guideTheme = (g) => themeOf(g.parcours && g.parcours[0]);

const FAVICON = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${PAL.bleu}"/><path d="M16 7l10 8h-3v9h-5.2v-6h-3.6v6H9v-9H6z" fill="#fff"/><path d="M19.5 18h2.5v6h-2.5z" fill="${PAL.accent}"/></svg>`);

/* Marque du header : tuile « verre » + maison blanche, porte terracotta
 * (même langage que le favicon). La porte s'éclaire au survol. */
const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="8" fill="#fff" opacity=".13"/><rect x="1" y="1" width="30" height="30" rx="7" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/><path d="M16 6.5l10.5 8.4h-3.1v9.6h-5.5v-6.2h-3.8v6.2H8.6v-9.6H5.5z" fill="#fff"/><path d="M19.4 18.3h2.5v6.2h-2.5z" class="brand-door" fill="${PAL.accent}"/></svg>`;
/* Wordmark : dernier mot du nom en accent, son « A » initial remplacé par
 * une maison-lettre (pignon = chapeau du A, porte = contrepoinçon). */
const BRAND_A = `<svg class="brand-a" viewBox="0 0 24 25" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M12 1l11 9.5V25h-7v-7.6H8V25H1V10.5z" fill="currentColor"/></svg>`;
const brandWords = SITE.name.split(' ');
const brandLastWord = brandWords.pop();
const BRAND_HTML = `${esc(brandWords.join(' '))} <em>${brandLastWord.startsWith('A') ? BRAND_A + esc(brandLastWord.slice(1)) : esc(brandLastWord)}</em>`;

/* ----------------------------- Layout ------------------------------ */

/* View Transitions cross-document : fondu-glissé court entre pages, header
 * et footer épinglés (immobiles), pilule du menu qui morphe. Chromium 126+
 * et Safari 18.2+ ; ailleurs, navigation classique. Les pseudo-éléments
 * ::view-transition échappent au kill switch reduced-motion : TOUT le bloc
 * doit vivre sous no-preference. Exclu des pages tableaux 464 lignes
 * (coût de snapshot) : sans opt-in des deux côtés, pas de transition. */
const VT_CSS = `<style>@media(prefers-reduced-motion:no-preference){
@view-transition{navigation:auto}
.site-header{view-transition-name:site-header}
.site-footer{view-transition-name:site-footer}
.main-nav a[aria-current]{view-transition-name:nav-actif}
::view-transition-old(root){animation-duration:.18s}
::view-transition-new(root){animation:vt-in .24s cubic-bezier(.2,.7,.3,1)}
@keyframes vt-in{from{opacity:0;transform:translateY(8px)}}
}</style>`;

/* Compteurs, jauges et pause de la skyline : IntersectionObserver uniquement,
 * garde matchMedia obligatoire (le kill switch CSS ne coupe jamais un rAF). */
const ANIM_JS = `<script>
/* iOS n'applique :active au tactile que si un listener touchstart existe. */
document.addEventListener('touchstart',function(){},{passive:true});
(function(){
if(matchMedia('(prefers-reduced-motion: reduce)').matches||!('IntersectionObserver' in window))return;
/* Compteurs : la valeur finale est déjà dans le HTML ; on la rejoue
 * visuellement, largeur figée avant (zéro CLS), texte d'origine restauré. */
var cpt=document.querySelectorAll('.compte');
if(cpt.length){var cio=new IntersectionObserver(function(es){es.forEach(function(en){
 if(!en.isIntersecting)return;cio.unobserve(en.target);
 var el=en.target,fin=parseFloat(el.getAttribute('data-compte')),txt=el.textContent,t0=null;
 el.style.display='inline-block';el.style.minWidth=el.offsetWidth+'px';
 function tick(ts){if(!t0)t0=ts;var p=Math.min((ts-t0)/900,1);
  el.textContent=p<1?Math.round(fin*(1-Math.pow(2,-10*p))).toLocaleString('fr-FR'):txt;
  if(p<1)requestAnimationFrame(tick)}
 requestAnimationFrame(tick)})},{threshold:.6});
 cpt.forEach(function(e){cio.observe(e)})}
/* Jauges des tableaux : jauge-anim met les barres à zéro, in-view les libère. */
var rows=[];
document.querySelectorAll('table.data').forEach(function(t){
 if(t.querySelector('td.bar')){t.classList.add('jauge-anim');rows.push.apply(rows,t.querySelectorAll('tbody tr'))}});
if(rows.length){var jio=new IntersectionObserver(function(es){es.forEach(function(en){
 if(en.isIntersecting){en.target.classList.add('in-view');jio.unobserve(en.target)}})},{rootMargin:'0px 0px -8% 0px'});
 rows.forEach(function(r){jio.observe(r)})}
/* Skyline : boucles (nuages, halo) en pause hors viewport (batterie). */
var illo=document.querySelector('.illo-skyline');
if(illo){new IntersectionObserver(function(es){es.forEach(function(en){
 illo.classList.toggle('pause',!en.isIntersecting)})}).observe(illo)}
})();
</script>`;

const BUILD_DATE = new Date();
const DATE_ISO = BUILD_DATE.toISOString().slice(0, 10);
const DATE_FR = BUILD_DATE.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const DATE_PUBLICATION = '2026-06-10';

function layout({ title, metaDescription, urlPath, h1: _h1, content, jsonLd = [], breadcrumbs = null }) {
  const canonical = SITE.baseUrl + urlPath;
  /* aria-current : annonce « page courante » aux lecteurs d'écran ; porte
   * aussi l'état visuel « vous êtes ici » du menu (pilule + barre).
   * « page » = correspondance exacte seulement ; une sous-page de la
   * section (ex. /logement-social/chiffres/) reçoit « true » (spec ARIA). */
  const navLink = (href, label) => {
    const cur = urlPath === href ? 'page' : urlPath.startsWith(href) ? 'true' : '';
    return `<a href="${href}"${cur ? ` aria-current="${cur}"` : ''}>${label}</a>`;
  };
  const nav = PARCOURS.map(p => navLink(`/${p.slug}/`, esc(p.nav))).join('');
  if (breadcrumbs) {
    jsonLd = jsonLd.concat([{
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [{ name: 'Accueil', url: '/' }].concat(breadcrumbs).map((b, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: b.name,
        ...(b.url ? { item: SITE.baseUrl + b.url } : {}),
      })),
    }]);
  }
  /* Échappement spécifique au contexte <script> : JSON.stringify ne protège
   * ni « < » ni « </script> » — une donnée open data hostile pourrait sinon
   * fermer la balise et injecter du HTML. Le JSON reste strictement valide. */
  const ldEsc = (o) => JSON.stringify(o)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const ld = jsonLd.map(o => `<script type="application/ld+json">${ldEsc(o)}</script>`).join('\n');
  const footGuides = GUIDES.map(g => `<li><a href="/guides/${g.slug}/">${esc(g.h1)}</a></li>`).join('');
  const footParcours = PARCOURS.map(p => `<li><a href="/${p.slug}/">${esc(p.nav)}</a></li>`).join('');
  const footData = [
    CROUS && '<li><a href="/residences-crous/">Résidences CROUS</a></li>',
    FJT && '<li><a href="/foyers-jeunes-travailleurs/">Foyers de jeunes travailleurs</a></li>',
    RES_AUTONOMIE && '<li><a href="/residences-autonomie/">Résidences autonomie (seniors)</a></li>',
    LS_COMMUNES && '<li><a href="/logement-social/chiffres/">Le logement social en chiffres</a></li>',
    '<li><a href="/recherche/">Rechercher sur le site</a></li>',
  ].filter(Boolean).join('');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDescription)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${FAVICON}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(metaDescription)}">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="fr_FR">
<meta property="og:image" content="${SITE.baseUrl}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(metaDescription)}">
<meta name="twitter:image" content="${SITE.baseUrl}/og-image.png">
<style>${css()}</style>
${urlPath.startsWith('/logement-social/chiffres/') ? '' : VT_CSS}
${ld}
</head>
<body>
<header class="site-header">
  <div class="container">
    <a class="brand" href="/" aria-label="${esc(SITE.name)}, accueil">${BRAND_MARK}<span class="brand-text" aria-hidden="true">${BRAND_HTML}<span class="brand-sub">Île-de-France</span></span></a>
    <nav class="main-nav">${nav}${navLink('/annuaire/', 'Annuaire')}${navLink('/recherche/', 'Rechercher')}</nav>
  </div>
</header>
<main class="container">
${content}
</main>
<svg class="roofline" viewBox="0 0 640 22" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path fill="#1c2733" d="M0 22V13h26l7-7 7 7h46V7h34l9-5 9 5h50v7h38l11-9 11 9h56V6h42l8-6 8 6h46v9h40l9-7 9 7h52V8h38l9-6 9 6h66v14z"/></svg>
<footer class="site-footer">
  <div class="container footer-grid">
    <div>
      <p class="footer-brand">${esc(SITE.name)}</p>
      <p>${esc(SITE.tagline)}. Un service d'orientation indépendant : nous vous guidons vers les dispositifs et les sources officielles, gratuitement.</p>
    </div>
    <div>
      <p class="footer-title">Parcours</p>
      <ul>${footParcours}<li><a href="/annuaire/">Annuaire des sources fiables</a></li></ul>
      <p class="footer-title">Données &amp; annuaires</p>
      <ul>${footData}</ul>
    </div>
    <div>
      <p class="footer-title">Guides pratiques</p>
      <ul>${footGuides}</ul>
    </div>
  </div>
  <div class="container footer-legal">
    <p>© ${SITE.annee} ${esc(SITE.name)} · <a href="/mentions-legales/">Mentions légales</a></p>
  </div>
</footer>
${ANIM_JS}
</body>
</html>`;
}

/* ----------------------------- Pages -------------------------------- */

const pages = []; // { urlPath, html, priority }

function addPage(urlPath, html, priority) {
  pages.push({ urlPath, html, priority });
}

/* Accueil */
(function buildHome() {
  const cards = PARCOURS.map(p => {
    const t = themeOf(p.slug);
    return `
  <a class="card card-parcours" href="/${p.slug}/" style="${themeStyle(t)}">
    <span class="card-icon">${icon(p.slug, t.c)}</span>
    <h3>${esc(p.nav)}</h3>
    <p>${esc(p.intro.split('. ')[0])}.</p>
    <span class="card-cta"><span class="cta-label">Voir le parcours</span> <span class="cta-arrow" aria-hidden="true">→</span></span>
  </a>`;
  }).join('');
  const guideCards = GUIDES.map(g => {
    const t = guideTheme(g);
    return `
  <a class="card card-guide" href="/guides/${g.slug}/" style="${themeStyle(t)}">
    <span class="card-icon card-icon-sm">${icon(g.slug, t.c)}</span>
    <div><h3>${esc(g.h1)}</h3>
    <p>${esc(g.metaDescription.split('. ')[0])}.</p></div>
  </a>`;
  }).join('');
  const content = `
<section class="hero">
  <div class="hero-text">
    <h1>Le logement en Île-de-France, enfin dans le bon ordre.</h1>
    <p class="lead">Étudiant, demandeur de logement social, senior, salarié en mobilité&nbsp;: chaque profil a ses dispositifs, ses aides et ses guichets, souvent méconnus. ${esc(SITE.name)} vous oriente, gratuitement, vers les bonnes démarches et les sources officielles.</p>
    <p class="hero-actions"><a class="btn" href="#parcours">Trouver mon parcours</a><a class="btn btn-ghost" href="/annuaire/">Voir les sources fiables</a></p>
  </div>
  <div class="hero-illo">${skyline()}</div>
</section>
<section id="parcours">
  <h2>Quelle est votre situation&nbsp;?</h2>
  <div class="grid grid-accueil">${cards}</div>
</section>
<section>
  <h2>Les guides essentiels</h2>
  <div class="grid grid-guides">${guideCards}</div>
  <p><a href="/guides/">Voir tous les guides <span class="cta-arrow" aria-hidden="true">→</span></a></p>
</section>
<section>
  <h2>Comment ça marche&nbsp;?</h2>
  <div class="steps">
    <div class="step"><h3>Identifiez votre profil</h3><p>Étudiant ou jeune actif, demandeur de logement social, senior, personne à mobilité réduite, salarié en mission ou expatrié de retour&nbsp;: chaque situation ouvre des droits différents. Choisissez le parcours qui correspond à la vôtre.</p></div>
    <div class="step"><h3>Suivez les étapes dans le bon ordre</h3><p>Sécuriser un garant avant de candidater, déposer sa demande unique avant de viser un bailleur précis, vérifier l'encadrement des loyers avant de signer&nbsp;: l'ordre des démarches change tout. Chaque parcours vous donne la séquence qui fonctionne.</p></div>
    <div class="step"><h3>Candidatez à la source</h3><p>Nous ne publions pas d'annonces&nbsp;: chaque guide renvoie vers le site officiel ou la plateforme qui fait foi (CROUS, demande-logement-social.gouv.fr, Action Logement, bailleurs). Vous candidatez là où votre dossier est réellement traité.</p></div>
  </div>
</section>
<section class="notice">
  <h2>Pourquoi ce site&nbsp;?</h2>
  <p>Le logement francilien est éclaté entre des dizaines de plateformes, de guichets et de dispositifs. Résultat&nbsp;: des droits non utilisés (Visale, Loca-Pass, logement intermédiaire…) et des parcours subis. Nous remettons de l'ordre&nbsp;: pas d'annonces dupliquées, pas de fausses promesses, mais des parcours clairs et des liens directs vers les sources qui font foi.</p>
</section>`;
  pushIndex(`${SITE.name}, accueil`, '/', SITE.description, 'Page');
  addPage('/', layout({
    title: `${SITE.name} : logement en Île-de-France par profil`,
    metaDescription: SITE.description,
    urlPath: '/',
    content,
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE.name,
      url: SITE.baseUrl,
      description: SITE.description,
      inLanguage: 'fr-FR'
    }, {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: SITE.name,
      url: SITE.baseUrl,
      logo: `${SITE.baseUrl}/og-image.png`,
      description: SITE.description
    }]
  }), '1.0');
})();

/* Hubs parcours */
for (const p of PARCOURS) {
  const etapes = p.etapes.map(e => {
    const links = e.guides.map(slug => {
      const g = GUIDES.find(x => x.slug === slug);
      return g ? `<a class="pill" href="/guides/${g.slug}/">${esc(g.h1)}</a>` : '';
    }).join(' ');
    return `<div class="step"><h2>${esc(e.titre.replace(/^\d+\.\s*/, ''))}</h2><p>${esc(e.texte)}</p>${links ? `<p class="pills">${links}</p>` : ''}</div>`;
  }).join('');
  const cats = ANNUAIRE.categories.filter(c => p.annuaireCategories.includes(c.id));
  const annuaireBlock = cats.map(c => `
  <h3>${esc(c.titre)}</h3>
  <ul class="sources">${c.sources.map(s => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.nom)}</a> · ${esc(s.desc)}</li>`).join('')}</ul>`).join('');
  /* Liens vers nos annuaires issus de l'open data (Phase 2) */
  const dataLinksOf = {
    etudiant: [
      CROUS && { u: '/residences-crous/', t: `Les ${CROUS.records.length} résidences CROUS d'Île-de-France` },
      FJT && { u: '/foyers-jeunes-travailleurs/', t: 'Les foyers de jeunes travailleurs (FJT)' },
    ],
    'logement-social': [
      LS_COMMUNES && { u: '/logement-social/chiffres/', t: 'Le logement social commune par commune : parc, loyers, vacance' },
      RES_AUTONOMIE && { u: '/residences-autonomie/', t: `Les ${RES_AUTONOMIE.records.length} résidences autonomie (seniors)` },
      FJT && { u: '/foyers-jeunes-travailleurs/', t: 'Les foyers de jeunes travailleurs (FJT)' },
    ],
    mobilite: [],
  };
  const dataLinks = (dataLinksOf[p.slug] || []).filter(Boolean)
    .map(l => `<a class="pill" href="${l.u}">${esc(l.t)}</a>`).join(' ');
  const t = themeOf(p.slug);
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › ${esc(p.nav)}</nav>
<header class="page-head" style="${themeStyle(t)}">
  <span class="page-head-icon">${icon(p.slug, t.c)}</span>
  <div>
    <p class="kicker">Parcours</p>
    <h1>${esc(p.h1)}</h1>
    <p class="lead">${esc(p.intro)}</p>
  </div>
  ${ILLUS[p.slug] || ''}
</header>
<div class="steps" style="${themeStyle(t)}">
${etapes}
</div>
<section class="notice">
  <h2>Où chercher&nbsp;: les sources fiables pour ce profil</h2>
  ${annuaireBlock}
  ${dataLinks ? `<h3>Nos annuaires (données publiques)</h3><p class="pills">${dataLinks}</p>` : ''}
  <p><a href="/annuaire/">Voir l'annuaire complet <span class="cta-arrow" aria-hidden="true">→</span></a></p>
</section>`;
  pushIndex(p.h1, `/${p.slug}/`, p.metaDescription, 'Parcours');
  addPage(`/${p.slug}/`, layout({
    title: p.title,
    metaDescription: p.metaDescription,
    urlPath: `/${p.slug}/`,
    content,
    breadcrumbs: [{ name: p.nav, url: `/${p.slug}/` }]
  }), '0.9');
}

/* Guides */

/* Ancre stable dérivée d'un titre de section (sommaire actif des guides). */
const DIACRITIQUES = new RegExp('[\\u0300-\\u036f]', 'g');
function anchorOf(txt, used) {
  let id = txt.toLowerCase().normalize('NFD').replace(DIACRITIQUES, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
  const base = id;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

for (const g of GUIDES) {
  const usedIds = new Set(['faq', 'verifier']);
  const tocItems = [];
  const sections = g.sections.map(s => {
    const id = anchorOf(s.h2, usedIds);
    tocItems.push(`<li><a href="#${id}">${esc(s.h2)}</a></li>`);
    let html = `<h2 id="${id}">${esc(s.h2)}</h2>`;
    if (s.paragraphs) html += s.paragraphs.map(t => `<p>${inline(t)}</p>`).join('');
    if (s.bullets) html += `<ul>${s.bullets.map(b => `<li>${inline(b)}</li>`).join('')}</ul>`;
    if (s.table) html += `<div class="table-wrap"><table class="data">
  <caption class="visually-hidden">${esc(s.table.caption)}</caption>
  <thead><tr>${s.table.headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${s.table.rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`;
    return html;
  }).join('');
  const faqHtml = g.faq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('');
  const srcHtml = g.sourcesOfficielles.map(s => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.label)}</a></li>`).join('');
  const related = PARCOURS.filter(p => g.parcours.includes(p.slug))
    .map(p => `<a class="pill" href="/${p.slug}/">${esc(p.nav)}</a>`).join(' ');
  const t = guideTheme(g);
  const aLireAussi = GUIDES.filter(x => x.slug !== g.slug && x.parcours.some(s => g.parcours.includes(s)))
    .slice(0, 3)
    .map(x => `<a class="pill" href="/guides/${x.slug}/">${esc(x.h1)}</a>`).join(' ');
  const outil = (g.slug === 'encadrement-des-loyers-paris' && ENCADREMENT) ? encadrementWidget() : '';
  if (outil) tocItems.unshift('<li><a href="#verifier">Vérifier votre loyer</a></li>');
  tocItems.push('<li><a href="#faq">Questions fréquentes</a></li>');
  /* Sommaire actif : sticky en desktop, replié en mobile par un micro-script
   * placé JUSTE APRÈS le nav (repli avant le paint du corps : pas de flash) ;
   * sans JS, il reste déplié : fallback sain. Le scroll-spy en fin de page
   * pose .on + aria-current="location" sur l'entrée visible. */
  const content = `
<div class="lecture-bar" aria-hidden="true"></div>
<nav class="breadcrumb"><a href="/">Accueil</a> › <a href="/guides/">Guides</a> › ${esc(g.h1)}</nav>
<article>
<header class="page-head" style="${themeStyle(t)}">
  <span class="page-head-icon">${icon(g.slug, t.c)}</span>
  <div>
    <p class="kicker">Guide pratique</p>
    <h1>${esc(g.h1)}</h1>
    <p class="lead">${esc(g.intro)}</p>
    <p class="maj">Mis à jour le ${DATE_FR}</p>
  </div>
</header>
<div class="guide-layout">
<nav class="guide-toc" aria-label="Sommaire du guide"><details class="toc-box" open><summary>Dans ce guide</summary><ol>${tocItems.join('')}</ol></details></nav>
<script>if(!matchMedia('(min-width:1020px)').matches){var tocD=document.querySelector('.guide-toc details');if(tocD)tocD.removeAttribute('open')}</script>
<div class="guide-body">
${outil}
${sections}
<section class="faq" id="faq"><h2>Questions fréquentes</h2>${faqHtml}</section>
<section class="notice"><h2>Sources officielles</h2><ul class="sources">${srcHtml}</ul></section>
${aLireAussi ? `<p class="pills"><strong>À lire aussi&nbsp;:</strong> ${aLireAussi}</p>` : ''}
<p class="pills"><strong>Parcours liés&nbsp;:</strong> ${related}</p>
</div>
</div>
</article>
<script>
(function(){
var toc=document.querySelector('.guide-toc');if(!toc)return;
var links={},ordre=[],vis={},cur=null;
toc.querySelectorAll('a[href^="#"]').forEach(function(a){var id=a.getAttribute('href').slice(1);links[id]=a;ordre.push(id)});
function on(id){var a=links[id];if(!a||a===cur)return;
 if(cur){cur.classList.remove('on');cur.removeAttribute('aria-current')}
 cur=a;a.classList.add('on');a.setAttribute('aria-current','location')}
/* Bande d'activation : tiers haut du viewport (un h2 posé en haut de page
 * par un clic sommaire reste dedans) ; on surligne toujours la PLUS HAUTE
 * section visible dans l'ordre du sommaire, jamais la dernière notifiée. */
var io=new IntersectionObserver(function(es){
 es.forEach(function(en){vis[en.target.id]=en.isIntersecting});
 for(var i=0;i<ordre.length;i++){if(vis[ordre[i]]){on(ordre[i]);return}}
},{rootMargin:'0px 0px -65% 0px'});
ordre.forEach(function(id){var el=document.getElementById(id);if(el)io.observe(el)});
toc.addEventListener('click',function(e){var a=e.target.closest('a[href^="#"]');if(a)on(a.getAttribute('href').slice(1))});
if(location.hash&&links[location.hash.slice(1)])on(location.hash.slice(1));
})();
</script>`;
  pushIndex(g.h1, `/guides/${g.slug}/`, g.metaDescription, 'Guide');
  addPage(`/guides/${g.slug}/`, layout({
    title: g.title,
    metaDescription: g.metaDescription,
    urlPath: `/guides/${g.slug}/`,
    content,
    breadcrumbs: [{ name: 'Guides', url: '/guides/' }, { name: g.h1, url: `/guides/${g.slug}/` }],
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: g.h1,
      description: g.metaDescription,
      datePublished: DATE_PUBLICATION,
      dateModified: DATE_ISO,
      inLanguage: 'fr-FR',
      mainEntityOfPage: `${SITE.baseUrl}/guides/${g.slug}/`,
      image: `${SITE.baseUrl}/og-image.png`,
      author: { '@type': 'Organization', name: SITE.name, url: SITE.baseUrl },
      publisher: { '@type': 'Organization', name: SITE.name, url: SITE.baseUrl, logo: { '@type': 'ImageObject', url: `${SITE.baseUrl}/og-image.png` } }
    }, {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: g.faq.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a }
      }))
    }]
  }), '0.8');
}

/* Hub des guides — cible du fil d'Ariane « Guides » et page de maillage. */
(function buildGuidesHub() {
  const cards = GUIDES.map(g => {
    const t = guideTheme(g);
    return `
  <a class="card card-guide" href="/guides/${g.slug}/" style="${themeStyle(t)}">
    <span class="card-icon card-icon-sm">${icon(g.slug, t.c)}</span>
    <div><h3>${esc(g.h1)}</h3>
    <p>${esc(g.metaDescription.split('. ')[0])}.</p></div>
  </a>`;
  }).join('');
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › Guides</nav>
<header class="page-head" style="${themeStyle(themeOf())}">
  <span class="page-head-icon">${icon('annuaire', PAL.bleu)}</span>
  <div>
    <h1>Les guides pratiques du logement en Île-de-France</h1>
    <p class="lead">${GUIDES.length} guides pour activer les bons dispositifs dans le bon ordre&nbsp;: garanties, aides, logement social, encadrement des loyers. Chacun renvoie vers les sources officielles qui font foi.</p>
  </div>
  ${illu('illu-guides', 'Illustration : un personnage consulte une carte à un carrefour de panneaux indiquant différents logements')}
</header>
<div class="grid grid-guides">${cards}</div>`;
  pushIndex('Les guides pratiques', '/guides/', `Les ${GUIDES.length} guides logement Île-de-France.`, 'Page');
  addPage('/guides/', layout({
    title: `Guides du logement en Île-de-France : aides et démarches`,
    metaDescription: `${GUIDES.length} guides pratiques pour se loger en Île-de-France : Visale, dossier, logement social, DALO, FJT, encadrement des loyers… avec les sources officielles.`,
    urlPath: '/guides/',
    content,
    breadcrumbs: [{ name: 'Guides', url: '/guides/' }],
  }), '0.7');
})();

/* Annuaire */
(function buildAnnuaire() {
  const cats = ANNUAIRE.categories.map(c => `
  <section id="${c.id}">
    <h2>${esc(c.titre)}</h2>
    <ul class="sources">${c.sources.map(s => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.nom)}</a> · ${esc(s.desc)}</li>`).join('')}</ul>
  </section>`).join('');
  const notres = [
    CROUS && { u: '/residences-crous/', t: `Résidences CROUS (${CROUS.records.length})`, d: 'Les résidences universitaires publiques d’Île-de-France : adresses, services, contact.' },
    FJT && { u: '/foyers-jeunes-travailleurs/', t: `Foyers de jeunes travailleurs (${FJT.records.length})`, d: 'Les FJT franciliens pour les 16-25 ans (jusqu’à 30 ans) : adresses et téléphones.' },
    RES_AUTONOMIE && { u: '/residences-autonomie/', t: `Résidences autonomie (${RES_AUTONOMIE.records.length})`, d: 'Les résidences pour seniors autonomes, aux loyers modérés.' },
    LS_COMMUNES && { u: '/logement-social/chiffres/', t: 'Le logement social en chiffres', d: 'Parc, loyers moyens, vacance et taux SRU, commune par commune.' },
  ].filter(Boolean);
  const notresBlock = notres.length ? `
  <section class="notice">
    <h2>Nos annuaires, construits sur les données publiques</h2>
    <ul class="sources">${notres.map(n => `<li><a href="${n.u}">${esc(n.t)}</a> · ${esc(n.d)}</li>`).join('')}</ul>
  </section>` : '';
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › Annuaire</nav>
<header class="page-head" style="${themeStyle(themeOf())}">
  <span class="page-head-icon">${icon('annuaire', PAL.bleu2)}</span>
  <div>
    <p class="kicker">Annuaire</p>
    <h1>${esc(ANNUAIRE.h1)}</h1>
    <p class="lead">${esc(ANNUAIRE.intro)}</p>
  </div>
</header>
${notresBlock}
${cats}`;
  pushIndex(ANNUAIRE.h1, '/annuaire/', ANNUAIRE.metaDescription, 'Annuaire');
  addPage('/annuaire/', layout({
    title: ANNUAIRE.title,
    metaDescription: ANNUAIRE.metaDescription,
    urlPath: '/annuaire/',
    content,
    breadcrumbs: [{ name: 'Annuaire', url: '/annuaire/' }]
  }), '0.9');
})();

/* ------------------ Pages données (Phase 2 open data) ------------------ */

/* « à Paris », « dans les Yvelines »… pour des H1 naturels. */
const DEP_PREP = {
  75: 'à Paris', 77: 'en Seine-et-Marne', 78: 'dans les Yvelines', 91: 'en Essonne',
  92: 'dans les Hauts-de-Seine', 93: 'en Seine-Saint-Denis', 94: 'dans le Val-de-Marne', 95: "dans le Val-d'Oise",
};

/** Bandeau source/licence commun aux pages construites sur l'open data. */
function sourceNotice(meta) {
  return `<p class="maj">${esc(meta.attribution)} · données extraites le ${esc(dateFrOf(meta.collectedAt))}. Les informations évoluent&nbsp;: vérifiez toujours auprès de l'établissement ou de la source officielle.</p>`;
}

/* JSON-LD schema.org/Dataset pour les hubs construits sur l'open data (GEO :
 * les moteurs IA et Google Dataset Search lisent licence, source et date). */
const LICENSE_URLS = {
  'Licence Ouverte / Open Licence v2.0 (Etalab)': 'https://www.etalab.gouv.fr/licence-ouverte-open-licence',
  'Licence Ouverte / Open Licence (Etalab)': 'https://www.etalab.gouv.fr/licence-ouverte-open-licence',
  'Open Database License (ODbL)': 'https://opendatacommons.org/licenses/odbl/1-0/',
};
function datasetLd(meta, { name, description, urlPath }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name,
    description,
    url: SITE.baseUrl + urlPath,
    license: LICENSE_URLS[meta.license] || meta.license,
    creator: { '@type': 'Organization', name: SITE.name, url: SITE.baseUrl },
    isBasedOn: String(meta.sourceUrl).split(' | '),
    dateModified: String(meta.collectedAt).slice(0, 10),
    spatialCoverage: 'Île-de-France, France',
    inLanguage: 'fr-FR',
  };
}

/* Compteur animable : la valeur finale reste DANS le HTML (SEO, lecteurs
 * d'écran, no-JS) ; le JS de layout ne la rejoue que visuellement.
 * Sous 10, un count-up serait ridicule : nombre nu. */
const compteur = (n) => n >= 10
  ? `<span class="compte" data-compte="${n}">${fmt(n)}</span>`
  : fmt(n);

/**
 * Annuaire générique : une page hub + une page par département.
 * cfg : { data, baseSlug, iconName, themeSlug, nom, nomPluriel, title,
 *        metaDescription, h1, intro, comment (HTML), guides (slugs),
 *        renderItem (record → HTML <li>), searchCat }
 */
function buildDirectory(cfg) {
  const { data, baseSlug } = cfg;
  /* Année des données (pas de l'exécution du build) : suit les snapshots open data. */
  const anneeData = String(data._meta.collectedAt || DATE_PUBLICATION).slice(0, 4);
  const t = themeOf(cfg.themeSlug);
  const byDep = new Map(DEPS_IDF.map(d => [d, data.records.filter(r => r.dep === d)]));
  const guidePills = (cfg.guides || []).map(slug => {
    const g = GUIDES.find(x => x.slug === slug);
    return g ? `<a class="pill" href="/guides/${g.slug}/">${esc(g.h1)}</a>` : '';
  }).filter(Boolean).join(' ');

  /* Hub */
  const depCards = DEPS_IDF.filter(d => byDep.get(d).length).map(d => `
  <a class="card card-parcours" href="/${baseSlug}/${DEP_SLUGS[d]}/" style="${themeStyle(t)}">
    <h3>${esc(DEP_NOMS[d])} (${d})</h3>
    <p>${compteur(byDep.get(d).length)} ${byDep.get(d).length > 1 ? cfg.nomPluriel : cfg.nom}</p>
    <span class="card-cta"><span class="cta-label">Voir la liste</span> <span class="cta-arrow" aria-hidden="true">→</span></span>
  </a>`).join('');
  const hubContent = `
<nav class="breadcrumb"><a href="/">Accueil</a> › ${esc(cfg.h1)}</nav>
<header class="page-head" style="${themeStyle(t)}">
  <span class="page-head-icon">${icon(cfg.iconName, t.c)}</span>
  <div>
    <p class="kicker">Annuaire · données publiques</p>
    <h1>${esc(cfg.h1)}</h1>
    <p class="lead">${esc(cfg.intro)}</p>
  </div>
  ${cfg.illu || ''}
</header>
<section>
  <h2>Choisissez votre département</h2>
  <div class="grid">${depCards}</div>
</section>
<section class="notice">
  ${cfg.comment}
  ${guidePills ? `<p class="pills"><strong>Guides utiles&nbsp;:</strong> ${guidePills}</p>` : ''}
  ${sourceNotice(data._meta)}
</section>`;
  pushIndex(cfg.h1, `/${baseSlug}/`, cfg.metaDescription, 'Annuaire');
  addPage(`/${baseSlug}/`, layout({
    title: cfg.title,
    metaDescription: cfg.metaDescription,
    urlPath: `/${baseSlug}/`,
    content: hubContent,
    breadcrumbs: [{ name: cfg.h1, url: `/${baseSlug}/` }],
    jsonLd: [datasetLd(data._meta, { name: cfg.h1, description: cfg.metaDescription, urlPath: `/${baseSlug}/` })],
  }), '0.8');

  /* Pages département */
  for (const d of DEPS_IDF) {
    const items = byDep.get(d);
    if (!items.length) continue;
    const urlPath = `/${baseSlug}/${DEP_SLUGS[d]}/`;
    const h1 = `${cfg.nomPlurielCap} ${DEP_PREP[d]} (${d})`;
    const others = DEPS_IDF.filter(x => x !== d && byDep.get(x).length)
      .map(x => `<a class="pill" href="/${baseSlug}/${DEP_SLUGS[x]}/">${esc(DEP_NOMS[x])} (${x})</a>`).join(' ');
    const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › <a href="/${baseSlug}/">${esc(cfg.h1)}</a> › ${esc(DEP_NOMS[d])}</nav>
<header class="page-head" style="${themeStyle(t)}">
  <span class="page-head-icon">${icon(cfg.iconName, t.c)}</span>
  <div>
    <p class="kicker">Annuaire · données publiques</p>
    <h1>${esc(h1)}</h1>
    <p class="lead">${compteur(items.length)} ${items.length > 1 ? cfg.nomPluriel : cfg.nom} ${DEP_PREP[d]}, d'après ${esc(data._meta.source.split('(')[0].trim())}.</p>
  </div>
</header>
<ul class="dir-list" style="${themeStyle(t)}">
${items.map(cfg.renderItem).join('\n')}
</ul>
<section class="notice">
  ${cfg.comment}
  ${guidePills ? `<p class="pills"><strong>Guides utiles&nbsp;:</strong> ${guidePills}</p>` : ''}
  ${sourceNotice(data._meta)}
</section>
<p class="pills"><strong>Autres départements&nbsp;:</strong> ${others}</p>`;
    for (const r of items) {
      pushIndex(r.nom, `${urlPath}#r-${r.finess || r.id}`, [r.adresse, r.cp, r.commune].filter(Boolean).join(', '), cfg.searchCat);
    }
    addPage(urlPath, layout({
      title: `${cfg.titleShort} ${DEP_PREP[d]} (${d}) : ${items.length} adresses`,
      metaDescription: `${items.length} ${cfg.nomPluriel} ${DEP_PREP[d]} : l'annuaire ${anneeData} avec adresses, contacts et démarches de candidature. ${cfg.metaSuffix}`,
      urlPath,
      content,
      breadcrumbs: [{ name: cfg.h1, url: `/${baseSlug}/` }, { name: DEP_NOMS[d], url: urlPath }],
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: h1,
        numberOfItems: items.length,
        /* Google exige un `item` complet dans chaque ListItem (erreur GSC
         * « Champ item manquant » sinon). Residence = sous-type de Place. */
        itemListElement: items.map((r, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'Residence',
            name: r.nom,
            url: `${SITE.baseUrl}${urlPath}#r-${r.finess || r.id}`,
            ...(r.adresse || r.cp || r.commune ? {
              address: {
                '@type': 'PostalAddress',
                ...(r.adresse ? { streetAddress: r.adresse } : {}),
                ...(r.cp ? { postalCode: r.cp } : {}),
                ...(r.commune ? { addressLocality: r.commune } : {}),
                addressCountry: 'FR',
              },
            } : {}),
            ...(r.tel ? { telephone: r.tel } : {}),
          },
        })),
      }],
    }), '0.6');
  }
}

const osmLink = (r) => (r.lat != null ? ` · <a href="https://www.openstreetmap.org/?mlat=${r.lat}&amp;mlon=${r.lon}#map=17/${r.lat}/${r.lon}" rel="noopener" target="_blank">voir sur la carte</a>` : '');

if (CROUS) {
  buildDirectory({
    data: CROUS,
    baseSlug: 'residences-crous',
    iconName: 'etudiant',
    themeSlug: 'etudiant',
    nom: 'résidence CROUS',
    nomPluriel: 'résidences CROUS',
    nomPlurielCap: 'Résidences CROUS',
    titleShort: 'Résidences CROUS',
    illu: illu('illu-residences-crous', 'Illustration : une résidence universitaire animée, étudiants et vélos'),
    title: `Résidences CROUS en Île-de-France : la liste des ${CROUS.records.length}`,
    metaDescription: `La liste des ${CROUS.records.length} résidences universitaires CROUS d'Île-de-France : adresses, services, contact et demande de logement, département par département.`,
    metaSuffix: 'Données officielles CNOUS.',
    h1: "Les résidences CROUS d'Île-de-France",
    intro: `${CROUS.records.length} résidences universitaires publiques, aux loyers les plus bas du marché francilien. Voici la liste officielle complète, avec adresses, services et liens de candidature.`,
    comment: `<h2>Comment obtenir une chambre CROUS&nbsp;?</h2>
  <p>On ne candidate pas auprès d'une résidence&nbsp;: tout passe par le <strong>Dossier social étudiant (DSE)</strong>, à constituer entre mars et mai sur messervices.etudiant.gouv.fr, puis par les vœux sur <a href="https://trouverunlogement.lescrous.fr" rel="noopener" target="_blank">trouverunlogement.lescrous.fr</a>. Une phase complémentaire ouvre en juillet pour les logements restés vacants, accessible aussi aux non-boursiers.</p>`,
    guides: ['aide-logement-etudiant', 'visale', 'dossierfacile'],
    searchCat: 'Résidence CROUS',
    renderItem: (r) => `<li class="dir-item" id="r-${r.id}">
  <h3>${esc(r.nom)}</h3>
  <p class="dir-addr">${esc(r.adresse)}${osmLink(r)}</p>
  ${(r.tel || r.mail) ? `<p class="dir-meta">${[r.tel && esc(r.tel), r.mail && `<a href="mailto:${esc(r.mail)}">${esc(r.mail)}</a>`].filter(Boolean).join(' · ')}</p>` : ''}
  ${r.services.length ? `<p class="dir-tags">${r.services.map(s => `<span>${esc(s)}</span>`).join('')}</p>` : ''}
  <p class="dir-links"><a href="${esc(safeUrl(r.bookingUrl || 'https://trouverunlogement.lescrous.fr'))}" rel="noopener" target="_blank">Demander un logement</a>${r.url ? ` · <a href="${esc(safeUrl(r.url))}" rel="noopener" target="_blank">site du CROUS</a>` : ''}</p>
</li>`,
  });
}

if (FJT) {
  buildDirectory({
    data: FJT,
    baseSlug: 'foyers-jeunes-travailleurs',
    iconName: 'foyer-jeune-travailleur',
    themeSlug: 'etudiant',
    nom: 'foyer de jeunes travailleurs',
    nomPluriel: 'foyers de jeunes travailleurs',
    nomPlurielCap: 'Foyers de jeunes travailleurs (FJT)',
    titleShort: 'FJT',
    illu: illu('illu-fjt', 'Illustration : trois jeunes actifs devant un foyer de jeunes travailleurs'),
    title: `FJT en Île-de-France : l'annuaire des ${FJT.records.length} foyers`,
    metaDescription: `${FJT.records.length} foyers de jeunes travailleurs (FJT) en Île-de-France : adresses et téléphones, département par département. Logement meublé tout compris pour les 16-25 ans.`,
    metaSuffix: 'Répertoire officiel FINESS.',
    h1: 'Les foyers de jeunes travailleurs (FJT) en Île-de-France',
    intro: `${FJT.records.length} FJT accueillent en Île-de-France les jeunes de 16 à 25 ans (parfois jusqu'à 30 ans) en activité, alternance ou insertion : logement meublé tout compris, redevance modérée, APL possible. Contrairement au CROUS, on candidate directement auprès de chaque foyer.`,
    comment: `<h2>Comment entrer en FJT&nbsp;?</h2>
  <p>Chaque foyer gère ses admissions&nbsp;: contactez directement ceux qui vous intéressent (téléphone ci-dessus), ou passez par les gestionnaires majeurs (ALJT, CLLAJ locaux, habitat jeunes). Les délais varient de quelques jours à quelques mois selon les secteurs. Notre guide détaille conditions, redevances et pièges&nbsp;à éviter.</p>`,
    guides: ['foyer-jeune-travailleur', 'aide-mobili-jeune', 'visale'],
    searchCat: 'FJT',
    renderItem: (r) => `<li class="dir-item" id="r-${r.finess}">
  <h3>${esc(r.nom)}</h3>
  <p class="dir-addr">${esc([r.adresse, [r.cp, r.commune].filter(Boolean).join(' ')].filter(Boolean).join(', '))}${osmLink(r)}</p>
  ${r.tel ? `<p class="dir-meta">${esc(r.tel)}</p>` : ''}
</li>`,
  });
}

if (RES_AUTONOMIE) {
  buildDirectory({
    data: RES_AUTONOMIE,
    baseSlug: 'residences-autonomie',
    iconName: 'logement-social',
    themeSlug: 'logement-social',
    nom: 'résidence autonomie',
    nomPluriel: 'résidences autonomie',
    nomPlurielCap: 'Résidences autonomie',
    titleShort: 'Résidences autonomie',
    illu: illu('illu-residences-autonomie', "Illustration : deux seniors sur un banc dans le jardin d'une résidence autonomie"),
    title: `Résidences autonomie en Île-de-France : l'annuaire (${RES_AUTONOMIE.records.length})`,
    metaDescription: `${RES_AUTONOMIE.records.length} résidences autonomie (ex foyers-logements) pour seniors en Île-de-France : adresses et téléphones par département. Loyers modérés, logement indépendant.`,
    metaSuffix: 'Répertoire officiel FINESS.',
    h1: "Les résidences autonomie d'Île-de-France (seniors)",
    intro: `Les résidences autonomie (anciens foyers-logements) proposent aux seniors autonomes un logement indépendant à loyer modéré, avec services collectifs. L'Île-de-France en compte ${RES_AUTONOMIE.records.length} : voici l'annuaire complet, département par département.`,
    comment: `<h2>Comment obtenir une place&nbsp;?</h2>
  <p>La demande se fait directement auprès de la résidence ou du CCAS de la commune (beaucoup sont gérées par les CCAS). Les loyers sont modérés et ouvrent droit aux aides au logement. Le portail public <a href="https://www.pour-les-personnes-agees.gouv.fr" rel="noopener" target="_blank">pour-les-personnes-agees.gouv.fr</a> propose un comparateur de prix officiel.</p>`,
    guides: ['demande-logement-social', 'fonds-solidarite-logement'],
    searchCat: 'Résidence autonomie',
    renderItem: (r) => `<li class="dir-item" id="r-${r.finess}">
  <h3>${esc(r.nom)}</h3>
  <p class="dir-addr">${esc([r.adresse, [r.cp, r.commune].filter(Boolean).join(' ')].filter(Boolean).join(', '))}${osmLink(r)}</p>
  ${r.tel ? `<p class="dir-meta">${esc(r.tel)}</p>` : ''}
</li>`,
  });
}

/* ---- Le logement social en chiffres : hub + 1 page par département ---- */
if (LS_COMMUNES) {
  const recs = LS_COMMUNES.records;
  const communesOf = (d) => recs.filter(r => r.dep === d && (d === '75' ? r.arrondissement || r.code === '75056' : !r.arrondissement));
  const parcOf = (rows) => rows.filter(r => !r.arrondissement).reduce((s, r) => s + (r.nbLogementsSociaux || 0), 0);
  const parcIdf = parcOf(recs);
  const nbCommunes = recs.filter(r => !r.arrondissement).length;
  const t = themeOf('logement-social');

  const statut = (r) => (r.carencee ? '<span class="badge badge-car" title="Commune carencée au titre de la loi SRU : objectifs non tenus, sanctions renforcées">carencée</span>'
    : r.deficitaire ? '<span class="badge badge-def" title="Commune en dessous de son objectif légal de logements sociaux (loi SRU)">déficitaire</span>' : '');
  const rowOf = (r) => `<tr id="c-${r.code}" data-n="${esc(r.nom.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))}">
    <td${r.note ? ` title="${esc(r.note)}"` : ''}>${esc(r.nom)}${r.note ? '&nbsp;*' : ''}</td>
    <td class="num">${fmt(r.nbLogementsSociaux)}</td>
    <td class="num">${fmt(r.loyerMedian, 2)}</td>
    <td class="num bar"${r.txVacance != null ? ` style="--pct:${Math.min(r.txVacance * 10, 100).toFixed(0)}%"` : ''}>${fmt(r.txVacance, 1)}</td>
    <td class="num bar"${r.tauxSRU != null ? ` style="--pct:${Math.min(r.tauxSRU, 100).toFixed(0)}%"` : ''}>${r.tauxSRU == null ? '—' : fmt(r.tauxSRU, 1) + ' %'}</td>
    <td>${esc(r.zone || '—')}</td>
    <td>${statut(r)}</td>
  </tr>`;
  const tableHead = `<thead><tr><th scope="col">Commune</th><th scope="col" class="num">Parc social (RPLS)</th><th scope="col" class="num">Loyer médian €/m²</th><th scope="col" class="num">Vacance %</th><th scope="col" class="num">Taux SRU</th><th scope="col">Zone</th><th scope="col">Statut SRU</th></tr></thead>`;
  const legende = `
<section class="notice">
  <h2>Comment lire ces chiffres</h2>
  <ul>
    <li><strong>Parc social (RPLS)</strong>&nbsp;: logements locatifs des bailleurs sociaux au 1ᵉʳ janvier 2024 (répertoire RPLS, Insee–SDES). Les communes sans découpage IRIS ne sont pas couvertes par ce fichier («&nbsp;—&nbsp;»).</li>
    <li><strong>Loyer médian</strong>&nbsp;: en €/m² de surface habitable, charges non comprises — à comparer aux 25-35&nbsp;€/m² du parc privé parisien.</li>
    <li><strong>Vacance</strong>&nbsp;: part des logements vacants — sous 3&nbsp;%, le parc est saturé.</li>
    <li><strong>Taux SRU</strong>&nbsp;: part de logements sociaux au sens de la loi SRU (inventaire au 1ᵉʳ janvier 2024, assiette plus large que le RPLS&nbsp;: ne pas additionner les deux). Une commune «&nbsp;déficitaire&nbsp;» est en dessous de son objectif légal&nbsp;; «&nbsp;carencée&nbsp;», elle est sanctionnée — des arguments utiles pour votre dossier.</li>
    <li><strong>Zone</strong>&nbsp;: zonage ABC (Abis = Paris…)&nbsp;: il fixe les plafonds de loyers et de ressources de nombreux dispositifs.</li>
  </ul>
  <p class="maj">${esc(LS_COMMUNES._meta.attribution)} · données extraites le ${esc(dateFrOf(LS_COMMUNES._meta.collectedAt))}.</p>
</section>`;

  /* Hub régional */
  const depRows = DEPS_IDF.map(d => {
    const rows = communesOf(d);
    const parc = d === '75' ? (recs.find(r => r.code === '75056') || {}).nbLogementsSociaux : parcOf(rows);
    const deficitaires = rows.filter(r => r.deficitaire).length;
    return `<tr>
      <td><a href="/logement-social/chiffres/${DEP_SLUGS[d]}/">${esc(DEP_NOMS[d])} (${d})</a></td>
      <td class="num">${fmt(parc)}</td>
      <td class="num">${d === '75' ? 1 : rows.length}</td>
      <td class="num">${fmt(deficitaires)}</td>
    </tr>`;
  }).join('');
  const hubContent = `
<nav class="breadcrumb"><a href="/">Accueil</a> › <a href="/logement-social/">Logement social</a> › Chiffres</nav>
<header class="page-head" style="${themeStyle(t)}">
  <span class="page-head-icon">${icon('demande-logement-social', t.c)}</span>
  <div>
    <p class="kicker">Données officielles</p>
    <h1>Le logement social en Île-de-France, en chiffres</h1>
    <p class="lead">Plus de ${compteur(Math.floor(parcIdf / 100000) * 100000)} logements locatifs sociaux sont recensés en Île-de-France (RPLS, 1ᵉʳ janvier 2024). Parc, loyers au m², vacance et taux SRU&nbsp;: les chiffres officiels, commune par commune, pour savoir où votre demande a le plus de chances d'aboutir.</p>
  </div>
  ${illu('illu-chiffres', 'Illustration : des immeubles et des barres de graphique, le logement social en chiffres')}
</header>
<div class="table-wrap"><table class="data">
  <caption class="visually-hidden">Logement social par département en Île-de-France (RPLS au 1ᵉʳ janvier 2024)</caption>
  <thead><tr><th scope="col">Département</th><th scope="col" class="num">Parc social (RPLS)</th><th scope="col" class="num">Communes couvertes</th><th scope="col" class="num">Communes déficitaires (SRU)</th></tr></thead>
  <tbody>${depRows}</tbody>
</table></div>
<p>Choisissez un département pour le détail commune par commune, ou utilisez la <a href="/recherche/">recherche</a> pour aller directement à votre commune.</p>
${legende}
<p class="pills"><strong>Guides utiles&nbsp;:</strong> <a class="pill" href="/guides/demande-logement-social/">Demande de logement social</a> <a class="pill" href="/guides/recours-dalo/">Recours DALO</a> <a class="pill" href="/guides/logement-intermediaire/">Logement intermédiaire</a></p>`;
  pushIndex('Le logement social en Île-de-France, en chiffres', '/logement-social/chiffres/', 'Parc, loyers, vacance et taux SRU commune par commune.', 'Chiffres');
  addPage('/logement-social/chiffres/', layout({
    title: 'Logement social en Île-de-France : les chiffres par commune',
    metaDescription: `Combien de logements sociaux par commune ? Loyers au m², vacance, taux SRU : les chiffres officiels au 1ᵉʳ janvier 2024 pour ${fmt(nbCommunes)} communes d'Île-de-France.`,
    urlPath: '/logement-social/chiffres/',
    content: hubContent,
    breadcrumbs: [{ name: 'Logement social & situations spécifiques', url: '/logement-social/' }, { name: 'Les chiffres', url: '/logement-social/chiffres/' }],
    jsonLd: [datasetLd(LS_COMMUNES._meta, {
      name: 'Le logement social par commune en Île-de-France (RPLS, SRU, zonage ABC)',
      description: 'Parc locatif social, loyers au m², vacance, taux SRU et zonage ABC pour les communes d\'Île-de-France, consolidés depuis les données publiques.',
      urlPath: '/logement-social/chiffres/',
    })],
  }), '0.8');

  /* Pages département */
  const filterScript = `<script>(function(){var i=document.getElementById('filtre');if(!i)return;var rs=[].slice.call(document.querySelectorAll('tbody tr'));function n(s){return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'')}i.addEventListener('input',function(){var q=n(i.value.trim());rs.forEach(function(r){r.style.display=!q||r.getAttribute('data-n').indexOf(q)>=0?'':'none'})})})();</script>`;
  for (const d of DEPS_IDF) {
    const rows = communesOf(d);
    if (!rows.length) continue;
    const urlPath = `/logement-social/chiffres/${DEP_SLUGS[d]}/`;
    const h1 = `Le logement social ${DEP_PREP[d]} (${d})&nbsp;: les chiffres`;
    const sumArr = recs.filter(r => r.arrondissement).reduce((s, r) => s + (r.nbLogementsSociaux || 0), 0);
    const parisNote = d === '75' ? `<p>Paris compte <strong>${fmt((recs.find(r => r.code === '75056') || {}).nbLogementsSociaux)}</strong> logements sociaux RPLS (${fmt((recs.find(r => r.code === '75056') || {}).tauxSRU, 1)}&nbsp;% au sens SRU). Le détail ci-dessous est par arrondissement&nbsp;; les taux SRU ne sont publiés qu'à l'échelle de la commune entière. La somme des 20 arrondissements (${fmt(sumArr)}) diffère légèrement du total communal&nbsp;: traitements statistiques de l'Insee entre niveaux d'agrégation.</p>` : '';
    const sorted = d === '75' ? rows.filter(r => r.arrondissement) : rows.slice().sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const others = DEPS_IDF.filter(x => x !== d)
      .map(x => `<a class="pill" href="/logement-social/chiffres/${DEP_SLUGS[x]}/">${esc(DEP_NOMS[x])} (${x})</a>`).join(' ');
    const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › <a href="/logement-social/chiffres/">Logement social en chiffres</a> › ${esc(DEP_NOMS[d])}</nav>
<header class="page-head" style="${themeStyle(t)}">
  <span class="page-head-icon">${icon('demande-logement-social', t.c)}</span>
  <div>
    <p class="kicker">Données officielles</p>
    <h1>${h1}</h1>
    <p class="lead">Parc social, loyers au m², vacance et statut SRU ${d === '75' ? 'des 20 arrondissements parisiens' : `des ${sorted.length} communes du département couvertes par les données publiques`}. Repérez les communes où le parc est important et la rotation réelle.</p>
  </div>
</header>
${parisNote}
<p><label for="filtre"><strong>Filtrer&nbsp;:</strong></label> <input id="filtre" type="search" placeholder="Nom de ${d === '75' ? "l'arrondissement" : 'la commune'}…" class="search-input search-inline"></p>
<div class="table-wrap"><table class="data">
  <caption class="visually-hidden">Logement social par ${d === '75' ? 'arrondissement' : 'commune'} — ${esc(DEP_NOMS[d])} (${d})</caption>
  ${tableHead}
  <tbody>${sorted.map(rowOf).join('')}</tbody>
</table></div>
${sorted.filter(r => r.note).map(r => `<p class="maj">* ${esc(r.nom)}&nbsp;: ${esc(r.note)}</p>`).join('')}
${filterScript}
${legende}
<p class="pills"><strong>Autres départements&nbsp;:</strong> ${others}</p>`;
    for (const r of sorted) {
      pushIndex(r.nom + (r.arrondissement ? '' : ` (${r.dep})`), `${urlPath}#c-${r.code}`,
        `Logement social : ${r.nbLogementsSociaux != null ? fmt(r.nbLogementsSociaux) + ' logements' : 'chiffres'}${r.loyerMedian != null ? `, loyer médian ${fmt(r.loyerMedian, 2)} €/m²` : ''}${r.tauxSRU != null ? `, taux SRU ${fmt(r.tauxSRU, 1)} %` : ''}.`, 'Commune');
    }
    addPage(urlPath, layout({
      title: `Logement social ${DEP_PREP[d]} (${d}) : parc et loyers`,
      metaDescription: `Le logement social ${DEP_PREP[d]} : parc, loyer médian au m², vacance et taux SRU ${d === '75' ? 'par arrondissement' : 'commune par commune'}. Données officielles au 1ᵉʳ janvier 2024.`,
      urlPath,
      content,
      breadcrumbs: [{ name: 'Logement social en chiffres', url: '/logement-social/chiffres/' }, { name: DEP_NOMS[d], url: urlPath }],
    }), '0.6');
  }
}

/* --------- Outil : vérificateur d'encadrement des loyers (Paris) -------- */

function encadrementWidget() {
  const m = ENCADREMENT._meta;
  const quartiers = [...new Map(ENCADREMENT.records.map(r => [r.quartierId, r.quartier])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'fr'));
  const optQ = quartiers.map(([id, nom]) => `<option value="${id}">${esc(nom)}</option>`).join('');
  const optE = EPOQUES.map((e, i) => `<option value="${i}">${esc(e.replace('Apres', 'Après'))}</option>`).join('');
  return `
<section class="tool" id="verifier">
  <h2>Vérifiez votre loyer&nbsp;: les références ${esc(m.millesime)}, quartier par quartier</h2>
  <p>Les loyers de référence officiels (arrêté préfectoral, références ${esc(m.millesime)}) pour chacun des 80 quartiers de Paris. Sélectionnez les caractéristiques du logement&nbsp;:</p>
  <div class="tool-form">
    <div><label for="enc-q">Quartier</label><select id="enc-q"><option value="">— Choisir —</option>${optQ}</select></div>
    <div><label for="enc-p">Pièces</label><select id="enc-p"><option value="">—</option><option value="1">1 pièce</option><option value="2">2 pièces</option><option value="3">3 pièces</option><option value="4">4 pièces et plus</option></select></div>
    <div><label for="enc-e">Construction</label><select id="enc-e"><option value="">—</option>${optE}</select></div>
    <div><label for="enc-m">Location</label><select id="enc-m"><option value="">—</option><option value="0">Non meublée</option><option value="1">Meublée</option></select></div>
    <div><label for="enc-s">Surface (m², optionnel)</label><input id="enc-s" type="number" min="6" max="400" step="0.5" placeholder="ex. 32"></div>
    <div><label for="enc-l">Loyer mensuel hors charges (€, optionnel)</label><input id="enc-l" type="number" min="1" step="1" placeholder="ex. 1200"></div>
  </div>
  <!-- Région live sur un parent JAMAIS masqué : un élément hidden sort de
       l'arbre d'accessibilité et ses annonces se perdent. -->
  <div aria-live="polite" aria-atomic="true"><div class="tool-result" id="enc-result" hidden></div></div>
  <noscript><p>Cet outil a besoin de JavaScript. Sans lui, consultez la grille officielle sur <a href="https://www.paris.fr/pages/l-encadrement-des-loyers-parisiens-en-vigueur-le-1er-aout-2712" rel="noopener" target="_blank">paris.fr</a>.</p></noscript>
  <p class="maj">${esc(m.attribution)} · références ${esc(m.millesime)}, extraites le ${esc(dateFrOf(m.collectedAt))}. Le quartier administratif peut différer du «&nbsp;quartier d'usage&nbsp;»&nbsp;: vérifiez sur la carte officielle en cas de doute.</p>
  <script>
(function(){
var G=null,Gq=false;
function $(i){return document.getElementById(i)}
function num(v){var n=parseFloat(String(v).replace(',','.'));return isFinite(n)&&n>0?n:null}
function fr(n,d){return n.toLocaleString('fr-FR',{minimumFractionDigits:d,maximumFractionDigits:d})}
function upd(){
 var q=$('enc-q').value,p=$('enc-p').value,e=$('enc-e').value,mb=$('enc-m').value,res=$('enc-result');
 if(q===''||p===''||e===''||mb===''){res.hidden=true;return}
 if(!G){
  /* Skeleton seulement après 180 ms de latence réelle (sur cache disque, un
   * skeleton qui flashe 50 ms est pire que rien), et seulement si les champs
   * sont toujours complets quand le timer tombe. Le span masqué rend le
   * chargement audible aux lecteurs d'écran (région live parente, pas
   * d'aria-busy : il étoufferait justement cette annonce). */
  if(!Gq){Gq=true;
   var sk=setTimeout(function(){
    if($('enc-q').value===''||$('enc-p').value===''||$('enc-e').value===''||$('enc-m').value==='')return;
    res.hidden=false;
    res.innerHTML='<span class="visually-hidden">Chargement des références…</span><div class="sk"></div><div class="sk sk-2"></div>'},180);
   fetch('/data/encadrement-loyers-paris.json').then(function(r){return r.json()}).then(function(j){
    clearTimeout(sk);G=j;upd()})
   .catch(function(){Gq=false;clearTimeout(sk);
    res.hidden=false;res.innerHTML='Impossible de charger les références. Réessayez ou consultez paris.fr.'})}
  return}
 var v=G.grille[q+'|'+p+'|'+e+'|'+mb];
 if(!v){res.hidden=false;res.innerHTML='Référence introuvable pour cette combinaison.';return}
 var s=num($('enc-s').value),l=num($('enc-l').value);
 var verd=null,pm2=null;
 if(s&&l){pm2=l/s;verd=pm2<=v[1]?'ok':'ko'}
 var stamp=verd&&verd!==lastV?' stamp':'';
 var h='<p><strong>Plafond légal (référence majorée)&nbsp;: '+fr(v[1],2)+' €/m²</strong><br>Loyer de référence&nbsp;: '+fr(v[0],2)+' €/m² · référence minorée&nbsp;: '+fr(v[2],2)+' €/m²</p>';
 if(s){h+='<p>Pour '+fr(s,1)+' m²&nbsp;: plafond de <strong>'+fr(v[1]*s,0)+' € hors charges par mois</strong> (hors complément de loyer).</p>'}
 if(verd==='ok'){h+='<p class="enc-ok'+stamp+'">✓ Votre loyer ('+fr(pm2,2)+' €/m²) respecte le plafond.</p>'}
 if(verd==='ko'){h+='<p class="enc-ko'+stamp+'">✗ Votre loyer ('+fr(pm2,2)+' €/m²) dépasse le plafond d\\'environ '+fr(l-v[1]*s,0)+' € par mois. Sans complément de loyer justifié au bail, ce dépassement est contestable (voir les recours ci-dessous).</p>'}
 lastV=verd;
 res.hidden=false;res.innerHTML=h;
}
var lastV=null;
['enc-q','enc-p','enc-e','enc-m'].forEach(function(i){$(i).addEventListener('input',upd)});
var deb;['enc-s','enc-l'].forEach(function(i){$(i).addEventListener('input',function(){clearTimeout(deb);deb=setTimeout(upd,150)})});
})();
  </script>
</section>`;
}

/* ----------------------- Recherche client-side ----------------------- */

(function buildRecherche() {
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › Recherche</nav>
<header class="page-head" style="${themeStyle(themeOf())}">
  <span class="page-head-icon">${icon('annuaire', PAL.bleu2)}</span>
  <div>
    <h1>Rechercher sur ${esc(SITE.name)}</h1>
    <p class="lead">Une commune, une résidence, un foyer, un dispositif ou une aide&nbsp;: tout le contenu du site est cherchable ici, y compris les ${compteur(SEARCH_INDEX.filter(e => DATA_SEARCH_CATS.includes(e.c)).length)} entrées de nos annuaires de données publiques.</p>
  </div>
</header>
<p><input id="q" type="search" class="search-input" aria-label="Rechercher sur le site" placeholder="Ex. : Massy, résidence CROUS, FJT, Visale, encadrement…" autocomplete="off"></p>
<p class="pills"><small>Essayez&nbsp;:</small> <button type="button" class="pill ex" data-q="Massy">Massy</button> <button type="button" class="pill ex" data-q="garant Visale">garant Visale</button> <button type="button" class="pill ex" data-q="résidence CROUS">résidence CROUS</button> <button type="button" class="pill ex" data-q="encadrement des loyers">encadrement des loyers</button></p>
<p class="result-count" id="count" aria-live="polite"></p>
<ul class="result-list" id="results"></ul>
<noscript><p>La recherche a besoin de JavaScript. Sans lui, parcourez les <a href="/annuaire/">annuaires</a> ou les <a href="/">parcours</a>.</p></noscript>
<script>
(function(){
var IDX=null,inp=document.getElementById('q'),out=document.getElementById('results'),cnt=document.getElementById('count');
function norm(s){return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'')}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function run(){
 var q=norm(inp.value.trim());
 if(q.length<2){out.innerHTML='';cnt.textContent='';return}
 if(!IDX){cnt.textContent='Chargement de l\\'index…';
  fetch('/search-index.json').then(function(r){return r.json()}).then(function(j){
   IDX=j.map(function(e){e.nt=norm(e.t);e.nd=norm(e.d||'');e.nc=norm(e.c||'');return e});run()})
  .catch(function(){cnt.textContent='Impossible de charger l\\'index de recherche.'});return}
 var toks=q.split(/\\s+/).filter(Boolean),res=[];
 for(var i=0;i<IDX.length;i++){var e=IDX[i],score=0,ok=true;
  for(var j=0;j<toks.length;j++){var t=toks[j];
   if(e.nt.indexOf(t)>=0){score+=e.nt.indexOf(t)===0?4:3}
   else if(e.nd.indexOf(t)>=0){score+=1}
   else if(e.nc.indexOf(t)>=0){score+=1}
   else{ok=false;break}}
  if(ok){res.push([score,e])}}
 res.sort(function(a,b){return b[0]-a[0]});
 cnt.textContent=res.length?res.length+' résultat'+(res.length>1?'s':''):'Aucun résultat. Essayez un nom de commune, de résidence ou de dispositif.';
 var vide=!out.children.length;
 out.innerHTML=res.slice(0,60).map(function(r,idx){var e=r[1];
  return '<li style="--i:'+(idx<8?idx:8)+'"><span class="badge-cat">'+esc(e.c)+'</span><div><a href="'+esc(e.u)+'">'+esc(e.t)+'</a>'+(e.d?'<br><small>'+esc(e.d)+'</small>':'')+'</div></li>'}).join('');
 /* Cascade au premier rendu (ou au passage vide -> rempli) seulement :
  * rejouer a chaque frappe ferait scintiller la liste. */
 if(vide&&res.length){out.classList.add('anim')}else{out.classList.remove('anim')}
}
var deb;inp.addEventListener('input',function(){clearTimeout(deb);deb=setTimeout(run,120)});
document.querySelectorAll('.pill.ex').forEach(function(b){b.addEventListener('click',function(){inp.value=b.getAttribute('data-q');run();inp.focus()})});
var m=location.search.match(/[?&]q=([^&]+)/);
if(m){inp.value=decodeURIComponent(m[1].replace(/\\+/g,' '));run()}
inp.focus();
})();
</script>`;
  addPage('/recherche/', layout({
    title: `Rechercher | ${SITE.name}`,
    metaDescription: `Recherchez une commune, une résidence CROUS, un FJT, une résidence autonomie, un dispositif ou une aide au logement en Île-de-France.`,
    urlPath: '/recherche/',
    content,
    breadcrumbs: [{ name: 'Recherche', url: '/recherche/' }],
  }), '0.3');
})();

/* Page 404 — sa présence désactive aussi le fallback SPA de Cloudflare Pages
 * (sans elle, toute URL inconnue renvoyait l'accueil en 200 : soft-404). */
const HTML_404 = layout({
  title: `Page introuvable | ${SITE.name}`,
  metaDescription: 'Cette page n\'existe pas ou plus.',
  urlPath: '/404/',
  content: `
<h1>Page introuvable</h1>
<p class="lead">Cette adresse ne correspond à aucune page du site. Le contenu a peut-être été déplacé.</p>
<p class="hero-actions"><a class="btn" href="/recherche/">Rechercher sur le site</a><a class="btn btn-ghost" href="/">Retour à l'accueil</a></p>`,
}).replace('<link rel="canonical" href="https://trouve-ton-appart.fr/404/">', '<meta name="robots" content="noindex">');

/* Mentions légales */
(function buildMentions() {
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › Mentions légales</nav>
<h1>Mentions légales</h1>
<p><strong>Éditeur du site</strong> : MKZ, société par actions simplifiée (SAS) au capital social de 1 000 €, dont le siège social est situé 1 rue Françoise Sagan, 77230 Dammartin-en-Goële. SIRET : 983 662 784 00013 · TVA intracommunautaire : FR44983662784.</p>
<p><strong>Directeur de la publication</strong> : Mickaël Leclerc, représentant légal.</p>
<p><strong>Contact</strong> : <a href="mailto:contact@mkz-consulting.fr">contact@mkz-consulting.fr</a></p>
<p><strong>Hébergement</strong> : Cloudflare Pages, Cloudflare Inc., 101 Townsend St, San Francisco, CA 94107, États-Unis.</p>
<p><strong>Données personnelles</strong> : Ce site ne collecte aucune donnée personnelle et ne dépose aucun cookie de suivi sans consentement.</p>
<p><strong>Nature du service</strong> : ${esc(SITE.name)} est un service d'information et d'orientation. Les candidatures et démarches s'effectuent exclusivement sur les sites officiels et plateformes tierces vers lesquels nous renvoyons ; nous ne sommes ni bailleur, ni agent immobilier, ni intermédiaire de transaction.</p>`;
  addPage('/mentions-legales/', layout({
    title: `Mentions légales | ${SITE.name}`,
    metaDescription: `Mentions légales du site ${SITE.name}.`,
    urlPath: '/mentions-legales/',
    content,
    breadcrumbs: [{ name: 'Mentions légales', url: '/mentions-legales/' }]
  }), '0.1');
})();

/* ------------------------------ CSS --------------------------------- */

/* Déclaration de fonction (hoistée) : le CSS est inliné dans <head> par layout(),
 * appelé avant ce point du fichier. Supprime la requête bloquante /style.css. */
function css() { return `:root{--bleu:${PAL.bleu};--bleu2:${PAL.bleu2};--accent:${PAL.accent};--accent2:${PAL.accentFonce};--cta:#b04a30;--encre:${PAL.encre};--gris:#5b6770;--fond:#fdfbf7;--surface:#ffffff;--fond2:#f2f6fa;--ciel:${PAL.cielClair};--creme:${PAL.creme};--bord:#dde5ec}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--encre);background:var(--fond);line-height:1.65}
.container{max-width:980px;margin:0 auto;padding:0 20px}
a{color:var(--bleu2)}h1,h2,h3{line-height:1.25;color:var(--bleu)}
h1{font-size:clamp(1.75rem,3.6vw,2.5rem);line-height:1.15;font-weight:800;letter-spacing:-.022em}
h2{font-size:clamp(1.32rem,2.2vw,1.55rem);line-height:1.25;font-weight:700;letter-spacing:-.012em;margin-top:2.6rem}
h3{font-size:1.08rem;line-height:1.35;font-weight:650}
.lead{font-size:1.14rem;line-height:1.6;color:var(--gris)}
.kicker{font-size:.76rem;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--ttx,var(--bleu2));margin:0 0 .2rem}
/* ---- Header ---- */
.site-header{background:linear-gradient(135deg,#163a5c,var(--bleu) 60%,#26619a);padding:16px 0 0}
.site-header::after{content:"";display:block;height:4px;margin-top:14px;background:linear-gradient(90deg,var(--bleu2) 0 34%,var(--accent) 34% 67%,#3d8b6e 67%)}
.main-nav a:focus-visible{outline:2px solid #fff;outline-offset:2px}
.site-header .container{display:flex;flex-wrap:wrap;gap:10px 24px;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:11px;color:#fff;text-decoration:none}
.brand-mark{width:38px;height:38px;flex:none;transition:transform .25s}
.brand:hover .brand-mark{transform:rotate(-4deg) scale(1.06)}
.brand .brand-door{transition:fill .25s}
.brand:hover .brand-door{fill:#ffb39e}
.brand-text{font-weight:800;font-size:1.22rem;letter-spacing:-.015em;line-height:1.15}
.brand-text em{font-style:normal;color:#f3a18b}
.brand-a{height:.78em;width:auto;margin-right:.02em}
.brand-sub{display:block;font-size:.64rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#9fc1e0}
.main-nav{display:flex;flex-wrap:wrap;gap:4px 6px}
.main-nav a{color:#fff;text-decoration:none;font-size:.93rem;opacity:.92;padding:6px 12px;border-radius:8px;transition:background .15s}
.main-nav a[aria-current]{background:rgba(255,255,255,.16);opacity:1;position:relative}
/* État de repos = barre visible ; l'animation ne fait qu'ARRIVER dessus
 * (from scaleX(0)) : sous reduced-motion, l'indicateur reste affiché. */
.main-nav a[aria-current]::after{content:"";position:absolute;left:12px;right:12px;bottom:2px;height:2px;border-radius:1px;background:#f3a18b;transform-origin:left;animation:nav-actif .26s ease-out .15s both}
.main-nav a:hover{background:rgba(255,255,255,.14);opacity:1}
/* ---- Hero ---- */
.hero{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:24px 36px;align-items:end;background:radial-gradient(420px 260px at 84% 22%,rgba(224,122,95,.12),transparent 70%),linear-gradient(160deg,#e8f1f9,#f7fbfe 60%,#fdfbf7 120%);border:1px solid #dbe7f1;border-radius:22px;box-shadow:0 18px 44px -28px rgba(31,78,121,.35);padding:40px 42px 28px;margin:1.6rem 0 .6rem}
.hero h1{margin:.2rem 0 .8rem}
.hero-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:1.4rem}
.hero-illo svg{display:block;width:100%;max-width:330px;height:auto;margin:0 0 .2rem auto}
/* La porte s'éclaire au survol/focus du CTA principal (retour plus lent
 * que l'aller pour éviter le clignotement). Sans :has() : rien, aucun bris. */
/* Fenêtres qui s'allument une fois, de bas en haut (délais posés au build) ;
 * sous reduced-motion, la règle dédiée du bloc reduce les sert allumées. */
.w-lit{opacity:0;animation:allumer .35s ease-out both}
.soleil,.soleil-halo{transform-box:fill-box;transform-origin:center}
/* 6 itérations et non infinite : la respiration s'éteint d'elle-même après
 * ~1 min (WCAG 2.2.2, pas de mouvement parallèle au contenu sans fin). */
.soleil{animation:respire 9s ease-in-out 6 alternate}
.soleil-halo{animation:halo 9s ease-in-out 6 alternate}
/* Pause hors viewport (batterie) : seulement les boucles temporelles, pas
 * les plans scroll-driven ni les fenêtres déjà allumées (micro-saut sinon). */
.illo-skyline.pause :is(.soleil,.soleil-halo,g[fill="#fff"]){animation-play-state:paused}
.porte{transition:filter .4s ease-out}
.porte-lueur{opacity:0;transition:opacity .4s ease-out}
.hero:has(.hero-actions .btn:not(.btn-ghost):hover) .porte,.hero:has(.hero-actions .btn:not(.btn-ghost):focus-visible) .porte{filter:brightness(1.45) saturate(1.15);transition-duration:.25s}
.hero:has(.hero-actions .btn:not(.btn-ghost):hover) .porte-lueur,.hero:has(.hero-actions .btn:not(.btn-ghost):focus-visible) .porte-lueur{opacity:.5;transition-duration:.25s}
.btn{display:inline-block;background:var(--cta);color:#fff;font-weight:600;text-decoration:none;padding:11px 22px;border-radius:10px;font-size:.97rem;box-shadow:0 8px 20px -10px rgba(176,74,48,.55);transition:background .15s,transform .15s,box-shadow .15s}
.btn:hover{background:#9a3f27;transform:translateY(-1px)}
/* Press state : descente rapide (80 ms), remontée douce (150 ms de base). */
.btn:active{transform:translateY(1px) scale(.985);box-shadow:0 3px 8px -6px rgba(176,74,48,.55);transition-duration:.15s,.08s,.15s}
.btn-ghost{background:transparent;color:var(--bleu);box-shadow:inset 0 0 0 2px var(--bleu2)}
.btn-ghost:hover{background:var(--ciel);transform:translateY(-1px)}
.btn-ghost:active{transform:translateY(1px) scale(.985);box-shadow:inset 0 0 0 2px var(--bleu2)}
/* ---- Cartes ---- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:18px;margin:1.2rem 0 2.2rem}
.card{display:block;border:1px solid var(--bord);border-radius:16px;padding:22px;text-decoration:none;color:inherit;background:var(--surface);box-shadow:0 1px 2px rgba(22,51,82,.05),0 6px 18px -12px rgba(22,51,82,.10);transition:box-shadow .18s,transform .18s,border-color .18s;position:relative;overflow:hidden}
.card:hover{box-shadow:0 16px 36px -14px var(--ts,rgba(31,78,121,.30));transform:translateY(-3px);border-color:var(--t,var(--bleu2))}
.card h3{margin:0 0 .5rem;font-size:1.06rem}.card p{margin:0;color:var(--gris);font-size:.92rem}
.card-parcours::before{content:"";position:absolute;inset:0 0 auto 0;height:5px;background:var(--t,var(--bleu2));transform-origin:top left;transition:transform .22s cubic-bezier(.2,.7,.3,1)}
.card-parcours:hover::before,.card-parcours:focus-visible::before{transform:scaleY(1.8)}
/* Ouverture en escalier des 3 parcours (accueil). Fill BACKWARDS uniquement :
 * un fill forwards sur transform tuerait le lift et le scaleY du survol. */
.grid-accueil .card{animation:rise .5s cubic-bezier(.2,.7,.3,1) .32s backwards}
.grid-accueil .card:nth-child(2){animation-delay:.4s}
.grid-accueil .card:nth-child(3){animation-delay:.48s}
.grid-accueil .card-parcours::before{animation:drawx .35s ease-out .32s backwards}
.grid-accueil .card-parcours:nth-child(2)::before{animation-delay:.4s}
.grid-accueil .card-parcours:nth-child(3)::before{animation-delay:.48s}
.card-icon{display:inline-flex;width:42px;height:42px;border-radius:11px;background:var(--tbg,var(--ciel));padding:8px;margin-bottom:10px}
.card-icon svg{width:100%;height:100%}
.card-cta{display:inline-block;margin-top:.9rem;color:var(--ttx,var(--bleu2));font-weight:650;font-size:.9rem}
/* Flèche autonome : seule la flèche glisse, seul le LIBELLÉ (.cta-label) se
 * souligne (un background sur le span entier passerait sous la flèche). */
.cta-label{padding-bottom:2px;background:linear-gradient(currentColor,currentColor) no-repeat 0 100%/0 1.5px;transition:background-size .25s}
.card:hover .cta-label,.card:focus-visible .cta-label{background-size:100% 1.5px}
.cta-arrow{display:inline-block;transition:transform .24s cubic-bezier(.34,1.4,.5,1)}
.card:hover .cta-arrow,.card:focus-visible .cta-arrow,a:hover>.cta-arrow,a:focus-visible>.cta-arrow{transform:translateX(5px)}
.grid-guides{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.card-guide{display:flex;gap:14px;align-items:flex-start}
.card-icon-sm{flex:none;width:36px;height:36px;border-radius:10px;padding:7px;margin:2px 0 0}
/* ---- Têtes de page illustrées ---- */
.page-head{display:flex;gap:18px;align-items:flex-start;background:linear-gradient(135deg,var(--tbg,var(--ciel)),#fff 85%);border:1px solid var(--bord);border-left:6px solid var(--t,var(--bleu2));border-radius:18px;padding:22px 26px;margin:0 0 1.8rem;box-shadow:0 14px 34px -24px var(--ts,rgba(31,78,121,.30))}
.page-head-icon{flex:none;width:46px;height:46px;background:#fff;border-radius:12px;padding:9px;box-shadow:0 4px 12px var(--ts,rgba(31,78,121,.18));margin-top:4px}
.page-head-icon svg{width:100%;height:100%}
.page-illu{flex:none;width:340px;max-width:38%;align-self:stretch;height:auto;object-fit:cover;border-radius:0 17px 17px 0;margin:-22px -26px -22px 8px;box-shadow:-14px 0 24px -18px rgba(31,78,121,.25)}
.page-head h1{margin:.1rem 0 .5rem}.page-head .lead{margin:0}
/* ---- Étapes numérotées ---- */
.steps{counter-reset:etape}
.step{position:relative;border:1px solid var(--bord);border-radius:14px;padding:18px 22px 16px 64px;margin:1.2rem 0;counter-increment:etape;background:var(--surface)}
.step::before{content:counter(etape);position:absolute;left:18px;top:20px;width:30px;height:30px;border-radius:50%;background:var(--ttx,var(--bleu2));color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:.95rem;box-shadow:0 0 0 5px var(--tbg,var(--ciel))}
.step:not(:last-child)::after{content:"";position:absolute;left:31px;top:54px;bottom:-1.3rem;width:3px;border-radius:2px;background:linear-gradient(180deg,var(--ts,rgba(46,116,181,.30)),transparent)}
.step h2{margin:.1rem 0 .5rem;font-size:1.2rem}
.step h3{margin:.15rem 0 .5rem;font-size:1.08rem;color:var(--bleu)}
.maj{font-size:.82rem;color:var(--gris);margin:.4rem 0 0;font-style:italic}
/* ---- Divers ---- */
.notice{background:var(--creme);border:1px solid #efe5d6;border-radius:16px;padding:8px 24px 20px;margin:2.2rem 0}
.pills{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pill{display:inline-block;background:var(--surface);border:1px solid var(--bord);border-radius:999px;padding:6px 15px;font-size:.85rem;text-decoration:none;transition:border-color .15s,background .15s}
/* Pills bouton = vraies cibles tactiles : min 44px (les pills lien restent
 * des tags secondaires au gabarit historique). */
button.pill{font:inherit;font-size:.85rem;color:var(--encre);cursor:pointer;padding:11px 16px;min-height:44px}
.compte{font-variant-numeric:tabular-nums}
.pill:hover{border-color:var(--t,var(--bleu2));background:var(--tbg,var(--ciel))}
.sources{padding-left:1.1rem}.sources li{margin:.5rem 0}
/* Liens de prose : le soulignement s'épaissit et passe au terracotta.
 * :not([class]) exclut pills, boutons et CTA de composants. */
main p a:not([class]),main li a:not([class]){text-decoration-thickness:1px;text-underline-offset:2px;transition:text-decoration-color .18s,text-decoration-thickness .18s,text-underline-offset .18s}
main p a:not([class]):hover,main li a:not([class]):hover,main p a:not([class]):focus-visible,main li a:not([class]):focus-visible{text-decoration-color:var(--accent);text-decoration-thickness:2px;text-underline-offset:3px}
.breadcrumb{font-size:.85rem;color:var(--gris);margin:1.3rem 0 1rem}.breadcrumb a{color:var(--gris)}
.faq details{border:1px solid var(--bord);border-radius:12px;padding:12px 18px;margin:.7rem 0;background:var(--surface);transition:border-color .15s}
.faq details[open]{border-color:var(--bleu2);background:linear-gradient(180deg,var(--ciel),#fff 140%)}
/* Chevron accent commun FAQ + sommaire de guide (le marker natif saute). */
.faq summary,.toc-box summary{cursor:pointer;font-weight:600;color:var(--bleu);list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px}
.faq summary::-webkit-details-marker,.toc-box summary::-webkit-details-marker{display:none}
.faq summary::after,.toc-box summary::after{content:"";flex:none;width:9px;height:9px;border-right:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:rotate(45deg);transition:transform .25s ease-out}
.faq details[open] summary::after,.toc-box[open] summary::after{transform:rotate(225deg)}
/* ---- Sommaire de guide + barre de lecture ---- */
.guide-toc{margin:0 0 1.4rem}
.toc-box{border:1px solid var(--bord);border-radius:12px;background:var(--surface);padding:2px 18px}
.toc-box summary{font-size:.92rem;padding:11px 0}
.toc-box ol{margin:.15rem 0 .8rem;padding-left:1.3rem;font-size:.88rem}
.toc-box li{margin:.32rem 0}
.toc-box a{color:var(--gris);text-decoration:none;display:inline-block;padding:1px 7px;margin-left:-7px;border-radius:6px;transition:background .2s,color .2s}
.toc-box a:hover{color:var(--bleu2)}
.toc-box a.on{background:var(--ciel);color:var(--bleu);font-weight:600}
/* Filet de progression de lecture (guides) : scroll-driven, Chromium.
 * Ailleurs (et sous reduced-motion) : scaleX(0), invisible, assumé. */
.lecture-bar{position:fixed;top:0;left:0;width:100%;height:3px;background:var(--accent);transform:scaleX(0);transform-origin:left;pointer-events:none;z-index:9}
@supports(animation-timeline:scroll()){.lecture-bar{animation:lecture linear both;animation-timeline:scroll(root)}}
@media(min-width:1020px){
.guide-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:0 36px;align-items:start}
.guide-toc{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto}
}
/* ---- Footer ---- */
.roofline{display:block;width:100%;height:22px;margin-top:3.5rem}
.site-footer{background:linear-gradient(180deg,#1c2733,#16202a);color:#cdd6de;margin-top:0;padding:2.4rem 0 1rem;font-size:.88rem}
.footer-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:24px}
.footer-brand{color:#fff;font-weight:700;font-size:1.05rem}
.footer-title{font-size:.78rem;font-weight:650;text-transform:uppercase;letter-spacing:.08em;color:#9fb3c8;margin-bottom:.4rem}
.site-footer ul{list-style:none;padding:0;margin:0}.site-footer li{margin:.38rem 0}.site-footer a{color:#9fc1e0;text-decoration:none}.site-footer a:hover{text-decoration:underline;color:#cfe3f4}
.footer-legal{border-top:1px solid #33414e;margin-top:1.6rem;padding-top:1rem;color:#8a98a5}
/* ---- Annuaires de données (Phase 2) ---- */
[id]{scroll-margin-top:16px}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dir-list{list-style:none;padding:0;margin:1.2rem 0}
.dir-item{position:relative;border:1px solid var(--bord);border-left:5px solid var(--t,var(--bleu2));border-radius:14px;padding:14px 20px;margin:.8rem 0;background:var(--surface)}
/* Projecteur : halo 1,5 s sur la fiche visée en arrivant de la recherche.
 * z-index:0 sur le parent crée le stacking context qui place le ::after
 * z-index:-1 AU-DESSUS du fond du parent mais SOUS son texte. */
.dir-item:target{z-index:0}
.dir-item:target::after{content:"";position:absolute;inset:-2px;border-radius:14px;background:var(--tbg,var(--ciel));opacity:0;pointer-events:none;z-index:-1;animation:spot 1.5s ease-out .15s both}
.dir-item h3{margin:.05rem 0 .3rem;font-size:1.05rem}
.dir-addr{margin:.15rem 0;color:var(--gris)}
.dir-meta{margin:.15rem 0;font-size:.92rem}
.dir-tags{margin:.4rem 0 .1rem}
.dir-tags span{display:inline-block;background:var(--fond2);border:1px solid var(--bord);border-radius:999px;padding:2px 10px;font-size:.76rem;margin:2px 5px 2px 0;color:var(--gris)}
.dir-links{margin:.4rem 0 .1rem;font-size:.92rem}
/* ---- Tableaux de données ---- */
.table-wrap{overflow-x:auto;margin:1.2rem 0;border:1px solid var(--bord);border-radius:14px;box-shadow:0 1px 2px rgba(22,51,82,.05),0 6px 18px -12px rgba(22,51,82,.10)}
table.data{border-collapse:collapse;width:100%;font-size:.92rem;background:var(--surface)}
.data th{background:linear-gradient(#edf4fa,#dfecf7);border-bottom:2px solid #c9dcec;color:var(--bleu);text-align:left;padding:9px 12px;white-space:nowrap;font-size:.76rem;text-transform:uppercase;letter-spacing:.05em}
.data td{border-top:1px solid var(--bord);padding:7px 12px}
.data tbody tr:nth-child(even) td{background:#f8fbfd}
.data tbody tr:hover td{background:var(--fond2)}
.data td.num,.data th.num{text-align:right;font-variant-numeric:tabular-nums}
.data td.bar{background-image:linear-gradient(90deg,var(--tbg,var(--ciel)) var(--pct,0%),transparent 0);background-origin:content-box;background-repeat:no-repeat}
/* Jauges animées : --pct enregistrée pour être interpolable ; la classe
 * jauge-anim (posée par JS, donc jamais en no-JS ni reduced-motion) met les
 * barres à zéro et in-view les libère. Le !important est nécessaire pour
 * primer sur le style inline --pct posé par le build. Sans @property
 * (vieux navigateurs) : remplissage instantané, aucun bris. */
@property --pct{syntax:'<percentage>';initial-value:0%;inherits:false}
.jauge-anim tbody tr.in-view td.bar{transition:--pct .8s cubic-bezier(.25,.7,.3,1)}
.jauge-anim tbody tr:not(.in-view) td.bar{--pct:0%!important}
.jauge-anim tbody tr:not(.in-view) .badge{opacity:0}
.jauge-anim tbody tr.in-view .badge{animation:badgepop .45s .5s cubic-bezier(.34,1.56,.64,1) backwards}
.badge{display:inline-block;border-radius:6px;padding:1px 8px;font-size:.74rem;font-weight:650;white-space:nowrap}
.badge-def{background:#fdecdd;color:#a8492f}
.badge-car{background:#b04a30;color:#fff}
/* ---- Outil encadrement ---- */
.tool{background:var(--ciel);border:1px solid var(--bord);border-radius:16px;padding:10px 24px 18px;margin:0 0 2rem}
.tool-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:1rem 0}
.tool-form label{font-size:.82rem;font-weight:650;color:var(--bleu);display:block;margin-bottom:3px}
.tool-form select,.tool-form input{width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--bord);border-radius:8px;font:inherit;background:#fff}
.tool-result{background:#fff;border:1px solid var(--bord);border-left:5px solid var(--accent);border-radius:12px;padding:12px 18px;margin:.8rem 0}
/* Skeleton du widget (affiché après 180 ms de latence réelle seulement) ;
 * min-height : le passage skeleton -> verdict ne doit pas décaler la page. */
#enc-result:not([hidden]){min-height:74px}
.sk{height:18px;border-radius:8px;background:var(--ciel);margin:8px 0;position:relative;overflow:hidden}
.sk-2{width:70%;height:12px}
.sk::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent);animation:reflet 1.2s linear infinite}
/* Verdict « tampon » : ne rejoue qu'au CHANGEMENT de verdict (classe stamp
 * posée par le JS), pas à chaque frappe, sinon clignotement pendant la saisie.
 * Jamais de count-up sur un plafond légal : le chiffre s'affiche entier. */
.enc-ok,.enc-ko{font-weight:650;padding:8px 14px;border-radius:10px;transform-origin:left center}
.enc-ok.stamp,.enc-ko.stamp{animation:tampon .38s cubic-bezier(.2,.8,.3,1.1) both}
.enc-ok{color:#2e7050;background:#e9f4ef}.enc-ko{color:#b3261e;background:#fdecdd}
/* ---- Recherche ---- */
.search-input{width:100%;min-height:44px;font-size:1.02rem;padding:11px 16px;border:2px solid var(--bleu2);border-radius:12px;font-family:inherit}
.search-inline{max-width:340px;display:inline-block;padding:8px 12px;font-size:.95rem;border-width:1px;border-color:var(--bord)}
.result-count{color:var(--gris);font-size:.88rem}
.result-list{list-style:none;padding:0}
.result-list li{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--bord);border-radius:12px;padding:10px 16px;margin:.55rem 0;background:var(--surface)}
.result-list small{color:var(--gris)}
.badge-cat{flex:none;background:var(--ciel);color:var(--bleu);border-radius:6px;padding:2px 8px;font-size:.72rem;font-weight:650;margin-top:2px;white-space:nowrap}
/* ---- Animations (CSS pur, désactivées si reduced-motion) ---- */
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes fadein{from{opacity:0}to{opacity:1}}
@keyframes drift{from{transform:translateX(-6px)}to{transform:translateX(10px)}}
@keyframes nav-actif{from{transform:scaleX(0)}}
@keyframes tampon{from{opacity:0;transform:scale(.94)}70%{transform:scale(1.015)}to{opacity:1;transform:none}}
@keyframes lecture{0%{transform:scaleX(0);opacity:0}4%{opacity:1}100%{transform:scaleX(1);opacity:1}}
@keyframes allumer{to{opacity:.95}}
@keyframes respire{to{transform:scale(1.03)}}
@keyframes halo{to{transform:scale(1.18);opacity:.1}}
@keyframes drawx{from{transform:scaleX(0)}}
@keyframes trace{from{transform:scaleY(0)}}
/* ignite : transform seul. Interpoler le fond clair vers le bleu croisait la
 * couleur du chiffre (contraste 1:1 à mi-course, état gelable au scroll). */
@keyframes ignite{from{transform:scale(.85)}}
@keyframes badgepop{from{opacity:0;transform:scale(.55)}60%{transform:scale(1.12)}}
@keyframes spot{20%{opacity:.55}}
@keyframes reflet{to{transform:translateX(100%)}}
@keyframes par-ciel{to{transform:translateY(-6px)}}
@keyframes par-fac{to{transform:translateY(-16px)}}
.hero-text h1{animation:rise .55s .05s cubic-bezier(.2,.7,.3,1) both}
.hero-text .lead{animation:rise .55s .15s cubic-bezier(.2,.7,.3,1) both}
.hero-actions{animation:rise .55s .25s cubic-bezier(.2,.7,.3,1) both}
.hero-illo{animation:rise .6s .2s cubic-bezier(.2,.7,.3,1) both}
.illo-skyline g[fill="#fff"]{animation:drift 16s ease-in-out infinite alternate}
.page-head-icon{animation:rise .45s cubic-bezier(.2,.7,.3,1) both}
.page-head>div{animation:rise .5s .08s cubic-bezier(.2,.7,.3,1) both}
.page-illu{animation:fadein .6s .15s ease-out both}
.card-icon{transition:transform .2s}
.card:hover .card-icon{transform:scale(1.07) rotate(-3deg)}
.faq details[open] p{animation:rise .3s ease-out both}
/* Cascade des résultats : premier rendu seulement (classe anim posée par le
 * JS de recherche), plafonnée à 8 items via la variable --i posée inline. */
.result-list.anim li{animation:rise .22s ease-out both;animation-delay:calc(var(--i,0)*25ms)}
.tool-result{animation:rise .35s ease-out both}
/* Révélation au défilement (Chromium ; statique ailleurs). Opacité seule sur
 * .card : un transform en fill bloquerait le translateY du survol. */
@supports(animation-timeline:view()){
/* La grille de l'accueil est EXCLUE : son escalier a ses propres délais,
 * que le shorthand animation de cette règle réinitialiserait. */
.grid:not(.grid-accueil) .card{animation:fadein both;animation-timeline:view();animation-range:entry 0% entry 35%}
.steps .step,.dir-item{animation:rise both;animation-timeline:view();animation-range:entry 0% entry 32%}
/* « Dans le bon ordre » : la ligne se trace et chaque pastille s'allume au
 * fil du scroll. Fallback (autres moteurs, reduced-motion) : état plein. */
.step:not(:last-child)::after{transform-origin:top;animation:trace both;animation-timeline:view();animation-range:entry 10% entry 75%}
.step::before{animation:ignite both;animation-timeline:view();animation-range:entry 15% entry 45%}
}
@supports(animation-timeline:scroll()){
/* Parallaxe de la skyline sur les 600 premiers px de scroll : le proche
 * (façades) bouge plus que le lointain (ciel), 16 px et 6 px, plafonds durs
 * (risque vestibulaire). La tour Eiffel vit avec les façades : ligne de sol. */
.plan-ciel{animation:par-ciel linear both;animation-timeline:scroll(root);animation-range:0px 600px}
.plan-facades{animation:par-fac linear both;animation-timeline:scroll(root);animation-range:0px 600px}
}
/* ---- Global a11y ---- */
:focus-visible{outline:3px solid var(--bleu2);outline-offset:2px}
@media(prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
::selection{background:var(--ciel)}
/* Kill switch : le sélecteur * seul ne matche PAS les pseudo-éléments
 * (chevron FAQ, barre du menu, liserets) — ils continueraient d'animer.
 * La barre de lecture reste à scaleX(0) : invisible sous reduced-motion, assumé. */
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}.card:hover,.btn:hover,.btn:active,.card:hover .card-icon,.card:hover .cta-arrow,.card:focus-visible .cta-arrow,a:hover>.cta-arrow,a:focus-visible>.cta-arrow,.brand:hover .brand-mark,.card-parcours:hover::before,.card-parcours:focus-visible::before{transform:none}
/* Les états finaux portés par une animation doivent être servis en statique. */
.w-lit{opacity:.95}}
/* ---- Responsive ---- */
@media(max-width:760px){
.hero{grid-template-columns:1fr;padding:24px 22px 20px;gap:8px}
.hero-illo{margin-top:.6rem}
.page-head{flex-direction:column;gap:12px;padding:20px}
.page-illu{width:calc(100% + 40px);max-width:none;margin:0 -20px -20px;border-radius:0 0 17px 17px;max-height:240px}
.step{padding-left:58px}
.step:not(:last-child)::after{display:none}
}`; }

/* --------------------------- Écriture ------------------------------- */

/* OneDrive ou l'antivirus peuvent tenir un verrou sur le dossier dist/ lui-même
 * (EPERM Windows) : on retente, puis on se rabat sur un vidage du contenu. */
try {
  fs.rmSync(DIST, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
} catch {
  for (const f of fs.readdirSync(DIST)) {
    fs.rmSync(path.join(DIST, f), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}
fs.mkdirSync(DIST, { recursive: true });

for (const { urlPath, html } of pages) {
  const dir = path.join(DIST, ...urlPath.split('/').filter(Boolean));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
}

fs.writeFileSync(path.join(DIST, 'style.css'), css());

/* Données consommées côté client (outil encadrement, recherche) */
if (ENCADREMENT) {
  const grille = {};
  for (const r of ENCADREMENT.records) {
    grille[`${r.quartierId}|${r.pieces}|${EPOQUES.indexOf(r.epoque)}|${r.meuble ? 1 : 0}`] = [r.ref, r.refMajore, r.refMinore];
  }
  fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'data', 'encadrement-loyers-paris.json'), JSON.stringify({
    millesime: ENCADREMENT._meta.millesime,
    attribution: ENCADREMENT._meta.attribution,
    grille,
  }));
}
fs.writeFileSync(path.join(DIST, 'search-index.json'), JSON.stringify(SEARCH_INDEX));

fs.writeFileSync(path.join(DIST, '404.html'), HTML_404);

/* ---------------- GEO : llms.txt et llms-full.txt -------------------- */
/* llms.txt (llmstxt.org) : index du site pour les moteurs IA — qui nous
 * sommes, ce qui fait foi, et où aller chercher quoi. llms-full.txt : le
 * contenu intégral en texte brut, citable, avec sources et dates. */
const B = SITE.baseUrl;
const llms = [];
llms.push(`# ${SITE.name}`);
llms.push('');
llms.push(`> ${SITE.tagline}. ${SITE.description}`);
llms.push('');
llms.push(`Service d'orientation indépendant et gratuit (éditeur : MKZ SAS) : pas d'annonces, des parcours par profil de vie et des liens vers les guichets officiels où candidater. Périmètre : Paris et Île-de-France. Nos annuaires et chiffres sont construits sur les données publiques (Licence Ouverte Etalab ; encadrement des loyers : ODbL Ville de Paris) — citez la source et la date en cas de réutilisation. Contenu mis à jour le ${DATE_FR}.`);
llms.push('');
llms.push('## Parcours par profil');
for (const p of PARCOURS) llms.push(`- [${p.h1}](${B}/${p.slug}/): ${p.metaDescription}`);
llms.push('');
llms.push('## Guides pratiques');
for (const g of GUIDES) llms.push(`- [${g.h1}](${B}/guides/${g.slug}/): ${g.metaDescription}`);
llms.push('');
llms.push('## Annuaires et chiffres (données publiques)');
if (CROUS) llms.push(`- [Résidences CROUS d'Île-de-France](${B}/residences-crous/): les ${CROUS.records.length} résidences universitaires publiques, adresses et contacts par département (source : CNOUS).`);
if (FJT) llms.push(`- [Foyers de jeunes travailleurs](${B}/foyers-jeunes-travailleurs/): les ${FJT.records.length} FJT franciliens pour les 16-25 ans, adresses et téléphones (source : FINESS).`);
if (RES_AUTONOMIE) llms.push(`- [Résidences autonomie (seniors)](${B}/residences-autonomie/): les ${RES_AUTONOMIE.records.length} résidences pour seniors autonomes (source : FINESS).`);
if (LS_COMMUNES) llms.push(`- [Le logement social en chiffres](${B}/logement-social/chiffres/): parc, loyers au m², vacance et taux SRU, commune par commune (sources : RPLS Insee-SDES 01/01/2024, inventaire SRU, zonage ABC).`);
if (ENCADREMENT) llms.push(`- [Vérificateur d'encadrement des loyers à Paris](${B}/guides/encadrement-des-loyers-paris/): les ${ENCADREMENT.records.length} loyers de référence ${ENCADREMENT._meta.millesime} (80 quartiers × pièces × époque × meublé). Grille complète en JSON : ${B}/data/encadrement-loyers-paris.json (ODbL, Ville de Paris).`);
llms.push('');
llms.push('## Divers');
llms.push(`- [Annuaire des sources fiables](${B}/annuaire/): ${ANNUAIRE.metaDescription}`);
llms.push(`- [Recherche](${B}/recherche/): commune, résidence, dispositif — index JSON : ${B}/search-index.json`);
llms.push(`- [Contenu intégral pour les LLM](${B}/llms-full.txt)`);
llms.push(`- [Mentions légales](${B}/mentions-legales/)`);
fs.writeFileSync(path.join(DIST, 'llms.txt'), llms.join('\n') + '\n');

const full = [];
full.push(`# ${SITE.name} — contenu intégral (llms-full.txt)`);
full.push('');
full.push(`Généré le ${DATE_ISO}. Site : ${B} — ${SITE.tagline}.`);
full.push(`${SITE.description} Service d'orientation indépendant (MKZ SAS) : nous ne publions pas d'annonces, nous orientons vers les guichets officiels. Les chiffres ci-dessous proviennent de données publiques ; citez la source et la date.`);
full.push('');
full.push('## PARCOURS');
for (const p of PARCOURS) {
  full.push('');
  full.push(`### ${p.h1} — ${B}/${p.slug}/`);
  full.push(p.intro);
  for (const e of p.etapes) full.push(`${e.titre} ${e.texte}`);
}
full.push('');
full.push('## GUIDES');
for (const g of GUIDES) {
  full.push('');
  full.push(`### ${g.h1} — ${B}/guides/${g.slug}/`);
  full.push(`Mis à jour le ${DATE_FR}.`);
  full.push(g.intro);
  for (const s of g.sections) {
    full.push(`#### ${s.h2}`);
    if (s.paragraphs) for (const t of s.paragraphs) full.push(t);
    if (s.bullets) for (const b of s.bullets) full.push(`- ${b}`);
    if (s.table) { full.push(s.table.caption); for (const r of s.table.rows) full.push(`- ${r.join(' · ')}`); }
  }
  full.push('FAQ :');
  for (const f of g.faq) { full.push(`Q : ${f.q}`); full.push(`R : ${f.a}`); }
  full.push(`Sources officielles : ${g.sourcesOfficielles.map(s => `${s.label} (${s.url})`).join(' · ')}`);
}
if (LS_COMMUNES) {
  full.push('');
  full.push(`## DONNÉES — LOGEMENT SOCIAL PAR COMMUNE (Île-de-France)`);
  full.push(`${LS_COMMUNES._meta.attribution}. Extraction du ${dateFrOf(LS_COMMUNES._meta.collectedAt)}. Détail et définitions : ${B}/logement-social/chiffres/`);
  full.push(`Avertissement : parc RPLS et décompte SRU reposent sur des assiettes différentes, ne pas les additionner. Loyers en €/m² de surface habitable, hors charges.`);
  for (const r of LS_COMMUNES.records) {
    const parts = [
      r.nbLogementsSociaux != null ? `${fmt(r.nbLogementsSociaux)} logements sociaux (RPLS 01/01/2024)` : null,
      r.loyerMedian != null ? `loyer médian ${fmt(r.loyerMedian, 2)} €/m²` : null,
      r.txVacance != null ? `vacance ${fmt(r.txVacance, 1)} %` : null,
      r.tauxSRU != null ? `taux SRU ${fmt(r.tauxSRU, 1)} %` : null,
      r.zone ? `zone ${r.zone}` : null,
      r.carencee ? 'commune carencée (SRU)' : (r.deficitaire ? 'commune déficitaire (SRU)' : null),
    ].filter(Boolean).join(', ');
    full.push(`- ${r.nom} (${r.arrondissement ? '75, arrondissement' : r.dep}) : ${parts || 'données non disponibles'}.${r.note ? ` Note : ${r.note}` : ''}`);
  }
}
const fullDir = (data, titre, urlPath) => {
  full.push('');
  full.push(`## DONNÉES — ${titre} (${data.records.length})`);
  full.push(`${data._meta.attribution}. Extraction du ${dateFrOf(data._meta.collectedAt)}. Annuaire complet : ${B}${urlPath}`);
  for (const r of data.records) {
    full.push(`- ${r.nom} — ${[r.adresse, [r.cp, r.commune].filter(Boolean).join(' ')].filter(Boolean).join(', ')} (${r.dep})${r.tel ? ` — ${r.tel}` : ''}`);
  }
};
if (CROUS) fullDir(CROUS, 'RÉSIDENCES CROUS', '/residences-crous/');
if (FJT) fullDir(FJT, 'FOYERS DE JEUNES TRAVAILLEURS (FJT)', '/foyers-jeunes-travailleurs/');
if (RES_AUTONOMIE) fullDir(RES_AUTONOMIE, 'RÉSIDENCES AUTONOMIE (SENIORS)', '/residences-autonomie/');
if (ENCADREMENT) {
  const majores = ENCADREMENT.records.map(r => r.refMajore);
  full.push('');
  full.push(`## DONNÉES — ENCADREMENT DES LOYERS À PARIS (références ${ENCADREMENT._meta.millesime})`);
  full.push(`${ENCADREMENT._meta.attribution}. ${ENCADREMENT.records.length} références officielles (80 quartiers × 1-4 pièces × 4 époques × meublé/non meublé). Plafonds légaux (loyer de référence majoré) : de ${fmt(Math.min(...majores), 2)} à ${fmt(Math.max(...majores), 2)} €/m² hors charges selon le profil du logement.`);
  full.push(`Vérificateur interactif : ${B}/guides/encadrement-des-loyers-paris/ · grille complète en JSON : ${B}/data/encadrement-loyers-paris.json`);
}
fs.writeFileSync(path.join(DIST, 'llms-full.txt'), full.join('\n') + '\n');

/* Assets statiques (og-image.png…) copiés tels quels */
const STATIC = path.join(ROOT, 'static');
if (fs.existsSync(STATIC)) {
  for (const f of fs.readdirSync(STATIC)) fs.copyFileSync(path.join(STATIC, f), path.join(DIST, f));
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url><loc>${SITE.baseUrl}${p.urlPath}</loc><lastmod>${DATE_ISO}</lastmod><priority>${p.priority}</priority></url>`).join('\n')}
</urlset>`;
fs.writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap);

fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE.baseUrl}/sitemap.xml\n\n# Index pour les moteurs IA : ${SITE.baseUrl}/llms.txt\n`);

console.log(`OK — ${pages.length} pages générées dans dist/ (+ sitemap.xml, robots.txt, style.css)`);
pages.forEach(p => console.log('  ' + p.urlPath));

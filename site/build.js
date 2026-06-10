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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

const THEMES = {
  'etudiant':        { c: PAL.bleu2,       bg: PAL.cielClair },
  'logement-social': { c: PAL.sauge,       bg: PAL.saugeClair },
  'mobilite':        { c: PAL.accentFonce, bg: '#fbeee9' },
};
const themeOf = (slug) => THEMES[slug] || { c: PAL.bleu, bg: PAL.cielClair };

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
  };
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${shapes[name] || shapes.annuaire}</svg>`;
}

/* Skyline parisienne du hero : façades haussmanniennes stylisées,
 * tour Eiffel en silhouette, soleil terracotta. */
function skyline() {
  const win = (x0, y0, cols, rows, fill, w = 8, h = 11, gx = 16, gy = 19) => {
    let s = '';
    for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++)
      s += `<rect x="${x0 + col * gx}" y="${y0 + r * gy}" width="${w}" height="${h}" rx="1.5" fill="${fill}"/>`;
    return s;
  };
  return `<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" class="illo-skyline">
  <circle cx="566" cy="54" r="26" fill="${PAL.accent}"/>
  <g fill="#fff" opacity=".9"><ellipse cx="120" cy="44" rx="34" ry="11"/><ellipse cx="148" cy="38" rx="22" ry="9"/><ellipse cx="448" cy="70" rx="30" ry="10"/></g>
  <g fill="${PAL.ciel}"><polygon points="92,28 98,28 122,238 68,238"/><rect x="70" y="118" width="50" height="7" rx="3"/><rect x="78" y="170" width="35" height="6" rx="3"/><rect x="91" y="14" width="8" height="18" rx="2"/></g>
  <g><rect x="150" y="104" width="92" height="134" fill="${PAL.bleu2}"/><polygon points="150,104 242,104 232,82 160,82" fill="${PAL.bleu}"/><rect x="168" y="70" width="7" height="16" fill="${PAL.bleu}"/>${win(162, 116, 5, 5, PAL.cielClair)}<rect x="188" y="206" width="18" height="32" rx="2" fill="${PAL.accent}"/></g>
  <g><rect x="256" y="64" width="106" height="174" fill="${PAL.bleuClair}"/><polygon points="256,64 362,64 350,40 268,40" fill="${PAL.bleu2}"/><rect x="282" y="28" width="7" height="16" fill="${PAL.bleu2}"/>${win(268, 76, 6, 7, PAL.blanc)}<rect x="296" y="210" width="20" height="28" rx="2" fill="${PAL.bleu}"/></g>
  <g><rect x="376" y="118" width="96" height="120" fill="#4a7fae"/><polygon points="376,118 472,118 462,96 386,96" fill="${PAL.bleu}"/>${win(388, 130, 5, 4, PAL.cielClair)}<rect x="408" y="206" width="18" height="32" rx="2" fill="${PAL.creme}"/></g>
  <g><rect x="486" y="92" width="88" height="146" fill="${PAL.bleu}"/><polygon points="486,92 574,92 564,70 496,70" fill="#163a5c"/><rect x="540" y="58" width="7" height="16" fill="#163a5c"/>${win(497, 104, 5, 5, PAL.ciel)}</g>
  <g><circle cx="606" cy="206" r="18" fill="${PAL.sauge}"/><rect x="603" y="216" width="6" height="22" rx="2" fill="#7a5c43"/></g>
  <g><circle cx="38" cy="212" r="14" fill="${PAL.sauge}"/><rect x="35.5" y="220" width="5" height="18" rx="2" fill="#7a5c43"/></g>
  <rect x="0" y="236" width="640" height="5" rx="2.5" fill="${PAL.ciel}"/>
</svg>`;
}

/* Icône d'un guide = thème de son premier parcours ; picto dédié par slug. */
const guideTheme = (g) => themeOf(g.parcours && g.parcours[0]);

const FAVICON = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${PAL.bleu}"/><path d="M16 7l10 8h-3v9h-5.2v-6h-3.6v6H9v-9H6z" fill="#fff"/><path d="M19.5 18h2.5v6h-2.5z" fill="${PAL.accent}"/></svg>`);

/* ----------------------------- Layout ------------------------------ */

function layout({ title, metaDescription, urlPath, h1: _h1, content, jsonLd = [] }) {
  const canonical = SITE.baseUrl + urlPath;
  const nav = PARCOURS.map(p => `<a href="/${p.slug}/">${esc(p.nav)}</a>`).join('');
  const ld = jsonLd.map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
  const footGuides = GUIDES.map(g => `<li><a href="/guides/${g.slug}/">${esc(g.h1)}</a></li>`).join('');
  const footParcours = PARCOURS.map(p => `<li><a href="/${p.slug}/">${esc(p.nav)}</a></li>`).join('');
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
<link rel="stylesheet" href="/style.css">
${ld}
</head>
<body>
<header class="site-header">
  <div class="container">
    <a class="brand" href="/">${esc(SITE.name)}<span class="brand-sub">Île-de-France</span></a>
    <nav class="main-nav">${nav}<a href="/annuaire/">Annuaire</a></nav>
  </div>
</header>
<main class="container">
${content}
</main>
<footer class="site-footer">
  <div class="container footer-grid">
    <div>
      <p class="footer-brand">${esc(SITE.name)}</p>
      <p>${esc(SITE.tagline)}. Un service d'orientation indépendant : nous vous guidons vers les dispositifs et les sources officielles, gratuitement.</p>
    </div>
    <div>
      <p class="footer-title">Parcours</p>
      <ul>${footParcours}<li><a href="/annuaire/">Annuaire des sources fiables</a></li></ul>
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
  <a class="card card-parcours" href="/${p.slug}/" style="--t:${t.c};--tbg:${t.bg}">
    <span class="card-icon">${icon(p.slug, t.c)}</span>
    <h3>${esc(p.nav)}</h3>
    <p>${esc(p.intro.split('. ')[0])}.</p>
    <span class="card-cta">Voir le parcours →</span>
  </a>`;
  }).join('');
  const guideCards = GUIDES.map(g => {
    const t = guideTheme(g);
    return `
  <a class="card card-guide" href="/guides/${g.slug}/" style="--t:${t.c};--tbg:${t.bg}">
    <span class="card-icon card-icon-sm">${icon(g.slug, t.c)}</span>
    <div><h3>${esc(g.h1)}</h3>
    <p>${esc(g.metaDescription.split('. ')[0])}.</p></div>
  </a>`;
  }).join('');
  const content = `
<section class="hero">
  <div class="hero-text">
    <h1>Le logement en Île-de-France, enfin dans le bon ordre.</h1>
    <p class="lead">Étudiant, demandeur de logement social, senior, salarié en mobilité&nbsp;: chaque profil a ses dispositifs, ses aides et ses guichets — souvent méconnus. ${esc(SITE.name)} vous oriente, gratuitement, vers les bonnes démarches et les sources officielles.</p>
    <p class="hero-actions"><a class="btn" href="#parcours">Trouver mon parcours</a><a class="btn btn-ghost" href="/annuaire/">Voir les sources fiables</a></p>
  </div>
  <div class="hero-illo">${skyline()}</div>
</section>
<section id="parcours">
  <h2>Quelle est votre situation&nbsp;?</h2>
  <div class="grid">${cards}</div>
</section>
<section>
  <h2>Les guides essentiels</h2>
  <div class="grid grid-guides">${guideCards}</div>
</section>
<section class="notice">
  <h2>Pourquoi ce site&nbsp;?</h2>
  <p>Le logement francilien est éclaté entre des dizaines de plateformes, de guichets et de dispositifs. Résultat&nbsp;: des droits non utilisés (Visale, Loca-Pass, logement intermédiaire…) et des parcours subis. Nous remettons de l'ordre&nbsp;: pas d'annonces dupliquées, pas de fausses promesses — des parcours clairs et des liens directs vers les sources qui font foi.</p>
</section>`;
  addPage('/', layout({
    title: `${SITE.name} — ${SITE.tagline}`,
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
  <ul class="sources">${c.sources.map(s => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.nom)}</a> — ${esc(s.desc)}</li>`).join('')}</ul>`).join('');
  const t = themeOf(p.slug);
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › ${esc(p.nav)}</nav>
<header class="page-head" style="--t:${t.c};--tbg:${t.bg}">
  <span class="page-head-icon">${icon(p.slug, t.c)}</span>
  <div>
    <h1>${esc(p.h1)}</h1>
    <p class="lead">${esc(p.intro)}</p>
  </div>
</header>
<div class="steps" style="--t:${t.c};--tbg:${t.bg}">
${etapes}
</div>
<section class="notice">
  <h2>Où chercher&nbsp;: les sources fiables pour ce profil</h2>
  ${annuaireBlock}
  <p><a href="/annuaire/">Voir l'annuaire complet →</a></p>
</section>`;
  addPage(`/${p.slug}/`, layout({
    title: p.title,
    metaDescription: p.metaDescription,
    urlPath: `/${p.slug}/`,
    content
  }), '0.9');
}

/* Guides */
for (const g of GUIDES) {
  const sections = g.sections.map(s => {
    let html = `<h2>${esc(s.h2)}</h2>`;
    if (s.paragraphs) html += s.paragraphs.map(t => `<p>${esc(t)}</p>`).join('');
    if (s.bullets) html += `<ul>${s.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`;
    return html;
  }).join('');
  const faqHtml = g.faq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('');
  const srcHtml = g.sourcesOfficielles.map(s => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.label)}</a></li>`).join('');
  const related = PARCOURS.filter(p => g.parcours.includes(p.slug))
    .map(p => `<a class="pill" href="/${p.slug}/">${esc(p.nav)}</a>`).join(' ');
  const t = guideTheme(g);
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › Guides › ${esc(g.h1)}</nav>
<article>
<header class="page-head" style="--t:${t.c};--tbg:${t.bg}">
  <span class="page-head-icon">${icon(g.slug, t.c)}</span>
  <div>
    <h1>${esc(g.h1)}</h1>
    <p class="lead">${esc(g.intro)}</p>
  </div>
</header>
${sections}
<section class="faq"><h2>Questions fréquentes</h2>${faqHtml}</section>
<section class="notice"><h2>Sources officielles</h2><ul class="sources">${srcHtml}</ul></section>
<p class="pills"><strong>Parcours liés&nbsp;:</strong> ${related}</p>
</article>`;
  addPage(`/guides/${g.slug}/`, layout({
    title: g.title,
    metaDescription: g.metaDescription,
    urlPath: `/guides/${g.slug}/`,
    content,
    jsonLd: [{
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

/* Annuaire */
(function buildAnnuaire() {
  const cats = ANNUAIRE.categories.map(c => `
  <section id="${c.id}">
    <h2>${esc(c.titre)}</h2>
    <ul class="sources">${c.sources.map(s => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.nom)}</a> — ${esc(s.desc)}</li>`).join('')}</ul>
  </section>`).join('');
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › Annuaire</nav>
<header class="page-head" style="--t:${PAL.bleu2};--tbg:${PAL.cielClair}">
  <span class="page-head-icon">${icon('annuaire', PAL.bleu2)}</span>
  <div>
    <h1>${esc(ANNUAIRE.h1)}</h1>
    <p class="lead">${esc(ANNUAIRE.intro)}</p>
  </div>
</header>
${cats}`;
  addPage('/annuaire/', layout({
    title: ANNUAIRE.title,
    metaDescription: ANNUAIRE.metaDescription,
    urlPath: '/annuaire/',
    content
  }), '0.9');
})();

/* Mentions légales */
(function buildMentions() {
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › Mentions légales</nav>
<h1>Mentions légales</h1>
<p><strong>Éditeur du site</strong> — MKZ, société par actions simplifiée (SAS) au capital social de 1 000 €, dont le siège social est situé 1 rue Françoise Sagan, 77230 Dammartin-en-Goële. SIRET : 983 662 784 00013 · TVA intracommunautaire : FR44983662784.</p>
<p><strong>Directeur de la publication</strong> — Mickaël Leclerc, représentant légal.</p>
<p><strong>Contact</strong> — <a href="mailto:contact@mkz-consulting.fr">contact@mkz-consulting.fr</a></p>
<p><strong>Hébergement</strong> — Cloudflare Pages, Cloudflare Inc., 101 Townsend St, San Francisco, CA 94107, États-Unis.</p>
<p><strong>Données personnelles</strong> — Ce site ne collecte aucune donnée personnelle et ne dépose aucun cookie de suivi sans consentement.</p>
<p><strong>Nature du service</strong> — ${esc(SITE.name)} est un service d'information et d'orientation. Les candidatures et démarches s'effectuent exclusivement sur les sites officiels et plateformes tierces vers lesquels nous renvoyons ; nous ne sommes ni bailleur, ni agent immobilier, ni intermédiaire de transaction.</p>`;
  addPage('/mentions-legales/', layout({
    title: `Mentions légales — ${SITE.name}`,
    metaDescription: `Mentions légales du site ${SITE.name}.`,
    urlPath: '/mentions-legales/',
    content
  }), '0.1');
})();

/* ------------------------------ CSS --------------------------------- */

const CSS = `:root{--bleu:${PAL.bleu};--bleu2:${PAL.bleu2};--accent:${PAL.accent};--accent2:${PAL.accentFonce};--encre:${PAL.encre};--gris:#5b6770;--fond:#ffffff;--fond2:#f2f6fa;--ciel:${PAL.cielClair};--creme:${PAL.creme};--bord:#dde5ec}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--encre);background:var(--fond);line-height:1.65}
.container{max-width:980px;margin:0 auto;padding:0 20px}
a{color:var(--bleu2)}h1,h2,h3{line-height:1.25;color:var(--bleu)}
h1{font-size:clamp(1.7rem,3.6vw,2.4rem);letter-spacing:-.015em}h2{font-size:1.4rem;margin-top:2.4rem}
.lead{font-size:1.13rem;color:var(--gris)}
/* ---- Header ---- */
.site-header{background:linear-gradient(135deg,#163a5c,var(--bleu) 60%,#26619a);padding:16px 0;box-shadow:inset 0 -3px 0 var(--accent)}
.site-header .container{display:flex;flex-wrap:wrap;gap:10px 24px;align-items:center;justify-content:space-between}
.brand{color:#fff;font-weight:700;font-size:1.18rem;text-decoration:none}.brand-sub{display:block;font-size:.68rem;font-weight:500;opacity:.75;letter-spacing:.14em;text-transform:uppercase}
.main-nav{display:flex;flex-wrap:wrap;gap:4px 6px}
.main-nav a{color:#fff;text-decoration:none;font-size:.93rem;opacity:.92;padding:6px 12px;border-radius:8px;transition:background .15s}
.main-nav a:hover{background:rgba(255,255,255,.14);opacity:1}
/* ---- Hero ---- */
.hero{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:24px 36px;align-items:end;background:linear-gradient(180deg,var(--ciel),#fff 130%);border-radius:20px;padding:34px 38px 26px;margin:1.6rem 0 .6rem}
.hero h1{margin:.2rem 0 .8rem}
.hero-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:1.4rem}
.hero-illo svg{display:block;width:100%;max-width:330px;height:auto;margin:0 0 .2rem auto}
.btn{display:inline-block;background:var(--accent2);color:#fff;font-weight:600;text-decoration:none;padding:11px 22px;border-radius:10px;font-size:.97rem;transition:background .15s,transform .15s}
.btn:hover{background:#a8492f;transform:translateY(-1px)}
.btn-ghost{background:transparent;color:var(--bleu);box-shadow:inset 0 0 0 2px var(--bleu2)}
.btn-ghost:hover{background:var(--ciel);transform:translateY(-1px)}
/* ---- Cartes ---- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:18px;margin:1.2rem 0 2.2rem}
.card{display:block;border:1px solid var(--bord);border-radius:16px;padding:22px;text-decoration:none;color:inherit;background:var(--fond);transition:box-shadow .18s,transform .18s,border-color .18s;position:relative;overflow:hidden}
.card:hover{box-shadow:0 10px 28px rgba(31,78,121,.14);transform:translateY(-3px);border-color:var(--t,var(--bleu2))}
.card h3{margin:0 0 .5rem;font-size:1.06rem}.card p{margin:0;color:var(--gris);font-size:.92rem}
.card-parcours::before{content:"";position:absolute;inset:0 0 auto 0;height:5px;background:var(--t,var(--bleu2))}
.card-icon{display:inline-flex;width:42px;height:42px;border-radius:11px;background:var(--tbg,var(--ciel));padding:8px;margin-bottom:10px}
.card-icon svg{width:100%;height:100%}
.card-cta{display:inline-block;margin-top:.9rem;color:var(--t,var(--bleu2));font-weight:650;font-size:.9rem}
.grid-guides{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.card-guide{display:flex;gap:14px;align-items:flex-start}
.card-icon-sm{flex:none;width:36px;height:36px;border-radius:10px;padding:7px;margin:2px 0 0}
/* ---- Têtes de page illustrées ---- */
.page-head{display:flex;gap:18px;align-items:flex-start;background:linear-gradient(135deg,var(--tbg,var(--ciel)),#fff 125%);border:1px solid var(--bord);border-left:6px solid var(--t,var(--bleu2));border-radius:18px;padding:22px 26px;margin:0 0 1.8rem}
.page-head-icon{flex:none;width:46px;height:46px;background:#fff;border-radius:12px;padding:9px;box-shadow:0 3px 10px rgba(31,78,121,.12);margin-top:4px}
.page-head-icon svg{width:100%;height:100%}
.page-head h1{margin:.1rem 0 .5rem}.page-head .lead{margin:0}
/* ---- Étapes numérotées ---- */
.steps{counter-reset:etape}
.step{position:relative;border:1px solid var(--bord);border-radius:14px;padding:18px 22px 16px 64px;margin:1.2rem 0;counter-increment:etape;background:var(--fond)}
.step::before{content:counter(etape);position:absolute;left:18px;top:20px;width:30px;height:30px;border-radius:50%;background:var(--t,var(--bleu2));color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:.95rem}
.step h2{margin:.1rem 0 .5rem;font-size:1.2rem}
/* ---- Divers ---- */
.notice{background:var(--creme);border:1px solid #efe5d6;border-radius:16px;padding:8px 24px 20px;margin:2.2rem 0}
.pills{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pill{display:inline-block;background:var(--fond);border:1px solid var(--bord);border-radius:999px;padding:6px 15px;font-size:.85rem;text-decoration:none;transition:border-color .15s,background .15s}
.pill:hover{border-color:var(--bleu2);background:var(--ciel)}
.sources{padding-left:1.1rem}.sources li{margin:.5rem 0}
.breadcrumb{font-size:.85rem;color:var(--gris);margin:1.3rem 0 1rem}.breadcrumb a{color:var(--gris)}
.faq details{border:1px solid var(--bord);border-radius:12px;padding:12px 18px;margin:.7rem 0;background:var(--fond);transition:border-color .15s}
.faq details[open]{border-color:var(--bleu2);background:var(--ciel)}
.faq summary{cursor:pointer;font-weight:600;color:var(--bleu)}
/* ---- Footer ---- */
.site-footer{background:var(--encre);color:#cdd6de;margin-top:3.5rem;padding:2.4rem 0 1rem;font-size:.88rem;border-top:4px solid var(--accent)}
.footer-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:24px}
.footer-brand{color:#fff;font-weight:700;font-size:1.05rem}.footer-title{color:#fff;font-weight:600}
.site-footer ul{list-style:none;padding:0;margin:0}.site-footer li{margin:.38rem 0}.site-footer a{color:#9fc1e0;text-decoration:none}.site-footer a:hover{text-decoration:underline;color:#cfe3f4}
.footer-legal{border-top:1px solid #33414e;margin-top:1.6rem;padding-top:1rem;color:#8a98a5}
/* ---- Responsive ---- */
@media(max-width:760px){
.hero{grid-template-columns:1fr;padding:24px 22px 20px;gap:8px}
.hero-illo{margin-top:.6rem}
.page-head{flex-direction:column;gap:12px;padding:20px}
.step{padding-left:58px}
}`;

/* --------------------------- Écriture ------------------------------- */

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const { urlPath, html } of pages) {
  const dir = path.join(DIST, ...urlPath.split('/').filter(Boolean));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
}

fs.writeFileSync(path.join(DIST, 'style.css'), CSS);

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url><loc>${SITE.baseUrl}${p.urlPath}</loc><priority>${p.priority}</priority></url>`).join('\n')}
</urlset>`;
fs.writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap);

fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE.baseUrl}/sitemap.xml\n`);

console.log(`OK — ${pages.length} pages générées dans dist/ (+ sitemap.xml, robots.txt, style.css)`);
pages.forEach(p => console.log('  ' + p.urlPath));

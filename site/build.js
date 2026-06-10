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
  const cards = PARCOURS.map(p => `
  <a class="card" href="/${p.slug}/">
    <h3>${esc(p.nav)}</h3>
    <p>${esc(p.intro.split('. ')[0])}.</p>
    <span class="card-cta">Voir le parcours →</span>
  </a>`).join('');
  const guideCards = GUIDES.map(g => `
  <a class="card card-guide" href="/guides/${g.slug}/">
    <h3>${esc(g.h1)}</h3>
    <p>${esc(g.metaDescription.split('. ')[0])}.</p>
  </a>`).join('');
  const content = `
<section class="hero">
  <h1>Le logement en Île-de-France, enfin dans le bon ordre.</h1>
  <p class="lead">Étudiant, demandeur de logement social, senior, salarié en mobilité&nbsp;: chaque profil a ses dispositifs, ses aides et ses guichets — souvent méconnus. ${esc(SITE.name)} vous oriente, gratuitement, vers les bonnes démarches et les sources officielles.</p>
</section>
<section>
  <h2>Quelle est votre situation&nbsp;?</h2>
  <div class="grid">${cards}</div>
</section>
<section>
  <h2>Les guides essentiels</h2>
  <div class="grid">${guideCards}</div>
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
    return `<div class="step"><h2>${esc(e.titre)}</h2><p>${esc(e.texte)}</p>${links ? `<p class="pills">${links}</p>` : ''}</div>`;
  }).join('');
  const cats = ANNUAIRE.categories.filter(c => p.annuaireCategories.includes(c.id));
  const annuaireBlock = cats.map(c => `
  <h3>${esc(c.titre)}</h3>
  <ul class="sources">${c.sources.map(s => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.nom)}</a> — ${esc(s.desc)}</li>`).join('')}</ul>`).join('');
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › ${esc(p.nav)}</nav>
<h1>${esc(p.h1)}</h1>
<p class="lead">${esc(p.intro)}</p>
${etapes}
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
  const content = `
<nav class="breadcrumb"><a href="/">Accueil</a> › Guides › ${esc(g.h1)}</nav>
<article>
<h1>${esc(g.h1)}</h1>
<p class="lead">${esc(g.intro)}</p>
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
<h1>${esc(ANNUAIRE.h1)}</h1>
<p class="lead">${esc(ANNUAIRE.intro)}</p>
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

const CSS = `:root{--bleu:#1f4e79;--bleu2:#2e74b5;--encre:#1c2733;--gris:#5b6770;--fond:#ffffff;--fond2:#f2f6fa;--bord:#dde5ec}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--encre);background:var(--fond);line-height:1.65}
.container{max-width:960px;margin:0 auto;padding:0 20px}
a{color:var(--bleu2)}h1,h2,h3{line-height:1.25;color:var(--bleu)}h1{font-size:1.9rem}h2{font-size:1.35rem;margin-top:2rem}
.lead{font-size:1.1rem;color:var(--gris)}
.site-header{background:var(--bleu);padding:14px 0}.site-header .container{display:flex;flex-wrap:wrap;gap:10px 24px;align-items:center;justify-content:space-between}
.brand{color:#fff;font-weight:700;font-size:1.15rem;text-decoration:none}.brand-sub{display:block;font-size:.7rem;font-weight:400;opacity:.8;letter-spacing:.08em;text-transform:uppercase}
.main-nav{display:flex;flex-wrap:wrap;gap:4px 18px}.main-nav a{color:#fff;text-decoration:none;font-size:.95rem;opacity:.92}.main-nav a:hover{text-decoration:underline;opacity:1}
.hero{padding:2.2rem 0 .6rem}.hero h1{font-size:2.1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px;margin:1rem 0 2rem}
.card{display:block;border:1px solid var(--bord);border-radius:10px;padding:18px;text-decoration:none;color:inherit;background:var(--fond);transition:box-shadow .15s}
.card:hover{box-shadow:0 4px 16px rgba(31,78,121,.12)}.card h3{margin:0 0 .5rem;font-size:1.05rem}.card p{margin:0;color:var(--gris);font-size:.92rem}
.card-cta{display:inline-block;margin-top:.7rem;color:var(--bleu2);font-weight:600;font-size:.9rem}
.notice{background:var(--fond2);border:1px solid var(--bord);border-radius:10px;padding:6px 22px 18px;margin:2rem 0}
.step{border-left:4px solid var(--bleu2);padding:2px 0 2px 18px;margin:1.6rem 0}.step h2{margin-top:.4rem}
.pills{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.pill{display:inline-block;background:var(--fond2);border:1px solid var(--bord);border-radius:999px;padding:5px 14px;font-size:.85rem;text-decoration:none}
.sources{padding-left:1.1rem}.sources li{margin:.45rem 0}
.breadcrumb{font-size:.85rem;color:var(--gris);margin:1.2rem 0}.breadcrumb a{color:var(--gris)}
.faq details{border:1px solid var(--bord);border-radius:8px;padding:10px 16px;margin:.6rem 0;background:var(--fond)}
.faq summary{cursor:pointer;font-weight:600;color:var(--bleu)}
.site-footer{background:var(--encre);color:#cdd6de;margin-top:3rem;padding:2.2rem 0 1rem;font-size:.88rem}
.footer-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:24px}
.footer-brand{color:#fff;font-weight:700;font-size:1.05rem}.footer-title{color:#fff;font-weight:600}
.site-footer ul{list-style:none;padding:0;margin:0}.site-footer li{margin:.35rem 0}.site-footer a{color:#9fc1e0;text-decoration:none}.site-footer a:hover{text-decoration:underline}
.footer-legal{border-top:1px solid #33414e;margin-top:1.6rem;padding-top:1rem;color:#8a98a5}
@media(max-width:640px){h1{font-size:1.5rem}.hero h1{font-size:1.6rem}}`;

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

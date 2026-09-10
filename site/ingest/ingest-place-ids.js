#!/usr/bin/env node
/**
 * ingest-place-ids.js : fiche Google Maps (place_id) de chaque résidence des annuaires.
 * ------------------------------------------------------------------
 * Exécution   : node ingest-place-ids.js [--echantillon] [--limite=N] [--concurrence=N] [--force]
 * Runtime     : Node.js >= 14 · Dépendances : AUCUNE
 * Identifiants: variables d'environnement DATAFORSEO_USERNAME et DATAFORSEO_PASSWORD
 *               (jamais en clair, jamais affichées).
 * Source      : Google Maps, lu par la SERP en direct de DataForSEO
 *               (POST /v3/serp/google/maps/live/advanced), 0,002 USD par appel,
 *               un ou deux appels par résidence (le second seulement si le premier
 *               ne donne aucune fiche acceptée).
 * Entrées     : site/data/open/crous-residences.json, fjt.json, residences-autonomie.json
 * Sortie      : site/data/place-ids.json : TOUTES les résidences, chacune avec son
 *               verdict (accepte, a_verifier, aucun), la fiche retenue et les mesures
 *               qui ont fondé le verdict. Seul un verdict « accepte » est utilisé par
 *               build.js ; les autres restent en lecture pour une revue humaine.
 * Cache       : site/ingest/.cache/place-ids/ (gitignoré), une réponse par appel.
 * ⚠️ HORS de ingest.js : une exécution complète coûte de l'ordre de 1,5 à 3 USD
 *    (728 résidences). Relancer à la demande, pas à chaque ingestion.
 * ------------------------------------------------------------------
 *
 * Pourquoi ce script (10/09/2026) : le lien « voir sur Google Maps » des annuaires
 * porte l'adresse en requête, seule forme mesurée juste à tous les coups. Mickaël veut
 * que la fiche s'ouvre par son NOM ; or une requête par nom fait basculer Google en
 * recherche par catégorie dès qu'aucune fiche ne correspond, et envoie vers un autre
 * établissement (3 cas sur 9). La seule voie sûre est le paramètre query_place_id du
 * format « Maps URLs », qui ouvre exactement la fiche identifiée, la requête (l'adresse)
 * ne servant que de repli si l'identifiant disparaît. D'où cet appariement vérifié,
 * résidence par résidence, sur trois mesures : distance entre la fiche et les
 * coordonnées de la source officielle, concordance de l'adresse (numéro et voie),
 * concordance du nom (ou catégorie d'hébergement). Un appariement douteux ne vaut
 * rien : il est classé « a_verifier » et n'est jamais publié tel quel.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DATA_OPEN = path.join(ROOT, 'data', 'open');
const SORTIE = path.join(ROOT, 'data', 'place-ids.json');
const CACHE = path.join(__dirname, '.cache', 'place-ids');

const ARGS = process.argv.slice(2);
const opt = (n) => { const a = ARGS.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const FORCE = ARGS.includes('--force');
const ECHANTILLON = ARGS.includes('--echantillon');
const LIMITE = opt('limite') ? Number(opt('limite')) : null;
if (opt('limite') && !(LIMITE > 0)) { console.error('--limite doit être un entier positif'); process.exit(2); }

/* Seuils du verdict, écrits dans la sortie pour que build.js et un relecteur
   humain jugent sur les mêmes règles. */
const SEUILS = {
  distanceAccepteM: 150,   // fiche à moins de 150 m des coordonnées de la source officielle
  distanceProcheM: 75,     // quand seul le nom entier concorde (adresse source inexploitable)
  distanceMaxAccepteM: 300, // borne absolue d'une acceptation (nom retrouvé dans l'adresse de la fiche, site étendu) ; build.js la relit
  distanceVerifierM: 300,  // au-delà, aucune fiche n'est proposée, même homonyme
  similariteNom: 0.34,     // part des mots significatifs du nom retrouvés dans le titre Google
  similariteNomSeule: 0.5, // exigée quand l'adresse ne concorde pas au numéro près
};

const USER = process.env.DATAFORSEO_USERNAME;
const PASS = process.env.DATAFORSEO_PASSWORD;
if (!USER || !PASS) { console.error('DATAFORSEO_USERNAME et DATAFORSEO_PASSWORD doivent être posées dans l\'environnement.'); process.exit(2); }
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

/* ---------- appels API ---------- */

function post(apiPath, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'api.dataforseo.com', path: apiPath, method: 'POST', headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, timeout: 60000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`réponse non JSON (HTTP ${res.statusCode}) : ${buf.slice(0, 160)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const dodo = (ms) => new Promise((r) => setTimeout(r, ms));

let COUT = 0, APPELS = 0, DEPUIS_CACHE = 0;

/** Une recherche Google Maps en direct, mise en cache. Rend les fiches (items maps_search). */
async function chercherMaps(cle, keyword, lat, lon) {
  fs.mkdirSync(CACHE, { recursive: true });
  const fichier = path.join(CACHE, cle + '.json');
  if (!FORCE && fs.existsSync(fichier)) {
    // Une passe interrompue peut laisser un fichier tronqué : on le refait plutôt que d'échouer.
    try { const j = JSON.parse(fs.readFileSync(fichier, 'utf8')); if (Array.isArray(j.fiches)) { DEPUIS_CACHE++; return j; } } catch (e) { /* refait ci-dessous */ }
    fs.unlinkSync(fichier);
  }
  const body = [{ keyword, location_coordinate: `${lat.toFixed(7)},${lon.toFixed(7)},15z`, language_code: 'fr', depth: 10 }];
  let derniere;
  for (let essai = 1; essai <= 3; essai++) {
    try {
      const j = await post('/v3/serp/google/maps/live/advanced', body);
      const t = j.tasks && j.tasks[0];
      // 40102 « No Search Results » est une réponse, pas une panne : Google Maps n'a rien
      // trouvé pour cette requête, on l'enregistre comme zéro fiche (payé 14 abandons le 10/09/2026).
      const vide = t && t.status_code === 40102;
      if (!t || (t.status_code !== 20000 && !vide)) throw new Error(`statut ${t ? t.status_code + ' ' + t.status_message : j.status_code + ' ' + j.status_message}`);
      COUT += Number(j.cost) || 0; APPELS++;
      const items = vide ? [] : ((t.result && t.result[0] && t.result[0].items) || []).filter((it) => it.type === 'maps_search');
      const compact = items.map((it) => ({
        titre: it.title, categorie: it.category || null, adresse: it.address || null,
        lat: it.latitude, lon: it.longitude, placeId: it.place_id || null, cid: it.cid || null,
        note: it.rating ? it.rating.value : null, avis: it.rating ? it.rating.votes_count : null,
      }));
      fs.writeFileSync(fichier, JSON.stringify({ keyword, collectedAt: new Date().toISOString(), cout: j.cost, fiches: compact }, null, 1));
      return { keyword, fiches: compact };
    } catch (e) {
      derniere = e;
      await dodo(1500 * essai);
    }
  }
  throw new Error(`${cle} : ${derniere.message}`);
}

/* ---------- normalisation et concordance ---------- */

// Plage des diacritiques combinants construite par code (un littéral y est invisible
// et se perd à l'édition, une séquence d'échappement ne survit pas aux outils d'écriture).
const DIACRITIQUES = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
const normaliser = (s) => String(s || '').normalize('NFD').replace(DIACRITIQUES, '').toLowerCase().replace(/[’']/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

const STOP_NOM = new Set(['residence', 'residences', 'res', 'rs', 'fjt', 'foyer', 'foyers', 'jeunes', 'jeune', 'travailleurs', 'travailleur', 'travailleuses', 'autonomie', 'crous', 'la', 'le', 'les', 'de', 'du', 'des', 'd', 'l', 'et', 'a', 'au', 'aux', 'en', 'pour', 'personnes', 'agees', 'maison', 'cite', 'universitaire', 'etudiante', 'etudiant', 'etudiants', 'logement', 'logements', 'habitat', 'centre', 'saint', 'sainte', 'st', 'ste', 'paris', 'sur', 'sous', 'ville', 'hlm', 'sociale', 'social', 'jeunesse', 'accueil', 'hebergement', 'seniors', 'senior', 'retraite', 'unite', 'services', 'service', 'bat', 'batiment', 'annexe', 'site']);
const STOP_VOIE = new Set(['rue', 'r', 'avenue', 'av', 'ave', 'boulevard', 'bd', 'bvd', 'allee', 'all', 'square', 'sq', 'place', 'pl', 'chemin', 'ch', 'impasse', 'imp', 'route', 'rte', 'quai', 'cours', 'passage', 'voie', 'cite', 'villa', 'sente', 'promenade', 'esplanade', 'mail', 'rond', 'point', 'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'bis', 'ter', 'a', 'b', 'au', 'aux', 'general', 'gal', 'marechal', 'mal', 'docteur', 'dr', 'president', 'pdt', 'saint', 'sainte', 'st', 'ste', 'paris']);

const motsNom = (s) => normaliser(s).split(' ').filter((m) => m.length > 1 && !STOP_NOM.has(m) && !STOP_VOIE.has(m) && !/^\d+$/.test(m));

/** Numéro et mots de voie d'une adresse (la partie avant le code postal). */
function decomposerAdresse(adresse) {
  const brut = normaliser(adresse);
  const avantCp = brut.replace(/\b(7[58]|77|9[12345])\s?\d{3}\b.*$/, '').trim();
  const num = (/^\D*?(\d{1,4})\s*(bis|ter|[a-d])?\b/.exec(avantCp) || [])[1] || null;
  const mots = avantCp.split(' ').filter((m) => m.length > 2 && !STOP_VOIE.has(m) && !/^\d+$/.test(m));
  return { num, mots };
}

const distanceM = (a, b, c, d) => {
  const R = 6371000, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
};

/* Catégories Google (en français) qui désignent un hébergement. Une fiche d'une autre
   catégorie n'est acceptée que si son nom concorde ET son adresse au numéro près. */
const RE_CAT_HEBERGEMENT = /hebergement|residence|foyer|logement|retraite|personnes agees|etudiant|universitaire|senior|ehpad|maison de repos|centre d accueil|habitat|appartement|auberge de jeunesse|internat|pension|domicile/;
/* Sans aucun mot commun dans le nom, seule une catégorie RÉSIDENTIELLE suffit : un « centre
   d'accueil » ou une association à la même adresse est le gestionnaire ou un autre service,
   pas la résidence (relu le 10/09/2026 : un CCAS classé « centre d'accueil pour sans-abris »). */
const RE_CAT_RESIDENTIELLE = /residence|retraite|personnes agees|etudiant|universitaire|foyer|hebergement|logement|appartement|senior|pension|internat/;
/* Titres qui désignent un autre établissement hébergé dans la résidence ou voisin : le club
   senior, le restaurant solidaire ou la bibliothèque logés dans une résidence autonomie de
   la Ville de Paris partagent son adresse et souvent son nom (relu le 10/09/2026 : 4 clubs,
   2 restaurants, 1 bibliothèque acceptés à tort par la seule concordance du nom). Jamais
   « parc », « jardin » ni « square », qui nomment des résidences. */
const RE_TITRE_AUTRE = /\b(club|bibliotheque|mediatheque|restaurant|cafe|bar|brasserie|ecole|college|lycee|gymnase|piscine|stade|mairie|eglise|paroisse|pharmacie|cabinet|medecin|docteur|dentiste|kine|coiffeur|boulangerie|supermarche|parking|theatre|cinema|musee|creche|garderie|ehpad|hotel|hostel)\b/;
/* Catégories qui ne peuvent pas être une résidence (relu le 10/09/2026 : une SCULPTURE
   homonyme acceptée à l'adresse d'une résidence autonomie du Marais). Une fiche ainsi
   classée n'est acceptée que si son titre porte lui-même un mot d'hébergement ou le nom
   d'un gestionnaire connu (« FJT Frédéric Ozanam » classé « Magasin » reste juste). */
const RE_CAT_AUTRE = /sculpture|monument|statue|oeuvre|site historique|attraction|touristique|restaurant|cafe|bar|bibliotheque|club|ecole|gymnase|piscine|pharmacie|medecin|dentiste|parking|magasin|boutique|supermarche|coiffeur|banque|assurance|agence immobiliere|avocat|notaire|eglise|paroisse|salon|garage/;
const RE_TITRE_HEBERGEMENT = /\b(fjt|foyer|residence|residences|crous|logement|logements|habitat|marpa|cljt|aljt|residentiel|pension|retraite|casvp|arpavie|agefo|apui|coallia|adoma|urhaj|habitat jeunes|seniors?)\b/;

/** Juge une fiche Google contre une résidence de la source. */
function juger(res, fiche) {
  if (!fiche.placeId || fiche.lat == null || fiche.lon == null) return null;
  const d = distanceM(res.lat, res.lon, fiche.lat, fiche.lon);
  const aRes = decomposerAdresse(res.adresse), aG = decomposerAdresse(fiche.adresse || '');
  // Un mot que le nom de la résidence partage avec sa propre voie (« Résidence Lhomond »
  // rue Lhomond) ne prouve rien sur le titre Google : tout voisin de la rue le porte aussi.
  const nomRes = motsNom(res.nom).filter((m) => !aRes.mots.includes(m)), nomG = new Set(motsNom(fiche.titre));
  const communs = nomRes.filter((m) => nomG.has(m));
  const similarite = nomRes.length ? Math.round((communs.length / nomRes.length) * 100) / 100 : 0;
  const distinctif = communs.some((m) => m.length >= 5);
  const voieCommune = aRes.mots.some((m) => aG.mots.includes(m));
  const adresseForte = Boolean(aRes.num && aG.num && aRes.num === aG.num && voieCommune);
  const catNorm = normaliser(fiche.categorie);
  const catHebergement = RE_CAT_HEBERGEMENT.test(catNorm);
  const catResidentielle = RE_CAT_RESIDENTIELLE.test(catNorm);
  const nomOk = similarite >= SEUILS.similariteNom || distinctif;
  // Un titre de club, de restaurant, de bibliothèque, d'EHPAD ou d'hôtel désigne un autre
  // établissement, hébergé dans la résidence ou voisin, même à la même adresse et même
  // homonyme : à relire, jamais publié seul.
  const titreNorm = normaliser(fiche.titre);
  const titreHebergement = RE_TITRE_HEBERGEMENT.test(titreNorm);
  const titreAutreEtablissement = RE_TITRE_AUTRE.test(titreNorm) || (RE_CAT_AUTRE.test(catNorm) && !titreHebergement);
  // Sans mot commun, un titre d'un seul mot sans marqueur d'hébergement (« Maison ») ne
  // désigne rien de vérifiable : la catégorie seule ne suffit pas.
  // ... sauf si ce mot unique est celui de notre voie ou de notre nom : « Fournières »,
  // résidence de la rue des Fournières, est bien nommée par sa rue (relu le 10/09/2026).
  const motsTitre = titreNorm.split(' ').filter(Boolean);
  const titreTropGenerique = !nomOk && motsTitre.length < 2 && !titreHebergement && !(motsTitre[0] && (aRes.mots.includes(motsTitre[0]) || normaliser(res.nom).split(' ').includes(motsTitre[0])));
  // Le nom entier de la résidence, mot distinctif compris, retrouvé dans le titre ou dans la
  // ligne d'adresse de la fiche (Google y écrit le nom du lieu sur un campus ou un parc :
  // « Résidence la Boissière, Parc la Boissière, D449 »).
  const nomEntier = nomRes.length > 0 && similarite >= 1 && distinctif;
  const motsAdresseG = new Set(normaliser(fiche.adresse).split(' '));
  const nomDansAdresse = nomRes.length > 0 && nomRes.filter((m) => m.length >= 5 && motsAdresseG.has(m)).length >= Math.max(1, Math.ceil(nomRes.length / 2));
  let verdict = 'aucun', motif = '';
  if (d <= SEUILS.distanceAccepteM && adresseForte && (nomOk || catResidentielle) && !titreAutreEtablissement && !titreTropGenerique) {
    verdict = 'accepte'; motif = `adresse au numéro près, ${nomOk ? 'nom concordant' : 'catégorie résidentielle'}, ${d} m`;
  } else if (d <= SEUILS.distanceAccepteM && voieCommune && catHebergement && (similarite >= SEUILS.similariteNomSeule || distinctif) && !titreAutreEtablissement) {
    // Sans le numéro (adresse sans numéro dans la source, ou immeuble d'angle), la même
    // voie reste exigée : un homonyme dans une autre rue est un autre établissement
    // (relu le 10/09/2026 : une résidence privée et un EHPAD homonymes à 130 et 149 m).
    verdict = 'accepte'; motif = `nom concordant, catégorie d'hébergement, même voie, ${d} m`;
  } else if (d <= SEUILS.distanceProcheM && nomEntier && catResidentielle && !titreAutreEtablissement) {
    // Adresse source inexploitable (« Domaine de l'Université, Bâtiment 470, Aile C ») : le nom
    // ENTIER dans le titre, une catégorie résidentielle et moins de 75 m suffisent (relu le
    // 10/09/2026 : la résidence CROUS Georges Charpak à 43 m, écartée faute de voie commune).
    verdict = 'accepte'; motif = `nom entier concordant, catégorie résidentielle, ${d} m`;
  } else if (d <= SEUILS.distanceMaxAccepteM && nomDansAdresse && catResidentielle && !titreAutreEtablissement) {
    verdict = 'accepte'; motif = `nom retrouvé dans l'adresse de la fiche, catégorie résidentielle, ${d} m`;
  } else if (d <= SEUILS.distanceVerifierM && (adresseForte || voieCommune || nomOk || catHebergement)) {
    verdict = 'a_verifier'; motif = `${d} m, adresse ${adresseForte ? 'forte' : voieCommune ? 'même voie' : 'non concordante'}, nom ${similarite}${distinctif ? ' (mot distinctif)' : ''}, catégorie ${catHebergement ? 'hébergement' : 'autre'}`;
  }
  return { fiche, d, similarite, distinctif, adresseForte, voieCommune, catHebergement, verdict, motif };
}

const RANG = { accepte: 2, a_verifier: 1, aucun: 0 };
function meilleur(jugements) {
  return jugements.filter(Boolean).sort((a, b) => (RANG[b.verdict] - RANG[a.verdict]) || (b.similarite - a.similarite) || (a.d - b.d))[0] || null;
}

/* ---------- résidences ---------- */

const lireJeu = (f) => JSON.parse(fs.readFileSync(path.join(DATA_OPEN, f), 'utf8')).records;
const adresseLigne = (r) => [r.adresse, [r.cp, r.commune].filter(Boolean).join(' ')].filter(Boolean).join(', ');

function residences() {
  const out = [];
  for (const r of lireJeu('crous-residences.json')) out.push({ jeu: 'crous', id: String(r.id), nom: r.nom, adresse: r.adresse, lat: r.lat, lon: r.lon });
  for (const r of lireJeu('fjt.json')) out.push({ jeu: 'fjt', id: String(r.finess), nom: r.nom, adresse: adresseLigne(r), lat: r.lat, lon: r.lon });
  for (const r of lireJeu('residences-autonomie.json')) out.push({ jeu: 'residences-autonomie', id: String(r.finess), nom: r.nom, adresse: adresseLigne(r), lat: r.lat, lon: r.lon });
  const sansCoord = out.filter((r) => r.lat == null || r.lon == null);
  if (sansCoord.length) throw new Error(`${sansCoord.length} résidence(s) sans coordonnées : impossible de juger une fiche`);
  return out;
}

function selection(toutes) {
  if (ECHANTILLON) {
    const parJeu = {};
    for (const r of toutes) (parJeu[r.jeu] = parJeu[r.jeu] || []).push(r);
    return Object.values(parJeu).flatMap((l) => [l[0], l[Math.floor(l.length / 2)], l[l.length - 1]]);
  }
  return LIMITE ? toutes.slice(0, LIMITE) : toutes;
}

/* ---------- appariement ---------- */

async function apparier(res) {
  const cle = `${res.jeu}-${res.id}`;
  const q1 = await chercherMaps(cle + '-q1', `${res.nom} ${res.adresse}`, res.lat, res.lon);
  let jugements = q1.fiches.map((f) => juger(res, f));
  let choix = meilleur(jugements);
  let appels = 1;
  if (!choix || choix.verdict !== 'accepte') {
    const q2 = await chercherMaps(cle + '-q2', res.nom, res.lat, res.lon);
    jugements = jugements.concat(q2.fiches.map((f) => juger(res, f)));
    choix = meilleur(jugements);
    appels = 2;
  }
  const base = { jeu: res.jeu, id: res.id, nom: res.nom, adresse: res.adresse, lat: res.lat, lon: res.lon, appels, candidats: jugements.filter(Boolean).length };
  if (!choix) return { ...base, verdict: 'aucun', motif: 'aucune fiche exploitable rendue par Google Maps' };
  return {
    ...base,
    verdict: choix.verdict, motif: choix.motif || 'aucune fiche à moins de ' + SEUILS.distanceVerifierM + ' m qui concorde',
    ...(choix.verdict !== 'aucun' ? {
      placeId: choix.fiche.placeId, cid: choix.fiche.cid, titreGoogle: choix.fiche.titre, categorieGoogle: choix.fiche.categorie,
      adresseGoogle: choix.fiche.adresse, latGoogle: choix.fiche.lat, lonGoogle: choix.fiche.lon, distanceM: choix.d,
      similariteNom: choix.similarite, adresseForte: choix.adresseForte, note: choix.fiche.note, avis: choix.fiche.avis,
    } : {}),
  };
}

async function main() {
  const toutes = residences();
  const cibles = selection(toutes);
  console.log(`${cibles.length} résidence(s) à apparier sur ${toutes.length}${ECHANTILLON ? ' (échantillon : première, milieu, dernière de chaque jeu)' : ''}`);
  const resultats = new Array(cibles.length);
  let i = 0, faits = 0;
  const erreurs = [];
  // L'API accepte 30 appels simultanés ; 5 par défaut, --concurrence=N pour une passe
  // complète (une recherche Maps en direct prend 5 à 10 s).
  const CONCURRENCE = opt('concurrence') ? Number(opt('concurrence')) : 5;
  if (!(CONCURRENCE >= 1 && CONCURRENCE <= 30)) { console.error('--concurrence doit être entre 1 et 30'); process.exit(2); }
  await Promise.all(Array.from({ length: CONCURRENCE }, async () => {
    while (i < cibles.length) {
      const k = i++;
      try { resultats[k] = await apparier(cibles[k]); } catch (e) { erreurs.push(`${cibles[k].jeu} ${cibles[k].id} : ${e.message}`); }
      faits++;
      if (faits % 50 === 0 || faits === cibles.length) console.log(`  ${faits}/${cibles.length} (${APPELS} appels, ${DEPUIS_CACHE} depuis le cache, ${COUT.toFixed(3)} USD)`);
    }
  }));
  if (erreurs.length) {
    console.error(`\n${erreurs.length} résidence(s) en erreur, rien n'est écrit :\n  ${erreurs.slice(0, 10).join('\n  ')}`);
    process.exit(1);
  }
  const items = resultats.filter(Boolean).sort((a, b) => a.jeu.localeCompare(b.jeu) || a.id.localeCompare(b.id, 'fr', { numeric: true }));
  /* Une fiche Google acceptée par plusieurs résidences ne peut être la fiche que d'une seule,
     sauf adresse concordante au numéro près pour chacune (un site et son extension, un FJT et
     une résidence autonomie du même gestionnaire à la même adresse). Sans cela, elle reste à
     celle dont le nom concorde le mieux, et les autres passent en relecture (relu le
     10/09/2026 : un foyer-soleil à 137 m rattaché à la fiche de sa résidence mère). */
  const parFiche = new Map();
  for (const it of items) if (it.verdict === 'accepte') (parFiche.get(it.placeId) || parFiche.set(it.placeId, []).get(it.placeId)).push(it);
  for (const groupe of parFiche.values()) {
    if (groupe.length < 2) continue;
    const fortes = groupe.filter((it) => it.adresseForte);
    const gardees = fortes.length ? fortes : [groupe.slice().sort((a, b) => (b.similariteNom - a.similariteNom) || (a.distanceM - b.distanceM))[0]];
    for (const it of groupe) {
      if (gardees.includes(it)) continue;
      it.verdict = 'a_verifier';
      it.motif = `fiche déjà attribuée à ${gardees.map((g) => `${g.jeu} ${g.id}`).join(', ')} (${it.motif})`;
    }
  }
  const comptes = {};
  for (const it of items) comptes[it.verdict] = (comptes[it.verdict] || 0) + 1;
  console.log('\nVerdicts :', JSON.stringify(comptes));
  for (const v of ['accepte', 'a_verifier']) {
    const l = items.filter((it) => it.verdict === v);
    if (!l.length) continue;
    console.log(`\n${v} (${l.length}) :`);
    for (const it of l.slice(0, ECHANTILLON ? 50 : 12)) console.log(`  - [${it.jeu}] ${it.nom} | ${it.adresse}\n      → ${it.titreGoogle} | ${it.categorieGoogle} | ${it.adresseGoogle} | ${it.distanceM} m | sim ${it.similariteNom} | ${it.motif}`);
  }
  const aucun = items.filter((it) => it.verdict === 'aucun');
  if (aucun.length) { console.log(`\naucun (${aucun.length}), premiers cas :`); for (const it of aucun.slice(0, ECHANTILLON ? 50 : 8)) console.log(`  - [${it.jeu}] ${it.nom} | ${it.adresse} | ${it.candidats} candidat(s) | ${it.motif}`); }

  if (ECHANTILLON || LIMITE) {
    console.log(`\nPasse partielle : ${SORTIE} n'est PAS écrit (coût ${COUT.toFixed(3)} USD, ${APPELS} appels).`);
    return;
  }
  const sortie = {
    _meta: {
      source: 'Google Maps, lu par la SERP en direct de DataForSEO (serp/google/maps/live/advanced)',
      methode: 'Pour chaque résidence : recherche « nom + adresse » centrée sur les coordonnées de la source officielle (puis « nom » seul si rien n\'est accepté) ; chaque fiche rendue est jugée sur la distance aux coordonnées de la source, la concordance de l\'adresse (numéro et voie) et celle du nom ou de la catégorie. Seul un verdict « accepte » est publié par build.js.',
      seuils: SEUILS,
      collectedAt: new Date().toISOString(),
      appels: APPELS + DEPUIS_CACHE,
      coutUsd: Math.round(COUT * 1000) / 1000,
      comptes,
    },
    items,
  };
  fs.writeFileSync(SORTIE, JSON.stringify(sortie, null, 1) + '\n');
  console.log(`\nÉcrit : ${path.relative(ROOT, SORTIE)} (${items.length} résidences, ${COUT.toFixed(3)} USD cette exécution)`);
}

main().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });

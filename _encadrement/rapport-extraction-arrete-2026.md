# Grille 2026 de l'encadrement des loyers : extraite du PDF, et prouvée

Mesuré le 4 septembre 2026. Chantier ouvert depuis le 4 septembre au matin
(constat de la routine de veille : le site sert la grille de l'arrêté du
16 juin 2025, hors vigueur depuis le 30 juin 2026).

## Ce qui a été produit

| Fichier | Rôle |
|---|---|
| `site/ingest/pdf.js` | Lecture d'un PDF en Node natif : objets, flux compressés, texte AVEC positions, récursion dans les XObject de type Form. Zéro dépendance. |
| `site/ingest/ingest-encadrement-arrete.js` | Extraction de la grille depuis l'arrêté, contrôles, dépliage sur les 80 quartiers, écriture du jeu. |
| `site/data/open/encadrement-loyers-paris.json` | **2 560 enregistrements**, même forme que le jeu précédent (plus trois champs : `majorationMeuble`, `arrondissement`, `quartierArrete`). Copie par millésime dans `archives/`. |
| `~/.claude/skills/extraire-donnees-pdf/` | Le lecteur PDF et la méthode, promus en skill : la procédure est répétable sur tout document dont la donnée n'existe qu'en PDF. |

Commandes :

```bash
node site/ingest/ingest-encadrement-arrete.js
```

```bash
node site/ingest/ingest-encadrement-arrete.js --recette
```

**Publié le 4 septembre 2026** (commit e691623) : le fichier produit a pris le nom
canonique `encadrement-loyers-paris.json`, le millésime 2025 est archivé, et le
site sert la grille en vigueur. Détail de la bascule en fin de rapport.

## Ce que contient l'arrêté, et pourquoi 2 560 enregistrements

L'arrêté publie **14 tableaux, un par secteur géographique**, de 16 lignes
(4 nombres de pièces fois 4 époques) et 7 colonnes : minoré, référence et
majoré pour les locations vides, la **majoration unitaire du meublé**, puis
minoré, référence et majoré pour les meublées. Soit 1 568 nombres.

Les 2 560 enregistrements du jeu servi sont le dépliage de ces 224 lignes sur
les 80 quartiers : la valeur ne dépend que du secteur. Vérifié sur le millésime
2025, 448 combinaisons, **0 conflit**. La table quartier vers secteur est lue
dans l'annexe 1 de l'arrêté lui-même, pas reprise de l'an dernier.

## Pourquoi la lecture est juste : cinq contrôles, tous bloquants

1. **Structure** : 14 secteurs distincts, 16 lignes par tableau, 7 nombres par
   ligne, colonnes alignées à 12 points près, ordre des colonnes prouvé par la
   position des en-têtes (jamais supposé), séquence des époques, étiquette de
   pièces qui doit tomber dans l'étendue verticale de son groupe.
2. **Conservation des glyphes** : 6 048 signes dessinés dans la zone des
   valeurs, 6 048 restitués dans les cellules. Un chiffre perdu ou dédoublé par
   le regroupement en mots ne passerait pas.
3. **Arithmétique de l'arrêté** : majoré = référence fois 1,2, minoré =
   référence fois 0,7, et référence meublée = référence vide plus majoration
   unitaire. **1 120 vérifications, 0 écart.**
4. **Falsification** : les contrôles arithmétiques ne valent que s'ils savent
   voir une erreur. Les 45 échanges de chiffres possibles (0 contre 1, 0 contre
   2...) sont rejoués sur la grille : le moins détecté casse quand même
   **622 vérifications**. Zéro angle mort.
5. **Recette contre vérité terrain** : le même code appliqué au PDF de l'arrêté
   du 16 juin 2025 rend **exactement** la grille publiée en données ouvertes
   pour ce millésime. 1 344 valeurs comparées, 80 quartiers, **0 écart**.
   C'est le contrôle qui compte : il prouve la chaîne entière sur un millésime
   dont la vérité est connue par ailleurs.

Contrôles annexes : la table quartier vers secteur 2026 est identique à celle de
2025 (0 quartier a changé de secteur), et une cellule témoin relue à la main dans
le PDF (secteur 2, une pièce, avant 1946 : 25,3 | 36,1 | 43,3 | 5,1 | 28,8 |
41,2 | 49,4) se retrouve à l'identique dans le fichier produit.

## Ce que dit la grille 2026

- **Loyer de référence : +3,33 % en médiane** (moyenne +3,33 %), de -0,50 % à
  +8,46 %. 2 532 valeurs en hausse, 26 stables, 2 en baisse (secteur 8,
  3 pièces, 1946-1970).
- Par secteur, la médiane va de **+2,62 %** (secteur 1) à **+3,76 %**
  (secteur 6). Aucun secteur ne décroche.
- **Plafond légal** (loyer de référence majoré) : de 18,1 à **52,2 euros par
  mètre carré** hors charges, contre 18,1 à 50,2 en 2025.

## La bascule, faite le 4 septembre 2026

1. **Source** : millésime 2025 archivé dans `site/data/open/archives/`, grille de
   l'arrêté promue au nom canonique `encadrement-loyers-paris.json`. L'URL servie
   `/data/encadrement-loyers-paris.json` ne change pas, donc rien à réindexer de ce
   côté. Le script d'ingestion archive désormais chaque millésime au passage.
2. **Garde-fou de millésime devenu garde-fou de période.** La phrase servie énonce
   la période d'application (« applicable du 1er juillet au 24 novembre 2026 ») au
   lieu d'affirmer qu'on est dedans : elle reste vraie même sans rebuild. Après le
   dernier jour d'application, le premier build ajoute de lui-même la mention
   d'échéance et repasse le bloc en avertissement. Les deux branches validées par
   réintroduction, ainsi que l'échec de build sur un millésime inattendu.
3. **Attributions corrigées** : les cinq mentions en dur qui attribuaient la grille
   à l'ODbL de la Ville de Paris sont réécrites. Zéro occurrence d'ODbL ou du
   millésime 2025 dans les 76 pages publiées.
4. **Le jeu open data ne peut plus faire reculer la grille** : `ingest-encadrement.js`
   écrit dans `archives/` et sort de la liste de `ingest.js`. Sans cela, un simple
   `node site/ingest/ingest.js` aurait réinstallé la grille périmée sans rien casser.
5. **Noms de quartier** : les noms actuels restent servis, le nom officiel est gardé
   dans `quartierArrete`. Basculer sur la typographie de l'arrêté reste ouvert.
6. **Le guide n'a pas été re-daté**, et c'est volontaire : son texte n'a pas changé,
   seule la donnée, qui porte sa propre date (« références 2026, extraites le
   4 septembre 2026 »). Re-dater aurait menti sur le texte.

Livraison : barrière `check-tout.js` verte, vérificateur rejoué en navigateur
(plafond 43,30 euros/m² pour St-Germain-l'Auxerrois, une pièce, avant 1946, soit
1 732 euros pour 40 m²), production vérifiée par le CONTENU (JSON servi identique
au build local, octet pour octet), IndexNow 200 sur 76 URLs, sitemap re-soumis,
« Indexation demandée » confirmée par lecture de la modale visible.

## Pièges consignés

- **Le PDF est un recueil d'actes administratifs** : chaque page source y est
  empilée comme un XObject de type Form. Sans récursion dans les `Do`, les
  pages ressortent vides et on conclut à tort à un PDF scanné.
- **Un contrôle se relit comme du code de production.** Le contrôle de
  conservation des glyphes a d'abord accusé l'extraction (432 signes contre
  410) : c'était `String(5.0)` qui rend « 5 » au lieu de « 5,0 » et perdait
  deux signes par valeur ronde. Le défaut était dans la sonde.
- **Ne pas bloquer sur la police.** L'arrêté de 2025 compose un « 0 » isolé en
  LiberationSans au milieu de cellules en Marianne, et les numéros de secteur
  sont en gras. Un invariant « une seule police dans les cellules » aurait
  refusé un document parfaitement lisible. L'identité des chiffres se prouve
  par le test de falsification, pas par la police.
- **Arrondi demi-haut en arithmétique entière.** En virgule flottante,
  31,5 fois 0,7 vaut 22,049999... et donne 22,0 là où l'arrêté publie 22,1 :
  39 valeurs du millésime 2025 en dépendent. Calculer en dixièmes d'euro
  entiers.
- **Le lecteur PDF du navigateur ne se laisse pas capturer** dans le pane :
  page rendue noire, vignettes blanches, clic impossible dans le cadre. La
  contre-preuve visuelle est passée par la recette 2025, qui vaut mieux qu'une
  capture.
- **Le simulateur officiel `encadrementdesloyers.gouv.fr` sert un certificat
  expiré** (constaté le 4 septembre 2026, `SEC_E_CERT_EXPIRED`). Il n'était donc
  pas utilisable comme source de recoupement.
- Le jeu `logement-encadrement-des-loyers` d'opendata.paris.fr est toujours
  figé au **17 juin 2025**, dernier millésime 2025 (revérifié le jour même).

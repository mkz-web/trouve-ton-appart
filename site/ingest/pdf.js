#!/usr/bin/env node
/**
 * pdf.js : lecture d'un PDF en Node natif, texte AVEC positions.
 * ------------------------------------------------------------------
 * Runtime     : Node.js >= 14
 * Dépendances : AUCUNE (modules natifs : zlib)
 * Usage       : const { extraireTexte, lignes, mots } = require('./pdf');
 * ------------------------------------------------------------------
 * Ce que le module sait faire, et pourquoi il en fait autant :
 *  - objets indexés par balayage du fichier (pas de table xref à parser) et
 *    flux d'objets /ObjStm dépliés, ce qui suffit à tout PDF non chiffré ;
 *  - flux FlateDecode, ASCIIHex, ASCII85 et prédicteurs PNG ;
 *  - récursion dans les XObject de type Form : le recueil des actes
 *    administratifs empile ses pages sources comme des « templates », et sans
 *    cette récursion les pages ressortent vides ;
 *  - codes de caractères résolus par /ToUnicode, sinon par /Differences.
 *
 * Ce qu'il ne fait pas : largeurs de glyphes (l'avance entre deux fragments est
 * approximative, seule la position d'ORIGINE de chaque fragment est exacte),
 * PDF chiffrés, texte dans une image.
 */
'use strict';

const zlib = require('zlib');

/* ------------------------------ lexique ----------------------------- */
const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isWS = (c) => WS.has(c);
const isReg = (c) => !WS.has(c) && !DELIM.has(c);

function skipWS(buf, i) {
  for (;;) {
    while (i < buf.length && isWS(buf[i])) i++;
    if (buf[i] === 0x25) { // % commentaire
      while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
      continue;
    }
    return i;
  }
}

const Name = (v) => ({ t: 'name', v });

function parseObjectAt(buf, i) {
  i = skipWS(buf, i);
  if (i >= buf.length) return { v: null, i };
  const c = buf[i];

  if (c === 0x2f) { // nom
    let j = i + 1, s = '';
    while (j < buf.length && isReg(buf[j])) {
      if (buf[j] === 0x23 && j + 2 < buf.length) {
        const hex = buf.toString('latin1', j + 1, j + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { s += String.fromCharCode(parseInt(hex, 16)); j += 3; continue; }
      }
      s += String.fromCharCode(buf[j]); j++;
    }
    return { v: Name(s), i: j };
  }
  if (c === 0x28) return parseLiteralString(buf, i);
  if (c === 0x3c && buf[i + 1] === 0x3c) return parseDict(buf, i);
  if (c === 0x3c) return parseHexString(buf, i);
  if (c === 0x5b) { // tableau
    const arr = []; let j = i + 1;
    for (;;) {
      j = skipWS(buf, j);
      if (j >= buf.length) break;
      if (buf[j] === 0x5d) { j++; break; }
      const r = parseObjectAt(buf, j);
      if (r.i === j) { j++; continue; }
      arr.push(r.v); j = r.i;
    }
    return { v: arr, i: j };
  }
  if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) return { v: null, i: i + 1 };

  let j = i, tok = '';
  while (j < buf.length && isReg(buf[j])) { tok += String.fromCharCode(buf[j]); j++; }
  if (tok === '') return { v: null, i: i + 1 };
  if (tok === 'true') return { v: true, i: j };
  if (tok === 'false') return { v: false, i: j };
  if (tok === 'null') return { v: null, i: j };
  if (/^[+-]?[0-9]*\.?[0-9]+$/.test(tok) || /^[+-]?[0-9]+\.$/.test(tok)) {
    const n = parseFloat(tok);
    if (/^[0-9]+$/.test(tok)) { // « num gen R » ?
      let k = skipWS(buf, j), t2 = '';
      while (k < buf.length && isReg(buf[k])) { t2 += String.fromCharCode(buf[k]); k++; }
      if (/^[0-9]+$/.test(t2)) {
        let m = skipWS(buf, k), t3 = '';
        while (m < buf.length && isReg(buf[m])) { t3 += String.fromCharCode(buf[m]); m++; }
        if (t3 === 'R') return { v: { t: 'ref', n, g: parseInt(t2, 10) }, i: m };
      }
    }
    return { v: n, i: j };
  }
  return { v: { t: 'op', v: tok }, i: j };
}

function parseLiteralString(buf, i) {
  let j = i + 1, depth = 1; const out = [];
  while (j < buf.length && depth > 0) {
    const c = buf[j];
    if (c === 0x5c) { // contre-oblique
      const d = buf[j + 1];
      j += 2;
      if (d === 0x6e) out.push(10);
      else if (d === 0x72) out.push(13);
      else if (d === 0x74) out.push(9);
      else if (d === 0x62) out.push(8);
      else if (d === 0x66) out.push(12);
      else if (d >= 0x30 && d <= 0x37) {
        let oct = String.fromCharCode(d);
        for (let k = 0; k < 2 && buf[j] >= 0x30 && buf[j] <= 0x37; k++) { oct += String.fromCharCode(buf[j]); j++; }
        out.push(parseInt(oct, 8) & 0xff);
      } else if (d === 0x0a) { /* ligne continuée */ }
      else if (d === 0x0d) { if (buf[j] === 0x0a) j++; }
      else out.push(d);
      continue;
    }
    if (c === 0x28) depth++;
    if (c === 0x29) { depth--; if (depth === 0) { j++; break; } }
    out.push(c); j++;
  }
  return { v: { t: 'str', v: Buffer.from(out) }, i: j };
}

function parseHexString(buf, i) {
  let j = i + 1, hex = '';
  while (j < buf.length && buf[j] !== 0x3e) {
    const ch = String.fromCharCode(buf[j]);
    if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    j++;
  }
  j++;
  if (hex.length % 2) hex += '0';
  return { v: { t: 'str', v: Buffer.from(hex, 'hex') }, i: j };
}

function parseDict(buf, i) {
  let j = i + 2; const d = {};
  for (;;) {
    j = skipWS(buf, j);
    if (j >= buf.length) break;
    if (buf[j] === 0x3e && buf[j + 1] === 0x3e) { j += 2; break; }
    if (buf[j] !== 0x2f) { const r = parseObjectAt(buf, j); j = r.i === j ? j + 1 : r.i; continue; }
    const k = parseObjectAt(buf, j); j = k.i;
    const v = parseObjectAt(buf, j); j = v.i;
    d[k.v.v] = v.v;
  }
  const save = j;
  j = skipWS(buf, j);
  if (buf.toString('latin1', j, j + 6) === 'stream') {
    j += 6;
    if (buf[j] === 0x0d) j++;
    if (buf[j] === 0x0a) j++;
    return { v: { t: 'stream', dict: d, start: j }, i: j };
  }
  return { v: { t: 'dict', v: d }, i: save };
}

/* ------------------------------ document ---------------------------- */
class Pdf {
  constructor(buf) {
    this.buf = buf;
    this.offsets = new Map();
    this.cache = new Map();
    this.fromObjStm = new Map();
    this.scan();
    this.expandObjStms();
  }

  scan() {
    const s = this.buf.toString('latin1');
    const re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      // La dernière occurrence gagne : dans une mise à jour incrémentale,
      // c'est la version la plus récente de l'objet.
      this.offsets.set(parseInt(m[1], 10), m.index + m[0].length);
    }
  }

  get(v) {
    let garde = 0;
    while (v && v.t === 'ref') { v = this.obj(v.n); if (++garde > 32) return null; }
    return v;
  }

  obj(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    this.cache.set(num, null); // anti-boucle
    let val = null;
    if (this.fromObjStm.has(num)) val = this.fromObjStm.get(num);
    else if (this.offsets.has(num)) val = parseObjectAt(this.buf, this.offsets.get(num)).v;
    this.cache.set(num, val);
    return val;
  }

  dictOf(o) {
    o = this.get(o);
    if (!o) return null;
    if (o.t === 'dict') return o.v;
    if (o.t === 'stream') return o.dict;
    return null;
  }

  streamData(st) {
    st = this.get(st);
    if (!st || st.t !== 'stream') return null;
    if (st._data) return st._data;
    const len = this.get(st.dict.Length);
    let end = null;
    if (typeof len === 'number' && len >= 0 && st.start + len <= this.buf.length) {
      const fin = st.start + len;
      if (/^\s*endstream/.test(this.buf.toString('latin1', fin, fin + 20))) end = fin;
    }
    if (end == null) { // /Length absent, indirect ou faux : on borne sur « endstream »
      const idx = this.buf.indexOf('endstream', st.start, 'latin1');
      end = idx < 0 ? this.buf.length : idx;
      while (end > st.start && (this.buf[end - 1] === 0x0a || this.buf[end - 1] === 0x0d)) end--;
    }
    let raw = this.buf.slice(st.start, end);
    const filtres = [].concat(this.get(st.dict.Filter) || []).filter(Boolean);
    const parms = [].concat(this.get(st.dict.DecodeParms) || this.get(st.dict.DP) || []);
    for (let k = 0; k < filtres.length; k++) {
      const f = this.get(filtres[k]);
      const nom = f && f.v;
      if (nom === 'FlateDecode' || nom === 'Fl') {
        try { raw = zlib.inflateSync(raw); }
        catch (e) {
          try { raw = zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
          catch (e2) { raw = Buffer.alloc(0); }
        }
      } else if (nom === 'ASCIIHexDecode' || nom === 'AHx') {
        const hex = raw.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
        raw = Buffer.from(hex.slice(0, hex.length - (hex.length % 2)), 'hex');
      } else if (nom === 'ASCII85Decode' || nom === 'A85') {
        raw = ascii85(raw);
      }
      const p = this.dictOf(parms[k]);
      if (p && this.get(p.Predictor) > 1) {
        raw = depredire(raw, this.get(p.Predictor), this.get(p.Colors) || 1, this.get(p.BitsPerComponent) || 8, this.get(p.Columns) || 1);
      }
    }
    st._data = raw;
    return raw;
  }

  expandObjStms() {
    for (const num of [...this.offsets.keys()]) {
      const o = this.obj(num);
      if (!o || o.t !== 'stream') continue;
      const ty = this.get(o.dict.Type);
      if (!ty || ty.v !== 'ObjStm') continue;
      const data = this.streamData(o);
      const n = this.get(o.dict.N), first = this.get(o.dict.First);
      if (!data || !n) continue;
      const tete = data.toString('latin1', 0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k < n; k++) {
        const onum = tete[2 * k], ooff = tete[2 * k + 1];
        if (!Number.isFinite(onum) || !Number.isFinite(ooff)) continue;
        if (this.offsets.has(onum)) continue; // un objet direct est plus récent
        this.fromObjStm.set(onum, parseObjectAt(data, first + ooff).v);
      }
    }
  }

  tousNumeros() { return [...new Set([...this.offsets.keys(), ...this.fromObjStm.keys()])]; }

  catalogue() {
    for (const num of this.tousNumeros()) {
      const d = this.dictOf({ t: 'ref', n: num });
      const ty = d && this.get(d.Type);
      if (ty && ty.v === 'Catalog') return d;
    }
    return null;
  }

  pages() {
    const cat = this.catalogue();
    const out = [];
    const marcher = (noeud, herite, profondeur) => {
      const d = this.dictOf(noeud);
      if (!d || profondeur > 64) return;
      const suivant = Object.assign({}, herite);
      for (const k of ['Resources', 'MediaBox', 'Rotate', 'CropBox']) if (d[k] !== undefined) suivant[k] = d[k];
      const ty = this.get(d.Type);
      if (ty && ty.v === 'Page') { out.push(Object.assign({}, suivant, d)); return; }
      for (const kid of this.get(d.Kids) || []) marcher(kid, suivant, profondeur + 1);
    };
    if (cat) marcher(cat.Pages, {}, 0);
    return out;
  }

  contenuDe(page) {
    const parts = [];
    for (const s of [].concat(this.get(page.Contents) || [])) {
      const d = this.streamData(s);
      if (d && d.length) parts.push(d, Buffer.from('\n'));
    }
    return Buffer.concat(parts);
  }
}

function ascii85(buf) {
  const s = buf.toString('latin1').replace(/\s/g, '').replace(/^<~/, '');
  const out = []; let tup = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '~') break;
    if (ch === 'z' && n === 0) { out.push(0, 0, 0, 0); continue; }
    tup = tup * 85 + (ch.charCodeAt(0) - 33); n++;
    if (n === 5) { out.push((tup >>> 24) & 255, (tup >>> 16) & 255, (tup >>> 8) & 255, tup & 255); tup = 0; n = 0; }
  }
  if (n > 0) {
    for (let i = n; i < 5; i++) tup = tup * 85 + 84;
    const b = [(tup >>> 24) & 255, (tup >>> 16) & 255, (tup >>> 8) & 255, tup & 255];
    out.push(...b.slice(0, n - 1));
  }
  return Buffer.from(out);
}

/** Prédicteurs PNG (10 à 15) des flux compressés. */
function depredire(data, pred, colors, bpc, columns) {
  if (pred < 10) return data;
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const row = Buffer.from(data.slice(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1)));
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let x = row[i];
      if (ft === 1) x = (x + a) & 255;
      else if (ft === 2) x = (x + b) & 255;
      else if (ft === 3) x = (x + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        x = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      row[i] = x;
    }
    row.copy(out, r * rowLen);
    prev = row;
  }
  return out;
}

/* ------------------------------ polices ----------------------------- */
function parseToUnicode(data) {
  const s = data.toString('latin1');
  const map = new Map();
  const hexVersTexte = (h) => {
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) {
      const code = parseInt(h.slice(i, i + 4), 16);
      if (Number.isFinite(code)) out += String.fromCharCode(code);
    }
    return out;
  };
  let m;
  const reChar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = reChar.exec(s)) !== null) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g; let p;
    while ((p = re.exec(m[1])) !== null) map.set(parseInt(p[1], 16), hexVersTexte(p[2]));
  }
  const reRange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = reRange.exec(s)) !== null) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([\s\S]*?)\])/g; let p;
    while ((p = re.exec(m[1])) !== null) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16);
      if (p[3] !== undefined) {
        const base = p[3];
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          const v = (parseInt(base.slice(-4), 16) || 0) + (c - lo);
          map.set(c, hexVersTexte(base.slice(0, -4)) + String.fromCharCode(v));
        }
      } else {
        (p[4].match(/<([0-9a-fA-F]*)>/g) || []).forEach((it, k) => map.set(lo + k, hexVersTexte(it.slice(1, -1))));
      }
    }
  }
  return map;
}

const CHIFFRES = 'zero one two three four five six seven eight nine'.split(' ');
const GLYPHES = {
  space: ' ', comma: ',', period: '.', hyphen: '-', percent: '%', slash: '/',
  parenleft: '(', parenright: ')', colon: ':', semicolon: ';', quotesingle: "'", quoteright: '’',
  degree: '°', euro: '€', eacute: 'é', egrave: 'è', agrave: 'à', ccedilla: 'ç',
  ecircumflex: 'ê', acircumflex: 'â', icircumflex: 'î', ocircumflex: 'ô',
  ucircumflex: 'û', ugrave: 'ù', edieresis: 'ë', idieresis: 'ï', udieresis: 'ü',
};
function glypheVersCaractere(n) {
  if (GLYPHES[n]) return GLYPHES[n];
  const k = CHIFFRES.indexOf(n);
  if (k >= 0) return String(k);
  if (/^uni([0-9A-Fa-f]{4})$/.test(n)) return String.fromCharCode(parseInt(n.slice(3), 16));
  return n.length === 1 ? n : '';
}

function construirePolices(pdf, resources) {
  const polices = {};
  const res = pdf.dictOf(resources);
  const fd = res && pdf.dictOf(res.Font);
  if (!fd) return polices;
  for (const cle of Object.keys(fd)) {
    const f = pdf.dictOf(fd[cle]);
    if (!f) continue;
    const sub = pdf.get(f.Subtype);
    const info = { deuxOctets: !!(sub && sub.v === 'Type0'), toUni: null, diff: null, nom: (pdf.get(f.BaseFont) || {}).v || '' };
    const tu = pdf.get(f.ToUnicode);
    if (tu && tu.t === 'stream') { try { info.toUni = parseToUnicode(pdf.streamData(tu)); } catch (e) { info.toUni = null; } }
    const enc = pdf.get(f.Encoding);
    if (enc && enc.t === 'dict') {
      const diffs = pdf.get(enc.v.Differences);
      if (Array.isArray(diffs)) {
        info.diff = new Map(); let cur = 0;
        for (const d of diffs) {
          if (typeof d === 'number') cur = d;
          else if (d && d.t === 'name') { info.diff.set(cur, d.v); cur++; }
        }
      }
    }
    if (enc && enc.t === 'name' && /Identity/.test(enc.v)) info.deuxOctets = true;
    polices[cle] = info;
  }
  return polices;
}

function decoder(str, police) {
  const bytes = str.v;
  let out = '';
  if (police && police.deuxOctets) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      out += (police.toUni && police.toUni.has(code)) ? police.toUni.get(code) : String.fromCharCode(code);
    }
    return out;
  }
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes[i];
    if (police && police.toUni && police.toUni.has(code)) { out += police.toUni.get(code); continue; }
    if (police && police.diff && police.diff.has(code)) { out += glypheVersCaractere(police.diff.get(code)); continue; }
    out += Buffer.from([code]).toString('latin1');
  }
  return out;
}

/* --------------------------- flux de contenu ------------------------ */
function* operateurs(buf) {
  let i = 0, pile = [];
  while (i < buf.length) {
    const avant = i;
    const r = parseObjectAt(buf, i);
    i = r.i;
    if (i <= avant) { i = avant + 1; continue; }
    const v = r.v;
    if (v && v.t === 'op') {
      if (v.v === 'BI') { // image en ligne : sauter jusqu'à EI
        const idx = buf.indexOf('EI', i, 'latin1');
        i = idx < 0 ? buf.length : idx + 2;
        pile = [];
        continue;
      }
      yield { op: v.v, args: pile };
      pile = [];
    } else {
      pile.push(v);
      if (pile.length > 64) pile.shift();
    }
  }
}

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

function jouer(pdf, contenu, resources, ctm0, items, profondeur, vus) {
  if (profondeur > 12) return;
  const polices = construirePolices(pdf, resources);
  const res = pdf.dictOf(resources) || {};
  const xobjs = pdf.dictOf(res.XObject) || {};
  let ctm = ctm0.slice();
  const pileG = [];
  let tm = null, tlm = null, police = null, corps = 0, interligne = 0, hscale = 1, rise = 0;

  const afficher = (str) => {
    if (!tm) return;
    const trm = mul(mul([corps * hscale, 0, 0, corps, 0, rise], tm), ctm);
    const s = decoder(str, police);
    if (s.trim() !== '') {
      const echelle = Math.sqrt(Math.abs(trm[0] * trm[3] - trm[1] * trm[2])) || Math.abs(corps);
      items.push({ s, x: trm[4], y: trm[5], corps: echelle, police: police ? police.nom : null });
    }
    // Avance approximative : les largeurs de glyphes ne sont pas lues. Elle
    // évite seulement d'empiler deux fragments à la même abscisse.
    tm = mul([1, 0, 0, 1, s.length * corps * 0.5 * hscale, 0], tm);
  };

  for (const { op, args } of operateurs(contenu)) {
    switch (op) {
      case 'q': pileG.push(ctm.slice()); break;
      case 'Q': ctm = pileG.pop() || ctm; break;
      case 'cm': if (args.length >= 6 && args.slice(-6).every((n) => typeof n === 'number')) ctm = mul(args.slice(-6), ctm); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
      case 'ET': tm = null; tlm = null; break;
      case 'Tf': {
        const nm = args[args.length - 2];
        if (typeof args[args.length - 1] === 'number') corps = args[args.length - 1];
        police = nm && nm.t === 'name' ? polices[nm.v] || null : null;
        break;
      }
      case 'Td': if (args.length >= 2) { tlm = mul([1, 0, 0, 1, args[args.length - 2], args[args.length - 1]], tlm || [1, 0, 0, 1, 0, 0]); tm = tlm.slice(); } break;
      case 'TD': if (args.length >= 2) { interligne = -args[args.length - 1]; tlm = mul([1, 0, 0, 1, args[args.length - 2], args[args.length - 1]], tlm || [1, 0, 0, 1, 0, 0]); tm = tlm.slice(); } break;
      case 'Tm': if (args.length >= 6) { tlm = args.slice(-6); tm = tlm.slice(); } break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -interligne], tlm || [1, 0, 0, 1, 0, 0]); tm = tlm.slice(); break;
      case 'TL': interligne = args[args.length - 1] || 0; break;
      case 'Tz': hscale = (args[args.length - 1] || 100) / 100; break;
      case 'Ts': rise = args[args.length - 1] || 0; break;
      case 'Tj': { const a = args[args.length - 1]; if (a && a.t === 'str') afficher(a); break; }
      case "'": case '"': {
        tlm = mul([1, 0, 0, 1, 0, -interligne], tlm || [1, 0, 0, 1, 0, 0]); tm = tlm.slice();
        const a = args[args.length - 1]; if (a && a.t === 'str') afficher(a);
        break;
      }
      case 'TJ': {
        const arr = args[args.length - 1];
        if (Array.isArray(arr)) {
          for (const el of arr) {
            if (el && el.t === 'str') afficher(el);
            else if (typeof el === 'number' && tm) tm = mul([1, 0, 0, 1, (-el / 1000) * corps * hscale, 0], tm);
          }
        }
        break;
      }
      case 'Do': {
        const nm = args[args.length - 1];
        if (!nm || nm.t !== 'name') break;
        const ref = xobjs[nm.v];
        const xo = pdf.get(ref);
        if (!xo || xo.t !== 'stream') break;
        const sub = pdf.get(xo.dict.Subtype);
        if (!sub || sub.v !== 'Form') break;
        const cle = (ref && ref.t === 'ref') ? ref.n : nm.v;
        if ((vus.get(cle) || 0) > 3) break; // garde-fou contre une récursion pathologique
        vus.set(cle, (vus.get(cle) || 0) + 1);
        const mtx = pdf.get(xo.dict.Matrix);
        const sousCtm = (Array.isArray(mtx) && mtx.length === 6) ? mul(mtx, ctm) : ctm;
        jouer(pdf, pdf.streamData(xo), xo.dict.Resources || resources, sousCtm, items, profondeur + 1, vus);
        vus.set(cle, vus.get(cle) - 1);
        break;
      }
      default: break;
    }
  }
}

/** Fragments de texte positionnés, page par page : [[{s,x,y,corps,police}]]. */
function extraireTexte(buf) {
  const pdf = new Pdf(buf);
  return pdf.pages().map((page) => {
    const items = [];
    jouer(pdf, pdf.contenuDe(page), page.Resources, [1, 0, 0, 1, 0, 0], items, 0, new Map());
    return items;
  });
}

/* ---------------------- regroupement en lignes ---------------------- */
/** Regroupe des fragments en lignes de même ordonnée, triées de haut en bas. */
function lignes(items, tolY) {
  const rows = [];
  for (const it of items.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = null;
    for (const rw of rows) if (Math.abs(rw.y - it.y) <= tolY) { row = rw; break; }
    if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
    row.items.push(it);
    row.y = row.items.reduce((s, i) => s + i.y, 0) / row.items.length;
  }
  rows.sort((a, b) => b.y - a.y);
  for (const rw of rows) rw.items.sort((a, b) => a.x - b.x);
  return rows;
}

/** Fusionne les fragments d'une ligne en mots : un écart supérieur à
 * `facteur` fois le corps coupe le mot. */
function mots(row, facteur) {
  const out = [];
  let cur = null, droite = null;
  for (const it of row.items) {
    const w = it.s.length * it.corps * 0.5;
    if (cur && droite != null && it.x - droite <= facteur * it.corps) { cur.s += it.s; cur.x2 = it.x + w; }
    else { if (cur) out.push(cur); cur = { s: it.s, x: it.x, x2: it.x + w, y: it.y, corps: it.corps, police: it.police }; }
    droite = it.x + w;
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { Pdf, extraireTexte, lignes, mots, parseObjectAt, parseToUnicode };

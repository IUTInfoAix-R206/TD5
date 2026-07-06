// canon.js - canonicalisation des résultats SQL et hash SHA-256.
//
// Ce fichier est la moitié JavaScript d'un CONTRAT partagé avec Python
// (scripts/webtd_canon.py). Les deux implémentations doivent produire des
// hashes bit-à-bit identiques pour un même résultat de requête.
//
// Il est utilisé tel quel :
//   - dans le navigateur (module ES importé par app.js) ;
//   - dans Node ≥ 18 par le vérificateur (scripts/verify-web-td.mjs) -
//     `crypto.subtle` et `TextEncoder` y sont des globales.
//
// Contrat (voir webtd_canon.py - toute modification doit être répercutée) :
//   Séparateurs : US=\x1f (cellules), RS=\x1e (lignes), GS=\x1d (en-tête/corps).
//   canon_cell :
//     NULL          -> "\x00N"
//     nombre entier -> chaîne décimale ("5", "-3", "0")
//     nombre réel   -> arrondi 6 décimales (arithmétique IEEE), zéros finaux ôtés
//     texte         -> échappement de \, \x00, US, RS, GS
//     BLOB          -> "\x00B"+hex (le générateur refuse les BLOB)
//   canon_result : lignes = US.join(cellules), triées si non ordonné,
//                  payload = String(ncols) + GS + RS.join(lignes).
//   hash = SHA-256(UTF-8(payload)) en hexadécimal minuscule.

const US = "\x1f"; // séparateur de cellules
const RS = "\x1e"; // séparateur de lignes
const GS = "\x1d"; // séparateur en-tête / corps

function canonNumber(v) {
  if (!Number.isFinite(v)) return "\x00X"; // NaN / ±Infinity ; le générateur refuse
  if (Number.isInteger(v)) {
    if (Object.is(v, -0)) return "0";
    return String(v);
  }
  const neg = v < 0;
  const a = Math.abs(v);
  // Arrondi demi-supérieur (away-from-zero) à 6 décimales via arithmétique IEEE,
  // identique à math.floor(a*1e6 + 0.5) côté Python.
  const r = Math.floor(a * 1e6 + 0.5);
  let digits = String(r);
  if (digits.length <= 6) digits = "0".repeat(7 - digits.length) + digits;
  const intPart = digits.slice(0, -6);
  const frac = digits.slice(-6).replace(/0+$/, "");
  let s = frac ? `${intPart}.${frac}` : intPart;
  if (neg && s !== "0") s = "-" + s;
  return s;
}

function hexBytes(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function escapeText(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\x00/g, "\\0")
    .replace(/\x1d/g, "\\g")
    .replace(/\x1e/g, "\\r")
    .replace(/\x1f/g, "\\u");
}

export function canonCell(v) {
  if (v === null || v === undefined) return "\x00N";
  if (typeof v === "number") return canonNumber(v);
  if (typeof v === "bigint") return canonNumber(Number(v));
  if (v instanceof Uint8Array) return "\x00B" + hexBytes(v);
  return escapeText(String(v));
}

export function canonPayload(ncols, rows, ordered) {
  const lines = rows.map((row) => row.map(canonCell).join(US));
  if (!ordered) lines.sort(); // ordre UTF-16 = ordre des points de code pour le BMP
  return String(ncols) + GS + lines.join(RS);
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  // crypto.subtle n'est disponible qu'en contexte sécurisé (https ou localhost).
  // Servie en http sur une IP réseau, la page n'y a pas accès : on bascule alors
  // sur une implémentation JS pure (résultat SHA-256 identique).
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", data);
    return hexBytes(new Uint8Array(buf));
  }
  return sha256Fallback(data);
}

// SHA-256 en JavaScript pur (FIPS 180-4), utilisé si crypto.subtle est absent.
function sha256Fallback(bytes) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  const l = bytes.length;
  const bitLen = l * 8;
  const withPad = new Uint8Array(((l + 8) >> 6) + 1 << 6);
  withPad.set(bytes);
  withPad[l] = 0x80;
  // longueur sur 64 bits (les 32 bits hauts sont nuls pour nos tailles)
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const toHex = (x) => (x >>> 0).toString(16).padStart(8, "0");
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

export async function hashResult(ncols, rows, ordered) {
  return sha256Hex(canonPayload(ncols, rows, ordered));
}

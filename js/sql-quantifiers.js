// sql-quantifiers.js - réécrit les comparaisons quantifiées (ALL / ANY / SOME) en
// équivalents que SQLite comprend. Jumeau de scripts/sql_quantifiers.py (sortie
// identique, prouvée par scripts/test-sql-quantifiers.mjs).
//
//   x >= ALL (S) -> x >= (SELECT MAX(c) FROM (S))   ; x < ANY (S) -> x < (SELECT MAX(c) ...)
//   x =  ANY (S) -> x IN (S)                        ; x <> ALL (S) -> x NOT IN (S)

const CMP = ["<=", ">=", "<>", "!=", "<", ">", "="]; // plus longs d'abord
const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const QUANT = /\b(ALL|ANY|SOME)\b/gi;
const WORD = /[A-Za-z0-9_]/;

function findBalanced(s, openIdx) {
  let depth = 0, i = openIdx, inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      if (c === "'") {
        if (i + 1 < s.length && s[i + 1] === "'") { i += 2; continue; }
        inStr = false;
      }
    } else if (c === "'") inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

function firstTopLevelFrom(body) {
  let depth = 0, i = 0, inStr = false;
  while (i < body.length) {
    const c = body[i];
    if (inStr) {
      if (c === "'") {
        if (i + 1 < body.length && body[i + 1] === "'") { i += 2; continue; }
        inStr = false;
      }
    } else if (c === "'") inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && body.slice(i, i + 4).toUpperCase() === "FROM"
             && (i === 0 || !WORD.test(body[i - 1]))
             && (i + 4 >= body.length || !WORD.test(body[i + 4]))) return i;
    i++;
  }
  return -1;
}

function projColname(subq) {
  const m = /^\s*SELECT\s+/i.exec(subq);
  if (!m) return null;
  let body = subq.slice(m[0].length);
  const md = /^DISTINCT\s+/i.exec(body);
  if (md) body = body.slice(md[0].length);
  const f = firstTopLevelFrom(body);
  if (f < 0) return null;
  const proj = body.slice(0, f).trim();
  let mm = new RegExp("\\bAS\\s+(" + IDENT + ")\\s*$", "i").exec(proj);
  if (mm) return mm[1];
  mm = new RegExp("^(" + IDENT + ")(?:\\.(" + IDENT + "))?$").exec(proj);
  if (mm) return mm[2] || mm[1];
  return null;
}

function build(op, kw, subq) {
  if (op === "=" && (kw === "ANY" || kw === "SOME")) return `IN (${subq})`;
  if ((op === "<>" || op === "!=") && kw === "ALL") return `NOT IN (${subq})`;
  if (op === "<" || op === "<=" || op === ">" || op === ">=") {
    let agg;
    if (kw === "ALL") agg = (op === ">" || op === ">=") ? "MAX" : "MIN";
    else agg = (op === ">" || op === ">=") ? "MIN" : "MAX";
    const name = projColname(subq);
    if (!name) return null;
    return `${op} (SELECT ${agg}(${name}) FROM (${subq}))`;
  }
  return null;
}

export function rewriteQuantifiers(sql) {
  let out = "", i = 0, m;
  QUANT.lastIndex = 0;
  while ((m = QUANT.exec(sql)) !== null) {
    if (m.index < i) continue; // déjà consommé par une réécriture précédente
    const kw = m[1].toUpperCase();
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(sql[j])) j--;
    let op = null, opStart = -1;
    for (const cand of CMP) {
      const L = cand.length;
      if (j - L + 1 >= 0 && sql.slice(j - L + 1, j + 1) === cand) { op = cand; opStart = j - L + 1; break; }
    }
    if (!op) continue;
    let k = m.index + m[0].length;
    while (k < sql.length && /\s/.test(sql[k])) k++;
    if (k >= sql.length || sql[k] !== "(") continue;
    const close = findBalanced(sql, k);
    if (close < 0) continue;
    const repl = build(op, kw, sql.slice(k + 1, close));
    if (repl === null) continue;
    out += sql.slice(i, opStart) + repl;
    i = close + 1;
  }
  out += sql.slice(i);
  return out;
}

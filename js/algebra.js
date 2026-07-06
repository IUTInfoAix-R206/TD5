// algebra.js - compilateur d'algèbre relationnelle (notation du cours) vers SQL SQLite.
//
// Notation de référence (STRICTE - voir docs/algebre-syntaxe.md) :
//   - une affectation par ligne : `Rnom := EXPR`
//   - opérateurs en MAJUSCULES sans accent : SELECTION, PROJECTION, RENOMMAGE,
//     UNION, INTERSECTION, DIFFERENCE, JOINTURE, DIVISION
//   - renommage : RENOMMAGE (R / ancien -> nouveau, ...)
//   - connecteurs booléens : ET / OU / NON (+ parenthèses)
//   - comparaisons : = <> < > <= >= ; chaînes '...' ; nombres ; temps HH:MM (non quoté)
//   - commentaires : -- jusqu'en fin de ligne ; la dernière relation affectée = réponse
//
// compileAlgebra(programText, catalog) -> { sql, finalSchema } ; lève AlgebraError.
// Utilisé au navigateur (app.js) ET côté Node (générateur/vérificateur) - source unique.

export class AlgebraError extends Error {
  constructor(message, line) {
    super(line ? `Ligne ${line} : ${message}` : message);
    this.name = "AlgebraError";
    this.line = line || null;
  }
}

const OPERATORS = new Set([
  "SELECTION", "PROJECTION", "RENOMMAGE", "UNION",
  "INTERSECTION", "DIFFERENCE", "JOINTURE", "JOINTURE_NATURELLE", "DIVISION",
]);
const BOOLEANS = new Set(["ET", "OU", "NON"]);
const KEYWORDS = new Set([...OPERATORS, ...BOOLEANS]);

function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function norm(s) {
  return stripDiacritics(s).toLowerCase();
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

const IDENT_START = /[A-Za-z_\u00C0-\u024F]/;
const IDENT_CHAR = /[A-Za-z0-9_\u00C0-\u024F]/;

function tokenize(src) {
  const toks = [];
  let i = 0, line = 1, col = 1;
  const n = src.length;
  const push = (type, value) => toks.push({ type, value, line });
  function adv(k = 1) { for (let j = 0; j < k; j++) { if (src[i] === "\n") { line++; col = 1; } else col++; i++; } }

  while (i < n) {
    const c = src[i];
    if (c === "\n") { push("NEWLINE"); adv(); continue; }
    if (c === " " || c === "\t" || c === "\r") { adv(); continue; }
    // Commentaire -- jusqu'en fin de ligne
    if (c === "-" && src[i + 1] === "-") { while (i < n && src[i] !== "\n") adv(); continue; }
    // Affectation :=
    if (c === ":" && src[i + 1] === "=") { push("ASSIGN", ":="); adv(2); continue; }
    // Flèche ->
    if (c === "-" && src[i + 1] === ">") { push("ARROW", "->"); adv(2); continue; }
    // Comparateurs
    if (c === "<" && src[i + 1] === "=") { push("CMP", "<="); adv(2); continue; }
    if (c === ">" && src[i + 1] === "=") { push("CMP", ">="); adv(2); continue; }
    if (c === "<" && src[i + 1] === ">") { push("CMP", "<>"); adv(2); continue; }
    if (c === "=" || c === "<" || c === ">") { push("CMP", c); adv(); continue; }
    // Ponctuation
    if (c === "(") { push("LPAREN", "("); adv(); continue; }
    if (c === ")") { push("RPAREN", ")"); adv(); continue; }
    if (c === "/") { push("SLASH", "/"); adv(); continue; }
    if (c === ",") { push("COMMA", ","); adv(); continue; }
    // Chaîne '...'
    if (c === "'") {
      const startLine = line;
      let s = "";
      adv();
      while (i < n && src[i] !== "'" && src[i] !== "\n") { s += src[i]; adv(); }
      if (src[i] !== "'") throw new AlgebraError("chaîne non terminée (apostrophe fermante manquante)", startLine);
      adv();
      toks.push({ type: "STRING", value: s, line: startLine });
      continue;
    }
    // Temps HH:MM (avant NUMBER)
    const tm = /^([0-9]{1,2}):([0-9]{2})/.exec(src.slice(i));
    if (tm) { push("TIME", tm[0]); adv(tm[0].length); continue; }
    // Nombre
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      push("NUMBER", m[0]); adv(m[0].length); continue;
    }
    // Identifiant / mot-clé (les noms de relations peuvent contenir des points internes)
    if (IDENT_START.test(c)) {
      let s = c; adv();
      while (i < n && (IDENT_CHAR.test(src[i]) || (src[i] === "." && IDENT_CHAR.test(src[i + 1] || "")))) { s += src[i]; adv(); }
      if (KEYWORDS.has(s)) push("KW", s);
      else toks.push({ type: "IDENT", value: s, line });
      continue;
    }
    throw new AlgebraError(`caractère inattendu « ${c} »`, line);
  }
  push("EOF");
  return toks;
}

// ── Parseur (descente récursive) ─────────────────────────────────────────────

function parse(toks) {
  let p = 0;
  const peek = () => toks[p];
  const at = (type) => toks[p].type === type;
  const next = () => toks[p++];
  function skipNewlines() { while (at("NEWLINE")) p++; }

  function expect(type, msgIfNot) {
    if (!at(type)) throw new AlgebraError(msgIfNot || `« ${type} » attendu`, peek().line);
    return next();
  }

  function relName() {
    const t = peek();
    if (t.type !== "IDENT") {
      if (t.type === "KW") throw new AlgebraError(`« ${t.value} » est un mot-clé ; nom de relation attendu`, t.line);
      throw new AlgebraError("nom de relation attendu", t.line);
    }
    return next().value;
  }

  function attrName() {
    const t = peek();
    if (t.type !== "IDENT") throw new AlgebraError("nom d'attribut attendu", t.line);
    return next().value;
  }

  // Détecte un opérateur mal orthographié pour un message d'aide.
  function unknownOperatorError(t) {
    if (t.type === "IDENT") {
      const up = stripDiacritics(t.value).toUpperCase();
      if (OPERATORS.has(up)) {
        return new AlgebraError(
          `opérateur « ${t.value} » : écrivez-le en majuscules sans accent : ${up}`, t.line);
      }
      return new AlgebraError(`opérateur inconnu « ${t.value} »`, t.line);
    }
    return new AlgebraError("opérateur attendu", t.line);
  }

  function operand(k, text) { return { k, text }; }

  function parseComparison() {
    const attr = attrName();
    const t = peek();
    if (t.type !== "CMP") throw new AlgebraError("comparateur attendu (= <> < > <= >=)", t.line);
    const op = next().value;
    const ot = peek();
    if (ot.type === "STRING") { next(); return { c: "cmp", attr, op, operand: operand("str", ot.value) }; }
    if (ot.type === "NUMBER") { next(); return { c: "cmp", attr, op, operand: operand("num", ot.value) }; }
    if (ot.type === "TIME") { next(); return { c: "cmp", attr, op, operand: operand("time", ot.value) }; }
    throw new AlgebraError("valeur attendue (chaîne, nombre ou heure HH:MM)", ot.line);
  }

  // Condition de SELECTION : OU / ET / NON / ( ) / comparaison
  function parseCondition() { return parseOr(); }
  function parseOr() {
    let node = parseAnd();
    while (at("KW") && peek().value === "OU") { next(); node = { c: "or", l: node, r: parseAnd() }; }
    return node;
  }
  function parseAnd() {
    let node = parseNot();
    while (at("KW") && peek().value === "ET") { next(); node = { c: "and", l: node, r: parseNot() }; }
    return node;
  }
  function parseNot() {
    if (at("KW") && peek().value === "NON") { next(); return { c: "not", e: parseNot() }; }
    if (at("LPAREN")) { next(); const e = parseCondition(); expect("RPAREN", "parenthèse fermante « ) » attendue"); return e; }
    return parseComparison();
  }

  // Condition de JOINTURE : conjonction de `attr CMP attr` reliés par ET
  function parseJoinCond() {
    const conds = [parseJoinCmp()];
    while (at("KW") && peek().value === "ET") { next(); conds.push(parseJoinCmp()); }
    return conds;
  }
  function parseJoinCmp() {
    const la = attrName();
    const t = peek();
    if (t.type !== "CMP") throw new AlgebraError("comparateur attendu dans la condition de jointure", t.line);
    const op = next().value;
    const ra = attrName();
    return { la, op, ra };
  }

  function parseAttrList() {
    const attrs = [attrName()];
    while (at("COMMA")) { next(); attrs.push(attrName()); }
    return attrs;
  }

  function parseRenameList() {
    const pairs = [];
    do {
      const from = attrName();
      expect("ARROW", "flèche « -> » attendue dans RENOMMAGE (ancien -> nouveau)");
      const to = attrName();
      pairs.push({ from, to });
    } while (at("COMMA") && (next(), true));
    return pairs;
  }

  function parseExpr(line) {
    const t = peek();
    if (t.type === "IDENT") {
      // Un identifiant dont la forme normalisée est un opérateur = opérateur mal écrit
      // (mauvaise casse/accent), pas un nom de relation → message ciblé.
      if (OPERATORS.has(stripDiacritics(t.value).toUpperCase())) throw unknownOperatorError(t);
      return { op: "REF", rel: next().value, line };
    }
    if (t.type !== "KW" || !OPERATORS.has(t.value)) throw unknownOperatorError(t);
    const op = next().value;
    expect("LPAREN", `parenthèse ouvrante « ( » attendue après ${op}`);
    let node;
    if (op === "SELECTION") {
      const rel = relName(); expect("SLASH", "« / » attendu avant la condition"); const cond = parseCondition();
      node = { op, rel, cond, line };
    } else if (op === "PROJECTION") {
      const rel = relName(); expect("SLASH", "« / » attendu avant la liste d'attributs"); const attrs = parseAttrList();
      node = { op, rel, attrs, line };
    } else if (op === "RENOMMAGE") {
      const rel = relName(); expect("SLASH", "« / » attendu avant les renommages"); const pairs = parseRenameList();
      node = { op, rel, pairs, line };
    } else if (op === "UNION" || op === "INTERSECTION" || op === "DIFFERENCE") {
      const left = relName(); expect("COMMA", "« , » attendu entre les deux relations"); const right = relName();
      node = { op, left, right, line };
    } else if (op === "JOINTURE") {
      const left = relName(); expect("COMMA", "« , » attendu entre les deux relations"); const right = relName();
      expect("SLASH", "« / » attendu avant la condition de jointure"); const conds = parseJoinCond();
      node = { op, left, right, conds, line };
    } else if (op === "JOINTURE_NATURELLE") {
      const left = relName(); expect("COMMA", "« , » attendu entre les deux relations"); const right = relName();
      node = { op, left, right, line };
    } else if (op === "DIVISION") {
      const left = relName(); expect("COMMA", "« , » attendu entre dividende et diviseur"); const right = relName();
      let dAttrs = null, vAttrs = null;
      if (at("SLASH")) {
        next();
        const all = parseAttrList();
        if (all.length % 2 !== 0) throw new AlgebraError("DIVISION : la liste d'attributs doit se diviser en deux moitiés égales", line);
        dAttrs = all.slice(0, all.length / 2); vAttrs = all.slice(all.length / 2);
      }
      node = { op, left, right, dAttrs, vAttrs, line };
    }
    expect("RPAREN", "parenthèse fermante « ) » attendue");
    return node;
  }

  const assignments = [];
  skipNewlines();
  while (!at("EOF")) {
    const line = peek().line;
    if (peek().type !== "IDENT") throw new AlgebraError("nom de relation attendu en début d'affectation", line);
    const name = next().value;
    if (at("CMP") && peek().value === "=") throw new AlgebraError("utilisez « := » pour l'affectation (et non « = »)", peek().line);
    expect("ASSIGN", "« := » attendu après le nom de la relation");
    const expr = parseExpr(line);
    if (!at("NEWLINE") && !at("EOF")) throw new AlgebraError("fin de ligne attendue (une seule affectation par ligne)", peek().line);
    assignments.push({ name, expr, line });
    skipNewlines();
  }
  if (assignments.length === 0) throw new AlgebraError("aucune affectation : écrivez au moins « R1 := ... »");
  return assignments;
}

// ── Compilateur vers SQL ─────────────────────────────────────────────────────

function col(name) { return { name, norm: norm(name) }; }

function resolve(attr, schema, line, what) {
  const nn = norm(attr);
  const hits = [];
  schema.forEach((c, idx) => { if (c.norm === nn) hits.push(idx); });
  if (hits.length === 0) {
    const avail = schema.map((c) => c.name).join(", ") || "(aucun)";
    throw new AlgebraError(`attribut « ${attr} » introuvable${what ? " " + what : ""}. Attributs disponibles : ${avail}`, line);
  }
  if (hits.length > 1) {
    throw new AlgebraError(`attribut « ${attr} » ambigu (présent ${hits.length} fois, typiquement après une JOINTURE). Renommez-le (RENOMMAGE) ou projetez-le avant de le réutiliser`, line);
  }
  return hits[0];
}

function padTime(t) {
  const [h, m] = t.split(":");
  return `'${h.padStart(2, "0")}:${m}'`;
}
function operandSQL(o) {
  if (o.k === "str") return `'${o.text}'`;
  if (o.k === "num") return o.text;
  return padTime(o.text); // time
}

export function compileAlgebra(programText, catalog) {
  const assignments = parse(tokenize(programText));

  // Index des tables de base (insensible à la casse).
  const baseByNorm = new Map();
  for (const [tname, cols] of Object.entries(catalog || {})) {
    baseByNorm.set(norm(tname), { name: tname, cols });
  }

  const ctes = [];              // { id, body } dans l'ordre de définition
  const env = new Map();        // relnameNorm -> { cte, schema }
  const baseCteByNorm = new Map();
  let ctr = 0;
  const newId = () => `_r${ctr++}`;

  function operandRef(name, line) {
    const nn = norm(name);
    if (env.has(nn)) return env.get(nn);
    if (baseByNorm.has(nn)) {
      if (!baseCteByNorm.has(nn)) {
        const t = baseByNorm.get(nn);
        const id = newId();
        const selects = t.cols.map((c, i) => `${quoteId(c)} AS c${i}`).join(", ");
        ctes.push({ id, body: `SELECT ${selects} FROM ${quoteId(t.name)}` });
        baseCteByNorm.set(nn, { cte: id, schema: t.cols.map(col) });
      }
      return baseCteByNorm.get(nn);
    }
    throw new AlgebraError(`relation « ${name} » non définie (ni base ni relation précédente)`, line);
  }

  function translateCond(cond, schema, line) {
    if (cond.c === "and") return `(${translateCond(cond.l, schema, line)} AND ${translateCond(cond.r, schema, line)})`;
    if (cond.c === "or") return `(${translateCond(cond.l, schema, line)} OR ${translateCond(cond.r, schema, line)})`;
    if (cond.c === "not") return `(NOT ${translateCond(cond.e, schema, line)})`;
    const idx = resolve(cond.attr, schema, line);
    return `c${idx} ${cond.op} ${operandSQL(cond.operand)}`;
  }

  function compileExpr(e) {
    if (e.op === "REF") {
      const o = operandRef(e.rel, e.line);
      return { body: `SELECT * FROM ${o.cte}`, schema: o.schema.slice() };
    }
    if (e.op === "SELECTION") {
      const o = operandRef(e.rel, e.line);
      return { body: `SELECT * FROM ${o.cte} WHERE ${translateCond(e.cond, o.schema, e.line)}`, schema: o.schema.slice() };
    }
    if (e.op === "PROJECTION") {
      const o = operandRef(e.rel, e.line);
      const cols = e.attrs.map((a, j) => `c${resolve(a, o.schema, e.line)} AS c${j}`);
      return { body: `SELECT DISTINCT ${cols.join(", ")} FROM ${o.cte}`, schema: e.attrs.map(col) };
    }
    if (e.op === "RENOMMAGE") {
      const o = operandRef(e.rel, e.line);
      const schema = o.schema.map((c) => ({ name: c.name, norm: c.norm }));
      for (const { from, to } of e.pairs) {
        const idx = resolve(from, schema, e.line, "(RENOMMAGE)");
        schema[idx] = col(to);
      }
      return { body: `SELECT * FROM ${o.cte}`, schema };
    }
    if (e.op === "UNION" || e.op === "INTERSECTION" || e.op === "DIFFERENCE") {
      const L = operandRef(e.left, e.line), R = operandRef(e.right, e.line);
      if (L.schema.length !== R.schema.length) {
        throw new AlgebraError(`${e.op} impossible : ${L.schema.length} attribut(s) à gauche mais ${R.schema.length} à droite (relations non compatibles)`, e.line);
      }
      const kw = e.op === "UNION" ? "UNION" : e.op === "INTERSECTION" ? "INTERSECT" : "EXCEPT";
      return { body: `SELECT * FROM ${L.cte} ${kw} SELECT * FROM ${R.cte}`, schema: L.schema.slice() };
    }
    if (e.op === "JOINTURE") {
      const L = operandRef(e.left, e.line), R = operandRef(e.right, e.line);
      const a = L.schema.length, b = R.schema.length;
      const sel = [];
      for (let k = 0; k < a; k++) sel.push(`t1.c${k} AS c${k}`);
      for (let k = 0; k < b; k++) sel.push(`t2.c${k} AS c${a + k}`);
      const on = e.conds.map((cnd) => {
        const lc = resolve(cnd.la, L.schema, e.line, "(côté gauche de la jointure)");
        const rc = resolve(cnd.ra, R.schema, e.line, "(côté droit de la jointure)");
        return `t1.c${lc} ${cnd.op} t2.c${rc}`;
      }).join(" AND ");
      return { body: `SELECT ${sel.join(", ")} FROM ${L.cte} t1, ${R.cte} t2 WHERE ${on}`, schema: L.schema.concat(R.schema) };
    }
    if (e.op === "JOINTURE_NATURELLE") {
      const L = operandRef(e.left, e.line), R = operandRef(e.right, e.line);
      const lByNorm = new Map(), rByNorm = new Map();
      L.schema.forEach((c, i) => { if (!lByNorm.has(c.norm)) lByNorm.set(c.norm, []); lByNorm.get(c.norm).push(i); });
      R.schema.forEach((c, i) => { if (!rByNorm.has(c.norm)) rByNorm.set(c.norm, []); rByNorm.get(c.norm).push(i); });
      const pairs = []; const rCommon = new Set();
      for (const [nm, lis] of lByNorm) {
        if (!rByNorm.has(nm)) continue;
        const ris = rByNorm.get(nm);
        if (lis.length > 1 || ris.length > 1) {
          throw new AlgebraError(`JOINTURE_NATURELLE : attribut « ${L.schema[lis[0]].name} » présent plusieurs fois, jointure naturelle ambiguë`, e.line);
        }
        pairs.push([lis[0], ris[0]]); rCommon.add(ris[0]);
      }
      if (pairs.length === 0) throw new AlgebraError("JOINTURE_NATURELLE : aucun attribut commun entre les deux relations", e.line);
      const sel = []; let outIdx = 0;
      const schema = L.schema.slice();
      for (let k = 0; k < L.schema.length; k++) sel.push(`t1.c${k} AS c${outIdx++}`);
      for (let k = 0; k < R.schema.length; k++) {
        if (rCommon.has(k)) continue; // attribut commun : conservé une seule fois (côté gauche)
        sel.push(`t2.c${k} AS c${outIdx++}`);
        schema.push(R.schema[k]);
      }
      const on = pairs.map(([li, ri]) => `t1.c${li} = t2.c${ri}`).join(" AND ");
      return { body: `SELECT ${sel.join(", ")} FROM ${L.cte} t1, ${R.cte} t2 WHERE ${on}`, schema };
    }
    if (e.op === "DIVISION") {
      const D = operandRef(e.left, e.line), V = operandRef(e.right, e.line);
      let dMatch, vIdx;
      if (e.dAttrs) {
        dMatch = e.dAttrs.map((a) => resolve(a, D.schema, e.line, "(dividende)"));
        vIdx = e.vAttrs.map((a) => resolve(a, V.schema, e.line, "(diviseur)"));
      } else {
        // Sans liste : les attributs du diviseur (par nom) doivent exister dans le dividende.
        vIdx = V.schema.map((_, i) => i);
        dMatch = V.schema.map((c) => resolve(c.name, D.schema, e.line, "(dividende, division implicite)"));
      }
      if (dMatch.length !== vIdx.length) throw new AlgebraError("DIVISION : nombres d'attributs incompatibles", e.line);
      const quot = D.schema.map((_, i) => i).filter((i) => !dMatch.includes(i));
      if (quot.length === 0) throw new AlgebraError("DIVISION : le quotient serait vide (tous les attributs du dividende servent à la correspondance)", e.line);
      const selQ = quot.map((q, j) => `d1.c${q} AS c${j}`).join(", ");
      const eqQuot = quot.map((q) => `d2.c${q} = d1.c${q}`).join(" AND ");
      const eqMatch = dMatch.map((dm, k) => `d2.c${dm} = v.c${vIdx[k]}`).join(" AND ");
      const body =
        `SELECT DISTINCT ${selQ} FROM ${D.cte} d1 WHERE NOT EXISTS (` +
        `SELECT 1 FROM ${V.cte} v WHERE NOT EXISTS (` +
        `SELECT 1 FROM ${D.cte} d2 WHERE ${eqQuot} AND ${eqMatch}))`;
      return { body, schema: quot.map((q) => D.schema[q]) };
    }
    throw new AlgebraError(`opérateur non géré : ${e.op}`, e.line);
  }

  let last = null;
  for (const asg of assignments) {
    const { body, schema } = compileExpr(asg.expr);
    const id = newId();
    ctes.push({ id, body });
    const entry = { cte: id, schema };
    env.set(norm(asg.name), entry);
    last = entry;
  }

  // SELECT final : renomme c{i} vers les noms d'attributs (dédupliqués - cosmétique).
  const seen = new Map();
  const finalCols = last.schema.map((c, i) => {
    let nm = c.name;
    const key = nm.toLowerCase();
    if (seen.has(key)) { const k = seen.get(key) + 1; seen.set(key, k); nm = `${nm}_${k}`; }
    else seen.set(key, 1);
    return `c${i} AS ${quoteId(nm)}`;
  });
  const sql = `WITH ${ctes.map((c) => `${c.id} AS (${c.body})`).join(",\n")}\nSELECT ${finalCols.join(", ")} FROM ${last.cte}`;
  return { sql, finalSchema: last.schema.map((c) => c.name) };
}

function quoteId(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// autocomplete.js - autocomplétion contextuelle de l'éditeur de requêtes, sans dépendance.
//
// Candidats tirés du schéma réel de la base (tables + colonnes, via engine.getSchema())
// et des mots-clés SQL / opérateurs d'algèbre. Contextuelle :
//   - SQL : après FROM/JOIN -> tables ; « alias. » ou « table. » -> colonnes de cette table ;
//           ailleurs -> colonnes puis tables puis mots-clés.
//   - Algèbre : après « / » -> attributs (+ ET/OU/NON) ; après « ( » ou « , » -> relations ;
//               début d'expression / après « := » -> opérateurs.
//
// La logique de suggestion (suggest, buildAliasMap) est PURE (pas de DOM) et testée par
// scripts/test-autocomplete.mjs. Le reste (popup, position du curseur) est du DOM.

const SQL_KEYWORDS = [
  "SELECT", "DISTINCT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC",
  "AND", "OR", "NOT", "IN", "EXISTS", "IS", "NULL", "LIKE", "BETWEEN", "AS", "ON", "USING",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL",
  "UNION", "INTERSECT", "EXCEPT", "ALL", "ANY", "CASE", "WHEN", "THEN", "ELSE", "END",
  "WITH", "RECURSIVE", "LIMIT", "OFFSET",
];
const SQL_FUNCTIONS = ["COUNT", "SUM", "AVG", "MIN", "MAX", "ROUND", "COALESCE",
  "UPPER", "LOWER", "LENGTH", "SUBSTR"];
// Dans la clause FROM : après FROM/JOIN/virgule on attend une TABLE ; après un nom de
// table on propose les mots-clés de jointure / la clause suivante (pas SELECT, WHERE placé
// ici pour enchaîner). Évite de noyer la liste des tables sous tous les mots-clés.
const SQL_TABLE_EXPECTING = ["FROM", "JOIN", ","];
const SQL_AFTER_TABLE = ["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS",
  "NATURAL", "ON", "WHERE", "GROUP", "ORDER", "HAVING"];
// Mots-clés utiles en POSITION D'EXPRESSION (SELECT, WHERE...) : modificateurs et
// opérateurs, mais PAS les démarreurs de clause (SELECT/FROM/WHERE/GROUP...).
const SQL_EXPR_KW = ["DISTINCT", "AS", "AND", "OR", "NOT", "IN", "EXISTS", "IS", "NULL",
  "LIKE", "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "END"];
// Dans une condition (WHERE/ON/HAVING) : après un opérande (colonne ou agrégat) ->
// comparateurs + prédicats ; après une valeur -> connecteurs logiques.
const SQL_COMPARATORS = ["=", "<>", "<", ">", "<=", ">="];
const SQL_PREDICATE_KW = ["IN", "LIKE", "BETWEEN", "IS", "NOT"];
const SQL_CONNECTORS = ["AND", "OR"];
const SQL_FUNCS_SET = new Set(SQL_FUNCTIONS);
// Opérateurs relationnels seulement (proposés en début d'expression). Les connecteurs
// ET/OU/NON ne sont PAS complétés : ils ne peuvent pas ouvrir une condition (on commence
// par un attribut) et sont assez courts pour être tapés à la main.
const ALGEBRA_OPERATORS = [
  "SELECTION", "PROJECTION", "RENOMMAGE", "UNION", "INTERSECTION", "DIFFERENCE",
  "JOINTURE", "JOINTURE_NATURELLE", "DIVISION",
];

const IDENT = "[A-Za-z_\\u00C0-\\u024F][A-Za-z0-9_\\u00C0-\\u024F]*";
const TRAILING_WORD = new RegExp(IDENT + "$");
// Démarreurs de CLAUSE uniquement (pas les opérateurs AND/OR/IN/LIKE...) : lastClauseKeyword
// doit donner la clause qui gouverne le curseur (WHERE...), pas le dernier opérateur tapé.
const CLAUSE_KW = new RegExp(
  "\\b(SELECT|FROM|WHERE|JOIN|ON|GROUP|ORDER|HAVING|BY|SET|VALUES|UNION|EXCEPT|INTERSECT|WITH)\\b",
  "gi");

// ── Logique de suggestion (pure) ─────────────────────────────────────────────

export function buildAliasMap(sql) {
  const map = {};
  let m;
  const joinRe = new RegExp("\\bJOIN\\s+(" + IDENT + ")(?:\\s+(?:AS\\s+)?(" + IDENT + "))?", "gi");
  while ((m = joinRe.exec(sql)) !== null) map[(m[2] || m[1]).toLowerCase()] = m[1];
  const fromRe = new RegExp(
    "\\bFROM\\s+([\\s\\S]+?)(?=\\bWHERE\\b|\\bGROUP\\b|\\bORDER\\b|\\bHAVING\\b|\\bLIMIT\\b|" +
    "\\bUNION\\b|\\bEXCEPT\\b|\\bINTERSECT\\b|\\bJOIN\\b|\\bON\\b|$)", "gi");
  const itemRe = new RegExp("^\\s*(" + IDENT + ")(?:\\s+(?:AS\\s+)?(" + IDENT + "))?");
  while ((m = fromRe.exec(sql)) !== null) {
    for (const item of m[1].split(",")) {
      const tm = itemRe.exec(item.trim());
      if (tm) map[(tm[2] || tm[1]).toLowerCase()] = tm[1];
    }
  }
  return map;
}

function resolveTable(qualifier, sql, schema) {
  const map = buildAliasMap(sql);
  const q = qualifier.toLowerCase();
  const target = (map[q] || qualifier).toLowerCase();
  return (schema.tables || []).find((t) => t.toLowerCase() === target) || null;
}

// Colonnes des tables présentes dans le FROM/JOIN de la requête (null si aucun FROM).
function inScopeColumns(sql, schema) {
  const inScope = new Set(Object.values(buildAliasMap(sql)).map((t) => t.toLowerCase()));
  if (!inScope.size) return null;
  const cols = [], seen = new Set();
  for (const t of (schema.tables || [])) {
    if (!inScope.has(t.toLowerCase())) continue;
    for (const c of (schema.columns[t] || [])) {
      const k = c.toLowerCase();
      if (!seen.has(k)) { seen.add(k); cols.push(c); }
    }
  }
  return cols.length ? cols : null;
}

// Le jeton `name` est-il une colonne (en portée du FROM, sinon de la base) ?
function isInScopeColumn(name, sql, schema) {
  const scoped = inScopeColumns(sql, schema) || schema.allColumns || [];
  const nl = String(name).toLowerCase();
  return scoped.some((c) => c.toLowerCase() === nl);
}

// Le texte se termine-t-il par un appel de fonction FONC(...) (agrégat/scalaire) ?
// Distingue « COUNT(*) » (opérande) de « IN (...) » / « (a OR b) » (prédicat/groupe fermé).
function closesFunctionCall(text) {
  const t = text.replace(/\s+$/, "");
  if (!t.endsWith(")")) return false;
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === ")") depth++;
    else if (t[i] === "(") {
      depth--;
      if (depth === 0) {
        const fm = /[A-Za-z_][A-Za-z0-9_]*$/.exec(t.slice(0, i).replace(/\s+$/, ""));
        return fm ? SQL_FUNCS_SET.has(fm[0].toUpperCase()) : false;
      }
    }
  }
  return false;
}

// Texte des niveaux de requête ENGLOBANT le curseur : retire les (...) « sœurs »
// (équilibrées, ne contenant pas le curseur) pour ne pas mélanger les portées d'un
// sous-requête sœur avec la requête courante. Conserve les niveaux englobants.
function scopeText(text, cursor) {
  let out = "", i = 0;
  while (i < text.length) {
    if (text[i] === "(") {
      let depth = 0, j = i;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") { depth--; if (depth === 0) break; }
      }
      const close = j < text.length ? j : text.length; // ')' ou fin si non équilibré
      if (cursor > i && cursor <= close) {
        out += " " + scopeText(text.slice(i + 1, close), cursor - (i + 1)); // curseur dedans
      } else {
        out += " "; // groupe sœur -> retiré
      }
      i = close + 1;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

function lastClauseKeyword(text) {
  let last = null, m;
  CLAUSE_KW.lastIndex = 0;
  while ((m = CLAUSE_KW.exec(text)) !== null) last = m[1].toUpperCase();
  return last;
}

// Dernier jeton avant le mot en cours : identifiant (MAJ) ou ponctuation (« , » « ( »…).
function prevToken(textBeforeWord) {
  const t = textBeforeWord.replace(/\s+$/, "");
  const wm = /[A-Za-z_][A-Za-z0-9_]*$/.exec(t);
  return wm ? wm[0].toUpperCase() : t.slice(-1);
}

// Relations et attributs proposés en MAJUSCULES (SQLite et le compilateur d'algèbre
// sont insensibles à la casse) ; les mots-clés/opérateurs sont déjà en majuscules.
const upTables = (schema) => (schema.tables || []).map((x) => ({ label: x.toUpperCase(), kind: "table" }));
const upCols = (list) => (list || []).map((x) => ({ label: x.toUpperCase(), kind: "col" }));

function sqlCandidates(textBefore, start, qualifier, schema, fullText) {
  const src = fullText || textBefore; // le FROM peut être APRÈS le curseur (liste du SELECT)
  // Portée : uniquement les niveaux de requête englobant le curseur (pas les sous-requêtes sœurs).
  const scope = scopeText(src, textBefore.length);
  if (qualifier) {
    const table = resolveTable(qualifier, scope, schema);
    const list = table && schema.columns[table] ? schema.columns[table] : (schema.allColumns || []);
    return upCols(list);
  }
  const beforeCur = textBefore.slice(0, start);
  // Contexte de clause déterminé au niveau ENGLOBANT (sous-requêtes sœurs retirées), sinon
  // un FROM de sous-requête fausserait le contexte de la requête courante.
  const ctx = lastClauseKeyword(scopeText(beforeCur, beforeCur.length));
  const pt = prevToken(beforeCur); // brut : voit le ')' d'une sous-requête / d'une fonction
  if (ctx === "FROM" || ctx === "JOIN") {
    // Après FROM/JOIN/virgule -> une table ; après un nom de table -> mots-clés de jointure.
    if (SQL_TABLE_EXPECTING.includes(pt)) return upTables(schema);
    return SQL_AFTER_TABLE.map((x) => ({ label: x, kind: "kw" }));
  }
  const scopedCols = () => upCols(inScopeColumns(scope, schema) || schema.allColumns);

  // Conditions (WHERE / ON / HAVING).
  if (ctx === "WHERE" || ctx === "ON" || ctx === "HAVING") {
    // Après un opérande (colonne ou fin d'appel de fonction) -> comparateur / prédicat.
    if (isInScopeColumn(pt, scope, schema) || closesFunctionCall(beforeCur)) {
      return [...SQL_COMPARATORS.map((x) => ({ label: x, kind: "op" })),
              ...SQL_PREDICATE_KW.map((x) => ({ label: x, kind: "kw" }))];
    }
    // Après une valeur, ou une parenthèse fermante non-fonction (fin de IN(...) / sous-requête
    // / sous-condition) -> connecteurs logiques AND/OR.
    if (pt === "'" || pt === "NULL" || /^[0-9]/.test(pt) || pt === ")") {
      return SQL_CONNECTORS.map((x) => ({ label: x, kind: "kw" }));
    }
    // Sinon (début, après opérateur/AND/OR...) -> opérande : colonnes + fonctions.
    return [...scopedCols(), ...SQL_FUNCTIONS.map((x) => ({ label: x, kind: "kw" }))];
  }

  // GROUP BY / ORDER BY : colonnes + fonctions + ASC/DESC (pas DISTINCT/AS/connecteurs).
  if (ctx === "BY") {
    const kw = [...SQL_FUNCTIONS, "ASC", "DESC"].map((x) => ({ label: x, kind: "kw" }));
    return [...scopedCols(), ...kw];
  }

  // SELECT et autres positions d'expression : colonnes + fonctions + mots-clés d'expression.
  const kw = [...SQL_FUNCTIONS, ...SQL_EXPR_KW].map((x) => ({ label: x, kind: "kw" }));
  return [...scopedCols(), ...kw];
}

function algebraCandidates(textBefore, start, schema) {
  const tables = upTables(schema);
  const cols = upCols(schema.allColumns);
  const ops = ALGEBRA_OPERATORS.map((x) => ({ label: x, kind: "kw" }));
  const before = textBefore.slice(0, start);
  const trimmed = before.replace(/\s+$/, "");
  if (trimmed === "" || trimmed.endsWith(":=")) return ops;
  let j = start - 1;
  while (j >= 0 && /\s/.test(textBefore[j])) j--;
  const prev = j >= 0 ? textBefore[j] : "";
  // Après un comparateur ou la flèche « -> » de RENOMMAGE : valeur / nouveau nom (saisie libre).
  if (prev === ">" || prev === "<" || prev === "=") return [];
  if (prev === "/") {
    // Attributs de la relation en cours (pas toutes les tables) ; repli si indéterminé.
    const attrs = contextAttributes(before, schema);
    const list = attrs && attrs.length ? attrs : (schema.allColumns || []);
    return list.map((x) => ({ label: x.toUpperCase(), kind: "col" }));
  }
  if (prev === "(" || prev === ",") {
    // Opérande : relation de base OU relation intermédiaire (Rn) déjà définie.
    const rels = definedRelations(before, schema).names.map((n) => ({ label: n.toUpperCase(), kind: "rel" }));
    return [...tables, ...rels];
  }
  return [...ops, ...tables, ...cols];
}

// Opérateur (et nombre de virgules de premier niveau) de la parenthèse englobant la
// fin de `before` — pour savoir quel séparateur suit une relation/attribut.
function enclosingOperator(before) {
  let depth = 0, openIdx = -1;
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i] === ")") depth++;
    else if (before[i] === "(") { if (depth === 0) { openIdx = i; break; } depth--; }
  }
  if (openIdx < 0) return null;
  let j = openIdx - 1;
  while (j >= 0 && /\s/.test(before[j])) j--;
  const m = /[A-Za-z_]+$/.exec(before.slice(0, j + 1));
  let commas = 0, d = 0;
  for (let i = openIdx + 1; i < before.length; i++) {
    if (before[i] === "(") d++;
    else if (before[i] === ")") d--;
    else if (before[i] === "," && d === 0) commas++;
  }
  return { op: m ? m[0].toUpperCase() : null, commas, openIdx };
}

// ── Suivi du schéma des relations (pour proposer les attributs du bon opérande) ──

function topLevelIndex(s, ch) {
  let depth = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "'") { if (s[i + 1] === "'") { i++; continue; } inStr = false; } }
    else if (c === "'") inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(s, ch) {
  const parts = [];
  let depth = 0, inStr = false, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "'") { if (s[i + 1] === "'") { i++; continue; } inStr = false; } }
    else if (c === "'") inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ch && depth === 0) { parts.push(s.slice(last, i)); last = i + 1; }
  }
  parts.push(s.slice(last));
  return parts;
}

// Colonnes d'une relation : table de base OU relation intermédiaire déjà définie.
function relationSchema(name, rels, baseSchema) {
  if (!name) return null;
  const nl = name.trim().toLowerCase();
  if (rels[nl]) return rels[nl];
  const t = (baseSchema.tables || []).find((x) => x.toLowerCase() === nl);
  return t ? (baseSchema.columns[t] || []) : null;
}

// Schéma résultant d'une expression algébrique (approché, pour l'autocomplétion).
function exprSchema(expr, rels, baseSchema) {
  const m = /^\s*([A-Za-z_]+)\s*\(([\s\S]*)\)\s*$/.exec(expr);
  if (!m) {
    const nm = /^\s*([A-Za-z_][\w.'-]*)\s*$/.exec(expr);
    return nm ? relationSchema(nm[1], rels, baseSchema) : null;
  }
  const op = m[1].toUpperCase();
  const inner = m[2];
  const slash = topLevelIndex(inner, "/");
  const operandsPart = slash >= 0 ? inner.slice(0, slash) : inner;
  const rest = slash >= 0 ? inner.slice(slash + 1) : "";
  const operands = splitTopLevel(operandsPart, ",").map((s) => s.trim()).filter(Boolean);
  const sch = (n) => relationSchema(n, rels, baseSchema) || [];
  if (op === "SELECTION") return sch(operands[0]);
  if (op === "PROJECTION") return splitTopLevel(rest, ",").map((s) => s.trim()).filter(Boolean);
  if (op === "RENOMMAGE") {
    const renames = {};
    for (const pair of splitTopLevel(rest, ",")) {
      const pm = /([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)/.exec(pair);
      if (pm) renames[pm[1].toLowerCase()] = pm[2];
    }
    return sch(operands[0]).map((c) => renames[c.toLowerCase()] || c);
  }
  if (op === "UNION" || op === "INTERSECTION" || op === "DIFFERENCE") return sch(operands[0]);
  if (op === "JOINTURE") return [...sch(operands[0]), ...sch(operands[1])];
  if (op === "JOINTURE_NATURELLE") {
    const a = sch(operands[0]), b = sch(operands[1]);
    const seen = new Set(a.map((c) => c.toLowerCase()));
    return [...a, ...b.filter((c) => !seen.has(c.toLowerCase()))];
  }
  if (op === "DIVISION") {
    const rm = new Set(sch(operands[1]).map((c) => c.toLowerCase()));
    return sch(operands[0]).filter((c) => !rm.has(c.toLowerCase()));
  }
  return null;
}

// Relations intermédiaires définies avant la ligne courante : { schemas:{lower:cols}, names:[] }.
function definedRelations(textBefore, baseSchema) {
  const schemas = {}, names = [];
  const lines = textBefore.split("\n");
  for (let i = 0; i < lines.length - 1; i++) { // sauf la ligne en cours de frappe
    const am = /^\s*([A-Za-z_][\w.'-]*)\s*:=\s*([\s\S]+)$/.exec(lines[i]);
    if (!am) continue;
    const sch = exprSchema(am[2], schemas, baseSchema);
    if (sch) schemas[am[1].toLowerCase()] = sch;
    names.push(am[1]);
  }
  return { schemas, names };
}

// Attributs disponibles à l'endroit du curseur (après « / »), = schéma du/des opérande(s)
// de l'opérateur courant. null si indéterminé (→ repli sur toutes les colonnes).
export function contextAttributes(textBefore, baseSchema) {
  const { schemas } = definedRelations(textBefore, baseSchema);
  const info = enclosingOperator(textBefore);
  if (!info || info.openIdx < 0) return null;
  const afterOpen = textBefore.slice(info.openIdx + 1);
  const slash = topLevelIndex(afterOpen, "/");
  const operandsPart = slash >= 0 ? afterOpen.slice(0, slash) : afterOpen;
  const operands = splitTopLevel(operandsPart, ",").map((s) => s.trim()).filter(Boolean);
  const sch = (n) => relationSchema(n, schemas, baseSchema) || [];
  // JOINTURE : la condition peut porter sur les attributs des DEUX relations.
  if (info.op === "JOINTURE") return [...sch(operands[0]), ...sch(operands[1])];
  return sch(operands[0]);
}

const AL_UNARY = ["SELECTION", "PROJECTION", "RENOMMAGE"];
const AL_BINARY = ["UNION", "INTERSECTION", "DIFFERENCE", "JOINTURE", "JOINTURE_NATURELLE", "DIVISION"];

// Séparateur inséré après une relation/attribut accepté en algèbre :
//   relation d'un opérateur unaire -> « / » ; 1re relation d'un binaire -> « , » ;
//   2e relation d'une JOINTURE -> « / » ; attribut (ancien nom) dans RENOMMAGE -> « -> ».
export function algebraAcceptSuffix(before, kind) {
  const info = enclosingOperator(before);
  if (!info || !info.op) return "";
  if (kind === "table") {
    if (AL_UNARY.includes(info.op)) return "/";
    if (AL_BINARY.includes(info.op)) {
      if (info.commas === 0) return ", ";
      if (info.op === "JOINTURE") return " / ";
    }
    return "";
  }
  if (kind === "col" && info.op === "RENOMMAGE") return " -> ";
  return "";
}

// Sur appel explicite (Ctrl+Espace) : si le mot sous le curseur est une relation/attribut
// DÉJÀ complet, à une position où un séparateur suit, renvoie ce séparateur (sinon "").
export function pendingSeparator(textBefore, schema) {
  const wm = TRAILING_WORD.exec(textBefore);
  if (!wm) return "";
  const word = wm[0];
  const start = textBefore.length - word.length;
  let j = start - 1;
  while (j >= 0 && /\s/.test(textBefore[j])) j--;
  const prev = j >= 0 ? textBefore[j] : "";
  let kind = null;
  if (prev === "(" || prev === ",") kind = "table";
  else if (prev === "/") kind = "col";
  else return "";
  const wl = word.toLowerCase();
  const list = kind === "table" ? (schema.tables || []) : (schema.allColumns || []);
  if (!list.some((x) => x.toLowerCase() === wl)) return "";
  return algebraAcceptSuffix(textBefore.slice(0, start), kind);
}

// Décision d'un déclenchement de complétion, testable sans DOM :
//   { type:"separator", text } : insère directement le séparateur (nom déjà complet) ;
//   { type:"list", start, word, items } : affiche la popup ; { type:"none" }.
export function completionAction(mode, textBefore, schema, force = false, fullText = null) {
  if (inString(textBefore)) return { type: "none" };
  if (force && mode === "algebra") {
    const sep = pendingSeparator(textBefore, schema);
    if (sep) return { type: "separator", text: sep };
  }
  const res = suggest(mode, textBefore, schema, force, fullText);
  if (!res.items.length) return { type: "none" };
  return { type: "list", start: res.start, word: res.word, items: res.items };
}

// Vrai si le curseur est dans une chaîne « non fermée » (échappement SQL '' géré).
function inString(text) {
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "'") continue;
    if (inStr && text[i + 1] === "'") { i++; continue; } // '' échappé
    inStr = !inStr;
  }
  return inStr;
}

// Renvoie { start, word, items:[{label, kind}] } ; items filtrés par préfixe (casse ignorée).
export function suggest(mode, textBefore, schema, force = false, fullText = null) {
  if (inString(textBefore)) return { start: textBefore.length, word: "", items: [] };
  const wm = TRAILING_WORD.exec(textBefore);
  const word = wm ? wm[0] : "";
  const start = textBefore.length - word.length;
  let qualifier = null;
  if (start >= 1 && textBefore[start - 1] === ".") {
    const qm = TRAILING_WORD.exec(textBefore.slice(0, start - 1));
    if (qm) qualifier = qm[0];
  }
  if (!force && !qualifier && word.length < 1) return { start, word, items: [] };
  const raw = mode === "algebra"
    ? algebraCandidates(textBefore, start, schema)
    : sqlCandidates(textBefore, start, qualifier, schema, fullText);
  const w = word.toLowerCase();
  const seen = new Set();
  const items = [];
  for (const it of raw) {
    const low = it.label.toLowerCase();
    if (!low.startsWith(w)) continue;
    if (low === w && !qualifier) continue; // mot déjà tapé en entier : rien à proposer
    if (seen.has(low)) continue;
    seen.add(low);
    items.push(it);
    if (items.length >= 40) break;
  }
  return { start, word, items };
}

// ── Popup (DOM) ──────────────────────────────────────────────────────────────

const KIND_LABEL = { table: "table", rel: "relation", col: "colonne", kw: "mot-clé", op: "opérateur" };

// Coordonnées (px) du curseur dans le textarea, via un div-miroir.
function caretCoords(textarea, position) {
  const div = document.createElement("div");
  const s = getComputedStyle(textarea);
  const props = ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom",
    "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
    "borderLeftWidth", "fontStyle", "fontVariant", "fontWeight", "fontStretch",
    "fontSize", "fontFamily", "lineHeight", "letterSpacing", "textAlign",
    "textTransform", "wordSpacing", "tabSize"];
  for (const p of props) div.style[p] = s[p];
  Object.assign(div.style, {
    position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap",
    wordWrap: "break-word", overflow: "hidden", top: "0", left: "0",
  });
  div.textContent = textarea.value.slice(0, position);
  const span = document.createElement("span");
  span.textContent = textarea.value.slice(position) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const top = span.offsetTop + (parseInt(s.borderTopWidth) || 0);
  const left = span.offsetLeft + (parseInt(s.borderLeftWidth) || 0);
  const height = parseInt(s.lineHeight) || Math.round((parseInt(s.fontSize) || 14) * 1.3);
  document.body.removeChild(div);
  return { top, left, height };
}

export function attachAutocomplete(textarea, opts) {
  const popup = document.createElement("ul");
  popup.className = "ac-popup";
  popup.style.display = "none";
  document.body.appendChild(popup);
  let items = [], active = -1, anchorStart = 0;

  const isOpen = () => popup.style.display !== "none";
  function close() { popup.style.display = "none"; items = []; active = -1; }

  function render() {
    popup.replaceChildren();
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = "ac-item" + (i === active ? " ac-active" : "");
      const label = document.createElement("span");
      label.className = "ac-label"; label.textContent = it.label;
      const kind = document.createElement("span");
      kind.className = "ac-kind ac-kind-" + it.kind; kind.textContent = KIND_LABEL[it.kind] || it.kind;
      li.append(label, kind);
      li.addEventListener("mousedown", (e) => { e.preventDefault(); accept(i); });
      popup.appendChild(li);
    });
    const cur = popup.children[active];
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function position() {
    const c = caretCoords(textarea, textarea.selectionStart);
    const r = textarea.getBoundingClientRect();
    popup.style.left = (window.scrollX + r.left + c.left - textarea.scrollLeft) + "px";
    popup.style.top = (window.scrollY + r.top + c.top - textarea.scrollTop + c.height) + "px";
  }

  function update(force = false) {
    if (textarea.selectionStart !== textarea.selectionEnd) return close();
    const pos = textarea.selectionStart;
    const act = completionAction(opts.getMode(), textarea.value.slice(0, pos), opts.getSchema(), force, textarea.value);
    if (act.type === "none") return close();
    if (act.type === "separator") {
      // Nom déjà complet : on insère directement le séparateur, sans proposer le mot lui-même.
      textarea.value = textarea.value.slice(0, pos) + act.text + textarea.value.slice(pos);
      textarea.selectionStart = textarea.selectionEnd = pos + act.text.length;
      close();
      if (opts.onInsert) opts.onInsert();
      return;
    }
    items = act.items; anchorStart = act.start; active = 0;
    render();
    popup.style.display = "block";
    position();
  }

  function accept(i) {
    if (i < 0 || i >= items.length) return;
    const pos = textarea.selectionStart;
    let insert = items[i].label;
    // En algèbre, insérer une relation/attribut ajoute le séparateur attendu (/, ->, virgule),
    // de sorte que l'appel de complétion suivant propose la suite (attributs, nouveau nom...).
    if (opts.getMode() === "algebra") {
      insert += algebraAcceptSuffix(textarea.value.slice(0, anchorStart), items[i].kind);
    }
    textarea.value = textarea.value.slice(0, anchorStart) + insert + textarea.value.slice(pos);
    textarea.selectionStart = textarea.selectionEnd = anchorStart + insert.length;
    close();
    textarea.focus();
    if (opts.onInsert) opts.onInsert();
  }

  function handleKeydown(e) {
    if (!isOpen()) {
      if ((e.ctrlKey || e.metaKey) && (e.key === " " || e.code === "Space")) {
        e.preventDefault(); update(true); return true;
      }
      return false;
    }
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); active = (active + 1) % items.length; render(); return true;
      case "ArrowUp": e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); return true;
      case "Enter":
        if (e.ctrlKey || e.metaKey) { close(); return false; } // Ctrl+Entrée : exécuter
        e.preventDefault(); accept(active); return true;
      case "Tab": e.preventDefault(); accept(active); return true;
      case "Escape": e.preventDefault(); close(); return true;
      default: return false;
    }
  }

  textarea.addEventListener("input", () => update(false));
  textarea.addEventListener("blur", () => setTimeout(close, 120));
  return { handleKeydown, update, close, isOpen };
}

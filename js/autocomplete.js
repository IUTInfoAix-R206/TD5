// autocomplete.js - autocomplétion contextuelle de l'éditeur de requêtes, sans dépendance.
//
// Candidats tirés du schéma réel de la base (tables + colonnes, via engine.getSchema())
// et des mots-clés SQL / opérateurs d'algèbre. Contextuelle :
//   - SQL : après FROM/JOIN -> tables ; « alias. » ou « table. » -> colonnes de cette table ;
//           ailleurs -> colonnes puis tables puis mots-clés.
//   - Algèbre : après « := » ou « = » d'affectation -> opérateurs ; opérandes (avant « / »)
//               -> relations ; après « / » -> attributs de l'opérande, à chaque élément d'une
//               liste (« , ») et dans les conditions (après ET/OU/NON, « ( », un comparateur) ;
//               après une comparaison complète -> ET/OU. Voir algebraContext.
//   Le filtrage par préfixe ignore casse et accents (« sel » propose SÉLECTION).
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
// Opérateurs relationnels (proposés en début d'expression). Les connecteurs ET/OU ne
// sont proposés qu'après une comparaison complète (jamais pour ouvrir une condition).
// Graphie française (accentuée), acceptée par le compilateur comme la forme sans accent.
const ALGEBRA_OPERATORS = [
  "SÉLECTION", "PROJECTION", "RENOMMAGE", "UNION", "INTERSECTION", "DIFFÉRENCE",
  "JOINTURE", "JOINTURE_NATURELLE", "DIVISION",
];
// Minuscules sans accent : comparaison insensible à la casse et aux accents.
const fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const OP_WORD = "[A-Za-z_\\u00C0-\\u024F]+";
// Ligne d'affectation dont l'expression n'est pas commencée : « R1 := » ou « R1 = ».
const ASSIGN_START = /^\s*[A-Za-z_\u00C0-\u024F][\w.\u00C0-\u024F]*\s*:?=\s*$/;

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
  const before = textBefore.slice(0, start);
  const ctx = algebraContext(before, schema);
  const kw = (list) => list.map((x) => ({ label: x, kind: "kw" }));
  switch (ctx.zone) {
    case "expr": return kw(ALGEBRA_OPERATORS);
    case "relation": {
      // Opérande : relation de base OU relation intermédiaire (Rn) déjà définie.
      const rels = definedRelations(before, schema).names.map((n) => ({ label: n.toUpperCase(), kind: "rel" }));
      return [...upTables(schema), ...rels];
    }
    case "attribute": return upCols(ctx.attrs);
    case "connector": return kw(ctx.connectors);
    default: return []; // nom de relation à affecter, nouveau nom (RENOMMAGE), après un attribut…
  }
}

// Jetons d'un fragment d'algèbre (chaînes, heures, nombres, mots, symboles).
const ALG_TOKEN = /'[^']*'|\d{1,2}:\d{2}|\d+(?:\.\d+)?|[A-Za-z_À-ɏ][\w.À-ɏ]*|->|<=|>=|<>|!=|=|<|>|\S/g;
const isCmp = (t) => /^(<=|>=|<>|!=|=|<|>)$/.test(t || "");
const isWord = (t) => /^[A-Za-z_À-ɏ]/.test(t || "");
const BOOL_KW = new Set(["ET", "OU", "NON"]);
const isBool = (t) => isWord(t) && BOOL_KW.has(fold(t).toUpperCase());
const OPERATOR_SET = new Set(ALGEBRA_OPERATORS.map((x) => fold(x).toUpperCase()));

// Parenthèse d'opérateur englobant la fin de `before` (sur la ligne courante) :
// la plus intérieure des parenthèses non fermées précédée d'un opérateur (les
// parenthèses d'une sous-condition de SÉLECTION sont traversées). Chaînes ignorées.
function enclosingOperator(before) {
  const lineStart = before.lastIndexOf("\n") + 1;
  const stack = [];
  let inStr = false;
  for (let i = lineStart; i < before.length; i++) {
    const c = before[i];
    if (inStr) { if (c === "'") inStr = false; continue; }
    if (c === "'") inStr = true;
    else if (c === "(") stack.push(i);
    else if (c === ")") stack.pop();
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const openIdx = stack[k];
    const m = new RegExp("(" + OP_WORD + ")\\s*$").exec(before.slice(lineStart, openIdx));
    const op = m ? fold(m[1]).toUpperCase() : null;
    if (!op || !OPERATOR_SET.has(op)) continue;
    const inner = before.slice(openIdx + 1);
    const slash = topLevelIndex(inner, "/");
    const operandsPart = slash >= 0 ? inner.slice(0, slash) : inner;
    const commas = splitTopLevel(operandsPart, ",").length - 1;
    return { op, commas, openIdx, slash: slash >= 0 ? openIdx + 1 + slash : -1 };
  }
  return null;
}

// Contexte du curseur en algèbre (`before` = texte jusqu'au début du mot en cours) :
//   { zone: "name" }                 nom de la relation affectée (début de ligne) ;
//   { zone: "expr" }                 après « := » / « = » : opérateur ;
//   { zone: "relation", info }       opérande d'un opérateur (avant « / ») ;
//   { zone: "attribute", attrs }     attribut de l'opérande (liste, condition, côté droit
//                                    d'une comparaison, ancien nom de RENOMMAGE) ;
//   { zone: "connector", connectors} après une comparaison complète : ET / OU ;
//   { zone: "none" }                 saisie libre (nouveau nom, comparateur attendu…).
export function algebraContext(before, baseSchema) {
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if (/^\s*$/.test(line)) return { zone: "name" };
  if (ASSIGN_START.test(line)) return { zone: "expr" };
  const info = enclosingOperator(before);
  if (!info) return { zone: "none" };
  if (info.slash < 0) return { zone: "relation", info };
  const attrs = operandAttributes(before, info, baseSchema);
  const toks = before.slice(info.slash + 1).match(ALG_TOKEN) || [];
  const last = toks[toks.length - 1], prev = toks[toks.length - 2];
  const attribute = { zone: "attribute", attrs };
  const none = { zone: "none" };
  if (info.op === "PROJECTION" || info.op === "DIVISION") {
    return !last || last === "," ? attribute : none;
  }
  if (info.op === "RENOMMAGE") {
    return !last || last === "," ? attribute : none; // après « -> » : nouveau nom, libre
  }
  if (info.op === "SELECTION" || info.op === "JOINTURE") {
    // Début de condition, après ET/OU/NON, « ( » ou un comparateur : un attribut.
    if (!last || last === "(" || isBool(last) || isCmp(last)) return attribute;
    // Après une comparaison complète (valeur, attribut comparé, sous-condition fermée).
    const value = last.startsWith("'") || /^\d/.test(last) || (isWord(last) && isCmp(prev));
    if (value || last === ")") {
      return { zone: "connector", connectors: info.op === "JOINTURE" ? ["ET"] : ["ET", "OU"] };
    }
  }
  return none;
}

// Attributs utilisables dans la partie « / … » de l'opérateur `info`.
function operandAttributes(before, info, baseSchema) {
  const { schemas } = definedRelations(before, baseSchema);
  const end = info.slash >= 0 ? info.slash : before.length;
  const operands = splitTopLevel(before.slice(info.openIdx + 1, end), ",").map((s) => s.trim()).filter(Boolean);
  const sch = (n) => relationSchema(n, schemas, baseSchema) || [];
  // JOINTURE (condition) et DIVISION (liste) portent sur les attributs des DEUX relations.
  const list = info.op === "JOINTURE" || info.op === "DIVISION"
    ? [...sch(operands[0]), ...sch(operands[1])] : sch(operands[0]);
  return list.length ? list : (baseSchema.allColumns || []);
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
  const m = new RegExp("^\\s*(" + OP_WORD + ")\\s*\\(([\\s\\S]*)\\)\\s*$").exec(expr);
  if (!m) {
    const nm = /^\s*([A-Za-z_][\w.'-]*)\s*$/.exec(expr);
    return nm ? relationSchema(nm[1], rels, baseSchema) : null;
  }
  const op = fold(m[1]).toUpperCase();
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
      const pm = new RegExp("(" + IDENT + ")\\s*->\\s*(" + IDENT + ")").exec(pair);
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
    const am = /^\s*([A-Za-z_\u00C0-\u024F][\w.'\u00C0-\u024F-]*)\s*:?=\s*([\s\S]+)$/.exec(lines[i]);
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
  const info = enclosingOperator(textBefore);
  if (!info) return null;
  return operandAttributes(textBefore, { ...info, slash: info.slash >= 0 ? info.slash : textBefore.length }, baseSchema);
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
  const before = textBefore.slice(0, textBefore.length - word.length);
  const ctx = algebraContext(before, schema);
  let kind, list;
  if (ctx.zone === "relation") {
    kind = "table";
    list = [...(schema.tables || []), ...definedRelations(before, schema).names];
  } else if (ctx.zone === "attribute") {
    kind = "col"; list = ctx.attrs;
  } else return "";
  const wl = fold(word);
  if (!list.some((x) => fold(x) === wl)) return "";
  return algebraAcceptSuffix(before, kind);
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
  const w = fold(word);
  const seen = new Set();
  const items = [];
  for (const it of raw) {
    const low = fold(it.label);
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

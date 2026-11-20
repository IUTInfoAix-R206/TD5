// oracle-compat.js - couche de compatibilité Oracle → SQLite (navigateur).
//
// Les pages web des TD simulent Oracle, SGBD du cours, avec SQLite (sql.js). Ce module
// est la moitié JavaScript d'un JUMEAU : scripts/oracle_compat.py implémente exactement
// la même traduction et les mêmes fonctions pour le générateur, qui précalcule les
// empreintes attendues. Toute modification doit être répercutée des deux côtés ; la
// parité est prouvée par scripts/test-oracle-compat.mjs, et le comportement attendu est
// défini par Oracle lui-même (scripts/oracle-compat-probes.json, vérifié par
// scripts/verify-oracle-parity.py). Voir la docstring de oracle_compat.py pour le détail.
//
// translateOracle(sql) : ALL/ANY/SOME ; + - / || → ORA_ADD/SUB/DIV/CONCAT ; fonctions
// Oracle → ORA_<NOM> (arguments optionnels complétés), DECODE → CASE, GREATEST/LEAST →
// MAX/MIN, EXTRACT ; SYSDATE ; DATE '…' ; '' → NULL ; MINUS → EXCEPT ; OFFSET/FETCH →
// LIMIT ; NULL en dernier (ASC) / en premier (DESC) dans ORDER BY.
// setupOracle(db) : fonctions, table DUAL, LIKE sensible à la casse.
// oracleHint(sql) : explication pour les constructions Oracle non simulées.

import { rewriteQuantifiers } from "./sql-quantifiers.js";

// ── Tokenisation ─────────────────────────────────────────────────────────────

const TOKEN_RE = new RegExp(
  "(?<ws>\\s+)" +
  "|(?<comment>--[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))" +
  "|(?<str>'(?:[^']|'')*'?)" +
  "|(?<qid>\"(?:[^\"]|\"\")*\"?|`[^`]*`?|\\[[^\\]]*\\]?)" +
  "|(?<num>(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?)" +
  "|(?<id>[A-Za-z_\\u00C0-\\u024F][A-Za-z0-9_$#\\u00C0-\\u024F]*)" +
  "|(?<op>\\|\\||<=|>=|<>|!=|==|->>|->|::|[^\\s])",
  "y");

// Mots réservés qui ne peuvent pas être un opérande (ils terminent une expression).
export const KEYWORDS = new Set(`
  SELECT FROM WHERE GROUP BY HAVING ORDER ASC DESC AND OR NOT IN IS LIKE GLOB REGEXP
  MATCH ESCAPE BETWEEN EXISTS AS ON USING JOIN INNER LEFT RIGHT FULL OUTER CROSS
  NATURAL UNION ALL ANY SOME INTERSECT EXCEPT MINUS DISTINCT WHEN THEN ELSE END WITH
  RECURSIVE LIMIT OFFSET FETCH FIRST NEXT ROWS ROW ONLY OVER PARTITION WINDOW FILTER
  RANGE PRECEDING FOLLOWING UNBOUNDED CURRENT INSERT INTO VALUES UPDATE SET DELETE
  CREATE TABLE VIEW DROP ALTER ADD CONSTRAINT PRIMARY FOREIGN KEY REFERENCES UNIQUE
  CHECK DEFAULT INDEX BEGIN COMMIT ROLLBACK START CONNECT PRIOR NULLS COLLATE
  RETURNING ISNULL NOTNULL
`.split(/\s+/).filter(Boolean));

const LEVELS = [["||"], ["*", "/", "%"], ["+", "-"]];
const WRAP = { "+": "ORA_ADD", "-": "ORA_SUB", "/": "ORA_DIV", "||": "ORA_CONCAT" };

// Fonctions Oracle : nom → [cible, nb min d'arguments, nb max, valeurs des arguments omis].
export const FUNCTIONS = {
  NVL: ["ORA_NVL", 2, 2, []],
  NVL2: ["ORA_NVL2", 3, 3, []],
  MOD: ["ORA_MOD", 2, 2, []],
  LPAD: ["ORA_LPAD", 2, 3, ["' '"]],
  RPAD: ["ORA_RPAD", 2, 3, ["' '"]],
  INITCAP: ["ORA_INITCAP", 1, 1, []],
  SUBSTR: ["ORA_SUBSTR", 2, 3, ["NULL"]],
  INSTR: ["ORA_INSTR", 2, 4, ["1", "1"]],
  TO_NUMBER: ["ORA_TO_NUMBER", 1, 1, []],
  TO_CHAR: ["ORA_TO_CHAR", 1, 2, ["NULL"]],
  TO_DATE: ["ORA_TO_DATE", 1, 2, ["NULL"]],
  ADD_MONTHS: ["ORA_ADD_MONTHS", 2, 2, []],
  MONTHS_BETWEEN: ["ORA_MONTHS_BETWEEN", 2, 2, []],
  LAST_DAY: ["ORA_LAST_DAY", 1, 1, []],
  TRUNC: ["ORA_TRUNC", 1, 2, ["NULL"]],
  ROUND: ["ORA_ROUND", 1, 2, ["NULL"]],
};
const NUMBER_TYPES = ["NUMBER", "NUMERIC", "DECIMAL", "DEC"];
const FLOAT_TYPES = ["FLOAT", "REAL", "DOUBLE", "BINARY_DOUBLE", "BINARY_FLOAT"];
const EXTRACT_FIELDS = ["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"];

// "X" → [X] : SQLite prend "X" pour une chaîne si aucune colonne X n'existe ; [X] est
// toujours un identifiant, comme "X" sous Oracle.
function bracket(text) {
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    const inner = text.slice(1, -1).replace(/""/g, '"');
    if (!inner.includes("]")) return `[${inner}]`;
  }
  return text;
}

function tokenize(sql) {
  const toks = [];
  let pos = 0;
  while (pos < sql.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(sql);
    const kind = Object.keys(m.groups).find((g) => m.groups[g] !== undefined);
    if (kind !== "ws" && kind !== "comment") toks.push([kind, m[0], m.index, m.index + m[0].length]);
    pos = m.index + m[0].length;
  }
  return toks;
}

class Rewriter {
  constructor(sql) {
    this.src = sql;
    this.t = tokenize(sql);
  }

  // Utilitaires sur les jetons
  isOp(k, ...texts) {
    return k < this.t.length && this.t[k][0] === "op" && texts.includes(this.t[k][1]);
  }

  isWord(k, ...words) {
    return k < this.t.length && this.t[k][0] === "id" && words.includes(this.t[k][1].toUpperCase());
  }

  gap(a, b) {
    return this.src.slice(this.t[a][3], this.t[b][2]);
  }

  matchParen(k, j) {
    let depth = 0;
    for (let m = k; m < j; m++) {
      if (this.isOp(m, "(")) depth++;
      else if (this.isOp(m, ")")) {
        depth--;
        if (depth === 0) return m;
      }
    }
    return null;
  }

  matchCase(k, j) {
    let depth = 0;
    for (let m = k; m < j; m++) {
      if (this.isWord(m, "CASE")) depth++;
      else if (this.isWord(m, "END")) {
        depth--;
        if (depth === 0) return m;
      }
    }
    return null;
  }

  splitTop(a, b) {
    const parts = [];
    let start = a, depth = 0;
    for (let m = a; m < b; m++) {
      if (this.isOp(m, "(")) depth++;
      else if (this.isOp(m, ")")) depth--;
      else if (depth === 0 && this.isOp(m, ",")) {
        parts.push([start, m]);
        start = m + 1;
      }
    }
    parts.push([start, b]);
    return parts;
  }

  group(k, m) {
    if (m === k + 1) return this.t[k][1] + this.gap(k, m) + this.t[m][1];
    return this.t[k][1] + this.gap(k, k + 1) + this.transform(k + 1, m) +
      this.gap(m - 1, m) + this.t[m][1];
  }

  string(k) {
    return this.t[k][1] === "''" ? "NULL" : this.t[k][1];
  }

  call(name, k, m) {
    if (name === "EXTRACT") {
      if (m - k >= 4 && this.t[k + 1][0] === "id" &&
          EXTRACT_FIELDS.includes(this.t[k + 1][1].toUpperCase()) && this.isWord(k + 2, "FROM")) {
        return `ORA_EXTRACT('${this.t[k + 1][1].toUpperCase()}', ${this.transform(k + 3, m)})`;
      }
      return null;
    }
    if (name === "CAST") return this.cast(k, m);
    if (m === k + 1) return null;
    const args = this.splitTop(k + 1, m);
    if (args.some(([a, b]) => a === b)) return null;
    const texts = args.map(([a, b]) => this.transform(a, b));
    const n = texts.length;
    if (name === "DECODE") {
      if (n < 3) return null;
      const expr = texts[0], rest = texts.slice(1);
      const whens = [];
      for (let i = 0; i < rest.length - 1; i += 2) whens.push(`WHEN (${expr}) IS (${rest[i]}) THEN ${rest[i + 1]}`);
      const other = rest.length % 2 ? ` ELSE ${rest[rest.length - 1]}` : "";
      return `CASE ${whens.join(" ")}${other} END`;
    }
    if (name === "GREATEST" || name === "LEAST") {
      if (n === 1) return `(${texts[0]})`;
      return `${name === "GREATEST" ? "MAX" : "MIN"}(${texts.join(", ")})`;
    }
    const [target, lo, hi, defaults] = FUNCTIONS[name];
    if (n < lo || n > hi) return null;
    return `${target}(${texts.concat(defaults.slice(n - lo)).join(", ")})`;
  }

  // CAST(expr AS type) avec sémantique Oracle (NUMBER(p,s) arrondit, etc.).
  cast(k, m) {
    let depth = 0, asIdx = null;
    for (let x = k + 1; x < m; x++) {
      depth += (this.isOp(x, "(") ? 1 : 0) - (this.isOp(x, ")") ? 1 : 0);
      if (depth === 0 && this.isWord(x, "AS")) asIdx = x;
    }
    if (asIdx === null || asIdx === k + 1 || asIdx + 1 >= m || this.t[asIdx + 1][0] !== "id") return null;
    const expr = this.transform(k + 1, asIdx), tname = this.t[asIdx + 1][1].toUpperCase();
    let params = [];
    if (this.isOp(asIdx + 2, "(")) {
      const g = this.matchParen(asIdx + 2, m);
      if (g !== null) {
        for (let x = asIdx + 3; x < g; x++) if (this.t[x][0] === "num") params.push(this.t[x][1]);
      }
    }
    if (NUMBER_TYPES.includes(tname)) {
      if (params.length) return `ORA_ROUND(${expr}, ${params.length > 1 ? params[1] : "0"})`;
      return `ORA_TO_NUMBER(${expr})`;
    }
    if (["INTEGER", "INT", "SMALLINT"].includes(tname)) return `ORA_ROUND(${expr}, 0)`;
    if (FLOAT_TYPES.includes(tname)) return `ORA_TO_NUMBER(${expr})`;
    if (["VARCHAR2", "VARCHAR", "NVARCHAR2"].includes(tname)) return `ORA_TO_CHAR(${expr}, NULL)`;
    if (["CHAR", "NCHAR"].includes(tname)) {
      return `ORA_RPAD(ORA_TO_CHAR(${expr}, NULL), ${params.length ? params[0] : "1"}, ' ')`;
    }
    if (tname === "DATE") return `ORA_CAST_DATE(${expr})`;
    return null;
  }

  // Analyse d'expression arithmétique
  atom(k, j) {
    if (k >= j) return null;
    const [kind, text] = this.t[k];
    let nxt, out, callable = false;
    if (this.isOp(k, "(")) {
      const m = this.matchParen(k, j);
      if (m === null) return null;
      nxt = m + 1; out = this.group(k, m);
    } else if (kind === "num") {
      nxt = k + 1; out = text;
    } else if (kind === "str") {
      nxt = k + 1; out = this.string(k);
    } else if (kind === "qid") {
      nxt = k + 1; out = bracket(text); callable = true;
    } else if (kind === "id") {
      const up = text.toUpperCase();
      if (up === "CASE") {
        const m = this.matchCase(k, j);
        if (m === null) return null;
        nxt = m + 1; out = this.group(k, m);
      } else if (KEYWORDS.has(up)) {
        return null;
      } else if (up === "DATE" && k + 1 < j && this.t[k + 1][0] === "str") {
        nxt = k + 2; out = this.string(k + 1);            // littéral DATE '…'
      } else if (up === "SYSDATE" && !this.isOp(k + 1, "(", ".")) {
        nxt = k + 1; out = "ORA_SYSDATE()";
      } else {
        nxt = k + 1; out = text; callable = true;
        const special = up in FUNCTIONS || ["DECODE", "GREATEST", "LEAST", "EXTRACT", "CAST"].includes(up);
        if (special && this.isOp(k + 1, "(") && !(k > 0 && this.isOp(k - 1, "."))) {
          const m = this.matchParen(k + 1, j);
          const translated = m !== null ? this.call(up, k + 1, m) : null;
          if (translated !== null) {
            nxt = m + 1; out = translated; callable = false;
          }
        }
      }
    } else {
      return null;
    }
    while (nxt < j) {
      if (this.isOp(nxt, ".") && nxt + 1 < j &&
          (this.t[nxt + 1][0] === "id" || this.t[nxt + 1][0] === "qid" || this.isOp(nxt + 1, "*"))) {
        out += this.gap(nxt - 1, nxt) + "." + this.gap(nxt, nxt + 1) + this.t[nxt + 1][1];
        nxt += 2;
      } else if (callable && this.isOp(nxt, "(")) {
        const m = this.matchParen(nxt, j);
        if (m === null) break;
        out += this.gap(nxt - 1, nxt) + this.group(nxt, m);
        nxt = m + 1; callable = false;
        // Fonction de fenêtrage / agrégat filtré : OVER (…), OVER nom, FILTER (…)
        while (this.isWord(nxt, "OVER", "FILTER") && nxt + 1 < j) {
          if (this.isOp(nxt + 1, "(")) {
            const m2 = this.matchParen(nxt + 1, j);
            if (m2 === null) break;
            out += this.gap(nxt - 1, nxt) + this.t[nxt][1] + this.gap(nxt, nxt + 1) + this.group(nxt + 1, m2);
            nxt = m2 + 1;
          } else if (this.t[nxt + 1][0] === "id" && this.isWord(nxt, "OVER")) {
            out += this.gap(nxt - 1, nxt) + this.t[nxt][1] + this.gap(nxt, nxt + 1) + this.t[nxt + 1][1];
            nxt += 2;
          } else {
            break;
          }
        }
      } else {
        break;
      }
    }
    return [nxt, out];
  }

  unary(k, j) {
    const start = k;
    while (this.isOp(k, "+", "-")) k++;
    const res = this.atom(k, j);
    if (res === null) return null;
    let [nxt, out] = res;
    if (k > start) out = this.src.slice(this.t[start][2], this.t[k][2]) + out;
    return [nxt, out];
  }

  expression(k, j) {
    const first = this.unary(k, j);
    if (first === null) return null;
    let [nxt, text] = first;
    let items = [text], ops = [];
    while (nxt < j && this.isOp(nxt, "||", "*", "/", "%", "+", "-")) {
      const right = this.unary(nxt + 1, j);
      if (right === null) break;
      ops.push([this.t[nxt][1], this.gap(nxt - 1, nxt), this.gap(nxt, nxt + 1)]);
      items.push(right[1]);
      nxt = right[0];
    }
    for (const level of LEVELS) {
      const merged = [items[0]], kept = [];
      ops.forEach(([op, g1, g2], i) => {
        const item = items[i + 1];
        if (level.includes(op)) {
          const left = merged[merged.length - 1];
          merged[merged.length - 1] = op in WRAP ? `${WRAP[op]}(${left}, ${item})` : `${left}${g1}${op}${g2}${item}`;
        } else {
          kept.push([op, g1, g2]);
          merged.push(item);
        }
      });
      items = merged; ops = kept;
    }
    return [nxt, items[0]];
  }

  // Clauses
  orderBy(k, j) {
    let end = k + 2, depth = 0;
    while (end < j) {
      if (this.isOp(end, "(")) depth++;
      else if (this.isOp(end, ")")) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (this.isOp(end, ";") || this.isWord(end,
          "LIMIT", "OFFSET", "FETCH", "UNION", "EXCEPT", "INTERSECT", "MINUS", "ROWS", "RANGE", "GROUPS"))) {
        break;
      }
      end++;
    }
    if (end === k + 2) return null;
    let out = this.t[k][1] + this.gap(k, k + 1) + this.t[k + 1][1] + this.gap(k + 1, k + 2);
    const parts = this.splitTop(k + 2, end);
    for (let idx = 0; idx < parts.length; idx++) {
      const [a, b] = parts[idx];
      if (a === b) return null;
      let text = this.transform(a, b);
      let d = 0, hasNulls = false;
      for (let m = a; m < b; m++) {
        d += (this.isOp(m, "(") ? 1 : 0) - (this.isOp(m, ")") ? 1 : 0);
        hasNulls = hasNulls || (d === 0 && this.isWord(m, "NULLS"));
      }
      if (!hasNulls) text += this.isWord(b - 1, "DESC") ? " NULLS FIRST" : " NULLS LAST";
      out += text;
      if (idx < parts.length - 1) out += this.gap(b - 1, b) + "," + this.gap(b, parts[idx + 1][0]);
    }
    return [end, out];
  }

  fetch(k, j) {
    if (!(this.isWord(k, "FETCH") && this.isWord(k + 1, "FIRST", "NEXT"))) return null;
    let p = k + 2, count;
    if (this.isWord(p, "ROW", "ROWS")) {
      count = "1"; p += 1;
    } else {
      const res = this.expression(p, j);
      if (res === null || !this.isWord(res[0], "ROW", "ROWS")) return null;
      count = res[1]; p = res[0] + 1;
    }
    if (!this.isWord(p, "ONLY")) return null;
    return [p + 1, count];
  }

  transform(i, j, top = false) {
    const out = [];
    let k = i;
    while (k < j) {
      if (k > i) out.push(this.gap(k - 1, k));
      const statementStart = top && (k === 0 || this.isOp(k - 1, ";"));
      if (statementStart && this.isWord(k, "CREATE", "ALTER") && this.isWord(k + 1, "TABLE")) {
        let m = k, depth = 0;
        while (m < j - 1 && !(depth === 0 && this.isOp(m, ";"))) {
          depth += (this.isOp(m, "(") ? 1 : 0) - (this.isOp(m, ")") ? 1 : 0);
          m++;
        }
        out.push(this.src.slice(this.t[k][2], this.t[m][3]));
        k = m + 1;
        continue;
      }
      if (this.isWord(k, "ORDER") && this.isWord(k + 1, "BY")) {
        const res = this.orderBy(k, j);
        if (res !== null) {
          out.push(res[1]);
          k = res[0];
          continue;
        }
      }
      if (this.isWord(k, "OFFSET")) {
        const res = this.expression(k + 1, j);
        if (res !== null && this.isWord(res[0], "ROW", "ROWS")) {
          const fetched = this.fetch(res[0] + 1, j);
          if (fetched !== null) {
            out.push(`LIMIT ${fetched[1]} OFFSET ${res[1]}`);
            k = fetched[0];
          } else {
            out.push(`LIMIT -1 OFFSET ${res[1]}`);
            k = res[0] + 1;
          }
          continue;
        }
      }
      const fetched = this.fetch(k, j);
      if (fetched !== null) {
        out.push(`LIMIT ${fetched[1]}`);
        k = fetched[0];
        continue;
      }
      const res = this.expression(k, j);
      if (res === null) {
        out.push(this.isWord(k, "MINUS") ? "EXCEPT" : this.t[k][1]);
        k++;
      } else {
        out.push(res[1]);
        k = res[0];
      }
    }
    return out.join("");
  }

  run() {
    if (this.t.length === 0) return this.src;
    const body = this.transform(0, this.t.length, true);
    return this.src.slice(0, this.t[0][2]) + body + this.src.slice(this.t[this.t.length - 1][3]);
  }
}

// ── Contrôles stricts : ce qu'Oracle refuse et que SQLite accepterait ─────────

export const AGGREGATES = new Set(`
  COUNT SUM AVG MIN MAX STDDEV VARIANCE MEDIAN LISTAGG COLLECT GROUPING GROUPING_ID
  STDDEV_POP STDDEV_SAMP VAR_POP VAR_SAMP CORR COVAR_POP COVAR_SAMP
`.split(/\s+/).filter(Boolean));
const CONSTANTS = new Set(`
  NULL TRUE FALSE SYSDATE SYSTIMESTAMP CURRENT_DATE CURRENT_TIMESTAMP USER LEVEL ROWNUM
  LEADING TRAILING BOTH INTERVAL
`.split(/\s+/).filter(Boolean));
const CLAUSES = ["FROM", "WHERE", "GROUP", "HAVING", "ORDER", "FETCH", "OFFSET", "LIMIT", "WINDOW",
  "CONNECT", "START"];
const ORA_00979 = (name, where) => `ORA-00979: "${name}": must appear in the GROUP BY clause or be used in an ` +
  `aggregate function - ${where}`;

class Checker extends Rewriter {
  norm(a, b) {
    let s = "";
    for (let m = a; m < b; m++) s += this.t[m][0] === "str" ? this.t[m][1] : this.t[m][1].toUpperCase();
    return s;
  }

  blockEnd(k) {
    let depth = 0, m = k + 1;
    while (m < this.t.length) {
      if (this.isOp(m, "(")) depth++;
      else if (this.isOp(m, ")")) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (this.isOp(m, ";") || this.isWord(m, "UNION", "INTERSECT", "EXCEPT", "MINUS"))) {
        break;
      }
      m++;
    }
    return m;
  }

  clauses(k, end) {
    const pos = {};
    let depth = 0;
    for (let m = k + 1; m < end; m++) {
      if (this.isOp(m, "(")) depth++;
      else if (this.isOp(m, ")")) depth--;
      else if (depth === 0 && this.t[m][0] === "id") {
        const up = this.t[m][1].toUpperCase();
        if (CLAUSES.includes(up) && !(up in pos) && (!["GROUP", "ORDER"].includes(up) || this.isWord(m + 1, "BY"))) {
          pos[up] = m;
        }
      }
    }
    return pos;
  }

  region(pos, name, end, skip = 1) {
    if (!(name in pos)) return null;
    const after = Object.values(pos).filter((p) => p > pos[name]);
    return [pos[name] + skip, after.length ? Math.min(...after) : end];
  }

  isSubquery(m) {
    return this.isWord(m + 1, "SELECT", "WITH");
  }

  hasAggregate(a, b) {
    let m = a;
    while (m < b) {
      if (this.isOp(m, "(")) {
        const g = this.matchParen(m, b);
        if (g === null) return false;
        if (!this.isSubquery(m) && this.hasAggregate(m + 1, g)) return true;
        m = g + 1;
        continue;
      }
      if (this.t[m][0] === "id" && AGGREGATES.has(this.t[m][1].toUpperCase()) && this.isOp(m + 1, "(")) {
        const g = this.matchParen(m + 1, b);
        if (g !== null && !this.isWord(g + 1, "OVER")) return true;
      }
      m++;
    }
    return false;
  }

  // Première colonne de [a, b) hors agrégat et hors GROUP BY, ou null.
  uncovered(a, b, keys, columns) {
    let m = a;
    while (m < b) {
      const [kind, text] = this.t[m];
      const up = text.toUpperCase();
      if (this.isOp(m, "(")) {
        const g = this.matchParen(m, b);
        if (g === null) return null;
        if (!this.isSubquery(m) && !keys.has(this.norm(m, g + 1))) {
          const found = this.uncovered(m + 1, g, keys, columns);
          if (found) return found;
        }
        m = g + 1;
        continue;
      }
      if (kind === "id" && this.isOp(m + 1, "(") && !KEYWORDS.has(up)) {
        const g = this.matchParen(m + 1, b);
        if (g === null) return null;
        let nxt = g + 1;
        if (this.isWord(nxt, "OVER") && this.isOp(nxt + 1, "(")) {
          const window = this.matchParen(nxt + 1, b);
          m = (window !== null ? window : g) + 1;  // fonction de fenêtrage
          continue;
        }
        if (!AGGREGATES.has(up) && !keys.has(this.norm(m, g + 1))) {
          const found = this.uncovered(m + 2, g, keys, columns);
          if (found) return found;
        }
        m = nxt;
        continue;
      }
      if (kind === "id" || kind === "qid") {
        if ((kind === "id" && (KEYWORDS.has(up) || CONSTANTS.has(up) || up === "CASE")) || this.isWord(m - 1, "AS")) {
          m++;
          continue;
        }
        if (up === "DATE" && m + 1 < b && this.t[m + 1][0] === "str") {
          m += 2;
          continue;
        }
        if (EXTRACT_FIELDS.includes(up) && this.isWord(m + 1, "FROM")) {
          m++;
          continue;
        }
        let qual = null, name = up, end = m + 1;
        if (this.isOp(m + 1, ".") && m + 2 < b) {
          if (this.isOp(m + 2, "*")) {
            m += 3;
            continue;
          }
          qual = up; name = this.t[m + 2][1].toUpperCase(); end = m + 3;
        }
        if (name.startsWith('"')) name = name.slice(1, -1);
        // Le qualificatif de table n'est pas comparé : Oracle accepte P.numPil quand le
        // GROUP BY porte sur V.numPil (colonnes égalées par la jointure).
        const covered = keys.has(this.norm(m, end)) || columns.some(([, n]) => n === name);
        if (!covered) return name;
        m = end;
        continue;
      }
      m++;
    }
    return null;
  }

  // Éléments du SELECT, sans leur alias : [début, fin, alias].
  selectItems(a, b) {
    if (this.isWord(a, "DISTINCT", "UNIQUE", "ALL")) a++;
    return this.splitTop(a, b).map(([s, e]) => {
      let alias = null;
      if (e - s >= 3 && this.isWord(e - 2, "AS")) {
        alias = this.t[e - 1][1].toUpperCase(); e -= 2;
      } else if (e - s >= 2 && ["id", "qid"].includes(this.t[e - 1][0]) &&
          !(this.t[e - 1][0] === "id" && KEYWORDS.has(this.t[e - 1][1].toUpperCase())) &&
          !(this.t[e - 2][0] === "op" && this.t[e - 2][1] !== ")")) {
        alias = this.t[e - 1][1].toUpperCase(); e -= 1;
      }
      return [s, e, alias];
    });
  }

  checkBlock(k) {
    const end = this.blockEnd(k);
    const pos = this.clauses(k, end);
    const firstClause = Object.keys(pos).length ? Math.min(...Object.values(pos)) : end;
    const frm = this.region(pos, "FROM", end);
    if (frm) {
      let depth = 0;
      for (let m = frm[0]; m < frm[1]; m++) {
        depth += (this.isOp(m, "(") ? 1 : 0) - (this.isOp(m, ")") ? 1 : 0);
        if (depth === 0 && this.isWord(m, "AS")) {
          return `ORA-03048: SQL reserved word 'AS' is not syntactically valid following '${this.t[m - 1][1]}' - ` +
            "en Oracle, un alias de table s'écrit sans AS : FROM Vol V";
        }
      }
    }
    const items = this.selectItems(k + 1, firstClause);
    const group = this.region(pos, "GROUP", end, 2);
    const having = this.region(pos, "HAVING", end);
    const aggregated = group !== null || items.some(([s, e]) => this.hasAggregate(s, e));
    if (!aggregated) return null;
    const keys = new Set(), columns = [];
    if (group) {
      let exprs = [];
      for (const [s, e] of this.splitTop(group[0], group[1])) {
        if (this.isWord(s, "ROLLUP", "CUBE") && this.isOp(s + 1, "(")) {
          exprs = exprs.concat(this.splitTop(s + 2, e - 1));
        } else if (this.isWord(s, "GROUPING") && this.isWord(s + 1, "SETS")) {
          exprs = exprs.concat(this.splitTop(s + 3, e - 1).map(([x, y]) =>
            [x + (this.isOp(x, "(") ? 1 : 0), y - (this.isOp(y - 1, ")") ? 1 : 0)]));
        } else {
          exprs.push([s, e]);
        }
      }
      for (const [s, e] of exprs) {
        keys.add(this.norm(s, e));
        if (e - s === 1 && ["id", "qid"].includes(this.t[s][0])) {
          columns.push([null, this.t[s][1].toUpperCase().replace(/^"|"$/g, "")]);
        } else if (e - s === 3 && this.isOp(s + 1, ".")) {
          columns.push([this.t[s][1].toUpperCase(), this.t[s + 2][1].toUpperCase().replace(/^"|"$/g, "")]);
        }
      }
    }
    for (const [s, e, alias] of items) {
      if (keys.has(this.norm(s, e)) ||
          (alias && columns.some(([q, n]) => q === null && n === alias.replace(/^"|"$/g, "")))) continue;
      const name = this.uncovered(s, e, keys, columns);
      if (name) {
        if (group === null) {
          return `ORA-00937: not a single-group group function - « ${name} » n'est pas agrégé : ` +
            "ajoutez un GROUP BY sur cette colonne ou retirez-la du SELECT";
        }
        return ORA_00979(name, "toute colonne du SELECT hors fonction d'agrégat doit figurer dans le GROUP BY");
      }
    }
    if (having) {
      const name = this.uncovered(having[0], having[1], keys, columns);
      if (name) return ORA_00979(name, "dans HAVING, une colonne doit être groupée ou agrégée");
    }
    return null;
  }

  quotedAliases() {
    const defs = new Set();
    this.t.forEach(([kind, text], m) => {
      if (kind === "qid" && text.startsWith('"') && m > 0 && (this.isWord(m - 1, "AS") ||
          ((["qid", "num", "str"].includes(this.t[m - 1][0]) || this.isOp(m - 1, ")") ||
            (this.t[m - 1][0] === "id" && !KEYWORDS.has(this.t[m - 1][1].toUpperCase()))) &&
           (this.isOp(m + 1, ",") || this.isWord(m + 1, "FROM") || m + 1 === this.t.length)))) {
        defs.add(text);
      }
    });
    return defs;
  }

  runChecks() {
    let defs = null;
    for (const [kind, text] of this.t) {
      if (kind === "qid" && text.startsWith('"') && text.length >= 2) {
        const inner = text.slice(1, -1);
        if (inner !== inner.toUpperCase()) {
          if (defs === null) defs = this.quotedAliases();
          if (!defs.has(text)) {
            return `ORA-00904: ${text}: invalid identifier - entre guillemets doubles, un identifiant ` +
              "respecte la casse ; les chaînes s'écrivent entre apostrophes ('…')";
          }
        }
      }
    }
    for (let m = 0; m < this.t.length; m++) {
      if (this.isWord(m, "SELECT")) {
        const err = this.checkBlock(m);
        if (err) return err;
      }
    }
    return null;
  }
}

// Message d'erreur Oracle (ORA-… + explication) si la requête serait refusée par Oracle
// alors que SQLite l'accepterait ; null sinon. Appelé avant l'exécution.
export function checkOracle(sql) {
  return new Checker(sql).runChecks();
}

// ── Requêtes hiérarchiques : START WITH / CONNECT BY → WITH RECURSIVE ────────
// Voir _Hierarchy dans scripts/oracle_compat.py (jumeau) pour le schéma de traduction.

const SET_OPS = ["UNION", "INTERSECT", "EXCEPT", "MINUS"];

class Hierarchy extends Checker {
  isHierarchical(k, end) {
    const pos = this.clauses(k, end);
    return "CONNECT" in pos && this.isWord(pos.CONNECT + 1, "BY");
  }

  text(a, b) {
    return b > a ? this.src.slice(this.t[a][2], this.t[b - 1][3]) : "";
  }

  // Texte de [a, b) où LEVEL (pseudo-colonne) devient LEVEL_.
  withLevel(a, b) {
    let out = "";
    for (let m = a; m < b; m++) {
      if (m > a) out += this.gap(m - 1, m);
      const bare = this.isWord(m, "LEVEL") && !this.isOp(m + 1, "(") && !(m > a && this.isOp(m - 1, "."));
      out += bare ? "LEVEL_" : this.t[m][1];
    }
    return out;
  }

  // Référence de colonne en m : [suivant, nom] ; qualifiée par la table ou son alias.
  column(m, b, names) {
    if (this.t[m][0] === "qid") return [m + 1, this.t[m][1]];
    if (this.t[m][0] !== "id") return null;
    const up = this.t[m][1].toUpperCase();
    if (this.isOp(m + 1, ".") && m + 2 < b && ["id", "qid"].includes(this.t[m + 2][0])) {
      return names.has(up) ? [m + 3, this.t[m + 2][1]] : null;
    }
    if (KEYWORDS.has(up) || CONSTANTS.has(up) || up === "CASE" || this.isOp(m + 1, "(")) return null;
    return [m + 1, this.t[m][1]];
  }

  connectCondition(a, b, names) {
    let out = "", m = a;
    while (m < b) {
      if (m > a) out += this.gap(m - 1, m);
      if (this.isOp(m, "(") && this.isSubquery(m)) return null;
      if (this.isWord(m, "PRIOR")) {
        const ref = this.column(m + 1, b, names);
        if (ref === null) return null;
        out += `_p.${ref[1]}`;
        m = ref[0];
        continue;
      }
      if (this.isWord(m, "LEVEL") && !this.isOp(m + 1, "(")) {
        out += "(_p.LEVEL_ + 1)";
        m++;
        continue;
      }
      const ref = this.column(m, b, names);
      if (ref !== null) {
        out += `_c.${ref[1]}`;
        m = ref[0];
        continue;
      }
      out += this.t[m][1];
      m++;
    }
    return out;
  }

  translateBlock(k, end, n) {
    const pos = this.clauses(k, end);
    if (!("FROM" in pos) || "GROUP" in pos || "HAVING" in pos) return null;
    if ("START" in pos && !this.isWord(pos.START + 1, "WITH")) return null;
    const part = (name, skip) => {
      if (!(name in pos)) return null;
      const after = Object.values(pos).filter((p) => p > pos[name]);
      return [pos[name] + skip, after.length ? Math.min(...after) : end];
    };
    const [fa, fb] = part("FROM", 1);
    let table, alias;
    if (fb - fa === 1 && this.t[fa][0] === "id") {
      table = alias = this.t[fa][1];
    } else if (fb - fa === 2 && this.t[fa][0] === "id" && this.t[fa + 1][0] === "id" &&
        !KEYWORDS.has(this.t[fa + 1][1].toUpperCase())) {
      table = this.t[fa][1]; alias = this.t[fa + 1][1];
    } else {
      return null;                                   // jointure : non simulé
    }
    let [ca, cb] = part("CONNECT", 2);
    if (this.isWord(ca, "NOCYCLE")) ca++;
    for (let m = k; m < end; m++) if (this.isWord(m, "PRIOR") && !(ca <= m && m < cb)) return null;
    if ("ORDER" in pos && this.isWord(pos.ORDER + 1, "SIBLINGS")) return null;
    const cond = this.connectCondition(ca, cb, new Set([table.toUpperCase(), alias.toUpperCase()]));
    if (cond === null) return null;
    const start = part("START", 2), where = part("WHERE", 1), order = part("ORDER", 2);
    const name = `_h${n}`, rowId = (a) => `printf('%010d', ${a}.rowid)`;
    const base = `SELECT ${alias}.*, 1 AS LEVEL_, ${rowId(alias)} AS _path FROM ${table} ${alias}` +
      (start ? ` WHERE ${this.text(...start)}` : "");
    const step = `SELECT _c.*, _p.LEVEL_ + 1, _p._path || '/' || ${rowId("_c")} ` +
      `FROM ${table} _c JOIN ${name} _p ON ${cond} ` +
      `WHERE instr('/' || _p._path || '/', '/' || ${rowId("_c")} || '/') = 0`;
    const cte = `WITH RECURSIVE ${name} AS (${base} UNION ALL ${step} ORDER BY _path)`;
    const final = `SELECT ${this.withLevel(k + 1, pos.FROM)} FROM ${name} ${alias}` +
      (where ? ` WHERE ${this.withLevel(...where)}` : "") +
      (order ? ` ORDER BY ${this.withLevel(...order)}` : "");
    // WITH doit ouvrir l'instruction : bloc pris dans une opération ensembliste, ou
    // précédé d'un WITH de premier niveau → encapsulé dans une sous-requête.
    const compound = this.isWord(end, ...SET_OPS) || (k > 0 && this.isWord(k - 1, ...SET_OPS)) ||
      (k > 1 && this.isWord(k - 1, "ALL") && this.isWord(k - 2, "UNION"));
    let depth = 0, stmt = k;
    while (stmt > 0 && !this.isOp(stmt - 1, ";")) stmt--;
    for (let m = stmt; m < k; m++) depth += (this.isOp(m, "(") ? 1 : 0) - (this.isOp(m, ")") ? 1 : 0);
    if (compound || (depth === 0 && this.isWord(stmt, "WITH"))) return `SELECT * FROM (${cte} ${final})`;
    return `${cte} ${final}`;
  }

  rewriteOne(n) {
    const blocks = [];
    for (let k = 0; k < this.t.length; k++) {
      if (this.isWord(k, "SELECT")) {
        const e = this.blockEnd(k);
        if (this.isHierarchical(k, e)) blocks.push([k, e]);
      }
    }
    for (const [k, end] of blocks) {
      if (blocks.some(([k2]) => k < k2 && k2 < end)) continue;   // du plus imbriqué vers l'extérieur
      const text = this.translateBlock(k, end, n);
      if (text !== null) return this.src.slice(0, this.t[k][2]) + text + this.src.slice(this.t[end - 1][3]);
    }
    return null;
  }
}

// START WITH / CONNECT BY → WITH RECURSIVE. Les formes non prises en charge (jointure dans
// le FROM, ORDER SIBLINGS BY, PRIOR hors CONNECT BY…) sont laissées telles quelles.
export function rewriteHierarchical(sql) {
  for (let n = 1; n < 50; n++) {
    const rewritten = new Hierarchy(sql).rewriteOne(n);
    if (rewritten === null) break;
    sql = rewritten;
  }
  return sql;
}

export function rewriteOracleSyntax(sql) {
  return new Rewriter(sql).run();
}

export function translateOracle(sql) {
  return rewriteOracleSyntax(rewriteHierarchical(rewriteQuantifiers(sql)));
}

// ── Fonctions à sémantique Oracle ────────────────────────────────────────────
// Les erreurs sont levées sous forme de chaîne : sql.js la transmet telle quelle comme
// message d'erreur SQL (« ORA-01476: divisor is equal to zero »).

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/;
const NUM_RE = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST",
  "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const ERR_YEAR = "ORA-01841: (full) year must be between -4713 and +9999, and not be 0";

const idiv = (a, b) => Math.floor(a / b);
const mod = (a, b) => a - idiv(a, b) * b;
const pad0 = (v, w) => String(v).padStart(w, "0");
const leap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const monthLen = (y, m) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = idiv(y, 400);
  const yoe = y - era * 400;
  const doy = idiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1;
  const doe = yoe * 365 + idiv(yoe, 4) - idiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = idiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = idiv(doe - idiv(doe, 1460) + idiv(doe, 36524) - idiv(doe, 146096), 365);
  const doy = doe - (365 * yoe + idiv(yoe, 4) - idiv(yoe, 100));
  const mp = idiv(5 * doy + 2, 153);
  const d = doy - idiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

// [jours, secondes] si v est une date ISO valide (texte), sinon null.
function asDate(v) {
  if (typeof v !== "string") return null;
  const m = DATE_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  if (!(y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= monthLen(y, mo) && h <= 23 && mi <= 59 && s <= 59)) {
    return null;
  }
  return [daysFromCivil(y, mo, d), h * 3600 + mi * 60 + s];
}

function makeDate(days, secs) {
  const [y, m, d] = civilFromDays(days);
  if (y < 1 || y > 9999) throw ERR_YEAR;
  const day = `${pad0(y, 4)}-${pad0(m, 2)}-${pad0(d, 2)}`;
  if (secs === 0) return day;
  const h = idiv(secs, 3600), r = secs - h * 3600;
  return `${day} ${pad0(h, 2)}:${pad0(idiv(r, 60), 2)}:${pad0(r % 60, 2)}`;
}

function parts(dt) {
  const [days, secs] = dt;
  const [y, m, d] = civilFromDays(days);
  return [y, m, d, idiv(secs, 3600), idiv(secs % 3600, 60), secs % 60];
}

function requireDate(v) {
  const dt = asDate(v);
  if (dt === null) throw "ORA-00932: inconsistent datatypes: expected DATE got NUMBER";
  return dt;
}

function num(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (NUM_RE.test(s)) return Number(s);
  }
  throw "ORA-01722: invalid number";
}

// Développement décimal sans exposant du plus court affichage du nombre : [signe, ent, frac].
function plain(x) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(x));
  const sign = m[1], ip0 = m[2], fp0 = m[3] || "", exp = Number(m[4] || 0);
  let digits = ip0 + fp0, point = ip0.length + exp;
  if (point <= 0) {
    digits = "0".repeat(1 - point) + digits; point = 1;
  } else if (point > digits.length) {
    digits += "0".repeat(point - digits.length);
  }
  return [sign, digits.slice(0, point).replace(/^0+/, "") || "0", digits.slice(point).replace(/0+$/, "")];
}

// Conversion implicite nombre → texte façon Oracle (0.5 → '.5').
function numText(x) {
  const [sign, ip, fp] = plain(x);
  if (!fp) return (sign && ip !== "0" ? "-" : "") + ip;
  return sign + (ip === "0" ? "" : ip) + "." + fp;
}

function text(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number") return numText(v);
  throw "ORA-00932: inconsistent datatypes";
}

const intArg = (v) => Math.trunc(num(v));

function shift(dt, days) {
  const total = dt[0] * 86400 + dt[1] + Math.floor(days * 86400 + 0.5);
  const d = idiv(total, 86400);
  return makeDate(d, total - d * 86400);
}

export function oraAdd(a, b) {
  if (a === null || b === null) return null;
  const da = asDate(a), db = asDate(b);
  if (da !== null && db !== null) throw "ORA-00975: date + date not allowed";
  if (da !== null) return shift(da, num(b));
  if (db !== null) return shift(db, num(a));
  return num(a) + num(b);
}

export function oraSub(a, b) {
  if (a === null || b === null) return null;
  const da = asDate(a), db = asDate(b);
  if (da !== null && db !== null) return ((da[0] * 86400 + da[1]) - (db[0] * 86400 + db[1])) / 86400;
  if (da !== null) return shift(da, -num(b));
  if (db !== null) throw "ORA-00932: inconsistent datatypes: expected NUMBER got DATE";
  return num(a) - num(b);
}

export function oraDiv(a, b) {
  if (a === null || b === null) return null;
  if (asDate(a) !== null || asDate(b) !== null) {
    throw "ORA-00932: inconsistent datatypes: expected NUMBER got DATE";
  }
  const d = num(b);
  if (d === 0) throw "ORA-01476: divisor is equal to zero";
  return num(a) / d;
}

// Oracle : la chaîne vide est NULL.
const nonEmpty = (s) => (s === "" ? null : s);

// Oracle ignore NULL dans une concaténation ('A' || NULL = 'A').
export function oraConcat(a, b) {
  if (a === null && b === null) return null;
  return nonEmpty((a === null ? "" : text(a)) + (b === null ? "" : text(b)));
}

export const oraNvl = (a, b) => (a === null ? b : a);
export const oraNvl2 = (a, b, c) => (a === null ? c : b);

export function oraMod(a, b) {
  if (a === null || b === null) return null;
  const m = num(a), n = num(b);
  if (n === 0) return m;
  return m % n;
}

function padText(s, n, padding, left) {
  if (s === null || n === null || padding === null) return null;
  s = text(s); n = intArg(n); padding = text(padding);
  if (n < 1 || padding === "") return null;
  if (s.length >= n) return s.slice(0, n);
  const fill = padding.repeat(idiv(n, padding.length) + 1).slice(0, n - s.length);
  return left ? fill + s : s + fill;
}

export const oraLpad = (s, n, p) => padText(s, n, p, true);
export const oraRpad = (s, n, p) => padText(s, n, p, false);

const ALNUM_RE = /[A-Za-z0-9À-ɏ]/;

export function oraInitcap(s) {
  if (s === null) return null;
  let out = "", prev = false;
  for (const ch of text(s)) {
    const cur = ALNUM_RE.test(ch);
    out += cur ? (prev ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prev = cur;
  }
  return nonEmpty(out);
}

export function oraSubstr(s, p, length) {
  if (s === null || p === null) return null;
  s = text(s);
  p = intArg(p);
  const n = s.length;
  const start = p > 0 ? p - 1 : (p < 0 ? n + p : 0);
  if (start < 0 || start >= n) return null;
  let r;
  if (length === null) {
    r = s.slice(start);
  } else {
    const ln = intArg(length);
    if (ln < 1) return null;
    r = s.slice(start, start + ln);
  }
  return r || null;
}

export function oraInstr(s, sub, pos, occ) {
  if (s === null || sub === null || pos === null || occ === null) return null;
  s = text(s); sub = text(sub); pos = intArg(pos); occ = intArg(occ);
  if (occ < 1) throw "ORA-01428: argument is out of range";
  if (pos === 0) return 0;
  if (pos > 0) {
    let idx = pos - 1;
    for (;;) {
      const f = s.indexOf(sub, idx);
      if (f < 0) return 0;
      occ--;
      if (occ === 0) return f + 1;
      idx = f + 1;
    }
  }
  let start = s.length + pos;
  while (start >= 0) {
    const f = s.lastIndexOf(sub, start);
    if (f < 0) return 0;
    occ--;
    if (occ === 0) return f + 1;
    start = f - 1;
  }
  return 0;
}

export const oraToNumber = (v) => (v === null ? null : num(v));

const isDigit = (c) => c >= "0" && c <= "9";
const isAlpha = (c) => c.toLowerCase() !== c.toUpperCase();
const isAlnum = (c) => isDigit(c) || isAlpha(c);

// Modèles de format de date (TO_CHAR / TO_DATE / TRUNC)
const FMT_RE = new RegExp(
  '"[^"]*"|FM|FX|YYYY|RRRR|YYY|YY|RR|Y|MONTH|MON|MM|RM|DDD|DD|DAY|DY|D|HH24|HH12|HH|MI|SS' +
  "|A\\.M\\.|P\\.M\\.|AM|PM|Q|J|[-/,.;: ]+", "iy");

function fmtTokens(fmt) {
  const toks = [];
  let pos = 0;
  while (pos < fmt.length) {
    FMT_RE.lastIndex = pos;
    const m = FMT_RE.exec(fmt);
    if (!m) throw "ORA-01821: date format not recognized";
    toks.push(m[0]);
    pos = m.index + m[0].length;
  }
  return toks;
}


// Casse Oracle, d'après les lettres du modèle : 'Mon' → Apr, 'MON' → APR, 'mon' → apr.
function styled(word, model) {
  const letters = [...model].filter(isAlpha);
  if (letters[0] === letters[0].toLowerCase()) return word.toLowerCase();
  if (letters.length > 1 && letters[1] === letters[1].toUpperCase()) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function now() {
  const n = new Date();
  return [daysFromCivil(n.getFullYear(), n.getMonth() + 1, n.getDate()),
    n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()];
}

export const oraSysdate = () => makeDate(...now());

function formatDate(dt, fmt) {
  const [y, mo, d, h, mi, s] = parts(dt);
  const wd = mod(mod(dt[0], 7) + 4, 7);
  let fm = false;
  const out = [];
  for (const tok of fmtTokens(fmt)) {
    const up = tok.toUpperCase();
    const n = (v, w) => (fm ? String(v) : pad0(v, w));
    if (tok.startsWith('"')) out.push(tok.slice(1, -1));
    else if (up === "FM") fm = !fm;
    else if (up === "FX") { /* sans effet en sortie */ }
    else if (up === "YYYY" || up === "RRRR") out.push(n(y, 4));
    else if (up === "YYY") out.push(n(y % 1000, 3));
    else if (up === "YY" || up === "RR") out.push(n(y % 100, 2));
    else if (up === "Y") out.push(String(y % 10));
    else if (up === "MONTH") out.push(styled(fm ? MONTHS[mo - 1] : MONTHS[mo - 1].padEnd(9), tok));
    else if (up === "MON") out.push(styled(MONTHS[mo - 1].slice(0, 3), tok));
    else if (up === "MM") out.push(n(mo, 2));
    else if (up === "RM") out.push(styled(fm ? ROMAN[mo - 1] : ROMAN[mo - 1].padEnd(4), tok));
    else if (up === "DDD") out.push(n(dt[0] - daysFromCivil(y, 1, 1) + 1, 3));
    else if (up === "DD") out.push(n(d, 2));
    else if (up === "DAY") out.push(styled(fm ? DAYS[wd] : DAYS[wd].padEnd(9), tok));
    else if (up === "DY") out.push(styled(DAYS[wd].slice(0, 3), tok));
    else if (up === "D") out.push(String(wd + 1));
    else if (up === "HH" || up === "HH12") out.push(n(((h + 11) % 12) + 1, 2));
    else if (up === "HH24") out.push(n(h, 2));
    else if (up === "MI") out.push(n(mi, 2));
    else if (up === "SS") out.push(n(s, 2));
    else if (up === "AM" || up === "PM") out.push(styled(h < 12 ? "AM" : "PM", tok));
    else if (up === "A.M." || up === "P.M.") out.push(styled(h < 12 ? "A.M." : "P.M.", tok));
    else if (up === "Q") out.push(String(idiv(mo - 1, 3) + 1));
    else if (up === "J") out.push(String(dt[0] + 2440588));
    else out.push(tok);
  }
  return out.join("");
}

// Arrondi décimal exact (demi vers l'infini) à n décimales sur les chiffres : [ent, frac].
function roundDigits(ip, fp, n) {
  const padded = fp + "0".repeat(n + 1);
  const keep = (ip + padded.slice(0, n)).split("");
  let carry = padded[n] >= "5", i = keep.length - 1;
  while (carry && i >= 0) {
    if (keep[i] === "9") {
      keep[i] = "0"; i--;
    } else {
      keep[i] = String.fromCharCode(keep[i].charCodeAt(0) + 1); carry = false;
    }
  }
  const s = (carry ? "1" : "") + keep.join("");
  const newIp = n ? s.slice(0, s.length - n) : s, newFp = n ? s.slice(s.length - n) : "";
  return [newIp.replace(/^0+/, "") || "0", newFp];
}

const NUMFMT_ERR = "ORA-01481: invalid number format model";

// TO_CHAR(nombre, format) : éléments 9 0 , . G D $ B S MI PR FM EEEE.
function formatNumber(x, fmt) {
  let f = fmt.toUpperCase();
  const fm = f.startsWith("FM");
  if (fm) f = f.slice(2);
  let blankZero = false, dollar = false, leadS = false;
  while (f && ["B", "$", "S"].includes(f[0])) {
    blankZero = blankZero || f[0] === "B"; dollar = dollar || f[0] === "$"; leadS = leadS || f[0] === "S";
    f = f.slice(1);
  }
  const eeee = f.endsWith("EEEE");
  if (eeee) f = f.slice(0, -4);
  const mi = f.endsWith("MI"), pr = f.endsWith("PR");
  if (mi || pr) f = f.slice(0, -2);
  const trailS = !leadS && f.endsWith("S");
  if (trailS) f = f.slice(0, -1);
  const body = f.replace(/G/g, ",").replace(/D/g, ".");
  if (!body || [...body].some((c) => !"90,.".includes(c)) || body.split(".").length > 2) throw NUMFMT_ERR;
  const [intFmt, fracFmt] = body.includes(".") ? body.split(".") : [body, null];
  if (fracFmt !== null && fracFmt.includes(",")) throw NUMFMT_ERR;
  const nfrac = fracFmt !== null ? fracFmt.length : 0;
  const width = body.length + (dollar ? 1 : 0) + (pr ? 2 : 1) + (eeee ? 5 : 0);
  let [sign, ip, fp] = plain(x);
  const neg = sign === "-";
  // FM : supprime les zéros finaux des positions 9.
  const trim = (frac) => {
    while (fm && frac && frac[frac.length - 1] === "0" && fracFmt[frac.length - 1] === "9") frac = frac.slice(0, -1);
    return frac;
  };
  let out;
  if (eeee) {
    const slots = intFmt.replace(/,/g, "");
    if (slots.length !== 1) throw NUMFMT_ERR;
    const sig = (ip + fp).replace(/^0+/, "");
    let mant, frac, exp;
    if (!sig) {
      mant = "0"; frac = "0".repeat(nfrac); exp = 0;
    } else {
      exp = ip !== "0" ? ip.length - 1 : -(fp.length - fp.replace(/^0+/, "").length + 1);
      let [rIp] = roundDigits(sig.slice(0, 1 + nfrac).padEnd(1 + nfrac, "0"), sig.slice(1 + nfrac), 0);
      if (rIp.length > 1 + nfrac) { rIp = rIp.slice(0, 1 + nfrac); exp += 1; }
      rIp = rIp.padStart(1 + nfrac, "0");
      mant = rIp[0]; frac = rIp.slice(1);
    }
    frac = trim(frac);
    const lead = (mant !== "0" || slots === "0" || fm) ? mant : " ";
    out = (fm ? "" : " ") + lead + (fracFmt !== null ? "." + frac : "");
    out += "E" + (exp >= 0 ? "+" : "-") + String(Math.abs(exp)).padStart(2, "0");
  } else {
    [ip, fp] = roundDigits(ip, fp, nfrac);
    if (blankZero && ip === "0" && /^0*$/.test(fp)) return fm ? "" : " ".repeat(width);
    const digits = ip === "0" ? "" : ip;
    const slotPos = [...intFmt].map((c, i) => ("90".includes(c) ? i : -1)).filter((i) => i >= 0);
    if (digits.length > slotPos.length) return "#".repeat(width);
    const firstZero = intFmt.indexOf("0");
    const chars = [...intFmt];
    [...slotPos].reverse().forEach((pos, nFromRight) => {
      if (nFromRight < digits.length) chars[pos] = digits[digits.length - 1 - nFromRight];
      else chars[pos] = (firstZero >= 0 && firstZero <= pos) ? "0" : " ";
    });
    const frac = fracFmt !== null ? trim(fp) : "";
    const shown = slotPos.some((p) => chars[p] !== " ");
    if (slotPos.length && !shown && (nfrac === 0 || (fm && frac === ""))) chars[slotPos[slotPos.length - 1]] = "0";
    [...intFmt].forEach((c, i) => {
      if (c === ",") chars[i] = slotPos.some((p) => p < i && chars[p] !== " ") ? "," : " ";
    });
    out = chars.join("") + (fracFmt !== null ? "." + frac : "");
  }
  const insertFirst = (s, ins) => {
    const stripped = s.replace(/^ +/, "");
    return s.slice(0, s.length - stripped.length) + ins + stripped;
  };
  if (dollar) out = insertFirst(out, "$");
  if (leadS) out = insertFirst(out, neg ? "-" : "+");
  else if (trailS) out += neg ? "-" : "+";
  else if (mi) out += neg ? "-" : " ";
  else if (pr) out = neg ? insertFirst(out, "<") + ">" : " " + out + " ";
  else out = insertFirst(out, neg ? "-" : " ");
  return fm ? out.replace(/^ +| +$/g, "") : out;
}

export function oraToChar(v, fmt) {
  if (v === null) return null;
  const dt = asDate(v);
  if (dt !== null) return nonEmpty(formatDate(dt, fmt === null ? "DD-MON-RR" : text(fmt)));
  if (fmt === null) return typeof v === "string" ? nonEmpty(v) : numText(v);
  return nonEmpty(formatNumber(num(v), text(fmt)));
}


export function oraToDate(v, fmt) {
  if (v === null) return null;
  const s = text(v);
  fmt = fmt === null ? "DD-MON-RR" : text(fmt);
  const [nowY, nowM] = parts(now());
  let y = null, mo = null, d = 1, h = 0, mi = 0, sec = 0, pm = null;
  let pos = 0;
  const n = s.length;

  const readNum = (width) => {
    while (pos < n && s[pos] === " ") pos++;
    const start = pos;
    while (pos < n && pos - start < width && isDigit(s[pos])) pos++;
    if (pos === start) {
      throw pos >= n ? "ORA-01840: input value not long enough for date format"
        : "ORA-01858: a non-numeric character was found where a numeric was expected";
    }
    return [Number(s.slice(start, pos)), pos - start];
  };
  const readWord = () => {
    while (pos < n && s[pos] === " ") pos++;
    const start = pos;
    while (pos < n && isAlpha(s[pos])) pos++;
    return s.slice(start, pos).toUpperCase();
  };

  for (const tok of fmtTokens(fmt)) {
    const up = tok.toUpperCase();
    if (tok.startsWith('"')) {
      const lit = tok.slice(1, -1);
      if (s.slice(pos, pos + lit.length).toUpperCase() !== lit.toUpperCase()) {
        throw "ORA-01861: literal does not match format string";
      }
      pos += lit.length;
    } else if (up === "FM" || up === "FX") {
      /* sans effet */
    } else if (!isAlpha(up[0])) {
      while (pos < n && !isAlnum(s[pos])) pos++;
    } else if (up === "YYYY" || up === "RRRR") {
      [y] = readNum(4);
    } else if (up === "YY" || up === "RR") {
      const [v2, width] = readNum(up === "RR" ? 4 : 2);
      const century = idiv(nowY, 100) * 100;
      if (width > 2) y = v2;
      else if (up === "YY") y = century + v2;
      else if (v2 < 50) y = century + v2 + (nowY % 100 >= 50 ? 100 : 0);
      else y = century + v2 - (nowY % 100 < 50 ? 100 : 0);
    } else if (up === "YYY" || up === "Y") {
      const [v2] = readNum(up.length);
      const p = 10 ** up.length;
      y = idiv(nowY, p) * p + v2;
    } else if (up === "MM") {
      [mo] = readNum(2);
    } else if (up === "MON" || up === "MONTH") {
      const w = readWord();
      const names = MONTHS.map((m) => (up === "MONTH" ? m : m.slice(0, 3)));
      if (!names.includes(w) && !(up === "MON" && MONTHS.includes(w))) throw "ORA-01843: not a valid month";
      mo = (names.includes(w) ? names.indexOf(w) : MONTHS.indexOf(w)) + 1;
    } else if (up === "DD") {
      [d] = readNum(2);
    } else if (up === "DY" || up === "DAY") {
      const w = readWord();
      if (!DAYS.includes(w) && !DAYS.map((x) => x.slice(0, 3)).includes(w)) {
        throw "ORA-01846: not a valid day of the week";
      }
    } else if (up === "HH" || up === "HH12") {
      [h] = readNum(2);
      if (h < 1 || h > 12) throw "ORA-01849: hour must be between 1 and 12";
      pm = pm || false;
    } else if (up === "HH24") {
      [h] = readNum(2);
      if (h > 23) throw "ORA-01850: hour must be between 0 and 23";
    } else if (up === "MI") {
      [mi] = readNum(2);
      if (mi > 59) throw "ORA-01851: minutes must be between 0 and 59";
    } else if (up === "SS") {
      [sec] = readNum(2);
      if (sec > 59) throw "ORA-01852: seconds must be between 0 and 59";
    } else if (["AM", "PM", "A.M.", "P.M."].includes(up)) {
      while (pos < n && s[pos] === " ") pos++;
      const w = s.slice(pos, pos + up.length).toUpperCase();
      if (!["AM", "PM", "A.M.", "P.M."].includes(w) || w.length !== up.length) {
        throw "ORA-01855: AM/A.M. or PM/P.M. required";
      }
      pm = w[0] === "P";
      pos += up.length;
    } else {
      throw `TO_DATE : l'élément de format ${tok} n'est pas simulé`;
    }
  }
  while (pos < n && s[pos] === " ") pos++;
  if (pos < n) throw "ORA-01830: date format picture ends before converting entire input string";
  if (pm !== null) h = (h % 12) + (pm ? 12 : 0);
  if (y === null) y = nowY;
  if (mo === null) mo = nowM;
  if (y < 1 || y > 9999) throw ERR_YEAR;
  if (mo < 1 || mo > 12) throw "ORA-01843: not a valid month";
  if (d < 1 || d > monthLen(y, mo)) throw "ORA-01847: day of month must be between 1 and last day of month";
  return makeDate(daysFromCivil(y, mo, d), h * 3600 + mi * 60 + sec);
}

export function oraAddMonths(v, n) {
  if (v === null || n === null) return null;
  const dt = requireDate(v);
  const [y, mo, d] = parts(dt);
  const total = y * 12 + mo - 1 + intArg(n);
  const ny = idiv(total, 12), nm = total - idiv(total, 12) * 12 + 1;
  if (ny < 1 || ny > 9999) throw ERR_YEAR;
  const last = monthLen(ny, nm);
  const nd = d === monthLen(y, mo) ? last : Math.min(d, last);
  return makeDate(daysFromCivil(ny, nm, nd), dt[1]);
}

export function oraMonthsBetween(a, b) {
  if (a === null || b === null) return null;
  const da = requireDate(a), db = requireDate(b);
  const [y1, m1, d1] = parts(da);
  const [y2, m2, d2] = parts(db);
  const months = (y1 - y2) * 12 + (m1 - m2);
  if (d1 === d2 || (d1 === monthLen(y1, m1) && d2 === monthLen(y2, m2))) return months;
  return months + ((d1 - d2) * 86400 + (da[1] - db[1])) / 2678400;
}

export function oraLastDay(v) {
  if (v === null) return null;
  const dt = requireDate(v);
  const [y, mo] = parts(dt);
  return makeDate(daysFromCivil(y, mo, monthLen(y, mo)), dt[1]);
}

export function oraTrunc(v, fmt) {
  if (v === null) return null;
  const dt = asDate(v);
  if (dt !== null) {
    const up = fmt === null ? "DD" : text(fmt).toUpperCase();
    const [y, mo, , h, mi] = parts(dt);
    if (["DD", "DDD", "J"].includes(up)) return makeDate(dt[0], 0);
    if (["MM", "MON", "MONTH", "RM"].includes(up)) return makeDate(daysFromCivil(y, mo, 1), 0);
    if (["YYYY", "SYYYY", "YEAR", "SYEAR", "YYY", "YY", "Y"].includes(up)) return makeDate(daysFromCivil(y, 1, 1), 0);
    if (up === "Q") return makeDate(daysFromCivil(y, idiv(mo - 1, 3) * 3 + 1, 1), 0);
    if (["DAY", "DY", "D"].includes(up)) return makeDate(dt[0] - mod(mod(dt[0], 7) + 4, 7), 0);
    if (["HH", "HH12", "HH24"].includes(up)) return makeDate(dt[0], h * 3600);
    if (up === "MI") return makeDate(dt[0], h * 3600 + mi * 60);
    throw "ORA-01821: date format not recognized";
  }
  const digits = fmt === null ? 0 : intArg(fmt);
  let [sign, ip, fp] = plain(num(v));
  if (digits >= 0) {
    fp = fp.slice(0, digits);
  } else {
    const keep = ip.length + digits;
    ip = keep > 0 ? ip.slice(0, keep) + "0".repeat(-digits) : "0";
    fp = "";
  }
  return Number(sign + ip + (fp ? "." + fp : ""));
}

// ROUND Oracle : arrondi décimal exact, demi vers l'infini ; date → jour le plus proche.
export function oraRound(v, n) {
  if (v === null) return null;
  const dt = asDate(v);
  if (dt !== null) {
    const up = n === null ? "DD" : text(n).toUpperCase();
    if (["DD", "DDD", "J"].includes(up)) return makeDate(dt[0] + (dt[1] >= 43200 ? 1 : 0), 0);
    throw "ROUND : seul l'arrondi d'une date au jour (DD) est simulé";
  }
  const digits = n === null ? 0 : intArg(n);
  let [sign, ip, fp] = plain(num(v));
  if (digits >= 0) {
    [ip, fp] = roundDigits(ip, fp, digits);
    fp = fp.replace(/0+$/, "");
  } else {
    const k = -digits;
    const padded = ip.padStart(k + 1, "0");
    const [head] = roundDigits(padded.slice(0, -k), padded.slice(-k), 0);
    ip = (head + "0".repeat(k)).replace(/^0+/, "") || "0";
    fp = "";
  }
  if (ip === "0" && !fp) return 0;
  return Number(sign + ip + (fp ? "." + fp : ""));
}

// CAST(x AS DATE) : une date reste elle-même, un texte suit le format par défaut.
export function oraCastDate(v) {
  if (v === null || asDate(v) !== null) return v;
  return oraToDate(v, null);
}

export function oraExtract(field, v) {
  if (v === null) return null;
  const dt = asDate(v);
  if (dt === null || !["YEAR", "MONTH", "DAY"].includes(field)) {
    throw "ORA-30076: invalid extract field for extract source";
  }
  const [y, mo, d] = parts(dt);
  return { YEAR: y, MONTH: mo, DAY: d }[field];
}

// ── Installation sur une base ────────────────────────────────────────────────

// Table DUAL d'Oracle (une ligne, colonne DUMMY = 'X').
export const ORACLE_SETUP_SQL = "CREATE TABLE IF NOT EXISTS DUAL (DUMMY VARCHAR(1));\n" +
  "INSERT INTO DUAL (DUMMY) SELECT 'X' WHERE NOT EXISTS (SELECT * FROM DUAL);\n";

// sql.js déduit l'arité de function.length : chaque fonction déclare ses paramètres.
export const ORACLE_FUNCTIONS = {
  ORA_ADD: oraAdd, ORA_SUB: oraSub, ORA_DIV: oraDiv, ORA_CONCAT: oraConcat,
  ORA_NVL: oraNvl, ORA_NVL2: oraNvl2, ORA_MOD: oraMod, ORA_LPAD: oraLpad,
  ORA_RPAD: oraRpad, ORA_INITCAP: oraInitcap, ORA_SUBSTR: oraSubstr,
  ORA_INSTR: oraInstr, ORA_TO_NUMBER: oraToNumber, ORA_TO_CHAR: oraToChar,
  ORA_TO_DATE: oraToDate, ORA_ADD_MONTHS: oraAddMonths,
  ORA_MONTHS_BETWEEN: oraMonthsBetween, ORA_LAST_DAY: oraLastDay,
  ORA_TRUNC: oraTrunc, ORA_EXTRACT: oraExtract, ORA_ROUND: oraRound, ORA_CAST_DATE: oraCastDate,
};

// Fonctions de compatibilité et LIKE sensible à la casse, sur chaque base fraîche.
export function registerOracleFunctions(db) {
  for (const [name, fn] of Object.entries(ORACLE_FUNCTIONS)) db.create_function(name, fn);
  db.create_function("ORA_SYSDATE", oraSysdate);
  db.run("PRAGMA case_sensitive_like = ON");
}

// Fonctions + table DUAL : à appeler après le chargement des données.
export function setupOracle(db) {
  registerOracleFunctions(db);
  db.run(ORACLE_SETUP_SQL);
}

// ── Explication des constructions Oracle non simulées ────────────────────────

const HINTS = [
  [/\bROWNUM\b/i, "ROWNUM n'est pas simulé : utilisez FETCH FIRST n ROWS ONLY (après ORDER BY)."],
  [/\(\s*\+\s*\)/, "La jointure externe (+) n'est pas simulée : utilisez LEFT JOIN … ON …."],
  [/\b(CONNECT\s+BY|START\s+WITH|PRIOR)\b/i,
    "Cette forme de requête hiérarchique n'est pas simulée (simulée : une seule table dans le FROM, " +
    "PRIOR dans CONNECT BY, sans ORDER SIBLINGS BY) : sinon, utilisez une requête récursive WITH."],
  [/\b(USER|ALL|DBA)_(TABLES|TAB_COLUMNS|CONSTRAINTS|CONS_COLUMNS|OBJECTS|VIEWS|INDEXES)\b/i,
    "Les vues du dictionnaire de données Oracle ne sont pas simulées : exécutez cette requête sous Oracle."],
];

// Explication complémentaire à afficher avec une erreur SQL (message SQLite facultatif),
// ou null.
export function oracleHint(sql, message = "") {
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return "ORA-02291 / ORA-02292 : contrainte d'intégrité référentielle violée (clé étrangère " +
      "vers une ligne absente, ou suppression d'une ligne encore référencée).";
  }
  const fn = /no such function: (\w+)/i.exec(message);
  if (fn) {
    const name = fn[1].toUpperCase();
    if (name in FUNCTIONS || ["DECODE", "GREATEST", "LEAST", "EXTRACT"].includes(name)) {
      return `ORA-00909: invalid number of arguments - nombre ou forme d'arguments incorrect pour ${name}.`;
    }
  }
  const col = /no such column: (\S+)/i.exec(message);
  if (col && sql.includes(`"${col[1]}"`)) {
    return `Les chaînes s'écrivent entre apostrophes ('${col[1]}') : entre guillemets doubles, ` +
      `"${col[1]}" désigne une colonne.`;
  }
  // Ignore le contenu des chaînes et des commentaires.
  const code = sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  for (const [re, msg] of HINTS) if (re.test(code)) return msg;
  return null;
}

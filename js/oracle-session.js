// oracle-session.js - session Oracle simulée sur sql.js : LDD, LMD, transactions,
// dictionnaire de données.
//
// Moitié JavaScript d'un JUMEAU : scripts/oracle_session.py fait exactement la même chose
// pour le générateur. Toute modification doit être répercutée des deux côtés ; la parité
// est prouvée par scripts/test-oracle-session.mjs, et le comportement attendu est celui
// d'Oracle (scripts/verify-oracle-session.py). Voir la docstring du jumeau pour le principe :
// un catalogue Oracle, d'où le SQLite (tables recréées, déclencheurs) est déduit.
//
//   const session = new Session(SQL);   // SQL : module renvoyé par initSqlJs
//   session.run(script);                // [{ sql, cols, rows } | { sql, error }]
//   session.state();                    // { TABLE: lignes }
//   session.close();

import {
  ORACLE_SETUP_SQL, Rewriter, TOKEN_RE, checkOracle, registerOracleFunctions, translateOracle,
} from "./oracle-compat.js";
import { canonCell } from "./canon.js";

const NOT_SIMULATED = "non simulé : ";

// Garde-fous : voir engine.js.
const MAX_ROWS = 100000;
const MAX_MS = 5000;

const words = (text) => new Set(text.trim().split(/\s+/));

const RESERVED = words(`
  ACCESS ADD ALL ALTER AND ANY AS ASC BETWEEN BY CHECK COLUMN CONNECT CREATE CURRENT DATE
  DEFAULT DELETE DESC DISTINCT DROP ELSE EXISTS FOR FROM GRANT GROUP HAVING IN INDEX INSERT
  INTERSECT INTO IS LEVEL LIKE MINUS MODE NOT NULL NUMBER OF ON OPTION OR ORDER PRIOR RAW
  ROW ROWID ROWNUM ROWS SELECT SET SIZE START TABLE THEN TO TRIGGER UNION UNIQUE UPDATE
  USER VALUES VARCHAR VARCHAR2 VIEW WHERE WITH`);

const INTEGER_TYPES = ["INTEGER", "INT", "SMALLINT"];
const DECIMAL_TYPES = ["NUMBER", "NUMERIC", "DECIMAL", "DEC"];
const FLOAT_TYPES = ["FLOAT", "REAL", "BINARY_FLOAT", "BINARY_DOUBLE"];
const TEXT_TYPES = ["VARCHAR2", "VARCHAR", "NVARCHAR2", "CHAR", "NCHAR"];

// Commandes SQL*Plus : elles se terminent à la fin de la ligne.
const COMMAND = "(?:PROMPT|REM|REMARK|EXIT|QUIT|DESC|DESCRIBE|SHOW|COLUMN|SPOOL)(?=[ \\t;\\r\\n]|$)[^\\n]*" +
  "|SET[ \\t]+(?!TRANSACTION\\b|CONSTRAINTS?\\b)[^\\n]*";
const COMMAND_AT = new RegExp(COMMAND, "iy");
const COMMAND_START = new RegExp(`^(?:${COMMAND})`, "i");
const SLASH_AT = /\/[ \t\r]*(?:\n|$)/y;
const IDENT_RE = /^[A-Za-z_À-ɏ][A-Za-z0-9_$#À-ɏ]*$/;

export const DICTIONARY = [
  ["User_Tables", ["table_Name", "tablespace_Name"]],
  ["User_Tab_Columns", ["table_Name", "column_Name", "data_Type", "data_Length",
    "data_Precision", "data_Scale", "nullable", "column_Id"]],
  ["User_Constraints", ["constraint_Name", "constraint_Type", "table_Name", "search_Condition",
    "r_Constraint_Name", "status", "deferrable", "deferred"]],
  ["User_Cons_Columns", ["constraint_Name", "table_Name", "column_Name", "position"]],
  ["User_Objects", ["object_Name", "object_Type", "status"]],
  ["User_Views", ["view_Name", "text"]],
];
const DICTIONARY_KEYS = DICTIONARY.map(([name]) => name.toUpperCase());

const [US, RS, GS] = ["\x1f", "\x1e", "\x1d"];   // séparateurs de canon.js

class SessionError extends Error {}
const fail = (message) => { throw new SessionError(message); };

function matchAt(re, text, pos) {
  re.lastIndex = pos;
  return re.exec(text);
}

// Découpe un script SQL*Plus en instructions (sans « ; » final ni « / »).
export function splitScript(text) {
  const out = [];
  let pos = 0;
  const n = text.length;
  const atLineStart = (at) => !text.slice(text.lastIndexOf("\n", at - 1) + 1, at).trim();
  while (pos < n) {
    let m = matchAt(TOKEN_RE, text, pos);
    if (m.groups.ws !== undefined || m.groups.comment !== undefined || m[0] === ";") {
      pos += m[0].length;
      continue;
    }
    if (atLineStart(pos)) {
      const slash = matchAt(SLASH_AT, text, pos);
      if (slash) {
        pos += slash[0].length;
        continue;
      }
    }
    const command = matchAt(COMMAND_AT, text, pos);
    if (command) {
      out.push(command[0].replace(/[\s;]+$/, ""));
      pos += command[0].length;
      continue;
    }
    const block = ["BEGIN", "DECLARE"].includes(m[0].toUpperCase());
    const start = pos;
    let end = pos;
    while (pos < n) {
      m = matchAt(TOKEN_RE, text, pos);
      if (m.groups.ws !== undefined || m.groups.comment !== undefined) {
        pos += m[0].length;
        continue;
      }
      if (!block && m[0] === ";") {
        pos += 1;
        break;
      }
      if (m[0] === "/") {
        const slash = matchAt(SLASH_AT, text, pos);
        if (slash && atLineStart(pos)) {
          pos += slash[0].length;
          break;
        }
      }
      pos += m[0].length;
      end = pos;
    }
    out.push(text.slice(start, end));
  }
  return out;
}

const quote = (name) => `[${name}]`;
const unquote = (text) => text.replace(/^"+|"+$/g, "");
const clone = (value) => JSON.parse(JSON.stringify(value));
const remove = (list, item) => list.splice(list.indexOf(item), 1);
const sortedKey = (list) => JSON.stringify([...list].sort());

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

const raise = (message) => `SELECT RAISE(ABORT, ${literal(message)})`;

// Lecture séquentielle des jetons d'une instruction.
class Parser extends Rewriter {
  constructor(sql) {
    super(sql);
    this.k = 0;
    this.end = this.t.length;
  }

  done() {
    return this.k >= this.end;
  }

  // Les prochains jetons sont-ils ces mots, dans cet ordre ?
  peek(...list) {
    return list.every((w, i) => this.k + i < this.end && this.isWord(this.k + i, w));
  }

  accept(...list) {
    if (!this.peek(...list)) return false;
    this.k += list.length;
    return true;
  }

  atOp(op) {
    return this.k < this.end && this.isOp(this.k, op);
  }

  expect(...list) {
    if (!this.accept(...list)) fail(`ORA-00905: missing keyword - ${list.join(" ")} attendu`);
  }

  finish() {
    if (!this.done()) {
      fail("ORA-03048: SQL reserved word or symbol is not syntactically valid" +
        ` - « ${this.t[this.k][1]} » inattendu`);
    }
  }

  name(error = "ORA-00904: invalid identifier") {
    if (this.done() || !["id", "qid"].includes(this.t[this.k][0])) fail(error);
    const kind = this.t[this.k][0];
    let text = this.t[this.k][1];
    if (kind === "id" && RESERVED.has(text.toUpperCase())) {
      if (error.includes("ORA-00903")) fail(error);
      const hint = text.toUpperCase() === "COLUMN" ? " - sous Oracle, ADD et MODIFY s'écrivent sans COLUMN" : "";
      fail(`ORA-03050: invalid identifier: "${text.toUpperCase()}" is a reserved word${hint}`);
    }
    if (kind === "qid") {
      text = text.slice(1, -1);
      if (!IDENT_RE.test(text)) fail(error);
    }
    this.k++;
    return text;
  }

  // Bornes [début, fin] du contenu du groupe parenthésé courant.
  parenthesized() {
    if (!this.atOp("(")) fail("ORA-00906: missing left parenthesis");
    const m = this.matchParen(this.k, this.end);
    if (m === null) fail("ORA-00907: missing right parenthesis");
    const bounds = [this.k + 1, m];
    this.k = m + 1;
    return bounds;
  }

  text(a, b) {
    return a < b ? this.src.slice(this.t[a][2], this.t[b - 1][3]) : "";
  }

  names() {
    const [a, b] = this.parenthesized();
    return this.splitTop(a, b).map(([x, y]) => {
      if (y - x !== 1 || !["id", "qid"].includes(this.t[x][0])) fail("ORA-00904: invalid identifier");
      return unquote(this.t[x][1]);
    });
  }

  sub(a, b) {
    const part = Object.assign(Object.create(Parser.prototype), this);
    part.k = a;
    part.end = b;
    return part;
  }
}

function parseType(p) {
  if (p.done() || p.t[p.k][0] !== "id") fail("ORA-02263: need to specify the datatype for this column");
  const name = p.t[p.k][1].toUpperCase();
  p.k++;
  const args = [];
  if (p.atOp("(")) {
    const [a, b] = p.parenthesized();
    for (const [x, y] of p.splitTop(a, b)) {
      if (x < y && p.t[x][1] === "*") args.push(null);
      else if (x < y && /^[0-9]+$/.test(p.t[x][1])) args.push(Number(p.t[x][1]));
      else fail("ORA-02017: integer value required");
    }
  }
  const spec = { type: name, size: null, precision: null, scale: null };
  if (INTEGER_TYPES.includes(name)) {
    spec.type = "NUMBER";
    spec.scale = 0;
  } else if (DECIMAL_TYPES.includes(name)) {
    spec.type = "NUMBER";
    if (args.length) {
      if (args[0] !== null && !(args[0] >= 1 && args[0] <= 38)) {
        fail("ORA-01727: numeric precision specifier is out of range (1 to 38)");
      }
      spec.precision = args[0];
      spec.scale = args.length > 1 ? args[1] : 0;
    } else if (name !== "NUMBER") {
      spec.scale = 0;
    }
  } else if (FLOAT_TYPES.includes(name)) {
    if (name === "FLOAT" || name === "REAL") {
      spec.type = "FLOAT";
      spec.precision = args.length ? args[0] : name === "REAL" ? 63 : 126;
    }
  } else if (TEXT_TYPES.includes(name)) {
    if (name === "VARCHAR") spec.type = "VARCHAR2";
    const fixed = name === "CHAR" || name === "NCHAR";
    let size = 1;
    if (args.length) size = args[0] || 0;
    else if (!fixed) fail("ORA-00906: missing left parenthesis - la taille est obligatoire");
    if (size < 1) fail("ORA-01723: zero-length columns are not allowed");
    if (size > (fixed ? 2000 : 4000)) fail("ORA-00910: specified length too long for its datatype");
    spec.size = size;
  } else if (!["DATE", "TIMESTAMP", "CLOB"].includes(name)) {
    fail(`ORA-00902: invalid datatype - ${name}`);
  }
  return spec;
}

function displayType(col) {
  const kind = col.type;
  if (col.size !== null) return `${kind}(${col.size})`;
  if (kind === "FLOAT") return `FLOAT(${col.precision})`;
  if (kind === "NUMBER") {
    if (col.precision === null && col.scale === null) return kind;
    const precision = col.precision ?? 38;
    return col.scale ? `NUMBER(${precision},${col.scale})` : `NUMBER(${precision})`;
  }
  return kind === "TIMESTAMP" ? "TIMESTAMP(6)" : kind;
}

function dataLength(col) {
  if (col.size !== null) return col.type === "NCHAR" || col.type === "NVARCHAR2" ? col.size * 2 : col.size;
  return { DATE: 7, TIMESTAMP: 11, CLOB: 4000, BINARY_FLOAT: 4, BINARY_DOUBLE: 8 }[col.type] ?? 22;
}

function family(col) {
  if (["NUMBER", "FLOAT", "BINARY_FLOAT", "BINARY_DOUBLE"].includes(col.type)) return "number";
  if (col.type === "DATE" || col.type === "TIMESTAMP") return "date";
  return "text";
}

function find(items, name) {
  const key = name.toUpperCase();
  return items.find((item) => item.key === key) ?? null;
}

function column(table, name) {
  return find(table.cols, name) ?? fail(`ORA-00904: "${name.toUpperCase()}": invalid identifier`);
}

function conditionColumns(table, cond) {
  const used = new Rewriter(cond).t
    .filter(([kind]) => kind === "id" || kind === "qid")
    .map(([, text]) => unquote(text).toUpperCase());
  return table.cols.map((c) => c.key).filter((key) => used.includes(key));
}

// Une session : une base vide au départ, puis run(script) ou execute(instruction).
export class Session {
  constructor(SQL) {
    this.db = new SQL.Database();
    registerOracleFunctions(this.db);
    this.db.run(ORACLE_SETUP_SQL);
    this.sql("PRAGMA legacy_alter_table = ON");
    this.tables = [];
    this.views = [];
    this.serial = 8000;
    this.inTransaction = false;
    for (const [name, cols] of DICTIONARY) {
      this.sql(`CREATE TEMP TABLE ${name} (${cols.map(quote).join(", ")})`);
    }
    this.sql("PRAGMA foreign_keys = ON");
  }

  // ── Accès à SQLite ─────────────────────────────────────────────────────────

  sql(text) {
    let stmt = null;
    try {
      stmt = this.db.prepare(text);
      const rows = [];
      const started = Date.now();
      while (stmt.step()) {
        rows.push(stmt.get());
        if (rows.length > MAX_ROWS || (rows.length % 1000 === 0 && Date.now() - started > MAX_MS)) {
          fail(`Requête interrompue : plus de ${MAX_ROWS} lignes ou plus de ${MAX_MS / 1000} s ` +
            "(requête récursive sans fin ou produit cartésien trop grand ?)");
        }
      }
      return [stmt.getColumnNames(), rows];
    } catch (e) {
      if (e instanceof SessionError) throw e;
      throw new SessionError(String(e.message ?? e));
    } finally {
      stmt?.free();
    }
  }

  rows(text) {
    return this.sql(text)[1];
  }

  close() {
    this.db.close();
  }

  // ── Point d'entrée ─────────────────────────────────────────────────────────

  // Exécute un script comme SQL*Plus : une erreur n'arrête pas la suite.
  run(script) {
    return splitScript(script).map((statement) => this.execute(statement));
  }

  // Exécute une instruction : { sql, cols, rows } ou { sql, error }.
  execute(statement) {
    const out = { sql: statement };
    try {
      const result = this.dispatch(statement);
      if (result) [out.cols, out.rows] = result;
    } catch (e) {
      if (!(e instanceof SessionError)) throw e;
      out.error = e.message;
    }
    return out;
  }

  dispatch(statement) {
    if (COMMAND_START.test(statement)) {
      const m = /^DESC(?:RIBE)?\s+(\S+?)\s*;?$/i.exec(statement);
      if (m) return this.describe(unquote(m[1]));
      if (/^DESC/i.test(statement)) fail("SP2-0565: Illegal identifier.");
      return null;
    }
    const p = new Parser(statement);
    if (p.done()) return null;
    if (p.peek("SELECT") || p.peek("WITH") || p.isOp(0, "(")) return this.query(statement);
    if (p.peek("INSERT") || p.peek("UPDATE") || p.peek("DELETE")) return this.dml(statement);
    if (p.accept("COMMIT")) {
      p.accept("WORK");
      p.finish();
      return this.commit();
    }
    if (p.accept("ROLLBACK")) {
      p.accept("WORK");
      if (p.accept("TO")) {
        p.accept("SAVEPOINT");
        const name = p.name();
        p.finish();
        const never = `ORA-01086: savepoint '${name.toUpperCase()}' never established`;
        if (!this.inTransaction) fail(never);
        try {
          this.sql(`ROLLBACK TO ${quote(name.toUpperCase())}`);
        } catch {
          fail(never);
        }
        return null;
      }
      p.finish();
      return this.rollback();
    }
    if (p.accept("SAVEPOINT")) {
      const name = p.name();
      p.finish();
      this.begin();
      this.sql(`SAVEPOINT ${quote(name.toUpperCase())}`);
      return null;
    }
    if (p.peek("BEGIN")) return this.block(p);
    if (p.accept("CREATE")) {
      const replace = p.accept("OR", "REPLACE");
      if (p.accept("VIEW")) return this.ddl(() => this.createView(p, replace));
      if (p.accept("TABLE") && !replace) return this.ddl(() => this.createTable(p));
    } else if (p.accept("ALTER")) {
      if (p.accept("TABLE")) return this.ddl(() => this.alterTable(p));
      if (p.accept("SESSION")) return null;
    } else if (p.accept("DROP")) {
      if (p.accept("TABLE")) return this.ddl(() => this.dropTable(p));
      if (p.accept("VIEW")) return this.ddl(() => this.dropView(p));
    } else if (p.accept("TRUNCATE")) {
      if (p.accept("TABLE")) return this.ddl(() => this.truncate(p));
    } else if (p.peek("DECLARE")) {
      fail(`${NOT_SIMULATED}bloc PL/SQL avec DECLARE`);
    } else {
      fail(`SP2-0734: unknown command beginning « ${p.t[0][1]} »`);
    }
    return fail(NOT_SIMULATED + p.t.slice(0, 3).map(([, text]) => text).join(" ").toUpperCase());
  }

  // ── Transactions ───────────────────────────────────────────────────────────

  begin() {
    if (!this.inTransaction) {
      this.sql("BEGIN");
      this.inTransaction = true;
    }
  }

  commit() {
    if (this.inTransaction) {
      try {
        this.sql("COMMIT");
      } catch (e) {
        this.sql("ROLLBACK");
        this.inTransaction = false;
        if (e.message.includes("FOREIGN KEY constraint failed")) {
          fail("ORA-02091: transaction rolled back - clé étrangère différée violée (ORA-02291)");
        }
        throw e;
      }
      this.inTransaction = false;
    }
    return null;
  }

  rollback() {
    if (this.inTransaction) {
      this.sql("ROLLBACK");
      this.inTransaction = false;
    }
    return null;
  }

  block(p) {
    p.expect("BEGIN");
    if (!(p.end > 1 && p.isOp(p.end - 1, ";") && p.isWord(p.end - 2, "END"))) {
      fail("ORA-06550: PLS-00103 - un bloc se termine par « END; »");
    }
    const bodyEnd = p.end - 2;
    const body = p.t.slice(p.k, bodyEnd).map(([, text]) => text.toUpperCase()).join(" ");
    // Boucle de nettoyage des scripts du cours : suppression de toutes les vues.
    if (new RegExp("^FOR (\\S+) IN \\( SELECT VIEW_NAME FROM USER_VIEWS \\) LOOP EXECUTE IMMEDIATE" +
        " 'DROP VIEW \"' \\|\\| \\1 \\. VIEW_NAME \\|\\| '\"' ; END LOOP ;$").test(body)) {
      return this.ddl(() => this.dropAllViews());
    }
    const statements = [];
    let start = p.k;
    let depth = 0;
    for (let m = p.k; m < bodyEnd; m++) {
      if (p.isOp(m, "(")) depth++;
      else if (p.isOp(m, ")")) depth--;
      else if (depth === 0 && p.isOp(m, ";")) {
        if (start < m) statements.push([start, m]);
        start = m + 1;
      }
    }
    if (start < bodyEnd) fail("ORA-06550: PLS-00103 - « ; » attendu avant END");
    if (!statements.length) fail("ORA-06550: PLS-00103 - un bloc vide contient au moins NULL;");
    for (const [a] of statements) {
      if (p.isWord(a, "SELECT", "WITH")) {
        fail("ORA-06550: PLS-00428: an INTO clause is expected in this SELECT statement");
      }
      if (p.isWord(a, "CREATE", "ALTER", "DROP", "TRUNCATE", "DESC", "DESCRIBE")) {
        fail("ORA-06550: PLS-00103 - pas de LDD ni de commande SQL*Plus dans un bloc");
      }
      if (!p.isWord(a, "INSERT", "UPDATE", "DELETE", "COMMIT", "ROLLBACK", "SAVEPOINT", "NULL")) {
        fail(`${NOT_SIMULATED}${p.t[a][1].toUpperCase()} dans un bloc PL/SQL` +
          " (seuls LMD et contrôle de transaction le sont)");
      }
    }
    this.begin();
    this.sql("SAVEPOINT ora__block");
    try {
      for (const [a, b] of statements) {
        if (p.isWord(a, "NULL")) continue;
        this.dispatch(p.text(a, b));
        if (!this.inTransaction) {            // COMMIT ou ROLLBACK : le travail suivant repart de là
          this.begin();
          this.sql("SAVEPOINT ora__block");
        }
      }
    } catch (e) {
      if (this.inTransaction) {
        try {
          this.sql("ROLLBACK TO ora__block");
          this.sql("RELEASE ora__block");
        } catch {
          this.rollback();
        }
      }
      throw e;
    }
    this.sql("RELEASE ora__block");
    return null;
  }

  // ── Interrogation et LMD ───────────────────────────────────────────────────

  query(statement) {
    const error = checkOracle(statement);
    if (error) fail(error);
    const tokens = new Rewriter(statement);
    let depth = 0;
    for (let m = 0; m < tokens.t.length; m++) {
      if (tokens.isOp(m, "(")) depth++;
      else if (tokens.isOp(m, ")")) depth--;
      // SQLite accepte « WITH … DELETE » : Oracle non, et le LMD échapperait à la transaction.
      if (depth === 0 && tokens.isWord(m, "INSERT", "UPDATE", "DELETE")) {
        fail("ORA-00928: SELECT keyword missing");
      }
    }
    // DEFERRABLE : colonne de User_Constraints, mais mot réservé de SQLite.
    let sql = statement;
    for (const [kind, text, a, b] of [...tokens.t].reverse()) {
      if (kind === "id" && text.toUpperCase() === "DEFERRABLE") sql = `${sql.slice(0, a)}[${text}]${sql.slice(b)}`;
    }
    try {
      return this.sql(translateOracle(sql));
    } catch (e) {
      return fail(this.explain(e.message));
    }
  }

  dml(statement) {
    const error = checkOracle(statement);
    if (error) fail(error);
    const p = new Parser(statement);
    const verb = p.t[0][1].toUpperCase();
    let sql = statement;
    p.k = 1;
    if (verb === "INSERT") {
      if (!p.accept("INTO")) fail("ORA-00925: missing INTO keyword");
    } else if (verb === "DELETE") {
      if (!p.accept("FROM")) sql = `DELETE FROM ${sql.slice(p.t[0][3])}`;   // FROM est facultatif sous Oracle
    }
    const named = p.k;
    const target = p.name("ORA-00903: invalid table name");
    if ((verb === "UPDATE" || verb === "DELETE") && !p.done() && p.t[p.k][0] === "id" &&
        !["SET", "WHERE", "AS", "RETURNING"].includes(p.t[p.k][1].toUpperCase())) {
      // « UPDATE table alias » : SQLite exige AS.
      sql = `${p.src.slice(0, p.t[named][3])} AS ${p.src.slice(p.t[p.k][2])}`;
      if (verb === "DELETE" && named === 1) sql = `DELETE FROM ${sql.slice(p.t[0][3])}`;
    }
    if (DICTIONARY_KEYS.includes(target.toUpperCase())) {
      fail("ORA-01031: insufficient privileges - le dictionnaire ne se modifie pas");
    }
    if (!find(this.tables, target) && !find(this.views, target)) {
      fail(`ORA-00942: table or view "${target.toUpperCase()}" does not exist`);
    }
    this.begin();
    try {
      this.sql(translateOracle(sql));
    } catch (e) {
      fail(this.explain(e.message, verb, target, p));
    }
    return null;
  }

  // Message SQLite → erreur Oracle.
  explain(message, verb = null, target = null, p = null) {
    if (/^(ORA|SP2|PLS)-/.test(message)) return message;
    let m = /^UNIQUE constraint failed: (.+)$/.exec(message);
    if (m) {
      const parts = m[1].split(",").map((x) => x.trim().split("."));
      const table = find(this.tables, parts[0][0]);
      const keys = sortedKey(parts.map((x) => x[x.length - 1].toUpperCase()));
      for (const c of table ? table.cons : []) {
        if ((c.type === "P" || c.type === "U") && sortedKey(c.cols) === keys) {
          return `ORA-00001: unique constraint (${c.key}) violated`;
        }
      }
      return "ORA-00001: unique constraint violated";
    }
    if (message.includes("FOREIGN KEY constraint failed")) {
      let parent = verb === "DELETE";
      const table = target ? find(this.tables, target) : null;
      if (verb === "UPDATE" && table) {
        const referenced = this.referencing(table).flatMap(([, c]) => c.refcols);
        const list = p.t.slice(p.k).map(([, text]) => text.toUpperCase());
        const where = list.indexOf("WHERE");
        const changed = where >= 0 ? list.slice(0, where) : list;
        parent = referenced.some((k) => changed.includes(k));
      }
      return parent
        ? "ORA-02292: integrity constraint violated - child record found"
        : "ORA-02291: integrity constraint violated - parent key not found";
    }
    m = /no such table: (?:main\.|temp\.)?(\S+)/.exec(message);
    if (m) return `ORA-00942: table or view "${m[1].toUpperCase()}" does not exist`;
    m = /no such column: (\S+)/.exec(message) || /has no column named (\S+)/.exec(message);
    if (m) return `ORA-00904: "${m[1].replace(/^[[\]]+|[[\]]+$/g, "").toUpperCase()}": invalid identifier`;
    if (message.includes("ambiguous column name")) return "ORA-00918: column ambiguously defined";
    m = /has ([0-9]+) columns but ([0-9]+) values/.exec(message) ||
      /^([0-9]+) values for ([0-9]+) columns/.exec(message);
    if (m) {
      const [first, second] = [Number(m[1]), Number(m[2])];
      const [values, cols] = message.includes("values for") ? [first, second] : [second, first];
      return values > cols ? "ORA-00913: too many values" : "ORA-00947: not enough values";
    }
    if (message.includes("because it is a view")) {
      const view = target ? find(this.views, target) : null;
      if (verb === "INSERT" && view?.virtual) return "ORA-01733: virtual column not allowed here";
      return "ORA-01732: data manipulation operation not legal on this view";
    }
    return message;
  }

  // ── LDD : validation implicite, atomicité ──────────────────────────────────

  ddl(action) {
    this.commit();
    const saved = clone([this.tables, this.views, this.serial]);
    this.sql("PRAGMA foreign_keys = OFF");
    this.sql("BEGIN");
    try {
      action();
      this.refreshDictionary();
      this.sql("COMMIT");
    } catch (e) {
      this.sql("ROLLBACK");
      [this.tables, this.views, this.serial] = saved;
      if (!(e instanceof SessionError)) throw e;
      fail(this.explain(e.message));
    } finally {
      this.sql("PRAGMA foreign_keys = ON");
    }
    return null;
  }

  systemName() {
    this.serial++;
    return `SYS_C00${this.serial}`;
  }

  table(name) {
    return find(this.tables, name) ?? fail(`ORA-00942: table or view "${name.toUpperCase()}" does not exist`);
  }

  checkFreeName(name) {
    const key = name.toUpperCase();
    if (key === "DUAL" || DICTIONARY_KEYS.includes(key) || key.startsWith("ORA__") || key.startsWith("SQLITE_") ||
        find(this.tables, name) || find(this.views, name)) {
      fail("ORA-00955: name is already used by an existing object");
    }
  }

  referencing(table, key = null) {
    return this.tables.flatMap((t) => t.cons
      .filter((c) => c.type === "R" && c.ref === table.key &&
        (key === null || sortedKey(c.refcols) === sortedKey(key.cols)))
      .map((c) => [t, c]));
  }

  // ── Colonnes et contraintes ────────────────────────────────────────────────

  // Corps d'une contrainte (de colonne si col est fourni, sinon de table).
  constraintBody(p, col, name) {
    const c = {
      key: name ? name.toUpperCase() : null, cols: [], cond: null, notnull: false,
      ref: null, refcols: [], action: null, deferrable: false, deferred: false,
    };
    const own = () => (col ? [col] : p.names().map((x) => x.toUpperCase()));
    if (col && p.accept("NOT", "NULL")) {
      Object.assign(c, { type: "C", cols: [col], notnull: true });
    } else if (p.accept("PRIMARY", "KEY")) {
      Object.assign(c, { type: "P", cols: own() });
    } else if (p.accept("UNIQUE")) {
      Object.assign(c, { type: "U", cols: own() });
    } else if (p.accept("CHECK")) {
      const [a, b] = p.parenthesized();
      for (let m = a; m < b; m++) {
        if (p.isWord(m, "SELECT")) fail("ORA-02251: subquery not allowed here");
        if (p.isWord(m, "SYSDATE")) {
          fail("ORA-02436: date or system variable wrongly specified in CHECK constraint");
        }
      }
      if (a === b) fail("ORA-00936: missing expression");
      Object.assign(c, { type: "C", cond: p.text(a, b), column: col });
    } else if ((col && p.peek("REFERENCES")) || (!col && p.accept("FOREIGN", "KEY"))) {
      Object.assign(c, { type: "R", cols: own() });
      p.expect("REFERENCES");
      c.ref = p.name("ORA-00903: invalid table name").toUpperCase();
      if (p.atOp("(")) c.refcols = p.names().map((x) => x.toUpperCase());
      if (p.accept("ON", "DELETE")) {
        if (p.accept("CASCADE")) c.action = "CASCADE";
        else if (p.accept("SET", "NULL")) c.action = "SET NULL";
        else fail("ORA-00905: missing keyword - CASCADE ou SET NULL attendu");
      }
    } else {
      fail("ORA-00904: invalid identifier - contrainte attendue");
    }
    for (;;) {
      if (p.accept("NOT", "DEFERRABLE")) c.deferrable = false;
      else if (p.accept("DEFERRABLE")) c.deferrable = true;
      else if (p.accept("INITIALLY", "DEFERRED")) c.deferrable = c.deferred = true;
      else if (p.accept("INITIALLY", "IMMEDIATE")) c.deferred = false;
      else if (!p.accept("ENABLE")) break;
    }
    if (c.deferrable && c.type !== "R") fail(`${NOT_SIMULATED}DEFERRABLE ailleurs que sur une clé étrangère`);
    return c;
  }

  // DEFAULT et contraintes qui suivent un nom de colonne et son type.
  columnTail(p, col, constraints) {
    let nullable = null;
    while (!p.done()) {
      if (p.accept("DEFAULT")) {
        const start = p.k;
        let depth = 0;
        while (!p.done()) {
          if (depth === 0 && (p.peek("CONSTRAINT") || p.peek("PRIMARY") || p.peek("UNIQUE") || p.peek("CHECK") ||
              p.peek("REFERENCES") || p.peek("NOT", "NULL") || (p.k > start && p.peek("NULL")))) break;
          if (p.isOp(p.k, "(")) depth++;
          else if (p.isOp(p.k, ")")) depth--;
          p.k++;
        }
        if (start === p.k) fail("ORA-00936: missing expression");
        const text = p.text(start, p.k);
        col.default = text.toUpperCase() === "NULL" ? null : text;
      } else if (p.accept("NULL")) {
        nullable = true;
      } else {
        const name = p.accept("CONSTRAINT") ? p.name() : null;
        const c = this.constraintBody(p, col.key, name);
        if (c.notnull) nullable = false;
        constraints.push(c);
      }
    }
    return nullable;
  }

  // Élément de CREATE TABLE ou de ALTER TABLE … ADD.
  element(p, cols, constraints) {
    if (p.done()) fail("ORA-00904: invalid identifier");
    if (p.accept("CONSTRAINT")) {
      const name = p.name();
      constraints.push(this.constraintBody(p, null, name));
    } else if (p.peek("PRIMARY") || p.peek("UNIQUE") || p.peek("CHECK") || p.peek("FOREIGN")) {
      constraints.push(this.constraintBody(p, null, null));
    } else {
      const name = p.name();
      const col = { key: name.toUpperCase(), name, default: null, ...parseType(p) };
      cols.push(col);
      this.columnTail(p, col, constraints);
    }
    p.finish();
  }

  addColumns(table, cols) {
    for (const col of cols) {
      if (find(table.cols, col.key)) {
        if (table.created) fail("ORA-01430: column being added already exists in table");
        fail("ORA-00957: duplicate column name");
      }
      table.cols.push(col);
    }
  }

  addConstraints(table, constraints) {
    // Clés d'abord : une clé étrangère peut viser une clé de la même instruction.
    const ordered = [...constraints.filter((x) => x.type !== "R"), ...constraints.filter((x) => x.type === "R")];
    for (const c of ordered) {
      if (c.key) {
        if ([...this.tables, table].some((t) => t.cons.some((x) => x.key === c.key))) {
          fail("ORA-02264: name already used by an existing constraint");
        }
      } else {
        c.key = this.systemName();
      }
      const cols = c.cols.map((k) => column(table, k));
      if (new Set(c.cols).size !== c.cols.length) fail("ORA-00957: duplicate column name");
      if (c.notnull) {
        if (table.cons.some((x) => x.notnull && sortedKey(x.cols) === sortedKey(c.cols))) {
          fail("ORA-01442: column to be modified to NOT NULL is already NOT NULL");
        }
      } else if (c.type === "P" || c.type === "U") {
        if (c.type === "P" && table.cons.some((x) => x.type === "P")) {
          fail("ORA-02260: table can have only one primary key");
        }
        if (table.cons.some((x) => (x.type === "P" || x.type === "U") && sortedKey(x.cols) === sortedKey(c.cols))) {
          fail("ORA-02261: such unique or primary key already exists in the table");
        }
      } else if (c.type === "R") {
        const parent = c.ref === table.key ? table : this.table(c.ref);
        const keys = parent.cons.filter((x) => x.type === "P" || x.type === "U");
        if (!c.refcols.length) {
          const primary = keys.find((x) => x.type === "P") ??
            fail("ORA-02268: referenced table does not have a primary key");
          c.refcols = [...primary.cols];
        }
        if (c.refcols.length !== c.cols.length) {
          fail("ORA-02256: number of referencing columns must match referenced columns");
        }
        const refs = c.refcols.map((k) => column(parent, k));
        if (!keys.some((x) => sortedKey(x.cols) === sortedKey(c.refcols))) {
          fail("ORA-02270: no matching unique or primary key for this column-list");
        }
        if (cols.some((a, i) => family(a) !== family(refs[i]))) {
          fail("ORA-02267: column type incompatible with referenced column type");
        }
      } else {
        c.cols = conditionColumns(table, c.cond);
        if (c.column && !(c.cols.length === 1 && c.cols[0] === c.column)) {
          fail("ORA-02438: column check constraint cannot reference other columns");
        }
      }
      table.cons.push(c);
    }
  }

  // ── Catalogue → SQLite ─────────────────────────────────────────────────────

  tableSql(table, name) {
    const items = table.cols.map((col) => {
      const affinity = family(col) === "number" ? "NUMERIC" : "TEXT";
      const value = col.default ? ` DEFAULT (${translateOracle(col.default)})` : "";
      return `${quote(col.name)} ${affinity}${value}`;
    });
    for (const c of table.cons) {
      const cols = c.cols.map(quote).join(", ");
      if (c.type === "P") items.push(`PRIMARY KEY (${cols})`);
      else if (c.type === "U") items.push(`UNIQUE (${cols})`);
      else if (c.type === "R") {
        let item = `FOREIGN KEY (${cols}) REFERENCES ${quote(c.ref)} (${c.refcols.map(quote).join(", ")})`;
        if (c.action) item += ` ON DELETE ${c.action}`;
        if (c.deferred) item += " DEFERRABLE INITIALLY DEFERRED";
        items.push(item);
      }
    }
    return `CREATE TABLE ${quote(name)} (${items.join(", ")})`;
  }

  triggerName(obj, event) {
    return quote(`ora__${obj.key}_${event}`);
  }

  tableTriggers(table) {
    const name = quote(table.name);
    for (const event of ["INSERT", "UPDATE"]) {
      const trigger = this.triggerName(table, event);
      const self = "rowid = NEW.rowid";
      const body = [];
      for (const col of table.cols) {
        const c = quote(col.name);
        const kind = col.type;
        const value = `NEW.${c}`;
        if (family(col) === "number") {
          body.push(`${raise("ORA-01722: invalid number")} WHERE typeof(${value}) = 'text'`);
          if (kind === "NUMBER" && col.scale !== null) {
            const rounded = `ORA_ROUND(${c}, ${col.scale})`;
            body.push(`UPDATE ${name} SET ${c} = ${rounded} WHERE ${self} AND ${c} <> ${rounded}`);
          }
          if (kind === "NUMBER" && col.precision !== null) {
            const message = raise("ORA-01438: value larger than specified precision allowed for this column");
            body.push(`${message} WHERE EXISTS (SELECT 1 FROM ${name} WHERE ${self}` +
              ` AND abs(${c}) >= 1e${col.precision - col.scale})`);
          }
        } else if (family(col) === "date") {
          body.push(`${raise("ORA-01861: literal does not match format string")} WHERE ${value} IS NOT NULL AND NOT` +
            ` (${value} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')`);
        } else if (col.size !== null) {
          const length = kind.startsWith("N") ? `length(${value})` : `length(CAST(${value} AS BLOB))`;
          const message = raise(`ORA-12899: value too large for column "${table.key}"."${col.key}"` +
            ` (maximum: ${col.size})`);
          body.push(`${message} WHERE ${length} > ${col.size}`);
          if (kind === "CHAR" || kind === "NCHAR") {
            body.push(`UPDATE ${name} SET ${c} = ORA_RPAD(${c}, ${col.size}, ' ')` +
              ` WHERE ${self} AND length(${c}) < ${col.size}`);
          }
        }
      }
      const required = [];
      for (const c of table.cons) {
        if (c.type === "P" || c.notnull) for (const k of c.cols) if (!required.includes(k)) required.push(k);
      }
      for (const key of required) {
        const where = `("${table.key}"."${key}")`;
        const message = event === "INSERT"
          ? `ORA-01400: cannot insert NULL into ${where}`
          : `ORA-01407: cannot update ${where} to NULL`;
        body.push(`${raise(message)} WHERE NEW.${quote(key)} IS NULL`);
      }
      for (const c of table.cons) {
        if (c.type === "C" && !c.notnull) {
          body.push(`${raise(`ORA-02290: check constraint (${c.key}) violated`)} WHERE EXISTS` +
            ` (SELECT 1 FROM ${name} WHERE ${self} AND NOT (${translateOracle(c.cond)}))`);
        } else if (c.type === "U" && c.cols.length > 1) {
          // Oracle : (A, NULL) deux fois viole l'unicité ; SQLite l'accepte.
          const same = c.cols.map((k) => `${quote(k)} IS NEW.${quote(k)}`).join(" AND ");
          const some = c.cols.map((k) => `NEW.${quote(k)} IS NOT NULL`).join(" OR ");
          body.push(`${raise(`ORA-00001: unique constraint (${c.key}) violated`)} WHERE (${some}) AND EXISTS` +
            ` (SELECT 1 FROM ${name} WHERE rowid <> NEW.rowid AND ${same})`);
        }
      }
      this.sql(`DROP TRIGGER IF EXISTS ${trigger}`);
      if (body.length) this.sql(`CREATE TRIGGER ${trigger} AFTER ${event} ON ${name} BEGIN ${body.join("; ")}; END`);
    }
  }

  exists(table, where) {
    return this.rows(`SELECT 1 FROM ${quote(table.name)} WHERE ${where} LIMIT 1`).length > 0;
  }

  duplicates(table, c) {
    const cols = c.cols.map(quote).join(", ");
    const some = c.cols.map((k) => `${quote(k)} IS NOT NULL`).join(" OR ");
    return this.rows(`SELECT 1 FROM ${quote(table.name)} WHERE ${some}` +
      ` GROUP BY ${cols} HAVING COUNT(*) > 1 LIMIT 1`).length > 0;
  }

  // Recrée la table d'après le catalogue ; valide les contraintes ajoutées sur les données.
  rebuild(table, before, added) {
    for (const c of added) {
      // Avant recréation : contrôles qui, sinon, échoueraient à la copie des données.
      if ((c.type === "P" || c.type === "U") && c.cols.every((k) => find(before.cols, k)) &&
          this.duplicates(before, c)) {
        fail(c.type === "P" ? "ORA-02437: cannot validate primary key - duplicates"
          : "ORA-02299: cannot validate - duplicate keys found");
      }
    }
    const kept = before.cols.filter((x) => find(table.cols, x.key));
    const name = quote(table.name);
    const temp = quote("ora__new");
    this.sql(this.tableSql(table, "ora__new"));
    if (kept.length) {
      const cols = kept.map((x) => quote(x.name)).join(", ");
      this.sql(`INSERT INTO ${temp} (${cols}) SELECT ${cols} FROM ${name} ORDER BY rowid`);
    }
    this.sql(`DROP TABLE ${name}`);
    this.sql(`ALTER TABLE ${temp} RENAME TO ${name}`);
    for (const c of added) {
      if (c.notnull || c.type === "P") {
        for (const key of c.cols) {
          if (this.exists(table, `${quote(key)} IS NULL`)) {
            if (!find(before.cols, key)) fail("ORA-01758: table must be empty to add mandatory (NOT NULL) column");
            fail(c.type === "P" ? "ORA-01449: column contains NULL values; cannot alter to NOT NULL"
              : "ORA-02296: cannot enable - null values found");
          }
        }
      } else if (c.type === "C") {
        if (this.exists(table, `NOT (${translateOracle(c.cond)})`)) {
          fail(`ORA-02293: cannot validate (${c.key}) - check constraint violated`);
        }
      } else if (c.type === "R") {
        if (this.rows(`PRAGMA foreign_key_check(${name})`).length) {
          fail(`ORA-02298: cannot validate (${c.key}) - parent keys not found`);
        }
      }
    }
    this.tableTriggers(table);
  }

  // ── Instructions LDD ───────────────────────────────────────────────────────

  createTable(p) {
    const ifMissing = p.accept("IF", "NOT", "EXISTS");
    const name = p.name("ORA-00903: invalid table name");
    if (ifMissing && find(this.tables, name)) return;
    this.checkFreeName(name);
    if (p.peek("AS")) {
      fail(`${NOT_SIMULATED}CREATE TABLE … AS SELECT : déclarez les colonnes et leurs types,` +
        " puis faites INSERT INTO … SELECT");
    }
    const [a, b] = p.parenthesized();
    p.finish();
    const cols = [];
    const constraints = [];
    for (const [x, y] of p.splitTop(a, b)) this.element(p.sub(x, y), cols, constraints);
    if (!cols.length) fail("ORA-00904: invalid identifier - aucune colonne");
    const table = { key: name.toUpperCase(), name, cols: [], cons: [], created: false };
    this.addColumns(table, cols);
    this.addConstraints(table, constraints);
    table.created = true;
    this.tables.push(table);
    this.sql(this.tableSql(table, name));
    for (const c of table.cons) {
      // colonne ou fonction inconnue : erreur dès le LDD
      if (c.type === "C" && !c.notnull) this.exists(table, `NOT (${translateOracle(c.cond)})`);
    }
    this.tableTriggers(table);
  }

  // « ( a, b ) » ou un seul élément : liste de sous-analyseurs.
  items(p) {
    if (p.atOp("(")) {
      const [a, b] = p.parenthesized();
      p.finish();
      return p.splitTop(a, b).map(([x, y]) => p.sub(x, y));
    }
    const part = p.sub(p.k, p.end);
    p.k = p.end;
    return [part];
  }

  alterTable(p) {
    const table = this.table(p.name("ORA-00903: invalid table name"));
    const before = clone(table);
    const added = [];
    if (p.accept("ADD")) {
      const cols = [];
      for (const part of this.items(p)) this.element(part, cols, added);
      this.addColumns(table, cols);
      this.addConstraints(table, added);
    } else if (p.accept("MODIFY")) {
      if (p.peek("CONSTRAINT") || p.peek("PRIMARY")) {
        fail(`${NOT_SIMULATED}MODIFY CONSTRAINT : supprimez puis recréez la contrainte`);
      }
      for (const part of this.items(p)) this.modifyColumn(table, part, added);
      this.addConstraints(table, added);
    } else if (p.accept("DROP")) {
      this.alterDrop(table, p);
    } else {
      fail(`${NOT_SIMULATED}ALTER TABLE … ${p.done() ? "" : p.t[p.k][1].toUpperCase()}`);
    }
    this.rebuild(table, before, added);
  }

  modifyColumn(table, p, added) {
    const col = column(table, p.name());
    const constraintFirst = ["DEFAULT", "NULL", "NOT", "CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "REFERENCES"]
      .some((w) => p.peek(w));
    if (!p.done() && !constraintFirst) {
      const changed = { ...col, ...parseType(p) };
      this.checkTypeChange(table, col, changed);
      Object.assign(col, changed);
    }
    if (this.columnTail(p, col, added) === true) {
      const existing = table.cons.find((c) => c.notnull && c.cols.length === 1 && c.cols[0] === col.key) ??
        fail("ORA-01451: column to be modified to NULL cannot be modified to NULL");
      remove(table.cons, existing);
    }
  }

  checkTypeChange(table, old, changed) {
    const name = quote(old.name);
    if (!this.exists(table, `${name} IS NOT NULL`)) return;
    if (old.type !== changed.type) fail("ORA-01439: column to be modified must be empty to change datatype");
    if (changed.size !== null && changed.size < old.size &&
        this.exists(table, `length(CAST(${name} AS BLOB)) > ${changed.size}`)) {
      fail("ORA-01441: cannot decrease column length because some value is too big");
    }
    if (changed.type === "NUMBER") {
      const { precision: p0, scale: s0 } = old;
      const { precision: p1, scale: s1 } = changed;
      const smaller = (s1 !== null && (s0 === null || s1 < s0)) ||
        (p1 !== null && (p0 === null || p1 - s1 < p0 - s0));
      if (smaller) fail("ORA-01440: column to be modified must be empty to decrease precision or scale");
    }
  }

  alterDrop(table, p) {
    if (p.accept("COLUMN") || p.atOp("(")) {
      const names = p.atOp("(") ? p.names() : [p.name()];
      const cascade = p.accept("CASCADE", "CONSTRAINTS");
      p.finish();
      const keys = names.map((n) => column(table, n).key);
      if (keys.length >= table.cols.length) fail("ORA-12983: cannot drop all columns in a table");
      for (const c of [...table.cons]) {
        if (!c.cols.some((k) => keys.includes(k))) continue;
        if (c.type === "P" || c.type === "U") {
          const children = this.referencing(table, c);
          if (children.length && !cascade) fail("ORA-12992: cannot drop parent key column");
          this.dropReferences(table, children);
        }
        if (!c.cols.every((k) => keys.includes(k)) && !cascade) {
          fail("ORA-12991: column is referenced in a multi-column constraint");
        }
        if (table.cons.includes(c)) remove(table.cons, c);
      }
      table.cols = table.cols.filter((c) => !keys.includes(c.key));
      return;
    }
    let found;
    let missing;
    if (p.accept("CONSTRAINT")) {
      const key = p.name().toUpperCase();
      found = table.cons.filter((c) => c.key === key);
      missing = "ORA-02443: Cannot drop constraint - nonexistent constraint";
    } else if (p.accept("PRIMARY", "KEY")) {
      found = table.cons.filter((c) => c.type === "P");
      missing = "ORA-02441: Cannot drop nonexistent primary key";
    } else if (p.accept("UNIQUE")) {
      const keys = sortedKey(p.names().map((x) => x.toUpperCase()));
      found = table.cons.filter((c) => c.type === "U" && sortedKey(c.cols) === keys);
      missing = "ORA-02442: Cannot drop nonexistent unique key";
    } else {
      fail("ORA-00905: missing keyword - COLUMN, CONSTRAINT, PRIMARY KEY ou UNIQUE attendu");
    }
    const cascade = p.accept("CASCADE");
    p.finish();
    if (!found.length) fail(missing);
    const c = found[0];
    if (c.type === "P" || c.type === "U") {
      const children = this.referencing(table, c);
      if (children.length && !cascade) {
        fail("ORA-02273: this unique/primary key is referenced by some foreign keys");
      }
      this.dropReferences(table, children);
    }
    remove(table.cons, c);
  }

  dropReferences(table, children) {
    for (const [child, c] of children) {
      const before = clone(child);
      if (child.cons.includes(c)) remove(child.cons, c);
      if (child !== table) this.rebuild(child, before, []);
    }
  }

  dropTable(p) {
    const ifExists = p.accept("IF", "EXISTS");
    const name = p.name("ORA-00903: invalid table name");
    const cascade = p.accept("CASCADE", "CONSTRAINTS");
    p.accept("PURGE");
    p.finish();
    if (ifExists && !find(this.tables, name)) return;
    const table = this.table(name);
    const children = this.referencing(table).filter(([t]) => t !== table);
    if (children.length && !cascade) {
      fail("ORA-02449: unique/primary keys in table referenced by foreign keys");
    }
    this.dropReferences(table, children);
    this.sql(`DROP TABLE ${quote(table.name)}`);
    remove(this.tables, table);
  }

  truncate(p) {
    const table = this.table(p.name("ORA-00903: invalid table name"));
    p.finish();
    if (this.referencing(table).some(([t]) => t !== table)) {
      fail("ORA-02266: unique/primary keys in table referenced by enabled foreign keys");
    }
    this.sql(`DELETE FROM ${quote(table.name)}`);
  }

  // ── Vues ───────────────────────────────────────────────────────────────────

  createView(p, replace) {
    const ifMissing = p.accept("IF", "NOT", "EXISTS");
    const name = p.name("ORA-00903: invalid table name");
    const existing = find(this.views, name);
    if (existing && ifMissing) return;
    if (!(existing && replace)) this.checkFreeName(name);
    const aliases = p.atOp("(") ? p.names() : [];
    if (!p.accept("AS")) fail("ORA-00905: missing keyword - AS attendu");
    const start = p.k;
    let end = p.end;
    let check = false;
    let readOnly = false;
    let option = null;
    if (end - 2 > start && p.isWord(end - 2, "CONSTRAINT")) {
      option = p.t[end - 1][1].toUpperCase();
      end -= 2;
    }
    if (end - 3 > start && p.isWord(end - 3, "WITH")) {
      check = p.isWord(end - 2, "CHECK") && p.isWord(end - 1, "OPTION");
      readOnly = p.isWord(end - 2, "READ") && p.isWord(end - 1, "ONLY");
      if (check || readOnly) end -= 3;
    }
    if (option && !(check || readOnly)) fail("ORA-00933: SQL command not properly ended");
    if (start >= end) fail("ORA-00928: missing SELECT keyword");
    const body = p.text(start, end);
    const error = checkOracle(body);
    if (error) fail(error);
    if (existing) {
      this.sql(`DROP VIEW ${quote(existing.name)}`);
      remove(this.views, existing);
    }

    const simple = this.simpleSelect(p.sub(start, end));
    let source = body;
    if (simple?.star) {
      // Oracle fige la liste des colonnes d'un SELECT * à la création de la vue.
      const listed = simple.table.cols.map((c) => quote(c.name)).join(", ");
      source = `SELECT ${listed} ${p.text(simple.from, end)}`;
    }
    const listing = aliases.length ? ` (${aliases.map(quote).join(", ")})` : "";
    this.sql(`CREATE VIEW ${quote(name)}${listing} AS ${translateOracle(source)}`);
    let names;
    let rows;
    try {
      [names, rows] = this.sql(`SELECT * FROM ${quote(name)} LIMIT 1`);
    } catch (e) {
      if (e.message.includes("columns") && aliases.length) {
        fail("ORA-01730: invalid number of column names specified");
      }
      throw e;
    }
    if (!aliases.length) {
      for (const col of names) {
        if (/:[0-9]+$/.test(col)) fail("ORA-00957: duplicate column name");
        if (!IDENT_RE.test(col)) fail("ORA-00998: must name this expression with a column alias");
      }
    }

    const bases = simple && simple.cols.length === names.length ? simple.cols : null;
    const origins = this.selectOrigins(p.sub(start, end), names.length);
    const cols = names.map((colName, i) => {
      const value = rows.length ? rows[0][i] : null;
      const origin = bases ? [simple.table, bases[i]] : origins[i];
      let col;
      if (origin) col = { ...origin[1], notNull: this.notNull(origin[0], origin[1].key) };
      else if (typeof value === "string") col = { type: "VARCHAR2", size: 4000, precision: null, scale: null };
      else col = { type: "NUMBER", size: null, precision: null, scale: null };
      return Object.assign(col, { key: colName.toUpperCase(), name: colName, default: null });
    });
    const optionKey = check || readOnly ? option ?? this.systemName() : null;
    const view = {
      key: name.toUpperCase(), name, text: body, cols, virtual: !bases && origins.includes(null),
      check, readOnly, option: optionKey,
    };
    this.views.push(view);
    if (readOnly) {
      const message = raise("ORA-42399: cannot perform a DML operation on a read-only view");
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        this.sql(`CREATE TRIGGER ${this.triggerName(view, event)} INSTEAD OF ${event}` +
          ` ON ${quote(name)} BEGIN ${message}; END`);
      }
    } else if (simple && bases) {
      this.viewTriggers(view, simple);
    } else if (check) {
      fail(`${NOT_SIMULATED}WITH CHECK OPTION sur une vue qui n'est pas` +
        " « SELECT colonnes FROM table WHERE condition »");
    }
  }

  // [table, colonne] d'où vient chaque colonne d'un SELECT, null pour une expression :
  // Oracle en reporte le type dans User_Tab_Columns.
  selectOrigins(p, count) {
    const none = new Array(count).fill(null);
    if (!p.accept("SELECT")) return none;
    if (!p.accept("DISTINCT")) p.accept("ALL");
    const first = p.k;
    let depth = 0;
    while (!p.done() && !(depth === 0 && p.peek("FROM"))) {
      if (p.isOp(p.k, "(")) depth++;
      else if (p.isOp(p.k, ")")) depth--;
      p.k++;
    }
    const items = p.splitTop(first, p.k);
    if (p.done() || items.length !== count) return none;
    const sources = [];                         // [nom dans la requête, table]
    for (let m = p.k + 1; m < p.end; m++) {
      if (["id", "qid"].includes(p.t[m][0]) && !p.isOp(m - 1, ".")) {
        const table = find(this.tables, unquote(p.t[m][1]));
        if (table) {
          sources.push([table.key, table]);
          if (m + 1 < p.end && p.t[m + 1][0] === "id") sources.push([p.t[m + 1][1].toUpperCase(), table]);
        }
      }
    }
    return items.map(([start, b]) => {
      let a = start;
      let qualifier = null;
      if (b - a >= 3 && p.isOp(a + 1, ".")) {
        qualifier = p.t[a][1].toUpperCase();
        a += 2;
      }
      const rest = b - a;
      if (rest === 1 || (rest === 2 && ["id", "qid"].includes(p.t[a + 1][0])) ||
          (rest === 3 && p.isWord(a + 1, "AS"))) {
        for (const [name, table] of sources) {
          const col = find(table.cols, unquote(p.t[a][1]));
          if (col && (qualifier === null || qualifier === name)) return [table, col];
        }
      }
      return null;
    });
  }

  // SELECT colonnes FROM table [alias] [WHERE …] : base d'une vue modifiable.
  simpleSelect(p) {
    if (!p.accept("SELECT")) return null;
    const first = p.k;
    let depth = 0;
    while (!p.done() && !(depth === 0 && p.peek("FROM"))) {
      if (p.isOp(p.k, "(")) depth++;
      else if (p.isOp(p.k, ")")) depth--;
      p.k++;
    }
    if (p.done()) return null;
    const last = p.k;
    const from = p.k;
    p.k++;
    if (p.done() || !["id", "qid"].includes(p.t[p.k][0])) return null;
    const base = find(this.tables, unquote(p.t[p.k][1]));
    if (!base) return null;
    p.k++;
    let alias = base.name;
    if (!p.done() && p.t[p.k][0] === "id") {
      const up = p.t[p.k][1].toUpperCase();
      if (!RESERVED.has(up) &&
          !["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "FETCH", "OFFSET"].includes(up)) {
        alias = p.t[p.k][1];
        p.k++;
      }
    }
    let cond = null;
    if (p.accept("WHERE")) {
      const a = p.k;
      depth = 0;
      while (!p.done()) {
        if (p.isOp(p.k, "(")) depth++;
        else if (p.isOp(p.k, ")")) depth--;
        else if (depth === 0 && ["GROUP", "ORDER", "UNION", "MINUS", "INTERSECT",
          "EXCEPT", "CONNECT", "START", "FETCH", "OFFSET"].some((w) => p.peek(w))) return null;
        p.k++;
      }
      cond = p.text(a, p.k);
    }
    if (!p.done()) return null;
    const star = last - first === 1 && p.isOp(first, "*");
    const cols = star ? [...base.cols] : [];
    if (!star) {
      for (const [start, b] of p.splitTop(first, last)) {
        let a = start;
        if (b - a >= 3 && p.isOp(a + 1, ".")) a += 2;
        const rest = b - a;
        if (!(rest === 1 || (rest === 2 && ["id", "qid"].includes(p.t[a + 1][0])) ||
            (rest === 3 && p.isWord(a + 1, "AS")))) return null;
        const col = find(base.cols, unquote(p.t[a][1]));
        if (!col || cols.includes(col)) return null;
        cols.push(col);
      }
    }
    return { table: base, alias, cond, cols, star, from };
  }

  viewTriggers(view, simple) {
    const name = quote(view.name);
    const base = quote(simple.table.name);
    const alias = quote(simple.alias);
    const shown = new Map(simple.cols.map((b, i) => [b.key, quote(view.cols[i].name)]));
    // Une colonne de vue perd l'affinité de sa colonne : on la redonne avant de comparer.
    const typed = (col) => (family(col) === "number"
      ? `ORA_TO_NUMBER(NEW.${shown.get(col.key)})`
      : `CAST(NEW.${shown.get(col.key)} AS TEXT)`);
    const cond = simple.cond ? translateOracle(simple.cond) : null;
    const found = [
      ...simple.cols.map((b) => `${quote(b.name)} IS OLD.${shown.get(b.key)}`),
      ...(cond ? [`(${cond})`] : []),
    ].join(" AND ");
    const row = `(SELECT ${alias}.rowid FROM ${base} AS ${alias} WHERE ${found} LIMIT 1)`;
    let check = "";
    let after = "";
    if (view.check && cond) {
      const message = raise("ORA-01402: view WITH CHECK OPTION where-clause violation");
      const fields = simple.table.cols.map((col) => `${shown.has(col.key) ? typed(col) : "NULL"} AS ${quote(col.name)}`);
      check = `${message} WHERE NOT EXISTS (SELECT 1 FROM (SELECT ${fields.join(", ")}) AS ${alias} WHERE ${cond}); `;
      // En UPDATE, Oracle contrôle la ligne de base (types, CHECK, clés étrangères) avant
      // WITH CHECK OPTION ; en INSERT, WITH CHECK OPTION d'abord.
      const byKey = new Map(simple.cols.map((b) => [b.key, b]));
      for (const c of simple.table.cons) {
        if (c.type !== "R" || c.deferred || !c.cols.every((k) => shown.has(k))) continue;
        const given = c.cols.map((k) => `${typed(byKey.get(k))} IS NOT NULL`).join(" AND ");
        const match = c.cols.map((k, i) => `${quote(c.refcols[i])} = ${typed(byKey.get(k))}`).join(" AND ");
        after += `; ${raise("ORA-02291: integrity constraint violated - parent key not found")} WHERE ${given}` +
          ` AND NOT EXISTS (SELECT 1 FROM ${quote(c.ref)} WHERE ${match})`;
      }
      const same = simple.cols.map((b) => `${quote(b.name)} IS ${typed(b)}`).join(" AND ");
      after += `; ${message} WHERE NOT EXISTS (SELECT 1 FROM ${base} AS ${alias} WHERE ${same} AND (${cond}))`;
    }
    const cols = simple.cols.map((b) => quote(b.name)).join(", ");
    const values = simple.cols.map((b) => `NEW.${shown.get(b.key)}`).join(", ");
    const sets = simple.cols.map((b) => `${quote(b.name)} = NEW.${shown.get(b.key)}`).join(", ");
    for (const [event, body] of [
      ["INSERT", `${check}INSERT INTO ${base} (${cols}) VALUES (${values})`],
      ["UPDATE", `UPDATE ${base} SET ${sets} WHERE rowid = ${row}${after}`],
      ["DELETE", `DELETE FROM ${base} WHERE rowid = ${row}`],
    ]) {
      this.sql(`CREATE TRIGGER ${this.triggerName(view, event)} INSTEAD OF ${event} ON ${name} BEGIN ${body}; END`);
    }
  }

  dropView(p) {
    const ifExists = p.accept("IF", "EXISTS");
    const name = p.name("ORA-00903: invalid table name");
    p.accept("CASCADE", "CONSTRAINTS");
    p.finish();
    const view = find(this.views, name);
    if (!view) {
      if (ifExists) return;
      fail(`ORA-00942: table or view "${name.toUpperCase()}" does not exist`);
    }
    this.sql(`DROP VIEW ${quote(view.name)}`);
    remove(this.views, view);
  }

  dropAllViews() {
    for (const view of this.views) this.sql(`DROP VIEW ${quote(view.name)}`);
    this.views = [];
  }

  // ── Dictionnaire de données ────────────────────────────────────────────────

  notNull(table, key) {
    return table.cons.some((c) => (c.type === "P" || c.notnull) && c.cols.includes(key));
  }

  refreshDictionary() {
    const rows = Object.fromEntries(DICTIONARY.map(([name]) => [name, []]));
    for (const [obj, isTable] of [...this.tables.map((t) => [t, true]), ...this.views.map((v) => [v, false])]) {
      const key = obj.key;
      rows.User_Objects.push([key, isTable ? "TABLE" : "VIEW", "VALID"]);
      obj.cols.forEach((col, i) => {
        const required = isTable ? this.notNull(obj, col.key) : col.notNull;
        rows.User_Tab_Columns.push([key, col.key, col.type, dataLength(col),
          col.precision, col.scale, required ? "N" : "Y", i + 1]);
      });
      if (!isTable) {
        rows.User_Views.push([key, obj.text]);
        if (obj.option) {
          rows.User_Constraints.push([obj.option, obj.check ? "V" : "O", key, null,
            null, "ENABLED", "NOT DEFERRABLE", "IMMEDIATE"]);
        }
        continue;
      }
      rows.User_Tables.push([key, "USERS"]);
      for (const c of obj.cons) {
        const cond = c.notnull ? `"${c.cols[0]}" IS NOT NULL` : c.cond;
        let ref = null;
        if (c.type === "R") {
          for (const x of find(this.tables, c.ref).cons) {
            if ((x.type === "P" || x.type === "U") && sortedKey(x.cols) === sortedKey(c.refcols)) ref = x.key;
          }
        }
        rows.User_Constraints.push([c.key, c.type, key, cond, ref, "ENABLED",
          c.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE", c.deferred ? "DEFERRED" : "IMMEDIATE"]);
        c.cols.forEach((col, i) => {
          rows.User_Cons_Columns.push([c.key, key, col, c.type === "C" ? null : i + 1]);
        });
        if (c.type === "P" || c.type === "U") rows.User_Objects.push([c.key, "INDEX", "VALID"]);
      }
    }
    for (const [name] of DICTIONARY) {
      this.sql(`DELETE FROM temp.${name}`);
      for (const row of rows[name]) this.sql(`INSERT INTO temp.${name} VALUES (${row.map(literal).join(", ")})`);
    }
  }

  describe(name) {
    const table = find(this.tables, name);
    const obj = table ?? find(this.views, name) ?? fail(`ORA-04043: object ${name.toUpperCase()} does not exist`);
    const rows = obj.cols.map((c) => {
      const required = table ? this.notNull(table, c.key) : c.notNull;
      return [c.key, required ? "NOT NULL" : null, displayType(c)];
    });
    return [["Name", "Null?", "Type"], rows];
  }

  // ── État, pour les tests et la notation ────────────────────────────────────

  // Contenu de chaque table : { NOM: lignes }, dans l'ordre d'insertion.
  state() {
    return Object.fromEntries(
      this.tables.map((t) => [t.key, this.rows(`SELECT * FROM ${quote(t.name)} ORDER BY rowid`)]));
  }

  // État noté d'une question LDD/LMD : { OBJET: texte canonique } (voir le jumeau Python).
  canonicalState() {
    const today = String(this.rows("SELECT ORA_SYSDATE()")[0][0]).slice(0, 10);
    const rows = (name) => this.rows(`SELECT * FROM ${quote(name)}`)
      .map((row) => row.map((v) => (typeof v === "string" && v.slice(0, 10) === today ? "\x00SYSDATE" : canonCell(v)))
        .join(US))
      .sort()
      .join(RS);
    const objects = {};
    for (const t of this.tables) {
      const cols = t.cols.map((c) => [c.key, displayType(c), this.notNull(t, c.key) ? "N" : "Y"].join(US)).join(RS);
      const keys = [];
      for (const c of t.cons) {
        if (c.type === "P" || c.type === "U") keys.push([c.type, [...c.cols].sort().join(",")].join(US));
        else if (c.type === "R") keys.push(["R", c.cols.join(","), c.ref, c.refcols.join(",")].join(US));
      }
      objects[t.key] = ["TABLE", cols, keys.sort().join(RS), rows(t.name)].join(GS);
    }
    for (const v of this.views) objects[v.key] = ["VIEW", String(v.cols.length), rows(v.name)].join(GS);
    return objects;
  }

  // Essaie chaque instruction puis l'annule : code d'erreur ORA, ou OK.
  probe(statements) {
    return statements.map((statement) => {
      this.execute("SAVEPOINT ora__probe");
      const r = this.execute(statement);
      this.execute("ROLLBACK TO ora__probe");
      if (r.error === undefined) return "OK";
      const m = /^((?:ORA|SP2|PLS)-[0-9]+)/.exec(r.error);
      return m ? m[1] : "ERREUR";
    });
  }
}

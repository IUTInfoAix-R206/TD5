// engine.js - encapsule sql.js (SQLite WASM).
//
// La base « maître » est construite une fois depuis data/schema.sql + data/insert.sql,
// puis exportée en instantané (snapshot). Chaque exécution de requête part d'une
// COPIE FRAÎCHE de cet instantané : un DELETE/UPDATE/DROP de l'étudiant ne peut donc
// jamais corrompre l'état, et il n'y a pas de « Reset » à gérer (le jeu de données
// est minuscule, recréer la base coûte quelques millisecondes).
//
// `initSqlJs` est fourni par vendor/sqljs/sql-wasm.js (chargé en <script> classique
// dans index.html, donc disponible en global).

import { rewriteQuantifiers } from "./sql-quantifiers.js";

let SQL = null;
let snapshot = null;
let schemaCache = null;

// Fonctions SQL personnalisées, réenregistrées sur chaque base fraîche.
// TO_DATE : les dates du jeu de données sont déjà au format ISO, la fonction est
// donc l'identité (permet d'accepter la syntaxe Oracle TO_DATE('2004-05-04', ...)).
function registerFunctions(db) {
  // 2 paramètres déclarés : sql.js déduit l'arité de function.length, et les
  // corrections utilisent TO_DATE(valeur, 'format') (syntaxe Oracle, 2 arguments).
  db.create_function("TO_DATE", (value, fmt) => value);
}

export async function initEngine(schemaUrl, insertUrl) {
  SQL = await initSqlJs({ locateFile: (f) => "vendor/sqljs/" + f });
  const [schema, insert] = await Promise.all([
    fetch(schemaUrl).then((r) => r.text()),
    fetch(insertUrl).then((r) => r.text()),
  ]);
  const db = new SQL.Database();
  registerFunctions(db);
  db.run(schema);
  if (insert.trim()) db.run(insert);
  snapshot = db.export();
  schemaCache = null;
  db.close();
}

// Exécute le SQL de l'étudiant sur une base fraîche.
// Renvoie { cols, rows } (résultat de la DERNIÈRE instruction) ou { error }.
export function runQuery(sql) {
  const db = new SQL.Database(snapshot);
  registerFunctions(db);
  try {
    // Réécrit les comparaisons quantifiées ALL/ANY (syntaxe Oracle/standard non
    // gérée par SQLite) en équivalents MAX/MIN/IN. Idempotent sur le SQL déjà réécrit.
    sql = rewriteQuantifiers(sql);
    let cols = [];
    let rows = [];
    let sawStatement = false;
    for (const stmt of db.iterateStatements(sql)) {
      cols = stmt.getColumnNames();
      rows = [];
      while (stmt.step()) rows.push(stmt.get());
      sawStatement = true;
    }
    if (!sawStatement) return { cols: [], rows: [], empty: true };
    return { cols, rows };
  } catch (e) {
    return { error: String(e.message || e) };
  } finally {
    db.close();
  }
}

// Schéma de la base, pour l'autocomplétion : { tables:[...], columns:{table:[...]},
// allColumns:[...] } (noms d'origine, casse préservée). Mis en cache.
export function getSchema() {
  if (schemaCache) return schemaCache;
  const empty = { tables: [], columns: {}, allColumns: [] };
  if (!SQL || !snapshot) return empty;
  const db = new SQL.Database(snapshot);
  try {
    const tables = [];
    const columns = {};
    const res = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    if (res.length) {
      for (const row of res[0].values) {
        const t = row[0];
        tables.push(t);
        const info = db.exec(`PRAGMA table_info("${String(t).replace(/"/g, '""')}")`);
        columns[t] = info.length ? info[0].values.map((r) => r[1]) : []; // r[1] = name
      }
    }
    const seen = new Set();
    const allColumns = [];
    for (const t of tables) {
      for (const c of columns[t]) {
        const k = c.toLowerCase();
        if (!seen.has(k)) { seen.add(k); allColumns.push(c); }
      }
    }
    schemaCache = { tables, columns, allColumns };
    return schemaCache;
  } catch {
    return empty;
  } finally {
    db.close();
  }
}

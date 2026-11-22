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

import {
  translateOracle, checkOracle, registerOracleFunctions, ORACLE_SETUP_SQL, oracleHint,
} from "./oracle-compat.js";
import { runSessionAnswer } from "./session-grade.js";

let SQL = null;
let snapshot = null;
let schemaCache = null;
let oracleScript = null;

// Fonctions de compatibilité Oracle (ORA_*, LIKE sensible à la casse), réenregistrées
// sur chaque base fraîche. Voir oracle-compat.js (jumeau de scripts/oracle_compat.py).
function registerFunctions(db) {
  registerOracleFunctions(db);
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
  db.run(ORACLE_SETUP_SQL); // table DUAL
  snapshot = db.export();
  schemaCache = null;
  db.close();
}

// Questions LDD/LMD : script Oracle des données (point de départ de chaque session).
export async function initSession(oracleUrl) {
  oracleScript = await fetch(oracleUrl).then((r) => r.text());
}

// Exécute une réponse LDD/LMD : voir session-grade.js.
export function runSession(prefix, answer, probes, mode) {
  if (!SQL || oracleScript === null) {
    return { error: "Le moteur SQL est encore en cours de chargement : réessayez dans un instant." };
  }
  return runSessionAnswer(SQL, oracleScript, prefix, answer, probes, mode);
}

// Garde-fous : sql.js s'exécute dans le fil principal ; une requête sans fin (CTE
// récursive infinie, produit cartésien énorme) figerait l'onglet. On l'interrompt
// au-delà de MAX_ROWS lignes produites ou de MAX_MS millisecondes.
const MAX_ROWS = 100000;
const MAX_MS = 5000;

// Exécute une requête sur une base fraîche.
// mode "sql" : SQL écrit par l'étudiant, en syntaxe Oracle → contrôles stricts puis
//   traduction Oracle → SQLite (oracle-compat.js).
// mode "algebra" : SQL généré par le compilateur d'algèbre (algebra.js), déjà en SQLite
//   et hors syntaxe Oracle → exécuté tel quel (identifiants entre guillemets compris).
// Renvoie { cols, rows } (résultat de la DERNIÈRE instruction) ou { error }.
export function runQuery(sql, mode = "sql") {
  if (!SQL || !snapshot) {
    return { error: "Le moteur SQL est encore en cours de chargement : réessayez dans un instant." };
  }
  const oracle = mode !== "algebra";
  // Contrôles stricts : refuse ce qu'Oracle refuserait (GROUP BY, alias AS, guillemets…).
  const strict = oracle ? checkOracle(sql) : null;
  if (strict) return { error: strict };
  const original = sql;
  const db = new SQL.Database(snapshot);
  registerFunctions(db);
  // Contraintes de clé étrangère appliquées, comme sous Oracle (désactivées par défaut
  // sous SQLite). Activées après le chargement des données, sur la copie de travail.
  db.run("PRAGMA foreign_keys = ON");
  try {
    // Traduit la syntaxe Oracle en SQL exécutable par SQLite (voir oracle-compat.js).
    if (oracle) sql = translateOracle(sql);
    const started = Date.now();
    let produced = 0;
    let cols = [];
    let rows = [];
    let sawStatement = false;
    for (const stmt of db.iterateStatements(sql)) {
      cols = stmt.getColumnNames();
      rows = [];
      while (stmt.step()) {
        rows.push(stmt.get());
        if (++produced > MAX_ROWS || (produced % 1000 === 0 && Date.now() - started > MAX_MS)) {
          stmt.free();
          return { error: `Requête interrompue : plus de ${MAX_ROWS} lignes ou plus de ${MAX_MS / 1000} s ` +
            "(requête récursive sans fin ou produit cartésien trop grand ?)" };
        }
      }
      sawStatement = true;
    }
    if (!sawStatement) return { cols: [], rows: [], empty: true };
    return { cols, rows };
  } catch (e) {
    // Construction Oracle non simulée : ajoute une explication au message SQLite.
    const message = String(e.message || e);
    const hint = oracle ? oracleHint(original, message) : null;
    return { error: message + (hint ? " - " + hint : "") };
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

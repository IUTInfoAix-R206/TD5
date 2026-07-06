// highlight.js - coloration syntaxique SQL minimale, sans dépendance.
//
// Produit du HTML échappé où chaque jeton est enveloppé dans un <span class="tok-…">.
// Utilisé comme calque affiché DERRIÈRE un <textarea> transparent (voir app.js) :
// le textarea garde tout le comportement (saisie, sélection, raccourcis), le <pre>
// ne sert qu'à l'affichage coloré.

const KEYWORDS = new Set([
  "SELECT", "DISTINCT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC",
  "AND", "OR", "NOT", "IN", "EXISTS", "IS", "NULL", "LIKE", "BETWEEN", "AS", "ON", "USING",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL",
  "UNION", "INTERSECT", "EXCEPT", "MINUS", "ALL", "ANY", "SOME",
  "CASE", "WHEN", "THEN", "ELSE", "END", "WITH", "RECURSIVE",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "MERGE",
  "CREATE", "TABLE", "VIEW", "INDEX", "DROP", "ALTER", "ADD", "COLUMN", "CONSTRAINT",
  "PRIMARY", "FOREIGN", "KEY", "REFERENCES", "UNIQUE", "CHECK", "DEFAULT",
  "LIMIT", "OFFSET", "FETCH", "FIRST", "NEXT", "ROW", "ROWS", "ONLY", "OVER", "PARTITION",
  "TRUE", "FALSE",
]);

const FUNCTIONS = new Set([
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ROUND", "ABS", "COALESCE", "NULLIF",
  "UPPER", "LOWER", "LENGTH", "SUBSTR", "SUBSTRING", "TRIM", "CONCAT",
  "TO_DATE", "TO_CHAR", "EXTRACT", "CAST", "DATE",
]);

const TOKEN_RE = new RegExp(
  "(--[^\\n]*|/\\*[\\s\\S]*?\\*/)" +     // 1 commentaire
  "|('(?:[^']|'')*'|\"[^\"]*\")" +        // 2 chaîne
  "|(\\b\\d+(?:\\.\\d+)?\\b)" +           // 3 nombre
  "|([A-Za-z_][A-Za-z0-9_]*)" +          // 4 mot (mot-clé / fonction / identifiant)
  "|(\\s+)" +                             // 5 espaces
  "|([^\\w\\s])",                         // 6 ponctuation / opérateur
  "g"
);

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightSQL(code) {
  let out = "";
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(code)) !== null) {
    if (m[1] !== undefined) out += `<span class="tok-comment">${escapeHtml(m[1])}</span>`;
    else if (m[2] !== undefined) out += `<span class="tok-string">${escapeHtml(m[2])}</span>`;
    else if (m[3] !== undefined) out += `<span class="tok-number">${escapeHtml(m[3])}</span>`;
    else if (m[4] !== undefined) {
      const word = m[4];
      const up = word.toUpperCase();
      if (KEYWORDS.has(up)) out += `<span class="tok-keyword">${escapeHtml(word)}</span>`;
      else if (FUNCTIONS.has(up)) out += `<span class="tok-function">${escapeHtml(word)}</span>`;
      else out += escapeHtml(word);
    } else if (m[5] !== undefined) out += m[5];
    else if (m[6] !== undefined) out += `<span class="tok-punct">${escapeHtml(m[6])}</span>`;
  }
  return out;
}

// ── Coloration de l'algèbre relationnelle (notation de référence) ────────────

const ALGEBRA_KEYWORDS = new Set([
  "SELECTION", "PROJECTION", "RENOMMAGE", "UNION", "INTERSECTION",
  "DIFFERENCE", "JOINTURE", "JOINTURE_NATURELLE", "DIVISION",
  "ET", "OU", "NON",
]);

const ALGEBRA_RE = new RegExp(
  "(--[^\\n]*)" +                          // 1 commentaire
  "|('(?:[^'\\n])*')" +                    // 2 chaîne
  "|(:=|->)" +                             // 3 affectation / flèche
  "|(<=|>=|<>|=|<|>)" +                    // 4 comparateur
  "|(\\b\\d{1,2}:\\d{2}\\b)" +             // 5 temps HH:MM
  "|(\\b\\d+(?:\\.\\d+)?\\b)" +            // 6 nombre
  "|([A-Za-z_\\u00C0-\\u024F][A-Za-z0-9_\\u00C0-\\u024F.]*)" + // 7 mot (mot-clé / relation / attribut)
  "|([(),/])" +                            // 8 ponctuation
  "|(\\s+)",                               // 9 espaces
  "g"
);

export function highlightAlgebra(code) {
  let out = "";
  ALGEBRA_RE.lastIndex = 0;
  let m, last = 0;
  while ((m = ALGEBRA_RE.exec(code)) !== null) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index)); // caractères non reconnus
    last = ALGEBRA_RE.lastIndex;
    if (m[1] !== undefined) out += `<span class="tok-comment">${escapeHtml(m[1])}</span>`;
    else if (m[2] !== undefined) out += `<span class="tok-string">${escapeHtml(m[2])}</span>`;
    else if (m[3] !== undefined) out += `<span class="tok-punct">${escapeHtml(m[3])}</span>`;
    else if (m[4] !== undefined) out += `<span class="tok-punct">${escapeHtml(m[4])}</span>`;
    else if (m[5] !== undefined) out += `<span class="tok-number">${escapeHtml(m[5])}</span>`;
    else if (m[6] !== undefined) out += `<span class="tok-number">${escapeHtml(m[6])}</span>`;
    else if (m[7] !== undefined) {
      const w = m[7];
      if (ALGEBRA_KEYWORDS.has(w)) out += `<span class="tok-keyword">${escapeHtml(w)}</span>`;
      else out += escapeHtml(w);
    } else if (m[8] !== undefined) out += `<span class="tok-punct">${escapeHtml(m[8])}</span>`;
    else out += m[9]; // espaces
  }
  if (last < code.length) out += escapeHtml(code.slice(last));
  return out;
}

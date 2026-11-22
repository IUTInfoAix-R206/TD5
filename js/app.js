// app.js - interface du TP SQL en ligne.

import { initEngine, initSession, runQuery, runSession, getSchema } from "./engine.js";
import { gradeSession, missingPrerequisites } from "./session-grade.js";
import { hashResult } from "./canon.js";
import { makeStore, buildExport, downloadText, exportFilename } from "./store.js";
import { highlightSQL, highlightAlgebra } from "./highlight.js";
import { compileAlgebra, AlgebraError } from "./algebra.js";
import { attachAutocomplete } from "./autocomplete.js";

const MAX_DISPLAY_ROWS = 50;

let questions = null;
let store = null;
let mode = "sql";       // "sql" | "algebra"
let catalog = null;     // schéma des tables (mode algèbre)
// Option enseignant (masquée aux étudiants) : ?sql dans l'URL affiche, en mode
// algèbre, le SQL compilé depuis la saisie de l'étudiant (jamais la correction).
let showSql = false;
let state = { answers: {}, name: "" };
const cards = new Map(); // id -> { statusEl, resultEl, feedbackEl }

// ── Utilitaires DOM ─────────────────────────────────────────────────────────

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.html != null) node.innerHTML = opts.html;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const c of children) node.appendChild(c);
  return node;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Affichage uniforme en MAJUSCULES (les valeurs de la base et la complétion le sont déjà).
// upcaseHtml : met le texte visible en capitales sans toucher aux balises ni aux entités.
function upcaseHtml(html) {
  return html.replace(/(<[^>]*>|&[a-zA-Z#0-9]+;)|([^<&]+)/g, (m, tag, txt) => tag || txt.toUpperCase());
}
// upcaseSql : met le DDL en capitales en laissant les lignes de commentaire (--) intactes.
function upcaseSql(text) {
  return text.split("\n").map((l) => (l.trimStart().startsWith("--") ? l : l.toUpperCase())).join("\n");
}

// ── Rendu de l'en-tête ──────────────────────────────────────────────────────

function renderHeader(root) {
  const progress = el("span", { class: "progress", attrs: { id: "progress" }, text: "" });

  const nameInput = el("input", {
    class: "name-input",
    attrs: { type: "text", placeholder: "Votre nom (optionnel)", value: state.name },
  });
  nameInput.addEventListener("input", () => {
    state.name = nameInput.value;
    store.save(state);
  });

  // En mode algèbre, l'export est un fichier texte .algebre (pas .sql).
  const exportExt = mode === "algebra" ? "algebre" : "sql";
  const exportBtn = el("button", { class: "btn", text: `Exporter .${exportExt}` });
  exportBtn.addEventListener("click", () => {
    downloadText(exportFilename(questions.tdId, state.name, exportExt), buildExport(questions, state));
  });

  const resetBtn = el("button", { class: "btn btn-danger", text: "Tout effacer" });
  resetBtn.addEventListener("click", () => {
    if (!confirm("Effacer toutes vos réponses enregistrées dans ce navigateur ?")) return;
    store.clear();
    try { localStorage.removeItem(`webtd:${questions.tdId}:playground`); } catch { /* ignore */ }
    state = { answers: {}, name: "" };
    location.reload();
  });

  const actions = el("div", { class: "header-actions" }, [nameInput, exportBtn, resetBtn]);
  const titleRow = el("div", { class: "title-row" }, [
    el("h1", { text: `${questions.tdLabel} - ${questions.title}` }),
    progress,
  ]);

  const header = el("header", { class: "app-header" }, [titleRow]);
  if (questions.intro) header.appendChild(el("p", { class: "intro", text: questions.intro }));
  if (questions.subjectPdf) {
    header.appendChild(el("p", { class: "subject-pdf" }, [
      el("a", {
        text: "📄 Ouvrir le sujet (PDF)",
        attrs: { href: questions.subjectPdf, target: "_blank", rel: "noopener" },
      }),
    ]));
  }
  header.appendChild(actions);
  header.appendChild(el("p", {
    class: "hint",
    text: "Vos réponses sont enregistrées dans ce navigateur uniquement. La base est réinitialisée à chaque exécution.",
  }));
  root.appendChild(header);
}

// ── Panneau schéma ──────────────────────────────────────────────────────────

async function renderSchemaPanel(root) {
  const rel = questions.database && questions.database.relationalSchema;
  // Mode algèbre : afficher le schéma relationnel (notation du cours), pas le SQL.
  if (mode === "algebra" && Array.isArray(rel) && rel.length) {
    const details = el("details", { class: "schema-panel", attrs: { open: "" } });
    details.appendChild(el("summary", { text: "Schéma relationnel" }));
    const box = el("div", { class: "schema-rel" });
    for (const line of rel) box.appendChild(el("div", { class: "schema-rel-line", html: upcaseHtml(line) }));
    details.appendChild(box);
    root.appendChild(details);
    return;
  }
  const details = el("details", { class: "schema-panel" });
  details.appendChild(el("summary", { text: "Schéma de la base de données" }));
  const pre = el("pre", { class: "schema-sql", text: "Chargement…" });
  details.appendChild(pre);
  root.appendChild(details);
  try {
    const text = await fetch(questions.database.schemaFile).then((r) => r.text());
    pre.textContent = upcaseSql(text.trim());
  } catch {
    pre.textContent = "(schéma indisponible)";
  }
}

// Rappel de syntaxe (mode algèbre) - panneau repliable pour les étudiants.
function renderSyntaxPanel(root) {
  const details = el("details", { class: "schema-panel syntax-panel" });
  details.appendChild(el("summary", { text: "Rappel : syntaxe de l'algèbre relationnelle" }));
  const body = el("div", { class: "syntax-body" });
  body.innerHTML = `
    <p>Une requête est une <strong>suite d'affectations</strong> (une par ligne, avec <code>:=</code> ou <code>=</code>) ;
       la <strong>dernière relation</strong> définie est la réponse. Exemple :</p>
    <pre>R1 := SELECTION (Avion / capacite &gt; 350)
R2 := PROJECTION (R1 / numAv, nomAv)</pre>
    <table class="syntax-table"><thead><tr><th>Opérateur</th><th>Forme</th></tr></thead><tbody>
      <tr><td>SÉLECTION</td><td>SÉLECTION (R / <em>condition</em>)</td></tr>
      <tr><td>PROJECTION</td><td>PROJECTION (R / attr1, attr2, …)</td></tr>
      <tr><td>RENOMMAGE</td><td>RENOMMAGE (R / ancien -&gt; nouveau, …) (ou →)</td></tr>
      <tr><td>UNION · INTERSECTION · DIFFÉRENCE</td><td>UNION (R1, R2)</td></tr>
      <tr><td>JOINTURE</td><td>JOINTURE (R1, R2 / attrG <em>op</em> attrD)</td></tr>
      <tr><td>JOINTURE_NATURELLE</td><td>JOINTURE_NATURELLE (R1, R2)</td></tr>
      <tr><td>DIVISION</td><td>DIVISION (R1, R2)</td></tr>
    </tbody></table>
    <p class="syntax-note">
      Conditions : comparateurs <code>=</code> <code>&lt;&gt;</code> (ou <code>!=</code>, <code>≠</code>) <code>&lt;</code> <code>&gt;</code>
      <code>&lt;=</code> (ou <code>≤</code>) <code>&gt;=</code> (ou <code>≥</code>) ; connecteurs <code>ET</code> / <code>OU</code> / <code>NON</code> ;
      chaînes entre apostrophes <code>'TEXTE'</code> ; heures <code>HH:MM</code> ;
      comparaison entre deux attributs (<code>adresse = villeDep</code>) ;
      commentaire <code>--</code> en fin de ligne ; noms de relations du type
      <code>R1</code>, <code>R2.1</code>, <code>R'4.1</code>, chacun affecté une seule fois. Opérateurs en <strong>MAJUSCULES</strong>, avec ou sans accent
      (<code>SÉLECTION</code> ou <code>SELECTION</code>).
    </p>`;
  details.appendChild(body);
  root.appendChild(details);
}

// Section « Comment fonctionne cette page ? » + terrain d'essai (sans évaluation).
function renderHowItWorks(root) {
  const isAlg = mode === "algebra";
  const what = isAlg ? "votre expression en algèbre relationnelle" : "votre requête SQL";
  const details = el("details", { class: "schema-panel howto-panel" });
  details.appendChild(el("summary", { text: "Comment fonctionne cette page ?" }));
  const body = el("div", { class: "howto-body" });
  const intro = el("div", { class: "howto-text" });
  intro.innerHTML = `
    <p>Pour chaque question, écrivez ${what} puis cliquez <strong>Exécuter</strong>
       (ou <code>Ctrl</code>/<code>Cmd</code> + <code>Entrée</code>).
       ${isAlg ? "Elle est traduite en SQL et exécutée" : "Elle est exécutée"} sur la base,
       et le résultat s'affiche dans une table.</p>
    <p>Un retour automatique compare votre résultat au résultat attendu (nombre de colonnes,
       de lignes et contenu) et affiche <strong>✓ Résultat exact</strong> si tout correspond -
       <em>sans jamais afficher la correction</em>.</p>
    <p>La base est <strong>réinitialisée à chaque exécution</strong> : vous pouvez tout tester
       sans risque. Vos réponses restent dans ce navigateur ; le bouton
       <strong>Exporter .${isAlg ? "algebre" : "sql"}</strong> les télécharge pour les rendre.</p>
    ${isAlg ? "<p>La notation de référence est imposée (voir le rappel de syntaxe) ; toute erreur est signalée précisément avec le numéro de ligne.</p>" : ""}
    ${questions.database.oracleFile ? `<p>Les questions qui <strong>modifient le schéma ou les données</strong> (ALTER, CREATE,
       UPDATE…) acceptent plusieurs instructions, comme SQL*Plus. Elles sont notées sur
       <strong>l'état de la base</strong> obtenu, pas sur le texte de la réponse. Chacune part des données
       d'origine, ou de l'état obtenu après vos réponses aux questions indiquées : elle reste
       bloquée tant que celles-ci ne sont pas exactes.</p>` : ""}`;
  body.appendChild(intro);

  // ── Terrain d'essai ────────────────────────────────────────────────────────
  body.appendChild(el("p", { class: "howto-pg-title", text: "Terrain d'essai (sans évaluation)" }));
  body.appendChild(el("p", { class: "howto-pg-sub", text: isAlg
    ? "Testez n'importe quelle expression : le résultat s'affiche, sans jugement de correction."
    : "Testez n'importe quelle requête : le résultat s'affiche, sans jugement de correction." }));

  const pgKey = `webtd:${questions.tdId}:playground`;
  const textarea = el("textarea", { class: "q-input", attrs: { spellcheck: "false", rows: "5",
    placeholder: isAlg ? "Écrivez une expression algébrique à tester…" : "Écrivez une requête SQL à tester…" } });
  try { textarea.value = localStorage.getItem(pgKey) || ""; } catch { /* ignore */ }
  const code = el("code");
  const pre = el("pre", { class: "q-highlight", attrs: { "aria-hidden": "true" } }, [code]);
  const editor = el("div", { class: "q-editor" }, [pre, textarea]);
  const highlight = isAlg ? highlightAlgebra : highlightSQL;
  const sync = () => { code.innerHTML = highlight(textarea.value + "\n"); pre.scrollTop = textarea.scrollTop; pre.scrollLeft = textarea.scrollLeft; };
  const savePg = debounce(() => { try { localStorage.setItem(pgKey, textarea.value); } catch { /* ignore */ } }, 400);
  const resultEl = el("div", { class: "q-result" });

  function runPg() {
    const input = textarea.value.trim();
    if (!input) { resultEl.replaceChildren(); return; }
    let sql = input;
    if (isAlg) {
      try { sql = compileAlgebra(input, catalog).sql; }
      catch (e) { resultEl.replaceChildren(el("div", { class: "sql-error", text: String(e && e.message || e) })); return; }
    }
    try { resultEl.replaceChildren(renderTable(runQuery(sql, mode))); }
    catch (e) { resultEl.replaceChildren(el("div", { class: "sql-error", text: String(e && e.message || e) })); }
  }

  textarea.addEventListener("input", () => { sync(); savePg(); });
  textarea.addEventListener("scroll", () => { pre.scrollTop = textarea.scrollTop; pre.scrollLeft = textarea.scrollLeft; });
  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runPg(); }
    else if (e.key === "Tab") {
      e.preventDefault();
      const s = textarea.selectionStart, en = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, s) + "    " + textarea.value.slice(en);
      textarea.selectionStart = textarea.selectionEnd = s + 4;
      sync(); savePg();
    }
  });
  sync();

  const runBtn = el("button", { class: "btn btn-run", text: "Exécuter ▶" });
  runBtn.addEventListener("click", runPg);
  body.appendChild(editor);
  body.appendChild(el("div", { class: "q-actions" }, [runBtn, el("span", { class: "run-hint", text: "Ctrl/Cmd + Entrée" })]));
  body.appendChild(resultEl);

  details.appendChild(body);
  root.appendChild(details);
}

// ── Rendu d'une table de résultat ───────────────────────────────────────────

function renderTable(result) {
  if (result.error) {
    return el("div", { class: "sql-error", text: "Erreur SQL : " + result.error });
  }
  const { cols, rows } = result;
  const table = el("table", { class: "result-table" });
  const thead = el("thead");
  thead.appendChild(el("tr", {}, cols.map((c) => el("th", { text: String(c).toUpperCase() }))));
  table.appendChild(thead);

  const tbody = el("tbody");
  const shown = rows.slice(0, MAX_DISPLAY_ROWS);
  for (const row of shown) {
    const tr = el("tr", {}, row.map((cell) => {
      if (cell === null || cell === undefined) {
        return el("td", { class: "cell-null" }, [el("span", { text: "NULL" })]);
      }
      return el("td", { text: String(cell) });
    }));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const wrap = el("div", { class: "table-wrap" }, [table]);
  if (rows.length > MAX_DISPLAY_ROWS) {
    wrap.appendChild(el("p", {
      class: "table-more",
      text: `… et ${rows.length - MAX_DISPLAY_ROWS} autres lignes (${rows.length} au total)`,
    }));
  } else if (rows.length === 0) {
    wrap.appendChild(el("p", { class: "table-more", text: "(aucune ligne)" }));
  }
  return wrap;
}

// ── Évaluation d'une réponse ────────────────────────────────────────────────

// Permutations des indices 0..n-1 (hors identité), pour reconnaître un résultat juste
// aux colonnes près. Limité à 6 colonnes (720 permutations).
function permutations(n) {
  const out = [];
  const rec = (prefix, rest) => {
    if (!rest.length) { out.push(prefix); return; }
    rest.forEach((x, i) => rec(prefix.concat(x), rest.slice(0, i).concat(rest.slice(i + 1))));
  };
  rec([], [...Array(n).keys()]);
  return out.slice(1);
}

async function columnsPermuted(question, result) {
  const n = result.cols.length;
  if (n < 2 || n > 6) return false;
  for (const perm of permutations(n)) {
    const rows = result.rows.map((r) => perm.map((i) => r[i]));
    if (question.hashesSorted.includes(await hashResult(n, rows, false))) return true;
  }
  return false;
}

async function grade(question, result, input = "") {
  if (result.error) return { kind: "error", message: result.error };
  const ncols = result.cols.length;
  const nrows = result.rows.length;
  const colsOk = ncols === question.expectedCols;
  const rowsOk = nrows === question.expectedRows;

  let sortedHash, orderedHash = null;
  try {
    sortedHash = await hashResult(ncols, result.rows, false);
    if (question.orderSensitive) orderedHash = await hashResult(ncols, result.rows, true);
  } catch (e) {
    return { kind: "hashfail", message: String(e && e.message || e), colsOk, rowsOk, ncols, nrows };
  }
  const sortedMatch = question.hashesSorted.includes(sortedHash);

  let exact = sortedMatch;
  let orderWrong = false;
  if (question.orderSensitive) {
    const orderedMatch = orderedHash === question.hashOrdered;
    exact = sortedMatch && orderedMatch;
    orderWrong = sortedMatch && !orderedMatch;
  }

  let kind;
  let permuted = false, roundHint = false;
  if (exact) kind = "exact";
  else if (orderWrong) kind = "order";
  else kind = "wrong";
  if (kind === "wrong" && colsOk && rowsOk) {
    if (await columnsPermuted(question, result)) {
      permuted = true;
      // En algèbre relationnelle, l'ordre des attributs n'a pas de sens.
      kind = mode === "algebra" && !question.orderSensitive ? "exact" : "columns";
    } else if (mode === "sql" && /\b(ROUND|TRUNC)\s*\(/i.test(input)) {
      roundHint = true;
    }
  }
  return { kind, colsOk, rowsOk, ncols, nrows, permuted, roundHint };
}

function chip(label, ok) {
  return el("span", { class: "chip " + (ok ? "chip-ok" : "chip-ko"), text: `${ok ? "✓" : "✗"} ${label}` });
}

function renderFeedback(question, g) {
  const box = el("div", { class: "feedback" });
  if (g.kind === "error") {
    box.classList.add("feedback-error");
    const msg = g.message ? "✗ Erreur SQL : " + g.message : "✗ Erreur SQL";
    box.appendChild(el("span", { class: "chip chip-ko", text: msg }));
    return box;
  }
  if (g.kind === "hashfail") {
    box.classList.add("feedback-error");
    box.appendChild(el("span", {
      class: "chip chip-ko",
      text: "✗ Vérification impossible (calcul du hash) : " + g.message,
    }));
    return box;
  }
  box.appendChild(chip(`Colonnes (attendu ${question.expectedCols}, obtenu ${g.ncols})`, g.colsOk));
  box.appendChild(chip(`Lignes (attendu ${question.expectedRows}, obtenu ${g.nrows})`, g.rowsOk));

  if (g.kind === "exact") {
    box.appendChild(el("span", { class: "chip chip-ok chip-strong", text: "✓ Résultat exact" }));
    if (g.permuted) {
      box.appendChild(el("span", { class: "chip chip-warn", text: "attributs dans un autre ordre (équivalent en algèbre)" }));
    }
  } else if (g.kind === "columns") {
    box.appendChild(el("span", { class: "chip chip-warn", text: "≈ Contenu correct, mais les colonnes ne sont pas dans l'ordre demandé" }));
  } else if (g.kind === "order") {
    box.appendChild(el("span", { class: "chip chip-warn", text: "≈ Contenu correct, mais l'ordre demandé n'est pas respecté" }));
  } else if (g.colsOk && g.rowsOk) {
    box.appendChild(el("span", { class: "chip chip-ko", text: "✗ Bons nombres de colonnes/lignes, mais le contenu diffère" }));
    if (g.roundHint) {
      box.appendChild(el("span", { class: "chip chip-warn", text: "Le résultat attendu n'est pas arrondi : retirez ROUND / TRUNC si l'énoncé ne le demande pas" }));
    }
  } else {
    box.appendChild(el("span", { class: "chip chip-ko", text: "✗ Résultat incorrect" }));
  }
  return box;
}

// ── Carte de question ───────────────────────────────────────────────────────

function difficultyStars(n) {
  if (n == null) return "";
  return "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
}

// Texte d'une liste de questions : « Q11, Q16 et Q19 ».
function questionList(ids) {
  const names = ids.map((id) => id.toUpperCase());
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}` : names[0];
}

// Résultat de chaque instruction d'une réponse LDD/LMD.
function renderSteps(steps) {
  const box = el("div", { class: "session-steps" });
  for (const step of steps) {
    const sql = step.sql.replace(/\s+/g, " ").trim();
    const label = sql.length > 90 ? sql.slice(0, 87) + "…" : sql;
    if (step.error !== undefined) {
      box.appendChild(el("div", { class: "sql-error", text: `${label}\n→ ${step.error}` }));
    } else if (step.rows) {
      box.appendChild(el("div", { class: "session-step", text: label }));
      // DESCRIBE : colonne « Null? » vide quand la colonne accepte NULL, comme SQL*Plus.
      const describe = step.cols.join() === "Name,Null?,Type";
      const rows = describe ? step.rows.map(([n, nul, t]) => [n, nul ?? "", t]) : step.rows;
      box.appendChild(renderTable({ cols: step.cols, rows }));
    } else {
      box.appendChild(el("div", { class: "session-step", text: "✓ " + label }));
    }
  }
  return box;
}

function renderSessionFeedback(g) {
  const box = el("div", { class: "feedback" });
  if (g.exact) {
    box.appendChild(el("span", { class: "chip chip-ok chip-strong", text: "✓ État de la base exact" }));
    return box;
  }
  box.appendChild(el("span", { class: "chip chip-ko", text: "✗ La base n'est pas dans l'état attendu" }));
  for (const k of g.missing) box.appendChild(el("span", { class: "chip chip-ko", text: `${k} : absente` }));
  for (const k of g.extra) box.appendChild(el("span", { class: "chip chip-ko", text: `${k} : en trop` }));
  for (const k of g.different) {
    box.appendChild(el("span", { class: "chip chip-ko", text: `${k} : colonnes, clés ou lignes différentes` }));
  }
  if (!g.probes) {
    box.appendChild(el("span", { class: "chip chip-warn",
      text: "Contraintes : elles n'acceptent pas exactement les valeurs attendues" }));
  }
  return box;
}

function renderQuestion(container, question) {
  const card = el("section", { class: "question-card", attrs: { id: question.id } });

  const titleBits = [el("span", { class: "q-num", text: "Q" + question.num })];
  if (question.difficulty != null) {
    titleBits.push(el("span", { class: "q-diff", attrs: { title: `difficulté ${question.difficulty}/5` }, text: difficultyStars(question.difficulty) }));
  }
  const status = el("span", { class: "q-status", text: "" });
  titleBits.push(status);
  card.appendChild(el("div", { class: "q-head" }, titleBits));

  card.appendChild(el("p", { class: "q-statement", text: question.statement }));
  if (question.expectedLabel) {
    const what = question.session ? "Pour vérifier : " : "Attendu : ";
    card.appendChild(el("p", { class: "q-expected", text: what + question.expectedLabel }));
  }
  let lockEl = null;
  if (question.session) {
    const requires = question.session.requires;
    card.appendChild(el("p", { class: "q-start", text: requires.length
      ? `Part de l'état de la base obtenu après ${requires.length > 1 ? "vos réponses" : "votre réponse"} à ${questionList(requires)}.`
      : "Part des données d'origine." }));
    lockEl = el("p", { class: "q-locked" });
    card.appendChild(lockEl);
  }
  if (question.sameAs) {
    card.appendChild(el("p", { class: "q-sameas", text: "Même résultat que " + question.sameAs.toUpperCase() }));
  }

  // Éditeur : textarea transparent au-dessus d'un calque <pre> colorié.
  const placeholder = mode === "algebra"
    ? "Écrivez votre expression algébrique ici…"
    : "Écrivez votre requête SQL ici…";
  const textarea = el("textarea", {
    class: "q-input",
    attrs: { spellcheck: "false", rows: "4", placeholder },
  });
  textarea.value = state.answers[question.id] || "";
  const highlightCode = el("code");
  const highlightPre = el("pre", { class: "q-highlight", attrs: { "aria-hidden": "true" } }, [highlightCode]);
  const editor = el("div", { class: "q-editor" }, [highlightPre, textarea]);
  const highlight = mode === "algebra" ? highlightAlgebra : highlightSQL;

  function syncHighlight() {
    // Ajoute un espace final pour qu'une ligne vide terminale s'affiche comme dans le textarea.
    highlightCode.innerHTML = highlight(textarea.value + "\n");
    highlightPre.scrollTop = textarea.scrollTop;
    highlightPre.scrollLeft = textarea.scrollLeft;
  }

  const saveDebounced = debounce(() => store.save(state), 400);
  textarea.addEventListener("input", () => {
    state.answers[question.id] = textarea.value;
    syncHighlight();
    saveDebounced();
  });
  textarea.addEventListener("scroll", () => {
    highlightPre.scrollTop = textarea.scrollTop;
    highlightPre.scrollLeft = textarea.scrollLeft;
  });

  // Autocomplétion contextuelle : tables/colonnes du schéma + mots-clés (SQL) ou
  // opérateurs/relations/attributs (algèbre). Déclenchée à la frappe et par Ctrl/Cmd+Espace.
  const ac = attachAutocomplete(textarea, {
    getMode: () => mode,
    getSchema,
    onInsert: () => {
      state.answers[question.id] = textarea.value;
      syncHighlight();
      saveDebounced();
    },
  });

  textarea.addEventListener("keydown", (e) => {
    if (ac.handleKeydown(e)) return; // la popup d'autocomplétion a consommé la touche
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const s = textarea.selectionStart, en = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, s) + "    " + textarea.value.slice(en);
      textarea.selectionStart = textarea.selectionEnd = s + 4;
      state.answers[question.id] = textarea.value;
      syncHighlight();
      saveDebounced();
    }
  });
  syncHighlight();

  const runBtn = el("button", { class: "btn btn-run", text: "Exécuter ▶" });
  const hint = el("span", { class: "run-hint", text: "Ctrl/Cmd + Entrée" });
  const resultEl = el("div", { class: "q-result" });
  const feedbackEl = el("div", { class: "q-feedback" });
  // Encart enseignant « SQL généré » (uniquement si ?sql en mode algèbre).
  let sqlPre = null, sqlBox = null;
  if (showSql) {
    sqlPre = el("pre", { class: "sql-generated-pre" });
    sqlBox = el("details", { class: "sql-generated" }, [el("summary", { text: "SQL généré (enseignant)" }), sqlPre]);
  }

  // Question LDD/LMD : bloquée tant qu'un prérequis n'est pas exact.
  function missing() {
    return question.session ? missingPrerequisites(question, isExact) : [];
  }
  function refreshLock() {
    if (!lockEl) return;
    const left = missing();
    runBtn.disabled = left.length > 0;
    lockEl.textContent = left.length ? `🔒 Réussissez d'abord ${questionList(left)}.` : "";
  }

  async function evaluateSession(input) {
    const prefix = question.session.requires.map((id) => state.answers[id] || "");
    const run = runSession(prefix, input, question.session.probes);
    if (run.error) return { compileError: run.error };
    return { steps: run.steps, g: await gradeSession(question, run) };
  }

  // Compile (algèbre), exécute et évalue une saisie : { result, g } ou { compileError }.
  async function evaluate(input) {
    if (question.session) {
      if (missing().length) return { locked: true };
      return evaluateSession(input);
    }
    let sql = input;
    if (mode === "algebra") {
      try {
        sql = compileAlgebra(input, catalog).sql;
        if (sqlPre) sqlPre.textContent = sql;
      } catch (e) {
        if (sqlPre) sqlPre.textContent = "(erreur de compilation)";
        return { compileError: String(e && e.message || e) };
      }
    }
    const result = runQuery(sql, mode);
    return { result, g: await grade(question, result, input) };
  }

  async function run() {
    const input = textarea.value.trim();
    if (!input) {
      resultEl.replaceChildren();
      feedbackEl.replaceChildren();
      status.textContent = "";
      return;
    }
    state.answers[question.id] = textarea.value;
    store.save(state);
    try {
      const { result, g, compileError, steps, locked } = await evaluate(input);
      if (locked) return;
      if (steps) {
        resultEl.replaceChildren(renderSteps(steps));
        feedbackEl.replaceChildren(renderSessionFeedback(g));
        setStatus(g.exact);
        await afterChange();
        return;
      }
      if (compileError) {
        resultEl.replaceChildren();
        feedbackEl.replaceChildren(el("div", { class: "feedback feedback-error" }, [
          el("span", { class: "chip chip-ko", text: "✗ " + compileError }),
        ]));
        status.textContent = "";
        updateProgress();
        return;
      }
      resultEl.replaceChildren(renderTable(result));
      feedbackEl.replaceChildren(renderFeedback(question, g));
      setStatus(g.kind === "exact");
      await afterChange();
    } catch (e) {
      feedbackEl.replaceChildren(el("div", { class: "feedback feedback-error" }, [
        el("span", { class: "chip chip-ko", text: "✗ Erreur interne : " + String(e && e.message || e) }),
      ]));
    }
  }

  runBtn.addEventListener("click", run);

  card.appendChild(editor);
  card.appendChild(el("div", { class: "q-actions" }, [runBtn, hint]));
  card.appendChild(resultEl);
  card.appendChild(feedbackEl);
  if (sqlBox) card.appendChild(sqlBox);
  container.appendChild(card);

  function setStatus(exact) {
    status.textContent = exact ? "✓" : "";
    status.className = "q-status " + (exact ? "ok" : "");
  }

  // Réévalue la réponse enregistrée (au chargement, ou quand un prérequis change).
  async function restore() {
    refreshLock();
    const input = textarea.value.trim();
    setStatus(false);
    if (!input || missing().length) return;
    try {
      const { g } = await evaluate(input);
      if (g) setStatus(question.session ? g.exact : g.kind === "exact");
    } catch { /* ignore */ }
  }

  cards.set(question.id, { status, restore, session: Boolean(question.session) });
}

// Question de cours : énoncé seul, sans éditeur ni auto-évaluation.
function renderTheory(container, question) {
  const card = el("section", { class: "question-card question-theory", attrs: { id: question.id } });
  card.appendChild(el("div", { class: "q-head" }, [el("span", { class: "q-num", text: "Q" + question.num })]));
  card.appendChild(el("p", { class: "q-statement", text: question.statement }));
  card.appendChild(el("p", { class: "q-theory-note", text: question.theoryNote || "Question de cours - pas d'auto-évaluation." }));
  container.appendChild(card);
}

// ── Progression ─────────────────────────────────────────────────────────────

function isExact(id) {
  const refs = cards.get(id);
  return Boolean(refs) && refs.status.textContent === "✓";
}

// Une réponse a changé : les questions LDD/LMD qui en partent sont réévaluées, dans l'ordre.
async function afterChange() {
  for (const refs of cards.values()) if (refs.session) await refs.restore();
  updateProgress();
}

let totalQuestions = 0;
const exactSet = new Set();

function updateProgress() {
  exactSet.clear();
  for (const [id, refs] of cards) {
    if (refs.status.textContent === "✓") exactSet.add(id);
  }
  const p = document.getElementById("progress");
  if (p) p.textContent = `Exactes : ${exactSet.size}/${totalQuestions}`;
}

// ── Amorçage ────────────────────────────────────────────────────────────────

async function main() {
  const root = document.getElementById("app");
  try {
    questions = await fetch("questions.json").then((r) => r.json());
  } catch {
    root.appendChild(el("p", { class: "fatal", text: "Impossible de charger questions.json." }));
    return;
  }
  mode = questions.mode || "sql";
  document.title = [questions.tdLabel, questions.title].filter(Boolean).join(" - ") || document.title;
  catalog = (questions.database && questions.database.catalog) || null;
  showSql = mode === "algebra" && new URLSearchParams(location.search).has("sql");
  store = makeStore(questions.tdId);
  state = store.load();

  renderHeader(root);
  await renderSchemaPanel(root);
  if (mode === "algebra") renderSyntaxPanel(root);
  renderHowItWorks(root);

  const main = el("main", { class: "sections" });
  for (const section of questions.sections) {
    if (section.name) main.appendChild(el("h2", { class: "section-title", text: section.name }));
    for (const item of section.items) {
      if (item.type === "instruction") main.appendChild(el("p", { class: "instruction", text: item.text }));
      else if (item.type === "text") main.appendChild(el("p", { class: "free-text", text: item.text }));
      else if (item.type === "question") {
        if (item.expectedCols === null && !item.session) { renderTheory(main, item); }   // question de cours
        else { totalQuestions++; renderQuestion(main, item); }
      }
    }
  }
  root.appendChild(main);

  const status = el("p", { class: "engine-status", text: "Chargement de SQLite (WASM)…" });
  root.appendChild(status);
  try {
    await initEngine(questions.database.schemaFile, questions.database.insertFile);
    if (questions.database.oracleFile) await initSession(questions.database.oracleFile);
    status.remove();
    // Progression : réévalue les réponses enregistrées dans ce navigateur.
    for (const refs of cards.values()) await refs.restore();
  } catch (e) {
    status.className = "engine-status fatal";
    status.textContent = "Échec du chargement de SQLite : " + (e.message || e)
      + " (la page doit être servie en http(s), pas ouverte via file://).";
  }
  updateProgress();
}

main();

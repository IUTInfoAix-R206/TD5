// store.js - persistance des réponses (localStorage) et export .sql.
//
// Les réponses restent dans le navigateur de l'étudiant : rien n'est envoyé à un
// serveur. La clé inclut l'identifiant du TD et une version de schéma (v1) : ne la
// changer que si le sens des identifiants de questions change.

const SCHEMA_VERSION = "v1";

export function makeStore(tdId) {
  const key = `webtd:${tdId}:${SCHEMA_VERSION}`;

  function load() {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { answers: {}, name: "" };
      const data = JSON.parse(raw);
      return { answers: data.answers || {}, name: data.name || "" };
    } catch {
      return { answers: {}, name: "" };
    }
  }

  function save(state) {
    try {
      localStorage.setItem(key, JSON.stringify({
        answers: state.answers,
        name: state.name,
        savedAt: new Date().toISOString(),
      }));
    } catch {
      /* quota plein ou stockage indisponible : on ignore silencieusement */
    }
  }

  function clear() {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  return { key, load, save, clear };
}

// Remplace les caractères typographiques non tapables au clavier par leur
// équivalent ASCII (les lettres accentuées, elles, sont conservées). Appliqué au
// texte des commentaires de l'export .sql, destiné à être ouvert dans un éditeur
// de code - contrairement au PDF/HTML qui gardent la typographie soignée.
// Motifs en \uXXXX : ce fichier source reste sans caractère spécial ni invisible.
function keyboardSafe(text) {
  return text
    .replace(/[\u2013\u2014]/g, "-")             // tirets demi-cadratin / cadratin
    .replace(/\u2026/g, "...")                   // points de suspension
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'") // apostrophes / quotes simples
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"') // guillemets doubles anglais
    .replace(/[\u00AB\u00BB]/g, '"')             // guillemets francais
    .replace(/[\u00A0\u202F\u2009]/g, " ");      // espaces insecables / fines
}

// Construit un fichier .sql : un bloc commenté par question + la réponse (ou un
// marqueur d'absence de réponse). L'énoncé est inséré en commentaire pour repérage.
export function buildExport(questions, state) {
  const lines = [];
  lines.push(`-- ${keyboardSafe(questions.tdLabel)} : ${keyboardSafe(questions.title)}`);
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`-- Export du ${today}${state.name ? ` - ${keyboardSafe(state.name)}` : ""}`);
  lines.push("");

  for (const section of questions.sections) {
    for (const item of section.items) {
      if (item.type !== "question") continue;
      const stmt = keyboardSafe((item.statement || "").replace(/\s+/g, " ").trim());
      lines.push(`-- Q${item.num} - ${stmt}`);
      const answer = (state.answers[item.id] || "").trim();
      if (answer) {
        lines.push(answer.endsWith(";") ? answer : answer + ";");
      } else {
        lines.push("-- (pas de réponse)");
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

// Nom du fichier exporté : inclut le nom de l'étudiant s'il est renseigné.
// Le nom est « slugifié » (accents retirés, minuscules, séparateurs → tirets) pour
// rester un nom de fichier valide sur tous les systèmes.
export function exportFilename(tdId, name, ext = "sql") {
  const slug = (name || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // retire les diacritiques
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")                        // tout le reste -> tiret
    .replace(/^-+|-+$/g, "")                            // pas de tiret en bord
    .slice(0, 60);
  return slug ? `${tdId}-reponses-${slug}.${ext}` : `${tdId}-reponses.${ext}`;
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// session-grade.js - notation des questions LDD/LMD (sans DOM, testée sous Node).
//
// Une question LDD/LMD (questions.json : item.session) est notée sur l'état de la base
// après la réponse, comparé aux empreintes calculées par le générateur
// (scripts/session_questions.py) : une empreinte par table ou vue, une pour les sondes
// de contraintes. Le point de départ rejoue les réponses de l'étudiant aux prérequis.
// Modes (voir session_questions.py) : « state » (tout l'état), « views » (les vues seules,
// rejouées sans les insertions de démonstration), « result » (aucun état). Une question
// avec expectedCols est en plus notée sur le résultat de sa dernière interrogation.

import { Session, splitScript } from "./oracle-session.js";
import { sha256Hex } from "./canon.js";

// Jumeaux de RE_QUERY et RE_VIEW_DDL (session_questions.py).
const RE_QUERY = /^\s*\(*\s*(?:SELECT|WITH)\b/i;
const RE_VIEW_DDL = /^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?VIEW|DROP\s+VIEW)\b/i;

export function viewStatements(script) {
  return splitScript(script).filter((s) => RE_VIEW_DDL.test(s)).map((s) => `${s}\n/`).join("\n");
}

// Dernier résultat d'une requête d'interrogation (pas d'un DESCRIBE).
export function lastResult(steps) {
  return steps.filter((s) => s.rows && RE_QUERY.test(s.sql)).pop() ?? null;
}

// Prérequis pas encore réussis : la question reste bloquée tant que la liste n'est pas vide.
export function missingPrerequisites(question, isExact) {
  return question.session.requires.filter((id) => !isExact(id));
}

// Exécute la réponse depuis le point de départ : données d'origine, puis chaque prérequis
// (réponse de l'étudiant), chacun suivi de COMMIT.
function startSession(SQL, dataScript, prefix) {
  const session = new Session(SQL);
  for (const script of [dataScript, ...prefix]) {
    session.run(script);
    session.execute("COMMIT");
  }
  return session;
}

export function runSessionAnswer(SQL, dataScript, prefix, answer, probes, mode = "state") {
  let session = startSession(SQL, dataScript, prefix);
  try {
    const steps = session.run(answer);
    if (mode === "result") return { steps, objects: {}, outcomes: [] };
    if (mode === "views") {
      session.close();
      session = startSession(SQL, dataScript, prefix);
      session.run(viewStatements(answer));
    }
    let objects = session.canonicalState();
    if (mode === "views") {
      const views = new Set(session.views.map((v) => v.key));
      objects = Object.fromEntries(Object.entries(objects).filter(([k]) => views.has(k)));
    }
    return { steps, objects, outcomes: session.probe(probes) };
  } finally {
    session.close();
  }
}

// { exact, missing, extra, different, probes } par rapport à l'état attendu le plus proche.
export async function gradeSession(question, run) {
  if (!question.session.states.length) return { exact: true, missing: [], extra: [], different: [], probes: true };
  const objects = {};
  for (const [key, text] of Object.entries(run.objects)) objects[key] = await sha256Hex(text);
  const probes = await sha256Hex(run.outcomes.join("\x1f"));
  let best = null;
  for (const want of question.session.states) {
    const keys = Object.keys(want.objects);
    const g = {
      missing: keys.filter((k) => !(k in objects)),
      extra: Object.keys(objects).filter((k) => !(k in want.objects)).sort(),
      different: keys.filter((k) => k in objects && objects[k] !== want.objects[k]),
      probes: probes === want.probes,
    };
    g.exact = !g.missing.length && !g.extra.length && !g.different.length && g.probes;
    const size = g.missing.length + g.extra.length + g.different.length + (g.probes ? 0 : 1);
    if (!best || size < best.size) best = { ...g, size };
  }
  delete best.size;
  return best;
}

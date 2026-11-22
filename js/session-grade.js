// session-grade.js - notation des questions LDD/LMD (sans DOM, testée sous Node).
//
// Une question LDD/LMD (questions.json : item.session) est notée sur l'état de la base
// après la réponse, comparé aux empreintes calculées par le générateur
// (scripts/session_questions.py) : une empreinte par table ou vue, une pour les sondes
// de contraintes. Le point de départ rejoue les réponses de l'étudiant aux prérequis.

import { Session } from "./oracle-session.js";
import { sha256Hex } from "./canon.js";

// Prérequis pas encore réussis : la question reste bloquée tant que la liste n'est pas vide.
export function missingPrerequisites(question, isExact) {
  return question.session.requires.filter((id) => !isExact(id));
}

// Exécute la réponse depuis le point de départ : données d'origine, puis chaque prérequis
// (réponse de l'étudiant), chacun suivi de COMMIT.
export function runSessionAnswer(SQL, dataScript, prefix, answer, probes) {
  const session = new Session(SQL);
  try {
    for (const script of [dataScript, ...prefix]) {
      session.run(script);
      session.execute("COMMIT");
    }
    const steps = session.run(answer);
    return { steps, objects: session.canonicalState(), outcomes: session.probe(probes) };
  } finally {
    session.close();
  }
}

// { exact, missing, extra, different, probes } par rapport à l'état attendu le plus proche.
export async function gradeSession(question, run) {
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

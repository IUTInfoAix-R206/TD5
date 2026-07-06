# TP SQL en ligne

Page web permettant de réaliser un TP de bases de données **entièrement dans le
navigateur** : une base SQLite (compilée en WebAssembly) exécute vos requêtes
côté client, le résultat s'affiche dans une table, et un retour automatique vous
indique si votre réponse est exacte.

## Utilisation

- Ouvrez la page (lien GitHub Pages du dépôt).
- Pour chaque question, écrivez votre requête SQL puis cliquez **Exécuter**
  (ou `Ctrl`/`Cmd` + `Entrée`).
- Le tableau affiche votre résultat ; les pastilles indiquent si le nombre de
  colonnes, le nombre de lignes et le contenu correspondent à ce qui est attendu.
  Un **Résultat exact** confirme la bonne réponse.

## Vos réponses

- Elles sont enregistrées **dans votre navigateur uniquement** (localStorage) :
  rien n'est envoyé à un serveur, et elles sont conservées entre les sessions sur
  le même navigateur/ordinateur.
- Le bouton **Exporter .sql** télécharge un fichier contenant toutes vos réponses
  (un bloc par question) : c'est ce fichier que vous pourrez rendre.
- Le bouton **Tout effacer** réinitialise vos réponses.

## Notes techniques

- La base est **réinitialisée à chaque exécution** : vous pouvez tester des
  `INSERT`/`UPDATE`/`DELETE` sans risque de corrompre les données.
- La correction n'est **pas** présente dans cette page : la vérification repose
  sur une empreinte (hash) du résultat attendu, calculée à l'avance.
- La page doit être servie en **http(s)** (GitHub Pages, ou `python3 -m http.server`).
  Elle ne fonctionne pas en l'ouvrant directement via `file://`.

## Crédits

Généré depuis les sources des TD de bases de données de l'IUT d'Aix-Marseille.
Moteur SQLite : [sql.js](https://github.com/sql-js/sql.js) (licence MIT).
Contenu sous licence **CC BY-NC-SA**.

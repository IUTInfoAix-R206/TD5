-- schema.sql - Schéma de la base de données "Gestion pédagogique"
-- Version PostgreSQL (adaptée depuis le script Oracle original)
-- Source Oracle : gestion-pedagogique-oracle.sql

DROP TABLE IF EXISTS Note;
DROP TABLE IF EXISTS Enseigne;
DROP TABLE IF EXISTS Professeur;
DROP TABLE IF EXISTS Module;
DROP TABLE IF EXISTS Etudiant;

CREATE TABLE Etudiant (
    numEt        NUMERIC(6,0)  PRIMARY KEY,
    nomEt        VARCHAR(30),
    prenomEt     VARCHAR(20),
    cpEt         VARCHAR(5),
    villeEt      VARCHAR(20),
    anneeEt      NUMERIC(2,0)  CHECK (anneeEt BETWEEN 1 AND 3),
    groupeEt     NUMERIC(1,0)  CHECK (groupeEt BETWEEN 1 AND 5),
    UNIQUE (nomEt, prenomEt)
);

CREATE TABLE Professeur (
    numProf      NUMERIC(3,0)  PRIMARY KEY,
    nomProf      VARCHAR(30),
    prenomProf   VARCHAR(20),
    adresseProf  VARCHAR(40),
    cpProf       VARCHAR(5),
    villeProf    VARCHAR(20),
    specProf     VARCHAR(7),
    UNIQUE (nomProf, prenomProf)
);

CREATE TABLE Module (
    code         VARCHAR(7)    PRIMARY KEY,
    libelle      VARCHAR(30),
    heureCMPrev  NUMERIC(3,0),
    heureCMReal  NUMERIC(3,0),
    heureTPPrev  NUMERIC(3,0),
    heureTPReal  NUMERIC(3,0),
    discipline   VARCHAR(15)   CHECK (discipline IN ('INFORMATIQUE', 'MATHS', 'GESTION')),
    coefCC       NUMERIC(3,0)  CHECK (coefCC BETWEEN 0 AND 100),
    coefTest     NUMERIC(3,0)  CHECK (coefTest BETWEEN 0 AND 100),
    resp         NUMERIC(3,0)  REFERENCES Professeur(numProf),
    codePere     VARCHAR(7)    REFERENCES Module(code),
    CHECK (COALESCE(coefCC, 0) + COALESCE(coefTest, 0) IN (0, 100))
);

CREATE TABLE Enseigne (
    code         VARCHAR(7)    REFERENCES Module(code),
    numProf      NUMERIC(3,0)  REFERENCES Professeur(numProf),
    numEt        NUMERIC(6,0)  REFERENCES Etudiant(numEt),
    PRIMARY KEY (code, numProf, numEt)
);

CREATE TABLE Note (
    numEt        NUMERIC(6,0)  REFERENCES Etudiant(numEt),
    code         VARCHAR(7)    REFERENCES Module(code),
    moyCC        NUMERIC(2,0)  CHECK (moyCC BETWEEN 0 AND 20),
    moyTest      NUMERIC(2,0)  CHECK (moyTest BETWEEN 0 AND 20),
    PRIMARY KEY (numEt, code)
);

-- La contrainte circulaire specProf → Module(code) est ajoutée
-- à la fin de insert.sql, après l'insertion des données.

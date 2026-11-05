'use strict';
// Modelo (M): conexión a la base de datos SQLite.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function abrirBaseDeDatos(ruta) {
  const archivo = ruta || process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'data', 'bitacora.db');

  if (archivo !== ':memory:') {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
  }

  const db = new Database(archivo);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON'); // sin esto SQLite NO respeta las llaves foráneas

  const esquema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(esquema);
  return db;
}

module.exports = { abrirBaseDeDatos };

-- =====================================================================
-- BitácoraAgro - Esquema de base de datos (SQLite)
-- Mismas entidades del Diagrama Entidad-Relación del análisis:
--   usuario, cultivo, insumo, parcela, lote, labor, cosecha, certificado, calificación
-- =====================================================================

-- ---------- Usuarios ----------
CREATE TABLE IF NOT EXISTS usuarios (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre         TEXT NOT NULL,
  correo         TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- credencial: se valida en back-end
  password_hash  TEXT NOT NULL,                          -- bcrypt, nunca texto plano
  rol            TEXT NOT NULL CHECK (rol IN ('ADMINISTRADOR','PRODUCTOR','COMPRADOR')),
  activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  creado_en      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Catálogos ----------
CREATE TABLE IF NOT EXISTS cultivos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  ciclo_dias  INTEGER NOT NULL CHECK (ciclo_dias > 0)
);

CREATE TABLE IF NOT EXISTS insumos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('FERTILIZANTE','PESTICIDA','FUNGICIDA','HERBICIDA','SEMILLA')),
  es_agroquimico  INTEGER NOT NULL DEFAULT 0 CHECK (es_agroquimico IN (0,1)),
  dias_carencia   INTEGER NOT NULL DEFAULT 0 CHECK (dias_carencia >= 0)   -- DATO SENSIBLE del core
);

-- ---------- Tablas del core (las llena el productor) ----------
CREATE TABLE IF NOT EXISTS parcelas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL,
  ubicacion   TEXT NOT NULL,
  hectareas   REAL NOT NULL CHECK (hectareas > 0),
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS lotes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo         TEXT NOT NULL UNIQUE,
  fecha_siembra  TEXT NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO','COSECHADO')),
  parcela_id     INTEGER NOT NULL REFERENCES parcelas(id),
  cultivo_id     INTEGER NOT NULL REFERENCES cultivos(id)
);

CREATE TABLE IF NOT EXISTS labores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo         TEXT NOT NULL CHECK (tipo IN ('RIEGO','ABONADO','FUMIGACION','DESHIERBE','OTRO')),
  fecha        TEXT NOT NULL,
  descripcion  TEXT NOT NULL DEFAULT '',
  cantidad     REAL,
  lote_id      INTEGER NOT NULL REFERENCES lotes(id),
  insumo_id    INTEGER REFERENCES insumos(id)
);

CREATE TABLE IF NOT EXISTS cosechas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha        TEXT NOT NULL,
  cantidad_kg  REAL NOT NULL CHECK (cantidad_kg > 0),
  calidad      TEXT NOT NULL,
  lote_id      INTEGER NOT NULL UNIQUE REFERENCES lotes(id)
);

CREATE TABLE IF NOT EXISTS certificados (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_publico  TEXT NOT NULL UNIQUE,
  hash            TEXT NOT NULL,
  fecha_emision   TEXT NOT NULL,
  lote_id         INTEGER NOT NULL UNIQUE REFERENCES lotes(id)
);

CREATE TABLE IF NOT EXISTS calificaciones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  puntaje       INTEGER NOT NULL CHECK (puntaje BETWEEN 1 AND 5),
  comentario    TEXT NOT NULL DEFAULT '',
  fecha         TEXT NOT NULL DEFAULT (datetime('now')),
  lote_id       INTEGER NOT NULL REFERENCES lotes(id),
  comprador_id  INTEGER NOT NULL REFERENCES usuarios(id),
  UNIQUE (lote_id, comprador_id)               -- un comprador califica una sola vez cada lote
);

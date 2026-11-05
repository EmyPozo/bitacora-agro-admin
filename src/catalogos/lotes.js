'use strict';
// Catálogo: Lotes.
//
// Dropdown EN CASCADA basado en una regla del core:
//   "Un lote solo puede crearse en una parcela propia"
//   Productor  ->  Parcela (solo las parcelas de ESE productor)  +  Cultivo
// El servidor vuelve a comprobar que la parcela pertenezca al productor elegido.
const { hoyISO } = require('../lib/validators');

module.exports = (db) => ({
  slug: 'lotes',
  titulo: 'Lotes',
  singular: 'Lote',
  icono: 'bi-grid-3x3-gap',
  tabla: 'lotes',
  etiquetaFila: (f) => f.codigo,

  valoresIniciales() {
    const n = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM lotes').get().n;
    return { codigo: `L-${String(n).padStart(4, '0')}`, fecha_siembra: hoyISO() };
  },
  // Al editar, el productor se obtiene de la parcela del lote
  alEditar(fila) {
    const p = db.prepare('SELECT usuario_id FROM parcelas WHERE id = ?').get(fila.parcela_id);
    return { productor_id: p ? p.usuario_id : '' };
  },

  campos: [
    { name: 'codigo', label: 'Código del lote', tipo: 'text', requerido: true, maxLen: 20, ayuda: 'Único. Ejemplo: L-0005.' },
    {
      name: 'productor_id', label: 'Productor', tipo: 'select-fk', requerido: true, guardar: false,
      ref: 'usuarios', refWhere: "rol = 'PRODUCTOR' AND activo = 1",
      opciones: () => db.prepare("SELECT id AS valor, nombre AS etiqueta FROM usuarios WHERE rol = 'PRODUCTOR' AND activo = 1 ORDER BY nombre").all(),
    },
    {
      // Depende del productor elegido
      name: 'parcela_id', label: 'Parcela', tipo: 'select-dep', requerido: true,
      ref: 'parcelas', dependeDe: 'productor_id',
      refFiltro: { col: 'usuario_id', desde: 'productor_id' },
      url: '/admin/api/productores/:id/parcelas',
      opcionesDe: (productorId) =>
        db.prepare('SELECT id AS valor, nombre AS etiqueta FROM parcelas WHERE usuario_id = ? ORDER BY nombre').all(Number(productorId)),
    },
    {
      name: 'cultivo_id', label: 'Cultivo', tipo: 'select-fk', requerido: true, ref: 'cultivos',
      opciones: () => db.prepare('SELECT id AS valor, nombre AS etiqueta FROM cultivos ORDER BY nombre').all(),
    },
    { name: 'fecha_siembra', label: 'Fecha de siembra', tipo: 'date', requerido: true, sensible: true },
  ],

  columnas: [
    { label: 'Código', campo: 'codigo' },
    { label: 'Cultivo', campo: 'cultivo' },
    { label: 'Parcela', formato: (f) => `${f.parcela} (${f.productor})` },
    { label: 'Siembra', campo: 'fecha_siembra' },
    { label: 'Estado', formato: (f) => (f.estado === 'ACTIVO' ? 'Activo' : 'Cosechado'), badge: (f) => (f.estado === 'ACTIVO' ? 'success' : 'secondary') },
  ],
  sqlLista: `
    SELECT l.*, cu.nombre AS cultivo, p.nombre AS parcela, u.nombre AS productor
    FROM lotes l
    JOIN cultivos cu ON cu.id = l.cultivo_id
    JOIN parcelas p ON p.id = l.parcela_id
    JOIN usuarios u ON u.id = p.usuario_id
    WHERE l.codigo LIKE @q OR cu.nombre LIKE @q OR p.nombre LIKE @q OR u.nombre LIKE @q
    ORDER BY l.codigo`,

  validar(d, { id, db: bd }) {
    const errores = {};
    // La siembra no puede ser en el futuro
    if (/^\d{4}-\d{2}-\d{2}$/.test(d.fecha_siembra) && d.fecha_siembra > hoyISO()) {
      errores.fecha_siembra = 'La fecha de siembra no puede ser posterior a hoy.';
    }
    if (d.codigo !== '' && !/^[A-Za-z0-9-]{3,20}$/.test(d.codigo)) {
      errores.codigo = 'Usa solo letras, números y guiones (3 a 20 caracteres).';
    }
    // Un lote no puede sembrarse después de que ya tenga labores registradas
    if (id !== null && !errores.fecha_siembra) {
      const antes = bd.prepare('SELECT COUNT(*) AS n FROM labores WHERE lote_id = ? AND fecha < ?').get(id, d.fecha_siembra).n;
      if (antes > 0) errores.fecha_siembra = 'Hay labores registradas antes de esa fecha de siembra.';
    }
    // Un lote cosechado ya no se modifica
    if (id !== null) {
      const l = bd.prepare('SELECT estado FROM lotes WHERE id = ?').get(id);
      if (l && l.estado === 'COSECHADO') errores.codigo = 'El lote ya fue cosechado y no se puede modificar.';
    }
    return errores;
  },
  normalizar(v) {
    v.codigo = v.codigo.toUpperCase();
  },
});

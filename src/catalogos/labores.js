'use strict';
// Catálogo: Labores del lote (riego, abonado, fumigación, deshierbe, otro).
//
// DATO SENSIBLE validado en el back-end: la FECHA de la labor. Es la base del
// historial verificable y del cálculo del tiempo de carencia, por eso el
// servidor aplica la regla (a) del core:
//   - el lote debe estar ACTIVO,
//   - la fecha no puede ser anterior a la siembra,
//   - la fecha no puede ser posterior a hoy.
const { hoyISO } = require('../lib/validators');

const TIPOS = [
  { valor: 'RIEGO', etiqueta: 'Riego' },
  { valor: 'ABONADO', etiqueta: 'Abonado' },
  { valor: 'FUMIGACION', etiqueta: 'Fumigación' },
  { valor: 'DESHIERBE', etiqueta: 'Deshierbe' },
  { valor: 'OTRO', etiqueta: 'Otro' },
];

module.exports = (db) => ({
  slug: 'labores',
  titulo: 'Labores',
  singular: 'Labor',
  femenino: true,
  icono: 'bi-journal-check',
  tabla: 'labores',
  etiquetaFila: (f) => `${(TIPOS.find((t) => t.valor === f.tipo) || {}).etiqueta || f.tipo} del ${f.fecha}`,

  valoresIniciales: () => ({ tipo: 'RIEGO', fecha: hoyISO() }),

  campos: [
    { name: 'tipo', label: 'Tipo de labor', tipo: 'select', requerido: true, opciones: TIPOS },
    { name: 'fecha', label: 'Fecha de la labor', tipo: 'date', requerido: true, sensible: true,
      ayuda: 'No puede ser anterior a la siembra ni posterior a hoy.' },
    {
      name: 'lote_id', label: 'Lote', tipo: 'select-fk', requerido: true, ref: 'lotes',
      opciones: () => db.prepare(`
        SELECT l.id AS valor, l.codigo || ' · ' || cu.nombre || ' · ' || p.nombre ||
               CASE l.estado WHEN 'ACTIVO' THEN '' ELSE ' (cosechado)' END AS etiqueta
        FROM lotes l JOIN cultivos cu ON cu.id = l.cultivo_id JOIN parcelas p ON p.id = l.parcela_id
        ORDER BY l.codigo`).all(),
    },
    {
      name: 'insumo_id', label: 'Insumo utilizado', tipo: 'select-fk', ref: 'insumos',
      ayuda: 'Obligatorio en abonado y fumigación.',
      opciones: () => db.prepare(`
        SELECT id AS valor, nombre || CASE WHEN es_agroquimico = 1 THEN ' (carencia ' || dias_carencia || ' días)' ELSE '' END AS etiqueta
        FROM insumos ORDER BY nombre`).all(),
    },
    { name: 'cantidad', label: 'Cantidad', tipo: 'number', decimal: true, min: 0, max: 1000000, ayuda: 'Opcional. Ejemplo: 25 (kg o litros).' },
    { name: 'descripcion', label: 'Descripción', tipo: 'text', maxLen: 200 },
  ],

  columnas: [
    { label: 'Fecha', campo: 'fecha' },
    { label: 'Labor', formato: (f) => (TIPOS.find((t) => t.valor === f.tipo) || {}).etiqueta || f.tipo },
    { label: 'Lote', formato: (f) => `${f.lote} · ${f.cultivo}` },
    { label: 'Insumo', formato: (f) => f.insumo || '—' },
    { label: 'Cantidad', formato: (f) => (f.cantidad === null ? '—' : f.cantidad) },
  ],
  sqlLista: `
    SELECT la.*, l.codigo AS lote, cu.nombre AS cultivo, i.nombre AS insumo
    FROM labores la
    JOIN lotes l ON l.id = la.lote_id
    JOIN cultivos cu ON cu.id = l.cultivo_id
    LEFT JOIN insumos i ON i.id = la.insumo_id
    WHERE l.codigo LIKE @q OR cu.nombre LIKE @q OR la.tipo LIKE @q OR i.nombre LIKE @q OR la.descripcion LIKE @q
    ORDER BY la.fecha DESC, la.id DESC`,

  validar(d, { db: bd }) {
    const errores = {};
    const lote = /^\d+$/.test(d.lote_id) ? bd.prepare('SELECT * FROM lotes WHERE id = ?').get(Number(d.lote_id)) : null;

    if (lote) {
      if (lote.estado !== 'ACTIVO') {
        errores.lote_id = 'El lote ya fue cosechado: sus labores están bloqueadas.';
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(d.fecha)) {
        if (d.fecha < lote.fecha_siembra) errores.fecha = `La fecha no puede ser anterior a la siembra (${lote.fecha_siembra}).`;
        else if (d.fecha > hoyISO()) errores.fecha = 'La fecha no puede ser posterior a hoy.';
      }
    }
    if ((d.tipo === 'ABONADO' || d.tipo === 'FUMIGACION') && d.insumo_id === '') {
      errores.insumo_id = 'Este tipo de labor necesita un insumo.';
    }
    return errores;
  },

  // Las labores de un lote cosechado no se pueden eliminar
  puedeEliminar(fila, { db: bd }) {
    const l = bd.prepare('SELECT estado FROM lotes WHERE id = ?').get(fila.lote_id);
    return l && l.estado !== 'ACTIVO' ? 'El lote ya fue cosechado: sus labores están bloqueadas y no se pueden eliminar.' : null;
  },
});

'use strict';
// =====================================================================
// REGLAS DEL CORE de BitácoraAgro (ver "2. Explicación Core" del análisis).
// Todo lo que protege la trazabilidad vive aquí y se ejecuta en el servidor:
//   a. Validar las labores
//   b. Calcular la fecha de liberación del lote
//   c. Validar la cosecha
//   d. Generar el certificado (hash SHA-256 + código público + QR)
//   e. Verificar la integridad del certificado
//   f. Calificar al productor y calcular su reputación
// =====================================================================
const crypto = require('node:crypto');
const { esFechaValida, hoyISO, sumarDias } = require('../lib/validators');

const TIPOS_LABOR = ['RIEGO', 'ABONADO', 'FUMIGACION', 'DESHIERBE', 'OTRO'];
const CALIDADES = ['Primera', 'Segunda', 'Tercera'];

/** Días entre dos fechas AAAA-MM-DD (hasta - desde). */
function diasEntre(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000);
}

function plural(n, uno, varios) {
  return `${n} ${n === 1 ? uno : varios}`;
}

// ---------------------------------------------------------------------
// Consultas base
// ---------------------------------------------------------------------
function obtenerLote(db, loteId) {
  return db.prepare(`
    SELECT l.*, cu.nombre AS cultivo, cu.ciclo_dias, p.nombre AS parcela, p.ubicacion, p.hectareas, p.usuario_id AS productor_id
    FROM lotes l
    JOIN cultivos cu ON cu.id = l.cultivo_id
    JOIN parcelas p ON p.id = l.parcela_id
    WHERE l.id = ?`).get(loteId);
}

/** Lote que pertenece al productor indicado (o undefined). */
function loteDelProductor(db, loteId, productorId) {
  const l = /^\d+$/.test(String(loteId)) ? obtenerLote(db, Number(loteId)) : undefined;
  return l && l.productor_id === productorId ? l : undefined;
}

function laboresDelLote(db, loteId) {
  return db.prepare(`
    SELECT la.*, i.nombre AS insumo, i.es_agroquimico, i.dias_carencia
    FROM labores la LEFT JOIN insumos i ON i.id = la.insumo_id
    WHERE la.lote_id = ? ORDER BY la.fecha, la.id`).all(loteId);
}

// ---------------------------------------------------------------------
// a. Validar las labores
// ---------------------------------------------------------------------
/**
 * Devuelve { campo: mensaje } con los errores. Vacío = labor válida.
 * Regla: solo se registra si el lote está activo y la fecha no es anterior
 * a la siembra ni posterior al día actual.
 */
function validarLabor(db, { tipo, fecha, lote_id, insumo_id }, hoy = hoyISO()) {
  const errores = {};
  const lote = /^\d+$/.test(String(lote_id)) ? obtenerLote(db, Number(lote_id)) : undefined;

  if (!TIPOS_LABOR.includes(tipo)) errores.tipo = 'Selecciona un tipo de labor válido.';
  if (!lote) {
    errores.lote_id = 'El lote seleccionado no existe.';
  } else if (lote.estado !== 'ACTIVO') {
    errores.lote_id = 'El lote ya fue cosechado: sus labores están bloqueadas.';
  }
  if (!esFechaValida(fecha)) {
    errores.fecha = 'Ingresa una fecha válida.';
  } else if (lote) {
    if (fecha < lote.fecha_siembra) errores.fecha = `La fecha no puede ser anterior a la siembra (${lote.fecha_siembra}).`;
    else if (fecha > hoy) errores.fecha = 'La fecha no puede ser posterior a hoy.';
  }
  if ((tipo === 'ABONADO' || tipo === 'FUMIGACION') && (insumo_id === '' || insumo_id == null)) {
    errores.insumo_id = 'Este tipo de labor necesita un insumo.';
  } else if (insumo_id !== '' && insumo_id != null && !db.prepare('SELECT 1 FROM insumos WHERE id = ?').get(Number(insumo_id))) {
    errores.insumo_id = 'El insumo seleccionado no existe.';
  }
  return errores;
}

// ---------------------------------------------------------------------
// b. Fecha de liberación del lote
// ---------------------------------------------------------------------
/**
 * fecha de liberación de una labor = fecha de la labor + días de carencia del insumo.
 * La del lote es la mayor de todas (sin agroquímicos: se libera desde la siembra).
 */
function fechaLiberacion(db, loteId) {
  const lote = obtenerLote(db, loteId);
  let fecha = lote.fecha_siembra;
  let causa = null;
  for (const la of laboresDelLote(db, loteId)) {
    if (la.es_agroquimico === 1) {
      const libera = sumarDias(la.fecha, la.dias_carencia);
      if (libera > fecha) {
        fecha = libera;
        causa = { insumo: la.insumo, fecha_labor: la.fecha, dias_carencia: la.dias_carencia };
      }
    }
  }
  return { fecha, causa };
}

/** Estado para cosecha de hoy: { fecha, faltan, listo, causa } */
function estadoCosecha(db, loteId, hoy = hoyISO()) {
  const { fecha, causa } = fechaLiberacion(db, loteId);
  const faltan = Math.max(0, diasEntre(hoy, fecha));
  return { fecha, faltan, listo: faltan === 0, causa };
}

// ---------------------------------------------------------------------
// c. Validar y registrar la cosecha
// ---------------------------------------------------------------------
function validarCosecha(db, loteId, { fecha, cantidad_kg, calidad }, hoy = hoyISO()) {
  const errores = {};
  const lote = obtenerLote(db, loteId);
  if (!lote) return { _general: 'El lote no existe.' };
  if (lote.estado !== 'ACTIVO') return { _general: 'Este lote ya fue cosechado.' };

  if (!esFechaValida(fecha)) {
    errores.fecha = 'Ingresa una fecha válida.';
  } else if (fecha < lote.fecha_siembra) {
    errores.fecha = `La cosecha no puede ser anterior a la siembra (${lote.fecha_siembra}).`;
  } else if (fecha > hoy) {
    errores.fecha = 'La fecha de cosecha no puede ser posterior a hoy.';
  } else {
    const lib = fechaLiberacion(db, loteId);
    const faltan = diasEntre(fecha, lib.fecha);
    if (faltan > 0) {
      const detalle = lib.causa
        ? ` Último agroquímico: ${lib.causa.insumo}, aplicado el ${lib.causa.fecha_labor} (${plural(lib.causa.dias_carencia, 'día', 'días')} de carencia).`
        : '';
      errores.fecha = `No se puede cosechar todavía: faltan ${plural(faltan, 'día', 'días')}. El lote se libera el ${lib.fecha}.${detalle}`;
    }
  }
  if (!/^\d+(\.\d+)?$/.test(String(cantidad_kg)) || Number(cantidad_kg) <= 0) {
    errores.cantidad_kg = 'Ingresa una cantidad mayor a 0 (en kg).';
  } else if (Number(cantidad_kg) > 10000000) {
    errores.cantidad_kg = 'La cantidad es demasiado grande.';
  }
  if (!CALIDADES.includes(calidad)) errores.calidad = 'Selecciona una calidad válida.';
  return errores;
}

/** Registra la cosecha y cierra el lote (sus labores quedan bloqueadas). */
function registrarCosecha(db, loteId, { fecha, cantidad_kg, calidad }) {
  return db.transaction(() => {
    db.prepare('INSERT INTO cosechas (fecha, cantidad_kg, calidad, lote_id) VALUES (?, ?, ?, ?)')
      .run(fecha, Number(cantidad_kg), calidad, loteId);
    db.prepare("UPDATE lotes SET estado = 'COSECHADO' WHERE id = ?").run(loteId);
  })();
}

// ---------------------------------------------------------------------
// d. Certificado: hash SHA-256 del historial completo del lote
// ---------------------------------------------------------------------
/** Historial del lote en un formato fijo (el orden de las claves importa para el hash). */
function historialParaHash(db, loteId) {
  const l = obtenerLote(db, loteId);
  const cosecha = db.prepare('SELECT fecha, cantidad_kg, calidad FROM cosechas WHERE lote_id = ?').get(loteId);
  return {
    codigo: l.codigo,
    cultivo: l.cultivo,
    parcela: l.parcela,
    fecha_siembra: l.fecha_siembra,
    labores: laboresDelLote(db, loteId).map((la) => ({
      fecha: la.fecha, tipo: la.tipo, descripcion: la.descripcion, insumo: la.insumo || null, cantidad: la.cantidad,
    })),
    cosecha: cosecha ? { fecha: cosecha.fecha, cantidad_kg: cosecha.cantidad_kg, calidad: cosecha.calidad } : null,
  };
}

function calcularHash(db, loteId) {
  return crypto.createHash('sha256').update(JSON.stringify(historialParaHash(db, loteId))).digest('hex');
}

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para evitar confusiones al leerlo
function codigoPublicoNuevo(db) {
  for (;;) {
    const bytes = crypto.randomBytes(8);
    const c = [...bytes].map((b) => ALFABETO[b % ALFABETO.length]).join('');
    const codigo = `BA-${c.slice(0, 4)}-${c.slice(4)}`;
    if (!db.prepare('SELECT 1 FROM certificados WHERE codigo_publico = ?').get(codigo)) return codigo;
  }
}

/** Genera el certificado de un lote COSECHADO. Devuelve { error } o { certificado }. */
function generarCertificado(db, loteId, hoy = hoyISO()) {
  const lote = obtenerLote(db, loteId);
  if (!lote) return { error: 'El lote no existe.' };
  if (lote.estado !== 'COSECHADO') return { error: 'Solo se puede generar el certificado de un lote ya cosechado.' };
  if (db.prepare('SELECT 1 FROM certificados WHERE lote_id = ?').get(loteId)) return { error: 'Este lote ya tiene certificado.' };

  const hash = calcularHash(db, loteId);
  const codigo = codigoPublicoNuevo(db);
  db.prepare('INSERT INTO certificados (codigo_publico, hash, fecha_emision, lote_id) VALUES (?, ?, ?, ?)')
    .run(codigo, hash, hoy, loteId);
  return { certificado: db.prepare('SELECT * FROM certificados WHERE lote_id = ?').get(loteId) };
}

// ---------------------------------------------------------------------
// e. Verificar la integridad
// ---------------------------------------------------------------------
/** Recalcula el hash con los datos ACTUALES y lo compara con el guardado. */
function verificarCertificado(db, certificado) {
  return calcularHash(db, certificado.lote_id) === certificado.hash;
}

// ---------------------------------------------------------------------
// f. Calificaciones y reputación
// ---------------------------------------------------------------------
function validarCalificacion(db, { loteId, compradorId, puntaje, comentario }) {
  const errores = {};
  const comprador = db.prepare('SELECT rol, activo FROM usuarios WHERE id = ?').get(compradorId);
  if (!comprador || comprador.rol !== 'COMPRADOR' || !comprador.activo) {
    errores._general = 'Solo un comprador registrado puede calificar.';
    return errores;
  }
  if (!db.prepare('SELECT 1 FROM certificados WHERE lote_id = ?').get(loteId)) {
    errores._general = 'Solo se pueden calificar lotes con certificado.';
    return errores;
  }
  if (db.prepare('SELECT 1 FROM calificaciones WHERE lote_id = ? AND comprador_id = ?').get(loteId, compradorId)) {
    errores._general = 'Ya calificaste este lote. Solo se puede calificar una vez.';
    return errores;
  }
  if (!/^[1-5]$/.test(String(puntaje))) errores.puntaje = 'Elige un puntaje de 1 a 5.';
  if (String(comentario || '').length > 300) errores.comentario = 'El comentario no puede superar 300 caracteres.';
  return errores;
}

function registrarCalificacion(db, { loteId, compradorId, puntaje, comentario }) {
  db.prepare('INSERT INTO calificaciones (puntaje, comentario, lote_id, comprador_id) VALUES (?, ?, ?, ?)')
    .run(Number(puntaje), String(comentario || '').trim(), loteId, compradorId);
}

/** reputación = suma de puntajes / total de calificaciones (sin calificaciones: promedio null = "No disponible"). */
function reputacionProductor(db, productorId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(c.puntaje), 0) AS suma, COUNT(c.id) AS total
    FROM calificaciones c
    JOIN lotes l ON l.id = c.lote_id
    JOIN parcelas p ON p.id = l.parcela_id
    WHERE p.usuario_id = ?`).get(productorId);
  return { promedio: r.total > 0 ? Math.round((r.suma / r.total) * 100) / 100 : null, total: r.total };
}

// ---------------------------------------------------------------------
// Página pública: solo información del producto (sin datos personales sensibles)
// ---------------------------------------------------------------------
/** "María Pérez" -> "María P." */
function nombreCorto(nombre) {
  const partes = String(nombre).trim().split(/\s+/);
  return partes.length > 1 ? `${partes[0]} ${partes[1].charAt(0)}.` : partes[0];
}

function trazabilidadPublica(db, codigo) {
  const cert = db.prepare('SELECT * FROM certificados WHERE codigo_publico = ?').get(String(codigo).toUpperCase());
  if (!cert) return null;
  const lote = obtenerLote(db, cert.lote_id);
  const productor = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(lote.productor_id);
  return {
    certificado: cert,
    lote,
    labores: laboresDelLote(db, lote.id),
    cosecha: db.prepare('SELECT * FROM cosechas WHERE lote_id = ?').get(lote.id),
    verificado: verificarCertificado(db, cert),
    productor: { nombre: nombreCorto(productor.nombre), reputacion: reputacionProductor(db, lote.productor_id) },
    calificaciones: db.prepare('SELECT COUNT(*) AS n FROM calificaciones WHERE lote_id = ?').get(lote.id).n,
  };
}

module.exports = {
  TIPOS_LABOR, CALIDADES, diasEntre, obtenerLote, loteDelProductor, laboresDelLote,
  validarLabor, fechaLiberacion, estadoCosecha, validarCosecha, registrarCosecha,
  historialParaHash, calcularHash, generarCertificado, verificarCertificado,
  validarCalificacion, registrarCalificacion, reputacionProductor, nombreCorto, trazabilidadPublica,
};

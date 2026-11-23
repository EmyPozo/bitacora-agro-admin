'use strict';
// Controlador (C): todo lo que hace el PRODUCTOR.
//   Parcelas (CRUD) · Lotes (crear, detalle) · Labores (CRUD mientras el lote esté activo)
//   Cosecha · Certificado + QR · Reporte propio · Calificaciones recibidas
// Regla de acceso: cada productor solo ve y toca SUS parcelas, lotes y labores.
// Si pide el id de otro productor, la respuesta es 404 (como si no existiera).
const QRCode = require('qrcode');
const { esFechaValida, hoyISO } = require('../lib/validators');
const {
  CALIDADES, TIPOS_LABOR, loteDelProductor, laboresDelLote, validarLabor, estadoCosecha,
  validarCosecha, registrarCosecha, generarCertificado, verificarCertificado, reputacionProductor,
} = require('../core/reglas');
const { calcularEstadisticas, leerRango } = require('./estadisticas');

const TABS = ['detalle', 'labores', 'certificado'];

function registrarProductor(app) {
  const db = app.db;
  const id = (req) => req.session.user.id;
  const noEncontrado = (reply, mensaje = 'No encontramos lo que buscas.') =>
    reply.page('error', { titulo: 'No encontrado', codigo: 404, mensaje, volver: '/productor' }, 404);
  const avisar = (req, tipo, msg) => { req.session.flash = { tipo, msg }; };
  const urlPublica = (req, codigo) => `${req.protocol}://${req.headers.host}/t/${codigo}`;

  const insumos = () => db.prepare(`
    SELECT id, nombre, es_agroquimico, dias_carencia FROM insumos ORDER BY nombre`).all();
  const parcelaPropia = (req, pid) =>
    /^\d+$/.test(pid) ? db.prepare('SELECT * FROM parcelas WHERE id = ? AND usuario_id = ?').get(Number(pid), id(req)) : undefined;

  // =====================================================================
  // Inicio
  // =====================================================================
  app.get('/productor', (req, reply) => {
    const yo = id(req);
    const n = (sql) => db.prepare(sql).get(yo).n;
    const resumen = {
      parcelas: n('SELECT COUNT(*) AS n FROM parcelas WHERE usuario_id = ?'),
      activos: n(`SELECT COUNT(*) AS n FROM lotes l JOIN parcelas p ON p.id = l.parcela_id WHERE p.usuario_id = ? AND l.estado = 'ACTIVO'`),
      cosechados: n(`SELECT COUNT(*) AS n FROM lotes l JOIN parcelas p ON p.id = l.parcela_id WHERE p.usuario_id = ? AND l.estado = 'COSECHADO'`),
      kg: db.prepare(`SELECT COALESCE(SUM(co.cantidad_kg), 0) AS n FROM cosechas co JOIN lotes l ON l.id = co.lote_id
                      JOIN parcelas p ON p.id = l.parcela_id WHERE p.usuario_id = ?`).get(yo).n,
    };
    const activos = db.prepare(`
      SELECT l.id, l.codigo, l.fecha_siembra, cu.nombre AS cultivo, p.nombre AS parcela
      FROM lotes l JOIN parcelas p ON p.id = l.parcela_id JOIN cultivos cu ON cu.id = l.cultivo_id
      WHERE p.usuario_id = ? AND l.estado = 'ACTIVO' ORDER BY l.id DESC`).all(yo)
      .map((l) => ({ ...l, estado: estadoCosecha(db, l.id) }));
    const ultimas = db.prepare(`
      SELECT c.puntaje, c.comentario, c.fecha, l.codigo, cu.nombre AS cultivo
      FROM calificaciones c JOIN lotes l ON l.id = c.lote_id JOIN parcelas p ON p.id = l.parcela_id
      JOIN cultivos cu ON cu.id = l.cultivo_id
      WHERE p.usuario_id = ? ORDER BY c.id DESC LIMIT 3`).all(yo);
    return reply.page('productor/inicio', {
      titulo: 'Inicio', resumen, activos, ultimas, reputacion: reputacionProductor(db, yo),
    });
  });

  // =====================================================================
  // Parcelas
  // =====================================================================
  function validarParcela(b) {
    const v = { nombre: String(b.nombre || '').trim(), ubicacion: String(b.ubicacion || '').trim(), hectareas: String(b.hectareas || '').trim().replace(',', '.') };
    const e = {};
    if (!v.nombre) e.nombre = 'Escribe el nombre de la parcela.';
    else if (v.nombre.length > 60) e.nombre = 'Máximo 60 caracteres.';
    if (!v.ubicacion) e.ubicacion = 'Escribe la ubicación.';
    else if (v.ubicacion.length > 120) e.ubicacion = 'Máximo 120 caracteres.';
    if (!/^\d+(\.\d+)?$/.test(v.hectareas) || Number(v.hectareas) <= 0) e.hectareas = 'Ingresa un número mayor a 0.';
    else if (Number(v.hectareas) > 100000) e.hectareas = 'El valor es demasiado grande.';
    return { v, e };
  }

  app.get('/productor/parcelas', (req, reply) => {
    const parcelas = db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM lotes WHERE parcela_id = p.id) AS lotes
      FROM parcelas p WHERE p.usuario_id = ? ORDER BY p.nombre`).all(id(req));
    return reply.page('productor/parcelas', { titulo: 'Parcelas', parcelas });
  });

  app.get('/productor/parcelas/nueva', (req, reply) =>
    reply.page('productor/parcela-form', { titulo: 'Nueva parcela', parcela: null, v: {}, e: {} }));

  app.post('/productor/parcelas', (req, reply) => {
    const { v, e } = validarParcela(req.body || {});
    if (Object.keys(e).length) return reply.page('productor/parcela-form', { titulo: 'Nueva parcela', parcela: null, v, e }, 422);
    db.prepare('INSERT INTO parcelas (nombre, ubicacion, hectareas, usuario_id) VALUES (?, ?, ?, ?)')
      .run(v.nombre, v.ubicacion, Number(v.hectareas), id(req));
    avisar(req, 'success', 'Parcela creada.');
    return reply.redirect('/productor/parcelas');
  });

  app.get('/productor/parcelas/:pid/editar', (req, reply) => {
    const p = parcelaPropia(req, req.params.pid);
    if (!p) return noEncontrado(reply, 'La parcela no existe.');
    return reply.page('productor/parcela-form', { titulo: 'Editar parcela', parcela: p, v: p, e: {} });
  });

  app.post('/productor/parcelas/:pid', (req, reply) => {
    const p = parcelaPropia(req, req.params.pid);
    if (!p) return noEncontrado(reply, 'La parcela no existe.');
    const { v, e } = validarParcela(req.body || {});
    if (Object.keys(e).length) return reply.page('productor/parcela-form', { titulo: 'Editar parcela', parcela: p, v, e }, 422);
    db.prepare('UPDATE parcelas SET nombre = ?, ubicacion = ?, hectareas = ? WHERE id = ?')
      .run(v.nombre, v.ubicacion, Number(v.hectareas), p.id);
    avisar(req, 'success', 'Parcela actualizada.');
    return reply.redirect('/productor/parcelas');
  });

  app.post('/productor/parcelas/:pid/eliminar', (req, reply) => {
    const p = parcelaPropia(req, req.params.pid);
    if (!p) return noEncontrado(reply, 'La parcela no existe.');
    if (db.prepare('SELECT 1 FROM lotes WHERE parcela_id = ?').get(p.id)) {
      avisar(req, 'danger', `No se puede eliminar «${p.nombre}»: tiene lotes registrados.`);
    } else {
      db.prepare('DELETE FROM parcelas WHERE id = ?').run(p.id);
      avisar(req, 'success', `Parcela «${p.nombre}» eliminada.`);
    }
    return reply.redirect('/productor/parcelas');
  });

  // =====================================================================
  // Lotes
  // =====================================================================
  app.get('/productor/lotes', (req, reply) => {
    const estado = ['ACTIVO', 'COSECHADO'].includes(req.query.estado) ? req.query.estado : '';
    const lotes = db.prepare(`
      SELECT l.id, l.codigo, l.estado, l.fecha_siembra, cu.nombre AS cultivo, p.nombre AS parcela,
             (SELECT COUNT(*) FROM labores WHERE lote_id = l.id) AS labores,
             (SELECT codigo_publico FROM certificados WHERE lote_id = l.id) AS certificado
      FROM lotes l JOIN parcelas p ON p.id = l.parcela_id JOIN cultivos cu ON cu.id = l.cultivo_id
      WHERE p.usuario_id = ? AND (? = '' OR l.estado = ?)
      ORDER BY l.id DESC`).all(id(req), estado, estado);
    return reply.page('productor/lotes', { titulo: 'Lotes', lotes, estado });
  });

  const datosFormLote = (req) => ({
    parcelas: db.prepare('SELECT id, nombre FROM parcelas WHERE usuario_id = ? ORDER BY nombre').all(id(req)),
    cultivos: db.prepare('SELECT id, nombre, ciclo_dias FROM cultivos ORDER BY nombre').all(),
    hoy: hoyISO(),
  });

  app.get('/productor/lotes/nuevo', (req, reply) => {
    const d = datosFormLote(req);
    return reply.page('productor/lote-nuevo', {
      titulo: 'Nuevo lote', ...d, e: {}, v: { fecha_siembra: d.hoy, parcela_id: req.query.parcela || '' },
    });
  });

  function siguienteCodigoLote() {
    let n = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM lotes').get().n;
    for (;;) {
      const codigo = `L-${String(n).padStart(4, '0')}`;
      if (!db.prepare('SELECT 1 FROM lotes WHERE codigo = ?').get(codigo)) return codigo;
      n += 1;
    }
  }

  app.post('/productor/lotes', (req, reply) => {
    const b = req.body || {};
    const v = { parcela_id: String(b.parcela_id || ''), cultivo_id: String(b.cultivo_id || ''), fecha_siembra: String(b.fecha_siembra || '').trim() };
    const e = {};
    // Regla: un lote solo puede crearse en una parcela PROPIA
    if (!parcelaPropia(req, v.parcela_id)) e.parcela_id = 'Selecciona una de tus parcelas.';
    if (!/^\d+$/.test(v.cultivo_id) || !db.prepare('SELECT 1 FROM cultivos WHERE id = ?').get(Number(v.cultivo_id))) e.cultivo_id = 'Selecciona un cultivo.';
    if (!esFechaValida(v.fecha_siembra)) e.fecha_siembra = 'Ingresa una fecha válida.';
    else if (v.fecha_siembra > hoyISO()) e.fecha_siembra = 'La siembra no puede ser posterior a hoy.';
    if (Object.keys(e).length) {
      return reply.page('productor/lote-nuevo', { titulo: 'Nuevo lote', ...datosFormLote(req), v, e }, 422);
    }
    const r = db.prepare('INSERT INTO lotes (codigo, fecha_siembra, parcela_id, cultivo_id) VALUES (?, ?, ?, ?)')
      .run(siguienteCodigoLote(), v.fecha_siembra, Number(v.parcela_id), Number(v.cultivo_id));
    avisar(req, 'success', 'Lote creado. Ahora registra sus labores.');
    return reply.redirect(`/productor/lotes/${r.lastInsertRowid}?tab=labores`);
  });

  // ---------- Detalle del lote (pestañas Detalle / Labores / Certificado) ----------
  async function verLote(req, reply, lote, { tab = 'detalle', v = {}, e = {}, vc = {}, ec = {}, editar = null, codigo = 200 } = {}) {
    const labores = laboresDelLote(db, lote.id);
    const cosecha = db.prepare('SELECT * FROM cosechas WHERE lote_id = ?').get(lote.id);
    const cert = db.prepare('SELECT * FROM certificados WHERE lote_id = ?').get(lote.id);
    let qr = null; let verificado = null;
    if (cert) {
      verificado = verificarCertificado(db, cert);
      if (tab === 'certificado') qr = await QRCode.toString(urlPublica(req, cert.codigo_publico), { type: 'svg', margin: 1 });
    }
    return reply.page('productor/lote', {
      titulo: `Lote ${lote.codigo}`, lote, tab, labores, cosecha, cert, qr, verificado,
      estado: lote.estado === 'ACTIVO' ? estadoCosecha(db, lote.id) : null,
      insumos: insumos(), tiposLabor: TIPOS_LABOR, calidades: CALIDADES, hoy: hoyISO(),
      v, e, vc, ec, urlPublica: cert ? urlPublica(req, cert.codigo_publico) : null,
      agroquimicos: labores.filter((l) => l.es_agroquimico === 1).length,
      puedeEliminar: lote.estado === 'ACTIVO' && labores.length === 0,
    }, codigo);
  }

  const loteOr404 = (req, reply) => {
    const lote = loteDelProductor(db, req.params.lid, id(req));
    if (!lote) { noEncontrado(reply, 'El lote no existe.'); return null; }
    return lote;
  };

  app.get('/productor/lotes/:lid', (req, reply) => {
    const lote = loteOr404(req, reply); if (!lote) return reply;
    const tab = TABS.includes(req.query.tab) ? req.query.tab : 'detalle';
    return verLote(req, reply, lote, { tab, v: { fecha: hoyISO(), tipo: 'RIEGO' }, vc: { fecha: hoyISO(), calidad: 'Primera' } });
  });

  app.post('/productor/lotes/:lid/eliminar', (req, reply) => {
    const lote = loteOr404(req, reply); if (!lote) return reply;
    if (lote.estado !== 'ACTIVO' || db.prepare('SELECT 1 FROM labores WHERE lote_id = ?').get(lote.id)) {
      avisar(req, 'danger', 'Solo se puede eliminar un lote activo que aún no tiene labores.');
      return reply.redirect(`/productor/lotes/${lote.id}`);
    }
    db.prepare('DELETE FROM lotes WHERE id = ?').run(lote.id);
    avisar(req, 'success', `Lote ${lote.codigo} eliminado.`);
    return reply.redirect('/productor/lotes');
  });

  // ---------- Labores ----------
  function leerLabor(b) {
    return {
      tipo: String(b.tipo || ''), fecha: String(b.fecha || '').trim(), insumo_id: String(b.insumo_id || ''),
      cantidad: String(b.cantidad || '').trim().replace(',', '.'), descripcion: String(b.descripcion || '').trim(),
    };
  }
  /** Regla (a) del core + validaciones de formato. Devuelve { campo: mensaje }. */
  function erroresLabor(lote, v) {
    const e = validarLabor(db, { tipo: v.tipo, fecha: v.fecha, lote_id: lote.id, insumo_id: v.insumo_id });
    if (v.cantidad !== '' && (!/^\d+(\.\d+)?$/.test(v.cantidad) || Number(v.cantidad) > 1000000)) e.cantidad = 'Ingresa un número válido (0 o más).';
    if (v.descripcion.length > 200) e.descripcion = 'Máximo 200 caracteres.';
    if (e.lote_id) { e._general = e.lote_id; delete e.lote_id; }
    return e;
  }
  const columnasLabor = (v) => [v.tipo, v.fecha, v.descripcion, v.cantidad === '' ? null : Number(v.cantidad), v.insumo_id === '' ? null : Number(v.insumo_id)];

  app.post('/productor/lotes/:lid/labores', (req, reply) => {
    const lote = loteOr404(req, reply); if (!lote) return reply;
    const v = leerLabor(req.body || {});
    const e = erroresLabor(lote, v);
    if (Object.keys(e).length) return verLote(req, reply, lote, { tab: 'labores', v, e, codigo: 422 });
    db.prepare('INSERT INTO labores (tipo, fecha, descripcion, cantidad, insumo_id, lote_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(...columnasLabor(v), lote.id);
    avisar(req, 'success', 'Labor registrada.');
    return reply.redirect(`/productor/lotes/${lote.id}?tab=labores`);
  });

  const laborPropia = (lote, lid) =>
    /^\d+$/.test(lid) ? db.prepare('SELECT * FROM labores WHERE id = ? AND lote_id = ?').get(Number(lid), lote.id) : undefined;

  app.get('/productor/lotes/:lid/labores/:laid/editar', (req, reply) => {
    const lote = loteOr404(req, reply); if (!lote) return reply;
    const labor = laborPropia(lote, req.params.laid);
    if (!labor) return noEncontrado(reply, 'La labor no existe.');
    if (lote.estado !== 'ACTIVO') {
      avisar(req, 'warning', 'El lote ya fue cosechado: sus labores están bloqueadas.');
      return reply.redirect(`/productor/lotes/${lote.id}?tab=labores`);
    }
    const v = { ...labor, insumo_id: labor.insumo_id === null ? '' : String(labor.insumo_id), cantidad: labor.cantidad === null ? '' : String(labor.cantidad) };
    return reply.page('productor/labor-form', { titulo: 'Editar labor', lote, labor, v, e: {}, insumos: insumos(), tiposLabor: TIPOS_LABOR, hoy: hoyISO() });
  });

  app.post('/productor/lotes/:lid/labores/:laid', (req, reply) => {
    const lote = loteOr404(req, reply); if (!lote) return reply;
    const labor = laborPropia(lote, req.params.laid);
    if (!labor) return noEncontrado(reply, 'La labor no existe.');
    const v = leerLabor(req.body || {});
    const e = erroresLabor(lote, v); // si el lote está cosechado, devuelve el error "bloqueadas"
    if (Object.keys(e).length) {
      return reply.page('productor/labor-form', { titulo: 'Editar labor', lote, labor, v, e, insumos: insumos(), tiposLabor: TIPOS_LABOR, hoy: hoyISO() }, 422);
    }
    db.prepare('UPDATE labores SET tipo = ?, fecha = ?, descripcion = ?, cantidad = ?, insumo_id = ? WHERE id = ?')
      .run(...columnasLabor(v), labor.id);
    avisar(req, 'success', 'Labor actualizada.');
    return reply.redirect(`/productor/lotes/${lote.id}?tab=labores`);
  });

  app.post('/productor/lotes/:lid/labores/:laid/eliminar', (req, reply) => {
    const lote = loteOr404(req, reply); if (!lote) return reply;
    const labor = laborPropia(lote, req.params.laid);
    if (!labor) return noEncontrado(reply, 'La labor no existe.');
    if (lote.estado !== 'ACTIVO') avisar(req, 'danger', 'El lote ya fue cosechado: sus labores están bloqueadas.');
    else { db.prepare('DELETE FROM labores WHERE id = ?').run(labor.id); avisar(req, 'success', 'Labor eliminada.'); }
    return reply.redirect(`/productor/lotes/${lote.id}?tab=labores`);
  });

  // ---------- Cosecha (regla c del core) ----------
  app.post('/productor/lotes/:lid/cosecha', (req, reply) => {
    const lote = loteOr404(req, reply); if (!lote) return reply;
    const b = req.body || {};
    const vc = { fecha: String(b.fecha || '').trim(), cantidad_kg: String(b.cantidad_kg || '').trim().replace(',', '.'), calidad: String(b.calidad || '') };
    const ec = validarCosecha(db, lote.id, vc);
    if (Object.keys(ec).length) return verLote(req, reply, lote, { tab: 'detalle', vc, ec, v: { fecha: hoyISO(), tipo: 'RIEGO' }, codigo: 422 });
    registrarCosecha(db, lote.id, vc);
    avisar(req, 'success', 'Cosecha registrada. El lote quedó cerrado. Ahora puedes generar su certificado.');
    return reply.redirect(`/productor/lotes/${lote.id}?tab=certificado`);
  });

  // ---------- Certificado (regla d del core) ----------
  app.post('/productor/lotes/:lid/certificado', (req, reply) => {
    const lote = loteOr404(req, reply); if (!lote) return reply;
    const r = generarCertificado(db, lote.id);
    if (r.error) avisar(req, 'danger', r.error);
    else avisar(req, 'success', `Certificado ${r.certificado.codigo_publico} generado.`);
    return reply.redirect(`/productor/lotes/${lote.id}?tab=certificado`);
  });

  app.get('/productor/lotes/:lid/certificado', async (req, reply) => {
    const lote = loteOr404(req, reply); if (!lote) return reply;
    const cert = db.prepare('SELECT * FROM certificados WHERE lote_id = ?').get(lote.id);
    if (!cert) {
      avisar(req, 'warning', 'Este lote todavía no tiene certificado.');
      return reply.redirect(`/productor/lotes/${lote.id}?tab=certificado`);
    }
    const url = urlPublica(req, cert.codigo_publico);
    return reply.page('productor/certificado', {
      titulo: `Certificado ${cert.codigo_publico}`, lote, cert, url,
      cosecha: db.prepare('SELECT * FROM cosechas WHERE lote_id = ?').get(lote.id),
      verificado: verificarCertificado(db, cert),
      qr: await QRCode.toString(url, { type: 'svg', margin: 1 }),
    });
  });

  // =====================================================================
  // Reporte propio por rango de fechas
  // =====================================================================
  app.get('/productor/reporte', (req, reply) => {
    const { desde, hasta, errores } = leerRango(req.query);
    const stats = calcularEstadisticas(db, desde, hasta, id(req));
    const lotes = db.prepare(`
      SELECT l.codigo, cu.nombre AS cultivo, co.fecha, co.cantidad_kg AS kg, co.calidad,
             (SELECT COUNT(*) FROM labores WHERE lote_id = l.id) AS labores,
             (SELECT ROUND(AVG(puntaje), 1) FROM calificaciones WHERE lote_id = l.id) AS promedio
      FROM cosechas co JOIN lotes l ON l.id = co.lote_id JOIN parcelas p ON p.id = l.parcela_id
      JOIN cultivos cu ON cu.id = l.cultivo_id
      WHERE p.usuario_id = ? AND co.fecha >= ? AND co.fecha <= ? ORDER BY co.fecha DESC`).all(id(req), desde, hasta);
    const labores = stats.ranking.length ? stats.ranking[0].labores : 0;
    return reply.page('productor/reporte', {
      titulo: 'Mi reporte', desde, hasta, errores, stats, lotes, labores,
    }, Object.keys(errores).length ? 422 : 200);
  });

  // =====================================================================
  // Calificaciones recibidas (solo lectura: el productor no puede editarlas ni borrarlas)
  // =====================================================================
  app.get('/productor/calificaciones', (req, reply) => {
    const yo = id(req);
    const lista = db.prepare(`
      SELECT c.puntaje, c.comentario, c.fecha, l.codigo, cu.nombre AS cultivo
      FROM calificaciones c JOIN lotes l ON l.id = c.lote_id JOIN parcelas p ON p.id = l.parcela_id
      JOIN cultivos cu ON cu.id = l.cultivo_id
      WHERE p.usuario_id = ? ORDER BY c.id DESC`).all(yo);
    const distribucion = [5, 4, 3, 2, 1].map((p) => ({ puntaje: p, n: lista.filter((c) => c.puntaje === p).length }));
    return reply.page('productor/calificaciones', { titulo: 'Calificaciones', lista, distribucion, reputacion: reputacionProductor(db, yo) });
  });
}

module.exports = { registrarProductor };

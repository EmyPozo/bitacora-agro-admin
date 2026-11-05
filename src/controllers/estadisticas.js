'use strict';
// Controlador (C): estadísticas generales (administrador), filtradas por rango de fechas.
// Se calculan sobre los lotes COSECHADOS dentro del rango (fecha de cosecha).
const { esFechaValida, hoyISO, sumarDias } = require('../lib/validators');

function calcularEstadisticas(db, desde, hasta) {
  const filas = db.prepare(`
    SELECT l.id, u.id AS productor_id, u.nombre AS productor, cu.nombre AS cultivo, co.cantidad_kg AS kg,
           (SELECT COUNT(*) FROM labores WHERE lote_id = l.id) AS labores,
           (SELECT COALESCE(SUM(puntaje), 0) FROM calificaciones WHERE lote_id = l.id) AS suma,
           (SELECT COUNT(*) FROM calificaciones WHERE lote_id = l.id) AS n
    FROM cosechas co
    JOIN lotes l ON l.id = co.lote_id
    JOIN parcelas p ON p.id = l.parcela_id
    JOIN usuarios u ON u.id = p.usuario_id
    JOIN cultivos cu ON cu.id = l.cultivo_id
    WHERE co.fecha >= ? AND co.fecha <= ?`).all(desde, hasta);

  const redondear = (n) => Math.round(n * 100) / 100;
  const promedio = (suma, n) => (n > 0 ? redondear(suma / n) : null);

  const porProductor = new Map();
  const porCultivo = new Map();
  let kgTotal = 0; let sumaGlobal = 0; let nGlobal = 0;

  for (const f of filas) {
    kgTotal += f.kg; sumaGlobal += f.suma; nGlobal += f.n;

    const p = porProductor.get(f.productor_id) || { productor: f.productor, lotes: 0, kg: 0, labores: 0, suma: 0, n: 0 };
    p.lotes += 1; p.kg += f.kg; p.labores += f.labores; p.suma += f.suma; p.n += f.n;
    porProductor.set(f.productor_id, p);

    const c = porCultivo.get(f.cultivo) || { cultivo: f.cultivo, lotes: 0, kg: 0 };
    c.lotes += 1; c.kg += f.kg;
    porCultivo.set(f.cultivo, c);
  }

  const ranking = [...porProductor.values()]
    .map((p) => ({ productor: p.productor, lotes: p.lotes, kg: redondear(p.kg), labores: p.labores, promedio: promedio(p.suma, p.n), calificaciones: p.n }))
    .sort((a, b) => b.kg - a.kg);
  const cultivos = [...porCultivo.values()].map((c) => ({ ...c, kg: redondear(c.kg) })).sort((a, b) => b.kg - a.kg);

  return {
    totalLotes: filas.length,
    kgTotal: redondear(kgTotal),
    promedioGlobal: promedio(sumaGlobal, nGlobal),
    totalCalificaciones: nGlobal,
    cultivos,
    ranking,
  };
}

function registrarEstadisticas(app) {
  const db = app.db;

  app.get('/admin/estadisticas', (req, reply) => {
    const hoy = hoyISO();
    let desde = String(req.query.desde || '').trim();
    let hasta = String(req.query.hasta || '').trim();
    const errores = {};

    if (!desde) desde = sumarDias(hoy, -365);
    else if (!esFechaValida(desde)) { errores.desde = 'Fecha inválida.'; desde = sumarDias(hoy, -365); }
    if (!hasta) hasta = hoy;
    else if (!esFechaValida(hasta)) { errores.hasta = 'Fecha inválida.'; hasta = hoy; }
    if (desde > hasta) { errores.hasta = 'La fecha final no puede ser anterior a la inicial.'; hasta = desde; }

    const stats = calcularEstadisticas(db, desde, hasta);
    const status = Object.keys(errores).length ? 422 : 200;
    return reply.page('estadisticas', { titulo: 'Estadísticas y reportes', desde, hasta, errores, stats }, status);
  });
}

module.exports = { registrarEstadisticas, calcularEstadisticas };

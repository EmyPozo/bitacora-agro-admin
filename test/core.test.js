'use strict';
// Pruebas de las REGLAS DEL CORE (src/core/reglas.js) directamente sobre la base de datos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearApp } = require('./helpers');
const { hoyISO, sumarDias } = require('../src/lib/validators');
const R = require('../src/core/reglas');

const hoy = () => hoyISO();
const hace = (d) => sumarDias(hoyISO(), -d);
const idLote = (app, codigo) => app.db.prepare('SELECT id FROM lotes WHERE codigo = ?').get(codigo).id;

test('(a) labor: lote cosechado, fecha futura o anterior a la siembra -> error', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const activo = idLote(app, 'L-0001');
  const cosechado = idLote(app, 'L-0002');
  assert.deepEqual(R.validarLabor(app.db, { tipo: 'RIEGO', fecha: hace(1), lote_id: activo, insumo_id: '' }), {});
  assert.ok(R.validarLabor(app.db, { tipo: 'RIEGO', fecha: sumarDias(hoy(), 1), lote_id: activo, insumo_id: '' }).fecha);
  assert.ok(R.validarLabor(app.db, { tipo: 'RIEGO', fecha: hace(400), lote_id: activo, insumo_id: '' }).fecha);
  assert.ok(R.validarLabor(app.db, { tipo: 'RIEGO', fecha: hace(1), lote_id: cosechado, insumo_id: '' }).lote_id);
  assert.ok(R.validarLabor(app.db, { tipo: 'FUMIGACION', fecha: hace(1), lote_id: activo, insumo_id: '' }).insumo_id);
});

test('(b) fecha de liberación = mayor (fecha de labor + carencia) de los agroquímicos', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const l5 = idLote(app, 'L-0005'); // Glifosato hace 2 días, 21 de carencia
  const e = R.estadoCosecha(app.db, l5);
  assert.equal(e.fecha, sumarDias(hace(2), 21));
  assert.equal(e.faltan, 19);
  assert.equal(e.listo, false);
  assert.equal(e.causa.insumo, 'Glifosato');

  const l1 = idLote(app, 'L-0001'); // todo con carencia vencida
  assert.equal(R.estadoCosecha(app.db, l1).listo, true);
});

test('lote sin agroquímicos: se libera desde la siembra', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const parcela = app.db.prepare('SELECT id FROM parcelas LIMIT 1').get().id;
  const cultivo = app.db.prepare('SELECT id FROM cultivos LIMIT 1').get().id;
  const id = app.db.prepare('INSERT INTO lotes (codigo, fecha_siembra, parcela_id, cultivo_id) VALUES (?, ?, ?, ?)')
    .run('L-9999', hace(5), parcela, cultivo).lastInsertRowid;
  assert.equal(R.fechaLiberacion(app.db, id).fecha, hace(5));
  assert.equal(R.estadoCosecha(app.db, id).listo, true);
});

test('(c) cosecha: antes de la liberación se rechaza e indica cuántos días faltan', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const l5 = idLote(app, 'L-0005');
  const e = R.validarCosecha(app.db, l5, { fecha: hoy(), cantidad_kg: '100', calidad: 'Primera' });
  assert.match(e.fecha, /faltan 19 días/);
  assert.match(e.fecha, /Glifosato/);
  assert.deepEqual(R.validarCosecha(app.db, idLote(app, 'L-0001'), { fecha: hoy(), cantidad_kg: '100', calidad: 'Primera' }), {});
});

test('cosecha: cantidad, calidad y fecha inválidas; no se cosecha dos veces', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const l1 = idLote(app, 'L-0001');
  assert.ok(R.validarCosecha(app.db, l1, { fecha: hoy(), cantidad_kg: '0', calidad: 'Primera' }).cantidad_kg);
  assert.ok(R.validarCosecha(app.db, l1, { fecha: hoy(), cantidad_kg: 'abc', calidad: 'Primera' }).cantidad_kg);
  assert.ok(R.validarCosecha(app.db, l1, { fecha: hoy(), cantidad_kg: '10', calidad: 'Cuarta' }).calidad);
  assert.ok(R.validarCosecha(app.db, l1, { fecha: sumarDias(hoy(), 1), cantidad_kg: '10', calidad: 'Primera' }).fecha);
  assert.ok(R.validarCosecha(app.db, idLote(app, 'L-0002'), { fecha: hoy(), cantidad_kg: '10', calidad: 'Primera' })._general);
});

test('registrar cosecha cierra el lote', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const l1 = idLote(app, 'L-0001');
  R.registrarCosecha(app.db, l1, { fecha: hoy(), cantidad_kg: '500', calidad: 'Primera' });
  assert.equal(app.db.prepare('SELECT estado FROM lotes WHERE id = ?').get(l1).estado, 'COSECHADO');
  assert.ok(R.validarLabor(app.db, { tipo: 'RIEGO', fecha: hoy(), lote_id: l1, insumo_id: '' }).lote_id);
});

test('(d)(e) certificado: hash SHA-256, código único; si se altera la BD, la verificación falla', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const l1 = idLote(app, 'L-0001');
  assert.ok(R.generarCertificado(app.db, l1).error, 'un lote activo no tiene certificado');
  R.registrarCosecha(app.db, l1, { fecha: hoy(), cantidad_kg: '500', calidad: 'Primera' });
  const { certificado } = R.generarCertificado(app.db, l1);
  assert.match(certificado.hash, /^[0-9a-f]{64}$/);
  assert.match(certificado.codigo_publico, /^BA-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(R.generarCertificado(app.db, l1).error, 'no se emite dos veces');
  assert.equal(R.verificarCertificado(app.db, certificado), true);

  const labor = app.db.prepare('SELECT id, fecha FROM labores WHERE lote_id = ? ORDER BY id LIMIT 1').get(l1);
  app.db.prepare('UPDATE labores SET fecha = ? WHERE id = ?').run(hace(59), labor.id); // alteración
  assert.equal(R.verificarCertificado(app.db, certificado), false);
  app.db.prepare('UPDATE labores SET fecha = ? WHERE id = ?').run(labor.fecha, labor.id); // se revierte
  assert.equal(R.verificarCertificado(app.db, certificado), true);

  app.db.prepare('UPDATE cosechas SET cantidad_kg = 9999 WHERE lote_id = ?').run(l1);
  assert.equal(R.verificarCertificado(app.db, certificado), false, 'también detecta cambios en la cosecha');
});

test('los certificados de prueba verifican bien', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  for (const c of app.db.prepare('SELECT * FROM certificados').all()) assert.equal(R.verificarCertificado(app.db, c), true);
});

test('(f) calificación: solo comprador, puntaje 1-5, una vez por lote, solo con certificado', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const l2 = idLote(app, 'L-0002'); const l1 = idLote(app, 'L-0001');
  const comprador = app.db.prepare("INSERT INTO usuarios (nombre, correo, password_hash, rol) VALUES ('Nuevo comprador', 'nc@x.com', 'x', 'COMPRADOR')").run().lastInsertRowid;
  const productor = app.db.prepare("SELECT id FROM usuarios WHERE rol = 'PRODUCTOR' LIMIT 1").get().id;
  const ok = { loteId: l2, compradorId: comprador, puntaje: '5', comentario: 'Excelente' };

  assert.ok(R.validarCalificacion(app.db, { ...ok, compradorId: productor })._general, 'un productor no califica');
  assert.ok(R.validarCalificacion(app.db, { ...ok, loteId: l1 })._general, 'lote sin certificado');
  assert.ok(R.validarCalificacion(app.db, { ...ok, puntaje: '6' }).puntaje);
  assert.ok(R.validarCalificacion(app.db, { ...ok, puntaje: '0' }).puntaje);
  assert.ok(R.validarCalificacion(app.db, { ...ok, comentario: 'x'.repeat(301) }).comentario);
  assert.deepEqual(R.validarCalificacion(app.db, ok), {});
  R.registrarCalificacion(app.db, ok);
  assert.match(R.validarCalificacion(app.db, ok)._general, /Ya calificaste/);
  assert.throws(() => R.registrarCalificacion(app.db, ok), /UNIQUE/, 'la BD también lo impide');
});

test('reputación = suma de puntajes / total; sin calificaciones -> null ("No disponible")', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const filas = app.db.prepare(`
    SELECT p.usuario_id AS u, SUM(c.puntaje) AS s, COUNT(*) AS n FROM calificaciones c
    JOIN lotes l ON l.id = c.lote_id JOIN parcelas p ON p.id = l.parcela_id GROUP BY p.usuario_id`).all();
  assert.ok(filas.length > 0);
  for (const f of filas) {
    const rep = R.reputacionProductor(app.db, f.u);
    assert.equal(rep.total, f.n);
    assert.equal(rep.promedio, Math.round((f.s / f.n) * 100) / 100);
  }
  const sinNada = app.db.prepare("INSERT INTO usuarios (nombre, correo, password_hash, rol) VALUES ('Nuevo', 'n@x.com', 'x', 'PRODUCTOR')").run().lastInsertRowid;
  assert.deepEqual(R.reputacionProductor(app.db, sinNada), { promedio: null, total: 0 });
});

test('página pública: nombre corto del productor y sin datos sensibles', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const cod = app.db.prepare('SELECT codigo_publico c FROM certificados LIMIT 1').get().c;
  const p = R.trazabilidadPublica(app.db, cod.toLowerCase());
  assert.equal(p.verificado, true);
  assert.match(p.productor.nombre, /^\S+ \S\.$/);
  assert.equal(JSON.stringify(p).includes('@'), false, 'no hay correos en lo que se publica');
  assert.equal(R.trazabilidadPublica(app.db, 'BA-NOPE-NOPE'), null);
});

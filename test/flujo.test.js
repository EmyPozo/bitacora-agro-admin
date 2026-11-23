'use strict';
// Flujo completo según los "criterios de éxito" del Documento de Análisis, a través de la web (HTTP).
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearApp, crearCliente } = require('./helpers');
const { hoyISO, sumarDias } = require('../src/lib/validators');

const hoy = () => hoyISO();
const hace = (d) => sumarDias(hoyISO(), -d);
const PASS = 'Clave12345';

async function registrarYEntrar(app, nombre, correo, rol) {
  const c = crearCliente(app);
  await c.get('/registro');
  let r = await c.post('/registro', { nombre, correo, password: PASS, password2: PASS, rol });
  assert.equal(r.statusCode, 302, 'registro');
  r = await c.login(correo, PASS);
  assert.equal(r.statusCode, 302, 'login');
  await c.get(r.headers.location); // carga el panel: así el cliente toma el token CSRF de la sesión nueva
  return c;
}
const idInsumo = (app, nombre) => app.db.prepare('SELECT id FROM insumos WHERE nombre = ?').get(nombre).id;

test('registro: validaciones en el servidor (contraseña débil, correo repetido, rol admin)', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = crearCliente(app); await c.get('/registro');
  const base = { nombre: 'Ana', correo: 'ana@x.com', password: PASS, password2: PASS, rol: 'PRODUCTOR' };
  assert.equal((await c.post('/registro', { ...base, password: '123', password2: '123' })).statusCode, 422);
  assert.equal((await c.post('/registro', { ...base, password2: 'otra' })).statusCode, 422);
  assert.equal((await c.post('/registro', { ...base, correo: 'mal' })).statusCode, 422);
  assert.equal((await c.post('/registro', { ...base, rol: 'ADMINISTRADOR' })).statusCode, 422, 'nadie se auto-registra como admin');
  assert.equal((await c.post('/registro', { ...base, correo: 'productor@bitacoraagro.com' })).statusCode, 422, 'correo repetido');
  assert.equal((await c.post('/registro', base)).statusCode, 302);
  assert.equal(app.db.prepare("SELECT rol FROM usuarios WHERE correo = 'ana@x.com'").get().rol, 'PRODUCTOR');
});

test('FLUJO COMPLETO: parcela -> lote -> 3 labores -> cosecha bloqueada -> cosecha -> certificado -> QR -> manipulación -> calificación', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const ana = await registrarYEntrar(app, 'Ana Torres', 'ana@x.com', 'PRODUCTOR');

  // Parcela (CRUD)
  let r = await ana.post('/productor/parcelas', { nombre: 'Loma Verde', ubicacion: 'Cayambe, Pichincha', hectareas: '0' });
  assert.equal(r.statusCode, 422, 'hectáreas 0 se rechaza');
  r = await ana.post('/productor/parcelas', { nombre: 'Loma Verde', ubicacion: 'Cayambe, Pichincha', hectareas: '1.5' });
  assert.equal(r.statusCode, 302);
  const parcela = app.db.prepare("SELECT id FROM parcelas WHERE nombre = 'Loma Verde'").get().id;

  // Lote
  await ana.get('/productor/lotes/nuevo');
  const cultivo = app.db.prepare("SELECT id FROM cultivos WHERE nombre = 'Papa'").get().id;
  r = await ana.post('/productor/lotes', { parcela_id: String(parcela), cultivo_id: String(cultivo), fecha_siembra: sumarDias(hoy(), 2) });
  assert.equal(r.statusCode, 422, 'siembra en el futuro');
  r = await ana.post('/productor/lotes', { parcela_id: String(parcela), cultivo_id: String(cultivo), fecha_siembra: hace(30) });
  assert.equal(r.statusCode, 302);
  const lote = app.db.prepare('SELECT * FROM lotes WHERE parcela_id = ?').get(parcela);
  assert.equal(lote.estado, 'ACTIVO');
  const base = `/productor/lotes/${lote.id}`;

  // Labores (regla a)
  await ana.get(`${base}?tab=labores`);
  r = await ana.post(`${base}/labores`, { tipo: 'RIEGO', fecha: sumarDias(hoy(), 1), insumo_id: '' });
  assert.equal(r.statusCode, 422, 'fecha futura');
  r = await ana.post(`${base}/labores`, { tipo: 'RIEGO', fecha: hace(40), insumo_id: '' });
  assert.equal(r.statusCode, 422, 'antes de la siembra');
  r = await ana.post(`${base}/labores`, { tipo: 'FUMIGACION', fecha: hace(3), insumo_id: '' });
  assert.equal(r.statusCode, 422, 'fumigación sin insumo');
  assert.equal((await ana.post(`${base}/labores`, { tipo: 'RIEGO', fecha: hace(20), insumo_id: '', cantidad: '3' })).statusCode, 302);
  assert.equal((await ana.post(`${base}/labores`, { tipo: 'ABONADO', fecha: hace(15), insumo_id: String(idInsumo(app, 'Urea')), cantidad: '25' })).statusCode, 302);
  assert.equal((await ana.post(`${base}/labores`, { tipo: 'FUMIGACION', fecha: hace(3), insumo_id: String(idInsumo(app, 'Glifosato')) })).statusCode, 302);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM labores WHERE lote_id = ?').get(lote.id).n, 3);

  // El detalle muestra "Faltan 18 días" (Glifosato: 21 de carencia, aplicado hace 3)
  r = await ana.get(base);
  assert.match(r.body, /Faltan 18 días/);

  // Cosecha BLOQUEADA por carencia (regla c)
  r = await ana.post(`${base}/cosecha`, { fecha: hoy(), cantidad_kg: '800', calidad: 'Primera' });
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /faltan 18 días/);
  assert.equal(app.db.prepare('SELECT estado FROM lotes WHERE id = ?').get(lote.id).estado, 'ACTIVO');
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM cosechas').get().n, 3, 'no se guardó (solo las 3 de prueba)');

  // Corrige la fecha de la fumigación (labor editable mientras el lote está activo) -> ya se puede cosechar
  const fum = app.db.prepare("SELECT id FROM labores WHERE lote_id = ? AND tipo = 'FUMIGACION'").get(lote.id).id;
  await ana.get(`${base}/labores/${fum}/editar`);
  r = await ana.post(`${base}/labores/${fum}`, { tipo: 'FUMIGACION', fecha: hace(25), insumo_id: String(idInsumo(app, 'Glifosato')), cantidad: '', descripcion: '' });
  assert.equal(r.statusCode, 302);
  r = await ana.post(`${base}/cosecha`, { fecha: hoy(), cantidad_kg: '800', calidad: 'Primera' });
  assert.equal(r.statusCode, 302);
  assert.equal(app.db.prepare('SELECT estado FROM lotes WHERE id = ?').get(lote.id).estado, 'COSECHADO');

  // Labores bloqueadas tras la cosecha
  r = await ana.post(`${base}/labores`, { tipo: 'RIEGO', fecha: hace(1), insumo_id: '' });
  assert.equal(r.statusCode, 422);
  await ana.get(base);
  r = await ana.post(`${base}/labores/${fum}`, { tipo: 'FUMIGACION', fecha: hace(26), insumo_id: String(idInsumo(app, 'Glifosato')) });
  assert.equal(r.statusCode, 422, 'no se edita');
  r = await ana.post(`${base}/labores/${fum}/eliminar`);
  assert.equal(r.statusCode, 302);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM labores WHERE id = ?').get(fum).n, 1, 'no se borra');

  // Certificado + QR (regla d)
  r = await ana.get(`${base}?tab=certificado`);
  assert.match(r.body, /Generar certificado/);
  assert.equal((await ana.post(`${base}/certificado`)).statusCode, 302);
  const cert = app.db.prepare('SELECT * FROM certificados WHERE lote_id = ?').get(lote.id);
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
  r = await ana.get(`${base}?tab=certificado`);
  assert.match(r.body, /<svg/); assert.match(r.body, new RegExp(cert.codigo_publico));
  r = await ana.get(`${base}/certificado`);
  assert.equal(r.statusCode, 200);

  // Página pública SIN sesión (regla e): verificada, sin datos personales
  const visitante = crearCliente(app);
  r = await visitante.get(`/t/${cert.codigo_publico}`);
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Verificado/);
  assert.equal(r.headers['set-cookie'], undefined, 'un visitante anónimo no recibe cookie');
  assert.ok(!r.body.includes('ana@x.com') && !r.body.includes('Ana Torres'), 'sin correo ni nombre completo');
  assert.match(r.body, /Ana T\./);
  assert.match((await visitante.get(`/t/${cert.codigo_publico}/qr.svg`)).headers['content-type'], /svg/);
  assert.equal((await visitante.get('/consultar?codigo=' + cert.codigo_publico.toLowerCase().replace(/-/g, ' '))).statusCode, 302, 'el buscador tolera minúsculas');
  assert.equal((await visitante.get('/t/BA-AAAA-BBBB')).statusCode, 404);
  r = await visitante.get('/t/' + cert.codigo_publico);
  assert.match(r.body, /Ingresa como comprador|Iniciar sesión/);

  // Manipulación de la BD -> alerta (criterio de éxito)
  const labor = app.db.prepare('SELECT id, fecha FROM labores WHERE lote_id = ? ORDER BY id LIMIT 1').get(lote.id);
  app.db.prepare('UPDATE labores SET fecha = ? WHERE id = ?').run(hace(28), labor.id);
  r = await visitante.get(`/t/${cert.codigo_publico}`);
  assert.match(r.body, /el historial fue modificado/);
  assert.doesNotMatch(r.body, />Verificado</);
  r = await ana.get(`${base}?tab=certificado`);
  assert.match(r.body, /ya no coincide/);
  app.db.prepare('UPDATE labores SET fecha = ? WHERE id = ?').run(labor.fecha, labor.id);
  assert.match((await visitante.get(`/t/${cert.codigo_publico}`)).body, />Verificado</);

  // Calificación (regla f): comprador registrado, una sola vez
  const rosa = await registrarYEntrar(app, 'Rosa Compradora', 'rosa@x.com', 'COMPRADOR');
  r = await rosa.get(`/t/${cert.codigo_publico}`);
  assert.match(r.body, /Enviar calificación/);
  r = await rosa.post(`/t/${cert.codigo_publico}/calificar`, { puntaje: '9', comentario: '' });
  assert.equal(r.statusCode, 302);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM calificaciones WHERE comprador_id = (SELECT id FROM usuarios WHERE correo = ?)').get('rosa@x.com').n, 0, 'puntaje 9 rechazado');
  await rosa.post(`/t/${cert.codigo_publico}/calificar`, { puntaje: '4', comentario: 'Muy buena papa' });
  await rosa.post(`/t/${cert.codigo_publico}/calificar`, { puntaje: '1', comentario: 'intento repetido' });
  const filas = app.db.prepare('SELECT puntaje FROM calificaciones WHERE lote_id = ?').all(lote.id);
  assert.deepEqual(filas.map((f) => f.puntaje), [4], 'solo cuenta la primera');
  r = await rosa.get(`/t/${cert.codigo_publico}`);
  assert.match(r.body, /Ya calificaste este lote/);
  assert.match(r.body, /4\.0/);
  r = await rosa.get('/comprador/calificaciones');
  assert.match(r.body, /Muy buena papa/);

  // El productor ve su reputación y no puede alterar calificaciones
  r = await ana.get('/productor/calificaciones');
  assert.match(r.body, /Muy buena papa/); assert.match(r.body, /4\.0/);
  assert.doesNotMatch(r.body, /calificaciones\/\d+|\/eliminar|\/editar/); // sin botones para editar ni borrar
  assert.equal((await ana.post('/productor/calificaciones/1/eliminar')).statusCode, 404);

  // Reporte propio por rango de fechas
  r = await ana.get(`/productor/reporte?desde=${hace(10)}&hasta=${hoy()}`);
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /<td class="fw-semibold">L-0006<\/td>/);
  assert.ok(!r.body.includes('L-0002'), 'no aparecen lotes de otros productores');
  r = await ana.get('/productor/reporte?desde=2026-13-45');
  assert.equal(r.statusCode, 422);
});

test('un productor solo ve y toca lo suyo (parcelas, lotes, labores, certificados)', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const luis = crearCliente(app); await luis.login('productor2@bitacoraagro.com', 'Productor123*');
  const loteAjeno = app.db.prepare("SELECT id FROM lotes WHERE codigo = 'L-0001'").get().id; // de María
  const laborAjena = app.db.prepare('SELECT id FROM labores WHERE lote_id = ?').get(loteAjeno).id;
  const parcelaAjena = app.db.prepare("SELECT id FROM parcelas WHERE nombre = 'El Mirador'").get().id;
  await luis.get('/productor');
  for (const url of [`/productor/lotes/${loteAjeno}`, `/productor/lotes/${loteAjeno}/certificado`, `/productor/parcelas/${parcelaAjena}/editar`, `/productor/lotes/${loteAjeno}/labores/${laborAjena}/editar`]) {
    assert.equal((await luis.get(url)).statusCode, 404, url);
  }
  const hoyTxt = hoy();
  assert.equal((await luis.post(`/productor/lotes/${loteAjeno}/labores`, { tipo: 'RIEGO', fecha: hoyTxt, insumo_id: '' })).statusCode, 404);
  assert.equal((await luis.post(`/productor/lotes/${loteAjeno}/cosecha`, { fecha: hoyTxt, cantidad_kg: '5', calidad: 'Primera' })).statusCode, 404);
  assert.equal((await luis.post(`/productor/lotes/${loteAjeno}/labores/${laborAjena}/eliminar`)).statusCode, 404);
  assert.equal((await luis.post(`/productor/parcelas/${parcelaAjena}/eliminar`)).statusCode, 404);
  // Crear un lote en una parcela ajena
  const cultivo = app.db.prepare('SELECT id FROM cultivos LIMIT 1').get().id;
  await luis.get('/productor/lotes/nuevo');
  const r = await luis.post('/productor/lotes', { parcela_id: String(parcelaAjena), cultivo_id: String(cultivo), fecha_siembra: hace(5) });
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /Selecciona una de tus parcelas/);
  // Su lista no incluye lotes ajenos
  const lista = await luis.get('/productor/lotes');
  assert.ok(!lista.body.includes('L-0001') && lista.body.includes('L-0003'));
  // Un lote con labores/cosecha no se puede borrar; una parcela con lotes tampoco
  const propia = app.db.prepare("SELECT id FROM parcelas WHERE nombre = 'San Juan'").get().id;
  await luis.post(`/productor/parcelas/${propia}/eliminar`);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM parcelas WHERE id = ?').get(propia).n, 1);
});

test('roles: cada rol solo entra a su zona; sin sesión se pide login', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const anon = crearCliente(app);
  assert.equal((await anon.get('/productor')).statusCode, 302);
  assert.equal((await anon.get('/comprador')).statusCode, 302);
  const comp = crearCliente(app); await comp.login('comprador@bitacoraagro.com', 'Comprador123*');
  assert.equal((await comp.get('/comprador')).statusCode, 200);
  assert.equal((await comp.get('/productor')).statusCode, 403);
  assert.equal((await comp.get('/admin')).statusCode, 403);
  const prod = crearCliente(app); await prod.login('productor@bitacoraagro.com', 'Productor123*');
  assert.equal((await prod.get('/comprador')).statusCode, 403);
  assert.equal((await prod.get('/admin')).statusCode, 403);
  // Un productor no califica
  const cod = app.db.prepare('SELECT codigo_publico c FROM certificados LIMIT 1').get().c;
  await prod.get('/productor');
  const r = await prod.post(`/t/${cod}/calificar`, { puntaje: '5' });
  assert.equal(r.statusCode, 302);
  // Usuario desactivado pierde el acceso al instante
  app.db.prepare("UPDATE usuarios SET activo = 0 WHERE correo = 'productor@bitacoraagro.com'").run();
  assert.equal((await prod.get('/productor')).statusCode, 302);
});

test('todas las pantallas cargan (productor, comprador, públicas) y el logout funciona', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const prod = crearCliente(app); await prod.login('productor@bitacoraagro.com', 'Productor123*');
  for (const u of ['/productor', '/productor/parcelas', '/productor/parcelas/nueva', '/productor/lotes', '/productor/lotes?estado=ACTIVO', '/productor/lotes/nuevo',
    '/productor/lotes/1', '/productor/lotes/1?tab=labores', '/productor/lotes/3?tab=certificado', '/productor/lotes/3/certificado', '/productor/reporte', '/productor/calificaciones']) {
    assert.equal((await prod.get(u)).statusCode, 200, u);
  }
  const comp = crearCliente(app); await comp.login('comprador@bitacoraagro.com', 'Comprador123*');
  for (const u of ['/comprador', '/comprador/calificaciones', '/']) assert.equal((await comp.get(u)).statusCode, 200, u);
  assert.equal((await prod.post('/logout')).statusCode, 302);
  assert.equal((await prod.get('/productor')).statusCode, 302);
});

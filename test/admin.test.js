'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { crearApp, crearCliente, admin, q } = require('./helpers');
const { hoyISO, sumarDias } = require('../src/lib/validators');
const { calcularEstadisticas } = require('../src/controllers/estadisticas');

const hoy = () => hoyISO();
const hace = (d) => sumarDias(hoyISO(), -d);

// ========================= Acceso y seguridad =========================
test('sin sesión: /admin redirige al login y la API responde 401', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = crearCliente(app);
  const r = await c.get('/admin/usuarios');
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/login');
  assert.equal((await c.get('/admin/api/productores/1/parcelas')).statusCode, 401);
});

test('login: credenciales malas -> 401; buenas -> panel', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = crearCliente(app);
  await c.get('/login');
  assert.equal((await c.post('/login', { correo: 'admin@bitacoraagro.com', password: 'mala' })).statusCode, 401);
  assert.equal((await c.post('/login', { correo: 'noexiste@x.com', password: 'Admin123*' })).statusCode, 401);
  assert.equal((await c.login()).statusCode, 302);
  assert.equal((await c.get('/admin')).statusCode, 200);
});

test('POST sin token CSRF se rechaza con 403', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const r = await c.post('/admin/cultivos', { nombre: 'Quinua', ciclo_dias: '150' }, { sinCsrf: true });
  assert.equal(r.statusCode, 403);
  assert.equal(q(app).uno("SELECT COUNT(*) n FROM cultivos WHERE nombre = 'Quinua'").n, 0);
});

test('rate limit del login: 5 fallos -> 429', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = crearCliente(app);
  await c.get('/login');
  for (let i = 0; i < 5; i++) await c.post('/login', { correo: 'admin@bitacoraagro.com', password: 'x' });
  assert.equal((await c.post('/login', { correo: 'admin@bitacoraagro.com', password: 'Admin123*' })).statusCode, 429);
});

test('un productor no puede entrar a /admin (403)', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = crearCliente(app);
  assert.equal((await c.login('productor@bitacoraagro.com', 'Productor123*')).statusCode, 302);
  assert.equal((await c.get('/admin/lotes')).statusCode, 403);
  assert.equal((await c.get('/admin/estadisticas')).statusCode, 403);
  assert.equal((await c.get('/admin/api/productores/1/parcelas')).statusCode, 403);
});

// ========================= Usuarios (credenciales sensibles) =========================
const usuarioValido = (extra = {}) => ({
  nombre: 'Pedro Nuevo', correo: 'pedro@test.com', password: 'Segura123', rol: 'PRODUCTOR', activo: '1', ...extra,
});

test('BACK-END usuario: contraseña débil o correo inválido -> 422 y no se guarda', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.post('/admin/usuarios', usuarioValido({ password: '12345678' }))).statusCode, 422);
  assert.equal((await c.post('/admin/usuarios', usuarioValido({ correo: 'sin-arroba' }))).statusCode, 422);
  assert.equal(q(app).uno("SELECT COUNT(*) n FROM usuarios WHERE nombre = 'Pedro Nuevo'").n, 0);
});

test('usuario válido: se crea con la contraseña en hash bcrypt', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.post('/admin/usuarios', usuarioValido())).statusCode, 302);
  const u = q(app).uno("SELECT * FROM usuarios WHERE correo = 'pedro@test.com'");
  assert.ok(u);
  assert.notEqual(u.password_hash, 'Segura123');
  assert.ok(bcrypt.compareSync('Segura123', u.password_hash));
});

test('correo repetido (sin importar mayúsculas) -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const r = await c.post('/admin/usuarios', usuarioValido({ correo: 'ADMIN@bitacoraagro.com' }));
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /Ya existe/);
});

test('rol inventado -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.post('/admin/usuarios', usuarioValido({ rol: 'SUPERUSUARIO' }))).statusCode, 422);
});

test('el admin no puede eliminarse ni desactivarse a sí mismo', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const yo = q(app).uno("SELECT * FROM usuarios WHERE correo = 'admin@bitacoraagro.com'");
  await c.post(`/admin/usuarios/${yo.id}/eliminar`);
  assert.ok(q(app).uno('SELECT 1 FROM usuarios WHERE id = ?', yo.id));
  const r = await c.post(`/admin/usuarios/${yo.id}`, { nombre: yo.nombre, correo: yo.correo, password: '', rol: 'ADMINISTRADOR' }); // sin "activo"
  assert.equal(r.statusCode, 422);
  assert.equal(q(app).uno('SELECT activo FROM usuarios WHERE id = ?', yo.id).activo, 1);
});

test('editar sin escribir contraseña conserva el hash anterior', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const p = q(app).uno("SELECT * FROM usuarios WHERE correo = 'productor@bitacoraagro.com'");
  const r = await c.post(`/admin/usuarios/${p.id}`, { nombre: 'María Editada', correo: p.correo, password: '', rol: 'PRODUCTOR', activo: '1' });
  assert.equal(r.statusCode, 302);
  const d = q(app).uno('SELECT * FROM usuarios WHERE id = ?', p.id);
  assert.equal(d.nombre, 'María Editada');
  assert.equal(d.password_hash, p.password_hash);
});

// ========================= Insumos (días de carencia = dato sensible) =========================
test('BACK-END insumo: agroquímico con 0 días de carencia -> 422 y no se guarda', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const r = await c.post('/admin/insumos', { nombre: 'Veneno X', tipo: 'PESTICIDA', es_agroquimico: '1', dias_carencia: '0' });
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /al menos 1 día/);
  assert.equal(q(app).uno("SELECT COUNT(*) n FROM insumos WHERE nombre = 'Veneno X'").n, 0);
});

test('BACK-END insumo: agroquímico sin días, pesticida sin marcar, o días negativos/texto -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const casos = [
    { nombre: 'A1', tipo: 'FUNGICIDA', es_agroquimico: '1', dias_carencia: '' },
    { nombre: 'A2', tipo: 'HERBICIDA', dias_carencia: '10' }, // herbicida sin marcar agroquímico
    { nombre: 'A3', tipo: 'PESTICIDA', es_agroquimico: '1', dias_carencia: '-5' },
    { nombre: 'A4', tipo: 'PESTICIDA', es_agroquimico: '1', dias_carencia: 'abc' },
    { nombre: 'A5', tipo: 'PESTICIDA', es_agroquimico: '1', dias_carencia: '9999' },
    { nombre: 'A6', tipo: 'VENENO', dias_carencia: '0' },
  ];
  for (const caso of casos) assert.equal((await c.post('/admin/insumos', caso)).statusCode, 422, caso.nombre);
});

test('insumo válido: agroquímico con carencia se guarda; no agroquímico queda en 0', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.post('/admin/insumos', { nombre: 'Abamectina', tipo: 'PESTICIDA', es_agroquimico: '1', dias_carencia: '12' })).statusCode, 302);
  assert.equal(q(app).uno("SELECT dias_carencia d FROM insumos WHERE nombre = 'Abamectina'").d, 12);
  assert.equal((await c.post('/admin/insumos', { nombre: 'Humus', tipo: 'FERTILIZANTE', dias_carencia: '30' })).statusCode, 302);
  assert.equal(q(app).uno("SELECT dias_carencia d FROM insumos WHERE nombre = 'Humus'").d, 0);
});

// ========================= Labores (fecha = dato sensible) =========================
function laborValida(app, extra = {}) {
  const lote = q(app).uno("SELECT id FROM lotes WHERE codigo = 'L-0001'").id;
  return { tipo: 'RIEGO', fecha: hace(2), lote_id: String(lote), insumo_id: '', cantidad: '', descripcion: 'Riego de prueba', ...extra };
}

test('BACK-END labor: fecha futura -> 422 y no se guarda', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const antes = q(app).uno('SELECT COUNT(*) n FROM labores').n;
  const r = await c.post('/admin/labores', laborValida(app, { fecha: sumarDias(hoy(), 1) }));
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /posterior a hoy/);
  assert.equal(q(app).uno('SELECT COUNT(*) n FROM labores').n, antes);
});

test('BACK-END labor: fecha anterior a la siembra -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const r = await c.post('/admin/labores', laborValida(app, { fecha: hace(200) })); // L-0001 se sembró hace 60 días
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /anterior a la siembra/);
});

test('BACK-END labor: fecha inexistente o mal formada -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  for (const fecha of ['2026-02-31', '05/11/2026', 'ayer', '']) {
    assert.equal((await c.post('/admin/labores', laborValida(app, { fecha }))).statusCode, 422, fecha);
  }
});

test('BACK-END labor: un lote cosechado tiene las labores bloqueadas', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const cosechado = q(app).uno("SELECT id FROM lotes WHERE estado = 'COSECHADO' LIMIT 1").id;
  const r = await c.post('/admin/labores', laborValida(app, { lote_id: String(cosechado), fecha: hace(100) }));
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /bloqueadas/);
  // tampoco se pueden eliminar
  const labor = q(app).uno('SELECT id FROM labores WHERE lote_id = ? LIMIT 1', cosechado);
  await c.post(`/admin/labores/${labor.id}/eliminar`);
  assert.ok(q(app).uno('SELECT 1 FROM labores WHERE id = ?', labor.id));
});

test('labor: abonado/fumigación exigen insumo; insumo o lote inventados -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.post('/admin/labores', laborValida(app, { tipo: 'FUMIGACION' }))).statusCode, 422);
  assert.equal((await c.post('/admin/labores', laborValida(app, { tipo: 'ABONADO', insumo_id: '9999' }))).statusCode, 422);
  assert.equal((await c.post('/admin/labores', laborValida(app, { lote_id: '9999' }))).statusCode, 422);
});

test('labor válida: se guarda (insumo y cantidad opcionales quedan en NULL)', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const r = await c.post('/admin/labores', laborValida(app, { descripcion: 'Riego válido' }));
  assert.equal(r.statusCode, 302);
  const l = q(app).uno("SELECT * FROM labores WHERE descripcion = 'Riego válido'");
  assert.equal(l.insumo_id, null);
  assert.equal(l.cantidad, null);
  // con insumo y cantidad con coma decimal
  const mancozeb = q(app).uno("SELECT id FROM insumos WHERE nombre = 'Mancozeb'").id;
  assert.equal((await c.post('/admin/labores', laborValida(app, { tipo: 'FUMIGACION', insumo_id: String(mancozeb), cantidad: '2,5', descripcion: 'Fumigación válida' }))).statusCode, 302);
  assert.equal(q(app).uno("SELECT cantidad FROM labores WHERE descripcion = 'Fumigación válida'").cantidad, 2.5);
});

// ========================= Lotes: dropdown en cascada Productor -> Parcela =========================
test('API de cascada: devuelve solo las parcelas de ese productor', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const maria = q(app).uno("SELECT id FROM usuarios WHERE correo = 'productor@bitacoraagro.com'").id;
  const r = await c.get(`/admin/api/productores/${maria}/parcelas`);
  assert.equal(r.statusCode, 200);
  const nombres = JSON.parse(r.body).map((p) => p.etiqueta).sort();
  assert.deepEqual(nombres, ['El Mirador', 'La Esperanza']);
  assert.equal((await c.get('/admin/api/productores/abc/parcelas')).statusCode, 400);
  assert.deepEqual(JSON.parse((await c.get('/admin/api/productores/9999/parcelas')).body), []);
});

test('el formulario de lote usa <select> (no inputs) para productor, parcela y cultivo', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const r = await c.get('/admin/lotes/nuevo');
  assert.match(r.body, /<select[^>]+name="productor_id"/);
  assert.match(r.body, /<select[^>]+name="parcela_id"[^>]+data-dep-url="\/admin\/api\/productores\/:id\/parcelas"/);
  assert.match(r.body, /<select[^>]+name="cultivo_id"/);
  assert.doesNotMatch(r.body, /<input[^>]+name="(productor_id|parcela_id|cultivo_id)"/);
  assert.match(r.body, /value="L-0005"/); // código sugerido
});

function loteValido(app, extra = {}) {
  const maria = q(app).uno("SELECT id FROM usuarios WHERE correo = 'productor@bitacoraagro.com'").id;
  const parcela = q(app).uno("SELECT id FROM parcelas WHERE nombre = 'El Mirador'").id;
  const cultivo = q(app).uno("SELECT id FROM cultivos WHERE nombre = 'Fréjol'").id;
  return { codigo: 'l-0100', productor_id: String(maria), parcela_id: String(parcela), cultivo_id: String(cultivo), fecha_siembra: hace(5), ...extra };
}

test('BACK-END lote: una parcela que NO es del productor elegido -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const deLuis = q(app).uno("SELECT id FROM parcelas WHERE nombre = 'San Juan'").id;
  const r = await c.post('/admin/lotes', loteValido(app, { parcela_id: String(deLuis) }));
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /no pertenece/);
  assert.equal(q(app).uno("SELECT COUNT(*) n FROM lotes WHERE codigo = 'L-0100'").n, 0);
});

test('BACK-END lote: productor inventado, o un usuario que no es productor -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.post('/admin/lotes', loteValido(app, { productor_id: '9999' }))).statusCode, 422);
  const comprador = q(app).uno("SELECT id FROM usuarios WHERE rol = 'COMPRADOR' LIMIT 1").id;
  assert.equal((await c.post('/admin/lotes', loteValido(app, { productor_id: String(comprador) }))).statusCode, 422);
  assert.equal((await c.post('/admin/lotes', loteValido(app, { cultivo_id: '9999' }))).statusCode, 422);
});

test('lote válido: se crea ACTIVO con el código en mayúsculas', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.post('/admin/lotes', loteValido(app))).statusCode, 302);
  const l = q(app).uno("SELECT * FROM lotes WHERE codigo = 'L-0100'");
  assert.ok(l);
  assert.equal(l.estado, 'ACTIVO');
});

test('lote: código repetido, siembra en el futuro o código con símbolos -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.post('/admin/lotes', loteValido(app, { codigo: 'l-0001' }))).statusCode, 422);
  assert.equal((await c.post('/admin/lotes', loteValido(app, { fecha_siembra: sumarDias(hoy(), 3) }))).statusCode, 422);
  assert.equal((await c.post('/admin/lotes', loteValido(app, { codigo: 'L 01;--' }))).statusCode, 422);
});

test('lote: no se puede mover la siembra después de sus labores, ni editar un lote cosechado', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const l1 = q(app).uno("SELECT * FROM lotes WHERE codigo = 'L-0001'");
  const base = loteValido(app, { codigo: 'L-0001', fecha_siembra: hace(5) }); // L-0001 tiene labores de hace 40 días
  assert.equal((await c.post(`/admin/lotes/${l1.id}`, base)).statusCode, 422);
  const cosechado = q(app).uno("SELECT * FROM lotes WHERE estado = 'COSECHADO' LIMIT 1");
  assert.equal((await c.post(`/admin/lotes/${cosechado.id}`, loteValido(app, { codigo: cosechado.codigo, fecha_siembra: cosechado.fecha_siembra }))).statusCode, 422);
});

test('al editar un lote, el formulario trae el productor y sus parcelas', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const l1 = q(app).uno("SELECT id FROM lotes WHERE codigo = 'L-0001'").id;
  const r = await c.get(`/admin/lotes/${l1}/editar`);
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /<option value="\d+" selected>María Pérez<\/option>/);
  assert.match(r.body, /<option value="\d+" selected>El Mirador<\/option>/);
});

// ========================= Parcelas =========================
test('parcela: el dueño debe ser un productor (un comprador -> 422); hectáreas > 0', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const comprador = q(app).uno("SELECT id FROM usuarios WHERE rol = 'COMPRADOR' LIMIT 1").id;
  const luis = q(app).uno("SELECT id FROM usuarios WHERE correo = 'productor2@bitacoraagro.com'").id;
  const base = { nombre: 'Nueva', ubicacion: 'Ambato, Tungurahua', hectareas: '1,5', usuario_id: String(luis) };
  assert.equal((await c.post('/admin/parcelas', { ...base, usuario_id: String(comprador) })).statusCode, 422);
  assert.equal((await c.post('/admin/parcelas', { ...base, hectareas: '0' })).statusCode, 422);
  assert.equal((await c.post('/admin/parcelas', { ...base, hectareas: 'mucho' })).statusCode, 422);
  assert.equal((await c.post('/admin/parcelas', base)).statusCode, 302);
  assert.equal(q(app).uno("SELECT hectareas h FROM parcelas WHERE nombre = 'Nueva'").h, 1.5);
});

// ========================= Cultivos e integridad referencial =========================
test('cultivo: ciclo inválido o nombre repetido -> 422', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.post('/admin/cultivos', { nombre: 'Quinua', ciclo_dias: '0' })).statusCode, 422);
  assert.equal((await c.post('/admin/cultivos', { nombre: 'Quinua', ciclo_dias: '1.5' })).statusCode, 422);
  assert.equal((await c.post('/admin/cultivos', { nombre: 'papa', ciclo_dias: '100' })).statusCode, 422);
  assert.equal((await c.post('/admin/cultivos', { nombre: 'Quinua', ciclo_dias: '150' })).statusCode, 302);
});

test('no se puede eliminar un cultivo, insumo, parcela o productor que ya usa el core', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const papa = q(app).uno("SELECT id FROM cultivos WHERE nombre = 'Papa'").id;
  await c.post(`/admin/cultivos/${papa}/eliminar`);
  assert.match((await c.get('/admin/cultivos')).body, /No se puede eliminar|utilizado/);
  assert.ok(q(app).uno('SELECT 1 FROM cultivos WHERE id = ?', papa));

  const urea = q(app).uno("SELECT id FROM insumos WHERE nombre = 'Urea'").id;
  await c.post(`/admin/insumos/${urea}/eliminar`);
  assert.ok(q(app).uno('SELECT 1 FROM insumos WHERE id = ?', urea));

  const mirador = q(app).uno("SELECT id FROM parcelas WHERE nombre = 'El Mirador'").id;
  await c.post(`/admin/parcelas/${mirador}/eliminar`);
  assert.ok(q(app).uno('SELECT 1 FROM parcelas WHERE id = ?', mirador));

  const maria = q(app).uno("SELECT id FROM usuarios WHERE correo = 'productor@bitacoraagro.com'").id;
  await c.post(`/admin/usuarios/${maria}/eliminar`);
  assert.ok(q(app).uno('SELECT 1 FROM usuarios WHERE id = ?', maria));

  const l1 = q(app).uno("SELECT id FROM lotes WHERE codigo = 'L-0001'").id;
  await c.post(`/admin/lotes/${l1}/eliminar`); // tiene labores
  assert.ok(q(app).uno('SELECT 1 FROM lotes WHERE id = ?', l1));
});

test('un cultivo sin uso sí se puede eliminar', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const fresa = q(app).uno("SELECT id FROM cultivos WHERE nombre = 'Fresa'").id;
  await c.post(`/admin/cultivos/${fresa}/eliminar`);
  assert.equal(q(app).uno('SELECT 1 FROM cultivos WHERE id = ?', fresa), undefined);
});

// ========================= Estadísticas =========================
test('estadísticas: cálculo por rango (lotes, kg, ranking, promedio)', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const e = calcularEstadisticas(app.db, hace(365), hoy());
  assert.equal(e.totalLotes, 3);
  assert.equal(e.kgTotal, 2450);
  assert.equal(e.promedioGlobal, 4.5);
  assert.equal(e.ranking[0].productor, 'Luis Andrade');
  assert.equal(e.ranking[0].kg, 1250);
  assert.equal(e.ranking[0].labores, 4);
  assert.equal(e.cultivos[0].cultivo, 'Maíz');
  // rango que solo incluye la cosecha de hace 20 días (cebolla, 450 kg)
  const corto = calcularEstadisticas(app.db, hace(25), hace(10));
  assert.equal(corto.totalLotes, 1);
  assert.equal(corto.kgTotal, 450);
  // rango sin cosechas: promedio "No disponible" (null)
  const vacio = calcularEstadisticas(app.db, hace(5), hoy());
  assert.equal(vacio.totalLotes, 0);
  assert.equal(vacio.promedioGlobal, null);
});

test('estadísticas: la página responde y valida el rango en el servidor', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const ok = await c.get('/admin/estadisticas');
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /Luis Andrade/);
  assert.match(ok.body, /2.450/);
  assert.equal((await c.get(`/admin/estadisticas?desde=${hoy()}&hasta=${hace(10)}`)).statusCode, 422);
  assert.equal((await c.get('/admin/estadisticas?desde=basura')).statusCode, 422);
});

// ========================= Seguridad general =========================
test('buscador no se rompe con caracteres especiales (SQL parametrizado)', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  const r = await c.get(`/admin/usuarios?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /0 registros/);
});

test('XSS: el texto se escapa al mostrarse', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  await c.post('/admin/cultivos', { nombre: '<script>alert(1)</script>', ciclo_dias: '100' });
  const r = await c.get('/admin/cultivos');
  assert.doesNotMatch(r.body, /<script>alert\(1\)<\/script>/);
  assert.match(r.body, /&lt;script&gt;/);
});

test('página inexistente -> 404 amigable; todas las listas cargan', async (t) => {
  const app = await crearApp(); t.after(() => app.close());
  const c = await admin(app);
  assert.equal((await c.get('/admin/no-existe')).statusCode, 404);
  for (const m of ['usuarios', 'cultivos', 'insumos', 'parcelas', 'lotes', 'labores']) {
    assert.equal((await c.get(`/admin/${m}`)).statusCode, 200, m);
    assert.equal((await c.get(`/admin/${m}/nuevo`)).statusCode, 200, m + '/nuevo');
  }
});

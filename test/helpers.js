'use strict';
// Ayudas para las pruebas: app en memoria + cliente que guarda cookie y token CSRF.
delete process.env.ADMIN_PASSWORD; delete process.env.ADMIN_EMAIL; // las pruebas usan los valores por defecto
const { buildApp } = require('../src/app');
const { sembrar } = require('../src/db/seed');

async function crearApp() {
  const app = buildApp({ dbPath: ':memory:', sessionSecret: 'x'.repeat(40) });
  sembrar(app.db);
  await app.ready();
  return app;
}

function crearCliente(app) {
  let cookie = '';
  let csrf = '';

  function guardarCookie(res) {
    const sc = res.headers['set-cookie'];
    if (sc) cookie = (Array.isArray(sc) ? sc : [sc]).map((c) => c.split(';')[0]).join('; ');
  }
  function leerCsrf(html) {
    const m = /name="_csrf" value="([^"]+)"/.exec(html);
    if (m) csrf = m[1];
  }

  const cliente = {
    async get(url) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      guardarCookie(res);
      leerCsrf(res.body);
      return res;
    },
    async post(url, datos = {}, { sinCsrf = false } = {}) {
      const payload = new URLSearchParams(sinCsrf ? datos : { _csrf: csrf, ...datos }).toString();
      const res = await app.inject({
        method: 'POST', url, payload,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      });
      guardarCookie(res);
      return res;
    },
    async login(correo = 'admin@bitacoraagro.com', password = 'Admin123*') {
      await cliente.get('/login');
      return cliente.post('/login', { correo, password });
    },
  };
  return cliente;
}

async function admin(app) {
  const c = crearCliente(app);
  const r = await c.login();
  if (r.statusCode !== 302) throw new Error('No se pudo iniciar sesión como admin');
  await c.get('/admin'); // refresca el token CSRF
  return c;
}

// Consultas cortas a la BD de prueba
const q = (app) => ({
  uno: (sql, ...p) => app.db.prepare(sql).get(...p),
  todos: (sql, ...p) => app.db.prepare(sql).all(...p),
});

module.exports = { crearApp, crearCliente, admin, q };

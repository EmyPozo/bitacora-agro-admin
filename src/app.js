'use strict';
// =====================================================================
// BitácoraAgro (MVC)
//   M = src/db (SQLite) + src/core (reglas) + src/catalogos (administración)
//   V = src/views (plantillas EJS + Bootstrap)
//   C = src/controllers (auth, admin, productor, comprador, público)
// =====================================================================
const path = require('node:path');
const crypto = require('node:crypto');
const Fastify = require('fastify');

const { abrirBaseDeDatos } = require('./db');
const crearCatalogos = require('./catalogos');
const { menuAdmin, menuProductor, menuComprador, HOME } = require('./menus');
const { registrarCrud } = require('./controllers/crud');
const { registrarAuth } = require('./controllers/auth');
const { registrarDashboard } = require('./controllers/dashboard');
const { registrarEstadisticas } = require('./controllers/estadisticas');
const { registrarProductor } = require('./controllers/productor');
const { registrarComprador } = require('./controllers/comprador');
const { registrarPublico } = require('./controllers/publico');
const h = require('./lib/vistas');

function buildApp({ dbPath, logger = false, sessionSecret } = {}) {
  const produccion = process.env.NODE_ENV === 'production';
  const secret = sessionSecret || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  if (produccion && !sessionSecret && !process.env.SESSION_SECRET) {
    throw new Error('Falta la variable de entorno SESSION_SECRET (mínimo 32 caracteres).');
  }

  const app = Fastify({ logger, trustProxy: true });
  const db = abrirBaseDeDatos(dbPath);
  app.decorate('db', db);
  app.addHook('onClose', async () => db.close());

  // ---------- Plugins ----------
  app.register(require('@fastify/formbody'));
  app.register(require('@fastify/cookie'));
  app.register(require('@fastify/session'), {
    secret,
    cookieName: 'bitacora.sid',
    saveUninitialized: false, // no se crea sesión hasta que haga falta
    cookie: { httpOnly: true, sameSite: 'lax', secure: produccion ? 'auto' : false, maxAge: 8 * 60 * 60 * 1000 },
  });

  const catalogos = crearCatalogos(db);
  const menus = { ADMINISTRADOR: menuAdmin(catalogos), PRODUCTOR: menuProductor, COMPRADOR: menuComprador };

  app.register(require('@fastify/view'), {
    engine: { ejs: require('ejs') },
    root: path.join(__dirname, 'views'),
    layout: 'layouts/main',
    includeViewExtension: true,
  });

  // Archivos estáticos: nuestro CSS/JS y Bootstrap (instalado con npm, funciona sin internet)
  app.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public'), prefix: '/' });
  app.register(require('@fastify/static'), {
    root: path.dirname(require.resolve('bootstrap/dist/css/bootstrap.min.css')).replace(/css$/, ''),
    prefix: '/vendor/bootstrap/', decorateReply: false,
  });
  app.register(require('@fastify/static'), {
    root: path.dirname(require.resolve('bootstrap-icons/font/bootstrap-icons.min.css')),
    prefix: '/vendor/icons/', decorateReply: false,
  });

  // reply.page(vista, datos, codigo): renderiza una vista con los datos comunes
  app.decorateReply('page', function page(vista, datos = {}, codigo = 200) {
    const s = this.request.session || {};
    const anonimoPublico = datos.publico && !s.user; // visitante anónimo en la página pública: no se crea sesión
    if (s.csrf === undefined && this.request.session && !anonimoPublico) s.csrf = crypto.randomBytes(24).toString('hex');
    const flash = s.flash || null;
    if (flash) delete s.flash;
    return this.code(codigo).view(vista, {
      titulo: '', user: s.user || null, flash, csrf: s.csrf, publico: false, h,
      menu: s.user ? menus[s.user.rol] || [] : [],
      ruta: this.request.url.split('?')[0], ...datos,
    });
  });

  // ---------- Seguridad: token CSRF en todos los formularios POST ----------
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST') return;
    const esperado = req.session && req.session.csrf;
    const recibido = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';
    const ok = esperado && recibido.length === esperado.length &&
      crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(esperado));
    if (!ok) {
      return reply.page('error', {
        titulo: 'Solicitud no válida', codigo: 403,
        mensaje: 'El formulario expiró o no es válido. Recarga la página e inténtalo de nuevo.',
      }, 403);
    }
  });

  // ---------- Errores ----------
  app.setNotFoundHandler((req, reply) => {
    if (path.extname(req.url.split('?')[0])) return reply.code(404).type('text/plain').send('No encontrado');
    return reply.page('error', { titulo: 'No encontrado', codigo: 404, mensaje: 'La página que buscas no existe.' }, 404);
  });
  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    const codigo = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.page('error', {
      titulo: 'Error', codigo,
      mensaje: codigo === 500 ? 'Ocurrió un error inesperado. Inténtalo de nuevo.' : 'La solicitud no es válida.',
    }, codigo);
  });

  // ---------- Guardia por rol ----------
  // Se consulta la BD en cada petición: si desactivan o cambian de rol al usuario, pierde acceso al instante.
  function guardia(rolRequerido, prefijoApi) {
    return async (req, reply) => {
      const sesion = req.session.user;
      const esApi = prefijoApi && req.url.startsWith(prefijoApi);
      if (!sesion) {
        if (esApi) return reply.code(401).send({ error: 'No autenticado' });
        req.session.flash = { tipo: 'warning', msg: 'Inicia sesión para continuar.' };
        return reply.redirect('/login');
      }
      const u = db.prepare('SELECT id, nombre, correo, rol, activo FROM usuarios WHERE id = ?').get(sesion.id);
      if (!u || !u.activo) {
        await req.session.destroy();
        return esApi ? reply.code(401).send({ error: 'No autenticado' }) : reply.redirect('/login');
      }
      if (u.rol !== rolRequerido) {
        if (esApi) return reply.code(403).send({ error: 'Sin permiso' });
        return reply.page('error', {
          titulo: 'Acceso restringido', codigo: 403,
          mensaje: 'Esta sección es solo para usuarios con otro rol.', volver: HOME[u.rol],
        }, 403);
      }
      req.session.user = { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol };
    };
  }

  // ---------- Controladores ----------
  registrarAuth(app);
  registrarPublico(app);

  app.register(async (admin) => {
    admin.addHook('preHandler', guardia('ADMINISTRADOR', '/admin/api/'));
    registrarDashboard(admin);
    registrarEstadisticas(admin);
    for (const cfg of catalogos) registrarCrud(admin, cfg);
  });

  app.register(async (productor) => {
    productor.addHook('preHandler', guardia('PRODUCTOR', '/productor/api/'));
    registrarProductor(productor);
  });

  app.register(async (comprador) => {
    comprador.addHook('preHandler', guardia('COMPRADOR'));
    registrarComprador(comprador);
  });

  return app;
}

module.exports = { buildApp };

'use strict';
// =====================================================================
// BitácoraAgro - Administración (MVC)
//   M = src/db (SQLite) + src/catalogos (reglas de cada módulo)
//   V = src/views (plantillas EJS + Bootstrap)
//   C = src/controllers (login, panel, CRUD)
// =====================================================================
const path = require('node:path');
const crypto = require('node:crypto');
const Fastify = require('fastify');

const { abrirBaseDeDatos } = require('./db');
const crearCatalogos = require('./catalogos');
const { registrarCrud } = require('./controllers/crud');
const { registrarAuth } = require('./controllers/auth');
const { registrarDashboard } = require('./controllers/dashboard');
const { registrarEstadisticas } = require('./controllers/estadisticas');

const GRUPOS_MENU = [
  { titulo: 'Personas', slugs: ['usuarios'] },
  { titulo: 'Catálogos', slugs: ['cultivos', 'insumos'] },
  { titulo: 'Producción (alimenta al core)', slugs: ['parcelas', 'lotes', 'labores'] },
  { titulo: 'Reportes', slugs: ['estadisticas'] },
];
const EXTRAS_MENU = { estadisticas: { slug: 'estadisticas', titulo: 'Estadísticas', icono: 'bi-bar-chart-line' } };

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
    saveUninitialized: false, // no se crea sesión hasta que haga falta (evita cookies de más)
    cookie: { httpOnly: true, sameSite: 'lax', secure: produccion ? 'auto' : false, maxAge: 8 * 60 * 60 * 1000 },
  });

  const catalogos = crearCatalogos(db);
  const menu = GRUPOS_MENU.map((g) => ({
    titulo: g.titulo,
    items: g.slugs.map((s) => EXTRAS_MENU[s] || catalogos.find((c) => c.slug === s)).map((c) => ({ slug: c.slug, titulo: c.titulo, icono: c.icono })),
  }));

  app.register(require('@fastify/view'), {
    engine: { ejs: require('ejs') },
    root: path.join(__dirname, 'views'),
    layout: 'layouts/main',
    includeViewExtension: true,
    defaultContext: { menu },
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
    if (s.csrf === undefined && this.request.session) s.csrf = crypto.randomBytes(24).toString('hex');
    const flash = s.flash || null;
    if (flash) delete s.flash;
    return this.code(codigo).view(vista, {
      titulo: '', user: s.user || null, flash, csrf: s.csrf,
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
    // Pedidos de archivos (favicon, mapas, etc.): respuesta simple, sin tocar la sesión
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

  // ---------- Controladores ----------
  registrarAuth(app);

  // Todo lo que está bajo /admin exige sesión iniciada y rol ADMINISTRADOR
  app.register(async (admin) => {
    admin.addHook('preHandler', async (req, reply) => {
      const sesion = req.session.user;
      const esApi = req.url.startsWith('/admin/api/');

      if (!sesion) {
        if (esApi) return reply.code(401).send({ error: 'No autenticado' });
        req.session.flash = { tipo: 'warning', msg: 'Inicia sesión para continuar.' };
        return reply.redirect('/login');
      }
      // Se consulta la BD en cada petición: si desactivan o cambian de rol al usuario, pierde acceso al instante
      const u = db.prepare('SELECT id, nombre, correo, rol, activo FROM usuarios WHERE id = ?').get(sesion.id);
      if (!u || !u.activo) {
        await req.session.destroy();
        return esApi ? reply.code(401).send({ error: 'No autenticado' }) : reply.redirect('/login');
      }
      if (u.rol !== 'ADMINISTRADOR') {
        if (esApi) return reply.code(403).send({ error: 'Sin permiso' });
        return reply.page('error', {
          titulo: 'Acceso restringido', codigo: 403,
          mensaje: 'Esta sección es solo para administradores.',
        }, 403);
      }
      req.session.user = { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol };
    });

    registrarDashboard(admin);
    registrarEstadisticas(admin);
    for (const cfg of catalogos) registrarCrud(admin, cfg);
  });

  return app;
}

module.exports = { buildApp };

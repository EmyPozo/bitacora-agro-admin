'use strict';
// Controlador (C): inicio y cierre de sesión.
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

const MAX_INTENTOS = 5;
const VENTANA_MS = 15 * 60 * 1000;
// Hash falso: se compara siempre una contraseña, exista o no el correo,
// para que el tiempo de respuesta no revele qué correos están registrados.
const HASH_FALSO = bcrypt.hashSync('contraseña-que-nadie-usa', 10);

function registrarAuth(app) {
  const db = app.db;
  const fallos = new Map(); // ip -> { cuenta, desde }

  function estaBloqueada(ip) {
    const f = fallos.get(ip);
    if (!f) return false;
    if (Date.now() - f.desde > VENTANA_MS) { fallos.delete(ip); return false; }
    return f.cuenta >= MAX_INTENTOS;
  }
  function anotarFallo(ip) {
    const f = fallos.get(ip);
    if (!f || Date.now() - f.desde > VENTANA_MS) fallos.set(ip, { cuenta: 1, desde: Date.now() });
    else f.cuenta += 1;
  }

  app.get('/', (req, reply) => reply.redirect(req.session.user ? '/admin' : '/login'));

  app.get('/login', (req, reply) => {
    if (req.session.user) return reply.redirect('/admin');
    return reply.page('login', { titulo: 'Iniciar sesión', correo: '', error: null });
  });

  app.post('/login', async (req, reply) => {
    const body = req.body || {};
    const correo = String(body.correo || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (estaBloqueada(req.ip)) {
      return reply.page('login', {
        titulo: 'Iniciar sesión', correo,
        error: 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.',
      }, 429);
    }

    const usuario = db.prepare('SELECT * FROM usuarios WHERE correo = ?').get(correo);
    const coincide = bcrypt.compareSync(password, usuario ? usuario.password_hash : HASH_FALSO);

    if (!usuario || !usuario.activo || !coincide) {
      anotarFallo(req.ip);
      return reply.page('login', { titulo: 'Iniciar sesión', correo, error: 'Correo o contraseña incorrectos.' }, 401);
    }

    fallos.delete(req.ip);
    await req.session.regenerate(); // sesión nueva: evita la "fijación de sesión"
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    req.session.user = { id: usuario.id, nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol };
    return reply.redirect('/admin');
  });

  app.post('/logout', async (req, reply) => {
    await req.session.destroy();
    return reply.redirect('/login');
  });
}

module.exports = { registrarAuth };

'use strict';
// Controlador (C): registro, inicio y cierre de sesión.
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { validarCorreo, validarPassword } = require('../lib/validators');
const { HOME } = require('../menus');

const MAX_INTENTOS = 5;
const VENTANA_MS = 15 * 60 * 1000;
// Hash falso: se compara siempre una contraseña, exista o no el correo,
// para que el tiempo de respuesta no revele qué correos están registrados.
const HASH_FALSO = bcrypt.hashSync('contraseña-que-nadie-usa', 10);

const ROLES_REGISTRO = [
  { valor: 'PRODUCTOR', etiqueta: 'Productor (registro mi producción)' },
  { valor: 'COMPRADOR', etiqueta: 'Comprador (consulto y califico productos)' },
];

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

  // ---------- Inicio ----------
  app.get('/login', (req, reply) => {
    if (req.session.user) return reply.redirect(HOME[req.session.user.rol]);
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
    return reply.redirect(HOME[usuario.rol]);
  });

  app.post('/logout', async (req, reply) => {
    await req.session.destroy();
    return reply.redirect('/login');
  });

  // ---------- Registro (productor o comprador; el administrador no se auto-registra) ----------
  const vistaRegistro = (reply, valores, errores = {}, codigo = 200) =>
    reply.page('registro', { titulo: 'Crear cuenta', valores, errores, roles: ROLES_REGISTRO }, codigo);

  app.get('/registro', (req, reply) => {
    if (req.session.user) return reply.redirect(HOME[req.session.user.rol]);
    return vistaRegistro(reply, { rol: req.query.rol === 'COMPRADOR' ? 'COMPRADOR' : 'PRODUCTOR' });
  });

  app.post('/registro', async (req, reply) => {
    const b = req.body || {};
    const valores = {
      nombre: String(b.nombre || '').trim(),
      correo: String(b.correo || '').trim().toLowerCase(),
      rol: String(b.rol || ''),
    };
    const password = String(b.password || '');
    const errores = {};

    // Validaciones en el SERVIDOR (credenciales = dato sensible)
    if (!valores.nombre) errores.nombre = 'Escribe tu nombre.';
    else if (valores.nombre.length > 80) errores.nombre = 'Máximo 80 caracteres.';
    const ec = validarCorreo(valores.correo);
    if (ec) errores.correo = ec;
    const ep = validarPassword(password);
    if (ep) errores.password = ep;
    else if (password !== String(b.password2 || '')) errores.password2 = 'Las contraseñas no coinciden.';
    if (!ROLES_REGISTRO.some((r) => r.valor === valores.rol)) errores.rol = 'Selecciona cómo usarás BitácoraAgro.';
    if (!errores.correo && db.prepare('SELECT 1 FROM usuarios WHERE correo = ?').get(valores.correo)) {
      errores.correo = 'Ya existe una cuenta con este correo.';
    }
    if (Object.keys(errores).length) return vistaRegistro(reply, valores, errores, 422);

    db.prepare('INSERT INTO usuarios (nombre, correo, password_hash, rol) VALUES (?, ?, ?, ?)')
      .run(valores.nombre, valores.correo, bcrypt.hashSync(password, 10), valores.rol);
    req.session.flash = { tipo: 'success', msg: 'Cuenta creada. Ya puedes iniciar sesión.' };
    return reply.redirect('/login');
  });
}

module.exports = { registrarAuth };

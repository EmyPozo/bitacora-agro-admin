'use strict';
// Controlador (C): lo que ve CUALQUIER persona, sin iniciar sesión.
//   /                      inicio con buscador de código
//   /consultar             busca un código y redirige a su página
//   /t/:codigo             página pública del certificado (se abre con el QR)
//   /t/:codigo/qr.svg      imagen del QR
//   /t/:codigo/calificar   un comprador registrado califica el lote
// La página pública NO muestra datos personales: solo el nombre corto del productor.
const QRCode = require('qrcode');
const { trazabilidadPublica, validarCalificacion, registrarCalificacion } = require('../core/reglas');

/** "ba-abcd efgh" -> "BA-ABCD-EFGH" (tolera minúsculas, espacios y falta de guiones) */
function normalizarCodigo(txt) {
  const limpio = String(txt || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^BA[A-Z0-9]{8}$/.test(limpio) ? `BA-${limpio.slice(2, 6)}-${limpio.slice(6)}` : String(txt || '').trim().toUpperCase();
}

function urlPublica(req, codigo) {
  return `${req.protocol}://${req.headers.host}/t/${codigo}`;
}

function registrarPublico(app) {
  const db = app.db;

  app.get('/', (req, reply) => reply.page('publico/inicio', { titulo: 'Trazabilidad agrícola', publico: true, error: null, codigo: '' }));

  app.get('/consultar', (req, reply) => {
    const codigo = normalizarCodigo(req.query.codigo);
    if (!codigo) return reply.redirect('/');
    const existe = db.prepare('SELECT 1 FROM certificados WHERE codigo_publico = ?').get(codigo);
    if (existe) return reply.redirect(`/t/${codigo}`);
    return reply.page('publico/inicio', {
      titulo: 'Trazabilidad agrícola', publico: true, codigo,
      error: `No encontramos ningún certificado con el código «${codigo}». Revisa que esté bien escrito.`,
    }, 404);
  });

  app.get('/t/:codigo', (req, reply) => {
    const codigo = normalizarCodigo(req.params.codigo);
    const t = trazabilidadPublica(db, codigo);
    if (!t) {
      return reply.page('publico/inicio', {
        titulo: 'Certificado no encontrado', publico: true, codigo,
        error: `No existe ningún certificado con el código «${codigo}».`,
      }, 404);
    }

    const sesion = req.session.user || null;
    const comentarios = db.prepare(`
      SELECT puntaje, comentario, fecha FROM calificaciones WHERE lote_id = ? ORDER BY id DESC LIMIT 5`).all(t.lote.id);
    // La calificación del comprador que está mirando (si ya calificó este lote)
    const miCalificacion = sesion && sesion.rol === 'COMPRADOR'
      ? db.prepare('SELECT puntaje, comentario FROM calificaciones WHERE lote_id = ? AND comprador_id = ?').get(t.lote.id, sesion.id)
      : null;

    return reply.page('publico/traza', {
      titulo: `Lote ${t.lote.codigo} · ${t.lote.cultivo}`, publico: true, t, comentarios, miCalificacion,
    });
  });

  app.get('/t/:codigo/qr.svg', async (req, reply) => {
    const codigo = normalizarCodigo(req.params.codigo);
    if (!db.prepare('SELECT 1 FROM certificados WHERE codigo_publico = ?').get(codigo)) {
      return reply.code(404).type('text/plain').send('No encontrado');
    }
    const svg = await QRCode.toString(urlPublica(req, codigo), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return reply.type('image/svg+xml').header('cache-control', 'public, max-age=3600').send(svg);
  });

  // Calificar: solo comprador registrado, una vez por lote, solo lotes con certificado
  app.post('/t/:codigo/calificar', (req, reply) => {
    const codigo = normalizarCodigo(req.params.codigo);
    const volver = `/t/${codigo}`;
    const sesion = req.session.user;
    if (!sesion) {
      req.session.flash = { tipo: 'warning', msg: 'Inicia sesión como comprador para calificar.' };
      return reply.redirect('/login');
    }
    const t = trazabilidadPublica(db, codigo);
    if (!t) return reply.redirect('/');

    const compradorId = sesion.id; // el id sale de la sesión, nunca del formulario
    const b = req.body || {};
    const datos = { loteId: t.lote.id, compradorId, puntaje: String(b.puntaje || ''), comentario: String(b.comentario || '').trim() };

    const errores = validarCalificacion(db, datos);
    if (!t.verificado && !errores._general) {
      errores._general = 'No se puede calificar: este certificado no pasó la verificación de integridad.';
    }
    const primero = errores._general || errores.puntaje || errores.comentario;
    if (primero) {
      req.session.flash = { tipo: 'danger', msg: primero };
      return reply.redirect(volver);
    }
    registrarCalificacion(db, datos);
    req.session.flash = { tipo: 'success', msg: '¡Gracias! Tu calificación fue registrada.' };
    return reply.redirect(volver);
  });
}

module.exports = { registrarPublico, normalizarCodigo };

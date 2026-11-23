'use strict';
// Controlador (C): lo que hace el COMPRADOR con sesión iniciada.
// (Consultar un certificado y calificarlo se hace en la página pública /t/:codigo.)
const { nombreCorto } = require('../core/reglas');

function registrarComprador(app) {
  const db = app.db;

  const misCalificaciones = (compradorId) => db.prepare(`
    SELECT c.puntaje, c.comentario, c.fecha, l.codigo AS lote, cu.nombre AS cultivo,
           ce.codigo_publico AS certificado, u.nombre AS productor
    FROM calificaciones c
    JOIN lotes l ON l.id = c.lote_id
    JOIN cultivos cu ON cu.id = l.cultivo_id
    JOIN parcelas p ON p.id = l.parcela_id
    JOIN usuarios u ON u.id = p.usuario_id
    JOIN certificados ce ON ce.lote_id = l.id
    WHERE c.comprador_id = ? ORDER BY c.id DESC`).all(compradorId)
    .map((c) => ({ ...c, productor: nombreCorto(c.productor) }));

  app.get('/comprador', (req, reply) => {
    const lista = misCalificaciones(req.session.user.id);
    return reply.page('comprador/inicio', { titulo: 'Inicio', total: lista.length, ultimas: lista.slice(0, 3) });
  });

  app.get('/comprador/calificaciones', (req, reply) =>
    reply.page('comprador/calificaciones', { titulo: 'Mis calificaciones', lista: misCalificaciones(req.session.user.id) }));
}

module.exports = { registrarComprador };

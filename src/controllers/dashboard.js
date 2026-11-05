'use strict';
// Controlador (C): panel principal y API para el dropdown en cascada.
function registrarDashboard(app) {
  const db = app.db;
  const contar = (tabla, donde = '') => db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} ${donde}`).get().n;

  app.get('/admin', (req, reply) => {
    const resumen = {
      usuarios: contar('usuarios'),
      cultivos: contar('cultivos'),
      insumos: contar('insumos'),
      parcelas: contar('parcelas'),
      lotes: contar('lotes'),
      labores: contar('labores'),
    };
    const porRol = db.prepare('SELECT rol, COUNT(*) AS n FROM usuarios GROUP BY rol').all();
    const lotesActivos = contar('lotes', "WHERE estado = 'ACTIVO'");
    const lotesCosechados = contar('lotes', "WHERE estado = 'COSECHADO'");
    const recientes = db.prepare(`
      SELECT l.codigo, cu.nombre AS cultivo, p.nombre AS parcela, u.nombre AS productor, l.estado, l.fecha_siembra
      FROM lotes l JOIN cultivos cu ON cu.id = l.cultivo_id JOIN parcelas p ON p.id = l.parcela_id JOIN usuarios u ON u.id = p.usuario_id
      ORDER BY l.id DESC LIMIT 5`).all();
    return reply.page('dashboard', { titulo: 'Panel de administración', resumen, porRol, recientes, lotesActivos, lotesCosechados });
  });

  // Alimenta el dropdown de parcelas cuando se elige un productor (dropdown en cascada)
  app.get('/admin/api/productores/:id/parcelas', (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: 'Productor inválido' });
    return db.prepare('SELECT id AS valor, nombre AS etiqueta FROM parcelas WHERE usuario_id = ? ORDER BY nombre')
      .all(Number(req.params.id));
  });
}

module.exports = { registrarDashboard };

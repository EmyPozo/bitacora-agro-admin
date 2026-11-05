'use strict';
// Catálogo: Cultivos. Alimenta el campo "cultivo" de cada lote del core.
module.exports = () => ({
  slug: 'cultivos',
  titulo: 'Cultivos',
  singular: 'Cultivo',
  icono: 'bi-flower1',
  tabla: 'cultivos',
  campos: [
    { name: 'nombre', label: 'Nombre del cultivo', tipo: 'text', requerido: true, maxLen: 60 },
    {
      name: 'ciclo_dias', label: 'Ciclo (días)', tipo: 'number', requerido: true, min: 1, max: 400,
      ayuda: 'Días aproximados desde la siembra hasta la cosecha.',
    },
  ],
  columnas: [
    { label: 'Cultivo', campo: 'nombre' },
    { label: 'Ciclo', formato: (f) => `${f.ciclo_dias} días` },
    { label: 'Lotes que lo usan', campo: 'lotes' },
  ],
  sqlLista: `
    SELECT c.*, (SELECT COUNT(*) FROM lotes l WHERE l.cultivo_id = c.id) AS lotes
    FROM cultivos c
    WHERE c.nombre LIKE @q
    ORDER BY c.nombre`,
});

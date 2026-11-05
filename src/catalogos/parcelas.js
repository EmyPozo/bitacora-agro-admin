'use strict';
// Catálogo: Parcelas. Cada parcela pertenece a un PRODUCTOR (dropdown, no input).
module.exports = (db) => ({
  slug: 'parcelas',
  titulo: 'Parcelas',
  singular: 'Parcela',
  femenino: true,
  icono: 'bi-map',
  tabla: 'parcelas',
  campos: [
    { name: 'nombre', label: 'Nombre de la parcela', tipo: 'text', requerido: true, maxLen: 80 },
    { name: 'ubicacion', label: 'Ubicación', tipo: 'text', requerido: true, maxLen: 120, ayuda: 'Ejemplo: Latacunga, Cotopaxi.' },
    { name: 'hectareas', label: 'Hectáreas', tipo: 'number', decimal: true, requerido: true, min: 0.01, max: 100000 },
    {
      name: 'usuario_id', label: 'Productor (dueño)', tipo: 'select-fk', requerido: true,
      ref: 'usuarios', refWhere: "rol = 'PRODUCTOR' AND activo = 1",
      opciones: () => db.prepare("SELECT id AS valor, nombre AS etiqueta FROM usuarios WHERE rol = 'PRODUCTOR' AND activo = 1 ORDER BY nombre").all(),
    },
  ],
  columnas: [
    { label: 'Parcela', campo: 'nombre' },
    { label: 'Ubicación', campo: 'ubicacion' },
    { label: 'Hectáreas', campo: 'hectareas' },
    { label: 'Productor', campo: 'productor' },
  ],
  sqlLista: `
    SELECT p.*, u.nombre AS productor
    FROM parcelas p JOIN usuarios u ON u.id = p.usuario_id
    WHERE p.nombre LIKE @q OR p.ubicacion LIKE @q OR u.nombre LIKE @q
    ORDER BY p.nombre`,
});

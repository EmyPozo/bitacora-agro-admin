'use strict';
// Catálogo: Insumos. Los días de carencia son la base de la regla más importante
// del core: no se puede cosechar hasta que pasen los días de carencia del último
// agroquímico aplicado.
const TIPOS = [
  { valor: 'FERTILIZANTE', etiqueta: 'Fertilizante' },
  { valor: 'PESTICIDA', etiqueta: 'Pesticida' },
  { valor: 'FUNGICIDA', etiqueta: 'Fungicida' },
  { valor: 'HERBICIDA', etiqueta: 'Herbicida' },
  { valor: 'SEMILLA', etiqueta: 'Semilla' },
];
const TIPOS_QUIMICOS = ['PESTICIDA', 'FUNGICIDA', 'HERBICIDA'];

module.exports = () => ({
  slug: 'insumos',
  titulo: 'Insumos',
  singular: 'Insumo',
  icono: 'bi-droplet-half',
  tabla: 'insumos',
  valoresIniciales: { es_agroquimico: 0, dias_carencia: 0 },
  campos: [
    { name: 'nombre', label: 'Nombre del insumo', tipo: 'text', requerido: true, maxLen: 80 },
    { name: 'tipo', label: 'Tipo', tipo: 'select', requerido: true, opciones: TIPOS },
    {
      name: 'es_agroquimico', label: 'Es agroquímico', tipo: 'checkbox',
      ayuda: 'Márcalo si tiene tiempo de carencia antes de cosechar.',
    },
    {
      name: 'dias_carencia', label: 'Días de carencia', tipo: 'number', min: 0, max: 365, sensible: true,
      ayuda: 'Días que deben pasar entre la aplicación y la cosecha. Si no es agroquímico, se guarda 0.',
    },
  ],
  columnas: [
    { label: 'Insumo', campo: 'nombre' },
    { label: 'Tipo', formato: (f) => (TIPOS.find((t) => t.valor === f.tipo) || {}).etiqueta || f.tipo },
    {
      label: 'Agroquímico',
      formato: (f) => (f.es_agroquimico ? 'Sí' : 'No'),
      badge: (f) => (f.es_agroquimico ? 'warning' : 'secondary'),
    },
    { label: 'Carencia', formato: (f) => (f.es_agroquimico ? `${f.dias_carencia} días` : '—') },
  ],
  sqlLista: `
    SELECT * FROM insumos
    WHERE nombre LIKE @q OR tipo LIKE @q
    ORDER BY nombre`,

  // Reglas de negocio validadas en el servidor
  validar(d) {
    const errores = {};
    if (TIPOS_QUIMICOS.includes(d.tipo) && !d.es_agroquimico) {
      errores.es_agroquimico = 'Pesticidas, fungicidas y herbicidas deben marcarse como agroquímico.';
    }
    // Dato sensible: sin días de carencia reales el core no puede proteger la cosecha
    if (d.es_agroquimico && (d.dias_carencia === '' || Number(d.dias_carencia) < 1)) {
      errores.dias_carencia = 'Un agroquímico debe tener al menos 1 día de carencia.';
    }
    return errores;
  },
  normalizar(v) {
    if (!v.es_agroquimico) v.dias_carencia = 0;
  },
});

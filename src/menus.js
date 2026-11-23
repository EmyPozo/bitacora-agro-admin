'use strict';
// Menú de navegación según el rol del usuario. Cada grupo: { titulo, items: [{ href, titulo, icono }] }
function menuAdmin(catalogos) {
  const item = (slug) => {
    const c = catalogos.find((x) => x.slug === slug);
    return { href: `/admin/${slug}`, titulo: c.titulo, icono: c.icono };
  };
  return [
    { titulo: null, items: [{ href: '/admin', titulo: 'Panel', icono: 'bi-speedometer2', exacto: true }] },
    { titulo: 'Personas', items: [item('usuarios')] },
    { titulo: 'Catálogos', items: [item('cultivos'), item('insumos')] },
    { titulo: 'Producción (alimenta al core)', items: [item('parcelas'), item('lotes'), item('labores')] },
    { titulo: 'Reportes', items: [{ href: '/admin/estadisticas', titulo: 'Estadísticas', icono: 'bi-bar-chart-line' }] },
  ];
}

const menuProductor = [
  { titulo: null, items: [
    { href: '/productor', titulo: 'Inicio', icono: 'bi-house', exacto: true },
    { href: '/productor/parcelas', titulo: 'Parcelas', icono: 'bi-map' },
    { href: '/productor/lotes', titulo: 'Lotes', icono: 'bi-box-seam' },
    { href: '/productor/reporte', titulo: 'Mi reporte', icono: 'bi-pie-chart' },
    { href: '/productor/calificaciones', titulo: 'Calificaciones', icono: 'bi-star' },
  ] },
];

const menuComprador = [
  { titulo: null, items: [
    { href: '/comprador', titulo: 'Inicio', icono: 'bi-house', exacto: true },
    { href: '/comprador/calificaciones', titulo: 'Mis calificaciones', icono: 'bi-star' },
  ] },
];

const ROLES = { ADMINISTRADOR: 'Administrador', PRODUCTOR: 'Productor', COMPRADOR: 'Comprador' };
const HOME = { ADMINISTRADOR: '/admin', PRODUCTOR: '/productor', COMPRADOR: '/comprador' };

module.exports = { menuAdmin, menuProductor, menuComprador, ROLES, HOME };

'use strict';
// Ayudas para las plantillas EJS (se usan como h.estrellas(4), h.fecha('2026-11-05'), etc.)
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const TIPOS_LABOR = { RIEGO: 'Riego', ABONADO: 'Abonado', FUMIGACION: 'Fumigación', DESHIERBE: 'Deshierbe', OTRO: 'Otro' };
const ICONOS_LABOR = {
  RIEGO: 'bi-droplet', ABONADO: 'bi-basket', FUMIGACION: 'bi-wind', DESHIERBE: 'bi-scissors', OTRO: 'bi-tools',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const h = {
  esc,
  tipoLabor: (t) => TIPOS_LABOR[t] || t,
  iconoLabor: (t) => ICONOS_LABOR[t] || 'bi-tools',
  /** '2026-11-05' -> '5 nov 2026' */
  fecha(txt) {
    if (!txt) return '—';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(txt);
    return m ? `${Number(m[3])} ${MESES[Number(m[2]) - 1]} ${m[1]}` : esc(txt);
  },
  numero: (n) => Number(n).toLocaleString('es-EC', { maximumFractionDigits: 2 }),
  /** Estrellas ★★★★☆ (HTML seguro: solo caracteres propios). Acepta decimales (se redondea a la más cercana). */
  estrellas(n) {
    const r = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return `<span class="estrellas" aria-label="${r} de 5 estrellas">${'★'.repeat(r)}<span class="vacia">${'★'.repeat(5 - r)}</span></span>`;
  },
  /** "4.5 ★" o "No disponible" */
  reputacion: (rep) => (rep.promedio === null ? 'No disponible' : `${rep.promedio.toFixed(1)} ★`),
  diasTxt: (n) => `${n} ${n === 1 ? 'día' : 'días'}`,
};

module.exports = h;

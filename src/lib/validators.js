'use strict';
// =====================================================================
// Validaciones de datos SENSIBLES del core. Se ejecutan SIEMPRE en el
// servidor (back-end) antes de guardar en la base de datos. El navegador
// solo ayuda al usuario, pero nunca es la validación real.
//
// Datos sensibles de BitácoraAgro:
//   1. Días de carencia de un insumo  -> seguridad alimentaria
//   2. Fecha de una labor             -> integridad del historial del lote
//   3. Credenciales (correo/contraseña)
// =====================================================================

function validarCorreo(correo) {
  if (typeof correo !== 'string' || correo.length > 120) return 'Correo demasiado largo.';
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo) ? null : 'Ingresa un correo válido.';
}

function validarPassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (password.length > 72) return 'La contraseña no puede superar 72 caracteres.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return 'Debe incluir mayúsculas, minúsculas y números.';
  }
  return null;
}

/** ¿Es una fecha real con formato AAAA-MM-DD? (rechaza 2026-02-31, por ejemplo) */
function esFechaValida(txt) {
  if (typeof txt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(txt)) return false;
  const d = new Date(`${txt}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === txt;
}

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria de Ecuador. */
function hoyISO(ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(ahora);
}

/** Suma (o resta) días a una fecha AAAA-MM-DD. */
function sumarDias(txt, dias) {
  const d = new Date(`${txt}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

module.exports = { validarCorreo, validarPassword, esFechaValida, hoyISO, sumarDias };

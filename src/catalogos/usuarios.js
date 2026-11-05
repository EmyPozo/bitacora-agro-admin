'use strict';
// Catálogo: Usuarios (administrador, productor, comprador).
//
//  * Correo y contraseña son datos SENSIBLES: se validan en el back-end
//    (formato, fuerza de la contraseña, correo único) antes de grabar.
//  * La contraseña se guarda con bcrypt, nunca en texto plano.
//  * Los productores creados aquí son los dueños de las parcelas del core.
const bcrypt = require('bcryptjs');
const { validarPassword } = require('../lib/validators');

const ROLES = [
  { valor: 'ADMINISTRADOR', etiqueta: 'Administrador' },
  { valor: 'PRODUCTOR', etiqueta: 'Productor' },
  { valor: 'COMPRADOR', etiqueta: 'Comprador' },
];

function otrosAdminsActivos(db, idExcluido) {
  return db.prepare(`SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'ADMINISTRADOR' AND activo = 1 AND id != ?`)
    .get(idExcluido ?? 0).n;
}

module.exports = () => ({
  slug: 'usuarios',
  titulo: 'Usuarios',
  singular: 'Usuario',
  icono: 'bi-people',
  tabla: 'usuarios',
  valoresIniciales: { rol: 'PRODUCTOR', activo: 1 },

  campos: [
    { name: 'nombre', label: 'Nombre completo', tipo: 'text', requerido: true, maxLen: 80 },
    { name: 'correo', label: 'Correo electrónico', tipo: 'email', requerido: true, maxLen: 120, sensible: true },
    {
      name: 'password', label: 'Contraseña', tipo: 'password', requerido: true, guardar: false, maxLen: 72, sensible: true,
      ayuda: 'Mínimo 8 caracteres con mayúsculas, minúsculas y números. Al editar, déjala vacía para no cambiarla.',
    },
    { name: 'rol', label: 'Rol', tipo: 'select', requerido: true, opciones: ROLES },
    { name: 'activo', label: 'Usuario activo (puede iniciar sesión)', tipo: 'checkbox' },
  ],

  columnas: [
    { label: 'Nombre', campo: 'nombre' },
    { label: 'Correo', campo: 'correo' },
    {
      label: 'Rol',
      formato: (f) => (ROLES.find((r) => r.valor === f.rol) || {}).etiqueta,
      badge: (f) => ({ ADMINISTRADOR: 'dark', PRODUCTOR: 'success', COMPRADOR: 'info' }[f.rol]),
    },
    { label: 'Estado', formato: (f) => (f.activo ? 'Activo' : 'Inactivo'), badge: (f) => (f.activo ? 'success' : 'secondary') },
  ],
  sqlLista: `
    SELECT * FROM usuarios
    WHERE nombre LIKE @q OR correo LIKE @q OR rol LIKE @q
    ORDER BY nombre`,

  limpiar(d) {
    d.correo = d.correo.toLowerCase();
  },

  // ----- Validaciones en el SERVIDOR -----
  validar(d, { id, db: bd, sesion }) {
    const errores = {};

    // 1) Contraseña: obligatoria al crear; al editar solo si se escribe una nueva
    if (d.password !== '') {
      const msg = validarPassword(d.password);
      if (msg) errores.password = msg;
    }

    // 2) Protecciones para no dejar el sistema sin administrador
    if (id !== null) {
      const actual = bd.prepare('SELECT rol, activo FROM usuarios WHERE id = ?').get(id);
      const eraAdminActivo = actual && actual.rol === 'ADMINISTRADOR' && actual.activo === 1;
      const seguiraAdminActivo = d.rol === 'ADMINISTRADOR' && d.activo === 1;
      if (eraAdminActivo && !seguiraAdminActivo) {
        if (sesion && sesion.id === id) {
          errores.rol = 'No puedes quitarte el rol de administrador ni desactivarte a ti mismo.';
        } else if (otrosAdminsActivos(bd, id) === 0) {
          errores.rol = 'Debe quedar al menos un administrador activo.';
        }
      }
    }
    return errores;
  },

  // La contraseña se transforma en hash antes de guardarse
  extras(d) {
    return d.password !== '' ? { password_hash: bcrypt.hashSync(d.password, 10) } : {};
  },

  puedeEliminar(fila, { db: bd, sesion }) {
    if (sesion && sesion.id === fila.id) return 'No puedes eliminar tu propia cuenta.';
    if (fila.rol === 'ADMINISTRADOR' && fila.activo === 1 && otrosAdminsActivos(bd, fila.id) === 0) {
      return 'Debe quedar al menos un administrador activo.';
    }
    return null;
  },
});

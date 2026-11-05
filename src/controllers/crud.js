'use strict';
// =====================================================================
// Controlador (C) reutilizable para todos los módulos de administración.
//
// Cada catálogo (usuarios, cultivos, insumos, lotes, ...) solo
// describe SUS campos y SUS reglas en un archivo de configuración
// (carpeta src/catalogos). Este controlador se encarga de:
//   listar -> mostrar formulario -> VALIDAR EN EL SERVIDOR -> guardar -> eliminar
// =====================================================================
const { validarCorreo, esFechaValida } = require('../lib/validators');

function registrarCrud(app, cfg) {
  const db = app.db;
  const base = `/admin/${cfg.slug}`;
  const campos = cfg.campos;
  const nombreDe = (fila) => (cfg.etiquetaFila ? cfg.etiquetaFila(fila) : fila.nombre);

  // ---------- 1. Leer lo que mandó el formulario ----------
  function leerDatos(body) {
    const datos = {};
    for (const c of campos) {
      if (c.tipo === 'checkbox') {
        datos[c.name] = body[c.name] ? 1 : 0;
      } else {
        datos[c.name] = String(body[c.name] ?? '').trim();
        if (c.decimal) datos[c.name] = datos[c.name].replace(',', '.');
      }
    }
    if (cfg.limpiar) cfg.limpiar(datos);
    return datos;
  }

  // ---------- 2. Validar (SIEMPRE en el back-end) ----------
  function validar(datos, id, sesion) {
    const errores = {};

    for (const c of campos) {
      const v = datos[c.name];
      if (c.tipo === 'checkbox') continue;

      const vacio = v === '';
      const obligatorio = c.requerido && !(c.tipo === 'password' && id !== null);
      if (vacio) {
        if (obligatorio) errores[c.name] = c.tipo.startsWith('select') ? 'Selecciona una opción.' : 'Este campo es obligatorio.';
        continue;
      }

      if (c.maxLen && v.length > c.maxLen) {
        errores[c.name] = `Máximo ${c.maxLen} caracteres.`;
      } else if (c.tipo === 'email') {
        const msg = validarCorreo(v);
        if (msg) errores[c.name] = msg;
      } else if (c.tipo === 'number') {
        const formato = c.decimal ? /^-?\d+(\.\d+)?$/ : /^-?\d+$/;
        const n = Number(v);
        if (!formato.test(v)) errores[c.name] = c.decimal ? 'Debe ser un número.' : 'Debe ser un número entero.';
        else if (c.min !== undefined && n < c.min) errores[c.name] = `Debe ser mayor o igual a ${c.min}.`;
        else if (c.max !== undefined && n > c.max) errores[c.name] = `Debe ser menor o igual a ${c.max}.`;
      } else if (c.tipo === 'date') {
        if (!esFechaValida(v)) errores[c.name] = 'Ingresa una fecha válida.';
      } else if (c.tipo === 'select') {
        if (!c.opciones.some((o) => o.valor === v)) errores[c.name] = 'Opción no permitida.';
      } else if (c.tipo === 'select-fk' || c.tipo === 'select-dep') {
        // Aunque el formulario use un dropdown, el servidor NO confía:
        // comprueba que el id exista en la tabla relacionada.
        const n = Number(v);
        if (!/^\d+$/.test(v)) {
          errores[c.name] = 'Selecciona una opción válida.';
        } else if (c.refFiltro && datos[c.refFiltro.desde] === '') {
          errores[c.name] = 'Primero elige la opción anterior.';
        } else if (c.refFiltro && errores[c.refFiltro.desde]) {
          // el campo anterior ya tiene error: no se compara contra un valor inválido
        } else {
          let sql = `SELECT 1 FROM ${c.ref} WHERE id = ?`;
          const params = [n];
          if (c.refWhere) sql += ` AND ${c.refWhere}`;
          if (c.refFiltro) {
            sql += ` AND ${c.refFiltro.col} = ?`;
            params.push(Number(datos[c.refFiltro.desde]));
          }
          if (!db.prepare(sql).get(...params)) {
            errores[c.name] = c.refFiltro
              ? 'Esa opción no pertenece a la selección anterior.'
              : 'La opción seleccionada no existe.';
          }
        }
      }
    }

    // Reglas propias de cada catálogo (por ejemplo: validar los días de carencia)
    if (cfg.validar) {
      const extra = cfg.validar(datos, { id, db, sesion });
      for (const [campo, msg] of Object.entries(extra)) {
        if (!errores[campo]) errores[campo] = msg;
      }
    }
    return errores;
  }

  // ---------- 3. Preparar los valores que van a la base de datos ----------
  function valoresParaDb(datos, esNuevo) {
    const v = {};
    for (const c of campos) {
      if (c.guardar === false) continue;
      const numerico = c.tipo === 'number' || c.tipo === 'select-fk' || c.tipo === 'select-dep';
      if (numerico) v[c.name] = datos[c.name] === '' ? null : Number(datos[c.name]); // opcional vacío -> NULL
      else v[c.name] = datos[c.name];
    }
    if (cfg.extras) Object.assign(v, cfg.extras(datos, esNuevo));
    if (cfg.normalizar) cfg.normalizar(v);
    return v;
  }

  function mapearErrorBD(e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const m = /failed: (.+)$/.exec(e.message);
      const columna = m ? m[1].split(',')[0].split('.').pop().trim() : '';
      const campo = campos.find((c) => c.name === columna);
      const mensaje = cfg.mensajeDuplicado || `Ya existe un registro con ese ${campo ? campo.label.toLowerCase() : 'valor'}.`;
      return { [campo ? columna : '_general']: mensaje };
    }
    if (e.code && e.code.startsWith('SQLITE_CONSTRAINT')) {
      return { _general: 'No se pudo guardar: los datos no cumplen las reglas de la base de datos.' };
    }
    throw e;
  }

  // ---------- 4. Opciones de los dropdowns ----------
  function opcionesFormulario(valores) {
    const out = {};
    for (const c of campos) {
      if (c.tipo === 'select-fk') out[c.name] = c.opciones();
      if (c.tipo === 'select-dep') out[c.name] = valores[c.dependeDe] ? c.opcionesDe(valores[c.dependeDe]) : [];
    }
    return out;
  }

  function mostrarFormulario(reply, { id = null, valores, errores = {}, status = 200 }) {
    return reply.page('crud/form', {
      titulo: `${id ? 'Editar' : (cfg.femenino ? 'Nueva' : 'Nuevo')} ${cfg.singular.toLowerCase()}`,
      cfg, id, valores, errores,
      opciones: opcionesFormulario(valores),
      accion: id ? `${base}/${id}` : base,
    }, status);
  }

  const idValido = (txt) => (/^\d+$/.test(txt) ? Number(txt) : null);
  const buscar = (id) => db.prepare(`SELECT * FROM ${cfg.tabla} WHERE id = ?`).get(id);

  // ---------- Rutas ----------
  // LISTAR (con buscador)
  app.get(base, (req, reply) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    const filas = db.prepare(cfg.sqlLista).all({ q: `%${q}%` });
    return reply.page('crud/list', { titulo: cfg.titulo, cfg, filas, q });
  });

  // FORMULARIO NUEVO
  app.get(`${base}/nuevo`, (req, reply) => {
    return mostrarFormulario(reply, { valores: { ...(typeof cfg.valoresIniciales === 'function' ? cfg.valoresIniciales() : cfg.valoresIniciales || {}) } });
  });

  // GUARDAR NUEVO
  app.post(base, (req, reply) => guardar(req, reply, null));

  // FORMULARIO EDITAR
  app.get(`${base}/:id/editar`, (req, reply) => {
    const id = idValido(req.params.id);
    const fila = id === null ? null : buscar(id);
    if (!fila) return reply.page('error', { titulo: 'No encontrado', codigo: 404, mensaje: 'Ese registro no existe.' }, 404);
    return mostrarFormulario(reply, { id, valores: { ...fila, ...(cfg.alEditar ? cfg.alEditar(fila) : {}) } });
  });

  // GUARDAR CAMBIOS
  app.post(`${base}/:id`, (req, reply) => {
    const id = idValido(req.params.id);
    if (id === null || !buscar(id)) {
      return reply.page('error', { titulo: 'No encontrado', codigo: 404, mensaje: 'Ese registro no existe.' }, 404);
    }
    return guardar(req, reply, id);
  });

  function guardar(req, reply, id) {
    const datos = leerDatos(req.body || {});
    const errores = validar(datos, id, req.session.user);
    if (Object.keys(errores).length) {
      return mostrarFormulario(reply, { id, valores: datos, errores, status: 422 });
    }

    const valores = valoresParaDb(datos, id === null);
    const columnas = Object.keys(valores);
    try {
      if (id === null) {
        db.prepare(`INSERT INTO ${cfg.tabla} (${columnas.join(', ')}) VALUES (${columnas.map((c) => '@' + c).join(', ')})`).run(valores);
      } else {
        db.prepare(`UPDATE ${cfg.tabla} SET ${columnas.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...valores, id });
      }
    } catch (e) {
      return mostrarFormulario(reply, { id, valores: datos, errores: mapearErrorBD(e), status: 422 });
    }

    req.session.flash = { tipo: 'success', msg: `${cfg.singular} ${id === null ? 'creado' : 'actualizado'} correctamente.` };
    return reply.redirect(base);
  }

  // ELIMINAR
  app.post(`${base}/:id/eliminar`, (req, reply) => {
    const id = idValido(req.params.id);
    const fila = id === null ? null : buscar(id);
    if (!fila) {
      req.session.flash = { tipo: 'warning', msg: 'Ese registro ya no existe.' };
      return reply.redirect(base);
    }

    const bloqueo = cfg.puedeEliminar ? cfg.puedeEliminar(fila, { db, sesion: req.session.user }) : null;
    if (bloqueo) {
      req.session.flash = { tipo: 'danger', msg: bloqueo };
      return reply.redirect(base);
    }

    try {
      db.prepare(`DELETE FROM ${cfg.tabla} WHERE id = ?`).run(id);
      req.session.flash = { tipo: 'success', msg: `${cfg.singular} «${nombreDe(fila)}» eliminado.` };
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        // Integridad referencial: la BD no deja borrar algo que otros registros usan
        req.session.flash = { tipo: 'danger', msg: `No se puede eliminar «${nombreDe(fila)}» porque está siendo utilizado por otros registros.` };
      } else {
        throw e;
      }
    }
    return reply.redirect(base);
  });
}

module.exports = { registrarCrud };

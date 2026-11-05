'use strict';
// Datos iniciales para poder usar y demostrar el sistema desde el primer arranque.
// Es seguro ejecutarlo varias veces: solo siembra si la base está vacía.
// Las fechas son relativas a HOY para que siempre cumplan las reglas del core
// (ninguna labor en el futuro, ninguna anterior a la siembra).
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { abrirBaseDeDatos } = require('./index');
const { hoyISO, sumarDias } = require('../lib/validators');

// [nombre, ciclo en días]
const CULTIVOS = [['Papa', 150], ['Maíz', 180], ['Tomate riñón', 120], ['Cebolla', 110], ['Fréjol', 110], ['Fresa', 90]];

// [nombre, tipo, es agroquímico, días de carencia]
const INSUMOS = [
  ['Urea', 'FERTILIZANTE', 0, 0],
  ['Compost orgánico', 'FERTILIZANTE', 0, 0],
  ['Semilla certificada', 'SEMILLA', 0, 0],
  ['Mancozeb', 'FUNGICIDA', 1, 7],
  ['Cipermetrina', 'PESTICIDA', 1, 14],
  ['Glifosato', 'HERBICIDA', 1, 21],
];

function sembrar(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n > 0) return false;

  const adminCorreo = process.env.ADMIN_EMAIL || 'admin@bitacoraagro.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123*';
  const hoy = hoyISO();
  const hace = (dias) => sumarDias(hoy, -dias);
  const hash = (p) => bcrypt.hashSync(p, 10);

  db.transaction(() => {
    const insCultivo = db.prepare('INSERT INTO cultivos (nombre, ciclo_dias) VALUES (?, ?)');
    const cultivo = {};
    for (const [n, d] of CULTIVOS) cultivo[n] = insCultivo.run(n, d).lastInsertRowid;

    const insInsumo = db.prepare('INSERT INTO insumos (nombre, tipo, es_agroquimico, dias_carencia) VALUES (?, ?, ?, ?)');
    const insumo = {};
    for (const [n, t, a, d] of INSUMOS) insumo[n] = insInsumo.run(n, t, a, d).lastInsertRowid;

    const insUsuario = db.prepare('INSERT INTO usuarios (nombre, correo, password_hash, rol) VALUES (?, ?, ?, ?)');
    insUsuario.run('Administrador BitácoraAgro', adminCorreo, hash(adminPassword), 'ADMINISTRADOR');
    const maria = insUsuario.run('María Pérez', 'productor@bitacoraagro.com', hash('Productor123*'), 'PRODUCTOR').lastInsertRowid;
    const luis = insUsuario.run('Luis Andrade', 'productor2@bitacoraagro.com', hash('Productor123*'), 'PRODUCTOR').lastInsertRowid;
    const hacienda = insUsuario.run('Restaurante La Hacienda', 'comprador@bitacoraagro.com', hash('Comprador123*'), 'COMPRADOR').lastInsertRowid;
    const mercado = insUsuario.run('Mercado Verde', 'comprador2@bitacoraagro.com', hash('Comprador123*'), 'COMPRADOR').lastInsertRowid;

    const insParcela = db.prepare('INSERT INTO parcelas (nombre, ubicacion, hectareas, usuario_id) VALUES (?, ?, ?, ?)');
    const mirador = insParcela.run('El Mirador', 'Latacunga, Cotopaxi', 2.5, maria).lastInsertRowid;
    const esperanza = insParcela.run('La Esperanza', 'Salcedo, Cotopaxi', 1.2, maria).lastInsertRowid;
    const sanJuan = insParcela.run('San Juan', 'Ibarra, Imbabura', 3, luis).lastInsertRowid;

    const insLote = db.prepare('INSERT INTO lotes (codigo, fecha_siembra, estado, parcela_id, cultivo_id) VALUES (?, ?, ?, ?, ?)');
    const insLabor = db.prepare('INSERT INTO labores (tipo, fecha, descripcion, cantidad, lote_id, insumo_id) VALUES (?, ?, ?, ?, ?, ?)');
    const insCosecha = db.prepare('INSERT INTO cosechas (fecha, cantidad_kg, calidad, lote_id) VALUES (?, ?, ?, ?)');
    const insCert = db.prepare('INSERT INTO certificados (codigo_publico, hash, fecha_emision, lote_id) VALUES (?, ?, ?, ?)');
    const insCalif = db.prepare('INSERT INTO calificaciones (puntaje, comentario, lote_id, comprador_id) VALUES (?, ?, ?, ?)');

    // Lote ACTIVO con labores: sirve para demostrar que no se puede borrar lo que está en uso
    const l1 = insLote.run('L-0001', hace(60), 'ACTIVO', mirador, cultivo['Papa']).lastInsertRowid;
    insLabor.run('ABONADO', hace(40), 'Abonado de cobertura', 25, l1, insumo['Urea']);
    insLabor.run('RIEGO', hace(25), 'Riego por surcos', 3, l1, null);
    insLabor.run('FUMIGACION', hace(10), 'Control de tizón', 2, l1, insumo['Mancozeb']);

    // Lotes COSECHADOS con certificado y calificaciones: alimentan las estadísticas
    function lotecosechado(codigo, siembra, parcela, cultivoId, labores, cosecha, calificaciones) {
      const id = insLote.run(codigo, hace(siembra), 'COSECHADO', parcela, cultivoId).lastInsertRowid;
      for (const [tipo, dias, desc, cant, ins] of labores) insLabor.run(tipo, hace(dias), desc, cant, id, ins);
      insCosecha.run(hace(cosecha[0]), cosecha[1], cosecha[2], id);
      const hashCert = crypto.createHash('sha256').update(`${codigo}|${hace(siembra)}|${hace(cosecha[0])}|${cosecha[1]}`).digest('hex');
      insCert.run(`BA-${hashCert.slice(0, 8).toUpperCase()}`, hashCert, hace(cosecha[0] - 1), id);
      for (const [puntaje, comentario, comprador] of calificaciones) insCalif.run(puntaje, comentario, id, comprador);
    }
    lotecosechado('L-0002', 200, esperanza, cultivo['Maíz'],
      [['ABONADO', 170, 'Abonado de fondo', 40, insumo['Urea']], ['FUMIGACION', 120, 'Control de gusano cogollero', 1.5, insumo['Cipermetrina']]],
      [60, 1200, 'Primera'], [[5, 'Excelente calidad y buena entrega.', hacienda], [4, 'Muy buen producto.', mercado]]);
    lotecosechado('L-0003', 150, sanJuan, cultivo['Tomate riñón'],
      [['RIEGO', 100, 'Riego por goteo', 5, null], ['FUMIGACION', 90, 'Control de hongos', 2, insumo['Mancozeb']]],
      [35, 800, 'Primera'], [[5, 'Tomates frescos y firmes.', hacienda]]);
    lotecosechado('L-0004', 140, sanJuan, cultivo['Cebolla'],
      [['DESHIERBE', 90, 'Deshierbe manual', null, null], ['FUMIGACION', 80, 'Control de malezas', 1, insumo['Glifosato']]],
      [20, 450, 'Segunda'], [[4, 'Buen tamaño.', mercado]]);
  })();
  return true;
}

module.exports = { sembrar };

// Permite ejecutar:  npm run seed
if (require.main === module) {
  const db = abrirBaseDeDatos();
  console.log(sembrar(db) ? 'Datos iniciales cargados.' : 'La base ya tiene datos; no se cambió nada.');
  db.close();
}

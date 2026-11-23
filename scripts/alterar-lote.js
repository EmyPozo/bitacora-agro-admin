'use strict';
// DEMOSTRACIÓN de la verificación de integridad: simula que alguien modifica la base de datos "por debajo".
//   npm run demo:alterar   -- L-0002    -> cambia la descripción de una labor del lote (queda marcada)
//   npm run demo:restaurar -- L-0002    -> deja el lote como estaba
// Después abre la página pública del certificado: verás la alerta roja (o "Verificado" tras restaurar).
const { abrirBaseDeDatos } = require('../src/db');
const { verificarCertificado } = require('../src/core/reglas');

const MARCA = ' [ALTERADO]';
const [accion, codigo] = process.argv.slice(2);

if (!['alterar', 'restaurar'].includes(accion) || !codigo) {
  console.log('Uso: node scripts/alterar-lote.js <alterar|restaurar> <código del lote>   Ej: alterar L-0002');
  process.exit(1);
}

const db = abrirBaseDeDatos();
const lote = db.prepare('SELECT id FROM lotes WHERE codigo = ?').get(codigo);
const cert = lote && db.prepare('SELECT * FROM certificados WHERE lote_id = ?').get(lote.id);
if (!lote || !cert) {
  console.error(`El lote «${codigo}» no existe o no tiene certificado.`);
  process.exit(1);
}
const labor = db.prepare('SELECT id, descripcion FROM labores WHERE lote_id = ? ORDER BY id LIMIT 1').get(lote.id);

if (accion === 'alterar' && !labor.descripcion.endsWith(MARCA)) {
  db.prepare('UPDATE labores SET descripcion = ? WHERE id = ?').run(labor.descripcion + MARCA, labor.id);
}
if (accion === 'restaurar' && labor.descripcion.endsWith(MARCA)) {
  db.prepare('UPDATE labores SET descripcion = ? WHERE id = ?').run(labor.descripcion.slice(0, -MARCA.length), labor.id);
}

const ok = verificarCertificado(db, cert);
console.log(`Lote ${codigo} (${cert.codigo_publico}): ${ok ? 'VERIFICADO ✔ (historial íntegro)' : 'ALERTA ✘ (el historial ya no coincide con el certificado)'}`);
console.log(`Ábrelo en: /t/${cert.codigo_publico}`);
db.close();

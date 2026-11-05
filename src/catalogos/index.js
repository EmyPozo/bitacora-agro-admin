'use strict';
// Lista de módulos de administración (aparecen en el menú lateral).
const crear = {
  usuarios: require('./usuarios'),
  cultivos: require('./cultivos'),
  insumos: require('./insumos'),
  parcelas: require('./parcelas'),
  lotes: require('./lotes'),
  labores: require('./labores'),
};

module.exports = (db) => Object.values(crear).map((fabrica) => fabrica(db));

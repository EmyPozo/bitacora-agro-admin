'use strict';
const { buildApp } = require('./app');
const { sembrar } = require('./db/seed');

const app = buildApp({ logger: true });

// Si la base está vacía (primer arranque o nuevo deploy) se cargan los datos iniciales
if (sembrar(app.db)) app.log.info('Base de datos vacía: se cargaron los datos iniciales.');

const puerto = Number(process.env.PORT) || 3000;
app.listen({ port: puerto, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

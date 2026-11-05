'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validarCorreo, validarPassword, esFechaValida, hoyISO, sumarDias } = require('../src/lib/validators');

test('correo', () => {
  assert.equal(validarCorreo('a@b.com'), null);
  assert.equal(typeof validarCorreo('no-es-correo'), 'string');
  assert.equal(typeof validarCorreo('a@b'), 'string');
  assert.equal(typeof validarCorreo('a b@c.com'), 'string');
});

test('contraseña fuerte', () => {
  assert.equal(validarPassword('Segura123'), null);
  assert.equal(typeof validarPassword('corta1A'), 'string');
  assert.equal(typeof validarPassword('sinmayusculas1'), 'string');
  assert.equal(typeof validarPassword('SINMINUSCULAS1'), 'string');
  assert.equal(typeof validarPassword('SinNumeros'), 'string');
});

test('fechas: formato y existencia real', () => {
  assert.equal(esFechaValida('2026-11-05'), true);
  assert.equal(esFechaValida('2026-02-31'), false);
  assert.equal(esFechaValida('05/11/2026'), false);
  assert.equal(esFechaValida('2026-13-01'), false);
  assert.equal(esFechaValida(''), false);
  assert.equal(esFechaValida(undefined), false);
});

test('hoyISO y sumarDias', () => {
  assert.match(hoyISO(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(sumarDias('2026-11-05', 7), '2026-11-12');
  assert.equal(sumarDias('2026-03-01', -1), '2026-02-28');
  assert.equal(sumarDias('2026-12-31', 1), '2027-01-01');
});

// BitácoraAgro Admin - ayudas de interfaz.
// IMPORTANTE: nada de esto es una validación de seguridad; el servidor valida todo otra vez.
(function () {
  'use strict';

  // 1) Dropdown en cascada (por ejemplo Productor -> Parcela)
  document.querySelectorAll('select[data-dep-url]').forEach(function (hijo) {
    var padre = document.getElementById(hijo.dataset.parent);
    var estado = document.querySelector('[data-estado-para="' + hijo.name + '"]');
    if (!padre) return;
    var pedido = 0;

    function mensaje(txt) { if (estado) estado.textContent = txt; }

    function cargar(valorAnterior) {
      var valorPadre = padre.value;
      hijo.innerHTML = '<option value="">Selecciona...</option>';
      if (!valorPadre) { hijo.disabled = true; mensaje('Primero elige la opción anterior.'); return; }

      var numero = ++pedido;
      hijo.disabled = true;
      mensaje('Cargando...');
      fetch(hijo.dataset.depUrl.replace(':id', encodeURIComponent(valorPadre)), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (lista) {
          if (numero !== pedido) return; // llegó una respuesta vieja: se ignora
          lista.forEach(function (o) {
            var op = document.createElement('option');
            op.value = o.valor;
            op.textContent = o.etiqueta; // textContent: evita inyectar HTML
            if (valorAnterior && String(o.valor) === String(valorAnterior)) op.selected = true;
            hijo.appendChild(op);
          });
          hijo.disabled = false;
          mensaje(lista.length === 1 ? '1 opción disponible.' : lista.length + ' opciones disponibles.');
        })
        .catch(function () { if (numero === pedido) { hijo.disabled = true; mensaje('No se pudo cargar. Recarga la página.'); } });
    }

    padre.addEventListener('change', function () { cargar(''); });
    if (!padre.value) { hijo.disabled = true; mensaje('Primero elige la opción anterior.'); }
    // Al deshabilitar un select no se envía: se reactiva justo antes de enviar para que el servidor lo reciba y lo valide
    if (hijo.form) hijo.form.addEventListener('submit', function () { hijo.disabled = false; });
  });

  // 2) Modal de eliminar: rellena nombre y destino
  var modal = document.getElementById('modalEliminar');
  if (modal) {
    modal.addEventListener('show.bs.modal', function (ev) {
      var boton = ev.relatedTarget;
      if (!boton) return;
      document.getElementById('formEliminar').action = boton.dataset.action;
      document.getElementById('nombreEliminar').textContent = '«' + boton.dataset.nombre + '»';
    });
  }
})();

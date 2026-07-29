// ============================================================================
// TEST del parser central de precios de ficha  ->  node test-parser-precio-ficha.js
// ----------------------------------------------------------------------------
// El repo NO tiene tests. Este es el primero y cubre EXACTAMENTE los casos reales del
// incidente 2026-07-28 (lead Alejandro Cabrera / cuenta Anton), que es lo que no puede
// volver a pasar. NO levanta el server ni toca la base ni gasta un token de IA: extrae
// el bloque del parser de server.js y lo evalua aislado.
// ============================================================================
var fs = require('fs');
var path = require('path');

var SRC = path.join(__dirname, 'server.js');
var txt = fs.readFileSync(SRC, 'utf8');
var ini = txt.indexOf('function _ppNorm(s) {');
var fin = txt.indexOf('// M20: alias de extraerPrecioDe');
if (ini < 0 || fin < 0 || fin <= ini) {
  console.error('NO se pudo aislar el parser en server.js (cambiaron los anclajes). ini=' + ini + ' fin=' + fin);
  process.exit(1);
}
var bloque = txt.slice(ini, fin);
var parsearPrecioFicha;
try {
  // eslint-disable-next-line no-eval
  parsearPrecioFicha = eval('(function(){ ' + bloque + ' return parsearPrecioFicha; })()');
} catch (e) {
  console.error('El bloque del parser no evalua:', e && e.message);
  process.exit(1);
}

var okTotal = 0, falloTotal = 0;
function chequear(nombre, cond, detalle) {
  if (cond) { okTotal++; console.log('  OK   ' + nombre); }
  else { falloTotal++; console.log('  FALLA ' + nombre + (detalle ? ('  -> ' + detalle) : '')); }
}
function tieneDuda(r, campo) {
  return (r.dudas || []).some(function (d) { return d.campo === campo; });
}
function j(x) { try { return JSON.stringify(x); } catch (e) { return String(x); } }

console.log('');
console.log('== CASO 1 (Local Globo Rojo n33606): "U$S 30.000" + "Alquiler anual, En Venta, Oportunidad" ==');
console.log('   La IA lo ofrecio como "$30.000 por mes". Tiene que dar VENTA USD 30000 y ANUAL EN DUDA.');
var c1 = parsearPrecioFicha('U$S 30.000', 'Alquiler anual, En Venta, Oportunidad');
chequear('venta = 30000', c1.venta && c1.venta.precio === 30000, j(c1.venta));
chequear('venta en USD', c1.venta && c1.venta.moneda === 'USD', j(c1.venta));
chequear('anual PRESENTE pero SIN precio (a consultar)', c1.anual && c1.anual.precio === null, j(c1.anual));
chequear('anual NO se lleva los 30000', !(c1.anual && c1.anual.precio === 30000), j(c1.anual));
chequear('hay duda en el campo anual', tieneDuda(c1, 'anual'), j(c1.dudas));
chequear('no marca la propiedad como no disponible', c1.no_disponible.venta === false && c1.no_disponible.anual === false, j(c1.no_disponible));

console.log('');
console.log('== CASO 2 (Sabor a Mama n29605): "RETASADO U$S 45.000" + "En Venta, No disponible" ==');
console.log('   Tiene que dar VENTA USD 45000 NO DISPONIBLE y NINGUN alquiler anual.');
var c2 = parsearPrecioFicha('RETASADO U$S 45.000', 'En Venta, No disponible');
chequear('venta = 45000 (RETASADO se ignora como ruido)', c2.venta && c2.venta.precio === 45000, j(c2.venta));
chequear('venta en USD', c2.venta && c2.venta.moneda === 'USD', j(c2.venta));
chequear('anual = null (no se ofrece)', c2.anual === null, j(c2.anual));
chequear('temporal = null (no se ofrece)', c2.temporal === null, j(c2.temporal));
chequear('no_disponible.venta = true', c2.no_disponible.venta === true, j(c2.no_disponible));
chequear('no_disponible.anual = false', c2.no_disponible.anual === false, j(c2.no_disponible));

console.log('');
console.log('== CASO 3 (temporal sano): "POR NOCHE $132.000 (DIC)" + "Alquiler temporario" ==');
var c3 = parsearPrecioFicha('POR NOCHE $132.000 (DIC)', 'Alquiler temporario');
chequear('temporal precio_dia = 132000', c3.temporal && c3.temporal.precio_dia === 132000, j(c3.temporal));
chequear('temporal en ARS', c3.temporal && c3.temporal.moneda === 'ARS', j(c3.temporal));
chequear('venta = null', c3.venta === null, j(c3.venta));
chequear('anual = null', c3.anual === null, j(c3.anual));
chequear('detecta la temporada "dic"', c3.temporal_temporada === 'dic', j(c3.temporal_temporada));
chequear('sin dudas', (c3.dudas || []).length === 0, j(c3.dudas));

console.log('');
console.log('== CASO 4 (Edificio San Jorge n12247): "U$S 52.000" en una propiedad TEMPORAL ==');
console.log('   Es una VENTA de U$S 52.000 que quedo guardada como "52.000 por noche". Tiene que ir a DUDA.');
var c4 = parsearPrecioFicha('U$S 52.000', 'Alquiler temporario');
chequear('temporal SIN precio_dia', c4.temporal && c4.temporal.precio_dia === null, j(c4.temporal));
chequear('NO escribe 52000 por noche', !(c4.temporal && c4.temporal.precio_dia === 52000), j(c4.temporal));
chequear('hay duda en el campo temporal', tieneDuda(c4, 'temporal'), j(c4.dudas));

console.log('');
console.log('== EXTRA: reglas de diseno que Diego pidio ==');
var e1 = parsearPrecioFicha('$ 300.000', 'Casa en el centro');
chequear('sin operacion reconocible -> NO default a venta', e1.venta === null && e1.anual === null && e1.temporal === null, j(e1));
chequear('sin operacion reconocible -> duda de operacion', tieneDuda(e1, 'operacion'), j(e1.dudas));

var e2 = parsearPrecioFicha('$400.000 por mes', 'Alquiler anual');
chequear('anual por mes = 400000 ARS', e2.anual && e2.anual.precio === 400000 && e2.anual.moneda === 'ARS', j(e2.anual));
chequear('anual sano no genera duda', (e2.dudas || []).length === 0, j(e2.dudas));

var e3 = parsearPrecioFicha('U$S 1.200 por mes', 'Alquiler anual');
chequear('alquiler anual en USD -> duda y NO se escribe', e3.anual && e3.anual.precio === null && tieneDuda(e3, 'anual'), j(e3));

var e4 = parsearPrecioFicha('POR NOCHE $500', 'Alquiler temporario');
chequear('tarifa por noche absurda (<5000 ARS) -> duda y no se escribe', e4.temporal && e4.temporal.precio_dia === null && tieneDuda(e4, 'temporal'), j(e4));

var e5 = parsearPrecioFicha('U$S 30.000', 'Alquiler temporario, En Venta');
chequear('temporal + venta con precio USD -> el numero va a VENTA', e5.venta && e5.venta.precio === 30000, j(e5.venta));
chequear('temporal queda a consultar, no se lleva el numero', e5.temporal && e5.temporal.precio_dia === null, j(e5.temporal));

var e6 = parsearPrecioFicha('U$S 80.000', 'Alquiler temporario, No disponible');
chequear('temporal "no disponible" -> NO apaga nada (D2)', e6.no_disponible.venta === false && e6.no_disponible.anual === false, j(e6.no_disponible));
chequear('temporal "no disponible" -> duda de disponibilidad', tieneDuda(e6, 'disponibilidad'), j(e6.dudas));

var e7 = parsearPrecioFicha('U$S 120.000', 'En Venta, Alquiler anual, No disponible');
chequear('no disponible con 2 operaciones -> NO apaga ninguna, va a duda', e7.no_disponible.venta === false && e7.no_disponible.anual === false && tieneDuda(e7, 'disponibilidad'), j(e7));

var e8 = parsearPrecioFicha('U$S 95.000', 'Vendida');
chequear('"Vendida" -> venta no disponible', e8.no_disponible.venta === true, j(e8.no_disponible));

var e9 = parsearPrecioFicha('Consultar', 'En Venta');
chequear('sin numero -> venta presente a consultar', e9.venta && e9.venta.precio === null, j(e9.venta));

var e10 = parsearPrecioFicha('Desde $80.000 hasta $120.000', 'En Venta');
chequear('dos precios distintos -> no escribe y va a duda', e10.venta && e10.venta.precio === null && (e10.dudas || []).length > 0, j(e10));

var e11 = parsearPrecioFicha(null, null);
chequear('entrada vacia no explota', e11 && e11.venta === null && Array.isArray(e11.dudas), j(e11));

var e12 = parsearPrecioFicha('$0', 'En Venta');
chequear('precio 0 -> duda y no se escribe', e12.venta && e12.venta.precio === null && (e12.dudas || []).length > 0, j(e12));

console.log('');
console.log('=======================================');
console.log('  OK: ' + okTotal + '   FALLAS: ' + falloTotal);
console.log('=======================================');
process.exit(falloTotal > 0 ? 1 : 0);

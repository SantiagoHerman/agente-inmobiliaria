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
chequear('detecta la temporada de verano', c3.temporada && c3.temporada.tipo === 'verano', j(c3.temporada));
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

// ============================================================================
// TEMPORADAS: invierno vs verano, rango de fechas y la REGLA DEL AÑO.
// A cada caso se le pasa una fecha de referencia FIJA para que el test no dependa de "hoy".
// ============================================================================
console.log('');
console.log('== TEMPORADAS (Diego: "existen temporadas de invierno y verano, hay que saber distinguir") ==');

// (a) Los 32 precios reales de Anton: marca (DIC), vistos el 2026-06-26. Diego: son verano 2026 = VIEJOS.
var t1 = parsearPrecioFicha('POR NOCHE $132.000 (DIC)', 'Alquiler temporario', '2026-06-26');
chequear('(DIC) -> temporada de VERANO', t1.temporada && t1.temporada.tipo === 'verano', j(t1.temporada));
chequear('(DIC) visto en jun-2026 -> verano 2026 (la que ya habia arrancado)', t1.temporada && t1.temporada.etiqueta === 'verano 2026', j(t1.temporada));
chequear('rango dic-2025 a mar-2026', t1.temporada && t1.temporada.desde === '2025-12-01' && t1.temporada.hasta === '2026-03-31', j(t1.temporada));
chequear('queda marcado que el año se infirio', t1.temporada && t1.temporada.anio_inferido === true, j(t1.temporada));
chequear('VENCIDA (termino antes de hoy 2026-07-28)', t1.temporada && t1.temporada.hasta < '2026-07-28', j(t1.temporada));
chequear('no genera duda (la proxima arranca recien en diciembre)', (t1.dudas || []).length === 0, j(t1.dudas));

// (b) VERANO VIGENTE: misma clase de marca, mirada en pleno verano.
var t2 = parsearPrecioFicha('POR NOCHE $150.000 (ENE)', 'Alquiler temporario', '2026-02-10');
chequear('(ENE) en feb-2026 -> verano 2026 VIGENTE', t2.temporada && t2.temporada.etiqueta === 'verano 2026' && t2.temporada.hasta >= '2026-02-10', j(t2.temporada));
chequear('el precio del verano vigente se escribe', t2.temporal && t2.temporal.precio_dia === 150000, j(t2.temporal));

// (c) INVIERNO: no se puede confundir con verano ni con su rango.
var t3 = parsearPrecioFicha('POR NOCHE $80.000 (JUL)', 'Alquiler temporario', '2026-07-20');
chequear('(JUL) -> temporada de INVIERNO', t3.temporada && t3.temporada.tipo === 'invierno', j(t3.temporada));
chequear('invierno 2026 = todo julio 2026', t3.temporada && t3.temporada.desde === '2026-07-01' && t3.temporada.hasta === '2026-07-31', j(t3.temporada));
chequear('un precio de julio NO cubre enero', t3.temporada && !(t3.temporada.desde <= '2027-01-15' && t3.temporada.hasta >= '2027-01-15'), j(t3.temporada));

// (d) AMBIGUA: (JUL) visto 5 dias ANTES de que arranque julio. No se sabe si es viejo o adelantado.
var t4 = parsearPrecioFicha('POR NOCHE $80.000 (JUL)', 'Alquiler temporario', '2026-06-26');
chequear('marca sin año al borde de la temporada -> DUDA', tieneDuda(t4, 'temporal'), j(t4.dudas));
chequear('ante la duda resuelve a la temporada VIEJA (error seguro)', t4.temporada && t4.temporada.etiqueta === 'invierno 2025', j(t4.temporada));

// (e) AÑO EXPLICITO: no se infiere nada, y el año no se confunde con un segundo precio.
var t5 = parsearPrecioFicha('POR NOCHE $200.000 (DIC 2026)', 'Alquiler temporario', '2026-07-28');
chequear('(DIC 2026) -> verano 2027 (se nombra por el año en que termina)', t5.temporada && t5.temporada.etiqueta === 'verano 2027', j(t5.temporada));
chequear('rango dic-2026 a mar-2027', t5.temporada && t5.temporada.desde === '2026-12-01' && t5.temporada.hasta === '2027-03-31', j(t5.temporada));
chequear('el año NO se lee como un segundo precio', t5.temporal && t5.temporal.precio_dia === 200000, j(t5.temporal));
chequear('marcado como año NO inferido', t5.temporada && t5.temporada.anio_inferido === false, j(t5.temporada));

var t6 = parsearPrecioFicha('POR NOCHE $210.000 verano 2027', 'Alquiler temporario', '2026-07-28');
chequear('"verano 2027" se toma tal cual', t6.temporada && t6.temporada.etiqueta === 'verano 2027', j(t6.temporada));

// (f) Otro mes (ni verano ni invierno): se resuelve igual, como ese mes.
var t7 = parsearPrecioFicha('POR NOCHE $60.000 (SEP)', 'Alquiler temporario', '2026-07-28');
chequear('(SEP) se resuelve como septiembre, sin forzarlo a verano/invierno', t7.temporada && t7.temporada.tipo === 'mes' && t7.temporada.desde === '2025-09-01', j(t7.temporada));

// (g) Dos marcas distintas -> duda, sin temporada.
var t8 = parsearPrecioFicha('POR NOCHE $70.000 (DIC) (JUL)', 'Alquiler temporario', '2026-07-28');
chequear('dos temporadas distintas en el mismo precio -> duda', tieneDuda(t8, 'temporal'), j(t8.dudas));
chequear('dos temporadas distintas -> no se deriva ninguna', t8.temporada === null, j(t8.temporada));

// (h) Sin marca: no hay temporada y no se inventa nada.
var t9 = parsearPrecioFicha('POR NOCHE $95.000', 'Alquiler temporario', '2026-07-28');
chequear('sin marca de temporada no se inventa ninguna', t9.temporada === null, j(t9.temporada));
chequear('sin marca el precio se escribe igual', t9.temporal && t9.temporal.precio_dia === 95000, j(t9.temporal));

// ============================================================================
// SEGUNDA PARTE: _scrapCamposDeParse — QUE se escribe de verdad en la base (correccion D2).
// El parser dice que confirma la web; esta funcion decide que columnas se tocan mirando ademas la
// fila que YA esta guardada. Es donde vive la "baja por operacion" y el anti-regresion.
// ============================================================================
var iniC = txt.indexOf('function _scrapCamposDeParse(parse, ex, tieneCols) {');
var finC = txt.indexOf('// Guarda UNA duda en la cola de revision');
if (iniC < 0 || finC < 0) { console.error('No se pudo aislar _scrapCamposDeParse'); process.exit(1); }
var _scrapCamposDeParse;
try {
  // eslint-disable-next-line no-eval
  _scrapCamposDeParse = eval('(function(){ function _scrapNum(v){ if (v == null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; } '
    + txt.slice(iniC, finC) + ' return _scrapCamposDeParse; })()');
} catch (e) { console.error('_scrapCamposDeParse no evalua:', e && e.message); process.exit(1); }

console.log('');
console.log('== D2: la baja es POR OPERACION, y el temporal NUNCA apaga la propiedad ==');

// Sabor a Mama: local EN VENTA "No disponible", sin ninguna otra operacion viva.
var d1 = _scrapCamposDeParse(parsearPrecioFicha('RETASADO U$S 45.000', 'En Venta, No disponible'),
  { id: 'x', venta_activa: true, venta_precio: 45000, anual_activa: false, temporal_activa: false }, true);
chequear('apaga la operacion de VENTA', d1.fila.venta_activa === false, j(d1.fila));
chequear('sin operaciones vivas -> apaga la propiedad', d1.fila.activa === false, j(d1.fila));
chequear('la apaga CON pausa_manual (si no, el cron la revive)', d1.fila.pausa_manual === true, j(d1.fila));
chequear('deja registrado no_disponible_web', d1.fila.no_disponible_web === true, j(d1.fila));

// Misma baja de venta pero la propiedad TAMBIEN se alquila: la propiedad NO se apaga.
var d2 = _scrapCamposDeParse(parsearPrecioFicha('U$S 45.000', 'En Venta, No disponible'),
  { id: 'x', venta_activa: true, anual_activa: true, temporal_activa: false }, true);
chequear('con otra operacion viva NO apaga la propiedad', d2.fila.activa === undefined, j(d2.fila));
chequear('no la pausa a mano', d2.fila.pausa_manual === undefined, j(d2.fila));

// LEGACY: columnas de operacion en null y la web dice "En Venta, Alquiler anual, Alquilada".
var d3 = _scrapCamposDeParse(parsearPrecioFicha('U$S 120.000', 'En Venta, Alquiler anual, Alquilada'),
  { id: 'x', venta_activa: null, anual_activa: null, temporal_activa: null }, true);
chequear('NO apaga una propiedad cuya venta la web sigue publicando', d3.fila.activa === undefined, j(d3.fila));

// Temporal: "no disponible" sin fechas NO apaga nada (va por temporario_periodos).
var d4 = _scrapCamposDeParse(parsearPrecioFicha('POR NOCHE $90.000', 'Alquiler temporario, No disponible'),
  { id: 'x', venta_activa: false, anual_activa: false, temporal_activa: true }, true);
chequear('temporal no disponible -> NO apaga la propiedad', d4.fila.activa === undefined, j(d4.fila));
chequear('temporal no disponible -> NO la pausa', d4.fila.pausa_manual === undefined, j(d4.fila));

console.log('');
console.log('== Anti-regresion: no pisar datos guardados con inferencias ==');

// Misma moneda, precio nuevo -> cambio sano, se escribe.
var a1 = _scrapCamposDeParse(parsearPrecioFicha('U$S 33.000', 'En Venta'),
  { id: 'x', venta_activa: true, venta_precio: 30000, venta_moneda: 'USD' }, true);
chequear('precio nuevo en la MISMA moneda se actualiza', a1.fila.venta_precio === 33000, j(a1.fila));

// Cambio de moneda -> NO se pisa, va a duda.
var a2 = _scrapCamposDeParse(parsearPrecioFicha('$ 33.000', 'En Venta'),
  { id: 'x', venta_activa: true, venta_precio: 30000, venta_moneda: 'USD' }, true);
chequear('cambio de MONEDA no se escribe', a2.fila.venta_precio === undefined, j(a2.fila));
chequear('cambio de MONEDA genera duda', (a2.dudas || []).length > 0, j(a2.dudas));

// Mismo numero: solo completa la moneda que falta, no toca el numero.
var a3 = _scrapCamposDeParse(parsearPrecioFicha('U$S 30.000', 'En Venta'),
  { id: 'x', venta_activa: true, venta_precio: 30000, venta_moneda: null }, true);
chequear('completa la moneda que faltaba', a3.fila.venta_moneda === 'USD', j(a3.fila));
chequear('no reescribe el numero que ya estaba', a3.fila.venta_precio === undefined, j(a3.fila));

// Sin la migracion corrida (tieneCols=false) no se toca ninguna columna nueva.
var a4 = _scrapCamposDeParse(parsearPrecioFicha('U$S 30.000', 'En Venta'), { id: 'x', venta_activa: true }, false);
chequear('sin migracion NO escribe columnas de moneda', a4.fila.venta_moneda === undefined && a4.fila.no_disponible_web === undefined, j(a4.fila));

// FIRMA DEL ENVENENAMIENTO: el mismo numero cargado en una operacion que la web no confirma.
var a5 = _scrapCamposDeParse(parsearPrecioFicha('U$S 52.000', 'En Venta'),
  { id: 'x', venta_activa: true, venta_precio: null, temporal_activa: true, temporal_precio_dia: 52000 }, true);
chequear('detecta el numero de venta cargado como tarifa por noche', (a5.dudas || []).some(function (d) { return d.campo === 'temporal'; }), j(a5.dudas));
chequear('NO lo corrige solo (no borra el dato)', a5.fila.temporal_precio_dia === undefined, j(a5.fila));

// AUTO-CURACION: la web la vuelve a publicar y la pausa la habia puesto el sistema.
var a6 = _scrapCamposDeParse(parsearPrecioFicha('U$S 45.000', 'En Venta'),
  { id: 'x', venta_activa: false, activa: false, pausa_manual: true, no_disponible_web: true }, true);
chequear('se despausa sola si la web la vuelve a publicar', a6.fila.activa === true && a6.fila.pausa_manual === false, j(a6.fila));
chequear('y repone la operacion que la web confirma', a6.fila.venta_activa === true, j(a6.fila));

// Una pausa MANUAL del dueno (sin no_disponible_web) NO se toca.
var a7 = _scrapCamposDeParse(parsearPrecioFicha('U$S 45.000', 'En Venta'),
  { id: 'x', venta_activa: true, activa: false, pausa_manual: true, no_disponible_web: false }, true);
chequear('NO revive una propiedad pausada a mano por el dueno', a7.fila.activa === undefined && a7.fila.pausa_manual === undefined, j(a7.fila));

// ============================================================================
// TERCERA PARTE: la temporada CONTRA LA BASE.
//  (1) el ancla de fecha (que evita que la temporada se re-fECHE sola en cada corrida),
//  (2) que solo se escriba en `temporario_periodos` cuando de verdad cambio algo,
//  (3) que un precio de temporada VENCIDA no llegue a la IA como vigente.
// ============================================================================
function trozo(desde, hasta, etiqueta) {
  var a = txt.indexOf(desde), b = txt.indexOf(hasta, a);
  if (a < 0 || b < 0) { console.error('No se pudo aislar ' + etiqueta); process.exit(1); }
  return txt.slice(a, b);
}
var srcEscribir = trozo('async function _scrapEscribirTemporada(', '// Trae de una las temporadas ya derivadas', '_scrapEscribirTemporada');
var srcAncla = trozo('function _scrapAnclaTemporada(', '// Sincroniza la temporada de UNA propiedad', '_scrapAnclaTemporada');
var srcSinc = trozo('async function _scrapSincronizarTemporada(', '// Guarda UNA duda en la cola', '_scrapSincronizarTemporada');

function stubSupabase(reg) {
  return { from: function (tabla) {
    var ctx = { tabla: tabla, filtros: {} };
    var q = {
      delete: function () { ctx.op = 'delete'; return q; },
      select: function () { return q; },
      eq: function (k, v) { ctx.filtros[k] = v; return q; },
      insert: function (row) { ctx.op = 'insert'; ctx.row = row; reg.push(ctx); return Promise.resolve({ error: null }); },
      then: function (res) { reg.push(ctx); return Promise.resolve(res({ error: null, data: [] })); }
    };
    return q;
  } };
}

console.log('');
console.log('== TEMPORADA CONTRA LA BASE (ancla de fecha y escritura en temporario_periodos) ==');

var _pack = eval('(function(supabase){ ' + srcEscribir + srcAncla + srcSinc
  + ' return { escribir: _scrapEscribirTemporada, ancla: _scrapAnclaTemporada, sinc: _scrapSincronizarTemporada }; })');

// (1) ANCLA: con el precio SIN cambios se ancla en el inicio de la temporada ya derivada -> re-deriva
//     EXACTAMENTE la misma. Es lo que evita que un "(DIC)" viejo se convierta en "verano 2027" el 1-dic.
var prevDic = { desde: '2025-12-01', hasta: '2026-03-31', precio_dia: 132000, texto: 'POR NOCHE $132.000 (DIC)' };
var api = _pack(stubSupabase([]));
var anclaIgual = api.ancla(prevDic, 'POR NOCHE $132.000 (DIC)', '2026-06-26');
chequear('precio sin cambios -> se ancla en la temporada ya derivada', anclaIgual === '2025-12-01', j(anclaIgual));
var reDeriva = parsearPrecioFicha('POR NOCHE $132.000 (DIC)', 'Alquiler temporario', anclaIgual);
chequear('re-derivar da la MISMA temporada (no se re-fecha sola)', reDeriva.temporada && reDeriva.temporada.etiqueta === 'verano 2026', j(reDeriva.temporada));
var reDeriva2 = parsearPrecioFicha('POR NOCHE $132.000 (DIC)', 'Alquiler temporario', api.ancla(prevDic, 'POR NOCHE $132.000 (DIC)', '2026-12-15'));
chequear('sigue dando verano 2026 aunque la corrida sea en diciembre-2026', reDeriva2.temporada && reDeriva2.temporada.etiqueta === 'verano 2026', j(reDeriva2.temporada));

// Si la web REPUBLICA el precio (texto distinto), se ancla en hoy: es informacion nueva.
chequear('precio republicado -> se ancla en hoy (null)', api.ancla(prevDic, 'POR NOCHE $180.000 (DIC)', '2026-06-26') === null, 'ancla');
chequear('sin temporada previa -> se ancla en el alta de la propiedad', api.ancla(null, 'POR NOCHE $132.000 (DIC)', '2026-06-26') === '2026-06-26', 'ancla');

// (2) ESCRITURA: solo cuando cambia algo.
(async function () {
  var reg1 = [];
  var api1 = _pack(stubSupabase(reg1));
  var parseDic = parsearPrecioFicha('POR NOCHE $132.000 (DIC)', 'Alquiler temporario', '2025-12-01');
  var n1 = await api1.sinc('u1', 'prop1', parseDic, 'POR NOCHE $132.000 (DIC)', prevDic);
  chequear('temporada sin cambios -> NO reescribe nada', n1 === 0 && reg1.length === 0, j(reg1));

  var reg2 = [];
  var api2 = _pack(stubSupabase(reg2));
  var n2 = await api2.sinc('u1', 'prop1', parseDic, 'POR NOCHE $132.000 (DIC)', null);
  var ins2 = reg2.filter(function (r) { return r.op === 'insert'; })[0];
  chequear('temporada nueva -> escribe la fila', n2 === 1 && !!ins2, j(reg2));
  chequear('va a temporario_periodos con estado "temporada" (no "ocupado")', ins2 && ins2.tabla === 'temporario_periodos' && ins2.row.estado === 'temporada', j(ins2 && ins2.row));
  chequear('guarda el rango de fechas de la temporada', ins2 && ins2.row.fecha_desde === '2025-12-01' && ins2.row.fecha_hasta === '2026-03-31', j(ins2 && ins2.row));
  chequear('guarda el precio por noche', ins2 && Number(ins2.row.precio_dia) === 132000, j(ins2 && ins2.row));
  chequear('aisla por tenant (user_id)', ins2 && ins2.row.user_id === 'u1', j(ins2 && ins2.row));

  var reg3 = [];
  var api3 = _pack(stubSupabase(reg3));
  var parseSinMarca = parsearPrecioFicha('POR NOCHE $99.000', 'Alquiler temporario', '2026-07-28');
  var n3 = await api3.sinc('u1', 'prop1', parseSinMarca, 'POR NOCHE $99.000', prevDic);
  chequear('si el precio deja de traer marca -> borra la temporada colgada', n3 === 0 && reg3.some(function (r) { return r.op === 'delete'; }), j(reg3));

  // (3) LO QUE VE LA IA: neutralizar el precio de una temporada vencida (codigo real del prompt).
  var srcNeutro = trozo('const _hoyISO = new Date().toISOString().slice(0, 10);', '} catch (eTempVenc)', 'bloque temporada vencida');
  var props = [
    { id: 'p-vencida', temporal_activa: true, temporal_precio_dia: 132000 },
    { id: 'p-vigente', temporal_activa: true, temporal_precio_dia: 150000 },
    { id: 'p-sin-temporada', temporal_activa: true, temporal_precio_dia: 90000 },
    { id: 'p-ocupada', temporal_activa: true, temporal_precio_dia: 70000 }
  ];
  var periodosPorProp = {
    'p-vencida': [{ estado: 'temporada', fecha_desde: '2025-12-01', fecha_hasta: '2026-03-31' }],
    'p-vigente': [{ estado: 'temporada', fecha_desde: '2026-07-01', fecha_hasta: '2999-12-31' }],
    'p-ocupada': [{ estado: 'ocupado', fecha_desde: '2020-01-01', fecha_hasta: '2020-01-10' }]
  };
  var res = eval('(function(properties, periodosPorProp){ let _hayTemporadaVencida = false; '
    + srcNeutro + ' return { props: properties, hay: _hayTemporadaVencida }; })')(props, periodosPorProp);
  chequear('precio de temporada VENCIDA -> se neutraliza (la IA dice "consultar")', res.props[0].temporal_precio_dia === null, j(res.props[0]));
  chequear('precio de temporada VIGENTE -> intacto', res.props[1].temporal_precio_dia === 150000, j(res.props[1]));
  chequear('propiedad SIN temporada derivada -> intacta (igual que hoy)', res.props[2].temporal_precio_dia === 90000, j(res.props[2]));
  chequear('una fila "ocupado" NO se confunde con una temporada', res.props[3].temporal_precio_dia === 70000, j(res.props[3]));
  chequear('se prende el aviso para la linea del prompt', res.hay === true, j(res.hay));

  console.log('');
  console.log('=======================================');
  console.log('  OK: ' + okTotal + '   FALLAS: ' + falloTotal);
  console.log('=======================================');
  process.exit(falloTotal > 0 ? 1 : 0);
})();

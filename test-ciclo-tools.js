// ============================================================================
// TEST del CICLO DE TOOLS (flag ciclo_tools_v1)  ->  node test-ciclo-tools.js
// ----------------------------------------------------------------------------
// NO levanta el server, NO toca la base y NO gasta un token de IA: extrae el
// bloque del ciclo de server.js y lo evalua aislado, con el modelo simulado.
//
// Cubre exactamente lo que no puede volver a pasar (caso real 2026-07-28, lead
// Alejandro Cabrera / cuenta Anton):
//   (a) que se ejecuten TODAS las herramientas de todas las vueltas;
//   (b) que se devuelva UN tool_result por CADA tool_use (la API responde 400 si
//       falta uno: es el 400 que hoy termina en "dejame buscar y te paso");
//   (c) que el tope duro corte y cierre con TEXTO, nunca con una promesa;
//   (d) que con el flag OFF el camino sea el de hoy (el ciclo ni se llama).
// ============================================================================
var fs = require('fs');
var path = require('path');

var SRC = path.join(__dirname, 'server.js');
var txt = fs.readFileSync(SRC, 'utf8');

var okTotal = 0, falloTotal = 0;
function chequear(nombre, cond, detalle) {
  if (cond) { okTotal++; console.log('  OK   ' + nombre); }
  else { falloTotal++; console.log('  FALLA ' + nombre + (detalle ? ('  -> ' + detalle) : '')); }
}
function j(x) { try { return JSON.stringify(x); } catch (e) { return String(x); } }

// ---------------------------------------------------------------------------
// Aislar el bloque del ciclo (const _CICLO_MAX_VUELTAS + async _correrCicloTools)
// ---------------------------------------------------------------------------
var ini = txt.indexOf('  const _CICLO_MAX_VUELTAS = 3;');
if (ini < 0) { console.error('NO se encontro _CICLO_MAX_VUELTAS en server.js (cambio el anclaje).'); process.exit(1); }
var fin = txt.indexOf('  // PARTE B (punto 6 / regla 19)', ini);
if (fin < 0 || fin <= ini) { console.error('NO se pudo aislar el bloque del ciclo. ini=' + ini + ' fin=' + fin); process.exit(1); }
var BLOQUE = txt.slice(ini, fin);

// Fabrica: evalua el bloque con TODO su entorno (closure) simulado.
var PRELUDIO = [
  'var completion = _ctx.completion;',
  'var mensajesParaIA = _ctx.mensajesParaIA;',
  'var mediaAEnviar = _ctx.mediaAEnviar;',
  'var MODELO_CLIENTE = "modelo-test";',
  'var systemBlocks = [{ type: "text", text: "system" }];',
  'var toolsAgente = [{ name: "buscar_inventario" }, { name: "ficha_inventario" }];',
  'var llamarIAConFailover = _ctx.llamar;',
  'var _toolResultadoCiclo = _ctx.ejecutar;',
  'var _agendarCitaTentativaAgente = _ctx.agendar;',
  'var _derivacionV3On = _ctx.derivOn;',
  'var _iaAgendaOn = _ctx.agendaOn;',
  'var user_id = "tenant-1"; var conversation_id = "conv-1"; var datosLead = { name: "Alejandro" };',
  'var _pidioDerivarV3 = false, _derivarMotivoV3 = null, _derivarDeptoV3 = null, _agendaDerivada = false;'
].join('\n');
var CIERRE = 'return { correr: _correrCicloTools, tope: _CICLO_MAX_VUELTAS, flags: function(){ return { pidioDerivar: _pidioDerivarV3, motivo: _derivarMotivoV3, depto: _derivarDeptoV3, agendaDerivada: _agendaDerivada }; } };';
var fabrica;
try {
  // eslint-disable-next-line no-eval
  fabrica = eval('(function(_ctx){ ' + PRELUDIO + '\n' + BLOQUE + '\n' + CIERRE + ' })');
} catch (e) {
  console.error('El bloque del ciclo no evalua:', e && e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Banco de pruebas: modelo simulado + registro de lo que se ejecuto
// ---------------------------------------------------------------------------
function tu(id, nombre, input) { return { type: 'tool_use', id: id, name: nombre, input: input || {} }; }
function texto(t) { return { type: 'text', text: t }; }
function respuesta(bloques, stop) { return { content: bloques, stop_reason: stop || 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }; }

function banco(opciones) {
  var o = opciones || {};
  var ejecutadas = [];      // nombres de tools realmente ejecutadas, en orden
  var llamadas = [];        // params de cada llamada al modelo
  var guion = (o.guion || []).slice();  // respuestas que va devolviendo el modelo
  var ctx = {
    completion: o.completion,
    mensajesParaIA: [{ role: 'user', content: 'quiero el detalle de los 4 locales' }],
    mediaAEnviar: [],
    derivOn: o.derivOn !== false,
    agendaOn: o.agendaOn !== false,
    ejecutar: async function (nombre, input) {
      ejecutadas.push({ nombre: nombre, input: input });
      if (nombre === 'enviar_foto_propiedad') return { texto: 'OK: foto enviada.', fotoUrl: 'https://x/foto.jpg', fueraHorario: false };
      return { texto: 'RESULTADO de ' + nombre, fotoUrl: null, fueraHorario: false };
    },
    agendar: async function () { return { ok: true, derivada: true, fechaInvalida: false }; },
    llamar: async function (params) {
      llamadas.push(JSON.parse(JSON.stringify({ max_tokens: params.max_tokens, tool_choice: params.tool_choice || null, messages: params.messages })));
      if (o.fallaLlamada) throw new Error('proveedor caido (simulado)');
      var r = guion.shift();
      if (!r) throw new Error('el guion del test se quedo sin respuestas');
      return r;
    }
  };
  var f = fabrica(ctx);
  return { f: f, ctx: ctx, ejecutadas: ejecutadas, llamadas: llamadas };
}

// Verifica la regla dura de la API: en cada llamada, el ULTIMO mensaje de usuario
// tiene que traer UN tool_result por CADA tool_use del mensaje assistant anterior.
function tool_resultsCoinciden(llamada) {
  var m = llamada.messages;
  var ultimo = m[m.length - 1];
  var previo = m[m.length - 2];
  if (!ultimo || ultimo.role !== 'user' || !Array.isArray(ultimo.content)) return 'el ultimo mensaje no es un user con bloques';
  if (!previo || previo.role !== 'assistant' || !Array.isArray(previo.content)) return 'el anteultimo no es el assistant con las tools';
  var idsPedidos = previo.content.filter(function (b) { return b.type === 'tool_use'; }).map(function (b) { return b.id; }).sort();
  var idsDevueltos = ultimo.content.filter(function (b) { return b.type === 'tool_result'; }).map(function (b) { return b.tool_use_id; }).sort();
  if (idsPedidos.length !== idsDevueltos.length) return 'pidio ' + idsPedidos.length + ' tools y se devolvieron ' + idsDevueltos.length + ' tool_result';
  for (var i = 0; i < idsPedidos.length; i++) if (idsPedidos[i] !== idsDevueltos[i]) return 'ids distintos: ' + j(idsPedidos) + ' vs ' + j(idsDevueltos);
  var vacios = ultimo.content.filter(function (b) { return !b.content; }).length;
  if (vacios) return vacios + ' tool_result sin contenido';
  return null;
}

var pendientes = [];
function correr(nombre, fn) { pendientes.push({ nombre: nombre, fn: fn }); }

// ===========================================================================
correr('CASO REAL: buscar -> 4 fichas en paralelo -> texto final', async function () {
  var b = banco({
    completion: respuesta([texto('Dale, te busco locales.'), tu('t1', 'buscar_inventario', { tipo: 'local' })]),
    guion: [
      respuesta([texto('Ahora traigo el detalle.'), tu('t2', 'ficha_inventario', { id: '1' }), tu('t3', 'ficha_inventario', { id: '2' }), tu('t4', 'ficha_inventario', { id: '3' }), tu('t5', 'ficha_inventario', { id: '4' })]),
      respuesta([texto('Local 1: ... Local 2: ... Local 3: ... Local 4: ...')], 'end_turn')
    ]
  });
  var reply = await b.f.correr();
  chequear('se ejecutaron las 5 tools (1 buscar + 4 fichas)', b.ejecutadas.length === 5, j(b.ejecutadas.map(function (x) { return x.nombre; })));
  chequear('las 4 fichas se ejecutaron con los 4 ids', b.ejecutadas.slice(1).map(function (x) { return x.input.id; }).join(',') === '1,2,3,4', j(b.ejecutadas.slice(1).map(function (x) { return x.input.id; })));
  chequear('se hicieron 2 llamadas extra al modelo (3 en total con la inicial)', b.llamadas.length === 2, 'llamadas extra=' + b.llamadas.length);
  var err1 = tool_resultsCoinciden(b.llamadas[0]);
  chequear('vuelta 1: un tool_result por cada tool_use', err1 === null, err1 || '');
  var err2 = tool_resultsCoinciden(b.llamadas[1]);
  chequear('vuelta 2: CUATRO tool_result por los cuatro tool_use (esto es lo que hoy da 400)', err2 === null, err2 || '');
  chequear('la respuesta final es el detalle, NO una promesa', /Local 1/.test(reply) && !/dejame buscar/i.test(reply), j(reply));
  chequear('el usage de las vueltas extra se acumulo', b.ctx.completion.usage.input_tokens === 30, j(b.ctx.completion.usage));
});

// ===========================================================================
correr('TOPE DURO: el modelo pide tools sin parar -> corta y cierra con texto', async function () {
  var b = banco({
    completion: respuesta([tu('a1', 'buscar_inventario', {})]),
    guion: [
      respuesta([tu('a2', 'ficha_inventario', { id: '1' })]),
      respuesta([tu('a3', 'ficha_inventario', { id: '2' })]),
      respuesta([texto('Te paso lo que tengo confirmado de esos locales: ...')], 'end_turn')
    ]
  });
  var reply = await b.f.correr();
  chequear('el tope es 3 vueltas', b.f.tope === 3, 'tope=' + b.f.tope);
  chequear('se hicieron exactamente 3 llamadas extra (4 en total)', b.llamadas.length === 3, 'llamadas extra=' + b.llamadas.length);
  var ult = b.llamadas[2];
  chequear('la ultima llamada va con tool_choice none (no puede pedir otra tool)', ult.tool_choice && ult.tool_choice.type === 'none', j(ult.tool_choice));
  chequear('la ultima llamada sube max_tokens a 800', ult.max_tokens === 800, 'max_tokens=' + ult.max_tokens);
  chequear('las vueltas normales quedan en max_tokens 500 (igual que hoy)', b.llamadas[0].max_tokens === 500 && b.llamadas[1].max_tokens === 500, j([b.llamadas[0].max_tokens, b.llamadas[1].max_tokens]));
  chequear('las vueltas normales NO llevan tool_choice', !b.llamadas[0].tool_choice && !b.llamadas[1].tool_choice, j([b.llamadas[0].tool_choice, b.llamadas[1].tool_choice]));
  chequear('cierra con texto, no con una promesa', /confirmado/.test(reply) && !/dejame/i.test(reply), j(reply));
});

// ===========================================================================
correr('DERIVAR DESPUES DE VER LOS RESULTADOS (vuelta 2): hoy se descarta', async function () {
  var b = banco({
    completion: respuesta([tu('d1', 'buscar_inventario', {})]),
    guion: [
      respuesta([texto('No tengo nada que encaje, te paso con un asesor.'), tu('d2', 'derivar_a_humano', { motivo: 'sin stock', departamento: 'Ventas' })])
    ]
  });
  var reply = await b.f.correr();
  var fl = b.f.flags();
  chequear('quedo marcado el pedido de derivar', fl.pidioDerivar === true, j(fl));
  chequear('se guardo el motivo', fl.motivo === 'sin stock', j(fl.motivo));
  chequear('se guardo el departamento', fl.depto === 'Ventas', j(fl.depto));
  chequear('no se gastó otra llamada al modelo para derivar', b.llamadas.length === 1, 'llamadas extra=' + b.llamadas.length);
  chequear('el reply es el texto que escribio la IA', /te paso con un asesor/i.test(reply), j(reply));
});

// ===========================================================================
correr('DERIVAR EN LA VUELTA 1: se lo deja a la cadena de hoy (null)', async function () {
  var b = banco({
    completion: respuesta([texto('Te paso con alguien.'), tu('e1', 'derivar_a_humano', { motivo: 'pide humano' })]),
    guion: []
  });
  var reply = await b.f.correr();
  chequear('devuelve null -> corre la cadena de hoy, sin cambios', reply === null, j(reply));
  chequear('no ejecuto ninguna tool', b.ejecutadas.length === 0, j(b.ejecutadas));
  chequear('no llamo al modelo', b.llamadas.length === 0, 'llamadas=' + b.llamadas.length);
  chequear('los flags de derivacion NO los toco el ciclo', b.f.flags().pidioDerivar === false, j(b.f.flags()));
});

// ===========================================================================
correr('FALLBACK TOTAL: si el modelo falla en la vuelta 1 -> null (cadena de hoy)', async function () {
  var b = banco({
    completion: respuesta([tu('f1', 'buscar_inventario', {})]),
    guion: [],
    fallaLlamada: true
  });
  var reply = await b.f.correr();
  chequear('devuelve null (nunca peor que hoy)', reply === null, j(reply));
  chequear('mediaAEnviar quedo limpio para que la cadena no duplique fotos', b.ctx.mediaAEnviar.length === 0, j(b.ctx.mediaAEnviar));
});

// ===========================================================================
correr('FOTO dentro del ciclo: se encola el media y sigue el ciclo', async function () {
  var b = banco({
    completion: respuesta([tu('g1', 'enviar_foto_propiedad', { numero: '33606', categoria: 'frente' })]),
    guion: [respuesta([texto('Te mando el frente del local.')], 'end_turn')]
  });
  var reply = await b.f.correr();
  chequear('la foto quedo encolada una sola vez', b.ctx.mediaAEnviar.length === 1, j(b.ctx.mediaAEnviar));
  chequear('el reply es el texto del modelo', /frente del local/.test(reply), j(reply));
});

// ===========================================================================
correr('TOOL DESCONOCIDA: igual se manda un tool_result (nunca se deja colgado)', async function () {
  var b = banco({
    completion: respuesta([tu('h1', 'tool_que_no_existe', {})]),
    guion: [respuesta([texto('Sigo la charla.')], 'end_turn')]
  });
  b.ctx.ejecutar = async function () { return { texto: '', fotoUrl: null, fueraHorario: false }; };
  var b2 = banco({
    completion: respuesta([tu('h1', 'tool_que_no_existe', {})]),
    guion: [respuesta([texto('Sigo la charla.')], 'end_turn')]
  });
  b2.ctx.ejecutar = async function () { return { texto: '', fotoUrl: null, fueraHorario: false }; };
  // rearmar la fabrica con el ejecutar vacio
  var f2 = fabrica(b2.ctx);
  var reply = await f2.correr();
  var err = tool_resultsCoinciden(b2.llamadas[0]);
  chequear('el tool_use desconocido igual recibio su tool_result no vacio', err === null, err || '');
  chequear('el turno cierra con texto', /Sigo la charla/.test(reply), j(reply));
});

// ===========================================================================
// FLAG OFF: verificacion ESTATICA sobre server.js + funcional del helper
// ===========================================================================
correr('FLAG OFF: el ciclo ni se llama y el helper es fail-closed', async function () {
  // 1) el unico call site esta guardado por _cicloToolsOn (la otra aparicion es la declaracion)
  var declara = txt.split('async function _correrCicloTools()').length - 1;
  var llamadas = (txt.split('_correrCicloTools()').length - 1) - declara;
  chequear('se declara una sola vez', declara === 1, 'declaraciones=' + declara);
  chequear('hay UN solo lugar donde se llama al ciclo', llamadas === 1, 'llamadas=' + llamadas);
  var iCall = txt.indexOf('await _correrCicloTools()');
  var contexto = txt.slice(Math.max(0, iCall - 400), iCall);
  chequear('ese call site esta dentro de if (_cicloToolsOn)', /if \(_cicloToolsOn\) \{/.test(contexto), 'contexto sin el guard');
  chequear('_cicloToolsOn arranca en false', txt.indexOf('let _cicloToolsOn = false;') >= 0, 'no se encontro la inicializacion en false');
  chequear('el else del ciclo devuelve el control a la cadena de hoy', txt.indexOf('if (_replyDelCiclo) { reply = _replyDelCiclo; } else {') >= 0, 'no se encontro el else');
  chequear('la cadena de hoy sigue arrancando por derivar_a_humano', txt.indexOf("const _toolDerivar = _derivacionV3On ? (completion.content || []).find(") >= 0, 'cambio la cadena');

  // 2) el helper del flag: fail-closed ante columna ausente / error / bs sin la propiedad
  var iH = txt.indexOf('async function cicloToolsActivo(user_id, bs) {');
  var fH = txt.indexOf('\n}', iH);
  chequear('existe el helper cicloToolsActivo', iH >= 0 && fH > iH, 'iH=' + iH);
  if (iH >= 0 && fH > iH) {
    var srcH = txt.slice(iH, fH + 2);
    var respuestaSupa = { data: null, error: null };
    // eslint-disable-next-line no-eval
    var helper = eval('(function(){ var supabase = { from: function(){ return { select: function(){ return { eq: function(){ return { maybeSingle: async function(){ return respuestaSupa; } }; } }; } }; } }; ' + srcH + ' return cicloToolsActivo; })()');
    var r1 = await helper('u1', { otra_columna: true });           // bs cargado SIN la columna -> consulta -> null
    chequear('bs sin la columna + fila sin dato -> false', r1 === false, j(r1));
    var r2 = await helper('u1', { ciclo_tools_v1: false });
    chequear('columna en false -> false', r2 === false, j(r2));
    var r3 = await helper('u1', { ciclo_tools_v1: null });
    chequear('columna en null -> false', r3 === false, j(r3));
    var r4 = await helper('u1', { ciclo_tools_v1: true });
    chequear('columna en true -> true', r4 === true, j(r4));
    respuestaSupa = { data: null, error: { message: 'column does not exist' } };
    var r5 = await helper('u1', undefined);
    chequear('error de la consulta (columna sin migrar) -> false', r5 === false, j(r5));
    var r6 = await helper(null, undefined);
    chequear('sin user_id -> false', r6 === false, j(r6));
  }
});

// ===========================================================================
(async function () {
  for (var i = 0; i < pendientes.length; i++) {
    console.log('');
    console.log('== ' + pendientes[i].nombre + ' ==');
    try { await pendientes[i].fn(); }
    catch (e) { falloTotal++; console.log('  FALLA (excepcion) -> ' + (e && e.message)); }
  }
  console.log('');
  console.log('================================');
  console.log('OK: ' + okTotal + '   FALLAS: ' + falloTotal);
  console.log('================================');
  process.exit(falloTotal ? 1 : 0);
})();

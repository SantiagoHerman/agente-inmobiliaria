// ============================================================================
// TEST del AVISO de dudas del scraper (correccion D3)  ->  node test-aviso-dudas-scraper.js
// ----------------------------------------------------------------------------
// Diego pidio "chequea muy bien si aparece el aviso y a quien". Esto NO es una lectura de codigo:
// extrae de server.js las funciones REALES de la cadena de aviso (_scrapAvisarDudas -> canal "Todos"
// + _pushDuenoAdmins -> enviarPushAsesor), les enchufa stubs en las hojas (base de datos y envio) y
// registra QUIEN recibiria el aviso y CON QUE TEXTO. No levanta el server, no toca la base, 0 IA.
//
// Lo que este test NO puede probar (hace falta la cuenta real): que el celular del dueno tenga la app
// instalada y un device_token vivo en FCM, y si el tenant tiene prendido el espejo por WhatsApp.
// ============================================================================
var fs = require('fs');
var path = require('path');

var txt = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function trozo(desde, hasta, etiqueta) {
  var a = txt.indexOf(desde), b = txt.indexOf(hasta, a);
  if (a < 0 || b < 0) { console.error('No se pudo aislar ' + etiqueta + ' en server.js'); process.exit(1); }
  return txt.slice(a, b);
}
var srcEsAdmin = trozo('function esAdministrador(ase) {', '// M19: REPARTO EQUITATIVO', 'esAdministrador');
var srcPushDA = trozo('async function _pushDuenoAdmins(ownerId, cuerpo, vistosSeed) {', '// Push DIRIGIDO combinado para eventos de un LEAD', '_pushDuenoAdmins');
var srcAviso = trozo('async function _scrapAvisarDudas(ownerId, cantidad) {', '// ===== MOTOR DE SCRAPING AUTOMATICO', '_scrapAvisarDudas');

var okTotal = 0, falloTotal = 0;
function chequear(nombre, cond, detalle) {
  if (cond) { okTotal++; console.log('  OK   ' + nombre); }
  else { falloTotal++; console.log('  FALLA ' + nombre + (detalle ? ('  -> ' + detalle) : '')); }
}

// --- Escenario configurable: equipo del tenant + quien "firma" los avisos internos ---
async function correrEscenario(opts) {
  var registro = { canal: [], push: [] };
  var OWNER = 'owner-uuid';
  // Stub de supabase: solo responde el select de asesores que usa _pushDuenoAdmins.
  var supabase = {
    from: function () {
      var q = {
        select: function () { return q; },
        eq: function () { return q; },
        then: function (res) { return res({ data: opts.asesores }); }
      };
      return q;
    }
  };
  var FRONTEND_URL = 'https://www.raicescrm.com';
  async function _avisoRemitente(ownerId) { return opts.remitente === 'owner' ? ownerId : 'bot-ia-uuid'; }
  async function _postearAvisoInterno(ownerId, depto, texto, o) { registro.canal.push({ depto: depto, texto: texto, opts: o || {} }); }
  async function enviarPushAsesor(authUserId, titulo, texto, bodyLiteral, meta) {
    registro.push.push({ a: authUserId, titulo: titulo, body: bodyLiteral, meta: meta || null });
  }
  var fn = eval('(async function(){ ' + srcEsAdmin + srcPushDA + srcAviso + ' return _scrapAvisarDudas; })()');
  var _scrapAvisarDudas = await fn;
  await _scrapAvisarDudas(OWNER, 12);
  return registro;
}

(async function () {
  console.log('');
  console.log('== ESCENARIO A: cuenta SIN usuario IA con login (el aviso lo "firma" el dueno) ==');
  var A = await correrEscenario({
    remitente: 'owner',
    asesores: [
      { auth_user_id: 'admin-uuid', rol: 'administrador', visibilidad: null },
      { auth_user_id: 'asesor-uuid', rol: 'asesor', visibilidad: [] },
      { auth_user_id: null, rol: 'asesor', visibilidad: [] }
    ]
  });
  console.log('   canal ->', JSON.stringify(A.canal.map(function (c) { return { depto: c.depto, soloRegistro: c.opts.soloRegistro }; })));
  console.log('   push  ->', JSON.stringify(A.push.map(function (p) { return p.a; })));
  chequear('queda escrito en el canal "Todos" (general)', A.canal.length === 1 && A.canal[0].depto === 'general', JSON.stringify(A.canal));
  chequear('el canal NO dispara el push masivo al equipo (soloRegistro)', A.canal[0] && A.canal[0].opts.soloRegistro === true, JSON.stringify(A.canal[0] && A.canal[0].opts));
  chequear('el texto del canal lleva el link a /automatizacion', /\/automatizacion/.test(A.canal[0].texto), A.canal[0].texto);
  chequear('el texto del canal dice cuantas son (12)', /12 precio/.test(A.canal[0].texto), A.canal[0].texto);
  chequear('le llega push al DUENO', A.push.some(function (p) { return p.a === 'owner-uuid'; }), JSON.stringify(A.push));
  chequear('le llega push al ADMINISTRADOR', A.push.some(function (p) { return p.a === 'admin-uuid'; }), JSON.stringify(A.push));
  chequear('NO le llega al asesor comun (no es admin)', !A.push.some(function (p) { return p.a === 'asesor-uuid'; }), JSON.stringify(A.push));
  chequear('el dueno NO recibe el push duplicado', A.push.filter(function (p) { return p.a === 'owner-uuid'; }).length === 1, JSON.stringify(A.push));
  var bodyMasLargo = A.push.reduce(function (m, p) { return Math.max(m, String(p.body || '').length); }, 0);
  console.log('   texto del push -> "' + A.push[0].body + '" (' + A.push[0].body.length + ' chars)');
  chequear('el push entra entero (el cuerpo se recorta a 120 + "Aviso interno: ")', bodyMasLargo <= 135, 'largo=' + bodyMasLargo);
  chequear('el push dice cuantas son', /12 precio/.test(A.push[0].body), A.push[0].body);

  console.log('');
  console.log('== ESCENARIO B: cuenta CON usuario IA con login (el aviso lo firma el bot) ==');
  var B = await correrEscenario({
    remitente: 'bot',
    asesores: [
      { auth_user_id: 'admin-uuid', rol: null, visibilidad: ['generales'] },
      { auth_user_id: 'asesor-uuid', rol: 'asesor', visibilidad: ['propios'] }
    ]
  });
  console.log('   push  ->', JSON.stringify(B.push.map(function (p) { return p.a; })));
  chequear('le llega push al DUENO', B.push.some(function (p) { return p.a === 'owner-uuid'; }), JSON.stringify(B.push));
  chequear('le llega al admin por visibilidad "generales"', B.push.some(function (p) { return p.a === 'admin-uuid'; }), JSON.stringify(B.push));
  chequear('NO le llega al asesor comun', !B.push.some(function (p) { return p.a === 'asesor-uuid'; }), JSON.stringify(B.push));
  chequear('NO se le manda al usuario IA (bot)', !B.push.some(function (p) { return p.a === 'bot-ia-uuid'; }), JSON.stringify(B.push));

  console.log('');
  console.log('=======================================');
  console.log('  OK: ' + okTotal + '   FALLAS: ' + falloTotal);
  console.log('=======================================');
  process.exit(falloTotal > 0 ? 1 : 0);
})();

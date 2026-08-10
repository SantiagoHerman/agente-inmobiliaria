// ============================================================================================
// chequeo-cuentas-al-dia.js
// Diego, 2026-08-10: "cada nuevo cliente tiene que tener lo ultimo que actualizamos".
//
// QUE RESUELVE: Lozano se creo el 10/08 a las 20:04 con 24 mejoras APAGADAS y con
// derivacion_unificada_v1 en true (el flag que causo el incidente del 7/8). Nadie se dio cuenta
// hasta las 21:20, y por casualidad -- lo encontre armando otra lista, no buscandolo.
//
// POR QUE UN CHEQUEO Y NO UNA REGLA MAS: ya habia memorias que decian exactamente lo que habia que
// hacer y no alcanzaron. Una regla depende de que alguien se acuerde; esto se corre en 5 segundos y
// contesta con un numero.
//
// COMO SE CORRE:   node chequeo-cuentas-al-dia.js
// SOLO LEE. No escribe nada, no toca ninguna fila.
//
// LA REFERENCIA son los CLIENTES REALES, no las cuentas de prueba (Diego 2026-08-10: "Anton
// Galdames y Lozano son clientes, Raices CRM es mi cuenta extra para atender clientes por la app,
// el resto es prueba"). Se compara contra los flags donde los clientes reales COINCIDEN: si dos
// clientes que funcionan tienen algo igual, una cuenta nueva deberia tenerlo igual.
// ============================================================================================

const fs = require('fs');
fs.readFileSync('.env', 'utf8').split('\n').forEach(function (l) {
  const i = l.indexOf('=');
  if (i > 0) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
if (!U || !K) { console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en .env'); process.exit(1); }

// Clientes de referencia. Si maniana entra un cliente nuevo que ya esta al dia, se puede sumar aca.
const REFERENCIA = ['Anton Bienes Raices', 'Andres Galdames'];
// Cuentas que quedan AFUERA del chequeo, con el motivo:
//   Raices Meta Test -> congelada + es la UNICA conectada a Messenger/Instagram/WhatsApp API
//                       (ahi vive el acceso a Meta), asi que sus flags son a proposito distintos.
const AFUERA = ['Raices Meta Test'];
// Preferencias del cliente, NO mejoras: es legitimo que difieran por cuenta. No se reportan.
//
// OJO -- ESTA LISTA ES LO QUE HACE QUE EL CHEQUEO SIRVA. La primera corrida reporto 18 flags
// "atrasados" y 6 eran falsos positivos: `recontacto_pausado` (una pausa que alguien puso a
// proposito), `ia_disponibilidad` (solo aplica a hotel) y `memoria_backfill_v1` (un relleno de una
// sola vez). Un chequeo que grita de mas se deja de mirar, y ahi vuelve a pasar lo de Lozano.
// Si aparece un flag nuevo aca: antes de sumarlo, chequear que sea de verdad una PREFERENCIA y no
// una mejora que alguien se olvido de prender.
const PREFERENCIAS = ['crm_pausado', 'congelada', 'cloud_api_v1', 'agente_pausado', 'eliminado_at',
  'ia_agenda', 'derivacion_avisar_equipo', 'memoria_backfill_v1', 'grupo_todos_wa_on',
  'recontacto_pausado', 'agente_premium_re'];
// Flags que dependen del RUBRO: comparar una inmobiliaria contra un hotel no dice nada.
const POR_RUBRO = ['ia_disponibilidad', 'reservas_v1', 'inventario_desarrollo_on'];

(async function () {
  const r = await fetch(U + '/rest/v1/business_settings?select=*', { headers: { apikey: K, Authorization: 'Bearer ' + K } });
  const filas = await r.json();
  if (!Array.isArray(filas)) { console.error('Error leyendo business_settings: ' + JSON.stringify(filas).slice(0, 200)); process.exit(1); }

  const porNombre = {};
  filas.forEach(function (b) { if (b.company_name) porNombre[b.company_name] = b; });
  const refs = REFERENCIA.map(function (n) { return porNombre[n]; }).filter(Boolean);
  if (refs.length < 2) { console.error('No encontre las cuentas de referencia: ' + REFERENCIA.join(', ')); process.exit(1); }

  // Flags donde TODAS las cuentas de referencia coinciden (y son booleanos en todas).
  const candidatos = Object.keys(refs[0]).filter(function (k) {
    if (PREFERENCIAS.indexOf(k) >= 0) return false;
    if (POR_RUBRO.indexOf(k) >= 0) return false;
    if (!refs.every(function (b) { return typeof b[k] === 'boolean'; })) return false;
    return refs.every(function (b) { return b[k] === refs[0][k]; });
  });

  const aRevisar = Object.keys(porNombre).filter(function (n) {
    return AFUERA.indexOf(n) < 0 && REFERENCIA.indexOf(n) < 0;
  }).sort();

  console.log('CHEQUEO DE CUENTAS AL DIA  -- ' + new Date().toISOString());
  console.log('Referencia: ' + REFERENCIA.join(' + ') + '   (' + candidatos.length + ' flags donde coinciden)');
  console.log('Afuera: ' + AFUERA.join(', ') + '   |   preferencias no chequeadas: ' + PREFERENCIAS.length);
  console.log('');

  let totalAtraso = 0;
  aRevisar.forEach(function (n) {
    const b = porNombre[n];
    const faltan = candidatos.filter(function (f) { return b[f] !== refs[0][f]; });
    totalAtraso += faltan.length;
    if (!faltan.length) { console.log('  OK    ' + n); return; }
    console.log('  ATRAS ' + n + '  -> ' + faltan.length + ' flags');
    faltan.forEach(function (f) {
      console.log('           ' + f.padEnd(30) + ' tiene=' + String(b[f]).padEnd(6) + ' deberia=' + refs[0][f]);
    });
  });

  console.log('');
  if (totalAtraso === 0) {
    console.log('=> TODO AL DIA. Ninguna cuenta esta atras de los clientes reales.');
  } else {
    console.log('=> ' + totalAtraso + ' flags atrasados en total. Cada linea de arriba es una funcion que ese');
    console.log('   cliente NO tiene y los clientes que funcionan si.');
  }

  // Aviso de cuentas recien creadas: es la ventana donde aparece el problema.
  const nuevas = filas.filter(function (b) {
    return b.company_name && b.created_at && (Date.now() - new Date(b.created_at).getTime()) < 7 * 86400e3;
  });
  if (nuevas.length) {
    console.log('');
    console.log('CUENTAS CREADAS EN LOS ULTIMOS 7 DIAS (revisar estas primero):');
    nuevas.forEach(function (b) {
      const h = Math.round((Date.now() - new Date(b.created_at).getTime()) / 3600e3);
      console.log('   ' + b.company_name.padEnd(24) + ' hace ' + h + ' h   rubro=' + b.rubro);
    });
  }

  // El valor de NACIMIENTO de las columnas no se puede leer por la API REST (information_schema no
  // esta expuesto). Para chequearlo hay que correr esto en el editor SQL de Supabase:
  console.log('');
  console.log('--- Para chequear con QUE VALOR NACE cada flag (esto va en el editor SQL, no por API):');
  console.log("    SELECT coalesce(column_default,'(sin default)') AS nace, count(*),");
  console.log("           string_agg(column_name, ', ' ORDER BY column_name)");
  console.log("      FROM information_schema.columns");
  console.log("     WHERE table_schema='public' AND table_name='business_settings' AND data_type='boolean'");
  console.log('     GROUP BY 1 ORDER BY 2 DESC;');
  console.log('    Una MEJORA que nazca en false es un caso Lozano esperando a pasar.');
})();

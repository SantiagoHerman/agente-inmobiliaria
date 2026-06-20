// Raices CRM - Backend del Agente IA + Webhook WhatsApp
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  // Lista blanca de origenes permitidos (solo la app de Raices CRM)
  const ORIGENES_PERMITIDOS = [
    'https://raices-crm.vercel.app',
    'https://www.raicescrm.com',
    'https://raicescrm.com',
    'http://localhost:3000'
  ];
  const origin = req.headers.origin;
  // Peticiones sin origin (server-to-server, ej webhook de Evolution) pasan sin restriccion CORS
  if (origin && ORIGENES_PERMITIDOS.indexOf(origin) !== -1) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, apikey, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// === SEGURIDAD: rate limiting casero en memoria (sin dependencias) ===
// Limite generoso: protege de abuso/ataques sin molestar el uso normal.
// El webhook de Evolution queda EXENTO (puede mandar muchos mensajes legitimos).
const _rlHits = new Map();
const _RL_VENTANA_MS = 60 * 1000;
const _RL_MAX = 200;

// === DEBOUNCE POR CONVERSACION (FIX bug doble-presentacion) ===
// Cuando un lead manda 2+ mensajes seguidos rapidos, llegan webhooks concurrentes y la IA
// respondia/se presentaba 2 veces. Solucion (sin migracion, instancia unica): por cada conv.id
// agrupamos la rafaga. Cada mensaje entrante SE GUARDA igual (no se pierde nada); solo la
// GENERACION de respuesta se debouncea: el ultimo mensaje reinicia un timer, y al vencer
// DEBOUNCE_MS se genera UNA sola respuesta que re-lee TODO el historial (contempla la rafaga).
// _genEnCurso evita que dos disparos solapados generen dos respuestas para la misma conv.
const _debounceConv = new Map(); // conv.id -> timeout handle
const _genEnCurso = new Set();   // conv.id en generacion ahora mismo
const DEBOUNCE_MS = 6000;
setInterval(() => { _rlHits.clear(); }, _RL_VENTANA_MS);
app.use((req, res, next) => {
  try {
    // el webhook de WhatsApp no se limita
    if (req.path === '/api/webhook/whatsapp') return next();
    if (req.path === '/api/webhook/mercadopago') return next();
    if (req.path === '/health') return next();
    const ip = (req.headers['x-forwarded-for'] || req.ip || 'sin-ip').split(',')[0].trim();
    const n = (_rlHits.get(ip) || 0) + 1;
    _rlHits.set(ip, n);
    if (n > _RL_MAX) return res.status(429).json({ error: 'Demasiadas peticiones, intenta en un momento' });
    next();
  } catch (e) { next(); }
});

const PORT = process.env.PORT || 3001;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY || '' });
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_KEY || '');

// === Notificaciones push (FCM) via firebase-admin ===
// Se inicializa SOLO si hay credenciales (env FIREBASE_SERVICE_ACCOUNT = JSON del service account).
// Si no esta configurado, enviarPushAsesor no hace nada (no rompe el flujo de mensajes).
let _fcmReady = false;
let _fcmAdmin = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    _fcmAdmin = require('firebase-admin');
    if (!_fcmAdmin.apps.length) {
      _fcmAdmin.initializeApp({ credential: _fcmAdmin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    _fcmReady = true;
    console.log('FCM listo (firebase-admin inicializado)');
  } else {
    console.log('FCM no configurado (sin FIREBASE_SERVICE_ACCOUNT)');
  }
} catch (e) { console.error('Error init firebase-admin:', e && e.message); }

// Envia un push al/los dispositivo(s) del asesor (identificado por su auth_user_id).
async function enviarPushAsesor(authUserId, leadNombre, texto, bodyLiteral) {
  try {
    if (!_fcmReady || !authUserId) return;
    const { data: toks } = await supabase.from('device_tokens').select('token').eq('user_id', authUserId);
    if (!toks || !toks.length) return;
    const tokens = toks.map(function (t) { return t.token; }).filter(Boolean);
    if (!tokens.length) return;
    const palabras = String(texto || '').trim().split(/\s+/).slice(0, 3).join(' ');
    // bodyLiteral: para avisos que NO son un mensaje de lead (ej. cupo IA al 80/100%), se respeta el cuerpo tal cual.
    const _body = bodyLiteral ? String(bodyLiteral) : ('Nuevo mensaje · ' + palabras);
    const resp = await _fcmAdmin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: { title: leadNombre || 'Nuevo lead', body: _body },
      android: { priority: 'high', notification: { channelId: 'mensajes', sound: 'default', priority: 'high' } }
    });
    // Limpiar tokens invalidos (desinstalados / expirados)
    if (resp && resp.responses) {
      for (let i = 0; i < resp.responses.length; i++) {
        const r = resp.responses[i];
        const code = (r && r.error && r.error.code) || '';
        if (!r.success && /not-registered|invalid-registration-token|invalid-argument/.test(code)) {
          try { await supabase.from('device_tokens').delete().eq('token', tokens[i]); } catch (eDel) {}
        }
      }
    }
  } catch (e) { console.error('Error enviarPushAsesor:', e && e.message); }
}

// === SEGURIDAD: verificacion de identidad por token JWT de Supabase ===
// Lee el token del header Authorization, lo valida contra Supabase y
// devuelve el user_id REAL del token (o null si no hay token valido).
// Capa 1: definido pero todavia NO aplicado a los endpoints.
async function verificarUsuario(req) {
  try {
    const auth = req.headers.authorization || req.headers.Authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return null;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user.id;
  } catch (e) {
    return null;
  }
}
const EVOLUTION_URL = process.env.EVOLUTION_URL || '';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';

const TONO = {
  formal: 'Usa un tono formal y profesional, tratando de usted.',
  cercano: 'Usa un tono cercano, amable y profesional. Equilibrado.',
  relajado: 'Usa un tono relajado y cotidiano, con voseo argentino (vos, tenes, queres). Natural y cercano.'
};
const AUTONOMIA = {
  conservador: 'Solo responde con informacion confirmada en la base de conocimiento. Si no sabes algo, deci que lo vas a consultar. Nunca inventes datos.',
  equilibrado: 'Orienta al cliente con la info disponible, pero aclara lo que debe confirmarse con un humano. No inventes datos.',
  comercial: 'Avanza hacia la conversion ofreciendo opciones y proximos pasos, pero sin inventar datos que no esten en la base de conocimiento.'
};
const OBJETIVO = {
  informar: 'Tu objetivo es responder consultas e informar. Para cualquier avance concreto (visita, reserva, sena), deriva a un asesor humano.',
  agendar_visita: 'Tu objetivo es informar y coordinar una visita o cita a la propiedad. Tomas el interes y los datos para la visita, y deriva a un asesor humano para confirmarla.',
  avanzar_reserva: 'Tu objetivo es avanzar hacia una reserva o sena: tomas el interes concreto y los datos necesarios, y deriva a un asesor humano para cerrar y cobrar.',
  precalificar: 'Tu objetivo es pre-calificar al cliente recopilando sus datos (presupuesto, requisitos, garantia) antes de derivar a un asesor humano.',
  ver_disponibilidad: 'Tu objetivo es informar disponibilidad y precios y ofrecer opciones de fechas. Para concretar la reserva, deriva a un asesor humano.',
  avanzar_reserva_hotel: 'Tu objetivo es tomar los datos de la reserva (fechas, cantidad de personas) y deriva a un asesor humano para confirmar y cobrar.'
};
const LARGO = {
  corto: 'Responde breve y simple, en pocas frases, como en un chat de WhatsApp real.',
  normal: 'Responde con un largo equilibrado, ni muy corto ni muy extenso.',
  detallado: 'Podes dar respuestas mas completas y detalladas cuando ayude.'
};

// ============ SUSCRIPCIONES Y PLANES (MercadoPago) — FASE 1 ============
// Definido pero INERTE (patron "Capa 1"): el gating real se activa con
// SUBSCRIPTIONS_ENABLED=true y requiere la tabla public.subscriptions.
// Mientras este apagado, TODO se permite => no afecta a los tenants actuales.
const SUBSCRIPTIONS_ENABLED = String(process.env.SUBSCRIPTIONS_ENABLED || '').toLowerCase() === 'true';
// Fecha ISO de corte: los clientes creados DESDE aca deben suscribirse; los anteriores quedan grandfathered (gratis). Vacio = nadie obligado.
const TRIAL_DESDE = process.env.TRIAL_DESDE || '';
const MP_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
const MP_BASE = 'https://api.mercadopago.com';
// IDs globales de los planes en MercadoPago (creados 2026-06-16). Son del SaaS, compartidos por todos los tenants.
// enterprise: su id se carga en la env MP_PLAN_ENTERPRISE de Railway (mismo patron; se crea una vez via /api/maestro/mp-crear-plan-enterprise).
const PLANES_MP = { basico: 'a1792acbe2b14721885c3d1b9cb2a867', pro: 'a91c0a95c26f499fb55d9b71ac888b39', premium: 'a320490c4aca402c92e8fa4d12347af7', enterprise: process.env.MP_PLAN_ENTERPRISE || '' };

// Topes y features por nivel. (Los precios viven en MercadoPago, no aca.)
const PLAN_LIMITS = {
  trial:      { ai_messages: 200,   asesores: 5,        contactos: 1000,     reportes_ia: true,  audio_traduccion: true,  backup_drive: false, multi_whatsapp: false },
  basico:     { ai_messages: 700,   asesores: 2,        contactos: 500,      reportes_ia: false, audio_traduccion: false, backup_drive: false, multi_whatsapp: false },
  pro:        { ai_messages: 1700,  asesores: 5,        contactos: 3000,     reportes_ia: true,  audio_traduccion: true,  backup_drive: false, multi_whatsapp: false },
  premium:    { ai_messages: 4500,  asesores: Infinity, contactos: Infinity, reportes_ia: true,  audio_traduccion: true,  backup_drive: true,  multi_whatsapp: true },
  enterprise: { ai_messages: 7000,  asesores: Infinity, contactos: Infinity, reportes_ia: true,  audio_traduccion: true,  backup_drive: true,  multi_whatsapp: true }
};
// TOPES VIEJOS (grandfathering). Los clientes creados ANTES de PLANES_NUEVOS_DESDE conservan estos topes de mensajes
// (no se les recorta a mitad de camino); los clientes NUEVOS arrancan con los topes nuevos de arriba (mas bajos, para
// blindar el margen ~70% aun a uso pleno). Solo difiere ai_messages; las features son las mismas que en PLAN_LIMITS.
const PLAN_LIMITS_LEGACY = { trial: 200, basico: 1000, pro: 4000, premium: 12000, enterprise: 20000 };
// Fecha de corte del nuevo esquema de planes (margen maximo). Configurable por env; default = el dia del cambio.
const PLANES_NUEVOS_DESDE = process.env.PLANES_NUEVOS_DESDE || '2026-06-19T00:00:00.000Z';
// Plan por defecto cuando la funcion esta apagada o el tenant no tiene fila: acceso total.
const PLAN_DEFECTO = 'premium';

// Tope de mensajes EFECTIVO de un plan, segun si el cliente es viejo (grandfathered -> tope legacy) o nuevo (tope nuevo).
// Usa sub.created_at (ya disponible, sin costo extra). Sin fecha confiable o creado antes del corte -> legacy (no recortar).
function topeMensajesPlan(plan, sub) {
  var nuevo = (PLAN_LIMITS[plan] || PLAN_LIMITS[PLAN_DEFECTO]).ai_messages;
  var legacy = PLAN_LIMITS_LEGACY[plan];
  if (legacy == null) return nuevo;
  var corte = new Date(PLANES_NUEVOS_DESDE).getTime();
  var ca = (sub && sub.created_at) ? new Date(sub.created_at).getTime() : null;
  if (ca == null || ca < corte) return legacy; // grandfathered
  return nuevo;
}

// Lee la suscripcion del tenant. Si la tabla no existe o no hay fila, devuelve null (no rompe).
async function getSubscription(user_id) {
  try {
    if (!user_id) return null;
    const { data, error } = await supabase.from('subscriptions').select('*').eq('user_id', user_id).maybeSingle();
    if (error) return null;
    return data || null;
  } catch (e) { return null; }
}

// Plan vigente del tenant (considera estado y vencimiento). DEFAULT-OPEN si la funcion esta apagada.
async function planActual(user_id) {
  if (!SUBSCRIPTIONS_ENABLED) return PLAN_DEFECTO;
  const sub = await getSubscription(user_id);
  if (!sub) return PLAN_DEFECTO; // sin fila todavia: no bloquear
  if (sub.cortesia === true) return PLAN_DEFECTO; // cortesia: acceso libre con features plenas
  const activo = (sub.status === 'active' || sub.status === 'trial');
  const vigente = !sub.current_period_end || new Date(sub.current_period_end).getTime() >= Date.now();
  if (!activo || !vigente) return 'basico'; // suscripcion caida: cae al minimo, no corta del todo
  return PLAN_LIMITS[sub.plan] ? sub.plan : PLAN_DEFECTO;
}

// True si el plan del tenant habilita una feature (reportes_ia, audio_traduccion, backup_drive, multi_whatsapp).
async function planPermite(user_id, feature) {
  if (!SUBSCRIPTIONS_ENABLED) return true;
  const plan = await planActual(user_id);
  const lim = PLAN_LIMITS[plan] || PLAN_LIMITS[PLAN_DEFECTO];
  return !!lim[feature];
}

// Mensajes IA consumidos en el periodo actual (0 si no hay fila).
async function usoMensajesIA(user_id) {
  const sub = await getSubscription(user_id);
  return (sub && typeof sub.ai_messages_this_period === 'number') ? sub.ai_messages_this_period : 0;
}

// True si el tenant sigue dentro del tope de mensajes IA de su plan.
async function dentroDelTopeIA(user_id) {
  if (!SUBSCRIPTIONS_ENABLED) return true;
  const sub = await getSubscription(user_id);
  const plan = await planActual(user_id);
  let tope = topeMensajesPlan(plan, sub); // grandfathering: clientes viejos conservan el tope legacy
  if (sub && sub.limits_override && typeof sub.limits_override.ai_messages === 'number') tope = sub.limits_override.ai_messages; // override por cliente (panel maestro)
  else if (sub && typeof sub.ai_messages_limit_override === 'number') tope = sub.ai_messages_limit_override; // compat override viejo
  if (tope === Infinity) return true;
  const usado = (sub && typeof sub.ai_messages_this_period === 'number') ? sub.ai_messages_this_period : 0;
  return usado < tope;
}

// Senal AUTORITATIVA de corte por falta de pago. Replica EXACTAMENTE el gate del
// webhook (~1271-1294) + planActual + cortesia + grandfathered, SIN alterarlo: solo
// computa lo mismo de forma reusable. FAIL-OPEN: ante cualquier error o duda -> false.
// TRUE solo cuando: SUBSCRIPTIONS_ENABLED esta activo Y el tenant NO es cortesia Y NO es
// grandfathered Y debe pagar y no lo hizo (status en {cancelled, suspended}
// O no tiene fila de suscripcion y su cuenta es posterior a TRIAL_DESDE).
// En CUALQUIER otro caso (flag apagado, cortesia, grandfathered, trial, active, sin certeza) -> false.
async function debeBloquearAcceso(user_id) {
  try {
    // PAPELERA (aditivo, independiente de las suscripciones): si el cliente fue eliminado
    // (business_settings.eliminado_at NOT NULL) no puede usar la app, este la funcion de
    // suscripciones encendida o no. Degrada bien si la columna aun no existe (select falla -> no bloquea por esto).
    try {
      const elim = await supabase.from('business_settings').select('eliminado_at').eq('user_id', user_id).maybeSingle();
      if (elim && !elim.error && elim.data && elim.data.eliminado_at) return true;
    } catch (eElim) {}
    if (!SUBSCRIPTIONS_ENABLED) return false; // funcion apagada: no se corta a nadie
    const sub = await getSubscription(user_id);
    const est = sub ? sub.status : null;
    const cortesia = sub && sub.cortesia === true;
    if (cortesia) return false; // cortesia: acceso libre, nunca se bloquea
    // Sin fila de suscripcion: solo se bloquea si la cuenta es NUEVA (creada DESDE TRIAL_DESDE).
    // Los anteriores quedan grandfathered (gratis) -> NO se bloquean. (mismo criterio que el webhook ~1277-1284)
    if (!sub) {
      if (!TRIAL_DESDE) return false; // nadie obligado a suscribirse
      try {
        const u = await supabase.auth.admin.getUserById(user_id);
        const ca = u && u.data && u.data.user && u.data.user.created_at;
        // grandfathered (created_at < TRIAL_DESDE) o sin certeza de la fecha -> NO bloquear (fail-open)
        if (ca && new Date(ca).getTime() >= new Date(TRIAL_DESDE).getTime()) return true;
        return false;
      } catch (eC) { return false; } // sin certeza -> no bloquear
    }
    // Con fila de suscripcion: bloquear SOLO si esta cancelled/suspended (EXACTO como el gate del agente,
    // webhook ~1285). NO se bloquea past_due: el agente sigue atendiendo durante la gracia de 1 dia, y el
    // cron revisarSuscripciones pasa past_due -> suspended tras esa gracia (recien ahi se bloquea aca).
    if (est === 'cancelled' || est === 'suspended') return true;
    // TRIAL = SIN ACCESO. MercadoPago NUNCA usa el estado "trial": una suscripcion autorizada (aun en su
    // periodo de prueba con tarjeta) queda 'authorized' -> la mapeamos a 'active'. Por eso status 'trial' en
    // nuestra base SOLO puede venir de: (a) el trial automatico del registro (sin tarjeta), o (b) una preapproval
    // 'pending'/abandonada (el webhook mapea todo lo no-authorized/paused/cancelled a 'trial', y le pone
    // mp_preapproval_id aunque NO este autorizada). Ninguno es un suscriptor real -> se bloquea SIEMPRE.
    // Asi un usuario recien registrado queda bloqueado (solo Suscripcion/Ayuda/Soporte/Salir) hasta que MP
    // confirme la suscripcion (authorized -> active). Tambien mata el bypass del boton Dashboard al volver atras.
    if (est === 'trial') return true;
    return false; // active, past_due (en gracia), o estado desconocido -> no bloquear
  } catch (e) { return false; } // ante cualquier error -> fail-open (no cortar el servicio)
}

// Suma 1 al contador de mensajes IA del periodo (best-effort, no rompe si falla).
async function registrarUsoIA(user_id) {
  try {
    if (!SUBSCRIPTIONS_ENABLED || !user_id) return;
    const sub = await getSubscription(user_id);
    if (!sub) return;
    const usadoAntes = (typeof sub.ai_messages_this_period === 'number') ? sub.ai_messages_this_period : 0;
    const nuevo = usadoAntes + 1;
    await supabase.from('subscriptions').update({ ai_messages_this_period: nuevo }).eq('user_id', user_id);
    // AVISO al dueno al CRUZAR el 80% y el 100% del tope. Deteccion por CRUCE (usadoAntes<umbral && nuevo>=umbral):
    // dispara una sola vez por umbral y por periodo, SIN columnas/migracion (al resetear el contador mensual, vuelve
    // a cruzar el mes que viene). El push es FCM al dueno -> NO gasta tokens de IA.
    try {
      if (sub.cortesia !== true) {
        const planN = await planActual(user_id); // mismo criterio que dentroDelTopeIA (degrada a basico si la sub no esta vigente)
        let tope = topeMensajesPlan(planN, sub);
        if (sub.limits_override && typeof sub.limits_override.ai_messages === 'number') tope = sub.limits_override.ai_messages;
        else if (typeof sub.ai_messages_limit_override === 'number') tope = sub.ai_messages_limit_override;
        if (tope && tope !== Infinity && tope > 0) {
          const p80 = Math.floor(tope * 0.8);
          if (usadoAntes < tope && nuevo >= tope) {
            await enviarPushAsesor(user_id, 'Se agoto tu cupo de mensajes IA', '', 'El agente dejo de responder automaticamente este mes. Podes mejorar tu plan para reactivarlo o esperar al proximo periodo.');
          } else if (usadoAntes < p80 && nuevo >= p80) {
            await enviarPushAsesor(user_id, 'Cupo de mensajes IA al 80%', '', 'Usaste el 80% de tus mensajes IA del mes. Cuando se agote, el agente deja de responder hasta el proximo periodo o un upgrade.');
          }
        }
      }
    } catch (eAviso) {}
  } catch (e) {}
}

// Precio de Sonnet 4.6 en USD por 1M de tokens (input / output / cache read / cache write).
const PRECIO_IA = { in: 3, out: 15, cache_read: 0.30, cache_write: 3.75 };
// Registra el uso real de tokens de una respuesta de la IA y su costo en USD (best-effort, no rompe).
async function registrarUsoTokens(user_id, usage) {
  try {
    if (!user_id || !usage) return;
    const i = usage.input_tokens || 0;
    const o = usage.output_tokens || 0;
    const cr = usage.cache_read_input_tokens || 0;
    const cw = usage.cache_creation_input_tokens || 0;
    const costo = (i * PRECIO_IA.in + o * PRECIO_IA.out + cr * PRECIO_IA.cache_read + cw * PRECIO_IA.cache_write) / 1000000;
    await supabase.from('ia_uso').insert({ user_id: user_id, input_tokens: i, output_tokens: o, cache_read: cr, cache_creation: cw, cost_usd: costo });
  } catch (e) {}
}

// Crea una notificacion en el Panel Maestro (best-effort y SILENCIOSO). CRITICO: todo va dentro de un try/catch
// que TRAGA cualquier error (tabla inexistente, fallo de red, etc.) para NO romper NUNCA al que lo llama.
// tipo: nuevo_cliente|suscripcion_nueva|suscripcion_cambio|suscripcion_cancelada|soporte|consumo_anomalo|ia_sin_saldo|sistema
// opts: { ref_user_id, ref_id, severidad } (severidad: info|warning|critico; default 'info').
async function crearNotifMaestro(tipo, titulo, cuerpo, opts) {
  try {
    var o = opts || {};
    var fila = {
      tipo: String(tipo || 'sistema'),
      titulo: String(titulo || ''),
      cuerpo: cuerpo != null ? String(cuerpo) : null,
      ref_user_id: o.ref_user_id || null,
      ref_id: o.ref_id != null ? String(o.ref_id) : null,
      severidad: o.severidad || 'info'
    };
    await supabase.from('maestro_notificaciones').insert(fila);
    // Push FCM al celular del Maestro (best-effort, fire-and-forget): asi las notifs llegan al telefono.
    enviarPushMaestro(fila.titulo, (fila.cuerpo || '').slice(0, 180)).catch(function(){});
  } catch (e) {}
}

// Push FCM a TODOS los dispositivos del Maestro (la app del dueno, tabla maestro_device_tokens). Best-effort.
async function enviarPushMaestro(titulo, cuerpo) {
  try {
    if (!_fcmReady) return;
    var q = await supabase.from('maestro_device_tokens').select('token');
    var toks = (q && q.data) || [];
    var tokens = toks.map(function(t){ return t.token; }).filter(Boolean);
    if (!tokens.length) return;
    var resp = await _fcmAdmin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: { title: String(titulo || 'Raices Maestro'), body: String(cuerpo || '') },
      android: { priority: 'high' }
    });
    if (resp && resp.responses) {
      for (var i = 0; i < resp.responses.length; i++) {
        var r = resp.responses[i];
        var code = (r && r.error && r.error.code) || '';
        if (!r.success && /not-registered|invalid-registration-token|invalid-argument/.test(code)) {
          try { await supabase.from('maestro_device_tokens').delete().eq('token', tokens[i]); } catch (eDel) {}
        }
      }
    }
  } catch (e) { console.error('enviarPushMaestro:', e && e.message); }
}

// Detecta si un error de anthropic.messages.create es por SALDO agotado/insuficiente y, si lo es, crea una
// notif 'ia_sin_saldo' (critico) con DEDUPE de 6h (no mas de 1 cada 6 horas). Best-effort: jamas relanza.
async function avisarSiIaSinSaldo(err) {
  try {
    var msg = String((err && err.message) || err || '').toLowerCase();
    var status = err && (err.status || err.statusCode);
    var esSaldo = msg.indexOf('credit balance') >= 0 || msg.indexOf('too low') >= 0 ||
                  (msg.indexOf('balance') >= 0 && (msg.indexOf('insufficient') >= 0 || status === 400));
    if (!esSaldo) return;
    // DEDUPE: no crear si ya hay una ia_sin_saldo en las ultimas 6h
    try {
      var desde6h = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      var ya = await supabase.from('maestro_notificaciones').select('id').eq('tipo', 'ia_sin_saldo').gte('created_at', desde6h).limit(1);
      if (ya && ya.data && ya.data.length) return;
    } catch (eDup) { /* si la consulta falla, igual avisamos (mejor avisar de mas que callar un corte de IA) */ }
    crearNotifMaestro('ia_sin_saldo', 'La IA dejo de responder', 'Saldo de Anthropic agotado o insuficiente. Recarga creditos.', { severidad: 'critico' }).catch(function(){});
  } catch (e) {}
}

// ---- MercadoPago via REST (sin SDK, sin dependencias nuevas; fetch es global en Node 18+) ----
async function mpFetch(path, metodo, cuerpo) {
  if (!MP_TOKEN) throw new Error('MercadoPago no configurado (falta MERCADOPAGO_ACCESS_TOKEN)');
  const r = await fetch(MP_BASE + path, {
    method: metodo || 'GET',
    headers: { 'Authorization': 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const txt = await r.text();
  let json = null; try { json = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (!r.ok) throw new Error('MP ' + r.status + ': ' + String((json && json.message) ? json.message : txt).slice(0, 200));
  return json;
}

// Crea un plan de suscripcion en MP (uno por nivel). Devuelve el preapproval_plan (con .id).
async function mpCrearPlan(nombre, montoARS, backUrl) {
  const body = {
    reason: nombre,
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: montoARS, currency_id: 'ARS', free_trial: { frequency: 4, frequency_type: 'days' } },
    back_url: backUrl,
    payment_methods_allowed: { payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }] }
  };
  return await mpFetch('/preapproval_plan', 'POST', body);
}

// Crea una suscripcion (preapproval). Devuelve el objeto con init_point (checkout de MP).
// IMPORTANTE: el flujo "con preapproval_plan_id + payer_email" via API exige card_token_id (MP400).
// Para obtener el init_point (checkout donde el cliente carga la tarjeta en MP) SIN exigir tarjeta,
// creamos la preapproval SIN plan, con status:'pending', copiando precio/frecuencia/prueba del plan
// (que leemos de MP, donde viven los precios). Conserva external_reference para mapear al usuario.
async function mpCrearSuscripcion(planId, payerEmail, externalRef, backUrl) {
  var ar = {};
  try {
    var plan = await mpFetch('/preapproval_plan/' + planId, 'GET', null);
    ar = (plan && plan.auto_recurring) ? plan.auto_recurring : {};
  } catch (e) { ar = {}; }
  var autoRecurring = {
    frequency: ar.frequency || 1,
    frequency_type: ar.frequency_type || 'months',
    transaction_amount: ar.transaction_amount,
    currency_id: ar.currency_id || 'ARS'
  };
  if (ar.free_trial) autoRecurring.free_trial = ar.free_trial;
  var body = {
    reason: (typeof plan !== 'undefined' && plan && plan.reason) ? plan.reason : 'Suscripcion Raices CRM',
    external_reference: externalRef,
    payer_email: payerEmail,
    back_url: backUrl,
    status: 'pending',
    auto_recurring: autoRecurring
  };
  return await mpFetch('/preapproval', 'POST', body);
}

// Consulta el estado de una suscripcion por id.
async function mpConsultarSuscripcion(preapprovalId) {
  return await mpFetch('/preapproval/' + preapprovalId, 'GET', null);
}

// ============ FUNCION REUTILIZABLE: genera la respuesta del agente ============
async function guardarMensajeSaliente(remoteJid, texto) {
  try {
    if (!texto) return;
    const telefono = remoteJid.split('@')[0];
    const { data: contacto } = await supabase.from('contacts').select('id, user_id').eq('phone', telefono).maybeSingle();
    if (!contacto) return;
    const { data: conv } = await supabase.from('conversations').select('id, user_id').eq('contact_id', contacto.id).maybeSingle();
    if (!conv) return;
    const hace2min = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: reciente } = await supabase.from('messages').select('id').eq('conversation_id', conv.id).eq('content', texto).gte('created_at', hace2min).limit(1).maybeSingle();
    if (reciente) return;
    await supabase.from('messages').insert({ conversation_id: conv.id, user_id: conv.user_id, role: 'human', content: texto, origen: 'celular', enviado_por: 'WhatsApp (celular)' });
    await supabase.from('conversations').update({ last_message: texto, last_role: 'human', updated_at: new Date().toISOString() }).eq('id', conv.id);
    console.log('Mensaje saliente (celular) guardado en conversacion ' + conv.id);
  } catch (e) { console.error('Error en guardarMensajeSaliente:', e && e.message); }
}

// Backup automatico: junta todos los datos de cada user y guarda una foto en la tabla backups.
// Mantiene las ultimas 48 copias por user (24 hs a razon de 1 cada 30 min) y borra las viejas.
async function hacerBackup() {
  try {
    // Obtener todos los user_id que tienen configuracion (clientes activos)
    const { data: settings } = await supabase.from('business_settings').select('user_id');
    if (!settings || settings.length === 0) return;
    const userIds = [...new Set(settings.map(function(s){ return s.user_id; }))];
    for (const uid of userIds) {
      try {
        const tablas = ['conversations','messages','contacts','recontactos','business_settings','properties','knowledge_base','whatsapp_instancias'];
        const contenido = {};
        for (const t of tablas) {
          const { data } = await supabase.from(t).select('*').eq('user_id', uid);
          contenido[t] = data || [];
        }
        const resumen = 'conv:' + (contenido.conversations.length) + ' msg:' + (contenido.messages.length) + ' cont:' + (contenido.contacts.length);
        await supabase.from('backups').insert({ user_id: uid, contenido: contenido, resumen: resumen });
        // Limpieza: dejar solo las ultimas 48 copias de este user
        const { data: viejos } = await supabase.from('backups').select('id').eq('user_id', uid).order('created_at', { ascending: false }).range(48, 1000);
        if (viejos && viejos.length > 0) {
          const ids = viejos.map(function(v){ return v.id; });
          await supabase.from('backups').delete().in('id', ids);
        }
        console.log('Backup hecho para user ' + uid + ' (' + resumen + ')');
      } catch (e2) { console.error('Error backup user ' + uid + ':', e2 && e2.message); }
    }
  } catch (e) { console.error('Error en hacerBackup:', e && e.message); }
}

// Elige el asesor ACTIVO con menos leads asignados (reparto equitativo). Devuelve su id o null.
// Los usuarios con rol 'administrador' quedan EXCLUIDOS de la auto-asignacion/rotacion
// (un admin no recibe leads automaticamente). El filtro deja pasar rol='asesor' y rol NULL (legacy).
async function elegirAsesorActivo(admin_id) {
  try {
    const { data: activos } = await supabase.from('asesores').select('id').eq('admin_id', admin_id).eq('activo', true).or('rol.is.null,rol.neq.administrador');
    if (!activos || activos.length === 0) return null;
    // contar leads asignados a cada asesor activo
    let mejor = null; let menos = Infinity;
    for (const a of activos) {
      const { count } = await supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('asesor_id', a.id);
      const n = count || 0;
      if (n < menos) { menos = n; mejor = a.id; }
    }
    return mejor;
  } catch (e) { console.error('Error elegirAsesorActivo:', e && e.message); return null; }
}

// ===== TRANSCRIPCION DE AUDIO con Groq Whisper (multilenguaje, autodetect) =====
async function transcribirAudioGroq(base64, mime) {
  try {
    if (!GROQ_KEY || !base64) return null; // fallback: sin key o sin audio
    const buffer = Buffer.from(base64, 'base64');
    const m = mime || 'audio/ogg';
    const nombreArchivo = (m.indexOf('mp3') >= 0 || m.indexOf('mpeg') >= 0) ? 'audio.mp3' : 'audio.ogg';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: m }), nombreArchivo);
    form.append('model', 'whisper-large-v3');
    // NO se manda 'language': dejamos que Whisper autodetecte el idioma (clave multilenguaje).
    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_KEY }, // sin Content-Type: el FormData setea el boundary
      body: form
    });
    if (!resp.ok) { console.error('transcribirAudioGroq fallo:', resp.status); return null; }
    const j = await resp.json();
    return ((j && j.text) || '').trim() || null;
  } catch (e) { console.error('transcribirAudioGroq error:', e && e.message); return null; }
}

// ===== MULTIMEDIA: baja un archivo de Evolution y lo sube a Supabase Storage =====
async function subirMediaAStorage(instancia, mensajeCrudo, tipoMedia, skipTranscribe) {
  try {
    // 1) Pedir el base64 del archivo a Evolution
    const resp = await fetch(EVOLUTION_URL + '/chat/getBase64FromMediaMessage/' + instancia, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({ message: mensajeCrudo, convertToMp4: false })
    });
    if (!resp.ok) { console.error('getBase64 fallo:', resp.status); return null; }
    const j = await resp.json();
    const base64 = j && (j.base64 || j.media || (j.data && j.data.base64));
    if (!base64) { console.error('getBase64 sin base64'); return null; }
    // 2) Determinar extension y content-type segun el tipo
    const mime = (j && j.mimetype) ? j.mimetype : '';
    let ext = 'bin';
    if (tipoMedia === 'imagen') ext = (mime.indexOf('png') >= 0) ? 'png' : 'jpg';
    else if (tipoMedia === 'audio') ext = (mime.indexOf('mp3') >= 0) ? 'mp3' : 'ogg';
    else if (tipoMedia === 'video') ext = 'mp4';
    else if (tipoMedia === 'documento') { if (mime.indexOf('pdf') >= 0) ext = 'pdf'; else if (mime.indexOf('word') >= 0) ext = 'docx'; else ext = 'bin'; }
    const contentType = mime || 'application/octet-stream';
    // 3) Subir a Supabase Storage (bucket 'media')
    const buffer = Buffer.from(base64, 'base64');
    const nombre = 'wa/' + Date.now() + '_' + Math.random().toString(36).substring(2, 8) + '.' + ext;
    const up = await supabase.storage.from('media').upload(nombre, buffer, { contentType: contentType, upsert: false });
    if (up.error) { console.error('upload Storage fallo:', up.error.message); return null; }
    // 4) Obtener URL publica
    const pub = supabase.storage.from('media').getPublicUrl(nombre);
    const url = pub && pub.data ? pub.data.publicUrl : null;
    // 5) Si es audio y hay Groq: transcribir REUSANDO el base64 ya bajado (sin segunda descarga)
    let transcripcion = null;
    if (tipoMedia === 'audio' && GROQ_KEY && !skipTranscribe) {
      transcripcion = await transcribirAudioGroq(base64, mime);
    }
    return url ? { url: url, tipo: tipoMedia, transcripcion: transcripcion } : null;
  } catch (e) { console.error('subirMediaAStorage error:', e && e.message); return null; }
}
// ===== ENVIAR MULTIMEDIA por WhatsApp (Evolution sendMedia) =====
async function enviarWhatsappMedia(instancia, numero, mediaUrl, tipo, caption) {
  try {
    let mediatype = 'document';
    if (tipo === 'imagen') mediatype = 'image';
    else if (tipo === 'video') mediatype = 'video';
    else if (tipo === 'audio') mediatype = 'audio';
    const endpoint = (mediatype === 'audio') ? '/message/sendWhatsAppAudio/' : '/message/sendMedia/';
    let bodyFinal;
    if (mediatype === 'audio') { bodyFinal = { number: numero, audio: mediaUrl }; }
    else { let extDef = 'bin'; if (mediatype === 'image') extDef = 'jpg'; else if (mediatype === 'video') extDef = 'mp4'; const nombreArch = 'archivo_' + Date.now() + '.' + extDef; bodyFinal = { number: numero, mediatype: mediatype, media: mediaUrl, fileName: nombreArch }; if (caption) bodyFinal.caption = caption; }
    const resp = await fetch(EVOLUTION_URL + endpoint + instancia, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify(bodyFinal)
    });
    return resp.ok;
  } catch (e) { console.error('enviarWhatsappMedia error:', e && e.message); return false; }
}

app.post('/api/enviar-media', async (req, res) => {
  try {
    const _uid = await verificarUsuario(req);
    if (!_uid) return res.status(401).json({ error: 'No autorizado' });
    const { conversation_id, media_url, media_tipo, caption, enviado_por } = req.body || {};
    if (!conversation_id || !media_url || !media_tipo) return res.status(400).json({ error: 'Faltan datos' });
    const { data: conv } = await supabase.from('conversations').select('contact_id, user_id').eq('id', conversation_id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });
    const { data: contacto } = await supabase.from('contacts').select('phone').eq('id', conv.contact_id).maybeSingle();
    if (!contacto) return res.status(404).json({ error: 'Contacto no encontrado' });
    const instanciaNombre = nombreInstancia(conv.user_id);
    const contenidoCartelito = caption || ('[' + media_tipo + ']');
    const { data: msgIns } = await supabase.from('messages').insert({ conversation_id: conversation_id, user_id: conv.user_id, role: 'human', content: contenidoCartelito, enviado_por: enviado_por || 'Asesor', media_url: media_url, media_tipo: media_tipo, estado_envio: 'enviando' }).select('id').maybeSingle();
    await supabase.from('conversations').update({ last_message: contenidoCartelito, last_role: 'human', updated_at: new Date().toISOString() }).eq('id', conversation_id);
    // Responder YA: el mensaje quedo guardado. El envio a WhatsApp sigue en segundo plano.
    res.json({ ok: true });
    // Envio a Evolution en segundo plano (no bloquea la respuesta)
    enviarWhatsappMedia(instanciaNombre, contacto.phone, media_url, media_tipo, caption).then(function(ok){
      if (msgIns && msgIns.id) { supabase.from('messages').update({ estado_envio: ok ? 'enviado' : 'fallido' }).eq('id', msgIns.id).then(function(){}, function(){}); }
    }, function(err){ console.error('envio media bg:', err && err.message); if (msgIns && msgIns.id) { supabase.from('messages').update({ estado_envio: 'fallido' }).eq('id', msgIns.id).then(function(){}, function(){}); } });
  } catch (e) { console.error('enviar-media error:', e && e.message); if (!res.headersSent) return res.status(500).json({ error: e && e.message }); }
});
async function generarRespuestaAgente(user_id, conversation_id, message, opciones) {
  const modoPrueba = opciones && opciones.modoPrueba;
  const historialManual = (opciones && opciones.historialManual) || null;
  const { data: settings } = await supabase.from('business_settings').select('*').eq('user_id', user_id).maybeSingle();
  const { data: knowledge } = await supabase.from('knowledge_base').select('category, question, answer').eq('user_id', user_id);
  const { data: properties } = await supabase.from('properties').select('id, numero, title, type, zone, caracteristicas, price, rooms, capacity, amenities, link, operation, status, venta_activa, venta_estado, venta_precio, anual_activa, anual_estado, anual_precio, temporal_activa, temporal_precio_dia, images').eq('user_id', user_id).eq('activa', true);

  // MEMORIA DEL LEAD: traer datos ya conocidos del contacto (name/interest/budget/notes) para inyectarlos al prompt
  // y evitar re-preguntar o re-presentarse. No bloquea ni rompe si falla (campos opcionales).
  let datosLead = null;
  if (conversation_id && !modoPrueba) {
    try {
      const { data: convC } = await supabase.from('conversations').select('contact_id').eq('id', conversation_id).maybeSingle();
      if (convC && convC.contact_id) {
        const { data: cont } = await supabase.from('contacts').select('name, interest, budget, notes').eq('id', convC.contact_id).maybeSingle();
        if (cont) datosLead = cont;
      }
    } catch (eDL) { console.error('lectura datos lead:', eDL && eDL.message); }
  }

  const agentName = (settings && settings.agent_name) || 'Asistente';
  const agentCargo = (settings && settings.agent_cargo && String(settings.agent_cargo).trim()) ? String(settings.agent_cargo).trim() : '';
  const tono = TONO[(settings && settings.agent_tone) || 'cercano'] || TONO.cercano;
  const autonomia = AUTONOMIA[(settings && settings.autonomy) || 'equilibrado'] || AUTONOMIA.equilibrado;
  const objetivo = OBJETIVO[(settings && settings.agent_objetivo) || 'informar'] || OBJETIVO.informar;
  const largo = LARGO[(settings && settings.response_length) || 'corto'] || LARGO.corto;
  const usaEmojis = settings && settings.use_emojis === true;
  const rubro = (settings && settings.rubro) || 'inmobiliaria';
  const company = (settings && settings.company_name) || 'la empresa';
  const instructions = (settings && settings.instructions) || '';

  let kb = 'No hay informacion cargada todavia.';
  if (knowledge && knowledge.length > 0) {
    kb = knowledge.map(function(k){ return '- [' + k.category + '] ' + k.question + ' => ' + k.answer; }).join('\n');
  }

  // Traer periodos ocupados del calendario temporal (para cruzar fechas)
  const periodosPorProp = {};
  try {
    const idsTemp = (properties || []).filter(function(p){ return p.temporal_activa; }).map(function(p){ return p.id; });
    if (idsTemp.length > 0) {
      const { data: periodos } = await supabase.from('temporario_periodos').select('property_id, fecha_desde, fecha_hasta, estado').in('property_id', idsTemp);
      (periodos || []).forEach(function(per){
        if (!periodosPorProp[per.property_id]) periodosPorProp[per.property_id] = [];
        periodosPorProp[per.property_id].push(per);
      });
    }
  } catch (e) { console.error('Error trayendo periodos:', e && e.message); }

  let inventario = 'No hay propiedades cargadas todavia.';
  if (properties && properties.length > 0) {
    inventario = properties.map(function(p){
    var ops = [];
    if (p.venta_activa && p.venta_estado !== 'vendida') ops.push('VENTA (' + (p.venta_estado||'disponible') + '): ' + (p.venta_precio ? 'USD ' + p.venta_precio : 'consultar'));
    if (p.anual_activa && p.anual_estado !== 'alquilada') ops.push('ALQUILER ANUAL (' + (p.anual_estado||'disponible') + '): ' + (p.anual_precio ? '$' + p.anual_precio + '/mes' : 'consultar'));
    if (p.temporal_activa) {
      var ocup = (periodosPorProp[p.id] || []).filter(function(per){ return per.estado === 'ocupado'; });
      var fechasTxt;
      if (ocup.length > 0) {
        var rangos = ocup.map(function(per){ return 'del ' + per.fecha_desde + ' al ' + per.fecha_hasta; }).join('; ');
        fechasTxt = ' (OCUPADA: ' + rangos + '. Libre en cualquier otra fecha)';
      } else {
        fechasTxt = ' (sin reservas cargadas: disponible para consultar fechas)';
      }
      ops.push('ALQUILER TEMPORAL: ' + (p.temporal_precio_dia ? '$' + p.temporal_precio_dia + '/dia (base)' : 'consultar') + fechasTxt);
    }
    if (ops.length === 0 && p.operation) ops.push(p.operation + (p.price ? ': ' + p.price : ''));
    var enc = (p.numero ? 'N' + p.numero + ' - ' : '') + (p.title||'');
    var carac = [p.zone, p.caracteristicas].filter(Boolean).join(', ');
    // Resumen de fotos disponibles por categoria (ADITIVO, solo si la propiedad tiene images cargadas).
    // Asi la IA sabe que categorias puede mandar con la tool enviar_foto_propiedad.
    var fotosTxt = '';
    try {
      var _imgs = Array.isArray(p.images) ? p.images : [];
      if (_imgs.length > 0) {
        var _cats = [];
        _imgs.forEach(function(im){ var c = im && im.categoria; if (c && _cats.indexOf(c) === -1) _cats.push(c); });
        if (_cats.length > 0) fotosTxt = ' | fotos disponibles: ' + _cats.join(', ');
        else fotosTxt = ' | fotos disponibles: si (sin categorizar)';
      }
    } catch (eImg) { fotosTxt = ''; }
    return '- ' + enc + (carac ? ' (' + carac + ')' : '') + ' | ' + (p.type||'') + ' | ambientes: ' + (p.rooms||'-') + ' | capacidad: ' + (p.capacity||'-') + ' | ' + (ops.length ? ops.join(' ; ') : 'sin operacion activa') + (p.amenities ? ' | amenities: ' + p.amenities : '') + (p.link ? ' | link: ' + p.link : '') + fotosTxt;
  }).join(String.fromCharCode(10));
  }

  let historial = [];
  if (modoPrueba && historialManual) {
    historial = historialManual.map(function(m){ return { role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }; });
  } else if (conversation_id) {
    // MEMORIA / costo: traemos solo los ULTIMOS N mensajes (no TODA la conversacion). Los datos clave del lead
    // (nombre/interes/presupuesto) ya viajan en bloqueDatosLead, asi que charlas muy largas no encarecen cada
    // respuesta ni el agente pierde el hilo reciente. (El historial NO se cachea -> capearlo baja el costo de
    // las charlas largas.) Traemos los N mas recientes (desc + limit) y los reordenamos cronologicamente.
    const MAX_HISTORIAL = 30;
    const { data: prev } = await supabase.from('messages').select('role, content, content_original').eq('conversation_id', conversation_id).order('created_at', { ascending: false }).limit(MAX_HISTORIAL);
    if (prev && prev.length > 0) {
      historial = prev.slice().reverse().map(function(m){ var textoBase = (m.role === 'ai') ? (m.content_original || m.content) : m.content; return { role: (m.role === 'contact' ? 'user' : 'assistant'), content: textoBase }; });
    }
  }

    let instruccionesRubro = '';
  if (rubro === 'hotel_cabanas') {
    instruccionesRubro = 'RUBRO HOTEL, CABANAS O COMPLEJO DE ALOJAMIENTO. Hablas de RESERVAS de alojamiento, no de venta ni alquiler de inmuebles. Vocabulario: noches, estadia, reserva, disponibilidad, check-in y check-out, capacidad de personas, temporada alta o baja, tarifa por noche, servicios incluidos como pileta, parrilla, wifi, cochera y ropa de cama. Preguntas clave al huesped ANTES de cotizar: fechas de entrada y salida (asi calculas cuantas noches) y cuantas personas se alojan. Con esas fechas cruza la DISPONIBILIDAD del inventario: si una unidad figura OCUPADA en esas fechas, no la ofrezcas para ese periodo y proponé fechas u opciones libres. Al presentar opciones, deci capacidad, servicios y precio por noche (y si podes, el total estimado por la cantidad de noches). Cuando el huesped quiere confirmar una reserva o seña, derivá a un asesor del equipo segun tu objetivo configurado. NUNCA hables de expensas, escrituras ni metros cuadrados.';
  } else if (rubro === 'desarrolladora') {
    instruccionesRubro = 'RUBRO DESARROLLADORA O EMPRENDIMIENTOS. Vendes unidades de emprendimientos o proyectos, muchas veces en POZO o en construccion. Vocabulario: proyecto o emprendimiento, unidades, tipologias de 1, 2 o 3 ambientes, etapa de obra (pozo, en construccion o a estrenar), fecha estimada de ENTREGA, financiacion, anticipo y CUOTAS, valor en pesos o dolares, ajuste por indice CAC. Preguntas clave: tipologia buscada, presupuesto o forma de pago (cuanto de anticipo y en cuantas cuotas), y si busca para vivienda o inversion. Al presentar, resalta la financiacion (anticipo + cuotas), la etapa de obra y la fecha de entrega estimada. Aclara siempre que los valores, las cuotas y las fechas de entrega son estimados y pueden estar sujetos a ajuste por avance de obra o indice. Cuando el lead quiere reservar una unidad o avanzar con la sena, derivá a un asesor del equipo segun tu objetivo configurado.';
  } else {
    instruccionesRubro = 'RUBRO INMOBILIARIA. Vocabulario: venta y alquiler, ambientes, dormitorios, metros cuadrados, expensas, zona o barrio, apto credito, escritura. Preguntas clave: si busca comprar o alquilar, zona, cantidad de ambientes y presupuesto. Al presentar, deci operacion, ambientes, zona y precio.';
  }

    const comportamientoSetter = [
    'QUIEN SOS: Sos una combinacion de tres roles en una sola persona. (1) SECRETARIA: ordenada, recordas datos del cliente, coordinas y no dejas cabos sueltos. (2) ATENCION AL PUBLICO: calida, paciente, clara, das una excelente primera impresion y resolves dudas con amabilidad. (3) SETTER: detectas que mueve al cliente, generas interes y avanzas la conversacion hacia el cierre. Combinas los tres roles de forma natural, no robotica.',
    'COMO TRABAJAS: No te limites a responder y esperar. Llevas la conversacion hacia adelante con calidez y naturalidad, paso a paso.',
    'REGITE SIEMPRE Y A RAJATABLA POR LA CONFIGURACION (es OBLIGATORIA, no opcional): respeta el IDIOMA configurado, el uso o no de EMOJIS, el TONO indicado, el nivel de AUTONOMIA (cuanto podes afirmar vs cuando derivar), el OBJETIVO (hasta donde atender antes de pasar a un humano), el LARGO de respuesta y las instrucciones internas; usa la base de conocimiento como tu UNICA fuente de verdad. Si la configuracion y tu instinto comercial chocan, SIEMPRE gana la configuracion.',
    'PRIMERO conecta: mostrate humano, calido y con interes genuino. Adapta el trato al lead segun como te escribe.',
    'DETECTA que motiva a este lead a avanzar: puede ser inversion, una mejor calidad de vida, disfrutar en pareja, vision a futuro, un proyecto para la familia, o seguridad. No lo interrogues ni preguntes el dolor de forma directa: descubrilo con preguntas naturales y escuchando lo que dice.',
    'CONECTA la oferta con eso que lo mueve: cuando presentes una opcion, relacionala con su motivacion (ejemplo: si busca invertir, resalta valor y proyeccion; si es para la familia, resalta espacio y comodidad). Siempre con datos reales.',
    'NUNCA inventes datos, precios, caracteristicas ni beneficios. Si no tenes la info, decis que la consultas. Persuadir es conectar lo real con lo que el lead necesita, no exagerar ni presionar.',
    'PROGRESA la charla: en cada respuesta haces avanzar un paso (entender mejor su necesidad, mostrar una opcion que encaje, o proponer el siguiente paso). Evita respuestas que cierren la conversacion.',
    'AVANZA hacia el cierre SOLO hasta el limite que define tu objetivo configurado (ver arriba). Cuando el lead ACEPTA o COORDINA ese paso (por ejemplo acuerda una visita o cita, da fecha/horario, o quiere avanzar una reserva/sena), DERIVA de inmediato: decile de forma natural que lo pasas con un asesor del equipo para confirmarlo/coordinarlo, y NO sigas vos gestionando ese cierre. Nunca te pases del limite de tu objetivo configurado.',
    'Sos empatico y persuasivo, nunca insistente ni manipulador. Si el lead no quiere avanzar, respetalo y dejas la puerta abierta.',
    'SI NO HAY CONVERSACION PREVIA con este contacto (no hablaron antes), tratalo como un primer contacto: presentate, genera confianza desde cero y NO asumas que ya venian hablando de algo. No digas cosas como lo que veniamos viendo si nunca hubo charla.'
  ].join(' ');

    const idiomaBase = (settings && settings.idioma) || 'es';
  const NOMBRE_IDIOMA = { es: 'espanol', en: 'ingles', pt: 'portugues', fr: 'frances', it: 'italiano', de: 'aleman', nl: 'holandes', ru: 'ruso', zh: 'chino mandarin', ja: 'japones', ko: 'coreano', ar: 'arabe', hi: 'hindi', tr: 'turco', pl: 'polaco' };
  const idiomaNombre = NOMBRE_IDIOMA[idiomaBase] || 'espanol';
  const instruccionIdioma = 'IDIOMA (OBLIGATORIO, NO NEGOCIABLE): Respondé SIEMPRE y EXCLUSIVAMENTE en ' + idiomaNombre + '. Es el idioma configurado por la empresa. AUNQUE el lead te escriba en otro idioma (castellano, ingles, lo que sea), vos SIEMPRE respondes en ' + idiomaNombre + ', de forma nativa y natural. Nunca cambies de idioma para acompanar al lead: la configuracion manda.';

  // MEMORIA DEL LEAD: armar el bloque con lo que YA sabemos del contacto, para no re-preguntar ni re-presentarse.
  let bloqueDatosLead = '';
  if (datosLead) {
    const _partes = [];
    if (datosLead.name && String(datosLead.name).trim()) _partes.push('nombre=' + String(datosLead.name).trim());
    if (datosLead.interest && String(datosLead.interest).trim()) _partes.push('interes=' + String(datosLead.interest).trim());
    if (datosLead.budget && String(datosLead.budget).trim()) _partes.push('presupuesto=' + String(datosLead.budget).trim());
    if (datosLead.notes && String(datosLead.notes).trim()) _partes.push('notas=' + String(datosLead.notes).trim());
    if (_partes.length > 0) {
      bloqueDatosLead = 'DATOS YA CONOCIDOS DEL LEAD (no los vuelvas a preguntar ni te re-presentes si ya sabes el nombre): ' + _partes.join('; ') + '.';
    }
  }

  // Parte ESTATICA del system: identica para el tenant entre mensajes y leads -> se CACHEA con cache_control
  // (prompt caching de Anthropic, ~-90% en relecturas). Los datos del lead (dinamicos) van en un bloque aparte.
  const systemStatic = [
    'Sos ' + agentName + (agentCargo ? (', ' + agentCargo) : ', asesor/a') + ' de ' + company + ' (rubro: ' + rubro + ').',
        'IDENTIDAD: Sos una persona del equipo. NUNCA digas que sos una inteligencia artificial, un bot, un asistente virtual ni un programa. Si te preguntan que cargo ocupas, si sos una IA, o quien sos, responde con tu nombre (' + agentName + ')' + (agentCargo ? (" y tu cargo (" + agentCargo + ")") : '') + ' de forma natural, sin admitir que sos un sistema.',
        'APELLIDO: Si te preguntan tu apellido, aclara con amabilidad que no es un dato relevante, y ofrece pasarlo con un asesor del equipo si lo necesita en ese momento.',
    'LINKS DE PROPIEDADES: Cuando menciones o recomiendes una propiedad que en el inventario tenga un campo link, inclui ese link en tu respuesta para que el lead pueda ver mas informacion y fotos. Compartilo de forma natural, por ejemplo: Te paso el link para que veas las fotos y los detalles. Si la propiedad no tiene link en el inventario, no inventes ninguno ni menciones que falta.',
    'FOTOS DE PROPIEDADES: Cuando el lead te PIDA ver una foto de una propiedad (por ejemplo: mandame una del dormitorio, mostrame la pileta, tenes fotos de la cocina), usa la herramienta enviar_foto_propiedad indicando el numero de la propiedad (campo numero del inventario, ej: 12) y la categoria pedida. Solo podes mandar fotos de propiedades que en el inventario digan fotos disponibles. Las categorias validas son: dormitorio, bano, cocina, comedor, living, parque, frente, pileta, cochera, exterior, otra. Si no tenes claro de que propiedad habla, primero preguntale cual antes de usar la herramienta. No inventes fotos que no existan.',
    instruccionesRubro,
    comportamientoSetter,
    instruccionIdioma,
    'Respondes consultas de clientes por WhatsApp.',
    'Si es el primer mensaje y todavia no sabes el nombre del cliente, presentate brevemente (deci tu nombre y la inmobiliaria) y preguntale su nombre de forma natural. Una vez que sepas el nombre, usalo para dirigirte a la persona segun el tono configurado (por nombre de pila si es informal; Sr./Sra. y apellido si es formal). No vuelvas a pedir el nombre si ya lo dio antes en la conversacion.',
    tono, autonomia, objetivo, largo,
    usaEmojis ? 'Podes usar algun emoji con moderacion.' : 'EMOJIS PROHIBIDOS: NO uses ningun emoji, emoticon ni simbolo grafico. Responde SIEMPRE solo con texto plano, sin excepciones.',
    instructions ? ('Instrucciones internas que SIEMPRE debes seguir: ' + instructions) : '',
    '', 'Base de conocimiento de la empresa:', kb, '',
    'Propiedades disponibles (usalas SOLO estas para recomendar; no inventes ni ofrezcas propiedades que no esten en esta lista). Si una propiedad tiene link, incluilo cuando la recomiendes asi el cliente ve las fotos. Distingui bien el tipo de operacion (venta, alquiler anual, alquiler temporal) y ofrece segun lo que pida el cliente:', inventario, '',
    'Hablas de forma humana y natural. No inventes datos que no esten en la base de conocimiento.'
  ].filter(Boolean).join('\n');

  const mensajesParaIA = historial.concat([{ role: 'user', content: message }]);

  // Tool para que la IA pueda enviar una foto de una propiedad cuando el lead la pide.
  // ADITIVO: si la IA no la usa, el flujo es exactamente el mismo de antes (respuesta de texto).
  const CATEGORIAS_FOTO = ['dormitorio', 'bano', 'cocina', 'comedor', 'living', 'parque', 'frente', 'pileta', 'cochera', 'exterior', 'otra'];
  const toolsAgente = [{
    name: 'enviar_foto_propiedad',
    description: 'Envia al lead una foto de una propiedad por WhatsApp. Usala SOLO cuando el lead pide ver una foto concreta (ej: mandame una del dormitorio, mostrame la pileta). Indica el numero de la propiedad (campo numero del inventario) y la categoria de foto pedida.',
    input_schema: {
      type: 'object',
      properties: {
        numero: { type: 'string', description: 'El numero de la propiedad tal como figura en el inventario (ej: 12).' },
        categoria: { type: 'string', enum: CATEGORIAS_FOTO, description: 'La categoria de foto pedida por el lead.' }
      },
      required: ['numero', 'categoria']
    }
  }];

  // System en bloques para CACHING: el bloque estatico (instrucciones+KB+catalogo) se cachea con cache_control
  // ephemeral; los datos del lead (dinamicos) van en un bloque aparte que NO se cachea. Asi las relecturas
  // del bloque grande cuestan ~10% (cache_read) en vez del precio full, sin cambiar nada de lo que responde la IA.
  const systemBlocks = [{ type: 'text', text: systemStatic, cache_control: { type: 'ephemeral' } }];
  if (bloqueDatosLead) systemBlocks.push({ type: 'text', text: bloqueDatosLead });

  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: systemBlocks,
    tools: toolsAgente,
    messages: mensajesParaIA
  });

  // mediaAEnviar: fotos que el webhook debera mandar DESPUES del texto. Vacio si la IA no pidio foto.
  let mediaAEnviar = [];
  let reply;
  // ¿La IA pidio usar la tool de foto?
  if (completion && completion.stop_reason === 'tool_use') {
    try {
      const toolUse = (completion.content || []).find(function(b){ return b && b.type === 'tool_use' && b.name === 'enviar_foto_propiedad'; });
      const textoPrevio = (completion.content || []).filter(function(b){ return b && b.type === 'text' && b.text; }).map(function(b){ return b.text; }).join(' ').trim();
      let fotoUrl = null;
      let fotoCategoria = null;
      let toolResultTexto = '';
      if (toolUse && toolUse.input) {
        const numPedido = String(toolUse.input.numero == null ? '' : toolUse.input.numero).trim();
        fotoCategoria = String(toolUse.input.categoria == null ? '' : toolUse.input.categoria).trim();
        // Buscar la propiedad por numero entre las YA cargadas (no re-consultamos la DB).
        const propFoto = (properties || []).find(function(p){ return p.numero != null && String(p.numero).trim() === numPedido; });
        if (propFoto) {
          const imgs = Array.isArray(propFoto.images) ? propFoto.images : [];
          if (imgs.length > 0) {
            // 1) intentar por categoria exacta
            let cand = imgs.filter(function(im){ return im && im.categoria === fotoCategoria && im.url; });
            // 2) fallback: portada / primera foto con url
            if (cand.length === 0) cand = imgs.filter(function(im){ return im && im.url; });
            if (cand.length > 0) {
              fotoUrl = cand[0].url;
              const huboCategoria = cand[0].categoria === fotoCategoria;
              toolResultTexto = huboCategoria
                ? ('OK: foto enviada de la propiedad N' + numPedido + ', categoria ' + fotoCategoria + '. Acompanala con un comentario breve y natural.')
                : ('No habia foto especifica de la categoria ' + fotoCategoria + ' para la propiedad N' + numPedido + '. Se envio otra foto disponible de la propiedad. Aclara con naturalidad que le mandas una foto de la propiedad aunque no sea exactamente de ' + fotoCategoria + '.');
            } else {
              toolResultTexto = 'La propiedad N' + numPedido + ' no tiene fotos disponibles. Avisale con amabilidad que por ahora no tenes una foto de esa propiedad para mandarle, y ofrecele el link si lo hay.';
            }
          } else {
            toolResultTexto = 'La propiedad N' + numPedido + ' no tiene fotos disponibles. Avisale con amabilidad que por ahora no tenes una foto de esa propiedad para mandarle, y ofrecele el link si lo hay.';
          }
        } else {
          toolResultTexto = 'No se encontro ninguna propiedad con el numero ' + numPedido + ' en el inventario. Pedile al lead que aclare de que propiedad quiere la foto.';
        }
      } else {
        toolResultTexto = 'No se pudo procesar el pedido de foto. Segui la conversacion con normalidad.';
      }

      // SEGUNDO TURNO: devolvemos el tool_result para que la IA cierre con texto natural (en idioma base).
      let textoFinal = '';
      try {
        const mensajesTurno2 = mensajesParaIA.concat([
          { role: 'assistant', content: completion.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse ? toolUse.id : 'sin_id', content: toolResultTexto }] }
        ]);
        const completion2 = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          system: systemBlocks,
          tools: toolsAgente,
          messages: mensajesTurno2
        });
        const b2 = (completion2.content || []).find(function(b){ return b && b.type === 'text' && b.text; });
        if (b2 && b2.text) textoFinal = b2.text;
        // acumular uso del segundo turno (incluye tokens de cache para que el costo logueado sea exacto)
        if (completion2 && completion2.usage && completion && completion.usage) {
          completion.usage = {
            input_tokens: (completion.usage.input_tokens || 0) + (completion2.usage.input_tokens || 0),
            output_tokens: (completion.usage.output_tokens || 0) + (completion2.usage.output_tokens || 0),
            cache_read_input_tokens: (completion.usage.cache_read_input_tokens || 0) + (completion2.usage.cache_read_input_tokens || 0),
            cache_creation_input_tokens: (completion.usage.cache_creation_input_tokens || 0) + (completion2.usage.cache_creation_input_tokens || 0)
          };
        }
      } catch (eTurno2) {
        console.error('segundo turno tool foto:', eTurno2 && eTurno2.message);
        // Fallback: caption corto fijo (en idioma base). La traduccion de salida se aplica igual mas abajo.
        textoFinal = textoPrevio || (fotoUrl ? 'Te mando una foto de la propiedad.' : 'Por ahora no tengo esa foto para mandarte.');
      }
      if (!textoFinal || !textoFinal.trim()) {
        textoFinal = textoPrevio || (fotoUrl ? 'Te mando una foto de la propiedad.' : 'Por ahora no tengo esa foto para mandarte.');
      }
      reply = textoFinal;
      if (fotoUrl) mediaAEnviar.push({ url: fotoUrl, caption: '' });
    } catch (eFoto) {
      // Si algo de las fotos falla, NO rompemos la respuesta de texto: usamos el texto que haya o un fallback.
      console.error('flujo tool foto:', eFoto && eFoto.message);
      mediaAEnviar = [];
      const _txt = (completion.content || []).filter(function(b){ return b && b.type === 'text' && b.text; }).map(function(b){ return b.text; }).join(' ').trim();
      reply = _txt || 'Disculpa, ahora mismo no puedo mandarte la foto, pero seguimos por aca.';
    }
  } else {
    const block = (completion && completion.content) ? completion.content[0] : null;
    reply = (block && block.type === 'text') ? block.text : 'No pude generar una respuesta.';
  }
  if (!usaEmojis) { const _limpio = quitarEmojis(reply); if (_limpio) reply = _limpio; } // emojis desactivados en config: los sacamos si o si

  // 'reply' esta en el idioma base de la empresa (la IA SIEMPRE responde en ese idioma, ver instruccionIdioma).
  // Si el traductor esta activo y el lead habla otro idioma, traducimos la respuesta al idioma del lead para ENVIARSELA,
  // y guardamos la version en idioma base como content_original para que el asesor la lea (mismo criterio que el envio manual).
  let replyCliente = reply; // lo que efectivamente se le envia al cliente por WhatsApp
  let idiomaAi = null;
  if (conversation_id && !modoPrueba) {
    try {
      const { data: convTrad } = await supabase.from('conversations').select('traductor_activo, idioma_lead').eq('id', conversation_id).maybeSingle();
      if (convTrad && convTrad.traductor_activo && convTrad.idioma_lead && convTrad.idioma_lead !== idiomaBase && await planPermite(user_id, 'audio_traduccion')) {
        const trad = await traducir(reply, convTrad.idioma_lead, user_id);
        if (trad && trad.trim() && trad.trim() !== reply.trim()) { replyCliente = trad; idiomaAi = convTrad.idioma_lead; }
      }
    } catch (e) { console.error('trad saliente IA:', e && e.message); /* si falla, se envia el original en idioma base */ }
    // content = lo que recibe el cliente (idioma del lead); content_original = version en idioma base para el asesor
    await supabase.from('messages').insert([
      { conversation_id: conversation_id, user_id: user_id, role: 'ai', content: replyCliente, content_original: (idiomaAi ? reply : null), idioma: idiomaAi, enviado_por: 'Agente IA' }
    ]);
    await supabase.from('conversations').update({ last_message: replyCliente, last_role: 'ai', updated_at: new Date().toISOString() }).eq('id', conversation_id);
  }

  return { reply: reply, replyCliente: replyCliente, usage: completion.usage, mediaAEnviar: mediaAEnviar };
}

// Detecta SIN IA si el lead pide explicitamente hablar/ser atendido por una persona/asesor/humano (en cualquier
// forma, incluso como pregunta). Determinista (regex, sin acentos) -> nunca falla en el caso obvio ni gasta tokens.
function _pideHumano(texto) {
  const s = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // GUARDAS: consultas/narracion que NO son un pedido de derivacion (las responde la IA) -> evitan el over-handoff.
  if (/\bbot\b/.test(s)) return false;                                                   // "sos un bot?", "es un bot"
  if (/\b(sos|eres|sois)\b[\s\S]{0,15}(persona|humano|robot|maquina|ia|real|chatbot|automat)/.test(s)) return false; // "sos una persona real?"
  if (/(me dijeron|me dijo|dijeron que|mi asesor|mi asesora|su asesor|el asesor me|la asesora me|que vi)/.test(s)) return false; // narracion (el lead cuenta, no pide)
  if (/(pasa(me|s|r)?|manda(me|s|r)?|envia(me|s|r)?|mostra(me|r)?)\s+(?:l[ao]s?\s+|el\s+|un[ao]?\s+|mas\s+)*(foto|imagen|video|dato|precio|valor|direccion|ubicacion|info|ficha|detalle|link|catalogo|plano|medida|metro)/.test(s)) return false; // pide contenido, no un humano
  if (/atiende\s+alguien/.test(s) && !/me\s+atien/.test(s)) return false;                 // "atiende alguien?" (pregunta de disponibilidad)
  // PEDIDOS EXPLICITOS de hablar/ser atendido por una persona/asesor/humano:
  if (/(hablar|hablo|comunicar(me)?|comunicame|contactar|conect(ar|ame)|derive|derivar|llame|llamar)[\s\S]{0,28}(asesor|persona|humano|agente|representante|vendedor|alguien|operador|encargad)/.test(s)) return true;
  if (/(pasa(me|s)?|paseme|deriva(me)?|conecta(me)?)\s+con\s+(un|una|el|la|algun|alguna)?\s*(asesor|persona|humano|agente|alguien|vendedor|operador|encargad)/.test(s)) return true; // "pasame con un asesor"
  if (/(me atienda|me atiendan|que me atienda|que me atiendan)/.test(s)) return true;     // "que me atienda un asesor"
  if (/(quiero|necesito|dame|deme|requiero)\s+(?:hablar\s+con\s+)?(?:un|una)?\s*(asesor|humano|agente|representante|persona real|operador)/.test(s)) return true;
  if (/(quiero|necesito|pasame|paseme|hablar con|comunicame con|hay algun|con un|con una)[\s\S]{0,18}(persona|humano|asesor|agente|operador)\s*(real|de verdad|de carne)/.test(s)) return true;
  return false;
}

// Clasifica el estado de la conversacion segun el ultimo mensaje del cliente.
// Conservador: solo devuelve un estado nuevo cuando la senal es clara; si no, devuelve null.
async function clasificarEstado(mensajeCliente, user_id) {
  try {
    // ATAJO SIN IA: si el lead pide explicitamente un humano/asesor/persona -> listo_humano seguro (no falla
    // ni gasta token). Resuelve el caso "puedo hablar con una persona real?" que la IA a veces sub-clasificaba.
    if (_pideHumano(mensajeCliente)) return 'listo_humano';
    const prompt = [
      'Sos un clasificador de intencion de un cliente que escribe a una inmobiliaria/hotel por WhatsApp.',
      'Segun el mensaje del cliente, responde UNA sola palabra exacta:',
      '- listo_humano  => si pide hablar con / ser atendido por una persona, asesor, humano, agente o alguien real EN CUALQUIER FORMA, incluso como PREGUNTA (ej: "puedo hablar con una persona real?", "que me atienda un asesor") => SIEMPRE listo_humano, sin importar si pregunto o no por una propiedad. TAMBIEN si CONFIRMA o ACUERDA un paso concreto: ACEPTA o COORDINA una VISITA o cita (da fecha/dia/horario o dice que si a ir a verla), una reserva, sena, compra o alquiler; o quiere AVANZAR la operacion; o pide que lo contacten/llamen.',
      '- interesado    => todavia esta CONSULTANDO sin confirmar: pregunta por una propiedad, precio, disponibilidad, o (en hotel) alojamiento/fechas; pide datos para decidir; pregunta si puede visitar o cuando (SIN acordar todavia una fecha/horario concreto); o dice que le interesa. Basta con que pregunte por algo concreto del negocio.',
      '- sin_cambio    => SOLO si es un saludo inicial sin consulta (hola, buenas) o algo no relacionado al negocio. Si ya pregunto algo concreto, NO es sin_cambio.',
      'CLAVE: la diferencia entre listo_humano e interesado es el COMPROMISO. Si SOLO consulta o muestra interes => interesado. Si ACEPTA/COORDINA una visita, reserva o avanzar la operacion => listo_humano (hay que derivar a un humano). Ante la duda entre interesado y sin_cambio, elegi interesado.',
      'Responde SOLO una de esas tres palabras exactas (listo_humano, interesado o sin_cambio), sin nada mas.',
      'Mensaje del cliente: ' + mensajeCliente
    ].join('\n');
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 20, messages: [{ role: 'user', content: prompt }] });
    try { if (user_id && r && r.usage) await registrarUsoTokens(user_id, r.usage, 'clasificar_estado'); } catch(e){}
    const out = (r.content[0] && r.content[0].type === 'text') ? r.content[0].text.trim().toLowerCase() : '';
    console.log('[CLASIFICADOR] mensaje:', mensajeCliente, '=> respuesta IA:', JSON.stringify(out));
    if (out.includes('listo_humano')) return 'listo_humano';
    if (out.includes('interesado')) return 'interesado';
    return null;
  } catch (e) { console.error('Error clasificando estado:', e && e.message); return null; }
}

// Extrae datos que el LEAD menciona (nombre, origen, interes, presupuesto) para tener MEMORIA y no re-preguntar.
// Mismo patron barato que clasificarEstado/clasificarTemperatura: una llamada chica a Anthropic que devuelve JSON.
// Solo extrae lo que el lead DICE explicitamente; no inventa (campo vacio si no lo menciona).
// datosPrevios se pasan como contexto para no duplicar lo ya sabido. Robusta a errores (try/catch).
async function extraerDatosLead(texto, datosPrevios, user_id) {
  try {
    if (!texto || !texto.trim()) return { nombre: '', origen: '', interes: '', presupuesto: '' };
    const prev = datosPrevios || {};
    const prompt = [
      'Sos un extractor de datos de un cliente que escribe a una inmobiliaria/hotel por WhatsApp.',
      'A partir del MENSAJE del cliente, devolve SOLO un JSON con estos campos (string):',
      '{ "nombre": "", "origen": "", "interes": "", "presupuesto": "" }',
      '- nombre: el nombre de pila/nombre propio SOLO si el cliente lo dice (ej: "soy Juan", "me llamo Ana"). Si no lo dice, "".',
      '- origen: de donde viene o como llego (ej: "Instagram", "Facebook", "un anuncio", "me recomendo un amigo", una ciudad/pais). Si no lo dice, "".',
      '- interes: que busca o le interesa (ej: "departamento 2 ambientes en Palermo", "casa para alquilar", "cabana para 4 personas el finde"). Si no lo dice, "".',
      '- presupuesto: cuanto puede/quiere gastar si lo menciona (ej: "USD 80000", "hasta 200 mil pesos por mes"). Si no lo dice, "".',
      'REGLAS: extrae SOLO lo que el cliente menciona EXPLICITAMENTE en este mensaje. NO inventes ni asumas. Si un dato no aparece, dejalo "".',
      'Responde UNICAMENTE el JSON, sin texto adicional, sin markdown.',
      (prev.nombre || prev.interes || prev.presupuesto) ? ('Datos ya conocidos (no hace falta repetirlos, solo agrega lo nuevo): ' + JSON.stringify({ nombre: prev.nombre || '', interes: prev.interes || '', presupuesto: prev.presupuesto || '' })) : '',
      'Mensaje del cliente: ' + JSON.stringify(texto)
    ].filter(Boolean).join('\n');
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, messages: [{ role: 'user', content: prompt }] });
    try { if (user_id && r && r.usage) await registrarUsoTokens(user_id, r.usage, 'extraer_datos'); } catch(e){}
    let out = (r && r.content && r.content[0] && r.content[0].type === 'text') ? r.content[0].text.trim() : '';
    // por si la IA envuelve en ```json ... ```
    const m = out.match(/\{[\s\S]*\}/);
    if (m) out = m[0];
    let parsed = {};
    try { parsed = JSON.parse(out); } catch (eP) { return { nombre: '', origen: '', interes: '', presupuesto: '' }; }
    const limpiar = function(v){ return (typeof v === 'string') ? v.trim() : ''; };
    return {
      nombre: limpiar(parsed.nombre),
      origen: limpiar(parsed.origen),
      interes: limpiar(parsed.interes),
      presupuesto: limpiar(parsed.presupuesto)
    };
  } catch (e) { console.error('Error extrayendo datos del lead:', e && e.message); return { nombre: '', origen: '', interes: '', presupuesto: '' }; }
}

// True si el mensaje es claramente TRIVIAL (saludo/confirmacion puro, sin datos): no vale gastar una llamada
// de IA para extraerle datos al lead. CONSERVADOR: solo saltea si TODO el mensaje calza (^...$); cualquier
// cosa con palabras de mas (ej "ok, 2 ambientes") NO calza -> se extrae igual. No se pierde ningun dato.
function esMensajeTrivial(t) {
  const s = String(t || '').trim().toLowerCase().replace(/[!.\s]+$/, '');
  if (!s) return true;
  if (s.length < 4) return true;
  return /^(hola+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|ok|oka|okey|okay|dale|listo|gracias|muchas gracias|mil gracias|perfecto|barbaro|joya|genial|buenisimo|si|sii|claro|no|nop|de acuerdo|entendido|ah ok|aja|jaja+|jeje+|ok gracias|👍|🙏|👌|🙌)$/.test(s);
}

// Enviar mensaje de WhatsApp via Evolution
// Verifica si una instancia esta conectada (estado 'open')
async function instanciaConectada(instancia) {
  try {
    const r = await fetch(EVOLUTION_URL + '/instance/connectionState/' + instancia, { headers: { 'apikey': EVOLUTION_KEY } });
    if (!r.ok) return false;
    const j = await r.json();
    const estado = (j && j.instance && j.instance.state) ? j.instance.state : (j && j.state ? j.state : null);
    return estado === 'open';
  } catch (e) { console.error('Error verificando conexion:', e && e.message); return false; }
}

// Envia mensaje de WhatsApp via Evolution. Devuelve true si salio, false si fallo.
// Verifica la conexion ANTES de enviar para no dar por enviado algo que no salio.
// ===== FASE 3: REALISMO HUMANO =====
// Espera aleatoria (ms)
function esperar(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
function aleatorio(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// Muestra el estado 'escribiendo...' en el chat del lead via Evolution
async function mostrarEscribiendo(instancia, numero, ms) {
  try {
    await fetch(EVOLUTION_URL + '/chat/sendPresence/' + instancia, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({ number: numero, presence: 'composing', delay: ms })
    });
  } catch (e) { /* si falla, no rompe el envio */ }
}

// Marca como leidos los mensajes del lead (tildes azules)
async function marcarLeido(instancia, key) {
  try {
    if (!key || !key.remoteJid || !key.id) return;
    await fetch(EVOLUTION_URL + '/chat/markMessageAsRead/' + instancia, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({ readMessages: [ { remoteJid: key.remoteJid, fromMe: key.fromMe === true, id: key.id } ] })
    });
  } catch (e) { /* no rompe nada */ }
}

// Parte un texto en 1-3 mensajes de forma ALEATORIA, cortando por frases completas
function partirMensaje(texto) {
  const t = String(texto || '').trim();
  if (!t) return [t];
  // separar en frases por punto, signo de exclamacion/pregunta, o salto de linea
  const frases = t.split(/(?<=[.!?\n])\s+/).map(function(f){ return f.trim(); }).filter(Boolean);
  if (frases.length <= 1) return [t];
  // decidir aleatoriamente en cuantos mensajes (1, 2 o 3, sin pasar la cant de frases)
  const maxMsgs = Math.min(3, frases.length);
  const cantMsgs = aleatorio(1, maxMsgs);
  if (cantMsgs === 1) return [t];
  // repartir las frases en 'cantMsgs' grupos de forma despareja pero natural
  const grupos = []; let idx = 0;
  const porGrupo = Math.ceil(frases.length / cantMsgs);
  for (let i = 0; i < cantMsgs; i++) {
    const trozo = frases.slice(idx, idx + porGrupo);
    if (trozo.length) grupos.push(trozo.join(' '));
    idx += porGrupo;
  }
  // si quedaron frases sueltas, agregarlas al ultimo grupo
  if (idx < frases.length) grupos[grupos.length - 1] += ' ' + frases.slice(idx).join(' ');
  return grupos.filter(Boolean);
}
// Quita emojis/emoticonos del texto. Se usa cuando el tenant los tiene DESACTIVADOS: no alcanza con pedirselo a la IA en el prompt, a veces igual los mete.
function quitarEmojis(t) {
  return String(t || '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .trim();
}
// Traduce un texto a un idioma destino usando el modelo. Devuelve el texto traducido (o el original si falla).
async function traducir(texto, idiomaDestino, user_id) {
  try {
    if (!texto || !idiomaDestino) return texto;
    const NOMBRES = { es: 'espanol', en: 'ingles', pt: 'portugues', fr: 'frances', it: 'italiano', de: 'aleman', nl: 'holandes', ru: 'ruso', zh: 'chino mandarin', ja: 'japones', ko: 'coreano', ar: 'arabe', hi: 'hindi', tr: 'turco', pl: 'polaco' };
    const destino = NOMBRES[idiomaDestino] || idiomaDestino;
    const comp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: 'Sos un traductor profesional. Traduci el texto del usuario al ' + destino + '. Reglas: devolve UNICAMENTE la traduccion, sin comillas, sin explicaciones, sin notas. Manten el tono, la intencion y el estilo informal o formal del original. No agregues ni quites informacion. Si el texto incluye una palabra o expresion dicha a proposito en otro idioma (un saludo, una marca, un termino comun), mantenela como esta en lugar de forzar su traduccion. Traduci el sentido natural, no palabra por palabra.',
      messages: [ { role: 'user', content: texto } ]
    });
    try { if (user_id && comp && comp.usage) await registrarUsoTokens(user_id, comp.usage, 'traducir'); } catch(e){}
    const out = (comp && comp.content && comp.content[0] && comp.content[0].text) ? comp.content[0].text.trim() : '';
    return out || texto;
  } catch (e) { console.error('Error traduciendo:', e && e.message); return texto; }
}

// Detecta el idioma de un texto. Devuelve un codigo (es/en/pt/de/it/fr) o 'es' por defecto.
async function detectarIdioma(texto, user_id) {
  try {
    if (!texto || texto.trim().length < 2) return 'es';
    const comp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      system: 'Detecta el idioma PRINCIPAL del texto del usuario, el idioma en el que esta escrito la mayor parte. Mira la ORACION completa, no palabras aisladas. Si el mensaje entero es un saludo o frase corta (ej. hi, hello, bonjour, hallo), ESE es el idioma. Solo si dentro de una oracion larga hay una palabra prestada de otro idioma, ignora esa palabra y usa el idioma dominante de la oracion. Responde SOLO con el codigo de dos letras del idioma (es, en, pt, fr, it, de, nl, ru, zh, ja, ko, ar, hi, tr, pl, u otro codigo ISO 639-1 si corresponde). Nada mas.',
      messages: [ { role: 'user', content: texto } ]
    });
    try { if (user_id && comp && comp.usage) await registrarUsoTokens(user_id, comp.usage, 'detectar_idioma'); } catch(e){}
    const out = (comp && comp.content && comp.content[0] && comp.content[0].text) ? comp.content[0].text.trim().toLowerCase().substring(0,2) : 'es';
    return ['es','en','pt','fr','it','de','nl','ru','zh','ja','ko','ar','hi','tr','pl'].indexOf(out) >= 0 ? out : 'es';
  } catch (e) { return 'es'; }
}
async function enviarWhatsapp(instancia, numero, texto, messageId) {
  async function registrar(ok) {
    if (!messageId) return;
    try { await supabase.from('messages').update({ estado_envio: ok ? 'enviado' : 'fallido' }).eq('id', messageId); } catch (e) { console.error('No se pudo registrar estado_envio:', e && e.message); }
  }
  if (!EVOLUTION_URL || !EVOLUTION_KEY) { console.error('Faltan EVOLUTION_URL o EVOLUTION_KEY'); await registrar(false); return false; }
  const conectada = await instanciaConectada(instancia);
  if (!conectada) { console.error('No se envia: instancia no conectada (' + instancia + ')'); await registrar(false); return false; }
  // envio con realismo humano: partir en mensajes y simular escritura
  try {
    const partes = partirMensaje(texto);
    let algunoFallo = false;
    for (let i = 0; i < partes.length; i++) {
      const parte = partes[i];
      // tiempo de tipeo aleatorio segun largo: ~40-70ms por caracter, con tope y piso
      const base = Math.min(6000, Math.max(1200, parte.length * aleatorio(40, 70)));
      const tipeo = base + aleatorio(0, 800);
      await mostrarEscribiendo(instancia, numero, tipeo);
      const resp = await fetch(EVOLUTION_URL + '/message/sendText/' + instancia, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
        body: JSON.stringify({ number: numero, text: parte, delay: tipeo, presence: 'composing' })
      });
      if (!resp.ok) { const t = await resp.text(); console.error('Error enviando WhatsApp:', resp.status, t); algunoFallo = true; }
      // pequena pausa entre mensajes (no en el ultimo)
      if (i < partes.length - 1) await esperar(aleatorio(400, 1200));
    }
    await registrar(!algunoFallo);
    return !algunoFallo;
  } catch (e) { console.error('Excepcion enviando WhatsApp:', e && e.message); await registrar(false); return false; }
}
app.get('/health', (req, res) => { res.json({ status: 'ok', app: 'Raices CRM' }); });
app.get('/', (req, res) => { res.json({ message: 'Raices CRM API', status: 'online' }); });

// Endpoint para probar el agente desde el CRM (escribir como cliente)
app.post('/api/agent/respond', async (req, res) => {
  try {
    const { user_id, conversation_id, message } = req.body || {};
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== user_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!user_id || !message) return res.status(400).json({ error: 'Faltan user_id o message' });
    // Guardar el mensaje del contacto (cuando se prueba desde el CRM)
    if (conversation_id) {
      await supabase.from('messages').insert({ conversation_id: conversation_id, user_id: user_id, role: 'contact', content: message });
    }
    const resultado = await generarRespuestaAgente(user_id, conversation_id, message);
    res.json(resultado);
  } catch (err) {
    console.error('Error en /api/agent/respond:', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Error interno' });
  }
});

// ============ WEBHOOK ENTRANTE DE WHATSAPP (Evolution API) ============
async function enviarReportesProgramados() {
  try {
    const { data: cuentas } = await supabase.from('business_settings').select('user_id, reportes_config').not('reportes_config', 'is', null);
    if (!cuentas || !cuentas.length) return;
    const ahora = new Date();
    const hoyStr = ahora.toISOString().substring(0, 10); // YYYY-MM-DD
    const diaSemana = ahora.getDay(); // 0=domingo, 1=lunes
    const diaMes = ahora.getDate();
    const hora = ahora.getHours();
    // La hora de envio la define cada cuenta (cfg.hora). Se compara dentro del loop.
    for (const cta of cuentas) {
      const cfg = cta.reportes_config || {};
      if (!cfg.whatsapp) continue;
      // Respetar la hora de envio configurada por la cuenta (formato HH:MM). Solo comparamos la hora.
      const horaCfg = (cfg.hora && /^[0-9]{1,2}:/.test(cfg.hora)) ? parseInt(cfg.hora.split(':')[0], 10) : 9;
      if (hora !== horaCfg) continue;
      const envios = cfg.ultimo_envio || {};
      let toca = null;
      if (cfg.diario && envios.diario !== hoyStr) toca = 'diario';
      else if (cfg.semanal && diaSemana === 1 && envios.semanal !== hoyStr) toca = 'semanal';
      else if (cfg.mensual && diaMes === 1 && envios.mensual !== hoyStr) toca = 'mensual';
      if (!toca) continue;
      try {
        const textoReporte = await generarReporteAdmin(cta.user_id, cfg);
        const encabezado = (toca === 'diario' ? 'Reporte diario' : toca === 'semanal' ? 'Reporte semanal' : 'Reporte mensual');
        await enviarWhatsapp(nombreInstancia(cta.user_id), cfg.whatsapp, encabezado + String.fromCharCode(10) + String.fromCharCode(10) + textoReporte);
        // marcar como enviado
        const nuevosEnvios = Object.assign({}, envios);
        nuevosEnvios[toca] = hoyStr;
        const nuevaCfg = Object.assign({}, cfg, { ultimo_envio: nuevosEnvios });
        await supabase.from('business_settings').update({ reportes_config: nuevaCfg }).eq('user_id', cta.user_id);
      } catch (e) { /* seguir con la siguiente cuenta */ }
    }
  } catch (e) { /* silencioso */ }
}

async function guardarSnapshotDiario() {
  try {
    const hoyStr = new Date().toISOString().substring(0, 10);
    // traer todas las conversaciones agrupando por user_id
    const { data: convs } = await supabase.from('conversations').select('user_id, status');
    if (!convs || !convs.length) return;
    // agrupar por user_id
    const porUser = {};
    for (const cv of convs) {
      if (!cv.user_id) continue;
      if (!porUser[cv.user_id]) porUser[cv.user_id] = { conversaciones:0, interesados:0, listo_humano:0, cierres:0, recontactos:0 };
      const u = porUser[cv.user_id];
      u.conversaciones++;
      if (cv.status === 'interesado') u.interesados++;
      else if (cv.status === 'listo_humano') u.listo_humano++;
      else if (cv.status === 'cerrado') u.cierres++;
      else if (cv.status === 'recontacto') u.recontactos++;
    }
    // contar mensajes por user (una query por user para no traer todo)
    for (const uid of Object.keys(porUser)) {
      let totalMsgs = 0;
      try {
        const { count } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('user_id', uid);
        totalMsgs = count || 0;
      } catch (e) { totalMsgs = 0; }
      const m = porUser[uid];
      await supabase.from('reportes_snapshots').upsert({
        user_id: uid, fecha: hoyStr,
        conversaciones: m.conversaciones, interesados: m.interesados, listo_humano: m.listo_humano,
        cierres: m.cierres, recontactos: m.recontactos, mensajes: totalMsgs
      }, { onConflict: 'user_id,fecha' });
    }
  } catch (e) { /* silencioso */ }
}

async function generarReporteAdmin(user_id, cfg) {
  // cfg = reportes_config (info: que incluir). Devuelve texto ASCII del reporte.
  const info = (cfg && cfg.info) || {};
  const lineas = [];
  lineas.push('*Reporte Raices CRM*');
  lineas.push('');
  try {
    // traer conversaciones del user con su status
    const { data: convs } = await supabase.from('conversations').select('status').eq('user_id', user_id);
    const lista = convs || [];
    const cuenta = function(st){ return lista.filter(function(x){ return x.status === st; }).length; };
    if (info.conversaciones_nuevas) lineas.push('Conversaciones totales: ' + lista.length);
    if (info.interesados) lineas.push('Interesados: ' + cuenta('interesado'));
    if (info.listo_humano) lineas.push('Listos para humano: ' + cuenta('listo_humano'));
    if (info.cierres) lineas.push('Cierres: ' + cuenta('cerrado'));
    if (info.recontactos) lineas.push('En recontacto: ' + cuenta('recontacto'));
    if (info.mensajes) {
      const { count } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('user_id', user_id);
      lineas.push('Mensajes totales: ' + (count || 0));
    }
  } catch (e) {
    lineas.push('(No se pudieron cargar todos los datos)');
  }
  lineas.push('');
  lineas.push('Generado: ' + new Date().toLocaleString('es-AR'));
  return lineas.join(String.fromCharCode(10));
}

// El admin pregunta por WhatsApp lo que necesite; la IA responde con los datos reales del tenant.
async function responderConsultaAdmin(user_id, pregunta) {
  try {
    const resConv = await supabase.from('conversations').select('id, status, asesor_id').eq('user_id', user_id);
    const resAse = await supabase.from('asesores').select('id, nombre, usuario, activo').eq('admin_id', user_id);
    const resCont = await supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('user_id', user_id);
    const lista = resConv.data || [];
    const ases = resAse.data || [];
    const convAsesor = {}; lista.forEach(function (c) { convAsesor[c.id] = c.asesor_id; });
    const porEstado = {}; lista.forEach(function (c) { porEstado[c.status] = (porEstado[c.status] || 0) + 1; });
    const asignados = {}; lista.forEach(function (c) { if (c.asesor_id) asignados[c.asesor_id] = (asignados[c.asesor_id] || 0) + 1; });
    // METRICAS POR ASESOR (additivo): cierres y leads "calientes" (interesado/listo_humano) por asesor, para % de conversion.
    const cerradosAsesor = {}, calientesAsesor = {};
    lista.forEach(function (c) {
      if (!c.asesor_id) return;
      if (c.status === 'cerrado') cerradosAsesor[c.asesor_id] = (cerradosAsesor[c.asesor_id] || 0) + 1;
      if (c.status === 'interesado' || c.status === 'listo_humano') calientesAsesor[c.asesor_id] = (calientesAsesor[c.asesor_id] || 0) + 1;
    });
    // Tiempos de respuesta (contact -> human) y ultima actividad, ultimos 30 dias
    const hace30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const resMsg = await supabase.from('messages').select('conversation_id, role, created_at').eq('user_id', user_id).gte('created_at', hace30).order('created_at', { ascending: true }).limit(4000);
    const lastContact = {}, respSum = {}, respCnt = {}, lastHuman = {};
    (resMsg.data || []).forEach(function (m) {
      const cv = m.conversation_id, t = new Date(m.created_at).getTime(), asid = convAsesor[cv];
      if (m.role === 'contact') { if (lastContact[cv] == null) lastContact[cv] = t; }
      else if (m.role === 'human') {
        if (lastContact[cv] != null && asid) { const gap = t - lastContact[cv]; if (gap > 0 && gap < 7 * 24 * 3600 * 1000) { respSum[asid] = (respSum[asid] || 0) + gap; respCnt[asid] = (respCnt[asid] || 0) + 1; } }
        lastContact[cv] = null; if (asid) lastHuman[asid] = Math.max(lastHuman[asid] || 0, t);
      }
    });
    function fmtDur(ms) { const min = Math.round(ms / 60000); if (min < 60) return min + ' min'; return Math.floor(min / 60) + 'h ' + (min % 60) + 'm'; }
    const resumenAses = ases.map(function (a) {
      const asig = asignados[a.id] || 0;
      const cerr = cerradosAsesor[a.id] || 0;
      const conv = asig > 0 ? Math.round((cerr / asig) * 100) : 0;
      return {
        nombre: a.nombre || a.usuario, activo: a.activo,
        leads_asignados: asig,
        leads_cerrados: cerr,
        leads_calientes: calientesAsesor[a.id] || 0,
        porcentaje_conversion: asig > 0 ? (conv + '%') : 'sin leads',
        tiempo_respuesta_promedio: respCnt[a.id] ? fmtDur(respSum[a.id] / respCnt[a.id]) : 'sin datos',
        ultima_actividad: lastHuman[a.id] ? new Date(lastHuman[a.id]).toLocaleString('es-AR') : 'sin actividad reciente'
      };
    });
    // COMPARATIVA ENTRE ASESORES (additivo): ranking simple por conversion y por velocidad de respuesta.
    let comparativaAsesores = null;
    try {
      const conLeads = resumenAses.filter(function (a) { return a.leads_asignados > 0; });
      const porConv = conLeads.slice().sort(function (x, y) { return parseInt(y.porcentaje_conversion) - parseInt(x.porcentaje_conversion); });
      const conTiempo = resumenAses.filter(function (a) { return a.tiempo_respuesta_promedio !== 'sin datos'; });
      const idPorNombre = {}; ases.forEach(function (a) { idPorNombre[a.nombre || a.usuario] = a.id; });
      const porVel = conTiempo.slice().sort(function (x, y) {
        return (respSum[idPorNombre[x.nombre]] / respCnt[idPorNombre[x.nombre]]) - (respSum[idPorNombre[y.nombre]] / respCnt[idPorNombre[y.nombre]]);
      });
      comparativaAsesores = {
        mejor_conversion: porConv.length ? (porConv[0].nombre + ' (' + porConv[0].porcentaje_conversion + ')') : 'sin datos',
        mas_rapido_en_responder: porVel.length ? (porVel[0].nombre + ' (' + porVel[0].tiempo_respuesta_promedio + ')') : 'sin datos',
        ranking_conversion: porConv.map(function (a) { return a.nombre + ': ' + a.porcentaje_conversion + ' (' + a.leads_cerrados + '/' + a.leads_asignados + ')'; })
      };
    } catch (eCmp) { /* la comparativa es best-effort */ }
    // MATCHING PROPIEDAD<->LEAD (additivo, best-effort): leads que buscaban algo similar a las propiedades activas y NO cerraron.
    let matchingPropLead = null;
    try {
      const resProps = await supabase.from('properties').select('id, numero, title, type, zone, price, operation').eq('user_id', user_id).eq('activa', true).limit(200);
      const resLeads = await supabase.from('contacts').select('id, name, interest, budget, notes').eq('user_id', user_id).limit(2000);
      const props = resProps.data || [];
      const leads = resLeads.data || [];
      // Solo leads de conversaciones NO cerradas (abiertas/calientes). contact_id -> mejor status.
      const resConvC = await supabase.from('conversations').select('contact_id, status').eq('user_id', user_id);
      const estadoContacto = {};
      (resConvC.data || []).forEach(function (c) { if (c.contact_id) estadoContacto[c.contact_id] = c.status; });
      const norm = function (s) { return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); };
      const tokensZona = function (s) { return norm(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 4; }); };
      const numPresupuesto = function (s) { const m = norm(s).replace(/\./g, '').match(/\d{4,}/g); return m ? m.map(Number) : []; };
      const matches = [];
      props.forEach(function (p) {
        const zonaP = norm(p.zone), tipoP = norm(p.type), tokP = tokensZona(p.zone);
        const precioP = typeof p.price === 'number' ? p.price : Number(String(p.price || '').replace(/[^0-9]/g, '')) || 0;
        const candidatos = [];
        leads.forEach(function (l) {
          const est = estadoContacto[l.id];
          if (est === 'cerrado') return; // ya cerro: no nos interesa
          if (est == null) return; // sin conversacion registrada: lo salteamos
          const texto = norm((l.interest || '') + ' ' + (l.notes || '') + ' ' + (l.budget || ''));
          if (!texto.trim()) return;
          let score = 0; const motivos = [];
          if (zonaP && (texto.indexOf(zonaP) >= 0)) { score += 2; motivos.push('zona'); }
          else if (tokP.some(function (t) { return texto.indexOf(t) >= 0; })) { score += 1; motivos.push('zona~'); }
          if (tipoP && texto.indexOf(tipoP) >= 0) { score += 1; motivos.push('tipo'); }
          if (precioP > 0) {
            const presup = numPresupuesto((l.budget || '') + ' ' + (l.interest || ''));
            if (presup.some(function (n) { return n >= precioP * 0.8 && n <= precioP * 1.3; })) { score += 1; motivos.push('presupuesto'); }
          }
          if (score >= 1) candidatos.push({ lead: l.name || ('contacto ' + l.id), estado: est, motivos: motivos.join('+'), score: score });
        });
        if (candidatos.length) {
          candidatos.sort(function (a, b) { return b.score - a.score; });
          matches.push({
            propiedad: (p.numero ? ('#' + p.numero + ' ') : '') + (p.title || p.type || 'propiedad') + (p.zone ? (' en ' + p.zone) : ''),
            operacion: p.operation || null,
            leads_interesados_no_cerrados: candidatos.slice(0, 5).map(function (c) { return c.lead + ' (' + c.estado + ', match: ' + c.motivos + ')'; })
          });
        }
      });
      matchingPropLead = matches.slice(0, 15);
    } catch (eMatch) { console.error('matching prop-lead:', eMatch && eMatch.message); /* best-effort: no rompe el reporte */ }
    const datos = { contactos_totales: resCont.count || 0, conversaciones_totales: lista.length, conversaciones_por_estado: porEstado, asesores: resumenAses };
    if (comparativaAsesores) datos.comparativa_asesores = comparativaAsesores;
    if (matchingPropLead && matchingPropLead.length) datos.matching_propiedad_lead = matchingPropLead;
    const sys = 'Sos el asistente de reportes de un CRM inmobiliario. El ADMINISTRADOR te hace una consulta por WhatsApp. Responde SOLO con los datos provistos (el JSON de abajo), en espanol rioplatense, claro y conciso, en formato WhatsApp (texto plano, podes usar *negrita* y saltos de linea, sin tablas). Si te piden un dato que no esta en los datos, deci que no lo tenes disponible. Nunca inventes numeros.';
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 700, system: sys, messages: [{ role: 'user', content: 'Datos actuales del CRM:\n' + JSON.stringify(datos, null, 1) + '\n\nConsulta del administrador: ' + pregunta }] });
    try { if (user_id && r && r.usage) await registrarUsoTokens(user_id, r.usage, 'reporte_admin'); } catch(e){}
    return (r && r.content && r.content[0] && r.content[0].text) ? r.content[0].text : 'No pude generar el reporte.';
  } catch (e) { console.error('responderConsultaAdmin:', e && e.message); return 'No pude generar el reporte en este momento.'; }
}

app.post('/api/webhook/whatsapp', async (req, res) => {
  res.json({ received: true });
  try {
    const body = req.body || {};
    const evento = body.event || '';
    if (evento !== 'messages.upsert') return;

    const data = body.data || {};
    const instanciaNombre = body.instance || data.instanceName || '';
    // SEGURIDAD: validar que la instancia tenga el formato esperado de Raices CRM
    if (!instanciaNombre || instanciaNombre.indexOf('cliente_') !== 0) return;
    if (!instanciaNombre) return;

    const key = data.key || {};
    const esFromMe = key.fromMe === true; // mensaje saliente propio: se maneja tras extraer el texto

    const remoteJid = key.remoteJid || '';
    if (!remoteJid || remoteJid.includes('@g.us')) return; // ignorar grupos
    const telefono = remoteJid.split('@')[0];

    const msg = data.message || {};
    let texto = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || '';
    // Detectar multimedia entrante
    let tipoMediaEntrante = null;
    if (msg.imageMessage) { tipoMediaEntrante = 'imagen'; if (!texto) texto = msg.imageMessage.caption || '[imagen]'; }
    else if (msg.audioMessage) { tipoMediaEntrante = 'audio'; if (!texto) texto = '[audio]'; }
    else if (msg.videoMessage) { tipoMediaEntrante = 'video'; if (!texto) texto = msg.videoMessage.caption || '[video]'; }
    else if (msg.documentMessage) { tipoMediaEntrante = 'documento'; if (!texto) texto = (msg.documentMessage && msg.documentMessage.fileName) ? ('[documento] ' + msg.documentMessage.fileName) : '[documento]'; }
    else if (msg.documentWithCaptionMessage) { tipoMediaEntrante = 'documento'; if (!texto) texto = '[documento]'; }
    if (!texto && !tipoMediaEntrante) return;

    // Mensaje saliente escrito por un humano desde su WhatsApp: guardarlo con marca y cortar.
    if (esFromMe) {
      await guardarMensajeSaliente(remoteJid, texto);
      return;
    }

    // Marcar el mensaje entrante como leido (tildes azules)
    marcarLeido(instanciaNombre, key);

    // 1) Identificar el user_id dueno de esta instancia (multi-cliente)
    const { data: inst } = await supabase.from('whatsapp_instancias').select('user_id').eq('instancia_nombre', instanciaNombre).maybeSingle();
    if (!inst) { console.error('Instancia sin user_id:', instanciaNombre); return; }
    const user_id = inst.user_id;

    // === REPORTE AL ADMIN: si quien escribe es el numero de reportes del dueno y pide reporte ===
    try {
      const { data: bsRep } = await supabase.from('business_settings').select('reportes_config, crm_pausado, eliminado_at').eq('user_id', user_id).maybeSingle();
      const repCfg = bsRep && bsRep.reportes_config ? bsRep.reportes_config : null;
      if (repCfg && repCfg.whatsapp) {
        const soloNumRep = String(repCfg.whatsapp).replace(/[^0-9]/g, '');
        const soloNumTel = String(telefono).replace(/[^0-9]/g, '');
        // comparar por los ultimos 8 digitos (evita lios de prefijos/0/15)
        const coincide = soloNumRep.length >= 8 && soloNumTel.length >= 8 && soloNumRep.slice(-8) === soloNumTel.slice(-8);
        if (coincide && texto && !tipoMediaEntrante) {
          // Pausa total del Maestro o cliente en papelera: NO gastar tokens ni siquiera en el canal de reportes.
          if (bsRep && (bsRep.crm_pausado === true || bsRep.eliminado_at)) return;
          const respuestaAdmin = await responderConsultaAdmin(user_id, texto);
          await enviarWhatsapp(instanciaNombre, telefono, respuestaAdmin);
          return; // el numero del admin es canal de reportes; no se procesa como lead
        }
      }
    } catch (e) { /* si falla el reporte, seguir con el flujo normal */ }

    // 2) Buscar contacto por telefono dentro del user_id (persistencia: no duplicar)
    // FLUJO PRINCIPAL: el lookup/insert que da el id del contacto usa la PROYECCION MINIMA SEGURA
    // (solo 'id'). Asi, aunque faltara alguna columna de enriquecimiento (name/interest/budget/notes),
    // el agente sigue respondiendo: el flujo NUNCA depende de esas columnas.
    let contacto;
    const _pushName = data.pushName || telefono;
    const { data: existente } = await supabase.from('contacts').select('id').eq('user_id', user_id).eq('phone', telefono).maybeSingle();
    if (existente) { contacto = existente; }
    else {
      const { data: nuevo } = await supabase.from('contacts').insert({ user_id: user_id, name: _pushName, phone: telefono, channel: 'whatsapp' }).select('id').single();
      contacto = nuevo;
    }
    if (!contacto) return;
    // ENRIQUECIMIENTO best-effort: leer name/interest/budget/notes para la memoria del lead.
    // Si este select falla (p.ej. faltara una columna), NO aborta el webhook: solo se pierde el
    // enriquecimiento opcional y el contacto queda con esos campos en null/undefined.
    try {
      const { data: _enr } = await supabase.from('contacts').select('name, interest, budget, notes').eq('id', contacto.id).maybeSingle();
      if (_enr) {
        contacto.name = _enr.name;
        contacto.interest = _enr.interest;
        contacto.budget = _enr.budget;
        contacto.notes = _enr.notes;
      }
    } catch (eEnr) { console.error('enriquecimiento contacto (best-effort):', eEnr && eEnr.message); }

    // 3) Buscar o crear conversacion
    let conv;
    const { data: convExistente } = await supabase.from('conversations').select('id, ai_enabled, status, estado_previo, idioma_lead, asesor_id').eq('user_id', user_id).eq('contact_id', contacto.id).maybeSingle();
    if (convExistente) { conv = convExistente; }
    else {
      const asesorAsignado = await elegirAsesorActivo(user_id);
      const { data: convNueva } = await supabase.from('conversations').insert({ user_id: user_id, contact_id: contacto.id, channel: 'whatsapp', status: 'en_conversacion', ai_enabled: true, asesor_id: asesorAsignado, ultimo_asesor_id: asesorAsignado }).select('id, ai_enabled, asesor_id').single();
      conv = convNueva;
    }
    if (!conv) return;

    // ===== GATE TEMPRANO (antes de gastar 1 solo token de IA) =====
    // La pausa TOTAL del Maestro (crm_pausado) y la papelera (eliminado_at) cortan ACA, ANTES de transcribir
    // (Groq) y de traducir/clasificar/responder (Claude) -> CERO gasto de tokens. La pausa POR-CONVERSACION
    // (ai_enabled) NO entra aca: esa deja transcribir+traducir para el humano y solo frena al agente (mas abajo).
    let _bsGate = null;
    { const _gq = await supabase.from('business_settings').select('crm_pausado, eliminado_at').eq('user_id', user_id).maybeSingle();
      if (_gq && _gq.error) { const _gq2 = await supabase.from('business_settings').select('crm_pausado').eq('user_id', user_id).maybeSingle(); _bsGate = _gq2 && _gq2.data; }
      else { _bsGate = _gq && _gq.data; } }
    // Papelera (eliminado_at) o pausa TOTAL del Maestro (crm_pausado): NO se gasta ningun token de IA.
    // Guardamos el mensaje CRUDO (sin transcribir ni traducir) para que el chat siga visible al reactivar/restaurar,
    // subimos el archivo si lo hay (Storage no gasta tokens) y cortamos. Diferencia: en pausa total avisamos al
    // asesor por push (un humano debe atender; el push es FCM, NO gasta tokens); en papelera no (cliente removido).
    const _enPapelera = !!(_bsGate && _bsGate.eliminado_at);
    // Pausa TOTAL = pausa de ESTE cliente (crm_pausado) O kill-switch GLOBAL del Maestro (_pausaGlobal, cache en memoria
    // refrescada c/30s; NO hace query por mensaje). El kill-switch global frena el gasto de IA de TODOS los clientes a la vez.
    const _enPausaTotal = !!(_pausaGlobal === true) || !!(_bsGate && _bsGate.crm_pausado === true);
    if (_enPapelera || _enPausaTotal) {
      let _mU = null, _mT = null;
      if (tipoMediaEntrante) { try { const _ms = await subirMediaAStorage(instanciaNombre, data, tipoMediaEntrante, true); if (_ms) { _mU = _ms.url; _mT = _ms.tipo; } } catch (e) {} }
      try {
        await supabase.from('messages').insert({ conversation_id: conv.id, user_id: user_id, role: 'contact', content: texto, media_url: _mU, media_tipo: _mT });
        await supabase.from('conversations').update({ last_message: texto, last_role: 'contact', updated_at: new Date().toISOString() }).eq('id', conv.id);
      } catch (e) { console.error('guardar msg (pausa total/papelera):', e && e.message); }
      if (_enPausaTotal) {
        // Pausa total: avisar al asesor humano (FCM, sin tokens) para que atienda en lugar de la IA.
        try {
          const _asesorRowId = conv.asesor_id || (convExistente && convExistente.asesor_id) || null;
          if (_asesorRowId) {
            const { data: _ase } = await supabase.from('asesores').select('auth_user_id').eq('id', _asesorRowId).maybeSingle();
            if (_ase && _ase.auth_user_id) { await enviarPushAsesor(_ase.auth_user_id, _pushName, texto); }
          }
        } catch (ePush) { console.error('push asesor (pausa total):', ePush && ePush.message); }
      }
      return;
    }

    // 4) Guardar SIEMPRE el mensaje entrante (no se pierde nada)
    // MEDIA ENTRANTE: subir a Storage ANTES de traducir/IA. Si es audio y hay Groq, subirMediaAStorage
    // ademas transcribe (reusando el base64 ya bajado, sin segunda descarga). Si vino transcripcion,
    // reemplazamos el '[audio]' por el texto real ANTES de armar contentLead -> asi la IA y el traductor
    // procesan el audio como si fuera un mensaje escrito. Fallback total: si falta GROQ_KEY o falla la
    // transcripcion, 'texto' sigue siendo '[audio]' (comportamiento exacto de hoy).
    let mediaSubido = null;
    if (tipoMediaEntrante) {
      try { mediaSubido = await subirMediaAStorage(instanciaNombre, data, tipoMediaEntrante); } catch (eMedia) { console.error('subir media lead:', eMedia && eMedia.message); }
      if (tipoMediaEntrante === 'audio' && mediaSubido && mediaSubido.transcripcion) {
        texto = mediaSubido.transcripcion;
      }
    }
    // Traduccion entrante: detectar idioma del lead y traducir al espanol para el asesor
    let contentLead = texto;
    let contentOrigLead = null;
    let idiomaLeadMsg = null;
    // Traducir SOLO texto/audio/imagen; NO traducir videos ni documentos.
    const _noTraducir = (tipoMediaEntrante === 'imagen' || tipoMediaEntrante === 'video' || tipoMediaEntrante === 'documento');
    try {
      // El traductor es feature de plan (Pro+). El Basico NO traduce (se guarda el mensaje en su idioma original;
      // un humano lo atiende). El AUDIO en cambio NO se gatea (Groq, casi gratis) -> queda en todos los planes.
      if (!_noTraducir && await planPermite(user_id, 'audio_traduccion')) {
        const idiomaDetectado = await detectarIdioma(texto, user_id);
        if (idiomaDetectado && idiomaDetectado !== 'es') {
          const trad = await traducir(texto, 'es', user_id);
          if (trad && trad !== texto) { contentLead = trad; contentOrigLead = texto; idiomaLeadMsg = idiomaDetectado; }
          // recordar el idioma del lead en la conversacion para el traductor saliente
          await supabase.from('conversations').update({ idioma_lead: idiomaDetectado }).eq('id', conv.id);
          if (conv) conv.idioma_lead = idiomaDetectado;
        }
      }
    } catch (eTrad) { console.error('trad entrante:', eTrad && eTrad.message); }
    let mediaUrlLead = null; let mediaTipoLead = null;
    if (mediaSubido) { mediaUrlLead = mediaSubido.url; mediaTipoLead = mediaSubido.tipo; }
    await supabase.from('messages').insert({ conversation_id: conv.id, user_id: user_id, role: 'contact', content: contentLead, content_original: contentOrigLead, idioma: idiomaLeadMsg, media_url: mediaUrlLead, media_tipo: mediaTipoLead });
    // Si el lead escribe en un idioma distinto al base, activar el traductor automaticamente
    const _updConv = { last_message: texto, last_role: 'contact', updated_at: new Date().toISOString() };
    if (idiomaLeadMsg) { _updConv.idioma_lead = idiomaLeadMsg; _updConv.traductor_activo = true; }
    await supabase.from('conversations').update(_updConv).eq('id', conv.id);

    // === MEMORIA DEL LEAD: extraer datos (nombre/origen/interes/presupuesto) y guardarlos en contacts ===
    // NO bloquea el flujo (mismo criterio que clasificarEstado/clasificarTemperatura): fire-and-forget.
    // Solo para mensajes de texto (no media). Usa contentLead (ya traducido a espanol) para extraer bien.
    if (!tipoMediaEntrante && contentLead && contentLead.trim() && !esMensajeTrivial(contentLead)) {
      (async function(){
        try {
          const datosPrevios = { nombre: contacto.name, interes: contacto.interest, presupuesto: contacto.budget };
          const ext = await extraerDatosLead(contentLead, datosPrevios, user_id);
          if (!ext) return;
          const updContacto = {};
          // nombre: solo si el lead dio un nombre real Y el actual parece el pushName de WhatsApp
          // (el pushName es el que vino de Evolution; si el name guardado coincide con el pushName, todavia no tenemos el nombre real que dio el lead)
          if (ext.nombre && (!contacto.name || contacto.name === _pushName)) {
            updContacto.name = ext.nombre;
          }
          // interest / budget: completar/actualizar si el lead aporto algo
          if (ext.interes) updContacto.interest = ext.interes;
          if (ext.presupuesto) updContacto.budget = ext.presupuesto;
          // origen (y nombre, si no fue a la columna name) van a notes: append corto sin pisar lo que haya
          const notasNuevas = [];
          if (ext.origen) notasNuevas.push('origen: ' + ext.origen);
          if (ext.nombre && !updContacto.name) notasNuevas.push('dice llamarse: ' + ext.nombre);
          if (notasNuevas.length > 0) {
            const notasPrev = (contacto.notes && String(contacto.notes).trim()) ? String(contacto.notes).trim() : '';
            const aAgregar = notasNuevas.filter(function(n){ return notasPrev.indexOf(n) === -1; });
            if (aAgregar.length > 0) {
              updContacto.notes = (notasPrev ? (notasPrev + ' | ') : '') + aAgregar.join(' | ');
            }
          }
          if (Object.keys(updContacto).length > 0) {
            await supabase.from('contacts').update(updContacto).eq('id', contacto.id);
          }
        } catch (eMem) { console.error('memoria lead:', eMem && eMem.message); }
      })();
    }

    // === Notificacion push al asesor asignado (por cada mensaje entrante) ===
    try {
      const _asesorRowId = conv.asesor_id || (convExistente && convExistente.asesor_id) || null;
      if (_asesorRowId) {
        const { data: _ase } = await supabase.from('asesores').select('auth_user_id').eq('id', _asesorRowId).maybeSingle();
        if (_ase && _ase.auth_user_id) {
          await enviarPushAsesor(_ase.auth_user_id, (data.pushName || telefono), texto);
        }
      }
    } catch (ePush) { console.error('push asesor:', ePush && ePush.message); }

    // Si la conversacion estaba en 'recontacto' y el lead volvio a escribir:
    // vuelve al estado en el que estaba (estado_previo) y se resetea el contador de recontactos
    if (convExistente && convExistente.status === 'recontacto') {
      const tempLead = await clasificarTemperatura(texto, user_id);
      let volverA = convExistente.estado_previo || 'en_conversacion';
      // Si el lead muestra interes (caliente), pasa a 'interesado' (sale de recontacto)
      if (tempLead === 'caliente') volverA = 'interesado';
      await supabase.from('conversations').update({
        status: volverA,
        temperatura: tempLead || convExistente.temperatura || null,
        estado_previo: null,
        recontacto_count: 0,
        updated_at: new Date().toISOString()
      }).eq('id', conv.id);
    }

    // 5) Si la IA esta activa, responder por WhatsApp.
    // (La pausa TOTAL del Maestro -crm_pausado- y la papelera -eliminado_at- ya cortaron mas arriba, ANTES de
    //  gastar un solo token. Aca queda solo la pausa POR-CONVERSACION: el agente no responde, pero el mensaje
    //  ya se transcribio/tradujo para que lo tome un humano. Esta es tu distincion: app vs Maestro.)
    if (conv.ai_enabled === false) return;
    // Enforcement de suscripcion (inerte salvo SUBSCRIPTIONS_ENABLED=true; fail-open ante errores para no cortar el servicio)
    if (SUBSCRIPTIONS_ENABLED) {
      try {
        const _sub = await getSubscription(user_id);
        const _est = _sub ? _sub.status : null;
        const _cortesia = _sub && _sub.cortesia === true;
        // Cliente NUEVO (creado desde TRIAL_DESDE) sin suscripcion: debe suscribirse para activar la IA. Los anteriores quedan grandfathered.
        if (!_sub && TRIAL_DESDE) {
          var _esNuevo = false;
          try { var _u = await supabase.auth.admin.getUserById(user_id); var _ca = _u && _u.data && _u.data.user && _u.data.user.created_at; if (_ca && new Date(_ca).getTime() >= new Date(TRIAL_DESDE).getTime()) _esNuevo = true; } catch (eC) {}
          if (_esNuevo) {
            await enviarWhatsapp(instanciaNombre, telefono, 'Para activar el asistente, el administrador debe iniciar la suscripcion (incluye 4 dias de prueba gratis).');
            return;
          }
        }
        // cancelled/suspended = lapso de pago; trial = suscripcion no autorizada todavia (pending/abandonada o
        // trial automatico del registro, ver debeBloquearAcceso). En todos esos casos la IA no atiende.
        if (!_cortesia && (_est === 'cancelled' || _est === 'suspended' || _est === 'trial')) {
          await enviarWhatsapp(instanciaNombre, telefono, 'El servicio no esta activo. El administrador debe completar o regularizar la suscripcion para continuar.');
          return;
        }
        if (!(await dentroDelTopeIA(user_id))) {
          await enviarWhatsapp(instanciaNombre, telefono, 'Se alcanzo el limite de mensajes del plan. El administrador puede actualizar el plan para seguir.');
          return;
        }
      } catch (e) { console.error('enforcement suscripcion:', e && e.message); }
    }
    // === DEBOUNCE POR CONVERSACION ===
    // En vez de generar la respuesta YA (lo que con 2 webhooks concurrentes hacia que la IA se presente 2 veces),
    // agrupamos la rafaga: cada mensaje reinicia el reloj; al vencer DEBOUNCE_MS se genera UNA sola respuesta.
    // El mensaje entrante YA quedo guardado arriba (paso 4), asi que generarRespuestaAgente re-lee TODO el
    // historial de la DB y contesta contemplando toda la rafaga. No se pierde ningun mensaje.
    if (_debounceConv.has(conv.id)) { clearTimeout(_debounceConv.get(conv.id)); }
    const _convId = conv.id;
    // procesar(): se ejecuta al vencer el debounce. Si hay una generacion en curso para esta
    // conv, NO descarta el disparo: REPROGRAMA un nuevo timer (reintenta tras DEBOUNCE_MS) para
    // que cuando la generacion en curso libere _genEnCurso, este reintento dispare y conteste
    // UNA sola respuesta contemplando el/los mensaje(s) nuevo(s) (generarRespuestaAgente re-lee
    // todo el historial). Asi ningun mensaje del lead queda sin respuesta.
    const procesar = async function(){
      // guard: si ya se esta generando para esta conv, reprogramar (no descartar) y salir.
      if (_genEnCurso.has(_convId)) {
        const _reintento = setTimeout(procesar, DEBOUNCE_MS);
        _debounceConv.set(_convId, _reintento);
        return;
      }
      _genEnCurso.add(_convId);
      // Este timer ya disparo y vamos a generar: liberar su entrada del mapa AHORA (es JS de un
      // solo hilo, ningun mensaje pudo interleavear entre el guard y aqui). Asi, si durante la
      // generacion (que puede tardar >DEBOUNCE_MS por el tipeo simulado) llega un mensaje nuevo,
      // ese mensaje agenda su PROPIO timer en el mapa sin pisar nada, y disparara un reintento
      // que tras liberarse _genEnCurso generara UNA respuesta con los mensajes nuevos.
      _debounceConv.delete(_convId);
      try {
        {
          // HANDOFF LIMPIO: si el lead pide hablar con un humano, derivar YA con un mensaje claro y SIN gastar la
          // respuesta de la IA (ahorra tokens). Evita que el agente conteste algo fuera de tema antes de pasar al asesor.
          if (_pideHumano(texto)) {
            const _msgHandoff = 'Dale, te paso con un compañero del equipo que te ayuda enseguida 🙌';
            try {
              await enviarWhatsapp(instanciaNombre, telefono, _msgHandoff);
              await supabase.from('messages').insert({ conversation_id: _convId, user_id: user_id, role: 'ai', content: _msgHandoff, enviado_por: 'Agente IA' });
              await supabase.from('conversations').update({ status: 'listo_humano', ai_enabled: false, last_message: _msgHandoff, last_role: 'ai', updated_at: new Date().toISOString() }).eq('id', _convId);
              // asignar asesor si no tiene + avisarle por push + resumen para que se ponga al dia (mismo criterio que la derivacion normal)
              const { data: _cvH } = await supabase.from('conversations').select('asesor_id, admin_tomo').eq('id', _convId).maybeSingle();
              let _aseH = _cvH && _cvH.asesor_id;
              if (_cvH && !_cvH.asesor_id && !_cvH.admin_tomo) {
                _aseH = await elegirAsesorActivo(user_id);
                if (_aseH) await supabase.from('conversations').update({ asesor_id: _aseH, ultimo_asesor_id: _aseH }).eq('id', _convId);
              }
              if (_aseH) { try { const { data: _aseRow } = await supabase.from('asesores').select('auth_user_id').eq('id', _aseH).maybeSingle(); if (_aseRow && _aseRow.auth_user_id) await enviarPushAsesor(_aseRow.auth_user_id, 'Un lead pide un asesor', (data.pushName || telefono)); } catch (eP) {} }
              try { const _resH = await generarResumenConversacion(_convId, user_id); if (_resH) await supabase.from('conversations').update({ summary: _resH }).eq('id', _convId); } catch (eR) {}
            } catch (eHand) { console.error('handoff humano:', eHand && eHand.message); }
            return; // saltea la generacion de la IA; el finally libera _genEnCurso
          }
          const resultado = await generarRespuestaAgente(user_id, _convId, texto);
          if (resultado && resultado.reply) {
            await enviarWhatsapp(instanciaNombre, telefono, resultado.replyCliente || resultado.reply);
            try { await registrarUsoTokens(user_id, resultado.usage); } catch (e) {}
            if (SUBSCRIPTIONS_ENABLED) { try { await registrarUsoIA(user_id); } catch (e) {} }
            // FOTOS: si la IA pidio mandar foto(s), enviarlas DESPUES del texto. Aislado en try/catch:
            // si una foto falla, NO afecta el flujo de texto ya enviado.
            try {
              const _media = (resultado && Array.isArray(resultado.mediaAEnviar)) ? resultado.mediaAEnviar : [];
              for (let _i = 0; _i < _media.length; _i++) {
                const _m = _media[_i];
                if (_m && _m.url) {
                  try { await enviarWhatsappMedia(instanciaNombre, telefono, _m.url, 'imagen', _m.caption || ''); }
                  catch (eM1) { console.error('envio foto propiedad:', eM1 && eM1.message); }
                  // Guardar la foto como mensaje para que TAMBIEN se vea en el chat de la app (no solo en WhatsApp). NO gasta IA.
                  try { await supabase.from('messages').insert({ conversation_id: _convId, user_id: user_id, role: 'ai', content: _m.caption || '', media_url: _m.url, media_tipo: 'imagen', enviado_por: 'Agente IA' }); }
                  catch (eM2) { console.error('guardar foto IA en chat:', eM2 && eM2.message); }
                }
              }
            } catch (eMedia) { console.error('loop fotos propiedad:', eMedia && eMedia.message); }
          }

          // Clasificar el estado de la conversacion segun el mensaje del cliente (conservador)
          // Leer el estado actual ANTES de clasificar
          const { data: convActual } = await supabase.from('conversations').select('status').eq('id', _convId).maybeSingle();
          const estadoActual = (convActual && convActual.status) || 'en_conversacion';
          // BLINDAJE: si ya esta en 'listo_humano' o 'cerrado', NO se reclasifica (queda quieto)
          if (estadoActual !== 'listo_humano' && estadoActual !== 'cerrado') {
            const nuevoEstado = await clasificarEstado(texto, user_id);
            if (nuevoEstado) {
              // Orden de prioridad: en_conversacion < interesado < listo_humano (solo sube, nunca baja)
              const nivel = { en_conversacion: 1, interesado: 2, listo_humano: 3 };
              if ((nivel[nuevoEstado] || 0) > (nivel[estadoActual] || 0)) {
                const update = { status: nuevoEstado, updated_at: new Date().toISOString() };
                // Si pasa a listo_humano, pausar la IA automaticamente para que lo tome un humano
                if (nuevoEstado === 'listo_humano') { update.ai_enabled = false; }
                await supabase.from('conversations').update(update).eq('id', _convId);
                // Si paso a listo_humano y no tiene asesor ni fue tomado por el admin, asignar automaticamente
                if (nuevoEstado === 'listo_humano') {
                  const { data: cv } = await supabase.from('conversations').select('asesor_id, admin_tomo').eq('id', _convId).single();
                  if (cv && !cv.asesor_id && !cv.admin_tomo) {
                    const asesorAuto = await elegirAsesorActivo(user_id);
                    if (asesorAuto) {
                      await supabase.from('conversations').update({ asesor_id: asesorAuto, ultimo_asesor_id: asesorAuto }).eq('id', _convId);
                    }
                  }
                  // Al TRANSICIONAR a listo_humano, generar el RESUMEN IA y guardarlo (no bloquea ni rompe la respuesta)
                  try {
                    var _res = await generarResumenConversacion(_convId, user_id);
                    if (_res) await supabase.from('conversations').update({ summary: _res, updated_at: new Date().toISOString() }).eq('id', _convId);
                  } catch (eResumen) { console.error('Error resumen auto listo_humano:', eResumen && eResumen.message); }
                }
              }
            }
            // RED DE SEGURIDAD: si la conversacion esta en listo_humano sin asesor (quedo huerfana), derivar ahora
            try {
              const { data: cvSeg } = await supabase.from('conversations').select('status, asesor_id, admin_tomo, user_id').eq('id', _convId).single();
              if (cvSeg && cvSeg.status === 'listo_humano' && !cvSeg.asesor_id && !cvSeg.admin_tomo) {
                const asesorSeg = await elegirAsesorActivo(cvSeg.user_id);
                if (asesorSeg) {
                  await supabase.from('conversations').update({ asesor_id: asesorSeg, ultimo_asesor_id: asesorSeg }).eq('id', _convId);
                }
              }
            } catch (eSeg) { console.error('Error red seguridad derivacion:', eSeg); }
          }
        }
      } catch (eGen) { console.error('Error generando respuesta (debounce):', eGen && eGen.message); try { avisarSiIaSinSaldo(eGen); } catch (eSaldo) {} }
      finally {
        // Siempre liberar _genEnCurso: la conv nunca queda trabada y un eventual reintento ya
        // agendado por un mensaje nuevo podra disparar y responder.
        // NO se toca _debounceConv aqui: su entrada (si la hay) pertenece a un mensaje que llego
        // durante la generacion y debe sobrevivir para reintentar (no clobberear timer nuevo).
        _genEnCurso.delete(_convId);
      }
    };
    const _timer = setTimeout(procesar, DEBOUNCE_MS);
    _debounceConv.set(conv.id, _timer);
  } catch (e) { console.error('Error en webhook whatsapp:', e && e.message); }
});

// ============ ENVIO MANUAL DE WHATSAPP (cuando el humano escribe desde el CRM) ============
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { user_id, conversation_id, texto, enviado_por } = req.body || {};
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== user_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!user_id || !conversation_id || !texto) return res.status(400).json({ error: 'Faltan datos' });

    // 1) Buscar la conversacion para obtener el contacto
    const { data: conv } = await supabase.from('conversations').select('contact_id, user_id, traductor_activo, idioma_lead').eq('id', conversation_id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });

    // 2) Buscar el telefono del contacto
    const { data: contacto } = await supabase.from('contacts').select('phone').eq('id', conv.contact_id).maybeSingle();
    if (!contacto || !contacto.phone) return res.status(400).json({ error: 'El contacto no tiene telefono (no es WhatsApp)' });

    // 3) Buscar la instancia de WhatsApp de este user (la conectada)
    const inst = { instancia_nombre: nombreInstancia(conv.user_id) };

    // 4) Guardar el mensaje como 'human' y actualizar la conversacion
    // Traduccion: si el traductor esta activo y el lead habla otro idioma, traducir antes de enviar
    let textoEnviar = texto;
    let idiomaMsg = null;
    if (conv.traductor_activo && conv.idioma_lead && conv.idioma_lead !== 'es' && await planPermite(user_id, 'audio_traduccion')) {
      textoEnviar = await traducir(texto, conv.idioma_lead, user_id);
      idiomaMsg = conv.idioma_lead;
    }
    const { data: msgInsertado } = await supabase.from('messages').insert({ conversation_id: conversation_id, user_id: conv.user_id, role: 'human', content: texto, content_original: (textoEnviar !== texto ? textoEnviar : null), idioma: idiomaMsg, enviado_por: enviado_por || 'Humano', estado_envio: 'enviando' }).select('id').single();
    await supabase.from('conversations').update({ last_message: texto, last_role: 'human', updated_at: new Date().toISOString() }).eq('id', conversation_id);
    // Si un humano (asesor o admin) escribe en un lead en recontacto o cerrado, pasa a listo_humano y se pausa la IA
    {
      const { data: convEstado } = await supabase.from('conversations').select('status').eq('id', conversation_id).maybeSingle();
      if (convEstado && (convEstado.status === 'recontacto' || convEstado.status === 'cerrado')) {
        await supabase.from('conversations').update({ status: 'listo_humano', ai_enabled: false, updated_at: new Date().toISOString() }).eq('id', conversation_id);
      }
    }
    // Si escribe el Administrador en un lead sin asignar, lo congela (admin_tomo) para que el bucle no lo reasigne
    if (enviado_por === 'Administrador') {
      const { data: convActual } = await supabase.from('conversations').select('asesor_id').eq('id', conversation_id).single();
      if (convActual && !convActual.asesor_id) {
        await supabase.from('conversations').update({ admin_tomo: true }).eq('id', conversation_id);
      }
    }

    // 5) Enviar por WhatsApp via Evolution
    const msgId = msgInsertado ? msgInsertado.id : null;
    const salio = await enviarWhatsapp(inst.instancia_nombre, contacto.phone, textoEnviar, msgId);

    res.json({ sent: salio, estado_envio: salio ? 'enviado' : 'fallido' });
  } catch (err) {
    console.error('Error en /api/whatsapp/send:', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Error interno' });
  }
});

// ============ MULTI-CLIENTE: conectar WhatsApp propio de cada inmobiliaria ============
// La URL publica del backend (para configurar el webhook de cada instancia automaticamente)
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || 'https://agente-inmobiliaria-production-7e1c.up.railway.app';

// Nombre de instancia unico y estable por usuario
function nombreInstancia(user_id) {
  return 'cliente_' + String(user_id).replace(/-/g, '').substring(0, 16);
}

// Devuelve el nombre de la instancia REALMENTE conectada en la base (o cae al nombre por defecto)
async function instanciaActiva(user_id) {
  // Fuente de verdad UNICA: siempre la instancia que genera nombreInstancia.
  // Antes se leia el estado de la base, pero se desactualizaba y causaba que estado/envio miraran instancias distintas.
  return nombreInstancia(user_id);
}

// Configura el webhook de una instancia para que apunte a nuestro backend
async function configurarWebhookInstancia(instancia) {
  try {
    await fetch(EVOLUTION_URL + '/webhook/set/' + instancia, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: BACKEND_PUBLIC_URL + '/api/webhook/whatsapp',
          events: ['MESSAGES_UPSERT']
        }
      })
    });
  } catch (e) { console.error('Error configurando webhook:', e && e.message); }
}

// POST /api/whatsapp/conectar -> crea (o reusa) la instancia del user y devuelve el QR
app.post('/api/whatsapp/conectar', async (req, res) => {
  try {
    const { user_id } = req.body || {};
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== user_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!user_id) return res.status(400).json({ error: 'Falta user_id' });
    if (!EVOLUTION_URL || !EVOLUTION_KEY) return res.status(500).json({ error: 'Evolution no configurado' });

    const instancia = nombreInstancia(user_id);

    // Intentar crear la instancia (si ya existe, Evolution devuelve error y lo ignoramos)
    let qr = null;
    try {
      const crear = await fetch(EVOLUTION_URL + '/instance/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
        body: JSON.stringify({ instanceName: instancia, qrcode: true, integration: 'WHATSAPP-BAILEYS' })
      });
      const data = await crear.json();
      if (data && data.qrcode && data.qrcode.base64) { qr = data.qrcode.base64; }
    } catch (e) { console.error('Error creando instancia:', e && e.message); }

    // Configurar el webhook de esa instancia hacia nuestro backend
    await configurarWebhookInstancia(instancia);

    // Si no obtuvimos QR al crear (instancia ya existia), pedir el connect para regenerar QR
    if (!qr) {
      try {
        const conn = await fetch(EVOLUTION_URL + '/instance/connect/' + instancia, {
          method: 'GET',
          headers: { 'apikey': EVOLUTION_KEY }
        });
        const cdata = await conn.json();
        if (cdata && cdata.base64) { qr = cdata.base64; }
      } catch (e) { console.error('Error en connect:', e && e.message); }
    }

    // Guardar/actualizar la instancia en la base, ligada al user_id
    const { data: existente } = await supabase.from('whatsapp_instancias').select('id').eq('user_id', user_id).eq('instancia_nombre', instancia).maybeSingle();
    if (!existente) {
      await supabase.from('whatsapp_instancias').insert({ user_id: user_id, instancia_nombre: instancia, estado: 'conectando' });
    } else {
      await supabase.from('whatsapp_instancias').update({ estado: 'conectando' }).eq('id', existente.id);
    }

    res.json({ instancia: instancia, qr: qr });
  } catch (err) {
    console.error('Error en /api/whatsapp/conectar:', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Error interno' });
  }
});

// GET /api/whatsapp/estado?user_id=... -> dice si la instancia ya esta conectada
app.post('/api/whatsapp/desconectar', async (req, res) => {
  try {
    const { user_id } = req.body || {};
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== user_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!user_id) return res.status(400).json({ error: 'Falta user_id' });
    if (!EVOLUTION_URL || !EVOLUTION_KEY) return res.status(500).json({ error: 'Evolution no configurado' });
    const instancia = await instanciaActiva(user_id);
    // Cerrar la sesion de WhatsApp en Evolution (logout) - la instancia queda lista para reconectar
    try {
      await fetch(EVOLUTION_URL + '/instance/logout/' + instancia, {
        method: 'DELETE',
        headers: { 'apikey': EVOLUTION_KEY }
      });
    } catch (e) { console.error('Error logout evolution:', e.message); }
    // Marcar la instancia como desconectada en la base
    await supabase.from('whatsapp_instancias').update({ estado: 'desconectado' }).eq('user_id', user_id);
    return res.json({ ok: true });
  } catch (e) {
    console.error('Error en desconectar:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/whatsapp/estado', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== user_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!user_id) return res.status(400).json({ error: 'Falta user_id' });
    const instancia = await instanciaActiva(user_id);
    const r = await fetch(EVOLUTION_URL + '/instance/connectionState/' + instancia, { headers: { 'apikey': EVOLUTION_KEY } });
    const data = await r.json();
    const estado = (data && data.instance && data.instance.state) || 'desconocido';
    // Si esta conectada (open), actualizar la base
    if (estado === 'open') {
      await supabase.from('whatsapp_instancias').update({ estado: 'conectado', conectado_at: new Date().toISOString() }).eq('user_id', user_id).eq('instancia_nombre', instancia);
    }
    res.json({ estado: estado, conectado: estado === 'open' });
  } catch (err) {
    console.error('Error en /api/whatsapp/estado:', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Error interno' });
  }
});

// ============ CRON: pasar a Recontacto las conversaciones inactivas (3 dias sin respuesta) ============
// ---- Helpers de recontacto ----

// Devuelve true si AHORA estamos dentro del horario de oficina del user (segun su config).
// Fail-safe: si no hay config o falla, devuelve false (no enviar).
function dentroHorarioOficina(horario) {
  try {
    if (!horario) return false;
    // Hora local Argentina (UTC-3)
    const ahora = new Date();
    const utc = ahora.getTime() + ahora.getTimezoneOffset() * 60000;
    const arg = new Date(utc - 3 * 60 * 60000);
    const dias = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const nombreDia = dias[arg.getDay()];
    const cfg = horario[nombreDia];
    if (!cfg || cfg.cerrado) return false;
    const minutosAhora = arg.getHours() * 60 + arg.getMinutes();
    const [hDesde, mDesde] = (cfg.desde || '09:00').split(':').map(Number);
    const [hHasta, mHasta] = (cfg.hasta || '18:00').split(':').map(Number);
    const desde = hDesde * 60 + mDesde;
    const hasta = hHasta * 60 + mHasta;
    return minutosAhora >= desde && minutosAhora <= hasta;
  } catch (e) { return false; }
}

// Plantillas variadas de primer recontacto (anti-baneo: nunca el mismo texto).
function mensajeRecontacto(nombre, esPrimerContacto, empresa) {
  const n = nombre ? (' ' + nombre) : '';
  const emp = empresa ? (' de ' + empresa) : '';
  if (esPrimerContacto) {
    const nuevas = [
      'Hola' + n + ', como estas? Soy Sofia' + emp + '. Te escribo para ponerme a disposicion por si estas buscando o pensando en algo. En que te puedo ayudar?',
      'Hola' + n + '! Soy Sofia' + emp + '. Me sumo para acompanarte por si estas viendo opciones. Contame que es lo que estas necesitando y vemos como te puedo ayudar.',
      'Hola' + n + ', un gusto! Soy Sofia' + emp + '. Te contacto por si te puedo dar una mano buscando algo que se ajuste a lo que necesitas. Que tenias en mente?'
    ];
    return nuevas[Math.floor(Math.random() * nuevas.length)];
  }
  const opciones = [
    'Hola' + n + ', seguis interesado/a? Quedo a disposicion por si queres que avancemos.',
    'Hola' + n + ', como va? Por si te quedo alguna duda sobre lo que veniamos hablando. Si todavia estas buscando, con gusto te paso mas info.',
    'Hola' + n + ', te escribo para saber si seguis interesado/a. Cualquier cosa me decis y seguimos.',
    'Como andas' + n + '? Quede con ganas de ayudarte. Si queres seguir viendo opciones, avisame.'
  ];
  return opciones[Math.floor(Math.random() * opciones.length)];
}

async function revisarInactividad() {
  try {
    const TRES_DIAS_MS = 3 * 24 * 60 * 60 * 1000;
    const ahoraMs = Date.now();
    // Conversaciones activas que podrian estar inactivas
    const { data: activas } = await supabase
      .from('conversations')
      .select('id, status, user_id, contact_id')
      .in('status', ['en_conversacion', 'interesado']);
    if (!activas || activas.length === 0) return;
    for (const conv of activas) {
      // Buscar el ULTIMO mensaje de la IA en esta conversacion
      const { data: ultimoAi } = await supabase
        .from('messages')
        .select('created_at')
        .eq('conversation_id', conv.id)
        .eq('role', 'ai')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!ultimoAi || !ultimoAi.created_at) continue;
      // Verificar que despues de ese mensaje de la IA el contacto NO haya respondido
      const { data: respuestaPosterior } = await supabase
        .from('messages')
        .select('id')
        .eq('conversation_id', conv.id)
        .eq('role', 'contact')
        .gt('created_at', ultimoAi.created_at)
        .limit(1)
        .maybeSingle();
      if (respuestaPosterior) continue; // el lead ya respondio, no aplica
      // Pasaron 72hs desde el ultimo mensaje de la IA?
      const transcurrido = ahoraMs - new Date(ultimoAi.created_at).getTime();
      if (transcurrido < TRES_DIAS_MS) continue;
      // -> pasa a recontacto guardando el estado previo
      await supabase.from('conversations').update({
        status: 'recontacto',
        estado_previo: conv.status,
        ai_enabled: true,
        updated_at: new Date().toISOString()
      }).eq('id', conv.id);
      console.log('Recontacto: conversacion ' + conv.id + ' paso a recontacto (72hs sin respuesta)');
    }
  } catch (e) { console.error('Error en revisarInactividad:', e && e.message); }
}

// ---- Envio del primer recontacto, solo en horario de oficina, con salvaguardas ----
async function enviarRecontactosPendientes() {
  try {
    const ahoraMs = Date.now();
    const UN_DIA_MS = 24 * 60 * 60 * 1000;
    // Conversaciones en recontacto
    const { data: enRecontacto } = await supabase
      .from('conversations')
      .select('id, user_id, contact_id, recontacto_count, recontacto_max, traductor_activo, idioma_lead')
      .eq('status', 'recontacto');
    if (!enRecontacto || enRecontacto.length === 0) return;
    for (const conv of enRecontacto) {
      // SALVAGUARDA 1: respetar el maximo de recontactos
      const maxRec = (conv.recontacto_max != null) ? conv.recontacto_max : 5;
      const countRec = conv.recontacto_count || 0;
      if (countRec >= maxRec) continue;
      // SALVAGUARDA 2: no mas de 1 recontacto por dia. Ver el ultimo recontacto enviado.
      const { data: ultimoRec } = await supabase
        .from('recontactos')
        .select('enviado_at')
        .eq('conversation_id', conv.id)
        .order('enviado_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ultimoRec && ultimoRec.enviado_at) {
        const desdeUltimo = ahoraMs - new Date(ultimoRec.enviado_at).getTime();
        if (desdeUltimo < UN_DIA_MS) continue; // ya se mando uno hoy
      }
      // Leer config de horario del user (fail-safe: si no hay, no enviar)
      const { data: settings } = await supabase
        .from('business_settings')
        .select('horario_oficina')
        .eq('user_id', conv.user_id)
        .maybeSingle();
      if (!settings || !dentroHorarioOficina(settings.horario_oficina)) continue;
      // Datos del contacto + instancia conectada
      const { data: contacto } = await supabase.from('contacts').select('name, phone').eq('id', conv.contact_id).maybeSingle();
      if (!contacto || !contacto.phone) continue;
      const inst = { instancia_nombre: nombreInstancia(conv.user_id) };
      // Enviar el mensaje variado
      // Detectar si la conversacion tiene historial real (lead de agenda vs lead con charla previa)
      const { data: msgsPrevios } = await supabase.from('messages').select('id, origen').eq('conversation_id', conv.id).neq('origen', 'historial_importado').limit(1);
      const esPrimerContacto = !msgsPrevios || msgsPrevios.length === 0;
      // nombre de la empresa para presentarse
      const { data: bsRec } = await supabase.from('business_settings').select('company_name').eq('user_id', conv.user_id).maybeSingle();
      const empresaRec = bsRec && bsRec.company_name ? bsRec.company_name : '';
      const texto = mensajeRecontacto(contacto.name, esPrimerContacto, empresaRec);
      // Si el lead habla otro idioma y el traductor esta activo, traducir el recontacto antes de enviar (igual que el camino reactivo/manual)
      let textoEnviar = texto, idiomaRec = null;
      if (conv.traductor_activo && conv.idioma_lead && conv.idioma_lead !== 'es' && await planPermite(conv.user_id, 'audio_traduccion')) {
        try { const tr = await traducir(texto, conv.idioma_lead, conv.user_id); if (tr && tr.trim()) { textoEnviar = tr; idiomaRec = conv.idioma_lead; } } catch (eTr) { console.error('trad recontacto:', eTr && eTr.message); }
      }
      // Registrar primero en messages (con id) para marcar estado de envio. content = lo que recibe el cliente; content_original = castellano para el asesor.
      const { data: msgRec } = await supabase.from('messages').insert({ conversation_id: conv.id, user_id: conv.user_id, role: 'ai', content: textoEnviar, content_original: (idiomaRec ? texto : null), idioma: idiomaRec, enviado_por: 'Agente IA', estado_envio: 'enviando' }).select('id').single();
      // Enviar y registrar estado (enviado/fallido) en ese mensaje
      await enviarWhatsapp(inst.instancia_nombre, contacto.phone, textoEnviar, msgRec ? msgRec.id : null);
      await supabase.from('conversations').update({ last_message: textoEnviar, last_role: 'ai', updated_at: new Date().toISOString() }).eq('id', conv.id);
      await supabase.from('recontactos').insert({ user_id: conv.user_id, conversation_id: conv.id, contact_id: conv.contact_id, intento: countRec + 1, mensaje: textoEnviar, enviado_at: new Date().toISOString() });
      await supabase.from('conversations').update({ recontacto_count: countRec + 1 }).eq('id', conv.id);
      console.log('Recontacto ENVIADO a conversacion ' + conv.id + ' (intento ' + (countRec+1) + ')');
    }
  } catch (e) { console.error('Error en enviarRecontactosPendientes:', e && e.message); }
}

// Reintenta automaticamente los mensajes que quedaron 'fallido' (WhatsApp estaba desconectado)
async function reintentarFallidos() {
  try {
    // buscar mensajes fallidos (humanos / manuales) de las ultimas 24hs
    const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: fallidos } = await supabase
      .from('messages')
      .select('id, conversation_id, content, created_at')
      .eq('estado_envio', 'fallido')
      .gte('created_at', desde)
      .order('created_at', { ascending: true })
      .limit(50);
    if (!fallidos || fallidos.length === 0) return;
    for (const msg of fallidos) {
      try {
        // conversacion -> user_id y contacto
        const { data: conv } = await supabase.from('conversations').select('id, user_id, contact_id').eq('id', msg.conversation_id).maybeSingle();
        if (!conv) continue;
        const instancia = nombreInstancia(conv.user_id);
        // solo reenviar si la instancia esta conectada ahora
        const conectada = await instanciaConectada(instancia);
        if (!conectada) continue;
        const { data: contacto } = await supabase.from('contacts').select('phone').eq('id', conv.contact_id).maybeSingle();
        if (!contacto || !contacto.phone) continue;
        // reenviar; enviarWhatsapp actualiza estado_envio a 'enviado' si sale
        const salio = await enviarWhatsapp(instancia, contacto.phone, msg.content, msg.id);
        if (salio) console.log('Reintento OK del mensaje ' + msg.id);
      } catch (e) { console.error('Error reintentando msg:', e && e.message); }
    }
  } catch (e) { console.error('Error en reintentarFallidos:', e && e.message); }
}

// Revisar fallidos cada 60 segundos (reenvia apenas WhatsApp vuelve a estar conectado)
setInterval(reintentarFallidos, 60 * 1000);
setInterval(revisarInactividad, 60 * 60 * 1000);
setInterval(enviarReportesProgramados, 60 * 60 * 1000); // reportes programados: chequear cada hora
setInterval(guardarSnapshotDiario, 60 * 60 * 1000); // snapshot de metricas: actualizar cada hora
setTimeout(guardarSnapshotDiario, 50 * 1000); // primer snapshot al arrancar
setTimeout(enviarReportesProgramados, 45 * 1000); // primer chequeo al arrancar
setTimeout(revisarInactividad, 30 * 1000);
// Envio de recontactos: revisar cada 15 min si hay que mandar (respeta horario de oficina y salvaguardas)
setInterval(enviarRecontactosPendientes, 15 * 60 * 1000);
setTimeout(enviarRecontactosPendientes, 60 * 1000);
// Backup automatico cada 30 minutos (foto completa de todos los datos por user)
setInterval(hacerBackup, 30 * 60 * 1000);
setTimeout(hacerBackup, 90 * 1000);

// ===== ASESORES (gestionados por el admin) =====
// Crear un asesor: crea el usuario en Auth (con la service key) y la fila en asesores.
app.post('/api/asesores/crear', async (req, res) => {
  try {
    const { admin_id, nombre, usuario, clave, cargo, rol } = req.body || {};
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== admin_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!admin_id || !nombre || !usuario || !clave) return res.status(400).json({ error: 'Faltan datos' });
    // Rol del usuario: 'asesor' (default) o 'administrador'. Los administradores quedan excluidos
    // de la auto-asignacion/rotacion de leads y de las notificaciones push automaticas de la IA.
    const rolFinal = (rol === 'administrador') ? 'administrador' : 'asesor';
    if (rol && rol !== 'asesor' && rol !== 'administrador') return res.status(400).json({ error: 'Rol invalido (debe ser asesor o administrador)' });
    // Limite de 5 asesores por admin
    const { data: existentes } = await supabase.from('asesores').select('id').eq('admin_id', admin_id);
    if (existentes && existentes.length >= 5) return res.status(400).json({ error: 'Maximo 5 asesores' });
    // El email interno se arma con el usuario (no se usa para login real, pero Auth lo requiere)
    // Obtener el email del admin para derivar el del asesor (emailAdmin + alias)
    const { data: adminData, error: errAdmin } = await supabase.auth.admin.getUserById(admin_id);
    if (errAdmin || !adminData || !adminData.user || !adminData.user.email) return res.status(400).json({ error: 'No se pudo obtener el email del administrador' });
    const adminEmail = adminData.user.email;
    const aliasLimpio = usuario.toLowerCase().replace(/[^a-z0-9]/g, '');
    const partes = adminEmail.split('@');
    const email = partes[0] + '+' + aliasLimpio + '@' + partes[1];
    const { data: created, error: errAuth } = await supabase.auth.admin.createUser({ email: email, password: clave, email_confirm: true, user_metadata: { rol: rolFinal, admin_id: admin_id, nombre: nombre } });
    if (errAuth) return res.status(400).json({ error: errAuth.message });
    const authId = created && created.user ? created.user.id : null;
    const { error: errIns } = await supabase.from('asesores').insert({ admin_id: admin_id, auth_user_id: authId, nombre: nombre, usuario: usuario, cargo: (cargo && cargo.trim()) ? cargo.trim() : 'Asesor', rol: rolFinal, estado: 'activo', activo: true });
    if (errIns) { if (authId) { try { await supabase.auth.admin.deleteUser(authId); } catch (e) {} } return res.status(400).json({ error: errIns.message }); }
    return res.json({ ok: true, email: email });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

// Eliminar un asesor: borra el usuario de Auth y la fila. Los mensajes conservan enviado_por.
app.post('/api/asesores/activar', async (req, res) => {
  try {
    const { admin_id, asesor_id } = req.body || {};
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== admin_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!admin_id || !asesor_id) return res.status(400).json({ error: 'Faltan datos' });
    // 1. Poner el asesor activo
    await supabase.from('asesores').update({ activo: true, estado: 'activo' }).eq('id', asesor_id);
    // 2. Buscar asesores activos de la inmobiliaria (excluyendo administradores: no reciben leads)
    const { data: activos } = await supabase.from('asesores').select('id').eq('admin_id', admin_id).eq('activo', true).or('rol.is.null,rol.neq.administrador');
    if (!activos || activos.length === 0) return res.json({ ok: true, asignados: 0 });
    // 3. Buscar leads en espera, sin asignar y no tomados por el admin
    const { data: enEspera } = await supabase.from('conversations').select('id').eq('user_id', admin_id).is('asesor_id', null).eq('admin_tomo', false);
    if (!enEspera || enEspera.length === 0) return res.json({ ok: true, asignados: 0 });
    // 4. Contar carga actual de cada activo para repartir equitativo
    const carga = {};
    for (const a of activos) {
      const { count } = await supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('asesor_id', a.id);
      carga[a.id] = count || 0;
    }
    // 5. Repartir cada lead en espera al activo con menos carga
    let asignados = 0;
    for (const lead of enEspera) {
      let mejor = activos[0].id; let menos = carga[mejor];
      for (const a of activos) { if (carga[a.id] < menos) { menos = carga[a.id]; mejor = a.id; } }
      await supabase.from('conversations').update({ asesor_id: mejor, ultimo_asesor_id: mejor }).eq('id', lead.id);
      carga[mejor] = (carga[mejor] || 0) + 1;
      asignados++;
    }
    return res.json({ ok: true, asignados });
  } catch (e) {
    console.error('Error en activar asesor:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/asesores/cambiar-clave', async (req, res) => {
  try {
    const { admin_id, asesor_id, clave_nueva } = req.body || {};
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== admin_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!admin_id || !asesor_id || !clave_nueva) return res.status(400).json({ error: 'Faltan datos' });
    if (String(clave_nueva).length < 6) return res.status(400).json({ error: 'La clave debe tener al menos 6 caracteres' });
    // verificar que el asesor pertenezca a este admin
    const { data: ases } = await supabase.from('asesores').select('*').eq('id', asesor_id).eq('admin_id', admin_id).maybeSingle();
    if (!ases) return res.status(404).json({ error: 'Asesor no encontrado' });
    if (!ases.auth_user_id) return res.status(400).json({ error: 'El asesor no tiene usuario de acceso' });
    // cambiar la clave en Supabase Auth
    const { error: errUpd } = await supabase.auth.admin.updateUserById(ases.auth_user_id, { password: String(clave_nueva) });
    if (errUpd) return res.status(500).json({ error: 'No se pudo cambiar la clave: ' + errUpd.message });
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});
app.post('/api/asesores/eliminar', async (req, res) => {
  try {
    const { admin_id, asesor_id } = req.body || {};
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== admin_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!admin_id || !asesor_id) return res.status(400).json({ error: 'Faltan datos' });
    const { data: ases } = await supabase.from('asesores').select('*').eq('id', asesor_id).eq('admin_id', admin_id).maybeSingle();
    if (!ases) return res.status(404).json({ error: 'Asesor no encontrado' });
    if (ases.auth_user_id) { try { await supabase.auth.admin.deleteUser(ases.auth_user_id); } catch (e) {} }
    await supabase.from('asesores').delete().eq('id', asesor_id).eq('admin_id', admin_id);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

// ===== SCRAPER MULTIPLATAFORMA: HELPERS (aditivo, no rompe el camino WordPress) =====
// Estrategia: el flujo de import sigue siendo lista -> detalle. Para WordPress/Houzez
// se usa el sitemap (como siempre). Para Tokko Broker (sin sitemap ni wp-json) se
// detecta la plataforma y se listan/parsean las propiedades desde el HTML renderizado.
// Sin dependencias nuevas: solo fetch + regex (no hay cheerio en node_modules).

// Quita tags HTML y entidades para texto limpio (variante local del scraper).
function _limpiarHtmlScrape(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;/g, '-')
    .replace(/&#8217;/g, "'")
    .replace(/&#?[a-z0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Detecta si un HTML corresponde a un sitio Tokko Broker.
function esSitioTokko(html) {
  if (!html) return false;
  return /tokkobroker\.com\/tfw\//i.test(html)
    || /Software\s+Inmobiliario\s*-\s*Tokko/i.test(html)
    || /<li\s+prop-id="\d+"/i.test(html);
}

// Lista las URLs de detalle de propiedades Tokko presentes en un HTML de listado.
// Cada tarjeta es <li prop-id="NNN"> ... <a href="/p/NNN-slug">. Devuelve [{url, numero}].
function listarPropsTokkoDeHTML(html, base) {
  var out = [];
  var re = /<li\s+prop-id="(\d+)"[\s\S]*?<a\s+href="(\/p\/[^"]+)"/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    out.push({ numero: m[1], url: base + m[2] });
  }
  return out;
}

// Recorre las paginas de operacion/tipo de un sitio Tokko y junta todas las URLs de detalle.
// Tokko renderiza ~20 props por pagina (server-side) y pagina con ?o=&1=1&page=N.
// Como la paginacion por query es inestable mas alla de la pagina 2, ademas recorremos
// las secciones de operacion y de tipo y deduplicamos por numero.
async function listarUrlsTokko(base, limite) {
  var SECCIONES = ['/Venta', '/Alquiler', '/Alquiler-temporario',
    '/Casas', '/Departamentos', '/PHs', '/Terrenos', '/Locales',
    '/Fondos-De-Comercio', '/Terrenos-comerciales', '/Oficinas', '/Cocheras'];
  var vistos = {};
  var items = [];
  var tope = limite || 9999;
  for (var s = 0; s < SECCIONES.length && items.length < tope; s++) {
    var antes = items.length;
    for (var pagina = 1; pagina <= 6 && items.length < tope; pagina++) {
      var url = (pagina === 1)
        ? base + SECCIONES[s]
        : base + SECCIONES[s] + '?o=&1=1&page=' + pagina;
      var html;
      try {
        var r = await fetchScrape(url);
        if (!r.ok) break;
        html = await r.text();
      } catch (e) { break; }
      var encontrados = listarPropsTokkoDeHTML(html, base);
      if (encontrados.length === 0) break;
      var nuevosEnPagina = 0;
      for (var i = 0; i < encontrados.length; i++) {
        var it = encontrados[i];
        if (!vistos[it.numero]) {
          vistos[it.numero] = 1;
          items.push(it);
          nuevosEnPagina++;
          if (items.length >= tope) break;
        }
      }
      // si una pagina no aporto nada nuevo, la paginacion ya no avanza -> pasar de seccion
      if (nuevosEnPagina === 0) break;
    }
    // si la primera seccion ya devolvio props pero ninguna seccion nueva aporta, igual seguimos
    void antes;
  }
  return items;
}

// Parsea la ficha de detalle de una propiedad Tokko a {titulo, descripcion, campos}
// con las MISMAS claves que espera normalizarPropiedadScrape en el frontend
// (Propiedad ID, Precio, Tipo de propiedad, Ambientes, Ciudad/ Localidad, Barrio/ Zona, Estado, Plazas).
function parsearDetalleTokko(html, url) {
  var raw = {};
  // ficha_detalle_item: <b>Etiqueta</b><br/>Valor</div>
  var re = /<div class="ficha_detalle_item">\s*<b>([^<]+)<\/b>\s*(?:<br\s*\/?>)?\s*([^<]*)</gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var k = _limpiarHtmlScrape(m[1]).replace(/:$/, '').trim();
    var v = _limpiarHtmlScrape(m[2]);
    if (k && v) raw[k] = v;
  }
  // codigo de referencia: "(REF. RHO7897445)" o <div class='codref'>RHO...</div>
  var cod = html.match(/\(REF\.?\s*([A-Za-z0-9\-]+)\)/i)
    || html.match(/codref[^>]*>\s*([A-Za-z0-9\-]+)\s*</i)
    || (url || '').match(/\/p\/(\d+)/);
  // precio: USD115.000 / U$S / US$ / $300.000
  var pr = html.match(/(USD|U\$S|US\$)\s?[\d.,]{3,}/i) || html.match(/\$\s?[\d.,]{4,}/);
  // operacion: del bloque tipo-ub de la tarjeta o del og:title
  var tipoub = (html.match(/prop-desc-tipo-ub">([^<]+)</)
    || html.match(/<meta[^>]*og:title[^>]*content="([^"]+)"/i)
    || [])[1] || '';
  var tituloM = html.match(/<meta[^>]*og:title[^>]*content="([^"]+)"/i);
  var descM = html.match(/<meta[^>]*og:description[^>]*content="([^"]+)"/i);

  var campos = {};
  if (cod) campos['Propiedad ID'] = cod[1];
  if (pr) campos['Precio'] = pr[0].trim();
  var tipo = raw['Tipo de Propiedad'] || raw['Tipo de propiedad'] || raw['Tipo'];
  if (tipo) campos['Tipo de propiedad'] = tipo;
  var amb = raw['Ambientes'] || raw['Dormitorios'] || raw['Habitaciones'];
  if (amb) campos['Ambientes'] = amb;
  var ubic = raw['Ubicaci' + String.fromCharCode(243) + 'n'] || raw['Ubicacion'] || raw['Localidad'] || raw['Ciudad'];
  if (ubic) campos['Ciudad/ Localidad'] = ubic;
  var dir = raw['Direcci' + String.fromCharCode(243) + 'n'] || raw['Direccion'] || raw['Barrio'] || raw['Zona'];
  if (dir) campos['Barrio/ Zona'] = dir;
  var plazas = raw['Plazas'] || raw['Capacidad'] || raw['Hu' + String.fromCharCode(233) + 'spedes'];
  if (plazas) campos['Plazas'] = plazas;
  // Estado/operacion: lo que entiende el normalizador (venta / alquiler anual / alquiler temporario)
  var estado = /alquiler\s*tempora|temporari|por\s*(noche|d[ií]a)|veraneo/i.test(tipoub)
    ? 'Alquiler temporario'
    : /alquiler|renta/i.test(tipoub) ? 'Alquiler anual' : 'Venta';
  campos['Estado'] = estado;

  // FOTOS: la galeria de Tokko viene en la MISMA ficha (ya descargada) como
  //   static.tokkobroker.com/pictures/<prop-id>_<hash>.jpg   (full-size)
  // mientras que /thumbs/ y /sm_pics/ son miniaturas (las ignoramos). Cada foto aparece
  // ~3 veces (slider + data-thumb + lightbox), por eso deduplicamos. Anclamos al prop-id
  // de la URL (/p/NNN) para NO mezclar fotos de propiedades relacionadas que figuren en la
  // misma pagina. Deterministico: sin IA y sin descargas extra. Tope 15 (igual que WordPress).
  var fotos = [];
  var pidM = (url || '').match(/\/p\/(\d+)/);
  var pid = pidM ? pidM[1] : null;
  var reFoto = pid
    ? new RegExp('https?://static\\.tokkobroker\\.com/pictures/' + pid + '_[0-9]+\\.(?:jpe?g|png|webp)', 'gi')
    : /https?:\/\/static\.tokkobroker\.com\/pictures\/\d+_[0-9]+\.(?:jpe?g|png|webp)/gi;
  var fm, vistosFoto = {};
  while ((fm = reFoto.exec(html)) !== null && fotos.length < 15) {
    var fu = fm[0];
    if (!vistosFoto[fu]) { vistosFoto[fu] = 1; fotos.push(fu); }
  }

  return {
    url: url,
    titulo: tituloM ? _limpiarHtmlScrape(tituloM[1]) : (tipoub || ''),
    descripcion: descM ? _limpiarHtmlScrape(descM[1]) : '',
    campos: campos,
    foto: fotos[0] || '',
    fotos: fotos
  };
}

// ===== SCRAPER UNIVERSAL: CASCADA DE ESTRATEGIAS (ADITIVO) =====
// Objetivo: que el importador lea la MAYORIA de las inmobiliarias. El orden de la cascada es:
//   1) Sitemap WordPress / wp-json (Houzez)        [ya existia]
//   2) Tokko Broker (HTML server-rendered)          [ya existia]
//   3) Datos estructurados: JSON-LD / OpenGraph / microdata  [endurecido: entidades + objetos concatenados]
//   4) Heuristica HTML generica (tarjetas: precio + m2 + link a ficha + ref)
//   4b) Sitemap GENERICO (robots.txt + sitemap.xml/index) para sitios no-WP — TOKEN-SAVING, antes de IA
//   5) Extraccion con IA (ULTIMO recurso; solo si 1-4b no extrajeron nada util)
//   6) Tolerancia TLS (https.Agent rejectUnauthorized:false) SOLO para descargas del scraper
//   7) Paginacion robusta + dedup
// Sin dependencias npm nuevas: fetch global + regex + https nativo + el SDK anthropic ya presente.

// (6) TOLERANCIA TLS — fetch del scraper con fallback a cadena de certificado incompleta.
// IMPORTANTE: NO altera la verificacion TLS global del backend (no se toca NODE_TLS_REJECT_UNAUTHORIZED
// ni el agente global). El https.Agent inseguro se usa SOLO en este fetch y SOLO como fallback
// cuando la descarga falla por un error de certificado (ej. oilherpropiedades.com con cadena incompleta).
let _agenteTlsInseguro = null;
function _getAgenteTlsInseguro() {
  if (!_agenteTlsInseguro) {
    try {
      const https = require('https');
      _agenteTlsInseguro = new https.Agent({ rejectUnauthorized: false });
    } catch (e) { _agenteTlsInseguro = null; }
  }
  return _agenteTlsInseguro;
}
function _esErrorCertificado(err) {
  const code = err && (err.code || (err.cause && err.cause.code)) || '';
  const msg = (err && err.message ? err.message : '') + ' ' + ((err && err.cause && err.cause.message) ? err.cause.message : '');
  return /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME|certificate/i.test(String(code) + ' ' + msg);
}
// (3) CACHE DE DECISION TLS POR DOMINIO. Cuando un host falla por certificado, lo recordamos
// y para las SIGUIENTES descargas de ese host vamos DIRECTO al agente TLS-tolerante, salteando
// el intento "seguro" que sabemos que va a fallar (cada reintento contra oilher costaba un RTT + error).
// Para hosts normales (sin cert roto) NO se relaja nada: nunca entran a este Map.
const _hostsCertRoto = new Map();
function _hostDe(url) { try { return new URL(url).host; } catch (e) { return ''; } }
// fetchScrape: usar SIEMPRE esta funcion para las descargas del scraper (no el fetch crudo).
// Reintenta una sola vez con el agente TLS tolerante si el primer intento falla por certificado,
// y memoriza el host para no volver a pagar el intento seguro fallido.
async function fetchScrape(url, opciones) {
  const opts = Object.assign({ headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RaicesCRM/1.0; +https://raicescrm.com)' } }, opciones || {});
  const host = _hostDe(url);
  // host con cert roto conocido -> directo al fallback TLS tolerante (sin intentar el fetch seguro).
  if (host && _hostsCertRoto.get(host) && _getAgenteTlsInseguro()) {
    return await _fetchHttpsInseguro(url, opts);
  }
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (_esErrorCertificado(e)) {
      const ag = _getAgenteTlsInseguro();
      if (ag) {
        // recordar el host para saltear el intento seguro la proxima vez.
        if (host) _hostsCertRoto.set(host, true);
        // Node 18+: el agente se pasa via dispatcher? No: usamos el cliente https nativo a traves de
        // la opcion `agent` que undici ignora, asi que descargamos por https.get como fallback real.
        return await _fetchHttpsInseguro(url, opts);
      }
    }
    throw e;
  }
}
// Fallback real de descarga con https nativo + agente inseguro (cuando el fetch global rechaza el cert).
// Devuelve un objeto con la misma forma minima que usamos de Response: { ok, status, text() }.
function _fetchHttpsInseguro(url, opts) {
  return new Promise(function(resolve, reject) {
    try {
      const https = require('https');
      const u = new URL(url);
      const req = https.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: (opts && opts.method) || 'GET',
        headers: (opts && opts.headers) || {},
        agent: _getAgenteTlsInseguro(),
        timeout: 20000
      }, function(resp) {
        // seguir redirects basicos (301/302/307/308)
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          var loc = resp.headers.location;
          try { loc = new URL(loc, url).toString(); } catch (e) {}
          resp.resume();
          return resolve(_fetchHttpsInseguro(loc, opts));
        }
        var chunks = [];
        resp.on('data', function(c) { chunks.push(c); });
        resp.on('end', function() {
          var body = Buffer.concat(chunks).toString('utf8');
          // exponer headers con la misma interfaz minima que usamos de fetch (.get), en minuscula.
          var hdrs = resp.headers || {};
          var headersLike = { get: function(name) { var v = hdrs[String(name).toLowerCase()]; return (v === undefined) ? null : (Array.isArray(v) ? v.join(', ') : v); } };
          resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode, headers: headersLike, text: function() { return Promise.resolve(body); }, json: function() { return Promise.resolve(JSON.parse(body)); } });
        });
      });
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(new Error('timeout')); });
      if (opts && opts.body) req.write(opts.body);
      req.end();
    } catch (e) { reject(e); }
  });
}

// Limpia HTML para mandar a la IA: saca scripts/estilos/nav/header/footer y comprime espacios.
// Devuelve texto + algo de estructura (mantiene href y precios). Cap configurable de chars.
function _htmlParaIA(html, capChars) {
  if (!html) return '';
  var s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // conservar los href para que la IA pueda devolver url_detalle
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi, ' [LINK:$1] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#?[a-z0-9]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  var cap = capChars || 70000;
  if (s.length > cap) s = s.slice(0, cap);
  return s;
}

// Parsea defensivamente un array JSON que viene de una respuesta de la IA (puede traer texto alrededor).
function _parseJsonArrayDefensivo(texto) {
  if (!texto) return null;
  var t = String(texto).trim();
  // sacar fences ```json ... ```
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // intento directo
  try { var d = JSON.parse(t); if (Array.isArray(d)) return d; if (d && Array.isArray(d.propiedades)) return d.propiedades; } catch (e) {}
  // buscar el primer [ ... ] balanceado
  var ini = t.indexOf('[');
  var fin = t.lastIndexOf(']');
  if (ini >= 0 && fin > ini) {
    var sub = t.slice(ini, fin + 1);
    try { var d2 = JSON.parse(sub); if (Array.isArray(d2)) return d2; } catch (e) {}
  }
  return null;
}
function _parseJsonObjetoDefensivo(texto) {
  if (!texto) return null;
  var t = String(texto).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { var d = JSON.parse(t); if (d && typeof d === 'object') return d; } catch (e) {}
  var ini = t.indexOf('{');
  var fin = t.lastIndexOf('}');
  if (ini >= 0 && fin > ini) { try { var d2 = JSON.parse(t.slice(ini, fin + 1)); if (d2 && typeof d2 === 'object') return d2; } catch (e) {} }
  return null;
}

// (3) DATOS ESTRUCTURADOS — extrae bloques JSON-LD de un HTML y los devuelve como array de objetos.
// Aplana @graph y arrays. Endurecido (ADITIVO, sin libs): tolera JSON con entidades HTML
// (&quot; &amp; &#34;), comas finales, comentarios JS, y VARIOS objetos JSON concatenados en
// un mismo <script> (}{ pegados) — caso comun en plugins de WP/Tokko/Inmoup. La forma de
// salida (array de nodos {@type,...}) NO cambia: las funciones que la consumen siguen igual.
function _decodeEntidadesJson(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return String(s)
    .replace(/&quot;/gi, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&#x0*22;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&');
}
// Intenta parsear un texto JSON-LD con varios niveles de tolerancia. Devuelve el objeto/array
// parseado o null. No lanza.
function _parseJsonLdTexto(raw) {
  if (!raw) return null;
  // 1) intento directo
  try { return JSON.parse(raw); } catch (e) {}
  // 2) sacar comentarios //... y /*...*/ + comas finales
  var limpio = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(limpio); } catch (e) {}
  // 3) entidades HTML dentro del JSON (sitios que escapan el bloque)
  try { return JSON.parse(_decodeEntidadesJson(limpio)); } catch (e) {}
  return null;
}
// Separa varios objetos JSON concatenados ("}{", "} {", "}\n{") en uno o mas trozos parseables.
function _splitJsonConcatenado(raw) {
  if (!raw || raw.indexOf('}') === -1) return [raw];
  // solo intentar el split si NO es un array y aparece el patron de objetos pegados
  if (/^\s*\[/.test(raw) || !/\}\s*\{/.test(raw)) return [raw];
  return raw.replace(/\}\s*\{/g, '}\u0000{').split('\u0000');
}
function _extraerJsonLd(html) {
  var out = [];
  if (!html) return out;
  var re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var raw = m[1].trim();
    if (!raw) continue;
    var trozos = _splitJsonConcatenado(raw);
    for (var ti = 0; ti < trozos.length; ti++) {
      var parsed = _parseJsonLdTexto(trozos[ti]);
      if (!parsed) continue;
      // aplanar @graph y arrays
      var lista = Array.isArray(parsed) ? parsed : (parsed['@graph'] && Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed]);
      for (var i = 0; i < lista.length; i++) {
        if (!lista[i] || typeof lista[i] !== 'object') continue;
        out.push(lista[i]);
        // un nodo puede a su vez anidar @graph (raro pero pasa): aplanarlo tambien.
        if (Array.isArray(lista[i]['@graph'])) {
          for (var g = 0; g < lista[i]['@graph'].length; g++) if (lista[i]['@graph'][g] && typeof lista[i]['@graph'][g] === 'object') out.push(lista[i]['@graph'][g]);
        }
      }
    }
  }
  return out;
}
function _tipoJsonLd(o) {
  if (!o) return '';
  var t = o['@type'];
  if (Array.isArray(t)) t = t.join(' ');
  return String(t || '').toLowerCase();
}
// True si un nodo JSON-LD parece una propiedad inmobiliaria / producto vendible.
// Cubre los @type pedidos (Product/Offer/RealEstateListing) + tipos reales habituales en inmobiliarias.
function _esNodoPropiedad(o) {
  var t = _tipoJsonLd(o);
  return /realestatelisting|residence|house|apartment|singlefamilyresidence|condominium|apartmentcomplex|product|offer|accommodation|lodgingbusiness|place|property|realestate/i.test(t);
}
// Extrae la URL de detalle de un nodo JSON-LD.
function _urlDeNodo(o, base) {
  var u = o.url || o['@id'] || (o.mainEntityOfPage && (o.mainEntityOfPage['@id'] || o.mainEntityOfPage)) || '';
  if (!u) return '';
  try { return new URL(u, base + '/').toString(); } catch (e) { return (typeof u === 'string' ? u : ''); }
}
// (3) lista de URLs de propiedades desde JSON-LD del HTML de listado.
function listarUrlsJsonLd(html, base) {
  var nodos = _extraerJsonLd(html);
  var out = [];
  var vistos = {};
  for (var i = 0; i < nodos.length; i++) {
    var o = nodos[i];
    // ItemList -> itemListElement[].url / .item.url
    var t = _tipoJsonLd(o);
    if (/itemlist/i.test(t) && Array.isArray(o.itemListElement)) {
      for (var j = 0; j < o.itemListElement.length; j++) {
        var el = o.itemListElement[j];
        var it = el && (el.item || el);
        var u = it ? _urlDeNodo(it, base) : (el && el.url ? el.url : '');
        if (u && !vistos[u]) { vistos[u] = 1; out.push({ url: u, numero: (u.match(/(\d{3,})/) || [])[1] || '' }); }
      }
      continue;
    }
    if (_esNodoPropiedad(o)) {
      var u2 = _urlDeNodo(o, base);
      if (u2 && !vistos[u2]) { vistos[u2] = 1; out.push({ url: u2, numero: (u2.match(/(\d{3,})/) || [])[1] || '' }); }
    }
  }
  return out;
}
// (3) parsea una ficha de detalle desde JSON-LD + OpenGraph al shape {url,titulo,descripcion,campos}.
function parsearDetalleEstructurado(html, url) {
  var nodos = _extraerJsonLd(html);
  var prop = null;
  for (var i = 0; i < nodos.length; i++) { if (_esNodoPropiedad(nodos[i])) { prop = nodos[i]; break; } }
  var campos = {};
  var titulo = '';
  var descripcion = '';
  if (prop) {
    titulo = prop.name || prop.title || '';
    descripcion = prop.description || '';
    // precio: offers.price / offers[].price / price
    var ofer = prop.offers || prop.priceSpecification || null;
    if (Array.isArray(ofer)) ofer = ofer[0];
    var precio = (ofer && (ofer.price || (ofer.priceSpecification && ofer.priceSpecification.price))) || prop.price || '';
    var moneda = (ofer && (ofer.priceCurrency || (ofer.priceSpecification && ofer.priceSpecification.priceCurrency))) || '';
    if (precio) campos['Precio'] = (moneda ? (moneda + ' ') : '') + precio;
    if (prop.identifier || prop.sku || prop.productID) campos['Propiedad ID'] = String(prop.identifier || prop.sku || prop.productID);
    if (prop.numberOfRooms) campos['Ambientes'] = String(prop.numberOfRooms.value || prop.numberOfRooms);
    if (prop.numberOfBedrooms) campos['Habitaciones'] = String(prop.numberOfBedrooms);
    if (prop.numberOfBathroomsTotal || prop.numberOfBathrooms) campos['Baños'] = String(prop.numberOfBathroomsTotal || prop.numberOfBathrooms);
    var fa = prop.floorSize || prop.area;
    if (fa) campos['Metros totales'] = String((fa.value || fa) + (fa.unitText ? (' ' + fa.unitText) : ''));
    var addr = prop.address;
    if (addr && typeof addr === 'object') {
      if (addr.addressLocality) campos['Ciudad/ Localidad'] = addr.addressLocality;
      if (addr.streetAddress) campos['Barrio/ Zona'] = addr.streetAddress;
      if (addr.addressRegion && !campos['Ciudad/ Localidad']) campos['Ciudad/ Localidad'] = addr.addressRegion;
    } else if (typeof addr === 'string') { campos['Barrio/ Zona'] = addr; }
  }
  // completar con OpenGraph si falto algo
  if (!titulo) { var tM = html.match(/og:title["'][^>]*content=["']([^"']*)/i) || html.match(/content=["']([^"']*)["'][^>]*og:title/i); if (tM) titulo = tM[1]; }
  if (!descripcion) { var dM = html.match(/og:description["'][^>]*content=["']([^"']*)/i) || html.match(/content=["']([^"']*)["'][^>]*og:description/i); if (dM) descripcion = dM[1]; }
  if (!campos['Precio']) {
    var pm = html.match(/(?:product:price:amount|og:price:amount)["'][^>]*content=["']([^"']+)/i);
    var cm = html.match(/(?:product:price:currency|og:price:currency)["'][^>]*content=["']([^"']+)/i);
    if (pm) campos['Precio'] = (cm ? cm[1] + ' ' : '') + pm[1];
  }
  // microdata simple: itemprop="price" / "priceCurrency"
  if (!campos['Precio']) {
    var ip = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)/i) || html.match(/itemprop=["']price["'][^>]*>\s*([\d.,]+)/i);
    if (ip) campos['Precio'] = ip[1];
  }
  var hayCampos = Object.keys(campos).length > 0;
  if (!titulo && !descripcion && !hayCampos) return null;
  return { url: url, titulo: _limpiarHtmlScrape(titulo), descripcion: _limpiarHtmlScrape(descripcion), campos: campos };
}

// (3b) SITEMAP GENERICO — descubrimiento de URLs de propiedades via sitemap.xml para sitios que
// NO son Houzez/WP (esos ya los cubre la estrategia 1 con sus nombres de sitemap propios). Esto
// es TOKEN-SAVING: si el sitemap lista las fichas, no hace falta IA para descubrir URLs.
// ADITIVO: corre como estrategia nueva en la cascada, ANTES del fallback con IA. No toca wp-json.
// Sin libs: fetch (fetchScrape) + regex sobre el XML.

// Saca todos los <loc>...</loc> de un XML de sitemap.
function _locsDeSitemapXml(xml) {
  if (!xml) return [];
  var out = [];
  var re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var u = m[1].replace(/<!\[CDATA\[/i, '').replace(/\]\]>/g, '').trim();
    u = u.replace(/&amp;/gi, '&');
    if (u) out.push(u);
  }
  return out;
}
// True si una URL "parece" la ficha de detalle de una propiedad (no categoria/pagina/blog).
function _urlPareceFicha(u) {
  if (!u) return false;
  if (/\.(?:jpg|jpeg|png|webp|gif|css|js|pdf|xml)(?:\?|$)/i.test(u)) return false;
  if (/(\/category\/|\/categoria\/|\/tag\/|\/etiqueta\/|\/page\/|\/author\/|\/autor\/|\/blog\/|\/noticias?\/|\/buscar|\/search|\/contacto|\/nosotros|\/tasaci)/i.test(u)) return false;
  return /(\/propiedad|\/propiedades\/|\/property\b|\/properties\/|\/inmueble|\/inmuebles\/|\/aviso|\/ficha|\/listing|\/emprendimiento|\/desarrollo|id-?\d{2,}|\/p\/\d|\/MLA-?\d)/i.test(u);
}
// True si una URL de sitemap apunta a OTRO sitemap (indice de sitemaps).
function _esUrlSitemap(u) { return /sitemap[^/]*\.xml(\.gz)?(\?|$)/i.test(u || '') || /\.xml(\?|$)/i.test(u || ''); }

// Descubre URLs de fichas de propiedad recorriendo el/los sitemap.xml del sitio.
// Best-effort: prueba robots.txt + rutas tipicas de sitemap, desciende a sub-sitemaps que parezcan
// de propiedades, y devuelve [{url, numero}]. Tope de sitemaps visitados para no explotar.
async function descubrirUrlsSitemap(base, limiteProps) {
  var props = [];
  var vistos = {};
  var sitemapsVistos = {};
  var cola = [];
  var TOPE_SITEMAPS = 12;
  var TOPE_PROPS = limiteProps || 3000;

  function pushProp(u) {
    var abs = u;
    try { abs = new URL(u, base + '/').toString(); } catch (e) {}
    if (!vistos[abs] && _urlPareceFicha(abs)) {
      vistos[abs] = 1;
      var num = (abs.match(/id-?(\d{2,})/i) || [])[1] || (abs.match(/(\d{4,})/) || [])[1] || '';
      props.push({ url: abs, numero: num });
    }
  }
  function encolarSitemap(u) {
    var abs = u;
    try { abs = new URL(u, base + '/').toString(); } catch (e) {}
    if (!sitemapsVistos[abs]) { sitemapsVistos[abs] = 1; cola.push(abs); }
  }

  // 1) sitemaps declarados en robots.txt
  try {
    var rr = await fetchScrape(base + '/robots.txt');
    if (rr && rr.ok) {
      var txt = await rr.text();
      var rmx = /sitemap:\s*(\S+)/gi, mm;
      while ((mm = rmx.exec(txt)) !== null) encolarSitemap(mm[1].trim());
    }
  } catch (e) { /* seguir con rutas tipicas */ }
  // 2) rutas tipicas de sitemap (si robots no declaro ninguna util)
  var rutas = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap/sitemap.xml'];
  for (var i = 0; i < rutas.length; i++) encolarSitemap(base + rutas[i]);

  var visitados = 0;
  while (cola.length > 0 && visitados < TOPE_SITEMAPS && props.length < TOPE_PROPS) {
    var sm = cola.shift();
    visitados++;
    var xml = '';
    try { var r = await fetchScrape(sm); if (!r || !r.ok) continue; xml = await r.text(); } catch (e) { continue; }
    if (!xml || (xml.indexOf('<loc') === -1)) continue;
    var locs = _locsDeSitemapXml(xml);
    var esIndice = /<sitemapindex/i.test(xml);
    for (var j = 0; j < locs.length && props.length < TOPE_PROPS; j++) {
      var loc = locs[j];
      if (esIndice || _esUrlSitemap(loc)) {
        // priorizar sub-sitemaps que mencionen propiedades; igual encolar el resto si hay cupo.
        if (/propiedad|propert|inmueb|listing|aviso|emprendim/i.test(loc)) encolarSitemap(loc);
        else if (cola.length + visitados < TOPE_SITEMAPS) encolarSitemap(loc);
      } else {
        pushProp(loc);
      }
    }
  }
  return props;
}

// (4) HEURISTICA HTML GENERICA — busca links de ficha de propiedad por patrones de URL,
// y se queda con los que conviven con precio (USD/$) o m2 en la pagina. Pensado para
// listados de plataformas no soportadas (custom, Inmoup-embed, etc.).
function listarUrlsHeuristica(html, base) {
  if (!html) return [];
  var vistos = {};
  var out = [];
  // patrones tipicos de URL de ficha de propiedad
  var rxFicha = /href=["']([^"']*(?:\/propiedad|\/propiedades\/|\/property|\/inmueble|\/aviso|\/ficha|\/listing|\/venta\/|\/alquiler\/|\/emprendimiento|\/p\/\d|\/MLA-?\d)[^"']*)["']/gi;
  var m;
  var baseHost = '';
  try { baseHost = new URL(base).host; } catch (e) {}
  while ((m = rxFicha.exec(html)) !== null) {
    var href = m[1];
    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    var abs;
    try { abs = new URL(href, base + '/').toString(); } catch (e) { continue; }
    // mantener solo links del mismo dominio (o ML/embed externos comunes)
    var host = '';
    try { host = new URL(abs).host; } catch (e) {}
    var mismoSitio = host === baseHost;
    var esML = /mercadolibre|mercadolibre\.com|tokkobroker\.com/i.test(host);
    if (!mismoSitio && !esML) continue;
    // descartar links de categoria obvia (sin id ni slug largo)
    if (/(\/category\/|\/tag\/|\/page\/|\/author\/|\/buscar|\/search|#)/i.test(abs)) continue;
    if (!vistos[abs]) { vistos[abs] = 1; out.push({ url: abs, numero: (abs.match(/(\d{4,})/) || [])[1] || '' }); }
  }
  // si hay un monton de links, exigir que la pagina tenga senales de precio/m2 (evita falsos positivos)
  if (out.length > 0) {
    var haySenal = /(USD|U\$S|US\$|\$\s?\d)[\s\S]{0,40}|\bm2\b|m²|metros\s*cuadrados|ambientes|dormitorios/i.test(html);
    if (!haySenal && out.length < 3) return [];
  }
  return out;
}

// GALERIA DESDE HTML — para sitios WordPress cuyas fichas NO estan expuestas en wp-json
// (ej. remaxbosque: las propiedades viven en /propiedades/<id>/ como paginas server-rendered,
// no como post type REST). El camino wp-json (_mapearPropWpJsonADetalle) ya resuelve la galeria
// via fave_property_images/parent-media; esta funcion es SOLO el fallback del camino HTML.
//
// Estrategia:
//  - junta imagenes wp-content/uploads cuyo NOMBRE DE ARCHIVO sea un UUID
//    ([0-9a-f]{8}-...-[0-9a-f]{12}). Eso distingue las fotos de la propiedad del logo/portada/
//    banners (que tienen nombres descriptivos: Logo-REMAX..., Portada-...).
//  - dedup por foto base: normaliza quitando el sufijo de tamano -WxH y el sufijo -scaled antes
//    de comparar; prefiere la version full (sin -WxH/-scaled). Mantiene el ORDEN del documento.
//  - excluye logo/portada/icon/avatar/placeholder por nombre.
//  - cap 15 (igual que los otros caminos).
//  - fallback: si el patron UUID no matchea nada (otros sitios), toma imagenes uploads del
//    PRIMER contenedor de gallery/slider/swiper/carousel del HTML, mismo dedup/cap.
function _extraerGaleriaHtml(html, baseUrl) {
  if (!html) return [];
  var RX_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  var RX_EXCLUIR = /(logo|portada|cover|banner|icon|avatar|placeholder|sprite|favicon|watermark|marca-?agua)/i;
  // saca el sufijo de tamano -WxH (justo antes de la extension) y luego -scaled.
  // OJO: NO tocar un sufijo numerico tipo -1 (re-subida de WP) — eso es parte del nombre base.
  function _normalizarBase(u) {
    var sinQuery = u.split('?')[0].split('#')[0];
    var b = sinQuery.replace(/-\d{1,5}x\d{1,5}(?=\.[a-z0-9]+$)/i, '');
    b = b.replace(/-scaled(?=\.[a-z0-9]+$)/i, '');
    return b.toLowerCase();
  }
  // "calidad" de una variante para elegir la MEJOR de una misma foto base.
  // full (sin sufijo) gana; luego -scaled; luego -WxH por area (mas grande mejor).
  function _calidad(u) {
    var archivo = u.split('?')[0].split('#')[0];
    var mWH = archivo.match(/-(\d{1,5})x(\d{1,5})\.[a-z0-9]+$/i);
    if (mWH) return parseInt(mWH[1], 10) * parseInt(mWH[2], 10);   // area (siempre > 0, < scaled)
    if (/-scaled\.[a-z0-9]+$/i.test(archivo)) return 1e9;           // scaled: muy buena, debajo de full
    return 2e9;                                                     // full (sin -WxH ni -scaled): la mejor
  }
  function _mejorQue(nueva, vieja) {
    var cn = _calidad(nueva), cv = _calidad(vieja);
    if (cn !== cv) return cn > cv;
    return nueva.length < vieja.length;   // empate: la mas corta
  }
  function _abs(u) { try { return new URL(u, (baseUrl || '') + '/').toString(); } catch (e) { return u; } }

  // recolecta URLs de uploads en ORDEN del documento desde CUALQUIER atributo (src, data-*, href,
  // data-rsBigImg de RoyalSlider, etc.) y desde srcset. Esto asegura juntar todas las variantes
  // de cada foto (incluida la mas grande, ej. -scaled) para luego quedarnos con la mejor.
  function _recolectar(fragmento) {
    var urls = [];
    var rx = /(?:[a-zA-Z_:-]+)\s*=\s*["']([^"']*\/wp-content\/uploads\/[^"']+?\.(?:jpe?g|png|webp))(?:["'?])/gi;
    var m;
    while ((m = rx.exec(fragmento)) !== null) urls.push(m[1]);
    // srcset: tomar TODAS las URLs de cada srcset (incluye la de mayor resolucion).
    var rxSet = /srcset\s*=\s*["']([^"']*\/wp-content\/uploads\/[^"']+)["']/gi;
    var ms;
    while ((ms = rxSet.exec(fragmento)) !== null) {
      var partes = ms[1].split(',');
      for (var s = 0; s < partes.length; s++) {
        var cand = partes[s].trim().split(/\s+/)[0];
        if (cand && /\.(?:jpe?g|png|webp)$/i.test(cand.split('?')[0])) urls.push(cand);
      }
    }
    return urls;
  }

  // dedup por base + cap, preservando orden de aparicion y eligiendo la mejor variante.
  function _consolidar(urls, exigirUuid) {
    var porBase = {};   // base -> { url, idx }
    var orden = [];     // bases en orden de primera aparicion
    for (var i = 0; i < urls.length; i++) {
      var raw = urls[i];
      var archivo = raw.split('?')[0].split('#')[0].split('/').pop() || '';
      if (RX_EXCLUIR.test(archivo)) continue;
      if (exigirUuid && !RX_UUID.test(archivo)) continue;
      var abs = _abs(raw);
      var base = _normalizarBase(abs);
      if (!porBase[base]) { porBase[base] = { url: abs }; orden.push(base); }
      else if (_mejorQue(abs, porBase[base].url)) { porBase[base].url = abs; }
    }
    var out = [];
    for (var k = 0; k < orden.length && out.length < 15; k++) out.push(porBase[orden[k]].url);
    return out;
  }

  // 1) intento principal: TODO el HTML, exigiendo UUID en el nombre (filtra logo/portada/banners).
  var todas = _recolectar(html);
  var galeria = _consolidar(todas, true);
  if (galeria.length) return galeria;

  // 2) fallback: primer contenedor de gallery/slider/swiper/carousel, sin exigir UUID.
  var mCont = html.match(/<[^>]+class=["'][^"']*(?:galler|slider|swiper|carousel|woocommerce-product-gallery|product-image-gallery)[^"']*["'][^>]*>([\s\S]{0,40000}?)<\/(?:div|ul|section)>/i);
  if (mCont) {
    var fb = _consolidar(_recolectar(mCont[0]), false);
    if (fb.length) return fb;
  }
  return [];
}

// (5) EXTRACCION CON IA — ultimo recurso. Manda el HTML limpio del LISTADO a Anthropic y
// pide TODAS las propiedades como JSON array. Solo se invoca si 1-4 fallaron. Cap de HTML
// y registro de uso de tokens (control de costo). Si no hay key, devuelve [] sin romper.
async function listarUrlsIA(html, base, user_id) {
  try {
    if (!process.env.ANTHROPIC_KEY) { console.log('[scraper IA] sin ANTHROPIC_KEY, se omite IA'); return []; }
    var limpio = _htmlParaIA(html, 70000);
    if (limpio.length < 200) return [];
    var sys = 'Sos un extractor de listados inmobiliarios. Te paso el TEXTO de una pagina de listado de una inmobiliaria ' +
      '(los links aparecen como [LINK:url]). Devolve EXCLUSIVAMENTE un JSON array (sin texto alrededor, sin markdown) ' +
      'con TODAS las propiedades del listado. Cada item: {"url_detalle","ref","operacion","tipo","precio","moneda","ubicacion","m2","ambientes","dormitorios","banos"}. ' +
      'url_detalle debe ser el link a la ficha (absoluto si podes, base del sitio: ' + base + '). ' +
      'Si un dato no aparece, deja "". No inventes propiedades. Si no hay propiedades, devolve [].';
    var r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: sys,
      messages: [{ role: 'user', content: 'TEXTO DEL LISTADO:\n' + limpio }]
    });
    try { if (user_id && r && r.usage) await registrarUsoTokens(user_id, r.usage); } catch (eU) {}
    var txt = (r && r.content && r.content[0] && r.content[0].text) ? r.content[0].text : '';
    var arr = _parseJsonArrayDefensivo(txt);
    if (!Array.isArray(arr)) return [];
    var vistos = {};
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i] || {};
      var u = (p.url_detalle || p.url || '').trim();
      if (!u) continue;
      try { u = new URL(u, base + '/').toString(); } catch (e) {}
      if (vistos[u]) continue;
      vistos[u] = 1;
      out.push({ url: u, numero: (p.ref || (u.match(/(\d{3,})/) || [])[1] || ''), ia: true, datos: p });
    }
    return out;
  } catch (e) { console.error('[scraper IA] listarUrlsIA:', e && e.message); return []; }
}
// (5) IA para FICHA de detalle — cuando el parseo determinista de una ficha no saca nada util.
async function parsearDetalleIA(html, url, user_id) {
  try {
    if (!process.env.ANTHROPIC_KEY) return null;
    // TRUNCADO: la entrada (HTML de la ficha) es el gasto GRANDE del scraping con IA, y corre x CADA propiedad.
    // Los datos de la propiedad (precio/ambientes/m2/descripcion) estan en la zona util; 20k chars (~5k tokens)
    // alcanzan de sobra y bajan ~60% el costo por propiedad. (Antes 50k.) Sigue siendo el ultimo recurso.
    var limpio = _htmlParaIA(html, 20000);
    if (limpio.length < 100) return null;
    var sys = 'Sos un extractor de fichas inmobiliarias. Te paso el TEXTO de la ficha de UNA propiedad. ' +
      'Devolve EXCLUSIVAMENTE un JSON objeto (sin markdown, sin texto alrededor) con: ' +
      '{"titulo","descripcion","ref","operacion","tipo","precio","moneda","ubicacion","barrio","m2","ambientes","dormitorios","banos"}. ' +
      'Si un dato no aparece, deja "". No inventes.';
    var r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: sys,
      messages: [{ role: 'user', content: 'TEXTO DE LA FICHA:\n' + limpio }]
    });
    try { if (user_id && r && r.usage) await registrarUsoTokens(user_id, r.usage); } catch (eU) {}
    var txt = (r && r.content && r.content[0] && r.content[0].text) ? r.content[0].text : '';
    var o = _parseJsonObjetoDefensivo(txt);
    if (!o) return null;
    var campos = {};
    if (o.precio) campos['Precio'] = (o.moneda ? (o.moneda + ' ') : '') + o.precio;
    if (o.ref) campos['Propiedad ID'] = String(o.ref);
    if (o.tipo) campos['Tipo de propiedad'] = o.tipo;
    if (o.ambientes) campos['Ambientes'] = String(o.ambientes);
    if (o.dormitorios) campos['Habitaciones'] = String(o.dormitorios);
    if (o.banos) campos['Baños'] = String(o.banos);
    if (o.m2) campos['Metros totales'] = String(o.m2);
    if (o.ubicacion) campos['Ciudad/ Localidad'] = o.ubicacion;
    if (o.barrio) campos['Barrio/ Zona'] = o.barrio;
    if (o.operacion) campos['Estado'] = /alquiler\s*tempora|temporari/i.test(o.operacion) ? 'Alquiler temporario' : (/alquiler|renta/i.test(o.operacion) ? 'Alquiler anual' : (/venta/i.test(o.operacion) ? 'Venta' : o.operacion));
    if (!o.titulo && !o.descripcion && Object.keys(campos).length === 0) return null;
    return { url: url, titulo: _limpiarHtmlScrape(o.titulo || ''), descripcion: _limpiarHtmlScrape(o.descripcion || ''), campos: campos, ia: true };
  } catch (e) { console.error('[scraper IA] parsearDetalleIA:', e && e.message); return null; }
}

// ===== WORDPRESS via wp-json (RAPIDO, SIN IA, SIN HTML por ficha) =====
// Muchos sitios WordPress (incluso con temas NO estandar/no-Houzez como oilherpropiedades.com)
// exponen /wp-json/wp/v2/properties con TODOS los datos: title, content, taxonomias (_embedded.wp:term),
// foto destacada (_embedded.wp:featuredmedia) y, sobre todo, `property_meta` (campos fave_* de Houzez:
// precio, ambientes, dormitorios, banos, cochera, m2, ref, direccion). Esto evita bajar el HTML de cada
// ficha y CAER A IA ficha-por-ficha (181 llamadas a Claude). Lo usamos como camino preferente para WP.

// Helper de concurrencia ACOTADA: ejecuta fn(item) sobre items, como mucho `limite` en paralelo.
async function _mapConcurrente(items, limite, fn) {
  var out = new Array(items.length);
  var idx = 0;
  var n = Math.max(1, limite || 1);
  async function worker() {
    while (idx < items.length) {
      var i = idx++;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { error: e && e.message }; }
    }
  }
  var workers = [];
  for (var w = 0; w < Math.min(n, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// Cache por host: ¿este sitio expone wp-json/wp/v2/properties? (evita re-chequear en cada lote).
// undefined = no chequeado; true/false = resultado memorizado.
const _hostsWpJson = new Map();
async function _detectarWpJson(base) {
  var host = _hostDe(base);
  if (host && _hostsWpJson.has(host)) return _hostsWpJson.get(host);
  var ok = false;
  try {
    var r = await fetchScrape(base + '/wp-json/wp/v2/properties?per_page=1&_fields=id');
    if (r && r.ok) {
      var txt = await r.text();
      try { var d = JSON.parse(txt); ok = Array.isArray(d); } catch (e) { ok = false; }
    }
  } catch (e) { ok = false; }
  if (host) _hostsWpJson.set(host, ok);
  return ok;
}

// Toma el primer valor de un campo de property_meta (Houzez los guarda como array de 1 elemento).
function _metaVal(meta, clave) {
  if (!meta) return null;
  var v = meta[clave];
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null) return null;
  v = String(v).trim();
  return v === '' ? null : v;
}
// Devuelve un meta como array de strings (para campos multivaluados ej. fave_property_images).
// Acepta tanto el formato wp ["76714","76715"] como un valor suelto. Filtra vacios.
function _metaArr(meta, clave) {
  if (!meta) return [];
  var v = meta[clave];
  if (v === undefined || v === null) return [];
  var arr = Array.isArray(v) ? v : [v];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === undefined || arr[i] === null) continue;
    var s = String(arr[i]).trim();
    if (s !== '') out.push(s);
  }
  return out;
}
// Devuelve el nombre del primer termino de una taxonomia dada dentro de _embedded.wp:term.
function _taxNombre(emb, tax) {
  var terms = (emb && emb['wp:term']) || [];
  for (var a = 0; a < terms.length; a++) {
    var g = terms[a] || [];
    for (var b = 0; b < g.length; b++) { if (g[b] && g[b].taxonomy === tax) return g[b].name; }
  }
  return null;
}
// Junta todos los nombres de una taxonomia (ej. property_feature -> caracteristicas).
function _taxLista(emb, tax) {
  var out = []; var terms = (emb && emb['wp:term']) || [];
  for (var a = 0; a < terms.length; a++) { var g = terms[a] || []; for (var b = 0; b < g.length; b++) { if (g[b] && g[b].taxonomy === tax) out.push(g[b].name); } }
  return out;
}

// Mapea UN objeto propiedad de wp-json al MISMO shape {url, titulo, descripcion, campos} que
// espera normalizarPropiedadScrape (mismas claves KNOWN del camino HTML/Houzez). NUNCA usa IA.
function _mapearPropWpJsonADetalle(p, urlOriginal, mediaMap) {
  var emb = p._embedded || {};
  var meta = p.property_meta || {};
  var titulo = limpiarHTML2(p.title && p.title.rendered) || '';
  var descripcion = limpiarHTML2(p.content && p.content.rendered) || '';
  var url = urlOriginal || p.link || '';
  var campos = {};

  // --- ID / referencia: fave_property_id (ej OIL-220637), si no app_id / id del slug / id del post ---
  var ref = _metaVal(meta, 'fave_property_id') || _metaVal(meta, 'app_id');
  if (!ref && p.slug) { var ms = String(p.slug).match(/^(\d{3,})/); if (ms) ref = ms[1]; }
  if (!ref && p.id) ref = String(p.id);
  if (ref) campos['Propiedad ID'] = ref;

  // --- Precio: fave_property_price + postfix/moneda ---
  var precioNum = _metaVal(meta, 'fave_property_price');
  if (precioNum) {
    var moneda = _metaVal(meta, 'fave_property_price_postfix') || _metaVal(meta, 'fave_currency') || '';
    // precio suele venir "250000.00" -> dejar limpio (sin .00) y prefijar moneda.
    var precioLimpio = precioNum.replace(/\.00$/, '').replace(/\.0$/, '');
    campos['Precio'] = (moneda ? (moneda + ' ') : '') + precioLimpio;
  }

  // --- Tipo / operacion (taxonomias) ---
  var tipo = _taxNombre(emb, 'property_type');
  if (tipo) campos['Tipo de propiedad'] = tipo;
  var estadoTax = _taxNombre(emb, 'property_status') || '';
  // normalizar a lo que entiende el front: Venta / Alquiler anual / Alquiler temporario
  var op = detectarOperacion(estadoTax, titulo + ' ' + descripcion.substring(0, 200));
  campos['Estado'] = (op === 'temporal') ? 'Alquiler temporario' : (op === 'anual') ? 'Alquiler anual' : 'Venta';

  // --- Ambientes / habitaciones / banos / cochera ---
  var ambientes = _metaVal(meta, 'fave_property_rooms');
  if (ambientes) campos['Ambientes'] = ambientes;
  var dorm = _metaVal(meta, 'fave_property_bedrooms');
  if (dorm) campos['Habitaciones'] = dorm;
  var banos = _metaVal(meta, 'fave_property_bathrooms');
  if (banos) campos['Baños'] = banos;
  var garage = _metaVal(meta, 'fave_property_garage');
  if (garage && !/^0$/.test(garage)) campos['Parking'] = garage;

  // --- Metros ---
  var size = _metaVal(meta, 'fave_property_size');
  if (size && !/^0(\.0+)?$/.test(size)) campos['Metros cubiertos'] = size;
  var land = _metaVal(meta, 'fave_property_land_real') || _metaVal(meta, 'fave_property_land');
  if (land && !/^0(\.0+)?$/.test(land)) campos['Metros totales'] = land;

  // --- Anio / orientacion ---
  var anio = _metaVal(meta, 'fave_property_year');
  if (anio) campos['A' + String.fromCharCode(241) + 'o de construcci' + String.fromCharCode(243) + 'n'] = anio;
  var orient = _metaVal(meta, 'fave_orientation');
  if (orient) campos['Orientaci' + String.fromCharCode(243) + 'n'] = orient;

  // --- Ubicacion (taxonomias city/area/state) + direccion ---
  var ciudad = _taxNombre(emb, 'property_city');
  if (ciudad) campos['Ciudad/ Localidad'] = ciudad;
  var area = _taxNombre(emb, 'property_area') || _metaVal(meta, 'fave_property_address');
  if (area) campos['Barrio/ Zona'] = area;
  var prov = _taxNombre(emb, 'property_state');
  if (prov) campos['Provincia'] = prov;

  // --- Foto destacada (para el front) ---
  var media = emb['wp:featuredmedia'] || [];
  var featuredId = (media[0] && media[0].id) ? String(media[0].id) : null;
  var featuredUrl = (media[0] && media[0].source_url) ? media[0].source_url : null;

  // --- Galeria: IDs de adjuntos de property_meta (NO trae URLs directas) ---
  // Orden: portada (slider) primero, luego la galeria completa, luego el featured.
  // Las URLs se resuelven aparte (endpoint /media) y llegan en `mediaMap` (id -> source_url).
  var idsGaleria = []
    .concat(_metaArr(meta, 'fave_prop_slider_image'))
    .concat(_metaArr(meta, 'fave_property_images'));
  if (featuredId) idsGaleria.push(featuredId);

  var foto = featuredUrl; // portada: featured si lo tenemos
  var fotos = [];
  var vistas = {};
  // Si tenemos el mapa id->url, construimos la galeria en orden, dedup, cap 15.
  if (mediaMap) {
    for (var gi = 0; gi < idsGaleria.length && fotos.length < 15; gi++) {
      var sourceUrl = mediaMap[idsGaleria[gi]];
      if (!sourceUrl || vistas[sourceUrl]) continue;
      vistas[sourceUrl] = 1;
      fotos.push(sourceUrl);
    }
    // si no resolvimos featured por _embedded, usar la primera de la galeria como portada
    if (!foto && fotos.length) foto = fotos[0];
  }
  // si por algun motivo no hay galeria pero si portada, dejar al menos la portada en fotos
  if (fotos.length === 0 && foto) fotos.push(foto);

  return { url: url, titulo: titulo, descripcion: descripcion, campos: campos, foto: foto, fotos: fotos, _idsGaleria: idsGaleria, wpjson: true };
}

// Resuelve EN BLOQUE un set de IDs de adjuntos WordPress a sus source_url.
// El meta de Houzez (fave_property_images) trae solo IDs, NO URLs -> hay que pedirlas al endpoint /media.
// Pide GET /wp-json/wp/v2/media?include=<ids>&per_page=100&_fields=id,source_url, loteando de a 100 IDs.
// Usa fetchScrape (TLS-tolerante para oilher). Devuelve un mapa { id(string) -> source_url }.
async function _resolverMediaWpJson(base, ids) {
  var mapa = {};
  if (!base || !ids || !ids.length) return mapa;
  // dedup preservando como strings
  var unicos = [];
  var visto = {};
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i] || '').trim();
    if (!id || visto[id]) continue;
    visto[id] = 1;
    unicos.push(id);
  }
  // lotear de a 100 (limite per_page de WP)
  for (var off = 0; off < unicos.length; off += 100) {
    var lote = unicos.slice(off, off + 100);
    var url = base + '/wp-json/wp/v2/media?include=' + lote.join(',') + '&per_page=100&_fields=id,source_url';
    try {
      var r = await fetchScrape(url);
      if (r && r.ok) {
        var data = JSON.parse(await r.text());
        if (Array.isArray(data)) {
          for (var j = 0; j < data.length; j++) {
            var m = data[j];
            if (m && m.id != null && m.source_url) mapa[String(m.id)] = m.source_url;
          }
        }
      }
    } catch (e) { /* lo que no resuelva queda sin url; la prop se queda con su portada */ }
  }
  return mapa;
}

// FALLBACK UNIVERSAL (independiente del tema): resuelve la galeria de un set de posts via los ADJUNTOS
// del post -> GET /wp-json/wp/v2/media?parent=<id1,id2,...>&per_page=100&_fields=id,source_url,post.
// Sirve para temas que NO exponen fave_property_images (ej. antonbienesraices). El param `parent`
// acepta MULTIPLES ids separados por coma (confirmado en vivo) -> batcheamos y agrupamos por `post`.
// Si por algun host el batch fallara/quedara vacio, caemos a per-property con concurrencia acotada (6).
// Usa fetchScrape (TLS-tolerante). Devuelve un mapa { postId(string) -> [source_url, ...] } (orden tal cual lo da WP).
async function _resolverMediaPorParent(base, postIds) {
  var mapa = {};
  if (!base || !postIds || !postIds.length) return mapa;
  // dedup como strings
  var unicos = [];
  var visto = {};
  for (var i = 0; i < postIds.length; i++) {
    var id = String(postIds[i] || '').trim();
    if (!id || visto[id]) continue;
    visto[id] = 1;
    unicos.push(id);
  }
  if (!unicos.length) return mapa;

  // acumula una media (id/source_url/post) en el mapa, dedup por source_url dentro del mismo post, cap 15.
  function _acumular(m) {
    if (!m || !m.source_url || m.post == null) return;
    var pid = String(m.post);
    var arr = mapa[pid] || (mapa[pid] = []);
    if (arr.length >= 15) return;
    if (arr.indexOf(m.source_url) === -1) arr.push(m.source_url);
  }

  // 1) intento BATCH: parent=id1,id2,... El param `parent` acepta multiples ids (confirmado en vivo).
  // Loteamos de a 5 posts: cada propiedad inmobiliaria suele tener 15-25 adjuntos y per_page tope=100,
  // asi que 5 posts entran completos en una sola respuesta (mas posts -> WP corta en 100 y el resto
  // queda para el per-property de abajo, perdiendo el ahorro del batch).
  for (var off = 0; off < unicos.length; off += 5) {
    var lote = unicos.slice(off, off + 5);
    var url = base + '/wp-json/wp/v2/media?parent=' + lote.join(',') + '&per_page=100&_fields=id,source_url,post';
    try {
      var r = await fetchScrape(url);
      if (r && r.ok) {
        var data = JSON.parse(await r.text());
        if (Array.isArray(data)) {
          for (var j = 0; j < data.length; j++) _acumular(data[j]);
        }
      }
    } catch (e) { /* lote fallido -> lo cubre el per-property de abajo si quedo sin fotos */ }
  }

  // 2) per-property (concurrencia 6) SOLO para los posts que el batch no resolvio.
  var faltantes = unicos.filter(function(pid) { return !mapa[pid] || mapa[pid].length === 0; });
  if (faltantes.length) {
    await _mapConcurrente(faltantes, 6, async function(pid) {
      var u = base + '/wp-json/wp/v2/media?parent=' + pid + '&per_page=100&_fields=id,source_url,post';
      try {
        var rr = await fetchScrape(u);
        if (rr && rr.ok) {
          var d = JSON.parse(await rr.text());
          if (Array.isArray(d)) {
            for (var k = 0; k < d.length; k++) {
              var m = d[k];
              // si la media no trae `post` (algun host) la imputamos al pid pedido
              if (m && m.source_url && m.post == null) m.post = pid;
              _acumular(m);
            }
          }
        }
      } catch (e) { /* sin fotos para este post */ }
      return null;
    });
  }
  return mapa;
}

// Trae EN LOTE los detalles de un conjunto de URLs/items WordPress via wp-json (1 sola llamada por lote).
// Estrategia: extraer el slug (ultimo segmento del path) de cada URL y pedir ?slug=a,b,c&_embed=1.
// Fallback: si la URL trae un id numerico de post (?p=NN o item.postId), usar ?include=...
// Devuelve un array de detalles {url, titulo, descripcion, campos, foto, fotos} alineado por slug; las URLs
// que no matchearon vuelven como null (para que el caller decida el fallback HTML/IA).
async function _traerDetallesWpJson(base, items) {
  // items: array de strings (url) u objetos {url,...}
  var metas = items.map(function(it) {
    var u = (typeof it === 'string') ? it : (it && it.url) || '';
    var slug = '';
    try {
      var path = new URL(u).pathname.replace(/\/+$/, '');
      slug = decodeURIComponent(path.split('/').pop() || '');
    } catch (e) { slug = ''; }
    return { url: u, slug: slug };
  });
  var resultadoPorUrl = {};
  // pedir por slug en lotes (la query de slug acepta lista separada por coma)
  var slugs = metas.filter(function(m) { return m.slug; }).map(function(m) { return m.slug; });
  if (slugs.length) {
    var qs = slugs.map(encodeURIComponent).join(',');
    var url = base + '/wp-json/wp/v2/properties?slug=' + qs + '&_embed=1&per_page=' + Math.min(100, slugs.length);
    try {
      var r = await fetchScrape(url);
      if (r && r.ok) {
        var data = JSON.parse(await r.text());
        if (Array.isArray(data)) {
          // --- PASO 1: mapear cada prop SIN galeria (recolecta los IDs de imagen en _idsGaleria) ---
          // Ademas guardamos el id del POST (p.id) en cada det para el fallback universal por `parent`.
          var dets = [];
          var idsTodos = [];
          for (var i = 0; i < data.length; i++) {
            var p = data[i];
            // matchear el item original por slug para conservar SU url exacta
            var orig = metas.find(function(m) { return m.slug === p.slug; });
            var det = _mapearPropWpJsonADetalle(p, orig ? orig.url : (p.link || ''), null);
            det._postId = (p.id != null) ? String(p.id) : null;
            dets.push(det);
            if (det._idsGaleria && det._idsGaleria.length) idsTodos = idsTodos.concat(det._idsGaleria);
          }
          // --- PASO 2: resolver TODOS los IDs del lote a URLs en bloque (endpoint /media) ---
          // Camino PREFERENTE Houzez: fave_property_images/slider -> URLs en orden curado.
          var mediaMap = await _resolverMediaWpJson(base, idsTodos);
          // --- PASO 3: asignar la galeria curada (Houzez): orden, dedup, cap 15 ---
          for (var k = 0; k < dets.length; k++) {
            var d = dets[k];
            var fotos = [];
            var vistas = {};
            var idsg = d._idsGaleria || [];
            for (var gi = 0; gi < idsg.length && fotos.length < 15; gi++) {
              var sUrl = mediaMap[idsg[gi]];
              if (!sUrl || vistas[sUrl]) continue;
              vistas[sUrl] = 1;
              fotos.push(sUrl);
            }
            d.fotos = fotos;          // puede quedar vacia (temas sin fave_property_images)
            d._vistas = vistas;       // dedup acumulado (para combinar luego con parent-media)
          }
          // --- PASO 4 (UNIVERSAL): para las props con galeria VACIA o POBRE (<2 fotos), traer los
          // adjuntos del post via ?parent=<id>. Combina featured + fave_property_images + parent-media,
          // dedup por source_url, cap 15, portada primero. Independiente del tema (cubre antonbienesraices).
          var postsPobres = [];
          for (var pp = 0; pp < dets.length; pp++) {
            var dpp = dets[pp];
            if (dpp._postId && (!dpp.fotos || dpp.fotos.length < 2)) postsPobres.push(dpp._postId);
          }
          var parentMap = postsPobres.length ? await _resolverMediaPorParent(base, postsPobres) : {};
          // --- PASO 5: combinar Houzez (preferente) + parent-media + featured, y cerrar cada det ---
          for (var k2 = 0; k2 < dets.length; k2++) {
            var d2 = dets[k2];
            var fotos2 = d2.fotos || [];
            var vistas2 = d2._vistas || {};
            for (var fi = 0; fi < fotos2.length; fi++) vistas2[fotos2[fi]] = 1;
            // agregar parent-media (universal) al final, sin pisar el orden curado de Houzez
            var pm = (d2._postId && parentMap[d2._postId]) ? parentMap[d2._postId] : [];
            for (var pj = 0; pj < pm.length && fotos2.length < 15; pj++) {
              if (!pm[pj] || vistas2[pm[pj]]) continue;
              vistas2[pm[pj]] = 1;
              fotos2.push(pm[pj]);
            }
            // featured como ultimo recurso de portada/galeria
            if (d2.foto && !vistas2[d2.foto] && fotos2.length < 15) { vistas2[d2.foto] = 1; fotos2.push(d2.foto); }
            if (fotos2.length) {
              d2.fotos = fotos2;
              if (!d2.foto) d2.foto = fotos2[0];   // portada primero
            } else if (d2.foto) {
              d2.fotos = [d2.foto];
            } else {
              d2.fotos = [];
            }
            // limpiar campos internos antes de devolver
            delete d2._idsGaleria;
            delete d2._postId;
            delete d2._vistas;
            resultadoPorUrl[d2.url] = d2;
          }
        }
      }
    } catch (e) { /* el caller cae a HTML/IA para los que falten */ }
  }
  // devolver alineado al input
  return items.map(function(it) {
    var u = (typeof it === 'string') ? it : (it && it.url) || '';
    return resultadoPorUrl[u] || null;
  });
}

function _dominioDe(u) { try { return new URL((String(u||'').startsWith('http') ? u : 'https://' + u)).hostname.replace(/^www\./,'').toLowerCase(); } catch (e) { return ''; } }
// Restringe el scraping al dominio del sitio configurado del tenant (scraping_config.fuente_url). Si aun NO
// configuro fuente_url, se permite y se FIJA ese dominio (queda 'el suyo'). Para cambiarlo, el tenant edita la
// URL en /api/scraping-config (o el Maestro). FAIL-OPEN: ante cualquier error de DB, NO bloquea el scraping.
async function scrapeUrlPermitida(user_id, urlPedida) {
  const domPedido = _dominioDe(urlPedida);
  if (!domPedido) return { ok: false, error: 'URL invalida' };
  try {
    const cfg = await supabase.from('scraping_config').select('fuente_url').eq('user_id', user_id).maybeSingle();
    const domConfig = (cfg && cfg.data && cfg.data.fuente_url) ? _dominioDe(cfg.data.fuente_url) : '';
    if (!domConfig) {
      try { await supabase.from('scraping_config').upsert({ user_id: user_id, fuente_url: urlPedida }, { onConflict: 'user_id' }); } catch (eU) {}
      return { ok: true };
    }
    if (domPedido !== domConfig) return { ok: false, error: 'Solo podes importar desde tu propio sitio (' + domConfig + '). Para cambiarlo, actualiza la URL en la configuracion de importacion.' };
    return { ok: true };
  } catch (e) { return { ok: true }; }
}

// ===== SCRAPING DE INVENTARIO (webs Houzez/WordPress + Tokko Broker) =====
app.get('/api/scrape/lista', async function(req, res) {
  try {
    let sitio = (req.query.url || '').trim();
    if (!sitio) return res.status(400).json({ error: 'Falta el parametro url' });
    if (!sitio.startsWith('http')) sitio = 'https://' + sitio;
    // normalizar a dominio base
    let base;
    try { const u = new URL(sitio); base = u.protocol + '//' + u.host; } catch(e){ return res.status(400).json({ error: 'URL invalida' }); }

    // restringir al dominio propio del tenant (anti-scrape de competencia / explosion de costo IA)
    var user_id = (req.query.user_id || (req.body && req.body.user_id) || '').trim();
    const _perm = await scrapeUrlPermitida(user_id, sitio);
    if (!_perm.ok) return res.status(400).json({ error: _perm.error });

    // ===== (1) WORDPRESS via wp-json BULK (preferente) =====
    // Si el sitio expone /wp-json/wp/v2/properties, paginamos per_page=50 siguiendo X-WP-TotalPages
    // y devolvemos las URLs canonicas (cuyo slug matchea wp-json) + el numero ya pre-extraido.
    // Esto hace que /api/scrape/detalle resuelva el lote por wp-json (sin IA, sin HTML por ficha).
    try {
      if (await _detectarWpJson(base)) {
        var itemsWp = [];
        var vistosWp = {};
        var paginaWp = 1;
        var totalPaginas = 1;
        var LIMITE_PAGINAS = 50; // tope sano (50 paginas * 50 = 2500 props)
        do {
          var urlWp = base + '/wp-json/wp/v2/properties?per_page=50&page=' + paginaWp + '&_fields=id,slug,link,property_meta';
          var rWp = await fetchScrape(urlWp);
          if (!rWp || !rWp.ok) break;
          // X-WP-TotalPages: en _fetchHttpsInseguro tenemos headers; con fetch global usar .headers.get
          var tp = rWp.headers ? (rWp.headers.get ? rWp.headers.get('x-wp-totalpages') : rWp.headers['x-wp-totalpages']) : null;
          if (tp) { var tpn = parseInt(tp, 10); if (tpn > 0) totalPaginas = tpn; }
          var dataWp = JSON.parse(await rWp.text());
          if (!Array.isArray(dataWp) || dataWp.length === 0) break;
          for (var iWp = 0; iWp < dataWp.length; iWp++) {
            var pWp = dataWp[iWp];
            var linkWp = pWp.link || (base + '/?p=' + pWp.id);
            if (vistosWp[linkWp]) continue;
            vistosWp[linkWp] = 1;
            var mw = pWp.property_meta || {};
            var numWp = (Array.isArray(mw.fave_property_id) ? mw.fave_property_id[0] : null)
              || (Array.isArray(mw.app_id) ? mw.app_id[0] : null)
              || (pWp.slug ? (String(pWp.slug).match(/^(\d{3,})/) || [])[1] : null)
              || String(pWp.id || '');
            itemsWp.push({ url: linkWp, numero: numWp || '' });
          }
          paginaWp++;
        } while (paginaWp <= totalPaginas && paginaWp <= LIMITE_PAGINAS);
        if (itemsWp.length > 0) {
          return res.json({ ok: true, total: itemsWp.length, urls: itemsWp, plataforma: 'wordpress', estrategia: 'wp-json-bulk' });
        }
      }
    } catch (eWpL) { console.error('[scraper wp-json] lista bulk:', eWpL && eWpL.message); /* caer a sitemap */ }

    // 1b) intentar el sitemap de propiedades de Houzez (fallback si wp-json no devolvio nada)
    const candidatos = [base + '/wp-sitemap-posts-property-1.xml', base + '/property-sitemap.xml', base + '/wp-sitemap.xml'];
    let urls = [];
    for (const sm of candidatos) {
      try {
        const r = await fetchScrape(sm);
        if (!r.ok) continue;
        const xml = await r.text();
        const matches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
        const locs = matches.map(function(m){ return m.replace(/<\/?loc>/g, ''); });
        // filtrar solo las de propiedades
        const props = locs.filter(function(u){ return /\/propiedad|\/property|\/propiedades\//i.test(u); });
        if (props.length > 0) { urls = props; break; }
        // si era el indice de sitemaps, buscar el de property y seguir
        const subProperty = locs.find(function(u){ return /property/i.test(u) && u.endsWith('.xml'); });
        if (subProperty) {
          const r2 = await fetchScrape(subProperty);
          if (r2.ok) { const xml2 = await r2.text(); const m2 = xml2.match(/<loc>([^<]+)<\/loc>/g) || []; urls = m2.map(function(m){ return m.replace(/<\/?loc>/g, ''); }); break; }
        }
      } catch(e) { /* probar siguiente */ }
    }
    // si el sitemap WordPress dio resultados, ese es el camino (estrategia 1) — devolver ya.
    if (urls.length > 0) {
      // extraer id de cada url (patron -id-NUMERO o idNUMERO)
      const items = urls.map(function(u){ const m = u.match(/id-?(\d+)/i); return { url: u, numero: m ? m[1] : '' }; });
      return res.json({ ok: true, total: items.length, urls: items, plataforma: 'wordpress', estrategia: 'sitemap-wp' });
    }
    // ===== CASCADA DE FALLBACKS (2->5) si no hubo sitemap WordPress =====
    // Descargamos el HOME + un par de rutas de listado tipicas para tener material a analizar.
    // (user_id ya se obtuvo arriba para el chequeo de dominio propio)
    var rutasListado = ['/', '/propiedades', '/propiedades/', '/listado', '/buscar', '/emprendimientos', '/venta', '/alquiler'];
    var homeHtml = '';
    var htmlsListado = [];
    for (var ri = 0; ri < rutasListado.length; ri++) {
      try {
        var rr = await fetchScrape(base + rutasListado[ri]);
        if (rr && rr.ok) { var h = await rr.text(); if (ri === 0) homeHtml = h; if (h && h.length > 500) htmlsListado.push(h); }
      } catch (e) { /* seguir */ }
      if (ri === 0 && !homeHtml) { /* home fallo; igual probamos rutas */ }
    }
    if (htmlsListado.length === 0 && homeHtml) htmlsListado.push(homeHtml);

    // (2) Tokko Broker
    try {
      if (esSitioTokko(homeHtml) || htmlsListado.some(esSitioTokko)) {
        const tokkoItems = await listarUrlsTokko(base, null);
        if (tokkoItems.length > 0) {
          return res.json({ ok: true, total: tokkoItems.length, urls: tokkoItems, plataforma: 'tokko', estrategia: 'tokko' });
        }
      }
    } catch (e) { /* seguir a la siguiente estrategia */ }

    // (3) Datos estructurados: JSON-LD / OpenGraph
    try {
      var jsonld = [];
      var vis3 = {};
      for (var hi = 0; hi < htmlsListado.length; hi++) {
        var got = listarUrlsJsonLd(htmlsListado[hi], base);
        for (var gi = 0; gi < got.length; gi++) { if (!vis3[got[gi].url]) { vis3[got[gi].url] = 1; jsonld.push(got[gi]); } }
      }
      if (jsonld.length > 0) {
        return res.json({ ok: true, total: jsonld.length, urls: jsonld, plataforma: 'estructurado', estrategia: 'json-ld' });
      }
    } catch (e) { /* seguir */ }

    // (4) Heuristica HTML generica
    try {
      var heur = [];
      var vis4 = {};
      for (var hj = 0; hj < htmlsListado.length; hj++) {
        var gotH = listarUrlsHeuristica(htmlsListado[hj], base);
        for (var gk = 0; gk < gotH.length; gk++) { if (!vis4[gotH[gk].url]) { vis4[gotH[gk].url] = 1; heur.push(gotH[gk]); } }
      }
      if (heur.length >= 3) {
        return res.json({ ok: true, total: heur.length, urls: heur, plataforma: 'heuristica', estrategia: 'heuristica-html' });
      }
    } catch (e) { /* seguir */ }

    // (4b) SITEMAP GENERICO (ANTES de la IA) — TOKEN-SAVING. Para sitios que NO son Houzez/WP pero
    // SI exponen sitemap.xml (Tokko propio, Mediacore, custom, etc.), descubrimos las URLs de fichas
    // desde el sitemap en vez de gastar una llamada a la IA. La estrategia 1/1b ya cubrio los sitemaps
    // WordPress; esto cubre el resto. Si encuentra fichas, corta aca y la IA no se usa.
    try {
      var smItems = await descubrirUrlsSitemap(base, null);
      if (smItems.length > 0) {
        return res.json({ ok: true, total: smItems.length, urls: smItems, plataforma: 'sitemap', estrategia: 'sitemap-generico' });
      }
    } catch (e) { /* seguir a la IA */ }

    // (5) Extraccion con IA (ultimo recurso; solo si 2-4b no extrajeron nada util).
    // Elegimos el HTML de listado MAS GRANDE (suele ser el que trae mas propiedades) para
    // darle a la IA el mejor material posible dentro del cap de chars.
    try {
      var htmlIA = homeHtml;
      for (var hk = 0; hk < htmlsListado.length; hk++) { if ((htmlsListado[hk] || '').length > (htmlIA || '').length) htmlIA = htmlsListado[hk]; }
      var iaItems = await listarUrlsIA(htmlIA, base, user_id);
      if (iaItems.length > 0) {
        return res.json({ ok: true, total: iaItems.length, urls: iaItems, plataforma: 'ia', estrategia: 'ia' });
      }
    } catch (e) { /* nada mas que probar */ }

    return res.json({ ok: true, total: 0, urls: [], nota: 'No se pudieron extraer propiedades con ninguna estrategia (wp-json/sitemap/Tokko/JSON-LD/heuristica/sitemap-generico/IA). La web puede no ser compatible o requerir JavaScript.' });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});
app.post('/api/scrape/detalle', async function(req, res) {
  try {
    const urls = (req.body && req.body.urls) || [];
    if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: 'Falta el array urls' });
    // limite sano: con wp-json el lote viaja en 1 sola llamada, asi que toleramos lotes mas grandes.
    if (urls.length > 60) return res.status(400).json({ error: 'Maximo 60 por lote' });
    const user_id = (req.body && req.body.user_id ? String(req.body.user_id).trim() : '');

    // restringir al dominio propio del tenant: el lote viene de /api/scrape/lista (mismo sitio),
    // asi que validamos el dominio de la primera url del array.
    var _urlDetalle = (typeof urls[0] === 'string') ? urls[0] : (urls[0] && urls[0].url) || '';
    const _perm = await scrapeUrlPermitida(user_id, _urlDetalle);
    if (!_perm.ok) return res.status(400).json({ error: _perm.error });

    // ===== (1) CAMINO RAPIDO WORDPRESS via wp-json (SIN IA, SIN HTML por ficha) =====
    // Si el sitio expone /wp-json/wp/v2/properties, traemos TODO el lote en 1 llamada por slug
    // y mapeamos property_meta/_embedded al shape {url,titulo,descripcion,campos}. Las URLs que
    // wp-json no resuelva caen al camino HTML/IA de siempre (abajo).
    var resueltasWp = {};
    try {
      var base0 = '';
      try { var u0 = new URL(typeof urls[0] === 'string' ? urls[0] : urls[0].url); base0 = u0.protocol + '//' + u0.host; } catch (e0) {}
      if (base0 && await _detectarWpJson(base0)) {
        var detsWp = await _traerDetallesWpJson(base0, urls);
        for (var iw = 0; iw < urls.length; iw++) {
          if (detsWp[iw] && detsWp[iw].campos && Object.keys(detsWp[iw].campos).length > 0) {
            var uw = typeof urls[iw] === 'string' ? urls[iw] : urls[iw].url;
            resueltasWp[uw] = detsWp[iw];
          }
        }
      }
    } catch (eWp) { console.error('[scraper wp-json] detalle batch:', eWp && eWp.message); }

    // ===== (4) RESTO via HTML/IA con CONCURRENCIA ACOTADA (6 en paralelo) =====
    // Procesa UNA url por el camino HTML/Tokko/estructurado/IA de siempre (logica intacta).
    async function procesarUnaUrlHtml(item) {
      const u = typeof item === 'string' ? item : item.url;
      // si la lista vino de la IA, ya trae datos pre-extraidos; los usamos como base/fallback.
      const datosIaPrevios = (item && typeof item === 'object' && item.datos) ? item.datos : null;
      try {
        const r = await fetchScrape(u);
        if (!r.ok) { return { url: u, error: 'status ' + r.status }; }
        const html = await r.text();
        // MULTIPLATAFORMA: si la ficha es de Tokko Broker, parsearla con su estructura propia
        // y devolver el MISMO shape {url, titulo, descripcion, campos} que espera el frontend.
        if (esSitioTokko(html)) {
          return parsearDetalleTokko(html, u);
        }
        // extraer todos los pares <strong>Etiqueta:</strong> Valor (camino WordPress/Houzez de siempre)
        const campos = {};
        // lista blanca de campos tecnicos conocidos de Houzez (evita capturar la descripcion)
        const KNOWN = ['Propiedad ID','Precio','Metros totales','Metros cubiertos','Ambientes','Plazas','Parking','Año de construcción','Tipo de propiedad','Estado','Habitaciones / Cuartos','Habitaciones','Cuartos','Baños','Acepta Permuta?','Vende Amueblado','Cantidad de plantas','Disposición','Cantidad de Pisos','Orientación','Puntaje','Acepta Mascota?','Ciudad/ Localidad','Ciudad / Localidad','Provincia','Barrio/ Zona','Barrio / Zona','País'];
        const re = /<strong>([^<]+?):<\/strong>\s*(?:<span[^>]*>([^<]*)<\/span>)?\s*([^<]*)<\/li>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
          const k = m[1].trim();
          if (KNOWN.indexOf(k) === -1) continue;
          const v = ((m[2] || '') + ' ' + (m[3] || '')).trim().replace(/\s+/g, ' ');
          if (k && v) campos[k] = v;
        }
        // titulo y descripcion desde meta og (flexible al orden de atributos)
        const tituloM = html.match(/og:title["'][^>]*content=["']([^"']*)/i) || html.match(/content=["']([^"']*)["'][^>]*og:title/i);
        // descripcion completa: primero el bloque property-description (Houzez/WP), fallback og:description
        var descCompleta = null;
        var mDescBloque = html.match(/<div[^>]*class="[^"]*property-description[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
        if (mDescBloque) { var dl = mDescBloque[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').replace(/^\s*Descripci[^\s]*\s*/i, '').trim(); if (dl.length > 100) descCompleta = dl; }
        if (!descCompleta) { var mDescClase = html.match(/class="[^"]*description[^"]*"[^>]*>([\s\S]{200,4000}?)<\/div>/i); if (mDescClase) { var dl2 = mDescClase[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); if (dl2.length > 100) descCompleta = dl2; } }
        const descM = html.match(/og:description["'][^>]*content=["']([^"']*)/i) || html.match(/content=["']([^"']*)["'][^>]*og:description/i);
        const detWp = {
          url: u,
          titulo: tituloM ? tituloM[1].trim() : '',
          descripcion: descCompleta ? descCompleta : (descM ? descM[1].trim() : ''),
          campos: campos
        };
        // GALERIA (camino HTML): SOLO aplica a fichas que NO vinieron por wp-json
        // (este `procesarUnaUrlHtml` corre justamente para las pendientes que no resolvio wp-json).
        // og:image como portada de respaldo; galeria UUID/contenedor como `fotos`. No pisa nada si
        // ya hay fotos en el objeto detalle. Lo computamos una vez y lo adjuntamos antes de cada return.
        var ogImg = '';
        var ogM = html.match(/og:image["'][^>]*content=["']([^"']*)/i) || html.match(/content=["']([^"']*)["'][^>]*og:image/i);
        if (ogM && ogM[1]) ogImg = ogM[1].trim();
        var galeriaHtml = [];
        try { galeriaHtml = _extraerGaleriaHtml(html, u); } catch (eG) { galeriaHtml = []; }
        function _adjuntarFotos(det) {
          if (!det || typeof det !== 'object') return det;
          // si ya trae fotos (p.ej. de un camino que las provea), no tocar.
          if (Array.isArray(det.fotos) && det.fotos.length) { if (!det.foto) det.foto = det.fotos[0]; return det; }
          var fotos = galeriaHtml.slice(0, 15);
          if (!fotos.length && ogImg) fotos = [ogImg];   // fallback final: la portada de siempre
          var portada = det.foto || (fotos.length ? fotos[0] : (ogImg || ''));
          if (portada) det.foto = portada;
          det.fotos = fotos;
          return det;
        }
        // si el parseo WordPress/Houzez ya saco campos tecnicos utiles, listo (camino de siempre).
        if (Object.keys(campos).length > 0) { return _adjuntarFotos(detWp); }

        // (3) FALLBACK datos estructurados: JSON-LD / OpenGraph / microdata
        const detEst = parsearDetalleEstructurado(html, u);
        if (detEst && Object.keys(detEst.campos).length > 0) {
          // combinar: titulo/desc del que tenga mejor info
          if (!detEst.titulo && detWp.titulo) detEst.titulo = detWp.titulo;
          if (!detEst.descripcion && detWp.descripcion) detEst.descripcion = detWp.descripcion;
          return _adjuntarFotos(detEst);
        }

        // (5) FALLBACK IA para la ficha (ultimo recurso; solo si lo determinista no saco campos)
        const detIa = await parsearDetalleIA(html, u, user_id);
        if (detIa && (Object.keys(detIa.campos).length > 0 || detIa.descripcion)) {
          if (!detIa.titulo && detWp.titulo) detIa.titulo = detWp.titulo;
          return _adjuntarFotos(detIa);
        }

        // si nada saco campos pero la lista IA ya traia datos pre-extraidos, usarlos como base.
        if (datosIaPrevios) {
          var camposPrev = {};
          var p = datosIaPrevios;
          if (p.precio) camposPrev['Precio'] = (p.moneda ? (p.moneda + ' ') : '') + p.precio;
          if (p.ref) camposPrev['Propiedad ID'] = String(p.ref);
          if (p.tipo) camposPrev['Tipo de propiedad'] = p.tipo;
          if (p.ambientes) camposPrev['Ambientes'] = String(p.ambientes);
          if (p.dormitorios) camposPrev['Habitaciones'] = String(p.dormitorios);
          if (p.banos) camposPrev['Baños'] = String(p.banos);
          if (p.m2) camposPrev['Metros totales'] = String(p.m2);
          if (p.ubicacion) camposPrev['Ciudad/ Localidad'] = p.ubicacion;
          if (p.operacion) camposPrev['Estado'] = /alquiler\s*tempora|temporari/i.test(p.operacion) ? 'Alquiler temporario' : (/alquiler|renta/i.test(p.operacion) ? 'Alquiler anual' : 'Venta');
          if (Object.keys(camposPrev).length > 0) {
            return _adjuntarFotos({ url: u, titulo: detWp.titulo || '', descripcion: detWp.descripcion || '', campos: camposPrev, ia: true });
          }
        }

        // ultimo: devolver lo que haya (titulo/desc de OG) aunque no haya campos tecnicos.
        return _adjuntarFotos(detWp);
      } catch (e) { return { url: u, error: e && e.message }; }
    }

    // Construir resultados: lo que resolvio wp-json va directo; el resto se procesa por HTML/IA
    // con concurrencia ACOTADA (6 en paralelo) en vez de secuencial.
    const pendientes = [];
    const idxPendiente = [];
    const resultados = new Array(urls.length);
    for (var ir = 0; ir < urls.length; ir++) {
      var uir = typeof urls[ir] === 'string' ? urls[ir] : urls[ir].url;
      if (resueltasWp[uir]) { resultados[ir] = resueltasWp[uir]; }
      else { pendientes.push(urls[ir]); idxPendiente.push(ir); }
    }
    if (pendientes.length) {
      const procesados = await _mapConcurrente(pendientes, 6, procesarUnaUrlHtml);
      for (var ip = 0; ip < procesados.length; ip++) resultados[idxPendiente[ip]] = procesados[ip];
    }
    return res.json({ ok: true, resultados: resultados, via_wpjson: Object.keys(resueltasWp).length, via_html: pendientes.length });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});
// ===== TEMPERATURA DE LEADS =====
// Clasifica un lead segun su ultimo mensaje: frio (no responde / sin interes), tibio (responde sin interes claro), caliente (muestra interes en ver propiedades)
async function clasificarTemperatura(textoUsuario, user_id) {
  try {
    if (!textoUsuario || !textoUsuario.trim()) return null;
    const prompt = 'Clasifica el interes de este mensaje de un posible cliente inmobiliario en UNA palabra: ' +
      'caliente (muestra interes concreto en ver, visitar, precio, o avanzar con una propiedad), ' +
      'tibio (responde pero sin interes claro), frio (no hay interes). ' +
      'Responde SOLO con: caliente, tibio o frio. Mensaje: ' + JSON.stringify(textoUsuario);
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: prompt }] });
    try { if (user_id && r && r.usage) await registrarUsoTokens(user_id, r.usage, 'clasificar_temperatura'); } catch(e){}
    const t = (r && r.content && r.content[0] && r.content[0].text ? r.content[0].text : '').toLowerCase().trim();
    if (t.indexOf('caliente') >= 0) return 'caliente';
    if (t.indexOf('tibio') >= 0) return 'tibio';
    if (t.indexOf('frio') >= 0 || t.indexOf('frío') >= 0) return 'frio';
    return null;
  } catch (e) { console.log('clasificarTemperatura error:', e && e.message); return null; }
}
// ===== FASE 3: AUTO-CATALOGO DE FOTOS POR VISION =====
// Clasifica fotos de propiedades en una categoria (dormitorio, baño, etc) usando vision de Claude.
// Endpoint nuevo y aislado: NO toca el flujo del agente, webhook, debounce ni memoria.
const CATEGORIAS_FOTO = ['dormitorio', 'baño', 'cocina', 'comedor', 'living', 'parque', 'frente', 'pileta', 'cochera', 'exterior', 'otra'];
// Normaliza acentos y mayusculas para comparar contra la lista de categorias.
function normalizarTexto(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
// Devuelve una categoria valida (sin acentos) a partir del texto crudo de Claude; si no matchea -> 'otra'.
function matchearCategoriaFoto(textoCrudo) {
  const norm = normalizarTexto(textoCrudo);
  if (!norm) return 'otra';
  // Mapa normalizado -> categoria canonica (con acento donde corresponde)
  for (let i = 0; i < CATEGORIAS_FOTO.length; i++) {
    const cat = CATEGORIAS_FOTO[i];
    if (normalizarTexto(cat) === norm) return cat;
  }
  // Match por inclusion (la respuesta puede traer palabras de mas, ej "es un dormitorio")
  for (let i = 0; i < CATEGORIAS_FOTO.length; i++) {
    const cat = CATEGORIAS_FOTO[i];
    if (norm.indexOf(normalizarTexto(cat)) >= 0) return cat;
  }
  return 'otra';
}
const PROMPT_CLASIFICAR_FOTO = 'Clasifica esta foto de una propiedad inmobiliaria en UNA sola palabra de esta lista exacta: dormitorio, baño, cocina, comedor, living, parque, frente, pileta, cochera, exterior, otra. Responde SOLO la palabra.';
// Fallback: descarga la imagen y la manda como base64 (cuando source.type:'url' falla o hay duda).
async function clasificarFotoBase64(url, user_id) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  let mediaType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  // La API de vision solo acepta estos tipos; default a jpeg si viene algo raro.
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(mediaType) < 0) mediaType = 'image/jpeg';
  const buf = Buffer.from(await resp.arrayBuffer());
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 10,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
      { type: 'text', text: PROMPT_CLASIFICAR_FOTO }
    ] }]
  });
  try { if (user_id && r && r.usage) await registrarUsoTokens(user_id, r.usage, 'vision_foto'); } catch(e){}
  return (r && r.content && r.content[0] && r.content[0].text) ? r.content[0].text : '';
}
// Clasifica una sola foto: primero intenta source.type:'url' (soportado por el SDK 0.91), y si falla cae a base64.
async function clasificarFotoUna(url, user_id) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: url } },
        { type: 'text', text: PROMPT_CLASIFICAR_FOTO }
      ] }]
    });
    try { if (user_id && r && r.usage) await registrarUsoTokens(user_id, r.usage, 'vision_foto'); } catch(e){}
    const t = (r && r.content && r.content[0] && r.content[0].text) ? r.content[0].text : '';
    return matchearCategoriaFoto(t);
  } catch (eUrl) {
    console.log('clasificar-fotos url fallo, probando base64:', eUrl && eUrl.message);
    try {
      const t2 = await clasificarFotoBase64(url, user_id);
      return matchearCategoriaFoto(t2);
    } catch (eB64) {
      console.log('clasificar-fotos base64 tambien fallo:', eB64 && eB64.message);
      return 'otra';
    }
  }
}
app.post('/api/clasificar-fotos', async (req, res) => {
  try {
    const _uid = await verificarUsuario(req);
    if (!_uid) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    const body = req.body || {};
    const urls = Array.isArray(body.urls) ? body.urls.filter(function(u){ return typeof u === 'string' && u.trim(); }) : [];
    const property_id = body.property_id;
    if (!urls.length) return res.status(400).json({ error: 'Falta urls (array de strings)' });
    // CACHE DE VISION: si la propiedad YA tiene categoria guardada para una URL, no la re-clasificamos (no se
    // re-paga la vision). Solo se clasifican las URLs nuevas/sin categoria -> re-importar cuesta casi $0 en fotos ya hechas.
    const yaClasif = {};
    if (property_id) {
      try {
        const { data: propPrev } = await supabase.from('properties').select('images').eq('id', property_id).eq('user_id', _uid).maybeSingle();
        if (propPrev && Array.isArray(propPrev.images)) {
          propPrev.images.forEach(function(it){ if (it && typeof it === 'object' && it.url && it.categoria) yaClasif[it.url] = it.categoria; });
        }
      } catch (eCache) {}
    }
    const urlsNuevas = urls.filter(function(u){ return !yaClasif[u]; });
    // Concurrencia limitada: procesar de a 4 en paralelo para no saturar la API.
    const LOTE = 4;
    const resultados = [];
    // Las ya cacheadas se devuelven sin costo (no llaman a la vision).
    for (let k = 0; k < urls.length; k++) { if (yaClasif[urls[k]]) resultados.push({ url: urls[k], categoria: yaClasif[urls[k]], cacheada: true }); }
    // Solo se clasifican (pagan vision) las URLs nuevas.
    for (let i = 0; i < urlsNuevas.length; i += LOTE) {
      const lote = urlsNuevas.slice(i, i + LOTE);
      const parciales = await Promise.all(lote.map(async function(u) {
        try {
          const categoria = await clasificarFotoUna(u, _uid);
          return { url: u, categoria: categoria };
        } catch (e) {
          console.log('clasificar-fotos error foto:', e && e.message);
          return { url: u, categoria: 'otra' };
        }
      }));
      for (let j = 0; j < parciales.length; j++) resultados.push(parciales[j]);
    }
    // Opcional: si viene property_id, persistir el catalogo en properties.images (no rompe si falla).
    if (property_id) {
      try {
        const mapa = {};
        for (let k = 0; k < resultados.length; k++) mapa[resultados[k].url] = resultados[k].categoria;
        const { data: prop } = await supabase.from('properties').select('images, user_id').eq('id', property_id).maybeSingle();
        if (prop && prop.user_id === _uid) {
          let imgs = prop.images;
          if (Array.isArray(imgs)) {
            imgs = imgs.map(function(it) {
              if (typeof it === 'string') {
                return mapa[it] ? { url: it, categoria: mapa[it] } : { url: it };
              }
              if (it && typeof it === 'object' && it.url && mapa[it.url]) {
                return Object.assign({}, it, { categoria: mapa[it.url] });
              }
              return it;
            });
            await supabase.from('properties').update({ images: imgs }).eq('id', property_id);
          }
        }
      } catch (ePersist) { console.log('clasificar-fotos persistir images fallo (no critico):', ePersist && ePersist.message); }
    }
    return res.json({ ok: true, resultados: resultados });
  } catch (e) {
    console.error('clasificar-fotos error:', e && e.message);
    if (!res.headersSent) return res.status(500).json({ error: e && e.message });
  }
});
// ===== FASE 2: IMPORTAR LEADS AL CONECTAR =====
// Paso 1: listar los chats existentes en el WhatsApp (sin guardar)
app.get('/api/whatsapp/listar-chats', async function(req, res) {
  try {
    const user_id = req.query.user_id;
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== user_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!user_id) return res.status(400).json({ error: 'Falta user_id' });
    const instancia = await instanciaActiva(user_id);
    if (!instancia) return res.status(400).json({ error: 'No hay instancia para este usuario' });
    const conectada = await instanciaConectada(instancia);
    if (!conectada) return res.json({ ok: false, conectado: false, nota: 'El WhatsApp no esta conectado.' });
    // 1) traer los chats (la parte de Mensajes = leads reales que escribieron)
    const r = await fetch(EVOLUTION_URL + '/chat/findChats/' + instancia, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY }, body: JSON.stringify({}) });
    if (!r.ok) { const t = await r.text(); return res.status(502).json({ error: 'Evolution respondio ' + r.status, detalle: t.substring(0,200) }); }
    const chatsRaw = await r.json();
    const lista = Array.isArray(chatsRaw) ? chatsRaw : (chatsRaw && chatsRaw.chats ? chatsRaw.chats : []);
    // 2) traer contactos (agenda) para conseguir los nombres por telefono
    const mapaNombre = {};
    try {
      const rc = await fetch(EVOLUTION_URL + '/chat/findContacts/' + instancia, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY }, body: JSON.stringify({}) });
      if (rc.ok) {
        const contRaw = await rc.json();
        const contactos = Array.isArray(contRaw) ? contRaw : (contRaw && contRaw.contacts ? contRaw.contacts : []);
        for (const ct of contactos) {
          const cjid = String(ct.remoteJid || '');
          if (cjid.indexOf('@s.whatsapp.net') < 0) continue;
          const ctel = cjid.replace(/@.*/, '').replace(/[^0-9]/g, '');
          if (ctel && ct.pushName) mapaNombre[ctel] = ct.pushName;
        }
      }
    } catch (e) { /* si falla, seguimos sin nombres de la agenda */ }
    // 3) armar leads: solo chats con telefono real, con nombre cruzado
    const leads = [];
    for (const ch of lista) {
      const jid = ch.remoteJid || '';
      if (jid.indexOf('@s.whatsapp.net') < 0) continue;
      const telefono = jid.replace(/@.*/, '').replace(/[^0-9]/g, '');
      if (!telefono || telefono.length < 8 || telefono.length > 15) continue;
      const nombre = ch.pushName || mapaNombre[telefono] || '';
      leads.push({ telefono: telefono, nombre: nombre });
    }
    const vistos = {}; const unicos = [];
    for (const l of leads) { if (!vistos[l.telefono]) { vistos[l.telefono] = 1; unicos.push(l); } }
    return res.json({ ok: true, conectado: true, total: unicos.length, leads: unicos });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

// Paso 2: importar los leads listados a la base (contactos + conversaciones), con duplicados por telefono
// #9 - Recupera el historial de mensajes de un lead, cruzando todas las vias posibles
async function recuperarHistorialLead(instancia, telefono, chatsCache) {
  try {
    // 1) ubicar el chat del lead: por telefono real (@s.whatsapp.net) en los chats
    const chats = chatsCache || [];
    let jidChat = null;
    const directo = chats.find(function(ch){ return String(ch.remoteJid||'').indexOf(telefono + '@s.whatsapp.net') >= 0; });
    if (directo) jidChat = directo.remoteJid;
    if (!jidChat) return [];
    // 2) pedir los mensajes de ese chat
    const r = await fetch(EVOLUTION_URL + '/chat/findMessages/' + instancia, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY }, body: JSON.stringify({ where: { key: { remoteJid: jidChat } } }) });
    if (!r.ok) return [];
    const jm = await r.json();
    const msgs = Array.isArray(jm) ? jm : (jm && jm.messages && jm.messages.records ? jm.messages.records : (jm && jm.messages ? jm.messages : []));
    if (!Array.isArray(msgs) || msgs.length === 0) return [];
    // 3) ordenar por timestamp y tomar los ultimos 10
    const ordenados = msgs.slice().sort(function(a,b){ return (a.messageTimestamp||0) - (b.messageTimestamp||0); });
    const ultimos = ordenados.slice(-10);
    // 4) mapear a {role, content, created_at}
    const out = [];
    for (const m of ultimos) {
      const k = m.key || {};
      const esMio = k.fromMe === true;
      // extraer texto del mensaje (conversation o extendedTextMessage)
      let texto = '';
      const mm = m.message || {};
      if (typeof mm.conversation === 'string') texto = mm.conversation;
      else if (mm.extendedTextMessage && mm.extendedTextMessage.text) texto = mm.extendedTextMessage.text;
      else if (mm.imageMessage && mm.imageMessage.caption) texto = '[imagen] ' + mm.imageMessage.caption;
      else if (mm.imageMessage) texto = '[imagen]';
      else if (mm.audioMessage) texto = '[audio]';
      else if (mm.videoMessage && mm.videoMessage.caption) texto = '[video] ' + mm.videoMessage.caption;
      else if (mm.videoMessage) texto = '[video]';
      else if (mm.documentMessage) texto = '[documento]';
      else if (mm.templateMessage) {
        var tm = mm.templateMessage.hydratedTemplate || mm.templateMessage.hydratedFourRowTemplate || (mm.templateMessage.fourRowTemplate) || {};
        texto = (tm.hydratedContentText || tm.hydratedTitleText || (tm.content && tm.content.text) || (tm.title && tm.title.text) || '');
        if (!texto) texto = '[mensaje con plantilla]';
      }
      else if (mm.buttonsMessage) texto = (mm.buttonsMessage.contentText || mm.buttonsMessage.text || '[mensaje con botones]');
      else if (mm.listMessage) texto = (mm.listMessage.description || mm.listMessage.title || '[mensaje con lista]');
      else if (mm.buttonsResponseMessage) texto = (mm.buttonsResponseMessage.selectedDisplayText || '[respuesta de boton]');
      else if (mm.listResponseMessage) texto = ((mm.listResponseMessage.title) || '[respuesta de lista]');
      else if (mm.ephemeralMessage && mm.ephemeralMessage.message && mm.ephemeralMessage.message.conversation) texto = mm.ephemeralMessage.message.conversation;
      if (!texto) continue;
      const ts = m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000).toISOString() : new Date().toISOString();
      out.push({ role: esMio ? 'human' : 'contact', content: texto, created_at: ts });
    }
    return out;
  } catch (e) { console.error('Error recuperando historial de lead:', e && e.message); return []; }
}
app.post('/api/whatsapp/importar-leads', async function(req, res) {
  try {
    const user_id = req.body && req.body.user_id;
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== user_id) return res.status(403).json({ error: 'Identidad no coincide' });
    const leads = (req.body && req.body.leads) || [];
    if (!user_id) return res.status(400).json({ error: 'Falta user_id' });
    if (!Array.isArray(leads) || leads.length === 0) return res.status(400).json({ error: 'No hay leads para importar' });
    let creados = 0; let yaExistian = 0; let errores = 0; let conHistorial = 0;
    // traer los chats UNA sola vez para recuperar historial (cache)
    const instancia = nombreInstancia(user_id);
    let chatsCache = [];
    try {
      const conectada = await instanciaConectada(instancia);
      if (conectada) {
        const rch = await fetch(EVOLUTION_URL + '/chat/findChats/' + instancia, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY }, body: JSON.stringify({}) });
        if (rch.ok) { const jr = await rch.json(); chatsCache = Array.isArray(jr) ? jr : (jr && jr.chats ? jr.chats : []); }
      }
    } catch (e) { /* si no hay chats, igual importamos sin historial */ }
    for (const lead of leads) {
      const telefono = String(lead.telefono || '').replace(/[^0-9]/g, '');
      if (!telefono || telefono.length < 8) { errores++; continue; }
      try {
        const { data: existente } = await supabase.from('contacts').select('id').eq('user_id', user_id).eq('phone', telefono).maybeSingle();
        let contactoId;
        if (existente) {
          contactoId = existente.id;
          yaExistian++;
        } else {
          const nombre = lead.nombre || telefono;
          const { data: nuevo, error: errC } = await supabase.from('contacts').insert({ user_id: user_id, name: nombre, phone: telefono, channel: 'whatsapp' }).select('id').single();
          if (errC || !nuevo) { errores++; continue; }
          contactoId = nuevo.id;
          creados++;
        }
        // crear conversacion solo si el contacto NO tiene una
        const { data: convExistente } = await supabase.from('conversations').select('id').eq('contact_id', contactoId).maybeSingle();
        let convId;
        if (!convExistente) {
          const { data: convNueva } = await supabase.from('conversations').insert({ user_id: user_id, contact_id: contactoId, channel: 'whatsapp', status: 'recontacto', ai_enabled: true }).select('id').single();
          convId = convNueva ? convNueva.id : null;
        } else {
          convId = convExistente.id;
        }
        // #9 - recuperar e insertar historial SOLO si la conversacion no tiene mensajes aun
        if (convId) {
          const { data: yaTiene } = await supabase.from('messages').select('id').eq('conversation_id', convId).limit(1);
          if (!yaTiene || yaTiene.length === 0) {
            const historial = await recuperarHistorialLead(instancia, telefono, chatsCache);
            if (historial.length > 0) {
              const filas = historial.map(function(h){ return { conversation_id: convId, user_id: user_id, role: h.role, content: h.content, origen: 'historial_importado', created_at: h.created_at }; });
              try { await supabase.from('messages').insert(filas); conHistorial++; } catch (e) { /* si falla el historial, no rompe la importacion */ }
            }
          }
        }
      } catch (e) { errores++; }
    }
    return res.json({ ok: true, creados: creados, yaExistian: yaExistian, errores: errores, conHistorial: conHistorial });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

// ===== SCRAPER UNIVERSAL DE INVENTARIO (multiples vias, cualquier inmobiliaria) =====
function limpiarHTML(html) {
  if (!html) return '';
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}
function extraerPrecioDe(html) {
  if (!html) return null;
  // metodo 1: clase item-price (Houzez), capturando contenido anidado
  var m = html.match(/<(span|div|p|h\d)[^>]*class="[^"]*item-price[^"]*"[^>]*>([\s\S]*?)<\/\1>/i);
  if (m) { var l = limpiarHTML(m[2]); if (l && /\d{3,}/.test(l)) return l; }
  // metodo 2: cualquier clase con 'price' que tenga numeros
  m = html.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]{0,80}?\d[\d.,]{2,}[\s\S]{0,10}?)<\//i);
  if (m) { var l2 = limpiarHTML(m[1]); if (/\d{3,}/.test(l2)) return l2; }
  // metodo 3: JSON-LD con price
  var lds = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (var i = 0; i < lds.length; i++) {
    try { var obj = JSON.parse(lds[i].replace(/<script[^>]*>/i,'').replace(/<\/script>/i,''));
      var stack = [obj];
      while (stack.length) { var o = stack.pop(); if (o && typeof o === 'object') { if (o.price) return String(o.price); if (o.offers) stack.push(o.offers); for (var k in o) { if (o[k] && typeof o[k] === 'object') stack.push(o[k]); } } }
    } catch (e) {}
  }
  // metodo 4: patron de precio en texto plano
  m = html.match(/(USD|U\$S)\s?[\d.,]{3,}/i) || html.match(/\$\s?[\d.,]{4,}/);
  if (m) return m[0].trim();
  return null;
}

// Trae propiedades probando varias vias. Devuelve array de objetos normalizados.
async function obtenerPropiedadesUniversal(sitio, limite) {
  var baseUrl = sitio.replace(/\/+$/, '');
  var props = [];
  // --- VIA 1: WordPress REST API con _embed (la mas completa) ---
  try {
    var pagina = 1; var seguir = true;
    while (seguir && props.length < (limite || 9999)) {
      var url = baseUrl + '/wp-json/wp/v2/properties?per_page=50&page=' + pagina + '&_embed=1';
      var r = await fetchScrape(url, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
      if (!r.ok) break;
      var data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      for (var i = 0; i < data.length; i++) {
        var p = data[i];
        var emb = p._embedded || {};
        var terms = emb['wp:term'] || [];
        function taxOf(tax) { for (var a = 0; a < terms.length; a++) { var g = terms[a] || []; for (var b = 0; b < g.length; b++) { if (g[b].taxonomy === tax) return g[b].name; } } return null; }
        var feats = []; for (var a = 0; a < terms.length; a++) { var g = terms[a] || []; for (var b = 0; b < g.length; b++) { if (g[b].taxonomy === 'property_feature') feats.push(g[b].name); } }
        var media = emb['wp:featuredmedia'] || [];
        var foto = (media[0] && media[0].source_url) ? media[0].source_url : null;
        props.push({
          titulo: limpiarHTML(p.title && p.title.rendered),
          descripcion: limpiarHTML(p.content && p.content.rendered),
          link: p.link || (baseUrl + '/?p=' + p.id),
          tipo: taxOf('property_type'),
          operacion: taxOf('property_status'),
          ciudad: taxOf('property_city'),
          zona: taxOf('property_area'),
          provincia: taxOf('property_state'),
          caracteristicas: feats.join(', '),
          foto: foto,
          precio: null,
          fuente: 'wp-rest'
        });
      }
      if (data.length < 50) seguir = false;
      pagina++;
    }
  } catch (e) {}
  return props;
}

// Endpoint del scraper universal. Params: url (sitio), modo ('update'|'reset'), limite (opcional)
app.post('/api/scrape/universal', async function(req, res) {
  try {
    var token = (req.headers.authorization || '').replace('Bearer ', '');
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var sitio = (req.body.url || '').trim();
    var modo = (req.body.modo === 'reset') ? 'reset' : 'update';
    var limite = req.body.limite ? parseInt(req.body.limite, 10) : null;
    if (!sitio) return res.status(400).json({ error: 'Falta la url del sitio' });
    if (!sitio.startsWith('http')) sitio = 'https://' + sitio;

    // restringir al dominio propio del tenant (anti-scrape de competencia / explosion de costo IA)
    const _perm = await scrapeUrlPermitida(user_id, sitio);
    if (!_perm.ok) return res.status(400).json({ error: _perm.error });

    var props = await obtenerPropiedadesUniversal(sitio, limite);
    if (!props.length) return res.json({ ok: false, mensaje: 'No se encontraron propiedades por ninguna via', total: 0 });

    // sacar el precio de cada propiedad entrando a su pagina (en tandas para no saturar)
    for (var i = 0; i < props.length; i++) {
      if (!props[i].link) continue;
      try {
        var h = await fetchScrape(props[i].link, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
        if (h.ok) { var html = await h.text(); props[i].precio = extraerPrecioDe(html); }
      } catch (e) {}
    }

    // modo reset: borrar el inventario actual del usuario antes de cargar
    if (modo === 'reset') {
      await supabase.from('properties').delete().eq('user_id', user_id);
    }

    // guardar cada propiedad (upsert por link para no duplicar en modo update)
    var creados = 0, actualizados = 0, errores = 0;
    for (var j = 0; j < props.length; j++) {
      var p = props[j];
      var fila = {
        user_id: user_id,
        title: p.titulo || 'Sin titulo',
        type: p.tipo || null,
        operation: p.operacion || null,
        zone: [p.ciudad, p.zona].filter(Boolean).join(' - ') || null,
        price: p.precio || null,
        description: p.descripcion || null,
        caracteristicas: p.caracteristicas || null,
        link: p.link || null,
        activa: true
      };
      try {
        if (modo === 'reset') {
          var insR = await supabase.from('properties').insert(fila);
          if (insR.error) errores++; else creados++;
        } else {
          // update: buscar por link; si existe actualiza, si no inserta
          var ex = await supabase.from('properties').select('id').eq('user_id', user_id).eq('link', p.link).maybeSingle();
          if (ex.data && ex.data.id) {
            var upR = await supabase.from('properties').update(fila).eq('id', ex.data.id);
            if (upR.error) errores++; else actualizados++;
          } else {
            var inR = await supabase.from('properties').insert(fila);
            if (inR.error) errores++; else creados++;
          }
        }
      } catch (e) { errores++; }
    }
    return res.json({ ok: true, modo: modo, total: props.length, creados: creados, actualizados: actualizados, errores: errores });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});


// ===== SCRAPER CORREGIDO: extraccion completa por propiedad =====
function limpiarHTML2(html) {
  if (!html) return '';
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}
// Extrae los pares Etiqueta:Valor de la tabla de detalles (Houzez y similares)
function extraerTablaDetalles(html) {
  var pares = {};
  var re = /<strong>([^<:]{1,40}):?<\/strong>\s*([^<]{1,60})</gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var k = m[1].trim(); var v = m[2].trim();
    if (k && v && !/^\s*$/.test(v)) pares[k] = v;
  }
  return pares;
}
// Detecta el numero identificador de forma adaptativa (cada inmobiliaria lo nombra distinto)
function detectarNumeroProp(pares, titulo, plataformaId) {
  var patrones = [/propiedad\s*id/i, /property\s*id/i, /listing\s*id/i, /\bmls\b/i, /c[oa]d(igo)?\.?\s*(de\s*)?prop/i, /\bref(erencia)?\.?\b/i, /\bn[uu]mero\b/i, /\bnro\.?\b/i, /c[oa]d(igo)?\.?/i, /\bid\b/i];
  var excluir = /postal|barrio|zona|telefono|tel\.|whatsapp|a[nu]o|construc|metro|ambient|ba[nu]o|cuarto|habitacion/i;
  for (var pi = 0; pi < patrones.length; pi++) {
    for (var k in pares) {
      if (excluir.test(k)) continue;
      if (patrones[pi].test(k)) {
        var val = String(pares[k]).match(/[A-Za-z0-9][A-Za-z0-9\-\/]*/);
        if (val) return val[0];
      }
    }
  }
  if (titulo) { var mt = titulo.match(/(?:id|c[oa]d(?:igo)?|ref(?:erencia)?|#)[\s\-:.]*([A-Za-z0-9][A-Za-z0-9\-]*)/i); if (mt) return mt[1]; }
  if (plataformaId) return String(plataformaId);
  return null;
}
// Detecta operacion y devuelve flags
function detectarOperacion(estado, textoExtra) {
  var t = ((estado || '') + ' ' + (textoExtra || '')).toLowerCase();
  if (/tempora|por noche|por dia|por d.a|alquiler temporal|temporario|veraneo|diaria/.test(t)) return 'temporal';
  if (/anual|alquiler anual|alquiler permanente|todo el a.o/.test(t)) return 'anual';
  if (/alquiler|renta|rent/.test(t)) return 'anual';
  if (/venta|vende|compra|sale/.test(t)) return 'venta';
  return 'venta';
}

function extraerPrecio2(html) {
  if (!html) return null;
  var m = html.match(/<(span|div|p|h\d)[^>]*class="[^"]*item-price[^"]*"[^>]*>([\s\S]*?)<\/\1>/i);
  if (m) { var l = limpiarHTML2(m[2]); if (l && /\d{3,}/.test(l)) return l; }
  m = html.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]{0,80}?\d[\d.,]{2,}[\s\S]{0,10}?)<\//i);
  if (m) { var l2 = limpiarHTML2(m[1]); if (/\d{3,}/.test(l2)) return l2; }
  var lds = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (var i = 0; i < lds.length; i++) { try { var obj = JSON.parse(lds[i].replace(/<script[^>]*>/i,'').replace(/<\/script>/i,'')); var st=[obj]; while(st.length){ var o=st.pop(); if(o&&typeof o==='object'){ if(o.price) return String(o.price); if(o.offers) st.push(o.offers); for(var k in o){ if(o[k]&&typeof o[k]==='object') st.push(o[k]); } } } } catch(e){} }
  m = html.match(/(USD|U\$S)\s?[\d.,]{3,}/i) || html.match(/\$\s?[\d.,]{4,}/);
  if (m) return m[0].trim();
  return null;
}
// Procesa una propiedad de la API + su ficha. Devuelve objeto con todos los campos para revision.
async function procesarPropiedad(p) {
  var emb = p._embedded || {};
  var terms = emb['wp:term'] || [];
  var feats = [];
  for (var a = 0; a < terms.length; a++) { var g = terms[a] || []; for (var b = 0; b < g.length; b++) { if (g[b].taxonomy === 'property_feature') feats.push(g[b].name); } }
  var media = emb['wp:featuredmedia'] || [];
  var foto = (media[0] && media[0].source_url) ? media[0].source_url : null;
  var titulo = limpiarHTML2(p.title && p.title.rendered);
  var descripcion = limpiarHTML2(p.content && p.content.rendered);
  var link = p.link || '';
  var pares = {}; var precio = null;
  try { var resp = await fetchScrape(link, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } }); if (resp.ok) { var html = await resp.text(); pares = extraerTablaDetalles(html); precio = extraerPrecio2(html); } } catch (e) {}
  var numero = detectarNumeroProp(pares, titulo, p.id);
  var operacion = detectarOperacion(pares['Estado'] || pares['Estado de la propiedad'], titulo + ' ' + descripcion.substring(0, 200));
  var ambientes = pares['Ambientes'] || pares['Habitaciones / Cuartos'] || pares['Habitaciones'] || null;
  var banos = pares['Banos'] || pares['Ba' + String.fromCharCode(241) + 'os'] || null;
  var parking = pares['Parking'] || pares['Cochera'] || pares['Garage'] || null;
  var ciudad = (pares['Ciudad/ Localidad'] || pares['Ciudad'] || pares['Localidad'] || '').split(',')[0].trim() || null;
  var zona = pares['Barrio/ Zona'] || pares['Zona'] || pares['Barrio'] || null;
  var caract = [].concat(feats);
  if (banos) caract.push('Banos: ' + banos);
  if (parking && !/no|aplica/i.test(parking)) caract.push('Cochera: ' + parking);
  return {
    numero: numero, titulo: titulo, tipo: pares['Tipo de propiedad'] || pares['Tipo'] || null,
    operacion: operacion, precio: precio, ambientes: ambientes, banos: banos,
    ciudad: ciudad, zona: zona, caracteristicas: caract.join(', '), descripcion: descripcion,
    link: link, foto: foto
  };
}

async function traerListaPropiedades(sitio, limite) {
  var baseUrl = sitio.replace(/\/+$/, '');
  var props = []; var pagina = 1; var seguir = true;
  try {
    while (seguir && props.length < (limite || 9999)) {
      var url = baseUrl + '/wp-json/wp/v2/properties?per_page=50&page=' + pagina + '&_embed=1';
      var r = await fetchScrape(url, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
      if (!r.ok) break;
      var data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      for (var i = 0; i < data.length; i++) props.push(data[i]);
      if (data.length < 50) seguir = false;
      pagina++;
    }
  } catch (e) {}
  if (limite) props = props.slice(0, limite);
  return props;
}
// Endpoint: devuelve las propiedades procesadas (para que el frontend muestre y el humano apruebe)
app.post('/api/scrape/v2', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var sitio = (req.body.url || '').trim();
    var limite = req.body.limite ? parseInt(req.body.limite, 10) : null;
    if (!sitio) return res.status(400).json({ error: 'Falta la url del sitio' });
    if (!sitio.startsWith('http')) sitio = 'https://' + sitio;
    // restringir al dominio propio del tenant (anti-scrape de competencia / explosion de costo IA)
    const _perm = await scrapeUrlPermitida(user_id, sitio);
    if (!_perm.ok) return res.status(400).json({ error: _perm.error });
    var lista = await traerListaPropiedades(sitio, limite);
    if (!lista.length) return res.json({ ok: false, mensaje: 'No se encontraron propiedades', propiedades: [] });
    var procesadas = [];
    for (var i = 0; i < lista.length; i++) {
      try { var pr = await procesarPropiedad(lista[i]); procesadas.push(pr); } catch (e) {}
    }
    return res.json({ ok: true, total: procesadas.length, propiedades: procesadas });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});


// ===== BANCO DE PROPIEDADES (para el chat / conversaciones) =====
// Devuelve las propiedades de la CUENTA del usuario logueado, resuelto server-side
// con la service key (que bypasea RLS). Esto arregla el bug donde un ASESOR veia
// "No hay propiedades" porque el frontend consultaba properties directo y la RLS
// lo bloqueaba (su auth.uid() != user_id del dueno de la cuenta).
// SEGURIDAD: el ownerId SIEMPRE se deriva del JWT del usuario (nunca de un
// parametro del request), asi un asesor solo ve las propiedades de SU cuenta.
app.get('/api/propiedades', async function(req, res) {
  try {
    var userId = await verificarUsuario(req);
    if (!userId) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    // Resolver el OWNER de la cuenta: si el usuario es un asesor, el dueno es su admin_id;
    // si no hay fila de asesor, el usuario ES el dueno de la cuenta.
    var ownerId = userId;
    var ase = await supabase.from('asesores').select('admin_id').eq('auth_user_id', userId).maybeSingle();
    if (ase && ase.data && ase.data.admin_id) ownerId = ase.data.admin_id;
    var q = await supabase.from('properties').select('*').eq('user_id', ownerId).order('numero');
    if (q.error) return res.status(500).json({ error: q.error.message });
    return res.json({ ok: true, propiedades: q.data || [] });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

// ===== CONFIG DE SCRAPING/IMPORTACION AUTOMATICA =====
app.get('/api/scraping-config', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var q = await supabase.from('scraping_config').select('*').eq('user_id', user_id).maybeSingle();
    return res.json({ ok: true, config: q.data || null });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});
app.post('/api/scraping-config', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var b = req.body || {};
    var fila = {
      user_id: user_id,
      fuente_tipo: (b.fuente_tipo === 'archivo') ? 'archivo' : 'web',
      fuente_url: (b.fuente_url || '').trim(),
      automatico: !!b.automatico,
      frecuencia: ['dos_por_dia','dias_semana','semanal','mensual'].indexOf(b.frecuencia) >= 0 ? b.frecuencia : 'semanal',
      horarios: Array.isArray(b.horarios) ? b.horarios : [],
      dias_semana: Array.isArray(b.dias_semana) ? b.dias_semana : [],
      modo: (b.modo === 'directo') ? 'directo' : 'pendiente'
    };
    var up = await supabase.from('scraping_config').upsert(fila, { onConflict: 'user_id' }).select().maybeSingle();
    if (up.error) return res.status(500).json({ error: up.error.message });
    return res.json({ ok: true, config: up.data });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});


// ===== MOTOR DE SCRAPING AUTOMATICO (revisa cada hora que cuentas deben actualizar inventario) =====
async function correrScrapingDeUsuario(cfg) {
  // trae propiedades de la fuente y las guarda en modo directo (upsert por numero)
  try {
    var sitio = (cfg.fuente_url || '').trim();
    if (!sitio) return { ok: false, motivo: 'sin url' };
    if (!sitio.startsWith('http')) sitio = 'https://' + sitio;
    var lista = await traerListaPropiedades(sitio, null);
    if (!lista.length) return { ok: false, motivo: 'sin propiedades' };
    var creados = 0, actualizados = 0, errores = 0;
    for (var i = 0; i < lista.length; i++) {
      try {
        var p = await procesarPropiedad(lista[i]);
        if (!p.numero) { errores++; continue; }
        var fila = {
          user_id: cfg.user_id, numero: String(p.numero), title: p.titulo || 'Sin titulo',
          type: p.tipo || null, zone: [p.ciudad, p.zona].filter(Boolean).join(' - ') || null,
          price: p.precio || null, description: p.descripcion || null,
          caracteristicas: p.caracteristicas || null, link: p.link || null, activa: true
        };
        var ex = await supabase.from('properties').select('id').eq('user_id', cfg.user_id).eq('numero', String(p.numero)).maybeSingle();
        if (ex.data && ex.data.id) {
          var up = await supabase.from('properties').update(fila).eq('id', ex.data.id);
          if (up.error) errores++; else actualizados++;
        } else {
          var ins = await supabase.from('properties').insert(fila);
          if (ins.error) errores++; else creados++;
        }
      } catch (e) { errores++; }
    }
    return { ok: true, creados: creados, actualizados: actualizados, errores: errores, total: lista.length };
  } catch (e) { return { ok: false, motivo: e && e.message }; }
}

// Endpoint para correr el scraping automatico de una cuenta a pedido (sirve para probar el motor)
app.post('/api/scraping-config/correr-ahora', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var q = await supabase.from('scraping_config').select('*').eq('user_id', user_id).maybeSingle();
    if (!q.data) return res.json({ ok: false, mensaje: 'No hay configuracion guardada' });
    var r = (q.data.modo === 'directo') ? await correrScrapingDeUsuario(q.data) : await correrScrapingPendiente(q.data);
    await supabase.from('scraping_config').update({ ultimo_scraping: new Date().toISOString() }).eq('user_id', user_id);
    return res.json({ ok: true, resultado: r });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

async function correrScrapingPendiente(cfg) {
  // compara lo scrapeado con la base y guarda diferencias en scraping_pendientes (no aplica)
  try {
    var sitio = (cfg.fuente_url || '').trim();
    if (!sitio) return { ok: false, motivo: 'sin url' };
    if (!sitio.startsWith('http')) sitio = 'https://' + sitio;
    var lista = await traerListaPropiedades(sitio, null);
    if (!lista.length) return { ok: false, motivo: 'sin propiedades' };
    // limpiar pendientes anteriores de este usuario (se reemplazan por el scraping nuevo)
    await supabase.from('scraping_pendientes').delete().eq('user_id', cfg.user_id);
    var nuevas = 0, modificadas = 0;
    for (var i = 0; i < lista.length; i++) {
      try {
        var p = await procesarPropiedad(lista[i]);
        if (!p.numero) continue;
        var nuevo = {
          numero: String(p.numero), title: p.titulo || 'Sin titulo', type: p.tipo || null,
          zone: [p.ciudad, p.zona].filter(Boolean).join(' - ') || null, price: p.precio || null,
          description: p.descripcion || null, caracteristicas: p.caracteristicas || null, link: p.link || null
        };
        var ex = await supabase.from('properties').select('id,title,price,zone,description').eq('user_id', cfg.user_id).eq('numero', String(p.numero)).maybeSingle();
        if (ex.data && ex.data.id) {
          // existe: detectar si cambio algo relevante (precio, titulo, zona, descripcion)
          var v = ex.data;
          var cambio = (String(v.price||'') !== String(nuevo.price||'')) || (String(v.title||'') !== String(nuevo.title||'')) || (String(v.zone||'') !== String(nuevo.zone||'')) || (String(v.description||'') !== String(nuevo.description||''));
          if (cambio) {
            await supabase.from('scraping_pendientes').insert({ user_id: cfg.user_id, numero: String(p.numero), tipo_cambio: 'modificada', titulo: nuevo.title, datos_nuevos: nuevo, datos_viejos: { title: v.title, price: v.price, zone: v.zone }, property_id: v.id });
            modificadas++;
          }
        } else {
          // no existe: es nueva
          await supabase.from('scraping_pendientes').insert({ user_id: cfg.user_id, numero: String(p.numero), tipo_cambio: 'nueva', titulo: nuevo.title, datos_nuevos: nuevo, datos_viejos: null, property_id: null });
          nuevas++;
        }
      } catch (e) {}
    }
    return { ok: true, nuevas: nuevas, modificadas: modificadas, total: lista.length };
  } catch (e) { return { ok: false, motivo: e && e.message }; }
}
async function revisarScrapingsAutomaticos() {
  try {
    var q = await supabase.from('scraping_config').select('*').eq('automatico', true);
    var cuentas = q.data || [];
    if (!cuentas.length) return;
    var ahora = new Date();
    var hoyStr = ahora.toISOString().substring(0, 10);
    var diaSemana = ahora.getDay();
    var diaMes = ahora.getDate();
    var horaActual = ahora.getHours();
    var nombresDias = ['dom','lun','mar','mie','jue','vie','sab'];
    var diaHoy = nombresDias[diaSemana];
    for (var i = 0; i < cuentas.length; i++) {
      var cfg = cuentas[i];
      var horarios = Array.isArray(cfg.horarios) ? cfg.horarios : [];
      var dias = Array.isArray(cfg.dias_semana) ? cfg.dias_semana : [];
      // determinar la hora objetivo segun frecuencia
      var horasObjetivo = horarios.map(function(h){ return parseInt(String(h).split(':')[0], 10); }).filter(function(n){ return !isNaN(n); });
      if (!horasObjetivo.length) horasObjetivo = [9];
      var leToca = false;
      // marca anti-repeticion: para dos_por_dia usamos fecha+hora; para el resto, fecha
      var marca = hoyStr;
      if (cfg.frecuencia === 'dos_por_dia') {
        if (horasObjetivo.indexOf(horaActual) >= 0) { leToca = true; marca = hoyStr + '-' + horaActual; }
      } else if (cfg.frecuencia === 'dias_semana') {
        if (dias.indexOf(diaHoy) >= 0 && horaActual === horasObjetivo[0]) leToca = true;
      } else if (cfg.frecuencia === 'semanal') {
        if (diaSemana === 1 && horaActual === horasObjetivo[0]) leToca = true;
      } else if (cfg.frecuencia === 'mensual') {
        if (diaMes === 1 && horaActual === horasObjetivo[0]) leToca = true;
      }
      if (!leToca) continue;
      // anti-repeticion: si ya corrio con esta marca, saltar
      if (cfg.ultimo_scraping && String(cfg.ultimo_scraping).indexOf(marca) >= 0) continue;
      // correr el scraping (modo directo en esta version)
      if (cfg.modo === 'directo') {
        await correrScrapingDeUsuario(cfg);
      } else {
        await correrScrapingPendiente(cfg);
      }
      // registrar que corrio (guarda la marca para no repetir)
      await supabase.from('scraping_config').update({ ultimo_scraping: ahora.toISOString().substring(0,13) + ':00:00 marca=' + marca }).eq('user_id', cfg.user_id);
    }
  } catch (e) {}
}
// revisar cada hora, con un arranque inicial a los 90 segundos del deploy
setInterval(revisarScrapingsAutomaticos, 60 * 60 * 1000);
setTimeout(revisarScrapingsAutomaticos, 90 * 1000);


// ===== BANDEJA DE CAMBIOS PENDIENTES (modo 'deja pendientes') =====
app.get('/api/scraping-pendientes', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var q = await supabase.from('scraping_pendientes').select('*').eq('user_id', user_id).order('created_at', { ascending: true });
    return res.json({ ok: true, pendientes: q.data || [] });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});
app.post('/api/scraping-pendientes/aceptar', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var soloId = (req.body && req.body.id) ? req.body.id : null;
    var query = supabase.from('scraping_pendientes').select('*').eq('user_id', user_id);
    if (soloId) query = query.eq('id', soloId);
    var q = await query;
    var items = q.data || [];
    var aplicados = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var d = it.datos_nuevos || {};
      var fila = { user_id: user_id, numero: String(it.numero), title: d.title || 'Sin titulo', type: d.type || null, zone: d.zone || null, price: d.price || null, description: d.description || null, caracteristicas: d.caracteristicas || null, link: d.link || null, activa: true };
      if (it.tipo_cambio === 'modificada' && it.property_id) {
        await supabase.from('properties').update(fila).eq('id', it.property_id);
      } else {
        var ex = await supabase.from('properties').select('id').eq('user_id', user_id).eq('numero', String(it.numero)).maybeSingle();
        if (ex.data && ex.data.id) { await supabase.from('properties').update(fila).eq('id', ex.data.id); }
        else { await supabase.from('properties').insert(fila); }
      }
      await supabase.from('scraping_pendientes').delete().eq('id', it.id);
      aplicados++;
    }
    return res.json({ ok: true, aplicados: aplicados });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});
app.post('/api/scraping-pendientes/rechazar', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var soloId = (req.body && req.body.id) ? req.body.id : null;
    if (soloId) { await supabase.from('scraping_pendientes').delete().eq('user_id', user_id).eq('id', soloId); }
    else { await supabase.from('scraping_pendientes').delete().eq('user_id', user_id); }
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});


// ===== CHAT DE PRUEBA DEL AGENTE (no guarda nada, no manda WhatsApp) =====
app.post('/api/probar-agente', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var message = (req.body && req.body.message) ? String(req.body.message) : '';
    var historial = (req.body && Array.isArray(req.body.historial)) ? req.body.historial : [];
    if (!message.trim()) return res.status(400).json({ error: 'Mensaje vacio' });
    var r = await generarRespuestaAgente(user_id, null, message, { modoPrueba: true, historialManual: historial });
    return res.json({ ok: true, reply: r.reply });
  } catch (e) { console.error('Error probar-agente:', e); return res.status(500).json({ error: e && e.message }); }
});

// ===== SUSCRIPCIONES: estado, checkout y webhook de MercadoPago (FASE 1) =====
// Inerte mientras no haya MERCADOPAGO_ACCESS_TOKEN / tabla subscriptions: responden 503 o vacio sin romper.

// Estado del plan del tenant (para la pantalla "Mi plan" del frontend).
app.get('/api/suscripcion', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var sub = await getSubscription(user_id);
    var plan = await planActual(user_id);
    var lim = PLAN_LIMITS[plan] || PLAN_LIMITS[PLAN_DEFECTO];
    // El cliente ve su tope de mensajes EFECTIVO (grandfathered o nuevo; y si tiene override del Maestro, ese manda).
    var topeEfectivo = topeMensajesPlan(plan, sub);
    if (sub && sub.limits_override && typeof sub.limits_override.ai_messages === 'number') topeEfectivo = sub.limits_override.ai_messages;
    lim = Object.assign({}, lim, { ai_messages: topeEfectivo });
    var usado = await usoMensajesIA(user_id);
    // Senal AUTORITATIVA para el frontend: congelar el acceso si el tenant debe pagar y no lo hizo.
    // Misma logica EXACTA con la que el agente corta el servicio (debeBloquearAcceso). FAIL-OPEN.
    var bloqueado = await debeBloquearAcceso(user_id);
    return res.json({ ok: true, habilitado: SUBSCRIPTIONS_ENABLED, plan: plan, estado: (sub && sub.status) || null, limites: lim, uso: { ai_messages: usado }, vence: (sub && sub.current_period_end) || null, bloqueado: bloqueado });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

// Inicia el checkout de una suscripcion: devuelve init_point (URL de MP) para redirigir al cliente.
app.post('/api/suscripcion/checkout', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    if (!MP_TOKEN) return res.status(503).json({ error: 'MercadoPago no configurado todavia' });
    var nivel = (req.body && req.body.plan) ? String(req.body.plan) : '';
    var email = (req.body && req.body.email) ? String(req.body.email) : '';
    if (['basico','pro','premium','enterprise'].indexOf(nivel) < 0) return res.status(400).json({ error: 'Plan invalido' });
    if (!email) return res.status(400).json({ error: 'Falta email del pagador' });
    // Los planes son GLOBALES (del SaaS), no per-tenant.
    var planId = PLANES_MP[nivel] || null;
    if (!planId) return res.status(503).json({ error: 'Ese plan todavia no esta disponible' });
    var backUrl = (process.env.BACKEND_PUBLIC_URL || 'https://raices-crm.vercel.app') + '/suscripcion/listo';
    var sus = await mpCrearSuscripcion(planId, email, user_id, backUrl);
    // Guardar el plan ELEGIDO en la fila para que se apliquen sus limites al activarse (el webhook NO incluye
    // 'plan' en su upsert -> se preserva). Asi un Enterprise queda con 20.000 y no cae al default. Si el tenant
    // NO esta active/cortesia, lo dejamos en 'trial' (bloqueado por el candado) hasta que MP confirme el pago;
    // si YA esta active (upgrade de plan), NO tocamos el status para no cortarle el acceso durante el cambio.
    try {
      var subPrev = await getSubscription(user_id);
      var filaPlan = { user_id: user_id, plan: nivel };
      if (!(subPrev && (subPrev.status === 'active' || subPrev.cortesia === true))) filaPlan.status = 'trial';
      await supabase.from('subscriptions').upsert(filaPlan, { onConflict: 'user_id' });
    } catch (eP) { console.error('checkout guardar plan:', eP && eP.message); }
    return res.json({ ok: true, init_point: sus && (sus.init_point || sus.sandbox_init_point), id: sus && sus.id });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

// Webhook de MercadoPago: avisa cambios de suscripcion/pago. Inerte si no hay token o la funcion esta apagada.
app.post('/api/webhook/mercadopago', async function(req, res) {
  res.sendStatus(200); // responder rapido siempre (MP reintenta si no)
  try {
    if (!MP_TOKEN || !SUBSCRIPTIONS_ENABLED) return;
    var tipo = String((req.body && (req.body.type || req.body.topic)) || '');
    var dataId = (req.body && req.body.data && req.body.data.id) || (req.query && req.query['data.id']) || null;
    if (tipo.indexOf('subscription') < 0 && tipo.indexOf('preapproval') < 0) return;
    if (!dataId) return;
    var sus = await mpConsultarSuscripcion(dataId);
    if (!sus) return;
    var user_id = sus.external_reference || null; // lo seteamos al crear la suscripcion
    if (!user_id) return;
    var estado = (sus.status === 'authorized') ? 'active' : (sus.status === 'paused' ? 'past_due' : (sus.status === 'cancelled' ? 'cancelled' : 'trial'));
    // Resolver el nivel del plan desde el preapproval_plan_id (planes globales)
    var planNivel = null;
    var ppId = sus.preapproval_plan_id || null;
    if (ppId) { Object.keys(PLANES_MP).forEach(function(k){ if (PLANES_MP[k] === ppId) planNivel = k; }); }
    // Leer el estado/plan ANTERIOR para distinguir suscripcion NUEVA vs CAMBIO de plan (best-effort).
    var prevSub = null;
    try { var ps = await supabase.from('subscriptions').select('status, plan').eq('user_id', user_id).maybeSingle(); prevSub = ps && ps.data ? ps.data : null; } catch (ePrev) {}
    var fila = { user_id: user_id, status: estado, mp_preapproval_id: sus.id, current_period_end: sus.next_payment_date || null };
    if (planNivel) fila.plan = planNivel;
    await supabase.from('subscriptions').upsert(fila, { onConflict: 'user_id' });
    // NOTIF MAESTRO (best-effort, nunca rompe el webhook). Criterio:
    //  - cancelled            -> 'suscripcion_cancelada'
    //  - active 1ra vez       -> 'suscripcion_nueva' (antes NO estaba 'active')
    //  - active + cambio plan -> 'suscripcion_cambio' (ya estaba 'active' pero cambio el nivel del plan)
    try {
      var prevEstado = prevSub && prevSub.status ? prevSub.status : null;
      var prevPlan = prevSub && prevSub.plan ? prevSub.plan : null;
      if (estado === 'cancelled' && prevEstado !== 'cancelled') {
        crearNotifMaestro('suscripcion_cancelada', 'Suscripcion cancelada', 'Un cliente cancelo su suscripcion' + (prevPlan ? ' (plan ' + prevPlan + ')' : '') + '.', { ref_user_id: user_id, ref_id: sus.id, severidad: 'warning' }).catch(function(){});
      } else if (estado === 'active') {
        if (prevEstado !== 'active') {
          crearNotifMaestro('suscripcion_nueva', 'Suscripcion nueva', 'Un cliente activo su suscripcion' + (planNivel ? ' (plan ' + planNivel + ')' : '') + '.', { ref_user_id: user_id, ref_id: sus.id, severidad: 'info' }).catch(function(){});
        } else if (planNivel && prevPlan && planNivel !== prevPlan) {
          crearNotifMaestro('suscripcion_cambio', 'Cambio de plan', 'Un cliente cambio de plan: ' + prevPlan + ' -> ' + planNivel + '.', { ref_user_id: user_id, ref_id: sus.id, severidad: 'info' }).catch(function(){});
        }
      }
    } catch (eNotif) {}
  } catch (e) { console.error('webhook mercadopago:', e && e.message); }
});

// (endpoint temporal /api/mp-setup-planes eliminado: los 3 planes base ya estan creados y sus IDs viven en PLANES_MP)

// Crea el plan ENTERPRISE en MercadoPago (una vez). Gateado por auth Maestro. Misma config que los otros
// (mensual, 4 dias de prueba, ARS, credito+debito) via mpCrearPlan. Devuelve el id para cargarlo en la env
// MP_PLAN_ENTERPRISE de Railway (mismo patron que los 3 planes base). Si ya esta seteado, no crea otro.
app.post('/api/maestro/mp-crear-plan-enterprise', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    if (!MP_TOKEN) return res.status(503).json({ error: 'MercadoPago no configurado' });
    if (PLANES_MP.enterprise) return res.json({ ok: true, yaConfigurado: true, id: PLANES_MP.enterprise, aviso: 'Ya hay un plan Enterprise configurado (env MP_PLAN_ENTERPRISE). Para recrearlo, borra esa variable primero.' });
    var backUrl = (process.env.BACKEND_PUBLIC_URL || 'https://raices-crm.vercel.app') + '/suscripcion/listo';
    var plan = await mpCrearPlan('Raices CRM - Plan Enterprise', 500000, backUrl);
    return res.json({ ok: true, id: plan && plan.id, aviso: 'Plan Enterprise creado en MP. Copia este id a la variable MP_PLAN_ENTERPRISE en Railway y redeploya para activarlo.' });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// ===== SOPORTE: el cliente envia un mensaje (error/sugerencia/modificacion) que llega al panel maestro =====
app.post('/api/soporte', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var categoria = (req.body && req.body.categoria) ? String(req.body.categoria).slice(0, 40) : 'consulta';
    var mensaje = (req.body && req.body.mensaje) ? String(req.body.mensaje).slice(0, 4000) : '';
    var telefono = (req.body && req.body.telefono) ? String(req.body.telefono).replace(/[^0-9+ ]/g, '').slice(0, 30) : '';
    if (!mensaje.trim()) return res.status(400).json({ error: 'El mensaje esta vacio' });
    // DEFENSIVO: intentar con telefono; si la columna aun no existe (migracion pendiente), reintentar sin el. Soporte nunca se rompe.
    var ins = await supabase.from('support_messages').insert({ user_id: user_id, categoria: categoria, mensaje: mensaje, estado: 'abierto', telefono: telefono });
    if (ins.error && /telefono|column|does not exist|schema cache/i.test(String(ins.error.message || ''))) {
      ins = await supabase.from('support_messages').insert({ user_id: user_id, categoria: categoria, mensaje: mensaje, estado: 'abierto' });
    }
    if (ins.error) { console.error('soporte insert:', ins.error.message); return res.status(503).json({ error: 'El soporte se esta habilitando, intenta mas tarde' }); }
    // NOTIF MAESTRO (best-effort, nunca rompe el soporte)
    crearNotifMaestro('soporte', 'Nuevo ticket de soporte', '[' + categoria + '] ' + mensaje.slice(0, 280), { ref_user_id: user_id, severidad: 'info' }).catch(function(){});
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

// ===== AGENTE DE IA DE SOPORTE: responde dudas del cliente sobre como funciona el CRM, y escala a humano si hace falta =====
// Conocimiento del producto CONDENSADO a partir de las 9 secciones de la pagina de Ayuda (texto embebido, sin imports cross-repo).
var CONOCIMIENTO_SOPORTE = [
  'CRM Raices: CRM inmobiliario con un agente de IA (Sofia) que responde a tus leads por WhatsApp. Secciones del producto:',
  '',
  '1) PANEL PRINCIPAL (Dashboard): pantalla de inicio. Muestra de un vistazo cuantas conversaciones tenes, cuantas necesitan atencion de un humano, cuantas estan en recontacto y cuantas se cerraron. Los numeros se actualizan solos. Las tarjetas de arriba son un resumen (mira sobre todo "Necesitan atencion"); mas abajo ves las conversaciones recientes con su estado. Usa el menu para entrar a cada seccion.',
  '',
  '2) CONVERSACIONES: es el corazon del CRM. Aca ves todos los chats con tus leads de WhatsApp, Instagram y Messenger en un solo lugar y podes responder vos cuando haga falta. A la izquierda la lista de chats; a la derecha la conversacion abierta. Cada chat tiene un estado (en conversacion, interesado, listo para humano, recontacto, cerrado). La IA responde sola salvo que la pauses o el chat pase a "Listo para humano" (ahi la IA se apaga sola en ese chat). Usa "Tomar conversacion" para responder vos y "Devolver a IA" para reactivarla. Escribi abajo para mandar un mensaje manual.',
  '',
  '3) INTEGRACIONES (conectar WhatsApp): aca conectas tu numero de WhatsApp para que Sofia empiece a responder. Al conectar se genera un codigo QR que escaneas con tu telefono (como WhatsApp Web). Una vez conectado, los mensajes entran solos a Conversaciones. El boton "IA ACTIVA / IA PAUSADA" frena o reactiva las respuestas automaticas de toda la cuenta (los mensajes igual llegan). Tambien podes importar tus contactos anteriores desde aca.',
  '',
  '4) INVENTARIO (propiedades): es el listado de propiedades o unidades que ofreces. Sofia usa este inventario para responder con datos reales (precios, zonas, caracteristicas). Cada propiedad tiene tipo, operacion (venta/alquiler), zona, precio y detalles. Podes importar tu inventario para cargarlo de una. Cuanto mejor cargado este, mas precisas son las respuestas del agente.',
  '',
  '5) RECONTACTOS: sirve para no perder leads que se enfriaron. La IA vuelve a escribirles sola a los que dejaron de responder, hasta cierta cantidad de intentos y dentro del horario que configures. Revisa los leads en cola de recontacto; el sistema los contacta solo segun la configuracion. El horario y la cantidad de intentos se configuran en Configuracion.',
  '',
  '6) ASESORES: te permite dar acceso a tu equipo de ventas. Cada asesor entra con su propio usuario y ve las conversaciones que le corresponden. Vos (administrador) creas los asesores con usuario y clave; ellos entran a una version del CRM enfocada en atender los chats asignados. Podes activarlos, desactivarlos o cambiarles la clave. Para crear uno: "Crear nuevo asesor" y carga nombre, usuario y clave.',
  '',
  '7) CONFIGURACION DEL AGENTE: aca defines como se comporta Sofia: el rubro del negocio, el tono, hasta donde avanza con el lead, el idioma base y el horario de oficina. El rubro ajusta el vocabulario, el tono define si es mas formal o cercano, y el objetivo define hasta donde lleva al lead antes de derivarlo a un humano. Elegi rubro, tono y nivel de autonomia, defini idioma y horario, y apreta "Guardar configuracion". Si cambias el idioma, la pantalla se actualiza sola.',
  '',
  '8) BASE DE CONOCIMIENTO: es la memoria del agente. Cargas preguntas frecuentes y datos del negocio (horarios, formas de pago, ubicacion, politicas) para que Sofia responda con info correcta. Se organiza por categorias; cada entrada es una pregunta y su respuesta. Elegi una categoria, carga la pregunta y la respuesta con "+ Agregar a la base". Cuanto mas completes, mejor responde Sofia.',
  '',
  '9) IMPORTAR LEADS: sirve para subir una lista de contactos que ya tenes (archivo CSV) y cargarlos como leads para hacerles recontacto. Tambien podes traer los contactos que ya te escribieron a tu WhatsApp. Prepara el CSV, arrastralo o hace clic para elegirlo, y el CRM los carga como leads listos para recontactar.'
].join('\n');

app.post('/api/soporte/agente', async function(req, res) {
  try {
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var pregunta = (req.body && req.body.pregunta) ? String(req.body.pregunta).slice(0, 2000) : '';
    var telefono = (req.body && req.body.telefono) ? String(req.body.telefono).replace(/[^0-9+ ]/g, '').slice(0, 30) : '';
    if (!pregunta.trim()) return res.status(400).json({ error: 'La consulta esta vacia' });

    var sys = 'Sos el asistente de soporte del CRM Raices. Respondé SOLO con la info provista sobre cómo funciona el producto, en español rioplatense, claro y breve. Si la consulta requiere una ACCIÓN que cambia la cuenta (cancelar suscripción, cambiar límites, pausar, borrar datos) NO la ejecutes: explicá y ofrecé derivar a una persona. Si no sabés la respuesta o el usuario pide hablar con alguien, indicá que derivás al equipo.\n\nCONOCIMIENTO DEL PRODUCTO:\n' + CONOCIMIENTO_SOPORTE + '\n\nAl final de tu respuesta, en una linea aparte, escribi exactamente "ESCALAR: SI" si no podes resolver la consulta con la info de arriba, si el usuario pide hablar con una persona, o si pide una accion que cambia la cuenta; en cualquier otro caso escribi "ESCALAR: NO". Esa linea es interna, el usuario igual la vera.';

    var respuesta = '';
    var escalado = false;
    try {
      var r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 700, system: sys, messages: [{ role: 'user', content: 'Consulta del cliente: ' + pregunta }] });
      try { if (r && r.usage) await registrarUsoTokens(user_id, r.usage); } catch (eU) {}
      var texto = (r && r.content && r.content[0] && r.content[0].text) ? r.content[0].text : '';
      // Detectar la marca de escalamiento y removerla de la respuesta visible.
      var m = /ESCALAR:\s*(SI|SÍ|NO)/i.exec(texto);
      if (m) { escalado = /S/i.test(m[1]); texto = texto.replace(/\s*ESCALAR:\s*(SI|SÍ|NO)\s*/gi, ' ').trim(); }
      respuesta = texto || 'No pude generar una respuesta. Te derivo con el equipo.';
      if (!texto) escalado = true;
    } catch (eIA) {
      console.error('soporte/agente IA:', eIA && eIA.message);
      respuesta = 'No pude procesar tu consulta en este momento. Te derivo con el equipo.';
      escalado = true;
    }

    if (escalado) {
      // DEFENSIVO: insertar la fila escalada con telefono; si la columna no existe aun, reintentar sin el. Nunca rompe.
      var fila = { user_id: user_id, categoria: 'consulta', mensaje: pregunta, estado: 'escalado' };
      var ins = await supabase.from('support_messages').insert(Object.assign({}, fila, { telefono: telefono }));
      if (ins.error && /telefono|column|does not exist|schema cache/i.test(String(ins.error.message || ''))) {
        ins = await supabase.from('support_messages').insert(fila);
      }
      if (ins.error) console.error('soporte/agente escalar insert:', ins.error.message);
      // NOTIF MAESTRO: el agente de soporte ESCALO a humano (best-effort, nunca rompe). Mas urgente -> warning.
      crearNotifMaestro('soporte', 'Soporte escalado a humano', pregunta.slice(0, 280), { ref_user_id: user_id, severidad: 'warning' }).catch(function(){});
    }

    return res.json({ ok: true, respuesta: respuesta, escalado: escalado });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

// ===== PANEL MAESTRO (superadmin/creador) — DOBLE GATEADO: MAESTRO_ENABLED + credenciales (dormido si no se activa) =====
const _cripto = require('crypto');
const MAESTRO_ENABLED = String(process.env.MAESTRO_ENABLED || '').toLowerCase() === 'true';
const MAESTRO_SECRET = process.env.MAESTRO_SECRET || ('rz-maestro-' + String(process.env.SUPABASE_SERVICE_KEY || 'x').slice(0, 16));
const MAESTRO_BOOTSTRAP = process.env.MAESTRO_BOOTSTRAP || '';

// TOTP (RFC 6238, SHA1, 6 digitos, ventana +-30s) sin dependencias
function _b32dec(s){ var a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; var bits=''; s=String(s).replace(/=+$/,'').toUpperCase(); for(var i=0;i<s.length;i++){ var idx=a.indexOf(s[i]); if(idx<0) continue; bits+=idx.toString(2).padStart(5,'0'); } var bytes=[]; for(var j=0;j+8<=bits.length;j+=8){ bytes.push(parseInt(bits.slice(j,j+8),2)); } return Buffer.from(bytes); }
function _totpAt(secret, counter){ var key=_b32dec(secret); var buf=Buffer.alloc(8); buf.writeUInt32BE(Math.floor(counter/4294967296),0); buf.writeUInt32BE(counter>>>0,4); var h=_cripto.createHmac('sha1',key).update(buf).digest(); var o=h[h.length-1]&0xf; var n=((h[o]&0x7f)<<24)|((h[o+1]&0xff)<<16)|((h[o+2]&0xff)<<8)|(h[o+3]&0xff); return String(n%1000000).padStart(6,'0'); }
function _totpOk(secret, code){ if(!secret||!code) return false; var c=Math.floor(Date.now()/1000/30); for(var w=-1;w<=1;w++){ if(_totpAt(secret,c+w)===String(code).trim()) return true; } return false; }
function _totpNuevo(){ var a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; var b=_cripto.randomBytes(32); var s=''; for(var i=0;i<32;i++) s+=a[b[i]%32]; return s; }
function _hashPass(p, salt){ return _cripto.scryptSync(String(p), String(salt), 32).toString('hex'); }
function _maestroToken(){ var payload=Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600 })).toString('base64'); var sig=_cripto.createHmac('sha256',MAESTRO_SECRET).update(payload).digest('hex'); return payload+'.'+sig; }
function _maestroTokenOk(tok){ try{ if(!tok) return false; var parts=String(tok).split('.'); if(parts.length!==2) return false; var sig=_cripto.createHmac('sha256',MAESTRO_SECRET).update(parts[0]).digest('hex'); if(sig!==parts[1]) return false; var p=JSON.parse(Buffer.from(parts[0],'base64').toString()); return p.exp > Math.floor(Date.now()/1000); }catch(e){ return false; } }
function maestroAuth(req){ var auth=req.headers.authorization||req.headers.Authorization||''; var tok=(auth.indexOf('Bearer ')===0) ? auth.slice(7) : null; return _maestroTokenOk(tok); }

// ===== KILL-SWITCH GLOBAL (#15): "Pausar TODO el sistema" =====
// Flag global persistido en superadmin_config.pausa_global (fila id=1). Cuando esta en true, el GATE TEMPRANO del
// webhook lo trata como pausa TOTAL para TODOS los clientes -> cero tokens de IA, mensaje crudo guardado, igual que
// la pausa por-cliente (crm_pausado). Para NO hacer una query por mensaje, se cachea en memoria (_pausaGlobal) y se
// refresca con un setInterval cada 30s. El endpoint /api/maestro/pausa-global ademas la setea al instante (sin esperar
// los 30s). Es ADITIVO: si la tabla/columna no existe todavia, _pausaGlobal queda en false (fail-open, no rompe nada).
var _pausaGlobal = false;
async function refrescarPausaGlobal() {
  try {
    var r = await supabase.from('superadmin_config').select('pausa_global').eq('id', 1).maybeSingle();
    if (r && r.error) return; // tabla/columna inexistente o error transitorio: NO tocar el valor cacheado
    _pausaGlobal = !!(r && r.data && r.data.pausa_global === true);
  } catch (e) { /* best-effort: ante error se mantiene el ultimo valor conocido */ }
}
setInterval(refrescarPausaGlobal, 30 * 1000);
setTimeout(refrescarPausaGlobal, 5 * 1000); // primera lectura al arrancar (despues de que Supabase este listo)

// ===== 2FA GATES ('ingreso' / 'eliminar') + PAPELERA — almacen en tabla maestro_config (service key) =====
// Genera un secreto base32 de 20 bytes aleatorios (estandar Google Authenticator; reusa _b32enc).
function _b32enc(buf){ var a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; var bits=''; for(var i=0;i<buf.length;i++){ bits+=buf[i].toString(2).padStart(8,'0'); } var out=''; for(var j=0;j<bits.length;j+=5){ var chunk=bits.slice(j,j+5); if(chunk.length<5) chunk=chunk.padEnd(5,'0'); out+=a[parseInt(chunk,2)]; } return out; }
function _secret2fa(){ return _b32enc(_cripto.randomBytes(20)); }
// Arma el otpauth para mostrar el QR/manual una sola vez.
function _otpauth2fa(cual, secret){ var label = (cual === 'eliminar') ? 'Eliminar' : 'Ingreso'; return 'otpauth://totp/RaicesCRM%20Maestro%20(' + label + ')?secret=' + secret + '&issuer=RaicesCRM&period=30&digits=6'; }
// Normaliza el parametro 'cual' a uno de los dos gates validos (o null).
function _gate2fa(v){ var s=String(v||'').trim().toLowerCase(); return (s==='ingreso'||s==='eliminar') ? s : null; }
// Lee el secreto guardado de un gate. Degrada bien si la tabla maestro_config aun no existe -> null (no-configurado).
async function _getSecret2fa(cual){ try{ var clave='2fa_'+cual; var r=await supabase.from('maestro_config').select('valor').eq('clave',clave).maybeSingle(); if(r && r.error) return null; return (r && r.data && r.data.valor) ? String(r.data.valor) : null; }catch(e){ return null; } }
// Guarda/regenera el secreto de un gate (service key). Devuelve {ok, error?}.
async function _setSecret2fa(cual, secret){ try{ var clave='2fa_'+cual; var r=await supabase.from('maestro_config').upsert({ clave: clave, valor: secret, updated_at: new Date().toISOString() }, { onConflict: 'clave' }); if(r && r.error) return { ok:false, error: r.error.message }; return { ok:true }; }catch(e){ return { ok:false, error: (e && e.message) || 'error' }; } }
// Verifica un codigo TOTP contra el secreto guardado de un gate (server-side, RFC6238 +-1 ventana via _totpOk).
async function _verificar2fa(cual, codigo){ var sec=await _getSecret2fa(cual); if(!sec) return false; return _totpOk(sec, codigo); }

// Estado de los dos gates 2FA (configurado = hay secreto guardado). No expone los secretos.
app.get('/api/maestro/2fa/estado', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var ing = await _getSecret2fa('ingreso');
    var eli = await _getSecret2fa('eliminar');
    return res.json({ ok: true, ingresoConfigurado: !!ing, eliminarConfigurado: !!eli });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Genera/regenera el secreto de un gate, lo guarda server-side y devuelve secret+otpauth (para QR/manual UNA vez).
app.post('/api/maestro/2fa/setup', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var cual = _gate2fa(req.body && req.body.cual);
    if (!cual) return res.status(400).json({ error: "cual debe ser 'ingreso' o 'eliminar'" });
    // SEGURIDAD: una vez configurado un gate, NADIE (ni quien entre al Maestro) puede volver a ver ni regenerar
    // el secreto desde el panel. Asi el codigo vive SOLO en el celular del dueno y no se puede capturar ni tomar
    // control del gate. El setup solo se permite la PRIMERA vez (gate sin secreto). Para RESETEAR hay que borrar
    // manualmente la fila de maestro_config en Supabase (accion deliberada y fuera del panel, a pedido del dueno).
    var ya = await _getSecret2fa(cual);
    if (ya) return res.status(409).json({ error: 'Ese codigo ya esta configurado. Por seguridad no se vuelve a mostrar; para resetearlo hay que borrar su fila en la base (a proposito).' });
    var secret = _secret2fa();
    var g = await _setSecret2fa(cual, secret);
    if (!g.ok) return res.status(503).json({ error: 'Falta la tabla maestro_config: ' + g.error });
    return res.json({ ok: true, secret: secret, otpauth: _otpauth2fa(cual, secret) });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Verifica un codigo de un gate (server-side). Devuelve { ok:bool }.
app.post('/api/maestro/2fa/verificar', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var cual = _gate2fa(req.body && req.body.cual);
    if (!cual) return res.status(400).json({ error: "cual debe ser 'ingreso' o 'eliminar'" });
    var codigo = (req.body && req.body.codigo) ? String(req.body.codigo) : '';
    var ok = await _verificar2fa(cual, codigo);
    return res.json({ ok: !!ok });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// SOFT-DELETE (papelera): exige codigo del gate 'eliminar' valido (server-side). NO borra datos, solo marca eliminado_at.
app.post('/api/maestro/cliente/eliminar', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var uid = (req.body && req.body.user_id) ? String(req.body.user_id) : '';
    var codigo = (req.body && req.body.codigo) ? String(req.body.codigo) : '';
    if (!uid) return res.status(400).json({ error: 'Falta user_id' });
    if (!(await _verificar2fa('eliminar', codigo))) return res.status(403).json({ ok: false, error: 'codigo' });
    var up = await supabase.from('business_settings').update({ eliminado_at: new Date().toISOString() }).eq('user_id', uid);
    if (up.error) return res.status(500).json({ ok: false, error: up.error.message });
    try { await supabase.from('admin_audit').insert({ accion: 'eliminar_cliente_papelera', target_user_id: uid, detalle: '{}' }); } catch(eA){}
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// RESTAURAR: saca al cliente de la papelera (eliminado_at = null). Gateado por auth Maestro; codigo 'eliminar' opcional (si viene, se valida).
app.post('/api/maestro/cliente/restaurar', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var uid = (req.body && req.body.user_id) ? String(req.body.user_id) : '';
    if (!uid) return res.status(400).json({ error: 'Falta user_id' });
    var codigo = (req.body && req.body.codigo) ? String(req.body.codigo) : '';
    if (codigo) { if (!(await _verificar2fa('eliminar', codigo))) return res.status(403).json({ ok: false, error: 'codigo' }); }
    var up = await supabase.from('business_settings').update({ eliminado_at: null }).eq('user_id', uid);
    if (up.error) return res.status(500).json({ ok: false, error: up.error.message });
    try { await supabase.from('admin_audit').insert({ accion: 'restaurar_cliente', target_user_id: uid, detalle: '{}' }); } catch(eA){}
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// BORRADO DEFINITIVO: exige codigo 'eliminar' valido -> exporta backup recuperable -> borra TODO en cascada + el auth user.
app.post('/api/maestro/cliente/borrar-definitivo', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var uid = (req.body && req.body.user_id) ? String(req.body.user_id) : '';
    var codigo = (req.body && req.body.codigo) ? String(req.body.codigo) : '';
    if (!uid) return res.status(400).json({ error: 'Falta user_id' });
    if (!(await _verificar2fa('eliminar', codigo))) return res.status(403).json({ ok: false, error: 'codigo' });
    // 1) EXPORTAR backup recuperable (snapshot completo del tenant) ANTES de borrar nada.
    var contenido = {};
    var tablasUser = ['business_settings','subscriptions','conversations','messages','contacts','properties','knowledge_base','recontactos','whatsapp_instancias','scraping_config','scraping_pendientes','reportes_snapshots','ia_uso','admin_notas','support_messages','device_tokens'];
    for (var ti = 0; ti < tablasUser.length; ti++) {
      var t = tablasUser[ti];
      try { var d = await supabase.from(t).select('*').eq('user_id', uid); contenido[t] = (d && d.data) ? d.data : []; } catch(eT){ contenido[t] = []; }
    }
    try { var dAse = await supabase.from('asesores').select('*').eq('admin_id', uid); contenido.asesores = (dAse && dAse.data) ? dAse.data : []; } catch(eAse){ contenido.asesores = []; }
    var resumen = 'BORRADO DEFINITIVO conv:' + (contenido.conversations || []).length + ' msg:' + (contenido.messages || []).length + ' cont:' + (contenido.contacts || []).length + ' prop:' + (contenido.properties || []).length;
    var backupGuardado = false;
    try { var bkr = await supabase.from('backups').insert({ user_id: uid, contenido: contenido, resumen: resumen }); backupGuardado = !(bkr && bkr.error); } catch(eBk){ backupGuardado = false; }
    if (!backupGuardado) return res.status(503).json({ ok: false, error: 'No se pudo guardar el backup recuperable; se aborta el borrado por seguridad' });
    // 2) Borrar en cascada (best-effort; el backup ya esta a salvo).
    for (var di = 0; di < tablasUser.length; di++) { try { await supabase.from(tablasUser[di]).delete().eq('user_id', uid); } catch(eD){} }
    try { await supabase.from('asesores').delete().eq('admin_id', uid); } catch(eDA){}
    // 3) Borrar el usuario de Auth (ultimo paso).
    try { await supabase.auth.admin.deleteUser(uid); } catch(eAu){ console.error('deleteUser borrar-definitivo:', eAu && eAu.message); }
    try { await supabase.from('admin_audit').insert({ accion: 'borrar_definitivo', target_user_id: uid, detalle: JSON.stringify({ resumen: resumen }) }); } catch(eA){}
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Setup inicial (una vez): requiere el bootstrap (env MAESTRO_BOOTSTRAP). Devuelve el secreto TOTP para cargar en la app autenticadora.
app.post('/api/maestro/setup', async function(req, res){
  try{
    if (!MAESTRO_ENABLED) return res.status(404).json({ error: 'no disponible' });
    var boot = (req.body && req.body.bootstrap) ? String(req.body.bootstrap) : '';
    if (!MAESTRO_BOOTSTRAP || boot !== MAESTRO_BOOTSTRAP) return res.status(403).json({ error: 'bootstrap invalido' });
    var yaConfig = await supabase.from('superadmin_config').select('id').eq('id', 1).maybeSingle();
    if (yaConfig && yaConfig.data) return res.status(409).json({ error: 'El panel ya esta configurado. Para reconfigurarlo hay que borrar la fila de superadmin_config en Supabase (a proposito, por seguridad).' });
    var pass = (req.body && req.body.password) ? String(req.body.password) : '';
    if (pass.length < 8) return res.status(400).json({ error: 'La contrasena debe tener al menos 8 caracteres' });
    var salt = _cripto.randomBytes(16).toString('hex');
    var totp = _totpNuevo();
    var up = await supabase.from('superadmin_config').upsert({ id: 1, password_hash: _hashPass(pass, salt), password_salt: salt, totp_secret: totp }, { onConflict: 'id' });
    if (up.error) return res.status(503).json({ error: 'Falta la tabla superadmin_config: ' + up.error.message });
    return res.json({ ok: true, totp_secret: totp, otpauth: 'otpauth://totp/RaicesCRM-Maestro?secret=' + totp + '&issuer=RaicesCRM' });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Login: contrasena + codigo TOTP -> token de sesion maestro (1h)
app.post('/api/maestro/login', async function(req, res){
  try{
    if (!MAESTRO_ENABLED) return res.status(404).json({ error: 'no disponible' });
    var pass = (req.body && req.body.password) ? String(req.body.password) : '';
    var code = (req.body && req.body.code) ? String(req.body.code) : '';
    var cfg = await supabase.from('superadmin_config').select('*').eq('id', 1).maybeSingle();
    if (!cfg.data) return res.status(403).json({ error: 'Panel no configurado' });
    if (_hashPass(pass, cfg.data.password_salt) !== cfg.data.password_hash) return res.status(403).json({ error: 'Credenciales invalidas' });
    if (!_totpOk(cfg.data.totp_secret, code)) return res.status(403).json({ error: 'Codigo invalido' });
    return res.json({ ok: true, token: _maestroToken() });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Lista de clientes + stats globales
app.get('/api/maestro/clientes', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    // Pedimos eliminado_at para distinguir ACTIVOS (null) de ELIMINADOS (papelera). Si la columna aun no existe,
    // el select falla -> reintentamos sin ella (degradar bien: todos quedan como activos, eliminado_at=null).
    var bs = await supabase.from('business_settings').select('user_id, company_name, rubro, crm_pausado, eliminado_at');
    if (bs && bs.error) { bs = await supabase.from('business_settings').select('user_id, company_name, rubro, crm_pausado'); }
    var subs = await supabase.from('subscriptions').select('user_id, plan, status, ai_messages_this_period, current_period_end, cortesia, limits_override');
    var byUser = {}; (subs.data || []).forEach(function(s){ byUser[s.user_id] = s; });
    var act = {}; try { var cv = await supabase.from('conversations').select('user_id, updated_at').order('updated_at', { ascending: false }).limit(3000); (cv.data || []).forEach(function(r){ if (!act[r.user_id]) act[r.user_id] = r.updated_at; }); } catch(eAct){}
    var clientes = (bs.data || []).map(function(b){ var s = byUser[b.user_id] || {}; var topeOv = (s.limits_override && typeof s.limits_override.ai_messages === 'number') ? s.limits_override.ai_messages : null; return { user_id: b.user_id, empresa: b.company_name || '(sin nombre)', rubro: b.rubro || '-', pausado: b.crm_pausado === true, eliminado: !!b.eliminado_at, eliminado_at: b.eliminado_at || null, cortesia: s.cortesia === true, plan: s.plan || null, estado: s.status || null, ai_mes: s.ai_messages_this_period || 0, tope: topeOv, vence: s.current_period_end || null, ultima_actividad: act[b.user_id] || null }; });
    try { var est = await Promise.all(clientes.map(function(c){ return Promise.race([ instanciaConectada(nombreInstancia(c.user_id)).catch(function(){ return null; }), new Promise(function(rz){ setTimeout(function(){ rz(null); }, 4000); }) ]); })); clientes.forEach(function(c, i){ c.whatsapp = (est[i] === true) ? 'conectado' : (est[i] === false ? 'desconectado' : 'desconocido'); }); } catch(eW){ clientes.forEach(function(c){ c.whatsapp = 'desconocido'; }); }
    var ahora = Date.now();
    clientes.forEach(function(c){ var sal = 'ok'; if (c.pausado) sal = 'pausada'; else if (c.whatsapp === 'desconectado') sal = 'whatsapp'; else if (c.tope && c.ai_mes >= c.tope) sal = 'tope'; else if (c.ultima_actividad && (ahora - new Date(c.ultima_actividad).getTime()) > 7 * 24 * 3600 * 1000) sal = 'inactivo'; c.salud = sal; });
    var totalIA = clientes.reduce(function(a, c){ return a + (c.ai_mes || 0); }, 0);
    var activos = clientes.filter(function(c){ return !c.eliminado; });
    var eliminados = clientes.filter(function(c){ return c.eliminado; });
    return res.json({ ok: true, total_clientes: activos.length, total_eliminados: eliminados.length, total_ai_mes: totalIA, costo_estimado_usd: Math.round(totalIA * 0.01 * 100) / 100, clientes: activos, eliminados: eliminados });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Detalle de un cliente
app.get('/api/maestro/cliente/:id', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var uid = req.params.id;
    var bs = await supabase.from('business_settings').select('*').eq('user_id', uid).maybeSingle();
    var B = bs.data || {};
    var convs = await supabase.from('conversations').select('status, updated_at').eq('user_id', uid).order('updated_at', { ascending: false });
    var stats = { conversaciones: 0, interesado: 0, listo_humano: 0, cerrado: 0, recontacto: 0 };
    (convs.data || []).forEach(function(c){ stats.conversaciones++; if (stats[c.status] !== undefined) stats[c.status]++; });
    var ultimaActividad = (convs.data && convs.data[0]) ? convs.data[0].updated_at : null;
    var cont = await supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('user_id', uid);
    var msgs = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('role', 'ai');
    var props = await supabase.from('properties').select('id', { count: 'exact', head: true }).eq('user_id', uid);
    var kb = await supabase.from('knowledge_base').select('question', { count: 'exact', head: true }).eq('user_id', uid);
    var ases = await supabase.from('asesores').select('activo').eq('admin_id', uid);
    var asesoresTotal = (ases.data || []).length;
    var asesoresActivos = (ases.data || []).filter(function(a){ return a.activo === true; }).length;
    var sub = await supabase.from('subscriptions').select('*').eq('user_id', uid).maybeSingle();
    var S = sub.data || null;
    var ultimoLogin = null; var altaFecha = null; try { var u = await supabase.auth.admin.getUserById(uid); if (u && u.data && u.data.user) { ultimoLogin = u.data.user.last_sign_in_at; altaFecha = u.data.user.created_at; } } catch(eL){}
    var ultimoBackup = null; var backupsCount = 0; try { var bk = await supabase.from('backups').select('created_at', { count: 'exact' }).eq('user_id', uid).order('created_at', { ascending: false }).limit(1); ultimoBackup = (bk.data && bk.data[0]) ? bk.data[0].created_at : null; backupsCount = bk.count || 0; } catch(eB){}
    var nota = ''; try { var nt = await supabase.from('admin_notas').select('nota').eq('user_id', uid).maybeSingle(); nota = (nt && nt.data && nt.data.nota) ? nt.data.nota : ''; } catch(eN){}
    var wa = 'desconocido'; try { wa = (await instanciaConectada(nombreInstancia(uid))) ? 'conectado' : 'desconectado'; } catch(eWa){}
    var planCli = (S && S.cortesia === true) ? 'premium' : ((S && PLAN_LIMITS[S.plan]) ? S.plan : 'premium');
    var ov = (S && S.limits_override) || {};
    function lef(k){ return (typeof ov[k] !== 'undefined' && ov[k] !== null) ? ov[k] : (PLAN_LIMITS[planCli] ? PLAN_LIMITS[planCli][k] : null); }
    var limites = { ai_messages: lef('ai_messages'), asesores: lef('asesores'), contactos: lef('contactos'), propiedades: (typeof ov.propiedades !== 'undefined' && ov.propiedades !== null) ? ov.propiedades : null };
    var config = { agente: B.agent_name || 'Asistente', cargo: B.agent_cargo || '', tono: B.agent_tone || 'cercano', autonomia: B.autonomy || 'equilibrado', objetivo: B.agent_objetivo || 'informar', largo: B.response_length || 'corto', emojis: B.use_emojis === true, idioma: B.idioma || 'es', instrucciones: B.instructions || '' };
    var nConv = stats.conversaciones || 0;
    var derivacion = nConv ? Math.round(stats.listo_humano / nConv * 100) : 0;
    var conversion = nConv ? Math.round(stats.cerrado / nConv * 100) : 0;
    return res.json({ ok: true, empresa: B.company_name || null, rubro: B.rubro || null, pausado: B.crm_pausado === true, cortesia: !!(S && S.cortesia === true), stats: stats, contactos: (cont.count || 0), ai_mensajes: (msgs.count || 0), propiedades: (props.count || 0), conocimiento: (kb.count || 0), asesores_total: asesoresTotal, asesores_activos: asesoresActivos, ultimo_login: ultimoLogin, ultima_actividad: ultimaActividad, whatsapp: wa, derivacion_pct: derivacion, conversion_pct: conversion, limites: limites, override: ov, config: config, alta: altaFecha, ultimo_backup: ultimoBackup, backups_count: backupsCount, nota: nota, suscripcion: S });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Accion sobre un cliente: pausar/reactivar IA o cambiar limite particular
app.post('/api/maestro/cliente/:id/accion', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var uid = req.params.id;
    var accion = (req.body && req.body.accion) ? String(req.body.accion) : '';
    if (accion === 'pausar' || accion === 'reactivar') {
      await supabase.from('business_settings').update({ crm_pausado: (accion === 'pausar') }).eq('user_id', uid);
    } else if (accion === 'limite') {
      var lim = parseInt(req.body && req.body.ai_messages, 10);
      if (!isNaN(lim)) await supabase.from('subscriptions').upsert({ user_id: uid, ai_messages_limit_override: lim }, { onConflict: 'user_id' });
    } else if (accion === 'limites') {
      var ov = {};
      ['ai_messages', 'asesores', 'contactos', 'propiedades'].forEach(function(k){ var v = req.body && req.body[k]; if (v === '' || v === null || typeof v === 'undefined') return; var n = parseInt(v, 10); if (!isNaN(n)) ov[k] = n; });
      await supabase.from('subscriptions').upsert({ user_id: uid, limits_override: ov }, { onConflict: 'user_id' });
    } else if (accion === 'cortesia') {
      await supabase.from('subscriptions').upsert({ user_id: uid, cortesia: (req.body && req.body.activo === true) }, { onConflict: 'user_id' });
    } else { return res.status(400).json({ error: 'Accion invalida' }); }
    try { await supabase.from('admin_audit').insert({ accion: accion, target_user_id: uid, detalle: JSON.stringify(req.body || {}) }); } catch(eA){}
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Alta de un cliente nuevo desde el Panel Maestro (incluye modo cortesia: exento, sin tarjeta).
// NO crea instancia de Evolution ni toca whatsapp_instancias (eso es lazy). Endpoint admin aislado.
app.post('/api/maestro/cliente/crear', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var b = req.body || {};
    var email = (b.email ? String(b.email) : '').trim().toLowerCase();
    var company = (b.company ? String(b.company) : '').trim();
    var rubro = (b.rubro ? String(b.rubro) : '').trim() || 'inmobiliaria';
    var nombre = (b.nombre ? String(b.nombre) : '').trim();
    var whatsapp = (b.whatsapp ? String(b.whatsapp) : '').trim();
    var cortesia = (b.cortesia === true);
    if (!email || !company) return res.status(400).json({ error: 'Faltan datos: email y company son obligatorios' });
    // Password: usa la provista o genera una fuerte con crypto
    var password = (b.password ? String(b.password) : '').trim();
    if (!password) password = _cripto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 14) + 'A9!';
    // 1) Crear el usuario en Auth
    var created, errAuth;
    try {
      var r = await supabase.auth.admin.createUser({ email: email, password: password, email_confirm: true, user_metadata: { name: nombre, company: company, rubro: rubro } });
      created = r.data; errAuth = r.error;
    } catch(eC){ errAuth = eC; }
    if (errAuth) {
      var msg = String((errAuth && errAuth.message) || errAuth || '');
      if (/already|registered|exists|duplicate/i.test(msg)) return res.status(400).json({ error: 'Ese email ya esta registrado' });
      return res.status(400).json({ error: msg || 'No se pudo crear el usuario' });
    }
    var uid = (created && created.user) ? created.user.id : null;
    if (!uid) return res.status(400).json({ error: 'No se pudo crear el usuario (sin id)' });
    // 2) business_settings (rollback del auth user si falla)
    var ins = await supabase.from('business_settings').insert({ user_id: uid, company_name: company, rubro: rubro, whatsapp_contacto: whatsapp });
    if (ins.error) {
      try { await supabase.auth.admin.deleteUser(uid); } catch(eD){}
      return res.status(400).json({ error: ins.error.message });
    }
    // 3) Cortesia (exento, sin tarjeta)
    if (cortesia === true) {
      try { await supabase.from('subscriptions').upsert({ user_id: uid, cortesia: true }, { onConflict: 'user_id' }); } catch(eS){}
    }
    // 4) Auditoria (no critico)
    try { await supabase.from('admin_audit').insert({ accion: 'crear_cliente', target_user_id: uid, detalle: JSON.stringify({ email: email, company: company, cortesia: cortesia }) }); } catch(eA){}
    // 5) Notif Maestro (best-effort, nunca rompe el alta)
    crearNotifMaestro('nuevo_cliente', 'Nuevo cliente: ' + company, 'Alta desde el Maestro. Email: ' + email + (cortesia ? ' (cortesia)' : ''), { ref_user_id: uid, severidad: 'info' }).catch(function(){});
    return res.json({ ok: true, user_id: uid, email: email, password: password });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Bandeja de soporte (mensajes de los clientes)
app.get('/api/maestro/soporte', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var m = await supabase.from('support_messages').select('*').order('created_at', { ascending: false }).limit(200);
    return res.json({ ok: true, mensajes: m.data || [] });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});
app.post('/api/maestro/soporte/:id/responder', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var resp = (req.body && req.body.respuesta) ? String(req.body.respuesta) : '';
    // Leer la fila primero (para tener user_id/telefono disponibles); no rompe el flujo si falla.
    var fila = null; try { var fr = await supabase.from('support_messages').select('*').eq('id', req.params.id).maybeSingle(); fila = fr && fr.data ? fr.data : null; } catch (eF) {}
    await supabase.from('support_messages').update({ respuesta: resp, estado: 'resuelto' }).eq('id', req.params.id);
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Impersonar: genera un acceso de un solo uso al dashboard del cliente (sin su clave)
app.post('/api/maestro/cliente/:id/impersonar', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var uid = req.params.id;
    var u = await supabase.auth.admin.getUserById(uid);
    var email = u && u.data && u.data.user && u.data.user.email;
    if (!email) return res.status(404).json({ error: 'El cliente no tiene email asociado' });
    var link = await supabase.auth.admin.generateLink({ type: 'magiclink', email: email });
    if ((link && link.error) || !link || !link.data || !link.data.properties || !link.data.properties.hashed_token) {
      return res.status(500).json({ error: (link && link.error && link.error.message) || 'No se pudo generar el acceso' });
    }
    try { await supabase.from('admin_audit').insert({ accion: 'impersonar', target_user_id: uid, detalle: email }); } catch(eA){}
    return res.json({ ok: true, token_hash: link.data.properties.hashed_token, email: email });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Guardar nota interna del dev sobre un cliente
app.post('/api/maestro/cliente/:id/nota', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var nota = (req.body && typeof req.body.nota === 'string') ? req.body.nota : '';
    await supabase.from('admin_notas').upsert({ user_id: req.params.id, nota: nota, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Ver conversaciones recientes del cliente (solo lectura)
app.get('/api/maestro/cliente/:id/conversaciones', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var uid = req.params.id;
    var cv = await supabase.from('conversations').select('id, contact_id, status, last_message, last_role, updated_at').eq('user_id', uid).order('updated_at', { ascending: false }).limit(20);
    var convs = cv.data || [];
    var ids = convs.map(function(c){ return c.contact_id; }).filter(Boolean);
    var nombres = {};
    if (ids.length) { try { var ct = await supabase.from('contacts').select('id, name').in('id', ids); (ct.data || []).forEach(function(x){ nombres[x.id] = x.name; }); } catch(eC){} }
    var out = convs.map(function(c){ return { id: c.id, contacto: nombres[c.contact_id] || 'Contacto', status: c.status, ultimo: c.last_message || '', rol: c.last_role || '', fecha: c.updated_at }; });
    return res.json({ ok: true, conversaciones: out });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Consumo de IA en USD por periodo (rolling): hoy=24h, 7d, 30d, 365d. Global + por cliente + saldo estimado.
app.get('/api/maestro/consumo', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var TOPE_ALERTA_USD = 15;
    var periodo = String((req.query && req.query.periodo) || '30d');
    // 'mes' = ultimos 30 dias (igual que 30d, por simplicidad).
    var dias = periodo === 'hoy' ? 1 : (periodo === '7d' ? 7 : (periodo === '365d' ? 365 : 30));
    // RANGO CUSTOM: si vienen AMBOS query params 'desde' y 'hasta' (ISO date), se filtra por ese rango en vez del periodo.
    var qDesde = req.query && req.query.desde ? String(req.query.desde) : null;
    var qHasta = req.query && req.query.hasta ? String(req.query.hasta) : null;
    var rangoCustom = !!(qDesde && qHasta);
    var desde = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
    var q = supabase.from('ia_uso').select('user_id, cost_usd, input_tokens, output_tokens');
    if (rangoCustom) { q = q.gte('created_at', qDesde).lte('created_at', (qHasta.indexOf('T') >= 0 ? qHasta : qHasta + 'T23:59:59.999Z')); }
    else { q = q.gte('created_at', desde); }
    var u = await q.limit(100000);
    var rows = u.data || [];
    // SALVAGUARDA anti-dato-corrupto: una sola llamada a Claude no puede costar mas de ~$3-4 (1M tokens Sonnet = $3).
    // Si una fila tiene un costo absurdo (> $10) es un dato corrupto (ej. un costo viejo logueado sin dividir por
    // 1.000.000) -> NO se suma, para que el panel no se dispare. Se reportan aparte (filas_anomalas_ignoradas).
    var MAX_COSTO_FILA = 10;
    var totalCost = 0, totalIn = 0, totalOut = 0; var porCliente = {}; var corruptas = 0; var costoCorrupto = 0;
    rows.forEach(function(r){ var c = Number(r.cost_usd) || 0; if (c > MAX_COSTO_FILA) { corruptas++; costoCorrupto += c; return; } totalCost += c; totalIn += r.input_tokens || 0; totalOut += r.output_tokens || 0; var pc = porCliente[r.user_id] || { cost: 0, input_tokens: 0, output_tokens: 0, msgs: 0 }; pc.cost += c; pc.input_tokens += r.input_tokens || 0; pc.output_tokens += r.output_tokens || 0; pc.msgs++; porCliente[r.user_id] = pc; });
    var nombres = {};
    var keys = Object.keys(porCliente);
    if (keys.length) { try { var bs = await supabase.from('business_settings').select('user_id, company_name').in('user_id', keys); (bs.data || []).forEach(function(b){ nombres[b.user_id] = b.company_name; }); } catch(eN){} }
    var ranking = keys.map(function(k){ return { user_id: k, empresa: nombres[k] || '(sin nombre)', cost: Math.round(porCliente[k].cost * 1000000) / 1000000, input_tokens: porCliente[k].input_tokens, output_tokens: porCliente[k].output_tokens, msgs: porCliente[k].msgs }; }).sort(function(a, b){ return b.cost - a.cost; });
    // ALERTA DE ANOMALIA por cliente: costo > 3x la MEDIANA de los costos>0 (con piso absoluto $1), o supera el tope absoluto.
    var costosPos = ranking.map(function(it){ return it.cost; }).filter(function(c){ return c > 0; }).sort(function(a, b){ return a - b; });
    var mediana = 0;
    if (costosPos.length) { var mid = Math.floor(costosPos.length / 2); mediana = costosPos.length % 2 ? costosPos[mid] : (costosPos[mid - 1] + costosPos[mid]) / 2; }
    ranking.forEach(function(it){
      it.alerta = false; it.motivo = '';
      if (it.cost > TOPE_ALERTA_USD) { it.alerta = true; it.motivo = 'supera $' + TOPE_ALERTA_USD; }
      else if (mediana > 0 && it.cost > 1 && it.cost > 3 * mediana) { it.alerta = true; it.motivo = 'gasta ' + (Math.round((it.cost / mediana) * 10) / 10) + 'x la mediana'; }
    });
    var alertas = ranking.filter(function(it){ return it.alerta; }).map(function(it){ return { user_id: it.user_id, empresa: it.empresa, cost: it.cost, motivo: it.motivo }; });
    // saldo estimado
    var cfg = await supabase.from('superadmin_config').select('saldo_cargado, saldo_fecha').eq('id', 1).maybeSingle();
    var saldoCargado = (cfg.data && cfg.data.saldo_cargado != null) ? Number(cfg.data.saldo_cargado) : null;
    var saldoRestante = null;
    if (saldoCargado != null && cfg.data.saldo_fecha) {
      var ud = await supabase.from('ia_uso').select('cost_usd').gte('created_at', cfg.data.saldo_fecha).limit(100000);
      var gastado = (ud.data || []).reduce(function(a, r){ var c = Number(r.cost_usd) || 0; return (c > MAX_COSTO_FILA || c < 0) ? a : a + c; }, 0); // misma salvaguarda anti-dato-corrupto que el total
      saldoRestante = Math.round((saldoCargado - gastado) * 100) / 100;
    }
    return res.json({ ok: true, periodo: periodo, desde: rangoCustom ? qDesde : null, hasta: rangoCustom ? qHasta : null, rango_custom: rangoCustom, costo_usd: Math.round(totalCost * 100) / 100, input_tokens: totalIn, output_tokens: totalOut, mensajes: rows.length, mensajes_validos: rows.length - corruptas, filas_anomalas_ignoradas: corruptas, costo_anomalo_ignorado: Math.round(costoCorrupto * 100) / 100, ranking: ranking.slice(0, 50), alertas: alertas, saldo_cargado: saldoCargado, saldo_restante: saldoRestante, saldo_fecha: (cfg.data && cfg.data.saldo_fecha) || null, pausa_global: _pausaGlobal === true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// ===== NOTIFICACIONES DEL MAESTRO (campana del panel). Service key, mismo gate que el resto de /api/maestro/* =====
// Listar notificaciones. Por defecto NO incluye eliminadas; ?incluir_eliminadas=1 para verlas tambien. Orden desc, limit 200.
app.get('/api/maestro/notificaciones', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var incluirElim = String((req.query && req.query.incluir_eliminadas) || '0') === '1';
    var q = supabase.from('maestro_notificaciones').select('id, tipo, titulo, cuerpo, ref_user_id, ref_id, severidad, created_at, leida_at, eliminada_at');
    if (!incluirElim) q = q.is('eliminada_at', null);
    var r = await q.order('created_at', { ascending: false }).limit(200);
    var notifs = (r && r.data) || [];
    var noLeidas = notifs.filter(function(n){ return !n.leida_at && !n.eliminada_at; }).length;
    return res.json({ ok: true, notificaciones: notifs, no_leidas: noLeidas });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Marcar UNA notificacion como leida.
app.post('/api/maestro/notificaciones/:id/leer', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    await supabase.from('maestro_notificaciones').update({ leida_at: new Date().toISOString() }).eq('id', req.params.id);
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Marcar TODAS las no leidas (y no eliminadas) como leidas.
app.post('/api/maestro/notificaciones/leer-todas', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    await supabase.from('maestro_notificaciones').update({ leida_at: new Date().toISOString() }).is('leida_at', null).is('eliminada_at', null);
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Eliminar (SOFT): marca eliminada_at. Queda en el historial (?incluir_eliminadas=1), no se borra fisico.
app.post('/api/maestro/notificaciones/:id/eliminar', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    await supabase.from('maestro_notificaciones').update({ eliminada_at: new Date().toISOString() }).eq('id', req.params.id);
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Registrar el token FCM del celular del Maestro (la app del dueno) para recibir las notificaciones por push.
app.post('/api/maestro/device-token', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var token = (req.body && req.body.token) ? String(req.body.token).slice(0, 4000) : '';
    var plataforma = (req.body && req.body.plataforma) ? String(req.body.plataforma).slice(0, 40) : 'android';
    if (!token) return res.status(400).json({ error: 'Falta token' });
    await supabase.from('maestro_device_tokens').upsert({ token: token, plataforma: plataforma, ultimo_uso: new Date().toISOString() }, { onConflict: 'token' });
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Cargar saldo manual de Anthropic (la API no expone el saldo; el dueno lo ingresa al recargar)
app.post('/api/maestro/saldo', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var monto = parseFloat(req.body && req.body.monto);
    if (isNaN(monto)) return res.status(400).json({ error: 'Monto invalido' });
    await supabase.from('superadmin_config').update({ saldo_cargado: monto, saldo_fecha: new Date().toISOString() }).eq('id', 1);
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// KILL-SWITCH GLOBAL (#15): pausar/reactivar TODO el sistema de una. { activar: bool }.
// Persiste en superadmin_config.pausa_global + actualiza el cache en memoria (_pausaGlobal) al instante (sin esperar
// el refresh de 30s) + deja una notif 'sistema' critica en el Maestro. Cuando esta activo, el GATE TEMPRANO frena el
// gasto de IA de TODOS los clientes (cero tokens, el mensaje crudo igual se guarda). ADITIVO: no toca otra logica.
app.post('/api/maestro/pausa-global', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var activar = !!(req.body && req.body.activar === true);
    var up = await supabase.from('superadmin_config').update({ pausa_global: activar }).eq('id', 1);
    if (up && up.error) return res.status(503).json({ error: 'No se pudo guardar la pausa global (revisa la columna pausa_global en superadmin_config): ' + up.error.message });
    _pausaGlobal = activar; // efecto inmediato, sin esperar el refresh de 30s
    // Notif critica al Maestro (best-effort, no bloquea la respuesta)
    if (activar) crearNotifMaestro('sistema', 'Sistema PAUSADO globalmente', 'Se activo el kill-switch global: la IA dejo de responder para TODOS los clientes (cero gasto de tokens). Reactivalo cuando quieras volver a la normalidad.', { severidad: 'critico' }).catch(function(){});
    else crearNotifMaestro('sistema', 'Sistema REACTIVADO globalmente', 'Se desactivo el kill-switch global: la IA vuelve a responder normalmente para todos los clientes (salvo los que tengan pausa individual).', { severidad: 'critico' }).catch(function(){});
    return res.json({ ok: true, pausa_global: _pausaGlobal });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Estado actual del kill-switch global (para que el front lo muestre sin depender del consumo). Lee el cache en memoria.
app.get('/api/maestro/pausa-global', async function(req, res){
  try{
    if (!MAESTRO_ENABLED || !maestroAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    return res.json({ ok: true, pausa_global: _pausaGlobal === true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Cancelar la suscripcion del cliente: revoca el preapproval en MercadoPago + marca cancelled localmente
app.post('/api/suscripcion/cancelar', async function(req, res){
  try{
    var user_id = await verificarUsuario(req);
    if (!user_id) return res.status(401).json({ error: 'No autorizado' });
    var sub = await getSubscription(user_id);
    if (!sub) return res.status(400).json({ error: 'No tenes una suscripcion para cancelar' });
    if (MP_TOKEN && sub.mp_preapproval_id) { try { await mpFetch('/preapproval/' + sub.mp_preapproval_id, 'PUT', { status: 'cancelled' }); } catch(eM){ console.error('cancelar MP:', eM && eM.message); } }
    await supabase.from('subscriptions').update({ status: 'cancelled' }).eq('user_id', user_id);
    return res.json({ ok: true });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// Genera un resumen breve de la conversacion con IA (para que el asesor se ponga al dia sin leer todo el chat)
async function generarResumenConversacion(conversation_id, user_id) {
  try {
    const r = await supabase.from('messages').select('role, content, content_original').eq('conversation_id', conversation_id).order('created_at', { ascending: true });
    const msgs = r.data || [];
    if (msgs.length === 0) return null;
    const transcripcion = msgs.map(function(m){ const quien = m.role === 'contact' ? 'Cliente' : (m.role === 'ai' ? 'Asistente' : 'Asesor'); return quien + ': ' + (m.content_original || m.content || ''); }).join('\n').slice(0, 12000);
    const comp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: 'Sos un asistente de un CRM inmobiliario. Resumi esta conversacion entre un cliente y el negocio para que un asesor humano se ponga al dia en 10 segundos. Devolve un resumen breve (4 a 6 lineas) que incluya: que busca el cliente (tipo de propiedad, zona, presupuesto si lo menciono), su nivel de interes, que se le respondio, y cual es el proximo paso pendiente. Escribi en espanol rioplatense, directo, sin saludos ni titulos, solo el resumen.',
      messages: [ { role: 'user', content: 'Conversacion:\n' + transcripcion } ]
    });
    try { if (typeof registrarUsoTokens === 'function' && comp && comp.usage) await registrarUsoTokens(user_id, comp.usage); } catch(eU){}
    const out = (comp && comp.content && comp.content[0] && comp.content[0].text) ? comp.content[0].text.trim() : '';
    return out || null;
  } catch (e) { console.error('Error generando resumen:', e && e.message); return null; }
}

// Generar/actualizar el resumen IA de una conversacion (read-only para el asesor)
app.post('/api/conversations/resumen', async function(req, res){
  try{
    var uid = await verificarUsuario(req);
    if (!uid) return res.status(401).json({ error: 'No autorizado' });
    var conversation_id = req.body && req.body.conversation_id;
    if (!conversation_id) return res.status(400).json({ error: 'Falta conversation_id' });
    var c = await supabase.from('conversations').select('user_id').eq('id', conversation_id).maybeSingle();
    if (!c.data) return res.status(404).json({ error: 'Conversacion no encontrada' });
    // Permitir al DUEÑO o a un ASESOR de la misma cuenta (asesor.admin_id === dueño de la conversacion).
    if (c.data.user_id !== uid) {
      var aRes = await supabase.from('asesores').select('admin_id').eq('auth_user_id', uid).maybeSingle();
      if (!aRes.data || aRes.data.admin_id !== c.data.user_id) return res.status(403).json({ error: 'No autorizado' });
    }
    // El consumo de tokens se atribuye al DUEÑO de la cuenta, no al asesor.
    var resumen = await generarResumenConversacion(conversation_id, c.data.user_id);
    if (!resumen) return res.status(422).json({ error: 'No se pudo generar el resumen (sin mensajes o error de IA)' });
    await supabase.from('conversations').update({ summary: resumen, updated_at: new Date().toISOString() }).eq('id', conversation_id);
    return res.json({ ok: true, summary: resumen });
  }catch(e){ return res.status(500).json({ error: e && e.message }); }
});

// CHEQUEO DIARIO de CONSUMO ANOMALO de IA por cliente (best-effort, jamas rompe). Reusa la MISMA logica
// de anomalia del endpoint /api/maestro/consumo (costo > 3x la mediana con piso $1, o supera el tope $15)
// sobre las ULTIMAS 24h. Por cada cliente anomalo nuevo crea una notif 'consumo_anomalo' (warning), con
// DEDUPE: no se crea si ya existe una notif consumo_anomalo de ese ref_user_id en las ultimas 24h.
// Se ejecuta como mucho 1 vez por dia (el cron corre c/6h; este flag evita repetir en cada corrida).
var _ultimaRevisionAnomalia = 0;
async function revisarConsumoAnomalo() {
  try {
    var ahora = Date.now();
    if (ahora - _ultimaRevisionAnomalia < 24 * 3600 * 1000) return; // a lo sumo 1 vez al dia
    var TOPE_ALERTA_USD = 15;            // mismo tope que /api/maestro/consumo
    var MAX_COSTO_FILA = 10;             // misma salvaguarda anti-dato-corrupto
    var desde = new Date(ahora - 24 * 3600 * 1000).toISOString();
    var u = await supabase.from('ia_uso').select('user_id, cost_usd').gte('created_at', desde).limit(100000);
    var rows = (u && u.data) || [];
    var porCliente = {};
    rows.forEach(function(r){ var c = Number(r.cost_usd) || 0; if (c > MAX_COSTO_FILA) return; if (!r.user_id) return; porCliente[r.user_id] = (porCliente[r.user_id] || 0) + c; });
    var ranking = Object.keys(porCliente).map(function(k){ return { user_id: k, cost: porCliente[k] }; });
    if (!ranking.length) { _ultimaRevisionAnomalia = ahora; return; }
    // Mediana de los costos > 0 (misma definicion que el endpoint)
    var costosPos = ranking.map(function(it){ return it.cost; }).filter(function(c){ return c > 0; }).sort(function(a, b){ return a - b; });
    var mediana = 0;
    if (costosPos.length) { var mid = Math.floor(costosPos.length / 2); mediana = costosPos.length % 2 ? costosPos[mid] : (costosPos[mid - 1] + costosPos[mid]) / 2; }
    // Detectar anomalos con el MISMO criterio del endpoint
    var anomalos = ranking.filter(function(it){
      if (it.cost > TOPE_ALERTA_USD) { it.motivo = 'supera $' + TOPE_ALERTA_USD + ' en 24h'; return true; }
      if (mediana > 0 && it.cost > 1 && it.cost > 3 * mediana) { it.motivo = 'gasta ' + (Math.round((it.cost / mediana) * 10) / 10) + 'x la mediana en 24h'; return true; }
      return false;
    });
    if (!anomalos.length) { _ultimaRevisionAnomalia = ahora; return; }
    // Nombres de empresa para el cuerpo de la notif (no critico)
    var nombres = {};
    try { var bs = await supabase.from('business_settings').select('user_id, company_name').in('user_id', anomalos.map(function(a){ return a.user_id; })); (bs.data || []).forEach(function(b){ nombres[b.user_id] = b.company_name; }); } catch (eN) {}
    for (var i = 0; i < anomalos.length; i++) {
      var it = anomalos[i];
      // DEDUPE: saltear si ya hay una notif consumo_anomalo de este cliente en las ultimas 24h
      try {
        var ya = await supabase.from('maestro_notificaciones').select('id').eq('tipo', 'consumo_anomalo').eq('ref_user_id', it.user_id).gte('created_at', desde).limit(1);
        if (ya && ya.data && ya.data.length) continue;
      } catch (eDup) { /* si la consulta falla, igual creamos la notif (mejor avisar que silenciar) */ }
      var empresa = nombres[it.user_id] || '(sin nombre)';
      crearNotifMaestro('consumo_anomalo', 'Consumo anomalo de IA: ' + empresa, 'El cliente ' + empresa + ' ' + it.motivo + ' (gasto ~$' + (Math.round(it.cost * 100) / 100) + ' en las ultimas 24h).', { ref_user_id: it.user_id, severidad: 'warning' }).catch(function(){});
    }
    _ultimaRevisionAnomalia = ahora;
  } catch (e) { console.error('revisarConsumoAnomalo:', e && e.message); }
}

// CRON suscripciones: dunning (past_due con +1 dia de gracia -> suspended) + reset mensual del contador de mensajes IA. Inerte si SUBSCRIPTIONS_ENABLED=false.
async function revisarSuscripciones() {
  try {
    if (!SUBSCRIPTIONS_ENABLED) return;
    var ahora = Date.now();
    var subs = await supabase.from('subscriptions').select('*');
    for (var k = 0; k < (subs.data || []).length; k++) {
      var s = subs.data[k];
      var updates = {};
      if (s.status === 'past_due' && s.current_period_end && (ahora - new Date(s.current_period_end).getTime()) > 1 * 24 * 3600 * 1000) updates.status = 'suspended';
      var ini = s.period_start ? new Date(s.period_start).getTime() : null;
      if (!ini) updates.period_start = new Date(ahora).toISOString();
      else if (ahora - ini > 30 * 24 * 3600 * 1000) { updates.ai_messages_this_period = 0; updates.period_start = new Date(ahora).toISOString(); }
      if (Object.keys(updates).length) { try { await supabase.from('subscriptions').update(updates).eq('user_id', s.user_id); } catch (eU) {} }
    }
  } catch (e) { console.error('revisarSuscripciones:', e && e.message); }
  // Chequeo diario de consumo anomalo (aislado: nunca afecta al dunning de arriba)
  try { await revisarConsumoAnomalo(); } catch (eA) {}
}
setInterval(revisarSuscripciones, 6 * 60 * 60 * 1000);
setTimeout(revisarSuscripciones, 120 * 1000);

// MONITOREO (#19): chequea que Supabase y el servidor de WhatsApp (Evolution) respondan. Si algo se cae,
// crea una notificacion 'sistema' (critico) en el Maestro -> llega al panel y (con FCM) al celular. Best-effort.
var _saludDedup = {}; // dedupe en memoria: ultimo aviso por componente (ms). Evita spamear el mismo problema.
async function _notifSistema(comp, titulo, cuerpo) {
  try {
    var ahora = Date.now();
    if (_saludDedup[comp] && (ahora - _saludDedup[comp]) < 60 * 60 * 1000) return; // 1 aviso/hora por componente
    _saludDedup[comp] = ahora;
    await crearNotifMaestro('sistema', titulo, cuerpo, { ref_id: comp, severidad: 'critico' });
  } catch (e) {}
}
async function revisarSaludSistema() {
  // Supabase (base de datos)
  try {
    var sb = await supabase.from('business_settings').select('user_id').limit(1);
    if (sb && sb.error) await _notifSistema('supabase', 'Supabase con problemas', 'La base de datos respondio con error: ' + String(sb.error.message || '').slice(0, 180) + '. Revisa el estado de Supabase.');
  } catch (eSb) { await _notifSistema('supabase', 'Supabase no responde', 'No se pudo consultar la base de datos. Revisa el estado de Supabase (los datos y la IA dependen de esto).'); }
  // Evolution (servidor de WhatsApp)
  if (EVOLUTION_URL) {
    try {
      var ctrl = new AbortController();
      var to = setTimeout(function(){ try { ctrl.abort(); } catch (e) {} }, 8000);
      var r = await fetch(EVOLUTION_URL + '/instance/fetchInstances', { headers: { 'apikey': EVOLUTION_KEY }, signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) await _notifSistema('evolution', 'WhatsApp (Evolution) con problemas', 'El servidor de WhatsApp respondio ' + r.status + '. Si persiste, los agentes podrian dejar de recibir/responder mensajes.');
    } catch (eEv) { await _notifSistema('evolution', 'WhatsApp (Evolution) caido', 'El servidor de WhatsApp no responde. Los agentes NO van a recibir ni responder mensajes hasta que vuelva. Revisa el VPS/EasyPanel.'); }
  }
}
setInterval(revisarSaludSistema, 10 * 60 * 1000); // cada 10 min
setTimeout(revisarSaludSistema, 75 * 1000);       // primer chequeo a los 75s del arranque

app.listen(PORT, function(){ console.log('Raices CRM backend escuchando en puerto ' + PORT); });
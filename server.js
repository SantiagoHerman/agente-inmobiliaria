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
setInterval(() => { _rlHits.clear(); }, _RL_VENTANA_MS);
app.use((req, res, next) => {
  try {
    // el webhook de WhatsApp no se limita
    if (req.path === '/api/webhook/whatsapp') return next();
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
async function enviarPushAsesor(authUserId, leadNombre, texto) {
  try {
    if (!_fcmReady || !authUserId) return;
    const { data: toks } = await supabase.from('device_tokens').select('token').eq('user_id', authUserId);
    if (!toks || !toks.length) return;
    const tokens = toks.map(function (t) { return t.token; }).filter(Boolean);
    if (!tokens.length) return;
    const palabras = String(texto || '').trim().split(/\s+/).slice(0, 3).join(' ');
    const resp = await _fcmAdmin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: { title: leadNombre || 'Nuevo lead', body: 'Nuevo mensaje · ' + palabras },
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
async function elegirAsesorActivo(admin_id) {
  try {
    const { data: activos } = await supabase.from('asesores').select('id').eq('admin_id', admin_id).eq('activo', true);
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

// ===== MULTIMEDIA: baja un archivo de Evolution y lo sube a Supabase Storage =====
async function subirMediaAStorage(instancia, mensajeCrudo, tipoMedia) {
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
    return url ? { url: url, tipo: tipoMedia } : null;
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
  const { data: properties } = await supabase.from('properties').select('id, numero, title, type, zone, caracteristicas, price, rooms, capacity, amenities, link, operation, status, venta_activa, venta_estado, venta_precio, anual_activa, anual_estado, anual_precio, temporal_activa, temporal_precio_dia').eq('user_id', user_id).eq('activa', true);

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
    return '- ' + enc + (carac ? ' (' + carac + ')' : '') + ' | ' + (p.type||'') + ' | ambientes: ' + (p.rooms||'-') + ' | capacidad: ' + (p.capacity||'-') + ' | ' + (ops.length ? ops.join(' ; ') : 'sin operacion activa') + (p.amenities ? ' | amenities: ' + p.amenities : '') + (p.link ? ' | link: ' + p.link : '');
  }).join(String.fromCharCode(10));
  }

  let historial = [];
  if (modoPrueba && historialManual) {
    historial = historialManual.map(function(m){ return { role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }; });
  } else if (conversation_id) {
    const { data: prev } = await supabase.from('messages').select('role, content, content_original').eq('conversation_id', conversation_id).order('created_at', { ascending: true });
    if (prev && prev.length > 0) {
      historial = prev.map(function(m){ return { role: (m.role === 'contact' ? 'user' : 'assistant'), content: (m.content_original || m.content) }; });
    }
  }

    let instruccionesRubro = '';
  if (rubro === 'hotel_cabanas') {
    instruccionesRubro = 'RUBRO HOTEL, CABANAS O COMPLEJO. Hablas de alojamiento, no de venta de inmuebles. Vocabulario: noches, estadia, check-in y check-out, capacidad de personas, temporada alta o baja, tarifa por noche, servicios incluidos como pileta, parrilla, wifi, cochera y ropa de cama. Preguntas clave al huesped: fechas de entrada y salida, cuantas personas y cuantas noches. Al presentar opciones, deci capacidad, servicios y precio por noche. NUNCA hables de expensas, escrituras ni metros cuadrados.';
  } else if (rubro === 'desarrolladora') {
    instruccionesRubro = 'RUBRO DESARROLLADORA O EMPRENDIMIENTOS. Vendes unidades de emprendimientos, muchas veces en pozo o en construccion. Vocabulario: unidades, tipologias de 1, 2 o 3 ambientes, etapa de obra como pozo, en construccion o a estrenar, fecha estimada de entrega, financiacion, anticipo y cuotas, valor en pesos o dolares, ajuste por indice CAC. Preguntas clave: tipologia buscada, presupuesto o forma de pago, y si busca para vivienda o inversion. Resalta financiacion y avance de obra. Aclara que valores y entregas pueden estar sujetos a ajuste.';
  } else {
    instruccionesRubro = 'RUBRO INMOBILIARIA. Vocabulario: venta y alquiler, ambientes, dormitorios, metros cuadrados, expensas, zona o barrio, apto credito, escritura. Preguntas clave: si busca comprar o alquilar, zona, cantidad de ambientes y presupuesto. Al presentar, deci operacion, ambientes, zona y precio.';
  }

    const comportamientoSetter = [
    'QUIEN SOS: Sos una combinacion de tres roles en una sola persona. (1) SECRETARIA: ordenada, recordas datos del cliente, coordinas y no dejas cabos sueltos. (2) ATENCION AL PUBLICO: calida, paciente, clara, das una excelente primera impresion y resolves dudas con amabilidad. (3) SETTER: detectas que mueve al cliente, generas interes y avanzas la conversacion hacia el cierre. Combinas los tres roles de forma natural, no robotica.',
    'COMO TRABAJAS: No te limites a responder y esperar. Llevas la conversacion hacia adelante con calidez y naturalidad, paso a paso.',
    'REGITE SIEMPRE POR LA CONFIGURACION: respeta el tono indicado, el nivel de autonomia (cuanto podes afirmar vs cuando derivar), el objetivo (hasta donde atender antes de pasar a un humano), el largo de respuesta, las instrucciones internas, y usa la base de conocimiento como tu fuente de verdad. Si la configuracion y tu instinto comercial chocan, gana la configuracion.',
    'PRIMERO conecta: mostrate humano, calido y con interes genuino. Adapta el trato al lead segun como te escribe.',
    'DETECTA que motiva a este lead a avanzar: puede ser inversion, una mejor calidad de vida, disfrutar en pareja, vision a futuro, un proyecto para la familia, o seguridad. No lo interrogues ni preguntes el dolor de forma directa: descubrilo con preguntas naturales y escuchando lo que dice.',
    'CONECTA la oferta con eso que lo mueve: cuando presentes una opcion, relacionala con su motivacion (ejemplo: si busca invertir, resalta valor y proyeccion; si es para la familia, resalta espacio y comodidad). Siempre con datos reales.',
    'NUNCA inventes datos, precios, caracteristicas ni beneficios. Si no tenes la info, decis que la consultas. Persuadir es conectar lo real con lo que el lead necesita, no exagerar ni presionar.',
    'PROGRESA la charla: en cada respuesta haces avanzar un paso (entender mejor su necesidad, mostrar una opcion que encaje, o proponer el siguiente paso). Evita respuestas que cierren la conversacion.',
    'AVANZA hacia el cierre SOLO hasta el limite que define tu objetivo configurado (ver arriba). Cuando llegues a ese punto (agendar visita, avanzar una reserva o sena, o precalificar segun corresponda), encaminalo y deriva a un asesor humano. No te pases de ese limite.',
    'Sos empatico y persuasivo, nunca insistente ni manipulador. Si el lead no quiere avanzar, respetalo y dejas la puerta abierta.',
    'SI NO HAY CONVERSACION PREVIA con este contacto (no hablaron antes), tratalo como un primer contacto: presentate, genera confianza desde cero y NO asumas que ya venian hablando de algo. No digas cosas como lo que veniamos viendo si nunca hubo charla.'
  ].join(' ');

    const idiomaBase = (settings && settings.idioma) || 'es';
  const NOMBRE_IDIOMA = { es: 'espanol', en: 'ingles', pt: 'portugues', fr: 'frances', it: 'italiano', de: 'aleman', nl: 'holandes', ru: 'ruso', zh: 'chino mandarin', ja: 'japones', ko: 'coreano', ar: 'arabe', hi: 'hindi', tr: 'turco', pl: 'polaco' };
  const idiomaNombre = NOMBRE_IDIOMA[idiomaBase] || 'espanol';
  const instruccionIdioma = 'IDIOMA: Detecta automaticamente en que idioma te escribe el lead y respondele SIEMPRE en ese mismo idioma, de forma nativa y natural. Si el lead no escribio todavia (primer mensaje saliente) o no se puede determinar, usa ' + idiomaNombre + ' por defecto. Manten el mismo tono y comportamiento sin importar el idioma.';

  const systemPrompt = [
    'Sos ' + agentName + (agentCargo ? (', ' + agentCargo) : ', asesor/a') + ' de ' + company + ' (rubro: ' + rubro + ').',
        'IDENTIDAD: Sos una persona del equipo. NUNCA digas que sos una inteligencia artificial, un bot, un asistente virtual ni un programa. Si te preguntan que cargo ocupas, si sos una IA, o quien sos, responde con tu nombre (' + agentName + ')' + (agentCargo ? (" y tu cargo (" + agentCargo + ")") : '') + ' de forma natural, sin admitir que sos un sistema.',
        'APELLIDO: Si te preguntan tu apellido, aclara con amabilidad que no es un dato relevante, y ofrece pasarlo con un asesor del equipo si lo necesita en ese momento.',
    'LINKS DE PROPIEDADES: Cuando menciones o recomiendes una propiedad que en el inventario tenga un campo link, inclui ese link en tu respuesta para que el lead pueda ver mas informacion y fotos. Compartilo de forma natural, por ejemplo: Te paso el link para que veas las fotos y los detalles. Si la propiedad no tiene link en el inventario, no inventes ninguno ni menciones que falta.',
    instruccionesRubro,
    comportamientoSetter,
    instruccionIdioma,
    'Respondes consultas de clientes por WhatsApp.',
    'Si es el primer mensaje y todavia no sabes el nombre del cliente, presentate brevemente (deci tu nombre y la inmobiliaria) y preguntale su nombre de forma natural. Una vez que sepas el nombre, usalo para dirigirte a la persona segun el tono configurado (por nombre de pila si es informal; Sr./Sra. y apellido si es formal). No vuelvas a pedir el nombre si ya lo dio antes en la conversacion.',
    tono, autonomia, objetivo, largo,
    usaEmojis ? 'Podes usar algun emoji con moderacion.' : 'NO uses emojis.',
    instructions ? ('Instrucciones internas que SIEMPRE debes seguir: ' + instructions) : '',
    '', 'Base de conocimiento de la empresa:', kb, '',
    'Propiedades disponibles (usalas SOLO estas para recomendar; no inventes ni ofrezcas propiedades que no esten en esta lista). Si una propiedad tiene link, incluilo cuando la recomiendes asi el cliente ve las fotos. Distingui bien el tipo de operacion (venta, alquiler anual, alquiler temporal) y ofrece segun lo que pida el cliente:', inventario, '',
    'Hablas de forma humana y natural. No inventes datos que no esten en la base de conocimiento.'
  ].filter(Boolean).join('\n');

  const mensajesParaIA = historial.concat([{ role: 'user', content: message }]);

  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: systemPrompt,
    messages: mensajesParaIA
  });

  const block = completion.content[0];
  const reply = (block && block.type === 'text') ? block.text : 'No pude generar una respuesta.';

  if (conversation_id) {
    // Traducir la respuesta de la IA al idioma base del sistema para que el asesor la lea (traductor bidireccional)
    let contentOriginalAi = null;
    let idiomaAi = null;
    try {
      const traduccionAsesor = await traducir(reply, idiomaBase);
      if (traduccionAsesor && traduccionAsesor.trim() !== reply.trim()) {
        contentOriginalAi = traduccionAsesor; // version en el idioma base (lo que ve el asesor)
        idiomaAi = idiomaBase;
      }
    } catch (e) { /* si falla la traduccion, se guarda solo el original */ }
    if (!modoPrueba) {
    await supabase.from('messages').insert([
      { conversation_id: conversation_id, user_id: user_id, role: 'ai', content: reply, content_original: contentOriginalAi, idioma: idiomaAi, enviado_por: 'Agente IA' }
    ]);
    await supabase.from('conversations').update({ last_message: reply, last_role: 'ai', updated_at: new Date().toISOString() }).eq('id', conversation_id);
    }
  }

  return { reply: reply, usage: completion.usage };
}

// Clasifica el estado de la conversacion segun el ultimo mensaje del cliente.
// Conservador: solo devuelve un estado nuevo cuando la senal es clara; si no, devuelve null.
async function clasificarEstado(mensajeCliente) {
  try {
    const prompt = [
      'Sos un clasificador de intencion de un cliente que escribe a una inmobiliaria/hotel por WhatsApp.',
      'Segun el mensaje del cliente, responde UNA sola palabra exacta:',
      '- listo_humano  => si pide hablar con una persona, asesor, vendedor o humano; o quiere reservar, senar, comprar, alquilar, o avanzar una operacion concreta; o pide que lo contacten/llamen.',
      '- interesado    => apenas consulta por una propiedad, alquiler o venta, pregunta precios/valores, disponibilidad, o (en hotel) alojamiento o disponibilidad en ciertas fechas; o pide datos para decidir, pide ir a ver/agendar visita, o dice que le interesa. Basta con que pregunte por algo concreto del negocio.',
      '- sin_cambio    => SOLO si es un saludo inicial sin consulta (hola, buenas) o algo no relacionado al negocio. Si ya pregunto algo concreto, NO es sin_cambio.',
      'Ante la duda entre interesado y sin_cambio, elegi interesado. Ante la duda entre listo_humano e interesado, mira si pide contacto humano o avanzar (listo_humano) o solo ver/consultar (interesado).',
      'Responde SOLO una de esas tres palabras exactas (listo_humano, interesado o sin_cambio), sin nada mas.',
      'Mensaje del cliente: ' + mensajeCliente
    ].join('\n');
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 20, messages: [{ role: 'user', content: prompt }] });
    const out = (r.content[0] && r.content[0].type === 'text') ? r.content[0].text.trim().toLowerCase() : '';
    console.log('[CLASIFICADOR] mensaje:', mensajeCliente, '=> respuesta IA:', JSON.stringify(out));
    if (out.includes('listo_humano')) return 'listo_humano';
    if (out.includes('interesado')) return 'interesado';
    return null;
  } catch (e) { console.error('Error clasificando estado:', e && e.message); return null; }
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
// Traduce un texto a un idioma destino usando el modelo. Devuelve el texto traducido (o el original si falla).
async function traducir(texto, idiomaDestino) {
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
    const out = (comp && comp.content && comp.content[0] && comp.content[0].text) ? comp.content[0].text.trim() : '';
    return out || texto;
  } catch (e) { console.error('Error traduciendo:', e && e.message); return texto; }
}

// Detecta el idioma de un texto. Devuelve un codigo (es/en/pt/de/it/fr) o 'es' por defecto.
async function detectarIdioma(texto) {
  try {
    if (!texto || texto.trim().length < 2) return 'es';
    const comp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      system: 'Detecta el idioma PRINCIPAL del texto del usuario, el idioma en el que esta escrito la mayor parte. Mira la ORACION completa, no palabras aisladas. Si el mensaje entero es un saludo o frase corta (ej. hi, hello, bonjour, hallo), ESE es el idioma. Solo si dentro de una oracion larga hay una palabra prestada de otro idioma, ignora esa palabra y usa el idioma dominante de la oracion. Responde SOLO con el codigo de dos letras del idioma (es, en, pt, fr, it, de, nl, ru, zh, ja, ko, ar, hi, tr, pl, u otro codigo ISO 639-1 si corresponde). Nada mas.',
      messages: [ { role: 'user', content: texto } ]
    });
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
      const { data: bsRep } = await supabase.from('business_settings').select('reportes_config').eq('user_id', user_id).maybeSingle();
      const repCfg = bsRep && bsRep.reportes_config ? bsRep.reportes_config : null;
      if (repCfg && repCfg.whatsapp) {
        const soloNumRep = String(repCfg.whatsapp).replace(/[^0-9]/g, '');
        const soloNumTel = String(telefono).replace(/[^0-9]/g, '');
        // comparar por los ultimos 8 digitos (evita lios de prefijos/0/15)
        const coincide = soloNumRep.length >= 8 && soloNumTel.length >= 8 && soloNumRep.slice(-8) === soloNumTel.slice(-8);
        const pideReporte = /\breporte\b/i.test(String(texto || ''));
        if (coincide && pideReporte) {
          const textoReporte = await generarReporteAdmin(user_id, repCfg);
          await enviarWhatsapp(instanciaNombre, telefono, textoReporte);
          return; // no procesar como lead
        }
      }
    } catch (e) { /* si falla el reporte, seguir con el flujo normal */ }

    // 2) Buscar contacto por telefono dentro del user_id (persistencia: no duplicar)
    let contacto;
    const { data: existente } = await supabase.from('contacts').select('id').eq('user_id', user_id).eq('phone', telefono).maybeSingle();
    if (existente) { contacto = existente; }
    else {
      const pushName = data.pushName || telefono;
      const { data: nuevo } = await supabase.from('contacts').insert({ user_id: user_id, name: pushName, phone: telefono, channel: 'whatsapp' }).select('id').single();
      contacto = nuevo;
    }
    if (!contacto) return;

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

    // 4) Guardar SIEMPRE el mensaje entrante (no se pierde nada)
    // Traduccion entrante: detectar idioma del lead y traducir al espanol para el asesor
    let contentLead = texto;
    let contentOrigLead = null;
    let idiomaLeadMsg = null;
    try {
      const idiomaDetectado = await detectarIdioma(texto);
      if (idiomaDetectado && idiomaDetectado !== 'es') {
        const trad = await traducir(texto, 'es');
        if (trad && trad !== texto) { contentLead = trad; contentOrigLead = texto; idiomaLeadMsg = idiomaDetectado; }
        // recordar el idioma del lead en la conversacion para el traductor saliente
        await supabase.from('conversations').update({ idioma_lead: idiomaDetectado }).eq('id', conv.id);
        if (conv) conv.idioma_lead = idiomaDetectado;
      }
    } catch (eTrad) { console.error('trad entrante:', eTrad && eTrad.message); }
    let mediaUrlLead = null; let mediaTipoLead = null;
    if (tipoMediaEntrante) {
      try { const subido = await subirMediaAStorage(instanciaNombre, data, tipoMediaEntrante); if (subido) { mediaUrlLead = subido.url; mediaTipoLead = subido.tipo; } } catch (eMedia) { console.error('subir media lead:', eMedia && eMedia.message); }
    }
    await supabase.from('messages').insert({ conversation_id: conv.id, user_id: user_id, role: 'contact', content: contentLead, content_original: contentOrigLead, idioma: idiomaLeadMsg, media_url: mediaUrlLead, media_tipo: mediaTipoLead });
    // Si el lead escribe en un idioma distinto al base, activar el traductor automaticamente
    const _updConv = { last_message: texto, last_role: 'contact', updated_at: new Date().toISOString() };
    if (idiomaLeadMsg) { _updConv.idioma_lead = idiomaLeadMsg; _updConv.traductor_activo = true; }
    await supabase.from('conversations').update(_updConv).eq('id', conv.id);

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
      const tempLead = await clasificarTemperatura(texto);
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

    // 5) Si la IA esta activa, responder por WhatsApp
    // PAUSA GLOBAL: si el CRM esta pausado, la IA no responde a nadie (los mensajes igual se guardan).
    // No modifica el ai_enabled de cada conversacion; es una capa global aparte.
    const { data: _bsPausa } = await supabase.from('business_settings').select('crm_pausado').eq('user_id', user_id).maybeSingle();
    if (_bsPausa && _bsPausa.crm_pausado === true) return;
    if (conv.ai_enabled === false) return;
    const resultado = await generarRespuestaAgente(user_id, conv.id, texto);
    if (resultado && resultado.reply) { await enviarWhatsapp(instanciaNombre, telefono, resultado.reply); }

    // Clasificar el estado de la conversacion segun el mensaje del cliente (conservador)
    // Leer el estado actual ANTES de clasificar
    const { data: convActual } = await supabase.from('conversations').select('status').eq('id', conv.id).maybeSingle();
    const estadoActual = (convActual && convActual.status) || 'en_conversacion';
    // BLINDAJE: si ya esta en 'listo_humano' o 'cerrado', NO se reclasifica (queda quieto)
    if (estadoActual !== 'listo_humano' && estadoActual !== 'cerrado') {
      const nuevoEstado = await clasificarEstado(texto);
      if (nuevoEstado) {
        // Orden de prioridad: en_conversacion < interesado < listo_humano (solo sube, nunca baja)
        const nivel = { en_conversacion: 1, interesado: 2, listo_humano: 3 };
        if ((nivel[nuevoEstado] || 0) > (nivel[estadoActual] || 0)) {
          const update = { status: nuevoEstado, updated_at: new Date().toISOString() };
          // Si pasa a listo_humano, pausar la IA automaticamente para que lo tome un humano
          if (nuevoEstado === 'listo_humano') { update.ai_enabled = false; }
          await supabase.from('conversations').update(update).eq('id', conv.id);
          // Si paso a listo_humano y no tiene asesor ni fue tomado por el admin, asignar automaticamente
          if (nuevoEstado === 'listo_humano') {
            const { data: cv } = await supabase.from('conversations').select('asesor_id, admin_tomo').eq('id', conv.id).single();
            if (cv && !cv.asesor_id && !cv.admin_tomo) {
              const asesorAuto = await elegirAsesorActivo(conv.user_id);
              if (asesorAuto) {
                await supabase.from('conversations').update({ asesor_id: asesorAuto, ultimo_asesor_id: asesorAuto }).eq('id', conv.id);
              }
            }
          }
        }
      }
      // RED DE SEGURIDAD: si la conversacion esta en listo_humano sin asesor (quedo huerfana), derivar ahora
      try {
        const { data: cvSeg } = await supabase.from('conversations').select('status, asesor_id, admin_tomo, user_id').eq('id', conv.id).single();
        if (cvSeg && cvSeg.status === 'listo_humano' && !cvSeg.asesor_id && !cvSeg.admin_tomo) {
          const asesorSeg = await elegirAsesorActivo(cvSeg.user_id);
          if (asesorSeg) {
            await supabase.from('conversations').update({ asesor_id: asesorSeg, ultimo_asesor_id: asesorSeg }).eq('id', conv.id);
          }
        }
      } catch (eSeg) { console.error('Error red seguridad derivacion:', eSeg); }
    }
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
    if (conv.traductor_activo && conv.idioma_lead && conv.idioma_lead !== 'es') {
      textoEnviar = await traducir(texto, conv.idioma_lead);
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
      .select('id, user_id, contact_id, recontacto_count, recontacto_max')
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
      // Registrar primero en messages (con id) para poder marcar estado de envio
      const { data: msgRec } = await supabase.from('messages').insert({ conversation_id: conv.id, user_id: conv.user_id, role: 'ai', content: texto, enviado_por: 'Agente IA', estado_envio: 'enviando' }).select('id').single();
      // Enviar y registrar estado (enviado/fallido) en ese mensaje
      await enviarWhatsapp(inst.instancia_nombre, contacto.phone, texto, msgRec ? msgRec.id : null);
      await supabase.from('conversations').update({ last_message: texto, last_role: 'ai', updated_at: new Date().toISOString() }).eq('id', conv.id);
      await supabase.from('recontactos').insert({ user_id: conv.user_id, conversation_id: conv.id, contact_id: conv.contact_id, intento: countRec + 1, mensaje: texto, enviado_at: new Date().toISOString() });
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
    const { admin_id, nombre, usuario, clave, cargo } = req.body || {};
    // SEGURIDAD: validar identidad por token
    const _uidToken = await verificarUsuario(req);
    if (!_uidToken) return res.status(401).json({ error: 'No autorizado: falta token valido' });
    if (_uidToken !== admin_id) return res.status(403).json({ error: 'Identidad no coincide' });
    if (!admin_id || !nombre || !usuario || !clave) return res.status(400).json({ error: 'Faltan datos' });
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
    const { data: created, error: errAuth } = await supabase.auth.admin.createUser({ email: email, password: clave, email_confirm: true, user_metadata: { rol: 'asesor', admin_id: admin_id, nombre: nombre } });
    if (errAuth) return res.status(400).json({ error: errAuth.message });
    const authId = created && created.user ? created.user.id : null;
    const { error: errIns } = await supabase.from('asesores').insert({ admin_id: admin_id, auth_user_id: authId, nombre: nombre, usuario: usuario, cargo: (cargo && cargo.trim()) ? cargo.trim() : 'Asesor', estado: 'activo', activo: true });
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
    // 2. Buscar asesores activos de la inmobiliaria
    const { data: activos } = await supabase.from('asesores').select('id').eq('admin_id', admin_id).eq('activo', true);
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

// ===== SCRAPING DE INVENTARIO (webs Houzez/WordPress) =====
app.get('/api/scrape/lista', async function(req, res) {
  try {
    let sitio = (req.query.url || '').trim();
    if (!sitio) return res.status(400).json({ error: 'Falta el parametro url' });
    if (!sitio.startsWith('http')) sitio = 'https://' + sitio;
    // normalizar a dominio base
    let base;
    try { const u = new URL(sitio); base = u.protocol + '//' + u.host; } catch(e){ return res.status(400).json({ error: 'URL invalida' }); }
    // 1) intentar el sitemap de propiedades de Houzez
    const candidatos = [base + '/wp-sitemap-posts-property-1.xml', base + '/property-sitemap.xml', base + '/wp-sitemap.xml'];
    let urls = [];
    for (const sm of candidatos) {
      try {
        const r = await fetch(sm, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
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
          const r2 = await fetch(subProperty, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
          if (r2.ok) { const xml2 = await r2.text(); const m2 = xml2.match(/<loc>([^<]+)<\/loc>/g) || []; urls = m2.map(function(m){ return m.replace(/<\/?loc>/g, ''); }); break; }
        }
      } catch(e) { /* probar siguiente */ }
    }
    if (urls.length === 0) return res.json({ ok: true, total: 0, urls: [], nota: 'No se encontro sitemap de propiedades. La web puede no ser compatible.' });
    // extraer id de cada url (patron -id-NUMERO o idNUMERO)
    const items = urls.map(function(u){ const m = u.match(/id-?(\d+)/i); return { url: u, numero: m ? m[1] : '' }; });
    return res.json({ ok: true, total: items.length, urls: items });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});
app.post('/api/scrape/detalle', async function(req, res) {
  try {
    const urls = (req.body && req.body.urls) || [];
    if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: 'Falta el array urls' });
    if (urls.length > 15) return res.status(400).json({ error: 'Maximo 15 por lote' });
    const resultados = [];
    for (const item of urls) {
      const u = typeof item === 'string' ? item : item.url;
      try {
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
        if (!r.ok) { resultados.push({ url: u, error: 'status ' + r.status }); continue; }
        const html = await r.text();
        // extraer todos los pares <strong>Etiqueta:</strong> Valor
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
        resultados.push({
          url: u,
          titulo: tituloM ? tituloM[1].trim() : '',
          descripcion: descCompleta ? descCompleta : (descM ? descM[1].trim() : ''),
          campos: campos
        });
      } catch (e) { resultados.push({ url: u, error: e && e.message }); }
    }
    return res.json({ ok: true, resultados: resultados });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});
// ===== TEMPERATURA DE LEADS =====
// Clasifica un lead segun su ultimo mensaje: frio (no responde / sin interes), tibio (responde sin interes claro), caliente (muestra interes en ver propiedades)
async function clasificarTemperatura(textoUsuario) {
  try {
    if (!textoUsuario || !textoUsuario.trim()) return null;
    const prompt = 'Clasifica el interes de este mensaje de un posible cliente inmobiliario en UNA palabra: ' +
      'caliente (muestra interes concreto en ver, visitar, precio, o avanzar con una propiedad), ' +
      'tibio (responde pero sin interes claro), frio (no hay interes). ' +
      'Responde SOLO con: caliente, tibio o frio. Mensaje: ' + JSON.stringify(textoUsuario);
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: prompt }] });
    const t = (r && r.content && r.content[0] && r.content[0].text ? r.content[0].text : '').toLowerCase().trim();
    if (t.indexOf('caliente') >= 0) return 'caliente';
    if (t.indexOf('tibio') >= 0) return 'tibio';
    if (t.indexOf('frio') >= 0 || t.indexOf('frío') >= 0) return 'frio';
    return null;
  } catch (e) { console.log('clasificarTemperatura error:', e && e.message); return null; }
}
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
  return String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
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
      var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
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

    var props = await obtenerPropiedadesUniversal(sitio, limite);
    if (!props.length) return res.json({ ok: false, mensaje: 'No se encontraron propiedades por ninguna via', total: 0 });

    // sacar el precio de cada propiedad entrando a su pagina (en tandas para no saturar)
    for (var i = 0; i < props.length; i++) {
      if (!props[i].link) continue;
      try {
        var h = await fetch(props[i].link, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
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
  return String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
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
  try { var resp = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } }); if (resp.ok) { var html = await resp.text(); pares = extraerTablaDetalles(html); precio = extraerPrecio2(html); } } catch (e) {}
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
      var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 RaicesCRM' } });
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
    var lista = await traerListaPropiedades(sitio, limite);
    if (!lista.length) return res.json({ ok: false, mensaje: 'No se encontraron propiedades', propiedades: [] });
    var procesadas = [];
    for (var i = 0; i < lista.length; i++) {
      try { var pr = await procesarPropiedad(lista[i]); procesadas.push(pr); } catch (e) {}
    }
    return res.json({ ok: true, total: procesadas.length, propiedades: procesadas });
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

app.listen(PORT, function(){ console.log('Raices CRM backend escuchando en puerto ' + PORT); });
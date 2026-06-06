// Raices CRM - Backend del Agente IA + Webhook WhatsApp
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3001;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY || '' });
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_KEY || '');
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

async function generarRespuestaAgente(user_id, conversation_id, message) {
  const { data: settings } = await supabase.from('business_settings').select('*').eq('user_id', user_id).maybeSingle();
  const { data: knowledge } = await supabase.from('knowledge_base').select('category, question, answer').eq('user_id', user_id);
  const { data: properties } = await supabase.from('properties').select('numero, title, type, zone, caracteristicas, price, rooms, capacity, amenities, link, operation, status, venta_activa, venta_estado, venta_precio, anual_activa, anual_estado, anual_precio, temporal_activa, temporal_precio_dia').eq('user_id', user_id).eq('activa', true);

  const agentName = (settings && settings.agent_name) || 'Asistente';
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

  let inventario = 'No hay propiedades cargadas todavia.';
  if (properties && properties.length > 0) {
    inventario = properties.map(function(p){
    var ops = [];
    if (p.venta_activa && p.venta_estado !== 'vendida') ops.push('VENTA (' + (p.venta_estado||'disponible') + '): ' + (p.venta_precio ? 'USD ' + p.venta_precio : 'consultar'));
    if (p.anual_activa && p.anual_estado !== 'alquilada') ops.push('ALQUILER ANUAL (' + (p.anual_estado||'disponible') + '): ' + (p.anual_precio ? '$' + p.anual_precio + '/mes' : 'consultar'));
    if (p.temporal_activa) ops.push('ALQUILER TEMPORAL: ' + (p.temporal_precio_dia ? '$' + p.temporal_precio_dia + '/dia (base)' : 'consultar') + ' (consultar fechas disponibles)');
    if (ops.length === 0 && p.operation) ops.push(p.operation + (p.price ? ': ' + p.price : ''));
    var enc = (p.numero ? 'N' + p.numero + ' - ' : '') + (p.title||'');
    var carac = [p.zone, p.caracteristicas].filter(Boolean).join(', ');
    return '- ' + enc + (carac ? ' (' + carac + ')' : '') + ' | ' + (p.type||'') + ' | ambientes: ' + (p.rooms||'-') + ' | capacidad: ' + (p.capacity||'-') + ' | ' + (ops.length ? ops.join(' ; ') : 'sin operacion activa') + (p.amenities ? ' | amenities: ' + p.amenities : '') + (p.link ? ' | link: ' + p.link : '');
  }).join(String.fromCharCode(10));
  }

  let historial = [];
  if (conversation_id) {
    const { data: prev } = await supabase.from('messages').select('role, content').eq('conversation_id', conversation_id).order('created_at', { ascending: true });
    if (prev && prev.length > 0) {
      historial = prev.map(function(m){ return { role: (m.role === 'contact' ? 'user' : 'assistant'), content: m.content }; });
    }
  }

  const systemPrompt = [
    'Sos ' + agentName + ', el asistente de atencion de ' + company + ' (rubro: ' + rubro + ').',
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
    await supabase.from('messages').insert([
      { conversation_id: conversation_id, user_id: user_id, role: 'ai', content: reply, enviado_por: 'Agente IA' }
    ]);
    await supabase.from('conversations').update({ last_message: reply, last_role: 'ai', updated_at: new Date().toISOString() }).eq('id', conversation_id);
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
async function enviarWhatsapp(instancia, numero, texto) {
  if (!EVOLUTION_URL || !EVOLUTION_KEY) { console.error('Faltan EVOLUTION_URL o EVOLUTION_KEY'); return; }
  try {
    const resp = await fetch(EVOLUTION_URL + '/message/sendText/' + instancia, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({ number: numero, text: texto })
    });
    if (!resp.ok) { const t = await resp.text(); console.error('Error enviando WhatsApp:', resp.status, t); }
  } catch (e) { console.error('Excepcion enviando WhatsApp:', e && e.message); }
}

app.get('/health', (req, res) => { res.json({ status: 'ok', app: 'Raices CRM' }); });
app.get('/', (req, res) => { res.json({ message: 'Raices CRM API', status: 'online' }); });

// Endpoint para probar el agente desde el CRM (escribir como cliente)
app.post('/api/agent/respond', async (req, res) => {
  try {
    const { user_id, conversation_id, message } = req.body || {};
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
app.post('/api/webhook/whatsapp', async (req, res) => {
  res.json({ received: true });
  try {
    const body = req.body || {};
    const evento = body.event || '';
    if (evento !== 'messages.upsert') return;

    const data = body.data || {};
    const instanciaNombre = body.instance || data.instanceName || '';
    if (!instanciaNombre) return;

    const key = data.key || {};
    const esFromMe = key.fromMe === true; // mensaje saliente propio: se maneja tras extraer el texto

    const remoteJid = key.remoteJid || '';
    if (!remoteJid || remoteJid.includes('@g.us')) return; // ignorar grupos
    const telefono = remoteJid.split('@')[0];

    const msg = data.message || {};
    const texto = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || '';
    if (!texto) return;

    // Mensaje saliente escrito por un humano desde su WhatsApp: guardarlo con marca y cortar.
    if (esFromMe) {
      await guardarMensajeSaliente(remoteJid, texto);
      return;
    }

    // 1) Identificar el user_id dueno de esta instancia (multi-cliente)
    const { data: inst } = await supabase.from('whatsapp_instancias').select('user_id').eq('instancia_nombre', instanciaNombre).maybeSingle();
    if (!inst) { console.error('Instancia sin user_id:', instanciaNombre); return; }
    const user_id = inst.user_id;

    // 2) Buscar contacto por telefono dentro del user_id (persistencia: no duplicar)
    let contacto;
    const { data: existente } = await supabase.from('contacts').select('id').eq('user_id', user_id).eq('phone', telefono).maybeSingle();
    if (existente) { contacto = existente; }
    else {
      const pushName = data.pushName || ('Cliente ' + telefono.slice(-4));
      const { data: nuevo } = await supabase.from('contacts').insert({ user_id: user_id, name: pushName, phone: telefono, channel: 'whatsapp' }).select('id').single();
      contacto = nuevo;
    }
    if (!contacto) return;

    // 3) Buscar o crear conversacion
    let conv;
    const { data: convExistente } = await supabase.from('conversations').select('id, ai_enabled, status, estado_previo').eq('user_id', user_id).eq('contact_id', contacto.id).maybeSingle();
    if (convExistente) { conv = convExistente; }
    else {
      const asesorAsignado = await elegirAsesorActivo(user_id);
      const { data: convNueva } = await supabase.from('conversations').insert({ user_id: user_id, contact_id: contacto.id, channel: 'whatsapp', status: 'en_conversacion', ai_enabled: true, asesor_id: asesorAsignado, ultimo_asesor_id: asesorAsignado }).select('id, ai_enabled').single();
      conv = convNueva;
    }
    if (!conv) return;

    // 4) Guardar SIEMPRE el mensaje entrante (no se pierde nada)
    await supabase.from('messages').insert({ conversation_id: conv.id, user_id: user_id, role: 'contact', content: texto });
    await supabase.from('conversations').update({ last_message: texto, last_role: 'contact', updated_at: new Date().toISOString() }).eq('id', conv.id);

    // Si la conversacion estaba en 'recontacto' y el lead volvio a escribir:
    // vuelve al estado en el que estaba (estado_previo) y se resetea el contador de recontactos
    if (convExistente && convExistente.status === 'recontacto') {
      const volverA = convExistente.estado_previo || 'en_conversacion';
      await supabase.from('conversations').update({
        status: volverA,
        estado_previo: null,
        recontacto_count: 0,
        updated_at: new Date().toISOString()
      }).eq('id', conv.id);
    }

    // 5) Si la IA esta activa, responder por WhatsApp
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
    }
  } catch (e) { console.error('Error en webhook whatsapp:', e && e.message); }
});

// ============ ENVIO MANUAL DE WHATSAPP (cuando el humano escribe desde el CRM) ============
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { user_id, conversation_id, texto, enviado_por } = req.body || {};
    if (!user_id || !conversation_id || !texto) return res.status(400).json({ error: 'Faltan datos' });

    // 1) Buscar la conversacion para obtener el contacto
    const { data: conv } = await supabase.from('conversations').select('contact_id, user_id').eq('id', conversation_id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });

    // 2) Buscar el telefono del contacto
    const { data: contacto } = await supabase.from('contacts').select('phone').eq('id', conv.contact_id).maybeSingle();
    if (!contacto || !contacto.phone) return res.status(400).json({ error: 'El contacto no tiene telefono (no es WhatsApp)' });

    // 3) Buscar la instancia de WhatsApp de este user (la conectada)
    const inst = { instancia_nombre: nombreInstancia(conv.user_id) };

    // 4) Guardar el mensaje como 'human' y actualizar la conversacion
    await supabase.from('messages').insert({ conversation_id: conversation_id, user_id: conv.user_id, role: 'human', content: texto, enviado_por: enviado_por || 'Humano' });
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
    await enviarWhatsapp(inst.instancia_nombre, contacto.phone, texto);

    res.json({ sent: true });
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
function mensajeRecontacto(nombre) {
  const n = nombre ? (' ' + nombre) : '';
  const opciones = [
    'Hola' + n + ', ¿seguís interesado/a? Quedo a disposición por si querés que avancemos.',
    'Hola' + n + ', ¿cómo va? Por si te quedó alguna duda sobre lo que veníamos hablando, decime y te ayudo.',
    'Buenas' + n + ', ¿retomamos? Si todavía estás buscando, con gusto te paso más info.',
    'Hola' + n + ', te escribo para saber si seguís interesado/a. Cualquier cosa me decís y seguimos.',
    '¿Cómo andás' + n + '? Quedé con ganas de ayudarte. Si querés seguir viendo opciones, avisame.'
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
      const texto = mensajeRecontacto(contacto.name);
      await enviarWhatsapp(inst.instancia_nombre, contacto.phone, texto);
      // Registrar: en messages (como ai), en recontactos, y actualizar contador
      await supabase.from('messages').insert({ conversation_id: conv.id, user_id: conv.user_id, role: 'ai', content: texto, enviado_por: 'Agente IA' });
      await supabase.from('conversations').update({ last_message: texto, last_role: 'ai', updated_at: new Date().toISOString() }).eq('id', conv.id);
      await supabase.from('recontactos').insert({ user_id: conv.user_id, conversation_id: conv.id, contact_id: conv.contact_id, intento: countRec + 1, mensaje: texto, enviado_at: new Date().toISOString() });
      await supabase.from('conversations').update({ recontacto_count: countRec + 1 }).eq('id', conv.id);
      console.log('Recontacto ENVIADO a conversacion ' + conv.id + ' (intento ' + (countRec+1) + ')');
    }
  } catch (e) { console.error('Error en enviarRecontactosPendientes:', e && e.message); }
}

setInterval(revisarInactividad, 60 * 60 * 1000);
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

app.post('/api/asesores/eliminar', async (req, res) => {
  try {
    const { admin_id, asesor_id } = req.body || {};
    if (!admin_id || !asesor_id) return res.status(400).json({ error: 'Faltan datos' });
    const { data: ases } = await supabase.from('asesores').select('*').eq('id', asesor_id).eq('admin_id', admin_id).maybeSingle();
    if (!ases) return res.status(404).json({ error: 'Asesor no encontrado' });
    if (ases.auth_user_id) { try { await supabase.auth.admin.deleteUser(ases.auth_user_id); } catch (e) {} }
    await supabase.from('asesores').delete().eq('id', asesor_id).eq('admin_id', admin_id);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e && e.message }); }
});

app.listen(PORT, function(){ console.log('Raices CRM backend escuchando en puerto ' + PORT); });
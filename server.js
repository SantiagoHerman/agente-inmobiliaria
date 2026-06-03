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
async function generarRespuestaAgente(user_id, conversation_id, message) {
  const { data: settings } = await supabase.from('business_settings').select('*').eq('user_id', user_id).maybeSingle();
  const { data: knowledge } = await supabase.from('knowledge_base').select('category, question, answer').eq('user_id', user_id);
  const { data: properties } = await supabase.from('properties').select('title, type, operation, zone, price, rooms, capacity, amenities, status').eq('user_id', user_id).eq('status', 'disponible');

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
    inventario = properties.map(function(p){ return '- ' + p.title + ' | ' + (p.type||'') + ' | ' + (p.operation||'') + ' | zona: ' + (p.zone||'-') + ' | precio: ' + (p.price||'-') + ' | ambientes: ' + (p.rooms||'-') + ' | capacidad: ' + (p.capacity||'-') + (p.amenities ? ' | ' + p.amenities : ''); }).join('\n');
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
    tono, autonomia, objetivo, largo,
    usaEmojis ? 'Podes usar algun emoji con moderacion.' : 'NO uses emojis.',
    instructions ? ('Instrucciones internas que SIEMPRE debes seguir: ' + instructions) : '',
    '', 'Base de conocimiento de la empresa:', kb, '',
    'Propiedades disponibles (usalas para recomendar; no ofrezcas las que no esten aca):', inventario, '',
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
      { conversation_id: conversation_id, user_id: user_id, role: 'ai', content: reply }
    ]);
    await supabase.from('conversations').update({ last_message: reply, updated_at: new Date().toISOString() }).eq('id', conversation_id);
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
      '- listo_humano  => si pide hablar con una persona/asesor, o quiere reservar, senar, o avanzar una compra/alquiler concreto.',
      '- interesado    => si pide ir a ver la propiedad personalmente, agendar visita, o coordinar una visita/cita.',
      '- sin_cambio    => en cualquier otro caso (consulta general, saludo, pregunta de info).',
      'Responde SOLO una de esas tres palabras, sin nada mas.',
      'Mensaje del cliente: ' + mensajeCliente
    ].join('\n');
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: prompt }] });
    const out = (r.content[0] && r.content[0].type === 'text') ? r.content[0].text.trim().toLowerCase() : '';
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
    if (key.fromMe === true) return; // ignorar mensajes propios (solo respondemos a quien escribe primero)

    const remoteJid = key.remoteJid || '';
    if (!remoteJid || remoteJid.includes('@g.us')) return; // ignorar grupos
    const telefono = remoteJid.split('@')[0];

    const msg = data.message || {};
    const texto = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || '';
    if (!texto) return;

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
    const { data: convExistente } = await supabase.from('conversations').select('id, ai_enabled').eq('user_id', user_id).eq('contact_id', contacto.id).maybeSingle();
    if (convExistente) { conv = convExistente; }
    else {
      const { data: convNueva } = await supabase.from('conversations').insert({ user_id: user_id, contact_id: contacto.id, channel: 'whatsapp', status: 'en_conversacion', ai_enabled: true }).select('id, ai_enabled').single();
      conv = convNueva;
    }
    if (!conv) return;

    // 4) Guardar SIEMPRE el mensaje entrante (no se pierde nada)
    await supabase.from('messages').insert({ conversation_id: conv.id, user_id: user_id, role: 'contact', content: texto });
    await supabase.from('conversations').update({ last_message: texto, updated_at: new Date().toISOString() }).eq('id', conv.id);

    // 5) Si la IA esta activa, responder por WhatsApp
    if (conv.ai_enabled === false) return;
    const resultado = await generarRespuestaAgente(user_id, conv.id, texto);
    if (resultado && resultado.reply) { await enviarWhatsapp(instanciaNombre, telefono, resultado.reply); }

    // Clasificar el estado de la conversacion segun el mensaje del cliente (conservador)
    const nuevoEstado = await clasificarEstado(texto);
    if (nuevoEstado) {
      // Leer el estado actual para no 'bajar' de nivel
      const { data: convActual } = await supabase.from('conversations').select('status').eq('id', conv.id).maybeSingle();
      const estadoActual = (convActual && convActual.status) || 'en_conversacion';
      // Orden de prioridad: en_conversacion < interesado < listo_humano
      const nivel = { en_conversacion: 1, interesado: 2, listo_humano: 3 };
      if ((nivel[nuevoEstado] || 0) > (nivel[estadoActual] || 0)) {
        const update = { status: nuevoEstado, updated_at: new Date().toISOString() };
        // Si pasa a listo_humano, pausar la IA automaticamente para que lo tome un humano
        if (nuevoEstado === 'listo_humano') { update.ai_enabled = false; }
        await supabase.from('conversations').update(update).eq('id', conv.id);
      }
    }
  } catch (e) { console.error('Error en webhook whatsapp:', e && e.message); }
});

// ============ ENVIO MANUAL DE WHATSAPP (cuando el humano escribe desde el CRM) ============
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { user_id, conversation_id, texto } = req.body || {};
    if (!user_id || !conversation_id || !texto) return res.status(400).json({ error: 'Faltan datos' });

    // 1) Buscar la conversacion para obtener el contacto
    const { data: conv } = await supabase.from('conversations').select('contact_id').eq('id', conversation_id).eq('user_id', user_id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });

    // 2) Buscar el telefono del contacto
    const { data: contacto } = await supabase.from('contacts').select('phone').eq('id', conv.contact_id).maybeSingle();
    if (!contacto || !contacto.phone) return res.status(400).json({ error: 'El contacto no tiene telefono (no es WhatsApp)' });

    // 3) Buscar la instancia de WhatsApp de este user (la conectada)
    const { data: inst } = await supabase.from('whatsapp_instancias').select('instancia_nombre').eq('user_id', user_id).eq('estado', 'conectado').maybeSingle();
    if (!inst) return res.status(400).json({ error: 'No hay instancia de WhatsApp conectada para este usuario' });

    // 4) Guardar el mensaje como 'human' y actualizar la conversacion
    await supabase.from('messages').insert({ conversation_id: conversation_id, user_id: user_id, role: 'human', content: texto });
    await supabase.from('conversations').update({ last_message: texto, updated_at: new Date().toISOString() }).eq('id', conversation_id);

    // 5) Enviar por WhatsApp via Evolution
    await enviarWhatsapp(inst.instancia_nombre, contacto.phone, texto);

    res.json({ sent: true });
  } catch (err) {
    console.error('Error en /api/whatsapp/send:', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Error interno' });
  }
});

app.listen(PORT, function(){ console.log('Raices CRM backend escuchando en puerto ' + PORT); });
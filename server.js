// Raices CRM - Backend del Agente IA
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// CORS abierto para que el frontend (Vercel) pueda llamar
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

app.get('/health', (req, res) => { res.json({ status: 'ok', app: 'Raices CRM' }); });
app.get('/', (req, res) => { res.json({ message: 'Raices CRM API', status: 'online' }); });

app.post('/api/agent/respond', async (req, res) => {
  try {
    const { user_id, conversation_id, message } = req.body || {};
    if (!user_id || !message) return res.status(400).json({ error: 'Faltan user_id o message' });

    const { data: settings } = await supabase.from('business_settings').select('*').eq('user_id', user_id).maybeSingle();
    const { data: knowledge } = await supabase.from('knowledge_base').select('category, question, answer').eq('user_id', user_id);

    const agentName = (settings && settings.agent_name) || 'Asistente';
    const tono = TONO[(settings && settings.agent_tone) || 'cercano'] || TONO.cercano;
    const autonomia = AUTONOMIA[(settings && settings.autonomy) || 'equilibrado'] || AUTONOMIA.equilibrado;
    const rubro = (settings && settings.rubro) || 'inmobiliaria';
    const company = (settings && settings.company_name) || 'la empresa';
    const instructions = (settings && settings.instructions) || '';

    let kb = 'No hay informacion cargada todavia.';
    if (knowledge && knowledge.length > 0) {
      kb = knowledge.map(function(k){ return '- [' + k.category + '] ' + k.question + ' => ' + k.answer; }).join('\n');
    }

    const systemPrompt = [
      'Sos ' + agentName + ', el asistente de atencion de ' + company + ' (rubro: ' + rubro + ').',
      'Respondes consultas de clientes por WhatsApp.',
      tono, autonomia,
      instructions ? ('Instrucciones internas que SIEMPRE debes seguir: ' + instructions) : '',
      '', 'Base de conocimiento de la empresa:', kb, '',
      'Responde breve y natural, como en un chat de WhatsApp. No inventes datos que no esten en la base de conocimiento.'
    ].filter(Boolean).join('\n');

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    });

    const block = completion.content[0];
    const reply = (block && block.type === 'text') ? block.text : 'No pude generar una respuesta.';

    if (conversation_id) {
      await supabase.from('messages').insert([
        { conversation_id: conversation_id, user_id: user_id, role: 'contact', content: message },
        { conversation_id: conversation_id, user_id: user_id, role: 'ai', content: reply }
      ]);
      await supabase.from('conversations').update({ last_message: reply, updated_at: new Date().toISOString() }).eq('id', conversation_id);
    }

    res.json({ reply: reply, usage: completion.usage });
  } catch (err) {
    console.error('Error en /api/agent/respond:', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Error interno' });
  }
});

app.listen(PORT, function(){ console.log('Raices CRM backend escuchando en puerto ' + PORT); });
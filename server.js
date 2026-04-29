Perfecto! Ahora copiá todo este código y pegalo en el archivo server.js:
javascriptimport express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.urlencoded({ extended: false }));

const twilioClient = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_TOKEN
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

const conversations = new Map();

const SYSTEM_PROMPT = `Sos Valentina, asesora virtual de InmoIA, 
inmobiliaria argentina. Respondé en español rioplatense, cercana y profesional.
Cuando el cliente quiera visitar una propiedad o quiera avanzar, escribí al final: DERIVAR_A_HUMANO: [motivo]

PROPIEDADES DISPONIBLES:
- Casa Palermo: venta USD 180.000, 3 ambientes, 120m², jardín y cochera
- Depto Belgrano: alquiler 380.000 pesos/mes, 2 ambientes, balcón y amenities
- PH Villa Crespo: venta USD 95.000, 2 ambientes, 70m², terraza propia
- Casa San Isidro: alquiler 650.000 pesos/mes, 4 ambientes, pileta y quincho
- Semipiso Recoleta: venta USD 320.000, 4 ambientes, vista al parque
- Monoambiente Caballito: alquiler 210.000 pesos/mes, 32m²`;

app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const userText = req.body.Body;

  const history = conversations.get(from) || [];

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [...history, { role: "user", content: userText }],
  });

  const raw = response.content[0].text;
  const handoff = raw.match(/DERIVAR_A_HUMANO:\s*(.+)/);
  const reply = raw.replace(/DERIVAR_A_HUMANO:\s*.+/, "").trim();

  history.push({ role: "user", content: userText });
  history.push({ role: "assistant", content: reply });
  if (history.length > 20) history.splice(0, 2);
  conversations.set(from, history);

  if (handoff) {
    await twilioClient.messages.create({
      from: "whatsapp:+14155238886",
      to: "whatsapp:+5492235624061",
      body: `🔔 Cliente interesado\n📱 ${from}\n💬 ${handoff[1]}`,
    });
  }

  await twilioClient.messages.create({
    from: "whatsapp:+14155238886",
    to: from,
    body: reply,
  });

  res.sendStatus(200);
});

app.listen(3000, () => console.log("✅ Servidor listo en puerto 3000"));
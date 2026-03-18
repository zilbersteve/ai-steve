import express from "express";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const VOICE_ID = process.env.VOICE_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

app.get("/", (req, res) => {
  res.send("AI Steve is live");
});

async function generateAudio() {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: "what up",
        model_id: "eleven_multilingual_v2"
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs failed: ${errorText}`);
  }

  const audioBuffer = await response.arrayBuffer();
  return Buffer.from(audioBuffer);
}

app.get("/audio.mp3", async (req, res) => {
  try {
    const audio = await generateAudio();
    res.set("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    console.error(err);
    res.status(500).send("Audio generation failed");
  }
});

function sendVoiceTwiML(req, res) {
  res.type("text/xml");
  res.send(`
    <Response>
      <Play>https://expressjs-postgres-production-91a9.up.railway.app/audio.mp3</Play>
    </Response>
  `);
}

app.get("/voice", sendVoiceTwiML);
app.post("/voice", sendVoiceTwiML);

async function generateSmsReply(incomingText, fromNumber) {
  const prompt = `
You are Steve. You're texting like yourself.

Sound like a real person, not support, not a chatbot, not polished.
Default to 1-2 sentences. Sometimes 3 if needed. Keep it concise, human, and slightly blunt.
Do not over-explain. Do not summarize neatly. Do not sound like customer service.

Style:
- natural, quick-witted, perceptive
- casual and grounded
- can be sharp, playful, direct, or thoughtful depending on context
- don't force questions
- most of the time, do not ask a question unless it feels genuinely useful
- react first when it fits
- can have opinions
- slight edge is fine

Texting habits:
- lowercase is fine
- sometimes use "u" instead of "you"
- sometimes use "ya" instead of "yeah"
- sometimes use "y" instead of "why"
- sometimes use "txt" instead of "text"
- occasional casual words like "ya", "yup", "honestly", "w8", "dude", "man", "bro" when they fit
- sentence fragments are okay
- saying "lol" or "LOL" is ok but rarely
- don't sound too clean or over-edited
- can say "hahaha" when something is very funny, or "LOL"
- no emojis unless the other person uses them first

Important:
- do not repeat the user's message back to them
- do not sound generic
- do not try too hard to keep the conversation going
- do not analyze their feelings unless they clearly go there
- if unclear, ask briefly instead of guessing
- keep most replies under 320 characters

How Steve thinks:
Steve is highly creative and strategic. He naturally thinks about attention, momentum, perception, psychology, virality, design, branding, marketing, and content systems. He prefers simple, high-signal ideas with a strong hook, clear visual, low friction, and a twist. He trusts behavior more than opinions and cares about what people actually react to, share, recreate, or talk about.

Personal flavor:
Steve is a filmmaker/editor turned viral strategist and system builder. He likes sharp thinking, visual ideas, cultural instinct, motorcycles, capybaras, and building Butter Baby as a full brand/IP world, not just a donut shop.

Incoming txt from ${fromNumber}: "${incomingText}"

Reply as Steve would txt back.
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.4",
      input: prompt,
      max_output_tokens: 120
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI failed: ${errorText}`);
  }

  const data = await response.json();
  return (data.output_text || "yo").trim().slice(0, 320);
}

app.post("/sms", async (req, res) => {
  try {
    const incoming = (req.body.Body || "").trim();
    const from = req.body.From || "";

    const reply = await generateSmsReply(incoming, from);

    res.type("text/xml");
    res.send(`
      <Response>
        <Message>${reply
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</Message>
      </Response>
    `);
  } catch (err) {
    console.error("SMS reply error:", err);
    res.type("text/xml");
    res.send(`
      <Response>
        <Message>Sorry, I hit a temporary issue. Try me again in a sec.</Message>
      </Response>
    `);
  }
});

app.post("/send-sms", async (req, res) => {
  try {
    const { to, body } = req.body;

    if (!to || !body) {
      return res.status(400).json({ error: "Missing to or body" });
    }

    const auth = Buffer.from(
      `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const twilioResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          To: to,
          From: TWILIO_FROM_NUMBER,
          Body: body
        })
      }
    );

    const data = await twilioResp.json();

    if (!twilioResp.ok) {
      return res.status(500).json({ error: data });
    }

    res.json({ success: true, sid: data.sid });
  } catch (err) {
    console.error("Outbound SMS error:", err);
    res.status(500).json({ error: "Outbound SMS failed" });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

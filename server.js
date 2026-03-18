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
You are AI Steve texting from Steve's business line.
Be concise, natural, confident, helpful, and human.
Do not use emojis unless the user does first.
Keep most replies under 320 characters.
Incoming text from ${fromNumber}: "${incomingText}"
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.4",
      input: prompt
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI failed: ${errorText}`);
  }

  const data = await response.json();
  return (data.output_text || "yo").trim();
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

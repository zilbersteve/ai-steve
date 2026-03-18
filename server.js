import express from "express";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const VOICE_ID = process.env.VOICE_ID;

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

app.post("/sms", (req, res) => {
  const incoming = (req.body.Body || "").trim();

  res.type("text/xml");
  res.send(`
    <Response>
      <Message>hey ${incoming}</Message>
    </Response>
  `);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

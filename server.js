import express from "express";

const app = express();

app.use(express.json());

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const VOICE_ID = process.env.VOICE_ID;

app.get("/", (req, res) => {
  res.send("AI Steve is live");
});

async function handleVoice(req, res) {
  try {
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
      console.error("ElevenLabs error:", errorText);
      return res.status(500).send("ElevenLabs request failed");
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString("base64");

    res.type("text/xml");
    res.send(`
      <Response>
        <Play>data:audio/mpeg;base64,${base64Audio}</Play>
      </Response>
    `);
  } catch (err) {
    console.error("Voice route error:", err);
    res.status(500).send("Error");
  }
}

app.get("/voice", handleVoice);
app.post("/voice", handleVoice);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

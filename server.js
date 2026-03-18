import express from "express";

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("AI Steve is live");
});

app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Say>yoo</Say>
    </Response>
  `);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

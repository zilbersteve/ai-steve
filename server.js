import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import pg from 'pg';
import { WebSocket } from 'ws';

const { Pool } = pg;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  PORT = '3000',
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  TWILIO_MESSAGING_SERVICE_SID,
  PUBLIC_BASE_URL,
  DATABASE_URL,
} = process.env;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  throw new Error('Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID');
}

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}

if (!TWILIO_MESSAGING_SERVICE_SID && !TWILIO_PHONE_NUMBER) {
  throw new Error('Missing TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER');
}

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL');
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function normalizePhone(input) {
  return String(input || '').trim();
}

function dedupeStrings(values) {
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

async function ensureTables() {
  await pool.query(`
    create table if not exists contact_memory (
      phone text primary key,
      profile jsonb not null default '{}'::jsonb,
      preferences jsonb not null default '[]'::jsonb,
      facts jsonb not null default '[]'::jsonb,
      open_loops jsonb not null default '[]'::jsonb,
      notes text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists contact_messages (
      id bigserial primary key,
      phone text not null,
      role text not null,
      text text not null,
      ts timestamptz not null default now()
    );
  `);

  await pool.query(`
    create index if not exists idx_contact_messages_phone_ts
    on contact_messages (phone, ts desc);
  `);

  await pool.query(`
    create table if not exists sms_sessions (
      phone text primary key,
      last_seen_at timestamptz not null default now()
    );
  `);
}

async function getRecentMessages(phone, limit = 24) {
  const result = await pool.query(
    `
      select role, text, ts
      from contact_messages
      where phone = $1
      order by ts desc
      limit $2
    `,
    [phone, limit]
  );

  return result.rows.reverse().map((r) => ({
    role: r.role,
    text: r.text,
    ts: r.ts,
  }));
}

async function getContactMemory(phone) {
  const result = await pool.query(
    `
      select phone, profile, preferences, facts, open_loops, notes, created_at, updated_at
      from contact_memory
      where phone = $1
    `,
    [phone]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    return {
      phone: row.phone,
      profile: row.profile || { name: '', relationship: '', company: '' },
      preferences: row.preferences || [],
      facts: row.facts || [],
      open_loops: row.open_loops || [],
      notes: row.notes || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: await getRecentMessages(phone),
    };
  }

  const fresh = {
    phone,
    profile: { name: '', relationship: '', company: '' },
    preferences: [],
    facts: [],
    open_loops: [],
    notes: '',
  };

  await pool.query(
    `
      insert into contact_memory (phone, profile, preferences, facts, open_loops, notes)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (phone) do nothing
    `,
    [
      fresh.phone,
      fresh.profile,
      fresh.preferences,
      fresh.facts,
      fresh.open_loops,
      fresh.notes,
    ]
  );

  return {
    ...fresh,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

async function saveContactMemory(memory) {
  await pool.query(
    `
      insert into contact_memory
        (phone, profile, preferences, facts, open_loops, notes, updated_at)
      values
        ($1, $2, $3, $4, $5, $6, now())
      on conflict (phone) do update set
        profile = excluded.profile,
        preferences = excluded.preferences,
        facts = excluded.facts,
        open_loops = excluded.open_loops,
        notes = excluded.notes,
        updated_at = now()
    `,
    [
      memory.phone,
      memory.profile,
      memory.preferences,
      memory.facts,
      memory.open_loops,
      memory.notes,
    ]
  );
}

async function appendMessage(phone, role, text) {
  await pool.query(
    `
      insert into contact_messages (phone, role, text)
      values ($1, $2, $3)
    `,
    [phone, role, String(text || '').trim()]
  );

  await pool.query(
    `
      update contact_memory
      set updated_at = now()
      where phone = $1
    `,
    [phone]
  );
}

async function updateLastSeen(phone) {
  await pool.query(
    `
      insert into sms_sessions (phone, last_seen_at)
      values ($1, now())
      on conflict (phone) do update set
        last_seen_at = now()
    `,
    [phone]
  );
}

async function maybeExtractFacts(phone, userText) {
  const memory = await getContactMemory(phone);
  const text = String(userText || '').trim();
  if (!text) return;

  const lower = text.toLowerCase();

  const nameMatch = text.match(/\b(?:my name is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i);
  if (nameMatch && !memory.profile.name) {
    memory.profile.name = nameMatch[1].trim();
  }

  const companyMatch = text.match(/\b(?:i work at|i'm at|i am at|i run|i'm with|i am with)\s+([A-Za-z0-9&.,' -]{2,60})/i);
  if (companyMatch && !memory.profile.company) {
    memory.profile.company = companyMatch[1].trim();
  }

  const likeMatch = text.match(/\b(?:i like|i love|i prefer)\s+(.{1,80})/i);
  if (likeMatch) {
    memory.preferences = dedupeStrings([
      ...memory.preferences,
      likeMatch[1].trim().replace(/[.!?]+$/, ''),
    ]);
  }

  const rememberMatch = text.match(/\bremember(?: that)?\s+(.{1,140})/i);
  if (rememberMatch) {
    memory.facts = dedupeStrings([
      ...memory.facts,
      rememberMatch[1].trim().replace(/[.!?]+$/, ''),
    ]);
  }

  if (
    lower.includes('follow up') ||
    lower.includes('circle back') ||
    lower.includes('remind me')
  ) {
    memory.open_loops = dedupeStrings([
      ...memory.open_loops,
      text.replace(/[.!?]+$/, ''),
    ]);
  }

  await saveContactMemory(memory);
}

async function buildMemoryContext(phone) {
  const memory = await getContactMemory(phone);

  const recentMessages = memory.messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'Contact' : 'Steve'}: ${m.text}`)
    .join('\n');

  return [
    'PRIVATE MEMORY CONTEXT FOR STEVE. DO NOT QUOTE OR MENTION THIS BLOCK DIRECTLY.',
    `Phone: ${phone}`,
    `Name: ${memory.profile.name || 'unknown'}`,
    `Relationship: ${memory.profile.relationship || 'unknown'}`,
    `Company: ${memory.profile.company || 'unknown'}`,
    `Preferences: ${memory.preferences.length ? memory.preferences.join(' | ') : 'none yet'}`,
    `Facts: ${memory.facts.length ? memory.facts.join(' | ') : 'none yet'}`,
    `Open loops: ${memory.open_loops.length ? memory.open_loops.join(' | ') : 'none yet'}`,
    `Notes: ${memory.notes || 'none yet'}`,
    'Recent conversation:',
    recentMessages || 'No recent conversation yet.',
    'End private memory context.',
  ].join('\n');
}

async function getSignedUrl(agentId) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    {
      method: 'GET',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get ElevenLabs signed URL: ${res.status} ${text}`);
  }

  const data = await res.json();

  if (!data.signed_url) {
    throw new Error('ElevenLabs did not return signed_url');
  }

  return data.signed_url;
}

function waitForAgentReply(ws, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for ElevenLabs agent response'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onClose() {
      cleanup();
      reject(new Error('WebSocket closed before agent replied'));
    }

    function onMessage(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        const type = msg.type || msg.event || '';

        if (
          type === 'agent_response' ||
          type === 'agent_response_correction' ||
          type === 'conversation.agent_response' ||
          type === 'response'
        ) {
          const text =
            msg.agent_response_event?.agent_response ||
            msg.agent_response ||
            msg.text ||
            msg.message;

          if (text && String(text).trim()) {
            cleanup();
            resolve(String(text).trim());
          }
        }

        const nestedText =
          msg?.data?.agent_response ||
          msg?.data?.text ||
          msg?.payload?.text;

        if (nestedText && String(nestedText).trim()) {
          cleanup();
          resolve(String(nestedText).trim());
        }
      } catch {
        // ignore non-relevant frames
      }
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

async function askElevenLabsText({ userText, fromNumber }) {
  const signedUrl = await getSignedUrl(ELEVENLABS_AGENT_ID);
  const memoryContext = await buildMemoryContext(fromNumber);
  const prompt = `${memoryContext}\n\nLatest inbound text from the contact:\n${userText}`;

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(signedUrl);

    ws.on('open', async () => {
      try {
        ws.send(
          JSON.stringify({
            type: 'conversation_initiation_client_data',
            conversation_config_override: {
              conversation: {
                text_only: true,
              },
            },
            custom_llm_extra_body: {
              metadata: {
                sms_from: fromNumber,
                memory_enabled: true,
              },
            },
          })
        );

        ws.send(
          JSON.stringify({
            type: 'user_message',
            text: prompt,
          })
        );

        ws.send(JSON.stringify({ type: 'user_message_end' }));

        const reply = await waitForAgentReply(ws);
        ws.close();
        resolve(reply);
      } catch (err) {
        try {
          ws.close();
        } catch {}
        reject(err);
      }
    });

    ws.on('error', reject);
  });
}

function splitSms(text, maxLen = 1400) {
  if (text.length <= maxLen) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let idx = remaining.lastIndexOf(' ', maxLen);
    if (idx < 1) idx = maxLen;
    parts.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

async function sendSms(to, body) {
  const parts = splitSms(body);
  const sent = [];

  for (const part of parts) {
    const payload = {
      to,
      body: part,
      statusCallback: PUBLIC_BASE_URL
        ? `${PUBLIC_BASE_URL}/twilio/status`
        : undefined,
    };

    if (TWILIO_MESSAGING_SERVICE_SID) {
      payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
    } else {
      payload.from = TWILIO_PHONE_NUMBER;
    }

    const msg = await twilioClient.messages.create(payload);
    sent.push(msg.sid);
  }

  return sent;
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.send('AI Steve SMS bridge with Postgres memory is live');
});

app.get('/memory/:phone', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const memory = await getContactMemory(phone);
    res.json(memory);
  } catch (err) {
    console.error('GET memory error:', err);
    res.status(500).json({ error: 'Failed to load memory' });
  }
});

app.post('/memory/:phone', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const memory = await getContactMemory(phone);
    const updates = req.body || {};

    if (typeof updates.notes === 'string') {
      memory.notes = updates.notes.trim();
    }

    if (typeof updates.profile?.name === 'string') {
      memory.profile.name = updates.profile.name.trim();
    }

    if (typeof updates.profile?.relationship === 'string') {
      memory.profile.relationship = updates.profile.relationship.trim();
    }

    if (typeof updates.profile?.company === 'string') {
      memory.profile.company = updates.profile.company.trim();
    }

    if (Array.isArray(updates.preferences)) {
      memory.preferences = dedupeStrings([
        ...memory.preferences,
        ...updates.preferences,
      ]);
    }

    if (Array.isArray(updates.facts)) {
      memory.facts = dedupeStrings([
        ...memory.facts,
        ...updates.facts,
      ]);
    }

    if (Array.isArray(updates.open_loops)) {
      memory.open_loops = dedupeStrings([
        ...memory.open_loops,
        ...updates.open_loops,
      ]);
    }

    await saveContactMemory(memory);
    res.json({ ok: true, memory });
  } catch (err) {
    console.error('POST memory error:', err);
    res.status(500).json({ error: 'Failed to update memory' });
  }
});

app.post('/sms', async (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = String(req.body.Body || '').trim();

  res.type('text/xml').send('<Response></Response>');

  if (!from || !body) return;

  try {
    await updateLastSeen(from);
    await appendMessage(from, 'user', body);
    await maybeExtractFacts(from, body);

    const aiReply = await askElevenLabsText({
      userText: body,
      fromNumber: from,
    });

    if (!aiReply) return;

    await appendMessage(from, 'assistant', aiReply);
    await sendSms(from, aiReply);
  } catch (err) {
    console.error('SMS bridge error:', err);

    await sendSms(
      from,
      'yo… something glitched on my side. send that again in a sec.'
    ).catch((sendErr) => {
      console.error('Fallback SMS failed:', sendErr);
    });
  }
});

app.post('/twilio/status', (req, res) => {
  console.log('Twilio status callback:', req.body);
  res.sendStatus(204);
});

ensureTables()
  .then(() => {
    app.listen(Number(PORT), () => {
      console.log(`AI Steve SMS bridge listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

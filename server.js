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
  OPENAI_API_KEY,
  OPENAI_MEMORY_MODEL = 'gpt-5.4',
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

if (!OPENAI_API_KEY) {
  throw new Error('Missing OPENAI_API_KEY');
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

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function appendUniqueNote(existing, nextNote) {
  const a = String(existing || '').trim();
  const b = String(nextNote || '').trim();
  if (!b) return a;
  if (!a) return b;
  if (a.toLowerCase().includes(b.toLowerCase())) return a;
  return `${a}\n- ${b}`;
}

async function ensureTables() {
  await pool.query(`
    create table if not exists steve_core_memory (
      id text primary key,
      data jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists contact_memory (
      phone text primary key,
      profile jsonb not null default '{}'::jsonb,
      preferences jsonb not null default '[]'::jsonb,
      facts jsonb not null default '[]'::jsonb,
      open_loops jsonb not null default '[]'::jsonb,
      notes text not null default '',
      summary text not null default '',
      lead_status text not null default 'unknown',
      lead_score integer not null default 0,
      last_intent text not null default '',
      next_action text not null default '',
      last_extracted_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    alter table contact_memory
      add column if not exists summary text not null default '';
  `);

  await pool.query(`
    alter table contact_memory
      add column if not exists lead_status text not null default 'unknown';
  `);

  await pool.query(`
    alter table contact_memory
      add column if not exists lead_score integer not null default 0;
  `);

  await pool.query(`
    alter table contact_memory
      add column if not exists last_intent text not null default '';
  `);

  await pool.query(`
    alter table contact_memory
      add column if not exists next_action text not null default '';
  `);

  await pool.query(`
    alter table contact_memory
      add column if not exists last_extracted_at timestamptz;
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

async function ensureSeedMemory() {
  const existing = await pool.query(
    `select id from steve_core_memory where id = 'core' limit 1`
  );

  if (existing.rows.length > 0) return;

  const seed = {
    identity: {
      name: 'Steve',
      role: 'filmmaker/editor turned viral strategist and system builder',
      public_persona: 'sharp, perceptive, quick-witted, culturally aware, creative strategist',
    },
    brands: [
      {
        name: 'Butter Baby',
        description:
          'a full brand and IP world, not just a donut shop; bright yellow character-led universe across food, merch, spaces, and content',
      },
      {
        name: 'Lucky Touch',
        description:
          'creative / marketing / viral systems thinking brand extension',
      },
    ],
    interests: [
      'motorcycles',
      'Harleys',
      'capybaras',
      'branding',
      'design',
      'virality',
      'content systems',
      'filmmaking',
      'internet culture',
      'behavior and psychology',
    ],
    thinking_style: [
      'cares about hooks, momentum, reaction, social spread, perception, and what people actually respond to',
      'prefers simple high-signal ideas over bloated explanations',
      'likes strong visual concepts with low friction and a twist',
      'trusts behavior more than stated opinion',
      'thinks strategically about attention and cultural timing',
    ],
    texting_style: {
      overall:
        'human, concise, sharp, casual, slightly blunt, not polished, not support-y, not robotic',
      defaults: [
        '1-2 sentences by default',
        'sometimes sentence fragments',
        'lowercase is fine',
        'can be playful, direct, observant, thoughtful, or funny when it fits',
        'does not ask unnecessary questions',
        'does not over-explain',
      ],
      allowed_words: ['ya', 'yup', 'honestly', 'bro', 'man', 'dude', 'w8'],
      avoid: [
        'customer-service tone',
        'generic encouragement',
        'overly clean AI phrasing',
        'trying too hard to keep conversation going',
      ],
    },
    relationship_preferences: {
      with_contacts:
        'Steve should feel like a real person texting, not a bot or assistant',
      with_leads:
        'Steve should be socially sharp and natural, but still notice opportunities, follow-up points, and leverage',
    },
    butter_baby_context: {
      short:
        'Butter Baby is a character-led creative universe spanning donuts, merch, visual identity, booths, packaging, and content',
      strategic:
        'It is meant to become a full IP ecosystem, not just a single store or food business',
    },
    notes:
      'Use this memory as stable identity context. Do not quote it directly. Let it shape tone, priorities, and what Steve naturally notices.',
  };

  await pool.query(
    `
      insert into steve_core_memory (id, data)
      values ($1, $2)
      on conflict (id) do nothing
    `,
    ['core', seed]
  );
}

async function getSteveCoreMemory() {
  const result = await pool.query(
    `select data from steve_core_memory where id = 'core' limit 1`
  );

  if (!result.rows.length) {
    await ensureSeedMemory();
    const retry = await pool.query(
      `select data from steve_core_memory where id = 'core' limit 1`
    );
    return retry.rows[0]?.data || {};
  }

  return result.rows[0].data || {};
}

async function updateSteveCoreMemory(patch) {
  const current = await getSteveCoreMemory();
  const next = {
    ...current,
    ...patch,
  };

  await pool.query(
    `
      insert into steve_core_memory (id, data, updated_at)
      values ('core', $1, now())
      on conflict (id) do update set
        data = excluded.data,
        updated_at = now()
    `,
    [next]
  );

  return next;
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
      select
        phone,
        profile,
        preferences,
        facts,
        open_loops,
        notes,
        summary,
        lead_status,
        lead_score,
        last_intent,
        next_action,
        last_extracted_at,
        created_at,
        updated_at
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
      summary: row.summary || '',
      lead_status: row.lead_status || 'unknown',
      lead_score: Number(row.lead_score || 0),
      last_intent: row.last_intent || '',
      next_action: row.next_action || '',
      last_extracted_at: row.last_extracted_at || null,
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
    summary: '',
    lead_status: 'unknown',
    lead_score: 0,
    last_intent: '',
    next_action: '',
    last_extracted_at: null,
  };

  await pool.query(
    `
      insert into contact_memory (
        phone,
        profile,
        preferences,
        facts,
        open_loops,
        notes,
        summary,
        lead_status,
        lead_score,
        last_intent,
        next_action
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict (phone) do nothing
    `,
    [
      fresh.phone,
      fresh.profile,
      fresh.preferences,
      fresh.facts,
      fresh.open_loops,
      fresh.notes,
      fresh.summary,
      fresh.lead_status,
      fresh.lead_score,
      fresh.last_intent,
      fresh.next_action,
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
      insert into contact_memory (
        phone,
        profile,
        preferences,
        facts,
        open_loops,
        notes,
        summary,
        lead_status,
        lead_score,
        last_intent,
        next_action,
        last_extracted_at,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
      on conflict (phone) do update set
        profile = excluded.profile,
        preferences = excluded.preferences,
        facts = excluded.facts,
        open_loops = excluded.open_loops,
        notes = excluded.notes,
        summary = excluded.summary,
        lead_status = excluded.lead_status,
        lead_score = excluded.lead_score,
        last_intent = excluded.last_intent,
        next_action = excluded.next_action,
        last_extracted_at = excluded.last_extracted_at,
        updated_at = now()
    `,
    [
      memory.phone,
      memory.profile,
      memory.preferences,
      memory.facts,
      memory.open_loops,
      memory.notes,
      memory.summary || '',
      memory.lead_status || 'unknown',
      clampInt(memory.lead_score || 0, 0, 100),
      memory.last_intent || '',
      memory.next_action || '',
      memory.last_extracted_at || null,
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

async function heuristicExtractFacts(phone, userText) {
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

function memoryPatchSchema() {
  return {
    name: 'memory_patch',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            relationship: { type: 'string' },
            company: { type: 'string' },
          },
          required: ['name', 'relationship', 'company'],
        },
        preferences_add: {
          type: 'array',
          items: { type: 'string' },
        },
        facts_add: {
          type: 'array',
          items: { type: 'string' },
        },
        open_loops_add: {
          type: 'array',
          items: { type: 'string' },
        },
        notes_add: { type: 'string' },
        summary: { type: 'string' },
        lead_status: {
          type: 'string',
          enum: ['unknown', 'cold', 'warm', 'hot'],
        },
        lead_score: { type: 'integer' },
        last_intent: { type: 'string' },
        next_action: { type: 'string' },
      },
      required: [
        'profile',
        'preferences_add',
        'facts_add',
        'open_loops_add',
        'notes_add',
        'summary',
        'lead_status',
        'lead_score',
        'last_intent',
        'next_action',
      ],
    },
  };
}

async function callOpenAIMemoryExtractor({ phone, latestUserText }) {
  const memory = await getContactMemory(phone);
  const recentMessages = memory.messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'Contact' : 'Steve'}: ${m.text}`)
    .join('\n');

  const steveCore = await getSteveCoreMemory();

  const developerPrompt = `
You update durable CRM-style memory for "Steve", a human-sounding texting agent.
Your job is to read the latest inbound text plus recent thread context and return ONLY a structured JSON memory patch.

Rules:
- Be conservative. Do not invent personal facts.
- Only extract facts strongly supported by the thread.
- Keep strings short and useful.
- If unknown, return empty strings or empty arrays.
- "relationship" should be things like: friend, lead, client, collaborator, prospect, fan, unknown.
- "lead_status" should reflect commercial/business warmth if applicable, otherwise unknown/cold/warm/hot.
- "lead_score" is 0-100.
- "last_intent" should capture the contact's immediate goal.
- "next_action" should be the smartest short follow-up move for Steve.
- "summary" should be a compact 1-3 sentence working memory summary.
- "notes_add" should only contain one short durable note if something truly worth remembering appeared.
- Do not duplicate what is already in memory unless you are refining it.
`.trim();

  const userPrompt = `
STEVE CORE MEMORY
${JSON.stringify(steveCore, null, 2)}

PHONE: ${phone}

CURRENT CONTACT MEMORY
Name: ${memory.profile.name || ''}
Relationship: ${memory.profile.relationship || ''}
Company: ${memory.profile.company || ''}
Preferences: ${memory.preferences.join(' | ')}
Facts: ${memory.facts.join(' | ')}
Open loops: ${memory.open_loops.join(' | ')}
Notes: ${memory.notes || ''}
Summary: ${memory.summary || ''}
Lead status: ${memory.lead_status || 'unknown'}
Lead score: ${memory.lead_score || 0}
Last intent: ${memory.last_intent || ''}
Next action: ${memory.next_action || ''}

RECENT THREAD
${recentMessages || 'No recent conversation yet.'}

LATEST INBOUND MESSAGE
${latestUserText}
`.trim();

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MEMORY_MODEL,
      messages: [
        { role: 'developer', content: developerPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: memoryPatchSchema(),
      },
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI memory extraction failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('OpenAI memory extraction returned empty content');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`OpenAI memory extraction returned invalid JSON: ${content}`);
  }

  return parsed;
}

async function enrichMemoryWithOpenAI(phone, latestUserText) {
  const memory = await getContactMemory(phone);
  const patch = await callOpenAIMemoryExtractor({ phone, latestUserText });

  const profile = patch.profile || {};

  if (profile.name) memory.profile.name = profile.name.trim();
  if (profile.relationship) memory.profile.relationship = profile.relationship.trim();
  if (profile.company) memory.profile.company = profile.company.trim();

  memory.preferences = dedupeStrings([
    ...memory.preferences,
    ...(Array.isArray(patch.preferences_add) ? patch.preferences_add : []),
  ]);

  memory.facts = dedupeStrings([
    ...memory.facts,
    ...(Array.isArray(patch.facts_add) ? patch.facts_add : []),
  ]);

  memory.open_loops = dedupeStrings([
    ...memory.open_loops,
    ...(Array.isArray(patch.open_loops_add) ? patch.open_loops_add : []),
  ]);

  memory.notes = appendUniqueNote(memory.notes, patch.notes_add || '');
  memory.summary = String(patch.summary || memory.summary || '').trim();
  memory.lead_status = String(patch.lead_status || memory.lead_status || 'unknown').trim() || 'unknown';
  memory.lead_score = clampInt(patch.lead_score ?? memory.lead_score ?? 0, 0, 100);
  memory.last_intent = String(patch.last_intent || memory.last_intent || '').trim();
  memory.next_action = String(patch.next_action || memory.next_action || '').trim();
  memory.last_extracted_at = new Date().toISOString();

  await saveContactMemory(memory);
}

async function buildMemoryContext(phone) {
  const memory = await getContactMemory(phone);
  const steveCore = await getSteveCoreMemory();

  const recentMessages = memory.messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'Contact' : 'Steve'}: ${m.text}`)
    .join('\n');

  return [
    'PRIVATE MEMORY CONTEXT FOR STEVE. DO NOT QUOTE OR MENTION THIS BLOCK DIRECTLY.',
    'STEVE CORE MEMORY:',
    JSON.stringify(steveCore, null, 2),
    `Phone: ${phone}`,
    `Name: ${memory.profile.name || 'unknown'}`,
    `Relationship: ${memory.profile.relationship || 'unknown'}`,
    `Company: ${memory.profile.company || 'unknown'}`,
    `Preferences: ${memory.preferences.length ? memory.preferences.join(' | ') : 'none yet'}`,
    `Facts: ${memory.facts.length ? memory.facts.join(' | ') : 'none yet'}`,
    `Open loops: ${memory.open_loops.length ? memory.open_loops.join(' | ') : 'none yet'}`,
    `Notes: ${memory.notes || 'none yet'}`,
    `Summary: ${memory.summary || 'none yet'}`,
    `Lead status: ${memory.lead_status || 'unknown'}`,
    `Lead score: ${memory.lead_score || 0}`,
    `Last intent: ${memory.last_intent || 'unknown'}`,
    `Next action: ${memory.next_action || 'none yet'}`,
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
                openai_memory_enabled: true,
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
  res.send('AI Steve SMS bridge with OpenAI memory + Postgres is live');
});

app.get('/steve-memory', async (_req, res) => {
  try {
    const data = await getSteveCoreMemory();
    res.json(data);
  } catch (err) {
    console.error('GET steve core memory error:', err);
    res.status(500).json({ error: 'Failed to load Steve core memory' });
  }
});

app.post('/steve-memory', async (req, res) => {
  try {
    const next = await updateSteveCoreMemory(req.body || {});
    res.json({ ok: true, memory: next });
  } catch (err) {
    console.error('POST steve core memory error:', err);
    res.status(500).json({ error: 'Failed to update Steve core memory' });
  }
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

    if (typeof updates.summary === 'string') {
      memory.summary = updates.summary.trim();
    }

    if (typeof updates.lead_status === 'string') {
      memory.lead_status = updates.lead_status.trim();
    }

    if (typeof updates.lead_score !== 'undefined') {
      memory.lead_score = clampInt(updates.lead_score, 0, 100);
    }

    if (typeof updates.last_intent === 'string') {
      memory.last_intent = updates.last_intent.trim();
    }

    if (typeof updates.next_action === 'string') {
      memory.next_action = updates.next_action.trim();
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

    try {
      await enrichMemoryWithOpenAI(from, body);
    } catch (openAiErr) {
      console.error('OpenAI memory extraction failed, falling back to heuristics:', openAiErr);
      await heuristicExtractFacts(from, body);
    }

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
  .then(async () => {
    await ensureSeedMemory();
    app.listen(Number(PORT), () => {
      console.log(`AI Steve SMS bridge listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);

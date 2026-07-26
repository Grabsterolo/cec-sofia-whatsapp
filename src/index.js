// Sofía <-> WhatsApp bridge via Zenvia Conversion (formerly Sirena).
// See README.md for the full API discovery notes this file relies on.

const ZENVIA_API_BASE = "https://conversion.zenvia.com/v1";
const WHATSAPP_CHANNEL = "whatsapp";

// CEC group inside Zenvia Conversion ("Centro Europeo de Cirugia").
// Not secret — confirmed live via GET /groups.
const CEC_GROUP_ID = "620bdb7ddc95c70003482762";

// Human agents eligible for escalation transfer (GET /as-user/transfer, live-confirmed).
// Excludes the bot accounts (WhatsApp Bot, FB Messenger Bot, Instagram Bot).
const HUMAN_AGENTS = [
  { id: "65fdf6b1d40c421938223798", name: "Adrian Ureña" },
  { id: "6244ca9a8dcc736594aa3f28", name: "Angie Barboza" },
  { id: "6447ff23812154a143050118", name: "Ingrid Calderón" },
  { id: "620bdb7ddc95c7000348276c", name: "Jordan Murillo" },
];

const MAX_HISTORY_MESSAGES = 20; // ~10 user/assistant turns

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Webhook entrypoint
// ---------------------------------------------------------------------------

async function handleWebhook(request, env) {
  if (env.WEBHOOK_SHARED_SECRET) {
    const providedSecret = new URL(request.url).searchParams.get("secret");
    if (providedSecret !== env.WEBHOOK_SHARED_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const inboundMessages = extractInboundMessages(body);

  // Always ack 200 once the payload parses, even if downstream processing
  // fails — this avoids Zenvia retry storms that could duplicate replies.
  // Failures are logged (visible via `wrangler tail`) but not surfaced to Zenvia.
  for (const inbound of inboundMessages) {
    try {
      await processInboundMessage(inbound, env);
    } catch (err) {
      console.error("Failed to process inbound message", inbound, err);
    }
  }

  return new Response(JSON.stringify({ received: inboundMessages.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Defensively pull out patient-authored WhatsApp messages from a webhook
// payload whose exact envelope shape has NOT been empirically confirmed yet
// (Zenvia does not publish it). Handles: a bare Interaction object, an array
// of Interactions, and {topic, event/action, data: Interaction | Interaction[]}
// envelopes. See README "Forma del payload del webhook" for details.
function extractInboundMessages(body) {
  const candidates = [];
  const rawItems = Array.isArray(body) ? body : [body];

  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const data = item.data ?? item.interaction ?? item;
    const dataItems = Array.isArray(data) ? data : [data];
    for (const interaction of dataItems) {
      const inbound = extractInboundFromInteraction(interaction);
      if (inbound) candidates.push(inbound);
    }
  }

  return candidates;
}

function extractInboundFromInteraction(interaction) {
  if (!interaction || typeof interaction !== "object") return null;

  const message = interaction.output?.message;
  if (!message) return null;

  // "integration" = message came in from the prospect via the channel.
  // "agent"/bot performers are our own outbound traffic — never reply to those.
  if (message.performer !== "integration") return null;
  if (interaction.via && interaction.via !== "whatsApp") return null;

  const text = (message.content || message.body || "").trim();
  const phone = message.sender;
  const prospectId = interaction.prospectId;
  if (!text || !phone || !prospectId) return null;

  return { text, phone, prospectId, interactionId: interaction.id };
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

async function processInboundMessage({ text, phone, prospectId }, env) {
  const phoneHash = await sha256Hex(phone);

  const session = await getOrCreateSession(env, phoneHash);
  const history = [...session.messages, { role: "user", content: text }].slice(
    -MAX_HISTORY_MESSAGES
  );

  const { system, knowledge_base } = await loadSofiaConfig(env);
  const chunks = await ragSearch(env, history);
  const systemBlocks = buildSystemBlocks(system, knowledge_base, chunks);

  const claudeData = await callClaude(env, systemBlocks, history);
  const rawText = claudeData?.content?.[0]?.text ?? "";
  const { reply, escalated, escalation_reason } = parseEscalation(rawText);

  const updatedHistory = [...history, { role: "assistant", content: reply }].slice(
    -MAX_HISTORY_MESSAGES
  );
  await saveSession(env, phoneHash, updatedHistory);

  if (escalated) {
    const agent = await pickAgentForEscalation(env);
    await transferProspectToAgent(env, prospectId, agent.id);
  } else {
    await sendWhatsappMessage(env, prospectId, reply);
  }

  await upsertConversation(env, {
    phoneHash,
    lastMessage: reply,
    escalated,
    escalationReason: escalation_reason,
  });
}

function parseEscalation(rawText) {
  const escalationMatch = rawText.match(/\[ESCALAR:?\s*([^\]]*)\]/i);
  const escalated = !!escalationMatch;
  const escalation_reason = escalated ? escalationMatch[1].trim() || null : null;
  const reply = rawText.replace(/\s*\[ESCALAR:?\s*([^\]]*)\]\s*/i, " ").trim();
  return { reply, escalated, escalation_reason };
}

// ---------------------------------------------------------------------------
// RAG + Claude (mirrors functions/api/chat.js in cecmarketing)
// ---------------------------------------------------------------------------

async function loadSofiaConfig(env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/sofia_config?select=system_prompt,knowledge_base&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return { system: "", knowledge_base: "" };
  const data = await res.json();
  return {
    system: data[0]?.system_prompt || "",
    knowledge_base: data[0]?.knowledge_base || "",
  };
}

async function ragSearch(env, history) {
  const searchQuery = history
    .filter((m) => m.role === "user")
    .slice(-2)
    .map((m) => m.content)
    .join(" ");

  try {
    const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: searchQuery,
      }),
    });
    if (!embedRes.ok) return [];
    const embedData = await embedRes.json();
    const queryEmbedding = embedData.data[0].embedding;

    const ragRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_sofia_chunks`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_count: 6,
        match_threshold: 0.5,
      }),
    });
    if (!ragRes.ok) return [];
    return await ragRes.json();
  } catch {
    // RAG falla silenciosamente — Sofía responde igual sin chunks
    return [];
  }
}

function buildSystemBlocks(system, knowledge_base, chunks) {
  const systemBlocks = [
    {
      type: "text",
      text: system,
      cache_control: { type: "ephemeral" },
    },
  ];

  if (chunks.length > 0) {
    systemBlocks.push({
      type: "text",
      text:
        "BASE DE CONOCIMIENTO RELEVANTE PARA ESTA CONSULTA:\n\n" +
        chunks.map((c) => c.content).join("\n\n---\n\n"),
    });
  } else if (knowledge_base) {
    systemBlocks.push({
      type: "text",
      text:
        "INFORMACIÓN COMPLETA DEL CEC (usa solo lo relevante para la pregunta del paciente):\n\n" +
        knowledge_base,
      cache_control: { type: "ephemeral" },
    });
  }

  return systemBlocks;
}

async function callClaude(env, systemBlocks, history) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Promo pricing through 2026-08-31 — re-evaluate the model choice after that.
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: systemBlocks,
      messages: history,
    }),
  });
  return response.json();
}

// ---------------------------------------------------------------------------
// Supabase session + conversation persistence
// ---------------------------------------------------------------------------

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getOrCreateSession(env, phoneHash) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/sofia_whatsapp_sessions?phone_hash=eq.${phoneHash}&select=messages&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return { messages: [] };
  const rows = await res.json();
  return { messages: rows[0]?.messages ?? [] };
}

async function saveSession(env, phoneHash, messages) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/sofia_whatsapp_sessions?on_conflict=phone_hash`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ phone_hash: phoneHash, messages, channel: "whatsapp" }),
  });
}

// sofia_conversations has no unique constraint on phone_hash (only on `id`),
// so this does a manual read-then-write instead of a PostgREST upsert.
async function upsertConversation(env, { phoneHash, lastMessage, escalated, escalationReason }) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  const existingRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/sofia_conversations?phone_hash=eq.${phoneHash}&select=id,message_count&limit=1`,
    { headers }
  );
  const existing = existingRes.ok ? await existingRes.json() : [];

  if (existing[0]) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/sofia_conversations?id=eq.${existing[0].id}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        last_message: lastMessage,
        escalated,
        escalation_reason: escalationReason,
        message_count: (existing[0].message_count ?? 0) + 1,
      }),
    });
  } else {
    await fetch(`${env.SUPABASE_URL}/rest/v1/sofia_conversations`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        phone_hash: phoneHash,
        channel: "whatsapp",
        last_message: lastMessage,
        escalated,
        escalation_reason: escalationReason,
        message_count: 1,
      }),
    });
  }
}

// ---------------------------------------------------------------------------
// Zenvia Conversion API calls
// ---------------------------------------------------------------------------

async function sendWhatsappMessage(env, prospectId, content) {
  const res = await fetch(
    `${ZENVIA_API_BASE}/prospect/${prospectId}/messaging/${WHATSAPP_CHANNEL}?api-key=${env.ZENVIA_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
  if (!res.ok) {
    console.error("sendWhatsappMessage failed", res.status, await res.text());
  }
  return res;
}

async function transferProspectToAgent(env, prospectId, agentId) {
  const res = await fetch(
    `${ZENVIA_API_BASE}/prospect/${prospectId}/as-user/transfer?api-key=${env.ZENVIA_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: agentId }),
    }
  );
  if (!res.ok) {
    console.error("transferProspectToAgent failed", res.status, await res.text());
  }
  return res;
}

// TODO: this is a simple "prefer online, else pseudo-random" picker. It has
// no memory across requests (Workers are stateless per-request), so it can't
// do a true round robin without a persistent counter (e.g. Workers KV or a
// Supabase counter). Consider adding one if load ever justifies it — for now
// "prefer whoever is online" is a reasonable proxy for availability.
async function pickAgentForEscalation(env) {
  try {
    const res = await fetch(
      `${ZENVIA_API_BASE}/group/${CEC_GROUP_ID}/agents/online?api-key=${env.ZENVIA_API_KEY}`
    );
    if (res.ok) {
      const data = await res.json();
      const onlineIds = new Set((data.agents || []).map((a) => a.id));
      const onlineHumans = HUMAN_AGENTS.filter((a) => onlineIds.has(a.id));
      if (onlineHumans.length > 0) {
        return onlineHumans[Math.floor(Math.random() * onlineHumans.length)];
      }
    }
  } catch (err) {
    console.error("pickAgentForEscalation: online lookup failed", err);
  }
  // Nobody confirmed online (or the lookup failed) — fall back to a
  // pseudo-random pick among all human agents so the interaction is never
  // left unassigned.
  return HUMAN_AGENTS[Math.floor(Math.random() * HUMAN_AGENTS.length)];
}

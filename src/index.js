// Sofía <-> WhatsApp bridge via Zenvia Conversion (formerly Sirena).
// See README.md for the full API discovery notes this file relies on.

const ZENVIA_API_BASE = "https://conversion.zenvia.com/v1";
const WHATSAPP_CHANNEL = "whatsapp";

// CEC group inside Zenvia Conversion ("Centro Europeo de Cirugia").
// Not secret — confirmed live via GET /groups.
const CEC_GROUP_ID = "620bdb7ddc95c70003482762";

// Sofía's own agent ID in Zenvia ("Sofia CEC" — the "Actuar como" identity
// the integration acts as, no longer "WhatsApp Bot"). Used to claim a
// conversation out of the "Sin asignar" pool the moment Sofía picks it up.
const SOFIA_AGENT_ID = "6a65946e85b682f18c9d3dd7";

// Human agents eligible for escalation transfer (GET /as-user/transfer, live-confirmed).
// Excludes Sofía's own agent identity and other bot accounts (FB Messenger Bot, Instagram Bot).
const HUMAN_AGENTS = [
  { id: "65fdf6b1d40c421938223798", name: "Adrian Ureña" },
  { id: "6244ca9a8dcc736594aa3f28", name: "Angie Barboza" },
  { id: "6447ff23812154a143050118", name: "Ingrid Calderón" },
  { id: "620bdb7ddc95c7000348276c", name: "Jordan Murillo" },
];
const HUMAN_AGENT_IDS = new Set(HUMAN_AGENTS.map((a) => a.id));

const MAX_HISTORY_MESSAGES = 20; // ~10 user/assistant turns
const MAX_CONVERSATION_TURNS = 10; // sofia_conversations.message_count ceiling before forcing escalation

const MESSAGE_LIMIT_REPLY =
  "Ya llevamos varios mensajes conversando — le voy a pasar con nuestro equipo para que le ayuden mejor con esto.";

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

  const agentId = interaction.agentId ?? interaction.agent?.id ?? null;

  return { text, phone, prospectId, interactionId: interaction.id, agentId };
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

async function processInboundMessage({ text, phone, prospectId, agentId }, env) {
  // Emergency kill switch: sofia_config.whatsapp_enabled, toggled from the
  // dashboard. Checked before anything else — no reply, no claim, no
  // sofia_conversations update — so it's an immediate global pause.
  const sofiaConfig = await loadSofiaConfig(env);
  if (!sofiaConfig.whatsapp_enabled) {
    console.log(`Skipping inbound message: Sofía WhatsApp is paused (whatsapp_enabled=false), prospect ${prospectId}`);
    return;
  }

  // A human already has this conversation (Adrian, Angie, Ingrid, or
  // Jordan) — don't touch it at all: no reply, no claim, no
  // sofia_conversations update. Only proceed when the interaction is
  // unassigned (null) or already assigned to Sofía herself.
  if (agentId && HUMAN_AGENT_IDS.has(agentId)) {
    console.log(
      `Skipping inbound message: prospect ${prospectId} is already assigned to a human agent (${agentId})`
    );
    return;
  }

  // Claim the conversation as Sofía right away so it leaves the shared "Sin
  // asignar" pool while she's handling it, instead of sitting there mixed
  // in with conversations that actually need a human. Skip the call
  // entirely when the interaction is already assigned to Sofía (the common
  // case after the first message in a conversation) to avoid an
  // unnecessary transfer on every turn. Kicked off here and awaited later
  // so it runs alongside the RAG + Claude calls instead of blocking them.
  const claimPromise =
    agentId !== SOFIA_AGENT_ID
      ? transferProspectToAgent(env, prospectId, SOFIA_AGENT_ID)
      : Promise.resolve();

  const phoneHash = await sha256Hex(phone);

  const session = await getOrCreateSession(env, phoneHash);
  const history = [...session.messages, { role: "user", content: text }].slice(
    -MAX_HISTORY_MESSAGES
  );

  const messageCount = await getConversationMessageCount(env, phoneHash);
  if (messageCount >= MAX_CONVERSATION_TURNS) {
    await claimPromise;
    await sendWhatsappMessage(env, prospectId, MESSAGE_LIMIT_REPLY);
    await transferProspectToGroup(env, prospectId, CEC_GROUP_ID);

    const updatedHistory = [...history, { role: "assistant", content: MESSAGE_LIMIT_REPLY }].slice(
      -MAX_HISTORY_MESSAGES
    );
    await saveSession(env, phoneHash, updatedHistory);
    await upsertConversation(env, {
      phoneHash,
      lastMessage: MESSAGE_LIMIT_REPLY,
      escalated: true,
      escalationReason: "límite de mensajes alcanzado",
    });
    return;
  }

  const { system, knowledge_base } = sofiaConfig;
  const chunks = await ragSearch(env, history);
  const systemBlocks = buildSystemBlocks(system, knowledge_base, chunks);

  const claudeData = await callClaude(env, systemBlocks, history);

  // Make sure the claim call (kicked off above) has actually finished before
  // this invocation ends — Workers don't guarantee in-flight fetches
  // complete once the handler returns without an explicit await.
  await claimPromise;

  // claude-sonnet-5 returns extended thinking by default, so content[0] is
  // often a {type: "thinking"} block rather than the reply — find the text
  // block explicitly instead of assuming it's first.
  const textBlock = (claudeData?.content || []).find((b) => b.type === "text");
  const rawText = textBlock?.text ?? "";
  const { reply, escalated, escalation_reason } = parseEscalation(rawText);

  const updatedHistory = [...history, { role: "assistant", content: reply }].slice(
    -MAX_HISTORY_MESSAGES
  );
  await saveSession(env, phoneHash, updatedHistory);

  if (escalated) {
    // Give the human agent context before they open the chat cold.
    await addEscalationNote(env, prospectId, escalation_reason, updatedHistory.slice(-2));

    // Sofía already wrote a transition line before the [ESCALAR] tag (e.g.
    // "nuestro equipo de asesores le va a estar contactando") — send it
    // before handing off, so the patient isn't left hanging. Skip only if
    // there's truly nothing to send (Sofía wrote nothing before the tag).
    if (reply) {
      await sendWhatsappMessage(env, prospectId, reply);
    }
    await transferProspectToGroup(env, prospectId, CEC_GROUP_ID);
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
    `${env.SUPABASE_URL}/rest/v1/sofia_config?select=system_prompt,knowledge_base,whatsapp_enabled&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return { system: "", knowledge_base: "", whatsapp_enabled: true };
  const data = await res.json();
  return {
    system: data[0]?.system_prompt || "",
    knowledge_base: data[0]?.knowledge_base || "",
    whatsapp_enabled: data[0]?.whatsapp_enabled ?? true,
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

  // No cache_control on this one, and it must stay last: it changes on every
  // request, so putting it before a cached block would invalidate the cache
  // prefix on every single message. system_prompt has a greeting rule that
  // depends on knowing the current hour in Costa Rica — without this block
  // Claude has no way to know it and defaults incorrectly (e.g. "buenas
  // tardes" at night).
  systemBlocks.push({
    type: "text",
    text: `Fecha y hora actual en Costa Rica: ${formatCostaRicaDateTime()}.`,
  });

  return systemBlocks;
}

// Costa Rica is UTC-6 year-round (no DST), so a fixed offset is exact —
// same approach cecmarketing/functions/api/chat.js uses for its hour-of-day
// greeting context.
function formatCostaRicaDateTime(date = new Date()) {
  const crDate = new Date(date.getTime() - 6 * 60 * 60 * 1000);
  const weekdays = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const months = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];

  const weekday = weekdays[crDate.getUTCDay()];
  const day = crDate.getUTCDate();
  const month = months[crDate.getUTCMonth()];
  const year = crDate.getUTCFullYear();
  const hour24 = crDate.getUTCHours();
  const minute = String(crDate.getUTCMinutes()).padStart(2, "0");
  const period = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 || 12;

  return `${weekday} ${day} de ${month} de ${year}, ${hour12}:${minute}${period}`;
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
      // claude-sonnet-5 runs adaptive thinking by default, which put the
      // reply text in content[1] instead of content[0] (see callers of
      // this function). Disabling it keeps content[0] a plain text block.
      thinking: { type: "disabled" },
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

async function getConversationMessageCount(env, phoneHash) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/sofia_conversations?phone_hash=eq.${phoneHash}&select=message_count&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return 0;
  const rows = await res.json();
  return rows[0]?.message_count ?? 0;
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

// Attaches a "note"-type interaction to the prospect (POST
// /prospect/{id}/interactions, live-confirmed — see README 1.5b) so the
// human agent has context before opening the chat. Non-fatal on failure:
// missing internal context is worse than blocking the handoff.
async function addEscalationNote(env, prospectId, escalationReason, recentMessages) {
  const transcript = recentMessages
    .map((m) => `${m.role === "user" ? "Paciente" : "Sofía"}: ${m.content}`)
    .join("\n");
  const content =
    `Escalado por Sofía CEC. Motivo: ${escalationReason || "no especificado"}\n\n` +
    transcript;

  const res = await fetch(
    `${ZENVIA_API_BASE}/prospect/${prospectId}/interactions?api-key=${env.ZENVIA_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "note", content }),
    }
  );
  if (!res.ok) {
    console.error("addEscalationNote failed", res.status, await res.text());
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

// Escalation goes to the group, not a specific agent — whoever's available
// on the team picks it up. scope: prospects:read (live-confirmed against
// the real swagger.json — see README 1.5).
async function transferProspectToGroup(env, prospectId, groupId) {
  const res = await fetch(
    `${ZENVIA_API_BASE}/prospect/${prospectId}/transfer?api-key=${env.ZENVIA_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupId }),
    }
  );
  if (!res.ok) {
    console.error("transferProspectToGroup failed", res.status, await res.text());
  }
  return res;
}

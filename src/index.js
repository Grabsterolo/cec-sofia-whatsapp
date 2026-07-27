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

const MESSAGE_LIMIT_REPLIES = [
  "Quiero asegurarme de que le den la mejor ayuda posible con esto, así que la voy a poner en contacto con nuestro equipo — en breve le escriben.",
  "Para que le puedan dar seguimiento como se merece, la voy a poner en contacto con nuestro equipo — en un momentito le contactan.",
  "Con gusto la conecto con nuestro equipo para que le ayuden mejor con esto — en breve le escriben.",
];

function pickMessageLimitReply() {
  return MESSAGE_LIMIT_REPLIES[Math.floor(Math.random() * MESSAGE_LIMIT_REPLIES.length)];
}

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

async function processInboundMessage({ text, phone, prospectId, agentId, interactionId }, env) {
  // Emergency kill switch: sofia_config.whatsapp_enabled, toggled from the
  // dashboard. Checked before anything else — no reply, no claim, no
  // sofia_conversations update — so it's an immediate global pause.
  const sofiaConfig = await loadSofiaConfig(env);
  if (!sofiaConfig.whatsapp_enabled) {
    console.log(`Skipping inbound message: Sofía WhatsApp is paused (whatsapp_enabled=false), prospect ${prospectId}`);
    return;
  }

  // A human already has this conversation (Adrian, Angie, Ingrid, or
  // Jordan) — don't touch it at all, on ANY message, unconditionally. This
  // used to be gated behind an "is this a new conversation" check based on
  // Interaction.id, which turned out to be wrong: Zenvia issues a new
  // Interaction.id per individual message, not per conversation thread
  // (confirmed live — see README 1.7), so that gate skipped this check on
  // almost every message and let Sofía reclaim conversations a human
  // already owned. agentId on the inbound payload reflects who currently
  // owns the prospect right now — that's the only signal we trust.
  if (agentId && HUMAN_AGENT_IDS.has(agentId)) {
    console.log(
      `Skipping inbound message: prospect ${prospectId} is already assigned to a human agent (${agentId})`
    );
    return;
  }

  const phoneHash = await sha256Hex(phone);
  const conversationState = await getConversationState(env, phoneHash);

  // Hard stop once this conversation has been escalated — by Sofía's own
  // [ESCALAR] decision or by hitting the message limit below — UNLESS
  // Zenvia's own prospect.status says the conversation was genuinely wrapped
  // up ("archived" — Zenvia's real API value; live-confirmed via GET
  // /prospects, see README 1.9 correction. The help-center concept "Closed"
  // does NOT literally appear as "closed" in the API). status is a
  // trustworthy signal (only changes when someone actually closes the
  // conversation) unlike Interaction.id, which is fresh on every single
  // message (see README 1.7/1.8). On any other status (new, unclaimed,
  // followUp) — or if the status lookup itself fails — stay silent, same as
  // before: silence-by-default over risking another Sofía-overrides-a-human
  // incident.
  let resetCounters = false;
  if (conversationState.escalated) {
    const prospectStatus = await getProspectStatus(env, prospectId);
    if (prospectStatus !== "archived") {
      console.log(
        `Skipping inbound message: conversation for prospect ${prospectId} is already escalated (Zenvia status=${prospectStatus})`
      );
      return;
    }
    console.log(`Conversation for prospect ${prospectId} was archived in Zenvia — resuming Sofía.`);
    conversationState.escalated = false;
    conversationState.messageCount = 0;
    resetCounters = true;
  }

  // Claim the conversation as Sofía right away so it leaves the shared "Sin
  // asignar" pool while she's handling it, instead of sitting there mixed
  // in with conversations that actually need a human. Skip the call
  // entirely when the interaction is already assigned to Sofía (the common
  // case after the first message in a conversation) to avoid an
  // unnecessary transfer on every turn. Kicked off here and awaited later
  // so it runs alongside the RAG + Claude calls instead of blocking them.
  // Only reached when we're actually going to process the message — both
  // gates above return before this point when they trigger.
  const claimPromise =
    agentId !== SOFIA_AGENT_ID
      ? transferProspectToAgent(env, prospectId, SOFIA_AGENT_ID)
      : Promise.resolve();

  const session = await getOrCreateSession(env, phoneHash);
  const history = [...session.messages, { role: "user", content: text }].slice(
    -MAX_HISTORY_MESSAGES
  );

  if (conversationState.messageCount >= MAX_CONVERSATION_TURNS) {
    const limitReasonText = "límite de mensajes alcanzado";
    const limitReply = pickMessageLimitReply();
    await claimPromise;
    await sendWhatsappMessage(env, prospectId, limitReply);
    const limitAgility = await runEscalationAgility(env, {
      prospectId,
      history,
      escalationReason: limitReasonText,
    });
    await transferProspectToGroup(env, prospectId, CEC_GROUP_ID);

    const updatedHistory = [...history, { role: "assistant", content: limitReply }].slice(
      -MAX_HISTORY_MESSAGES
    );
    await saveSession(env, phoneHash, updatedHistory);
    await upsertConversation(env, {
      phoneHash,
      lastMessage: limitReply,
      escalated: true,
      escalationReason: limitReasonText,
      interactionId,
      resetCounters,
      procedureInterest: limitAgility.procedureInterest,
      sentiment: limitAgility.sentiment,
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

  let agility = { procedureInterest: null, sentiment: null };

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
    agility = await runEscalationAgility(env, {
      prospectId,
      history: updatedHistory,
      escalationReason: escalation_reason,
    });
    await transferProspectToGroup(env, prospectId, CEC_GROUP_ID);
  } else {
    await sendWhatsappMessage(env, prospectId, reply);
  }

  await upsertConversation(env, {
    phoneHash,
    lastMessage: reply,
    escalated,
    escalationReason: escalation_reason,
    interactionId,
    resetCounters,
    procedureInterest: agility.procedureInterest,
    sentiment: agility.sentiment,
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

async function getConversationState(env, phoneHash) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/sofia_conversations?phone_hash=eq.${phoneHash}&select=message_count,escalated,last_interaction_id&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return { messageCount: 0, escalated: false, lastInteractionId: null };
  const rows = await res.json();
  return {
    messageCount: rows[0]?.message_count ?? 0,
    escalated: rows[0]?.escalated ?? false,
    lastInteractionId: rows[0]?.last_interaction_id ?? null,
  };
}

// sofia_conversations has no unique constraint on phone_hash (only on `id`),
// so this does a manual read-then-write instead of a PostgREST upsert.
// message_count accumulates from the stored value, unless resetCounters is
// set (Zenvia's prospect.status confirmed "archived" for a previously
// escalated conversation — see processInboundMessage) — then it starts
// fresh from 0, same as a genuinely new conversation.
async function upsertConversation(env, {
  phoneHash,
  lastMessage,
  escalated,
  escalationReason,
  interactionId,
  resetCounters,
  procedureInterest,
  sentiment,
}) {
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
  const baselineMessageCount = resetCounters ? 0 : existing[0]?.message_count ?? 0;

  if (existing[0]) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/sofia_conversations?id=eq.${existing[0].id}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        last_message: lastMessage,
        escalated,
        escalation_reason: escalationReason,
        message_count: baselineMessageCount + 1,
        last_interaction_id: interactionId,
        procedure_interest: procedureInterest ?? null,
        sentiment: sentiment ?? null,
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
        last_interaction_id: interactionId,
        procedure_interest: procedureInterest ?? null,
        sentiment: sentiment ?? null,
      }),
    });
  }
}

// ---------------------------------------------------------------------------
// Zenvia Conversion API calls
// ---------------------------------------------------------------------------

// Zenvia's prospect.status has 4 real values live-confirmed via GET
// /prospects (README 1.9 correction): "new", "unclaimed", "followUp",
// "archived" — unlike Interaction.id (fresh per message, not per thread, see
// README 1.7/1.8), status only changes when the conversation is genuinely
// wrapped up ("archived"). Used to decide whether a previously-escalated
// conversation can safely resume with Sofía. Returns null on any failure —
// callers must treat that as "not archived" (stay silent), never as
// "archived".
async function getProspectStatus(env, prospectId) {
  try {
    const res = await fetch(`${ZENVIA_API_BASE}/prospect/${prospectId}?api-key=${env.ZENVIA_API_KEY}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.status ?? null;
  } catch {
    return null;
  }
}

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

// ---------------------------------------------------------------------------
// Escalation agility: label + classify + notify (all best-effort — see
// runEscalationAgility, none of this may block or delay transferring the
// conversation to the group).
// ---------------------------------------------------------------------------

async function getAvailableLabels(env) {
  try {
    const res = await fetch(`${ZENVIA_API_BASE}/as-user/labels?api-key=${env.ZENVIA_API_KEY}`);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error("getAvailableLabels failed", err);
    return [];
  }
}

// Cheap classification pass with Haiku (not Sonnet — this is a simple
// tagging task, not a conversational one) so a human agent gets a running
// start: which label fits, what the patient actually wants, and how they
// seem to be feeling. Never throws — always returns a usable (possibly
// all-null) result.
async function classifyEscalationWithHaiku(env, history, availableLabels) {
  try {
    const labelsContext = availableLabels.map((l) => `${l.key}: ${l.name}`).join("\n");
    const transcript = history
      .map((m) => `${m.role === "user" ? "Paciente" : "Sofía"}: ${m.content}`)
      .join("\n");

    // The patient's very first message is the strongest signal for the real
    // originating interest — it's often what they actually asked for or
    // clicked through from (a Meta/Facebook/Instagram ad reply sometimes
    // carries that context, e.g. "Source: Meta - ID:..."). Called out
    // separately so it doesn't get diluted by later turns where Sofía may
    // have listed several unrelated procedures as options.
    const firstPatientMessage = history.find((m) => m.role === "user")?.content || null;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        system:
          "Eres un clasificador de conversaciones de WhatsApp para una clínica de cirugía plástica. " +
          "Responde ÚNICAMENTE con un objeto JSON válido (sin texto adicional, sin markdown), con " +
          'exactamente estas claves: "label" (el key EXACTO de una de las etiquetas provistas que mejor ' +
          'describa el interés del paciente, o null si ninguna calza bien — nunca inventes un key que no ' +
          'esté en la lista), "procedure_interest" (resumen muy corto, 2-4 palabras, del procedimiento o ' +
          'tema de interés del paciente, ej. "rinoplastia", "precio botox"), "sentiment" ("positivo", ' +
          '"neutral" o "negativo", según el tono general del paciente en la conversación).\n\n' +
          "REGLA DE PRIORIZACIÓN — muy importante: prioriza siempre el procedimiento que el PACIENTE " +
          "pidió o por el que preguntó originalmente (mira primero su primer mensaje y cualquier " +
          "contexto de origen del lead, como un anuncio de Meta/Facebook/Instagram, si aparece ahí). " +
          "NO uses un procedimiento solo porque Sofía lo haya mencionado como una de varias opciones " +
          "durante la conversación — Sofía frecuentemente ofrece 2 o 3 alternativas, y elegir una al " +
          "azar entre esas produce clasificaciones incorrectas. Si Sofía ofreció varias opciones y el " +
          "paciente no confirmó claramente cuál le interesa, es preferible responder con una etiqueta " +
          "más general (o \"label\": null) que adivinar cuál de las opciones eligió.",
        messages: [
          {
            role: "user",
            content:
              `Etiquetas disponibles (usa el key exacto, columna izquierda):\n${labelsContext}\n\n` +
              (firstPatientMessage
                ? `Primer mensaje del paciente en esta conversación (la señal más confiable de su interés de origen):\n${firstPatientMessage}\n\n`
                : "") +
              `Conversación completa:\n${transcript}`,
          },
        ],
      }),
    });
    const data = await response.json();
    const textBlock = (data?.content || []).find((b) => b.type === "text");
    // Haiku sometimes wraps the JSON in a ```json ... ``` fence despite the
    // system prompt asking it not to — strip that before parsing.
    const cleanedText = (textBlock?.text ?? "{}").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleanedText);

    const label = availableLabels.some((l) => l.key === parsed.label) ? parsed.label : null;
    return {
      label,
      procedureInterest: parsed.procedure_interest || null,
      sentiment: parsed.sentiment || null,
    };
  } catch (err) {
    console.error("classifyEscalationWithHaiku failed", err);
    return { label: null, procedureInterest: null, sentiment: null };
  }
}

async function addLabelToProspect(env, prospectId, label) {
  try {
    const res = await fetch(
      `${ZENVIA_API_BASE}/prospect/${prospectId}/as-user/label?api-key=${env.ZENVIA_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      }
    );
    if (!res.ok) {
      console.error("addLabelToProspect failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("addLabelToProspect threw", err);
  }
}

// ⚠️ As of 2026-07-26, this call reliably fails with 400 "This app does not
// have the permissions to send notifications" — the CEC integration isn't
// registered as a Custom App with push-notification permission in Zenvia
// (separate from the "notifications" API-key scope used for webhook
// subscriptions, despite the confusingly identical name). Left in, since
// it's best-effort and harmless when it fails, and it'll start working the
// moment that permission is granted from the Zenvia side — see README 1.5d.
async function sendEscalationNotification(env, escalationReason) {
  try {
    const title = "Sofía escaló una conversación";
    const body = escalationReason || "Revisar conversación de WhatsApp";
    const platformPayload = { title, body };
    const res = await fetch(`${ZENVIA_API_BASE}/apps/notifications?api-key=${env.ZENVIA_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "sofia_escalation",
        target: { role: ["agent"] },
        platforms: { android: platformPayload, ios: platformPayload, desktop: platformPayload },
      }),
    });
    if (!res.ok) {
      console.error("sendEscalationNotification failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("sendEscalationNotification threw", err);
  }
}

// Orchestrates the whole "agility for advisors" step at escalation time:
// label the prospect, classify interest/sentiment, push a notification.
// Deliberately never throws and never blocks the caller for long on a
// single failing step — the main flow (reply to patient, transfer to
// group) must never depend on any of this working.
async function runEscalationAgility(env, { prospectId, history, escalationReason }) {
  try {
    const labels = await getAvailableLabels(env);
    const classification = await classifyEscalationWithHaiku(env, history, labels);
    if (classification.label) {
      await addLabelToProspect(env, prospectId, classification.label);
    }
    await sendEscalationNotification(env, escalationReason);
    return classification;
  } catch (err) {
    console.error("runEscalationAgility failed", err);
    return { label: null, procedureInterest: null, sentiment: null };
  }
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

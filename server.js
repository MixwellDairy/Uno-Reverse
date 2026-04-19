const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const cors = require("cors");
const bodyParser = require("body-parser");

// -------------------------
// Config
// -------------------------
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11435);
const PANEL_PORT = Number(process.env.PANEL_PORT || 6741);
const TIMEOUT_SECONDS = Number(process.env.UNO_REVERSE_TIMEOUT_SECONDS || 300);

// -------------------------
// State
// -------------------------
const pending = new Map();
let idCounter = 0;

// -------------------------
// Helpers
// -------------------------
function makeId() {
  idCounter += 1;
  return `${Date.now()}_${idCounter}`;
}

function nowIso() {
  return new Date().toISOString();
}

function safeString(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractPromptFromBody(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.prompt === "string" && body.prompt.trim()) return body.prompt;

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (!m || m.role !== "user") continue;
      if (typeof m.content === "string" && m.content.trim()) {
        return m.content;
      }
      const text = extractMessageText(m.content);
      if (text) return text;
    }
  }
  return "";
}

function extractAttachmentsFromBody(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return [];
  const attachments = [];
  for (const msg of body.messages) {
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = safeString(part.type || "attachment");
      if (type === "text") continue;
      const name = safeString(part.name || part.filename || part.title || type).slice(0, 200) || "attachment";
      attachments.push({ type, name });
    }
  }
  return attachments.slice(0, 20);
}

function parseChatContextFromPrompt(prompt) {
  const text = safeString(prompt);
  const section = /###\s*Chat History:\s*([\s\S]*)$/i.exec(text);
  if (!section) return "";
  return section[1].trim().slice(0, 4000);
}

function parseChatContextFromMessages(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return "";
  const lines = [];
  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = safeString(msg.role || "message").toLowerCase();
    if (role === "system") continue;
    const text = safeString(extractMessageText(msg.content)).trim();
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }
  if (!lines.length) return "";
  return lines.slice(-10).join("\n").slice(0, 4000);
}

function getMessageEntries(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return [];
  return body.messages
    .map((m) => ({
      role: safeString(m && m.role).toLowerCase(),
      text: extractMessageText(m && m.content)
    }))
    .map(({ role, text }) => ({ role, text: safeString(text).trim() }))
    .filter((entry) => Boolean(entry.text));
}

const SYSTEM_PROMPT_WRAPPERS = [
  {
    type: "title",
    label: "📝 Chat title request",
    editor: "markdown",
    instruction: "Set a concise 3-5 word title (emoji optional).",
    match: (text) => {
      const lower = text.toLowerCase();
      return (
        /@generate_chat_title\.json/.test(lower) ||
        /generate\s+(a\s+)?concise[\s\S]{0,100}title[\s\S]{0,100}emoji/i.test(text) ||
        /json\s+format[\s\S]{0,80}\{\s*"title"\s*:/i.test(text) ||
        (/chat\s+history/i.test(text) && /return\s+.*json/i.test(text) && /"title"\s*:/.test(text))
      );
    },
    buildPayload: (body, promptText) => {
      const context = parseChatContextFromPrompt(promptText) || parseChatContextFromMessages(body);
      return {
        context,
        attachments: extractAttachmentsFromBody(body),
        suggested_value: suggestTitle(context || promptText),
        response_schema: { title: "string" }
      };
    },
    normalizeReply: (content, payload) => normalizeTitleReply(content, payload?.suggested_value || "💬 Chat Summary")
  },
  {
    type: "follow_up",
    label: "❓ Follow-up questions",
    editor: "markdown",
    instruction: "Suggest 3-5 relevant follow-up questions for the user.",
    match: (text) => /suggest\s+3-5\s+relevant\s+follow-up\s+questions/i.test(text),
    buildPayload: (body, _promptText) => ({
      context: parseChatContextFromMessages(body),
      attachments: extractAttachmentsFromBody(body),
      response_schema: { follow_ups: ["string"] }
    }),
    normalizeReply: (content) => {
      const lines = content.split("\n").map(l => l.replace(/^[-*•\d.]+\s+/, "").trim()).filter(Boolean);
      return JSON.stringify({ follow_ups: lines });
    }
  },
  {
    type: "tags",
    label: "🏷️ Chat Tags",
    editor: "markdown",
    instruction: "Generate relevant tags for this chat.",
    match: (text) => /generate\s+relevant\s+tags\s+for\s+this\s+chat/i.test(text),
    buildPayload: (body, _promptText) => ({
      context: parseChatContextFromMessages(body),
      attachments: extractAttachmentsFromBody(body),
      response_schema: { tags: ["string"] }
    }),
    normalizeReply: (content) => {
      const tags = content.split(/[,\n]/).map(t => t.trim()).filter(Boolean);
      return JSON.stringify({ tags });
    }
  },
  {
    type: "search",
    label: "🔍 Search Query Analysis",
    editor: "markdown",
    instruction: "Analyze chat history to determine if search queries are needed.",
    match: (text) => /analyze\s+the\s+chat\s+history\s+to\s+determine\s+the\s+necessity\s+of\s+generating\s+search\s+queries/i.test(text),
    buildPayload: (body, _promptText) => ({
      context: parseChatContextFromMessages(body),
      attachments: extractAttachmentsFromBody(body),
      response_schema: { queries: ["string"] }
    }),
    normalizeReply: (content) => {
      const queries = content.split("\n").map(l => l.replace(/^[-*•\d.]+\s+/, "").trim()).filter(Boolean);
      return JSON.stringify({ queries });
    }
  },
  {
    type: "system_generic",
    label: "⚙️ System Task",
    editor: "markdown",
    instruction: "Complete the requested system meta-task.",
    match: (text) => text.includes("### Task:") && text.includes("### Guidelines:"),
    buildPayload: (body, promptText) => ({
      context: promptText,
      attachments: extractAttachmentsFromBody(body)
    }),
    normalizeReply: (content) => {
      try {
        JSON.parse(content);
        return content;
      } catch {
        return JSON.stringify({ response: content });
      }
    }
  }
];

function findSystemPromptWrapper(body, prompt) {
  const candidates = [{ role: "prompt", text: safeString(prompt) }, ...getMessageEntries(body)]
    .map((entry) => ({ role: safeString(entry.role).toLowerCase(), text: safeString(entry.text).trim() }))
    .filter((entry) => Boolean(entry.text));

  for (const candidate of candidates) {
    for (const wrapper of SYSTEM_PROMPT_WRAPPERS) {
      if (wrapper.match(candidate.text, candidate.role)) {
        log(`SYSTEM_PROMPT: Detected matching wrapper for type: ${wrapper.type}`);
        return { wrapper, promptText: candidate.text };
      }
    }
  }

  // Fallback for unidentified system-like prompts
  const text = safeString(prompt);
  const lower = text.toLowerCase();
  if (lower.includes("json") && (lower.includes("generate") || lower.includes("return") || lower.includes("output"))) {
    log("SYSTEM_PROMPT: Unmatched system-like prompt detected, using system_unknown fallback");
    return {
      wrapper: {
        type: "system_unknown",
        label: "❓ Unknown System Task",
        editor: "markdown",
        instruction: "This looks like a system prompt but wasn't explicitly matched. Please provide the required response.",
        buildPayload: (body, promptText) => ({
          context: promptText,
          attachments: extractAttachmentsFromBody(body)
        }),
        normalizeReply: (content) => {
          try {
            JSON.parse(content);
            return content;
          } catch {
            return JSON.stringify({ response: content });
          }
        }
      },
      promptText: text
    };
  }

  return null;
}

function suggestTitle(context) {
  const text = safeString(context).toLowerCase();
  if (!text) return "💬 Chat Summary";
  if (/\b(hello|hi|hey|greetings)\b/.test(text)) return "👋 Friendly Greeting";
  if (/\b(error|bug|fix|issue|404|500)\b/.test(text)) return "🛠️ Debugging Session";
  if (/\b(code|pull request|pr|repo|github|commit)\b/.test(text)) return "💻 Dev Workflow Notes";
  if (/\b(image|photo|picture)\b/.test(text)) return "🖼️ Shared Image Notes";
  if (/\b(file|document|pdf|attachment)\b/.test(text)) return "📎 File Discussion";
  return "📝 Chat Title Draft";
}

function normalizeTitleReply(content, fallbackTitle) {
  const text = safeString(content).trim();
  if (!text) return JSON.stringify({ title: fallbackTitle });
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.title === "string" && parsed.title.trim()) {
      return JSON.stringify({ title: parsed.title.trim() });
    }
  } catch {
    // operator entered plain markdown/text
  }
  return JSON.stringify({ title: text });
}

function createRequestMeta(id, model, prompt, body, createdAt) {
  const wrappedPrompt = findSystemPromptWrapper(body, prompt);
  if (!wrappedPrompt) {
    return { id, model, prompt, created_at: createdAt, kind: "chat", title_request: null };
  }

  const wrapper = wrappedPrompt.wrapper;
  const payload = typeof wrapper.buildPayload === "function" ? wrapper.buildPayload(body, wrappedPrompt.promptText) : {};

  return {
    id,
    model,
    prompt: wrapper.label,
    created_at: createdAt,
    kind: "wrapped_prompt",
    wrapper: {
      type: wrapper.type,
      label: wrapper.label,
      editor: wrapper.editor,
      instruction: wrapper.instruction,
      ...payload
    }
  };
}

function normalizeReplyForEntry(entry, content) {
  if (!entry || !entry.meta || entry.meta.kind !== "wrapped_prompt") return content;
  const type = entry.meta.wrapper?.type;
  let wrapper = SYSTEM_PROMPT_WRAPPERS.find((item) => item.type === type);

  // Handle system_unknown which is not in the static list
  if (!wrapper && type === "system_unknown") {
    wrapper = {
      normalizeReply: (c) => {
        try { JSON.parse(c); return c; } catch { return JSON.stringify({ response: c }); }
      }
    };
  }

  if (!wrapper || typeof wrapper.normalizeReply !== "function") return content;
  return wrapper.normalizeReply(content, entry.meta.wrapper);
}

function ndjsonWrite(res, obj) {
  res.write(`${JSON.stringify(obj)}\n`);
}

function log(...args) {
  console.log(`[${nowIso()}]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Delay between word tokens when streaming a reply to the client (~15ms ≈ 60 words/sec)
const STREAM_TOKEN_DELAY_MS = 15;

async function streamContent(res, model, content) {
  // Split into alternating word / whitespace tokens so spacing is preserved exactly
  const tokens = content.split(/(\s+)/).filter(Boolean);
  for (const token of tokens) {
    try {
      ndjsonWrite(res, { model, created_at: nowIso(), response: token, done: false });
    } catch {
      return;
    }
    if (token.trim()) {
      await sleep(STREAM_TOKEN_DELAY_MS);
    }
  }
  try {
    ndjsonWrite(res, { model, created_at: nowIso(), response: "", done: true });
    res.end();
  } catch {
    // client disconnected mid-stream
  }
}

// -------------------------
// Control Panel Server (6741)
// -------------------------
const panelApp = express();
panelApp.use(cors());
panelApp.use(bodyParser.json());
panelApp.use(express.static(path.join(__dirname, "public")));

panelApp.get("/health", (_req, res) => {
  res.json({ ok: true, service: "control-panel", time: nowIso() });
});

panelApp.post("/operator-reply", async (req, res) => {
  const { id, content } = req.body;
  const safeId = safeString(id).trim();
  const safeContent = safeString(content).trim();

  if (!safeId) {
    return res.status(400).json({ error: "Missing id" });
  }

  const entry = pending.get(safeId);
  if (!entry) {
    log(`SYSTEM_PROMPT: Reply received for unknown/expired id: ${safeId}`);
    return res.status(404).json({ error: "Request not found or expired" });
  }

  log(`SYSTEM_PROMPT: Operator reply received for id: ${safeId}`);

  clearTimeout(entry.timer);
  pending.delete(safeId);

  try {
    const finalContent = normalizeReplyForEntry(entry, safeContent);
    log(`SYSTEM_PROMPT: Sent reply to client for id: ${safeId}, payload: ${finalContent}`);

    // For system prompts, we often want to send the JSON immediately rather than streaming words
    if (entry.meta.kind === "wrapped_prompt") {
      ndjsonWrite(entry.res, {
        model: entry.meta.model,
        created_at: nowIso(),
        response: finalContent,
        done: true
      });
      entry.res.end();
    } else {
      await streamContent(entry.res, entry.meta.model, finalContent);
    }

    broadcast({
      type: "answered",
      id: safeId,
      content: safeContent,
      answered_at: nowIso()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("SYSTEM_PROMPT: Failed writing response to client:", err);
    res.status(500).json({ error: "Failed to deliver reply" });
  }
});

const panelServer = http.createServer(panelApp);
const wss = new WebSocket.Server({ server: panelServer });

function broadcast(messageObj) {
  const payload = JSON.stringify(messageObj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on("connection", (ws) => {
  const list = Array.from(pending.values()).map((entry) => entry.meta);
  ws.send(JSON.stringify({ type: "pending_list", data: list }));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type !== "reply") return;

    const id = safeString(msg.id).trim();
    const content = safeString(msg.content).trim();

    if (!id) return;

    const entry = pending.get(id);
    if (!entry) return;
    if (!content && entry.meta.kind !== "wrapped_prompt") return;

    clearTimeout(entry.timer);
    pending.delete(id);

    try {
      const finalContent = normalizeReplyForEntry(entry, content);
      await streamContent(entry.res, entry.meta.model, finalContent);
    } catch (err) {
      console.error("Failed writing response stream:", err);
    }

    broadcast({
      type: "answered",
      id,
      content,
      answered_at: nowIso()
    });
  });
});

panelServer.listen(PANEL_PORT, "0.0.0.0", () => {
  log(`🧠 Control panel: http://localhost:${PANEL_PORT}`);
});

// -------------------------
// Fake Ollama Server (11435)
// -------------------------
const ollamaApp = express();
ollamaApp.use(cors());
ollamaApp.use(bodyParser.json({ limit: "2mb" }));
ollamaApp.use((req, res, next) => {
  console.log(`[FAKE OLLAMA API] ${req.method} ${req.originalUrl}`);
  next();
});

ollamaApp.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fake-ollama", time: nowIso() });
});

ollamaApp.get("/api/tags", (_req, res) => {
  res.json({
    models: [
      {
        name: "uno-reverse",
        model: "uno-reverse",
        modified_at: nowIso(),
        size: 0,
        digest: "human-controlled",
        details: { format: "human", family: "operator", parameter_size: "N/A", quantization_level: "N/A" }
      }
    ]
  });
});

ollamaApp.get("/v1", (_req, res) => {
  res.json({ ok: true, service: "fake-ollama-v1-compat" });
});

ollamaApp.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [{ id: "uno-reverse", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "uno-reverse" }]
  });
});

ollamaApp.get("/debug/pending", (_req, res) => {
  const data = Array.from(pending.entries()).map(([id, entry]) => ({
    id,
    meta: entry.meta
  }));
  res.json({ count: data.length, ws_clients: wss.clients.size, data });
});

ollamaApp.get("/debug/ws", (_req, res) => {
  res.json({ ws_clients: wss.clients.size, time: nowIso() });
});

function extractId(req) {
  const body = req.body || {};
  // Prioritize chat_id from body, then metadata, then headers
  const id = body.chat_id ||
             (body.metadata && body.metadata.chat_id) ||
             req.headers["x-chat-id"] ||
             req.headers["x-request-id"] ||
             makeId();
  return safeString(id);
}

function handleGenerateLike(req, res) {
  const body = req.body || {};
  const model = safeString(body.model || "uno-reverse");
  const prompt = extractPromptFromBody(body);
  const id = extractId(req);
  const createdAt = nowIso();

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  ndjsonWrite(res, { model, created_at: createdAt, response: "", done: false });

  const meta = createRequestMeta(id, model, prompt, body, createdAt);

  if (meta.kind === "wrapped_prompt") {
    log(`SYSTEM_PROMPT: Intercepted system prompt for id: ${id}, type: ${meta.wrapper.type}`);
  }

  const timer = setTimeout(() => {
    try {
      if (meta.kind === "wrapped_prompt") {
        log(`SYSTEM_PROMPT: Timeout for id: ${id}`);
      }
      ndjsonWrite(res, { model, created_at: nowIso(), response: "[Operator did not respond in time]", done: false });
      ndjsonWrite(res, { model, created_at: nowIso(), response: "", done: true });
      res.end();
    } catch (err) {
      console.error("Timeout stream close error:", err);
    } finally {
      pending.delete(id);
      broadcast({ type: "expired", id, expired_at: nowIso() });
    }
  }, TIMEOUT_SECONDS * 1000);

  pending.set(id, { res, timer, meta });

  if (meta.kind === "wrapped_prompt") {
    log(`SYSTEM_PROMPT: Emitting system_prompt_request for id: ${id}`);
    broadcast({ type: "system_prompt_request", ...meta });
  } else {
    broadcast({ type: "incoming", ...meta });
  }

  res.on("close", () => {
    if (pending.has(id)) {
      clearTimeout(timer);
      pending.delete(id);
      broadcast({ type: "client_disconnected", id, at: nowIso() });
    }
  });
}

ollamaApp.post("/api/generate", handleGenerateLike);
ollamaApp.post("/api/chat", handleGenerateLike);
ollamaApp.post("/api/chat/completions", handleGenerateLike);
ollamaApp.post("/v1/chat/completions", handleGenerateLike);
ollamaApp.post("/api/ps", (_req, res) => {
  res.json({ ok: true, service: "prompt-service", status: "stub", time: nowIso() });
});

ollamaApp.listen(OLLAMA_PORT, "0.0.0.0", () => {
  log(`🤖 Fake Ollama API: http://localhost:${OLLAMA_PORT}`);
});

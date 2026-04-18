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

function isTitleSystemPrompt(prompt) {
  const text = safeString(prompt).trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (/@generate_chat_title\.json/.test(lower)) return true;
  return (
    /generate\s+(a\s+)?concise[\s\S]{0,100}title[\s\S]{0,100}emoji/i.test(text) ||
    /json\s+format[\s\S]{0,80}\{\s*"title"\s*:/i.test(text) ||
    (/chat\s+history/i.test(text) && /return\s+.*json/i.test(text) && /"title"\s*:/.test(text))
  );
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
    match: (text) => isTitleSystemPrompt(text),
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
  }
];

function findSystemPromptWrapper(body, prompt) {
  const candidates = [{ role: "prompt", text: safeString(prompt) }, ...getMessageEntries(body)]
    .map((entry) => ({ role: safeString(entry.role).toLowerCase(), text: safeString(entry.text).trim() }))
    .filter((entry) => Boolean(entry.text));
  for (const candidate of candidates) {
    for (const wrapper of SYSTEM_PROMPT_WRAPPERS) {
      if (wrapper.match(candidate.text, candidate.role)) {
        return { wrapper, promptText: candidate.text };
      }
    }
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

  const payload = wrappedPrompt.wrapper.buildPayload(body, wrappedPrompt.promptText);
  return {
    id,
    model,
    prompt: wrappedPrompt.wrapper.label,
    created_at: createdAt,
    kind: "wrapped_prompt",
    wrapper: {
      type: wrappedPrompt.wrapper.type,
      label: wrappedPrompt.wrapper.label,
      editor: wrappedPrompt.wrapper.editor,
      instruction: wrappedPrompt.wrapper.instruction,
      ...payload
    }
  };
}

function normalizeReplyForEntry(entry, content) {
  if (!entry || !entry.meta || entry.meta.kind !== "wrapped_prompt") return content;
  const type = entry.meta.wrapper?.type;
  const wrapper = SYSTEM_PROMPT_WRAPPERS.find((item) => item.type === type);
  if (!wrapper || typeof wrapper.normalizeReply !== "function") return content;
  return wrapper.normalizeReply(content, entry.meta.wrapper);
}

function ndjsonWrite(res, obj) {
  res.write(`${JSON.stringify(obj)}\n`);
}

function log(...args) {
  console.log(`[${nowIso()}]`, ...args);
}

// -------------------------
// Control Panel Server (6741)
// -------------------------
const panelApp = express();
panelApp.use(cors());
panelApp.use(express.static(path.join(__dirname, "public")));

panelApp.get("/health", (_req, res) => {
  res.json({ ok: true, service: "control-panel", time: nowIso() });
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

  ws.on("message", (raw) => {
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

    try {
      const finalContent = normalizeReplyForEntry(entry, content);
      ndjsonWrite(entry.res, {
        model: entry.meta.model,
        created_at: nowIso(),
        response: finalContent,
        done: false
      });
      ndjsonWrite(entry.res, {
        model: entry.meta.model,
        created_at: nowIso(),
        response: "",
        done: true
      });
      entry.res.end();
    } catch (err) {
      console.error("Failed writing response stream:", err);
    }

    pending.delete(id);

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

function handleGenerateLike(req, res) {
  const body = req.body || {};
  const model = safeString(body.model || "uno-reverse");
  const prompt = extractPromptFromBody(body);
  const id = makeId();
  const createdAt = nowIso();

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  ndjsonWrite(res, { model, created_at: createdAt, response: "", done: false });

  const meta = createRequestMeta(id, model, prompt, body, createdAt);

  const timer = setTimeout(() => {
    try {
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

  broadcast({ type: meta.kind === "wrapped_prompt" ? "prompt_wrapper" : "incoming", ...meta });

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

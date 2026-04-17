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
// pending[id] = { res, timer, meta: { id, model, prompt, created_at } }
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

function extractPromptFromBody(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.prompt === "string" && body.prompt.trim()) return body.prompt;

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
        return m.content;
      }
    }
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m && typeof m.content === "string" && m.content.trim()) return m.content;
    }
  }
  return "";
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
  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
      sent += 1;
    }
  }
  log(`WS broadcast type=${messageObj.type} sent_to=${sent} clients_total=${wss.clients.size}`);
}

wss.on("connection", (ws, req) => {
  const ip = req?.socket?.remoteAddress || "unknown";
  log(`WS client connected from ${ip}. total_clients=${wss.clients.size}`);

  // Send currently pending list
  const list = Array.from(pending.values()).map((entry) => entry.meta);
  ws.send(JSON.stringify({ type: "pending_list", data: list }));
  log(`Sent pending_list count=${list.length} to new WS client`);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON message." }));
      return;
    }

    if (msg.type !== "reply") return;

    const id = safeString(msg.id).trim();
    const content = safeString(msg.content).trim();

    if (!id) {
      ws.send(JSON.stringify({ type: "error", message: "Missing message id." }));
      return;
    }
    if (!content) {
      ws.send(JSON.stringify({ type: "error", message: "Reply content cannot be empty." }));
      return;
    }

    const entry = pending.get(id);
    if (!entry) {
      ws.send(JSON.stringify({ type: "error", message: `No pending message found for id ${id}.` }));
      return;
    }

    clearTimeout(entry.timer);

    try {
      ndjsonWrite(entry.res, {
        model: entry.meta.model,
        created_at: nowIso(),
        response: content,
        done: false
      });
      ndjsonWrite(entry.res, {
        model: entry.meta.model,
        created_at: nowIso(),
        response: "",
        done: true
      });
      entry.res.end();
      log(`Answered id=${id} content_len=${content.length}`);
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

  ws.on("close", () => {
    log(`WS client disconnected. total_clients=${wss.clients.size}`);
  });

  ws.on("error", (err) => {
    log(`WS client error: ${err.message}`);
  });
});

panelServer.listen(PANEL_PORT, "0.0.0.0", () => {
  log(`🧠 Control panel: http://localhost:${PANEL_PORT}`);
});

// -------------------------
// Fake Ollama Server (11435 default)
// -------------------------
const ollamaApp = express();
ollamaApp.use(cors());
ollamaApp.use(bodyParser.json({ limit: "2mb" }));

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
        details: {
          format: "human",
          family: "operator",
          parameter_size: "N/A",
          quantization_level: "N/A"
        }
      }
    ]
  });
});

ollamaApp.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [{ id: "uno-reverse", object: "model", created: Date.now(), owned_by: "uno-reverse" }]
  });
});

// Debug: inspect pending queue
ollamaApp.get("/debug/pending", (_req, res) => {
  const data = Array.from(pending.entries()).map(([id, entry]) => ({
    id,
    meta: entry.meta,
    timerAlive: !!entry.timer
  }));
  res.json({ count: data.length, ws_clients: wss.clients.size, data });
});

// Debug: inspect ws client count
ollamaApp.get("/debug/ws", (_req, res) => {
  res.json({ ws_clients: wss.clients.size, time: nowIso() });
});

function handleGenerateLike(req, res) {
  const body = req.body || {};
  const model = safeString(body.model || "uno-reverse");
  const prompt = extractPromptFromBody(body);
  const id = makeId();
  const createdAt = nowIso();

  log(`Incoming request id=${id} path=${req.path} model=${model} prompt_len=${prompt.length}`);

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  ndjsonWrite(res, {
    model,
    created_at: createdAt,
    response: "",
    done: false
  });

  const meta = { id, model, prompt, created_at: createdAt };

  const timer = setTimeout(() => {
    try {
      ndjsonWrite(res, {
        model,
        created_at: nowIso(),
        response: "[Operator did not respond in time]",
        done: false
      });
      ndjsonWrite(res, {
        model,
        created_at: nowIso(),
        response: "",
        done: true
      });
      res.end();
      log(`Expired id=${id} after ${TIMEOUT_SECONDS}s`);
    } catch (err) {
      console.error("Timeout stream close error:", err);
    } finally {
      pending.delete(id);
      broadcast({ type: "expired", id, expired_at: nowIso() });
    }
  }, TIMEOUT_SECONDS * 1000);

  pending.set(id, { res, timer, meta });
  log(`Pending added id=${id}. pending_count=${pending.size}`);

  broadcast({
    type: "incoming",
    ...meta
  });

  req.on("close", () => {
    if (pending.has(id)) {
      clearTimeout(timer);
      pending.delete(id);
      log(`Client disconnected before reply id=${id}. pending_count=${pending.size}`);
      broadcast({ type: "client_disconnected", id, at: nowIso() });
    }
  });
}

ollamaApp.post("/api/generate", handleGenerateLike);
ollamaApp.post("/api/chat/completions", handleGenerateLike);
ollamaApp.post("/v1/chat/completions", handleGenerateLike);

ollamaApp.listen(OLLAMA_PORT, "0.0.0.0", () => {
  log(`🤖 Fake Ollama API: http://localhost:${OLLAMA_PORT}`);
  log(`⏱️ Timeout: ${TIMEOUT_SECONDS}s`);
});

# uno-reverse

Be the AI in OpenWebUI chats.

`uno-reverse` runs:
- a **fake Ollama-compatible API** on `http://localhost:11435`
- a **human control panel** on `http://localhost:6741`

When a user sends a message to the fake model, it appears in your panel. You type the response, and it streams back as if it came from an AI model.

---

## System Prompt UX (OpenWebUI System Tasks)

- OpenWebUI system/meta prompts (including titles, follow-up questions, tags, and search query analysis) are automatically intercepted and routed as **wrapped system tasks**.
- Supported types:
  - **Title**: `{"title": "..."}`
  - **Follow-up**: `{"follow_ups": ["...", "..."]}`
  - **Tags**: `{"tags": ["...", "..."]}`
  - **Search**: `{"queries": ["...", "..."]}`
- Raw LLM instructions are **not shown** to the operator in the main chat. Instead, a dedicated **system task modal** appears.
- The modal includes a Markdown editor, helper tools, live preview, and displays relevant chat context/attachments.
- Submitted answers are automatically wrapped into the correct JSON format required by OpenWebUI.
- All system prompt events are logged with `SYSTEM_PROMPT:` prefix for end-to-end traceability.

---

## Requirements

- **Node.js 18+**
- **npm 9+**
- **bash** (macOS/Linux native, Windows via Git Bash/WSL)

Check versions:
```bash
node -v
npm -v
```

---

## Explicit Install Instructions

### 1) Clone repo
```bash
git clone https://github.com/MixwellDairy/uno-reverse.git
cd uno-reverse
```

### 2) Make scripts executable (macOS/Linux/WSL)
```bash
chmod +x scripts/install.sh scripts/uninstall.sh scripts/update.sh
```

### 3) Install app dependencies
```bash
npm run install:app
```

### 4) Start app in bg
```bash
cd ~/uno-reverse
# use custom ports if needed:
OLLAMA_PORT=11435 PANEL_PORT=6741 nohup npm start > uno-reverse.log 2>&1 &
echo $!   # prints the background process id (PID)
```

You should see:
- `🤖 Fake Ollama API: http://localhost:11435`
- `🧠 Control panel: http://localhost:6741`

### 5) Open control panel
Go to:

`http://localhost:6741`

### 6) Configure OpenWebUI
Set Ollama/base URL to:

`http://localhost:11435`

Model:

`uno-reverse`

---

## Scripts

### Install
```bash
npm run install:app
```
Runs `scripts/install.sh`:
- validates Node/npm
- installs dependencies (`npm ci` if lockfile exists, otherwise `npm install`)

### Uninstall
```bash
npm run uninstall:app
```
Runs `scripts/uninstall.sh`:
- removes `node_modules`
- removes `package-lock.json`

### Update
```bash
npm run update:app
```
Runs `scripts/update.sh`:
- `npm update`
- `npm audit fix` (best effort)

### Start
```bash
npm start
```
Starts both servers.

---

## Quick API Test

### Check model list
```bash
curl http://localhost:11435/api/tags
```

### Send a prompt (streaming)
```bash
curl -N -X POST "http://localhost:11435/api/generate" \
  -H "Content-Type: application/json" \
  -d '{"model":"uno-reverse","prompt":"Hello from curl"}'
```

Now reply from control panel and curl will finish.

---

## Documentation

For a detailed mapping of communication flows between Open-WebUI and Ollama, including payload structures and how `uno-reverse` handles them, see:

👉 [**OLLAMA_FLOWS.md**](./OLLAMA_FLOWS.md)

---

## Environment Variables

- `OLLAMA_PORT` (default `11435`)
- `PANEL_PORT` (default `3000`)
- `UNO_REVERSE_TIMEOUT_SECONDS` (default `300`)
- `OPERATOR_HISTORY_LIMIT` (default `20`): Number of recent chat messages to include in the system prompt history.
- `SKIP_SYSTEM_TASKS` (default `undefined`): If set to `true`, the server will automatically respond to system prompts (titles, tags, etc.) with default values. If set, the UI toggle is locked. If unset, operators can toggle this at runtime (not persisted across restarts).

Example:
```bash
OLLAMA_PORT=11435 PANEL_PORT=3000 UNO_REVERSE_TIMEOUT_SECONDS=600 npm start
```

---

## Endpoints

- `GET /api/tags`
- `POST /api/generate`
- `POST /api/chat`
- `POST /api/chat/completions`
- `POST /v1/chat/completions` (compat)
- `POST /api/ps` (stub system prompt service)

---

## Troubleshooting

### Bash not found on Windows
Use **Git Bash** or **WSL**, then run npm scripts there.

### Port in use
```bash
OLLAMA_PORT=11435 PANEL_PORT=3001 npm start
```

### OpenWebUI not connecting
- ensure app is running
- URL is `http://localhost:11435`
- model is `uno-reverse`

---

## Notes

- In-memory only (restart clears pending state)
- Keep local unless you add auth + HTTPS
- Intended for testing, demos, and creative workflows

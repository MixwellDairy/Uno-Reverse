# uno-reverse

Be the AI in OpenWebUI chats.

`uno-reverse` runs:
- a **fake Ollama-compatible API** on `http://localhost:11434`
- a **human control panel** on `http://localhost:6741`

When a user sends a message to the fake model, it appears in your panel. You type the response, and it streams back as if it came from an AI model.

---

## System Prompt UX (OpenWebUI Title Requests)

- OpenWebUI title/meta prompts (including `@generate_chat_title.json` flows) are detected and routed as **wrapped system tasks**.
- Raw LLM system/meta instructions are **not shown** to the operator as normal chat text.
- The control panel opens a dedicated **system task modal** with a Markdown editor, helper tools, and live preview.
- Context and detected attachments are shown in the modal for reference.
- Submitted title text is automatically wrapped by the backend to the required JSON shape:
  - `{ "title": "## 📊 Analytics Summary" }`
- The wrapper architecture is extensible so future system prompts (tags, summaries, etc.) can be added with their own UI/normalization handler without exposing raw meta prompts.

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
- `🤖 Fake Ollama API: http://localhost:11434`
- `🧠 Control panel: http://localhost:6741`

### 5) Open control panel
Go to:

`http://localhost:6741`

### 6) Configure OpenWebUI
Set Ollama/base URL to:

`http://localhost:11434`

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
curl http://localhost:11434/api/tags
```

### Send a prompt (streaming)
```bash
curl -N -X POST "http://localhost:11434/api/generate" \
  -H "Content-Type: application/json" \
  -d '{"model":"uno-reverse","prompt":"Hello from curl"}'
```

Now reply from control panel and curl will finish.

---

## Environment Variables

- `OLLAMA_PORT` (default `11434`)
- `PANEL_PORT` (default `3000`)
- `UNO_REVERSE_TIMEOUT_SECONDS` (default `300`)

Example:
```bash
OLLAMA_PORT=11434 PANEL_PORT=3000 UNO_REVERSE_TIMEOUT_SECONDS=600 npm start
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
- URL is `http://localhost:11434`
- model is `uno-reverse`

---

## Notes

- In-memory only (restart clears pending state)
- Keep local unless you add auth + HTTPS
- Intended for testing, demos, and creative workflows

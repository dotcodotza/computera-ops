# Computera AI ⚡

A modern, full-featured **filesystem-aware local AI chatbot** powered by **Express.js** and **Ollama**. Computera AI lets you interact with local language models (such as `llama3.2:1b`) with full context and control over your project workspace.

![UI Overview](public/index.html)

---

## ✨ Features

- **💬 Real-Time Streaming Chat:** Instant token-by-token streaming responses with live markdown rendering and syntax-highlighted code blocks.
- **📂 Live Filesystem Explorer:**
  - Browse workspace files and directories with breadcrumb navigation.
  - Inspect file metadata (sizes, modification dates, extensions).
  - Create new files directly from the UI.
- **👁️ File Viewer & Editor Modal:**
  - View any file in a clean monospace editor with line numbers.
  - Edit and save changes directly to disk via the backend API.
- **📎 Direct Context Attachment:**
  - **Attach File:** Select any workspace file to inject its content directly into the prompt.
  - **Project Files:** Injects directory structure into the context with a single click.
  - **Ask AI About This File:** Instant prompt generation for file analysis, code review, or refactoring.
- **🧠 Persistent Memory:**
  - Save, load, and manage persistent memory notes across chat sessions.
  - Inject saved notes directly into chat context.
- **⚡ Slash Commands:**
  - `/read <file>` or `/cat <file>`: Read and attach a file.
  - `/ls [dir]`: List directory contents.
  - `/models`: List available Ollama models.
  - `/clear`: Clear active chat messages.
  - `/help`: Display available commands.
- **🛡️ Secure Filesystem Access:** Validated filesystem paths to keep operations within safe workspace roots.

---

## 🛠️ Tech Stack

- **Backend:** Node.js (ES Modules), Express.js, `fs-extra`, `cors`
- **Frontend:** Vanilla JS, HTML5, Modern CSS (Dark Theme)
- **Libraries (CDN):** Marked.js (Markdown), Highlight.js (Syntax Highlighting)
- **Local LLM Engine:** [Ollama](https://ollama.com/) (e.g. `llama3.2:1b`)

---

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Ollama](https://ollama.com/) installed and running

Ensure you have a model pulled in Ollama:
```bash
ollama pull llama3.2:1b
```

### 2. Installation

Clone the repository and install dependencies:
```bash
git clone https://github.com/Skywalkingzulu1/ai-webapp-computera.git
cd ai-webapp-computera
npm install
```

### 3. Start Ollama & the Server

Start Ollama (if not already running as a service):
```bash
ollama serve
```

Start the Computera AI server:
```bash
npm start
```

### 4. Access the Application

Open your browser and navigate to:
- **Local:** [http://localhost:3000](http://localhost:3000)

---

## ⚙️ Configuration

Environment variables (optional):
- `PORT`: Server port (default: `3000`)
- `OLLAMA_URL`: URL to your Ollama instance (default: `http://localhost:11434`)
- `ALLOWED_FS_ROOTS`: Semicolon-separated paths allowed for filesystem operations.
- `EXA_API_KEY`: [Exa](https://exa.ai) key for web search. Empty disables `POST /api/web/search` and the chat agent's `web_search` tool (they answer 503).

---

## 🌐 Fleet mode (up to 7 workers)

Every machine runs the same app. One node is the **master** (the workspace, and the only writer to
`data/app.db`); the rest are **workers**. Workers advertise what they can actually do — Kilo, Ollama,
both, or neither — and the master dispatches each task only to a node that can run it.

### 1. Master

```bash
# .env
NODE_ROLE=master
FLEET_TOKEN=<shared secret>
PORT=3000
```

### 2. Each worker

```bash
# .env
NODE_ROLE=worker
MASTER_URL=http://<master-lan-ip>:3000
FLEET_TOKEN=<same shared secret>
WORKER_NAME=Desk 2
PORT=3002
# optional, only on nodes that can serve the public link:
PUBLIC_URL=https://desk2.example.ts.net
```

Start both with `npm start`. The worker probes its own engines at boot, joins the roster, and
heartbeats every 15 s. A node that stops reporting shows as **offline** after 45 s.

### 3. Dispatch

Each task carries a **Needs** value:

| Needs | Runs on |
| --- | --- |
| `any` | least-loaded online worker with Kilo **or** Ollama |
| `kilo` | only a worker advertising Kilo |
| `ollama` | only a worker advertising Ollama |

`POST /api/fleet/dispatch/:taskId` (or the **Dispatch** button) makes the choice, retries one
alternate candidate on failure, then falls back to the master's own engines. If nothing can run it
the task stays in `todo` with a visible `blocked_reason` — never silently dropped.

### 4. Shared calendar

All entries live on the master and are read by every node through the proxy, so there are no
conflicting writers. `GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` returns day → entries plus the
host for each day. Each entry shows the assigned worker and its capability requirement.

### 5. Host of the day

One node serves the public link per day, rotating round-robin (nodes with `PUBLIC_URL` first).

- `GET /api/fleet/today` — today's host and link (shown in the dashboard with a copy button)
- `GET /today` — stable entry point, redirects to whichever node is hosting today
- if the host misses heartbeats, the master promotes the next online node and issues a new link token
- the previous day's token stops working, so an old leaked URL does not stay valid

### 6. Security

Set `PUBLIC_MODE=1` on any node serving a public link. The UI then requires today's link
token, and `FLEET_TOKEN` guards `join`, `heartbeat`, `run` and worker removal.

Workspace file sharing is controlled separately by `WORKSPACE_SHARE`:

| value | link holders can |
| --- | --- |
| `off` | nothing (`/api/filesystem`, `/api/document`, `/api/memory` return 403) |
| `read` (default) | browse, list, read and download files under `SHARED_FS_ROOT` |
| `write` | the above plus create, edit, upload and delete files |

Shared access never leaves `SHARED_FS_ROOT` (default: the workspace folder) and always skips
dotfiles, `data/`, `memory/`, `node_modules/` and local tooling, so the database, `.env` and
the app's own memory store stay private. `/api/tools/execute` and any path outside the
workspace still require `X-Fleet-Token` or Basic auth. On a LAN-only node (`PUBLIC_MODE` off)
the fleet token / Basic auth path is not needed; the app is limited to `ALLOWED_FS_ROOTS`, which
defaults to the workspace folder plus your home directory — set `ALLOWED_FS_ROOTS` explicitly
to the workspace folder to keep the home directory out of reach.

Node identity and exposure settings (`public_url`, `public_mode`, `workspace_share`,
`shared_fs_root`, `last_boot`) are stored in the `settings` table and readable via
`GET /api/state`.

Single-machine use is unchanged: with no `NODE_ROLE`, the app behaves exactly as before.

---

## 📄 License

MIT License. Created by [Skywalkingzulu](https://github.com/Skywalkingzulu1).

## Chat, Studio and POV

- `/` and `/studio` — chat beside the POV document editor (what `/` used to be).
- `/chat` — chat only, no document pane.
- `/dashboard` — calendar, tasks and fleet, unchanged.

POV (pdfcraft) is proxied under this app's own origin at `/pdfcraft/`: only its
three published build files, cached in `data/pdfcraft-cache/`. That same-origin
setup is what makes its `postMessage` bridge work — opening a PDF from the Files
tab pushes it into POV, and saving in POV writes back into the workspace file
(the previous version is copied to `data/backups/pdf/`). Studio polls the open
file every 5 s, so an edit the AI or Kilo makes on disk reloads into POV.

Set `POV_MODE=embed` to frame `https://skywalkingzulu1.github.io/pdfcraft/`
instead. In that mode POV's code does not run on this origin and nothing is
saved back to the workspace, but POV also cannot read workspace PDFs by itself.
The trade-off of the default: proxied third-party WASM is same-origin code and
inherits this page's API access.

# @ohif/extension-ai-assist

AI Agent Assistant extension for the OHIF Viewer, providing an interactive chat interface for automated radiology workflows.

## Features

- **AI Chat Panel** — Conversational interface embedded in the OHIF side panel
- **Automatic Report Generation** — Structured radiology reports using your chosen LLM
- **Organ Segmentation** — Run TotalSegmentator or nnU-Net models directly from the chat
- **Radiomics Extraction** — Extract quantitative features using PyRadiomics
- **Customizable LLMs** — OpenAI, Anthropic, Ollama (local), OpenRouter, Azure OpenAI
- **Customizable Segmentation Models** — TotalSegmentator, nnU-Net, and custom REST endpoints
- **Per-Study Chat Persistence** — Chat history is stored separately per study and survives page refreshes

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────────────┐
│   OHIF Viewer (React)   │        │   AI Agent Backend (FastAPI)     │
│                         │        │                                  │
│  ┌───────────────────┐  │  SSE   │  ┌────────────────────────────┐  │
│  │  PanelAIAssistant │◄─┼────────┼──│  LangGraph ReAct Agent     │  │
│  │  (chat UI)        │  │        │  │                            │  │
│  └───────────────────┘  │  POST  │  │  Tools:                    │  │
│                         │────────►  │  • TotalSegmentator        │  │
│  ┌───────────────────┐  │        │  │  • nnU-Net / AutoPET       │  │
│  │  AIAgentService   │  │        │  │  • Custom REST endpoints   │  │
│  │  (API client)     │  │        │  │  • PyRadiomics             │  │
│  └───────────────────┘  │        │  │  • Report generator        │  │
└─────────────────────────┘        └──────────────────────────────────┘
```

## Quick Start

### 1. Start the Backend

```bash
cd extensions/ai-assist/backend

# Copy and configure environment
cp .env.example .env
# Edit .env to add your API keys

# Option A: Docker (recommended)
docker-compose up -d

# Option B: Local Python
pip install -r requirements.txt
# Install optional AI models:
pip install TotalSegmentator  # for organ segmentation
pip install nnunetv2          # for nnU-Net models
python main.py
```

### 2. Build the Extension

The extension is part of the OHIF monorepo and is built automatically:

```bash
# From the repo root
yarn install
yarn dev  # or: yarn build
```

### 3. Open the AI Assistant

In any viewer mode (Basic, Segmentation, etc.), click the **AI** tab in the right panel.

---

## Configuration

### LLM Providers

| Provider    | Models                              | Requires              |
|-------------|-------------------------------------|-----------------------|
| OpenAI      | gpt-4o, gpt-4o-mini                | `OPENAI_API_KEY`      |
| Anthropic   | claude-opus-4-6, claude-sonnet-4-6 | `ANTHROPIC_API_KEY`   |
| Ollama      | llama3.2, mistral, …               | Local Ollama server   |
| OpenRouter  | Any model via OpenRouter           | `OPENROUTER_API_KEY`  |
| Azure       | Your deployed model                | Azure credentials     |

Configure via the **⚙ Settings** button in the panel, or via backend environment variables.

### Segmentation Models

| Model            | Type           | Description                              |
|------------------|----------------|------------------------------------------|
| TotalSegmentator | totalsegmentator | 117 anatomical structures               |
| AutoPET (nnU-Net)| nnunet         | Whole-body lesion detection for PET/CT   |
| Custom           | custom         | Any REST endpoint you define             |

Add custom models via the **⚙ Settings → Add Custom Model** UI, or via the `CUSTOM_SEG_ENDPOINTS` environment variable.

### Quick Actions

The panel includes one-click buttons for:
- **Report** — Generate a structured radiology report
- **Segment** — Run automatic organ segmentation
- **Radiomics** — Extract quantitative imaging features
- **Describe** — Describe the current study and findings

### Chat History Persistence

The panel remembers the conversation for each study independently. You can choose where history is stored via **⚙ Settings → Chat History Storage**:

| Option | Description |
|--------|-------------|
| **localStorage** | Stored in the browser's `localStorage`. Survives page refreshes and browser restarts. Default. |
| **sessionStorage** | Stored in the browser's `sessionStorage`. Cleared when the browser tab is closed. |
| **Server (local path)** | Saved as JSON files on the backend server at a configurable path. Survives browser data clearing and is accessible across devices sharing the same backend. |
| **None** | In-memory only. History is lost on page refresh. |

#### Server-side storage path

When using **Server (local path)**, history files are written to the directory configured by `CHAT_HISTORY_DIR` on the backend. Each study produces one file:

```
<CHAT_HISTORY_DIR>/<StudyInstanceUID>.json
```

Set the path in your `.env` file or as an environment variable:

```bash
# .env
CHAT_HISTORY_DIR=/data/ohif-chat-history
```

The default is `/tmp/ohif-ai-chat-history`. The directory is created automatically on backend startup.

---

## Backend Environment Variables

| Variable                  | Default        | Description                         |
|---------------------------|----------------|-------------------------------------|
| `OPENAI_API_KEY`          | —              | OpenAI API key                      |
| `ANTHROPIC_API_KEY`       | —              | Anthropic API key                   |
| `OPENROUTER_API_KEY`      | —              | OpenRouter API key                  |
| `DEFAULT_LLM_PROVIDER`    | `openai`       | Default LLM provider                |
| `DEFAULT_LLM_MODEL`       | `gpt-4o`       | Default model name                  |
| `DEFAULT_SEGMENTATION_MODEL` | `totalsegmentator` | Active segmentation model    |
| `OLLAMA_BASE_URL`         | `http://localhost:11434` | Ollama server URL         |
| `CUSTOM_SEG_ENDPOINTS`    | —              | `id:url` pairs, comma-separated     |
| `TOTALSEGMENTATOR_TASK`   | `total`        | TotalSegmentator task               |
| `TOTALSEGMENTATOR_FAST`   | `false`        | Use fast mode                       |
| `CHAT_HISTORY_DIR`        | `/tmp/ohif-ai-chat-history` | Directory for server-side chat history files |
| `PORT`                    | `8000`         | Backend server port                 |
| `DEBUG`                   | `false`        | Enable debug logging                |

---

## API Reference

### `POST /api/chat/stream`

Streaming chat endpoint (SSE).

**Request body:**
```json
{
  "message": "Generate a radiology report",
  "history": [{"role": "user", "content": "..."}],
  "study_context": {
    "studyInstanceUID": "1.2.3...",
    "seriesInstanceUID": "1.2.3...",
    "modality": "CT",
    "dicomwebUrl": "http://orthanc:8042/wado"
  },
  "config": {
    "llm_provider": "openai",
    "llm_model": "gpt-4o",
    "segmentation_model": "totalsegmentator",
    "api_key": "sk-..."
  }
}
```

**SSE events:**
```
data: {"type": "observation", "content": "token text"}
data: {"type": "tool_start", "toolName": "run_totalsegmentator", "toolInput": {...}}
data: {"type": "tool_end", "toolName": "run_totalsegmentator", "toolOutput": "..."}
data: {"type": "final", "content": "complete response text"}
data: [DONE]
```

### `GET /api/models`

Returns available LLM and segmentation models.

### `GET /api/chat/history/{study_uid}`

Load persisted chat history for a study (server storage backend only).

**Response:**
```json
{
  "messages": [{"role": "user", "content": "...", "timestamp": "2024-01-01T00:00:00Z"}, ...],
  "path": "/tmp/ohif-ai-chat-history/1.2.3.json"
}
```
Returns `{"messages": []}` if no history file exists yet.

### `POST /api/chat/history/{study_uid}`

Persist chat history for a study (overwrites any existing file).

**Request body:**
```json
{"messages": [{"role": "user", "content": "...", "timestamp": "..."}]}
```

### `DELETE /api/chat/history/{study_uid}`

Delete the persisted history file for a study.

### `GET /health`

Health check endpoint. Also reports the configured `chat_history_dir`.

---

## Development

```bash
# Run backend in debug mode
DEBUG=true python main.py

# The extension hot-reloads with the OHIF dev server
yarn dev
```

## License

MIT — Part of the OHIF Viewer project.

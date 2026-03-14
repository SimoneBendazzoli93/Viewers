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
| Ollama      | Fetched live from your server      | `OLLAMA_BASE_URL` (+ optional `OLLAMA_API_KEY`) |
| OpenRouter  | Any model via OpenRouter           | `OPENROUTER_API_KEY`  |
| Azure       | Your deployed model                | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` |

Configure via the **⚙ Settings** button in the panel, or via backend environment variables.

#### Ollama

The extension communicates with Ollama through an **OpenAI-compatible API** (`/models` and `/chat/completions`). Set `OLLAMA_BASE_URL` to the base URL of your server:

```bash
# Local Ollama
OLLAMA_BASE_URL=http://localhost:11434/v1

# Remote / hosted Ollama with authentication
OLLAMA_BASE_URL=https://my-ollama-server.example.com/api
OLLAMA_API_KEY=my-bearer-token
```

Available models are **fetched live** from the server when you select the Ollama provider in Settings — no hardcoded model list.

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

| Variable                      | Default                        | Description                                     |
|-------------------------------|--------------------------------|-------------------------------------------------|
| `OPENAI_API_KEY`              | —                              | OpenAI API key                                  |
| `ANTHROPIC_API_KEY`           | —                              | Anthropic API key                               |
| `OPENROUTER_API_KEY`          | —                              | OpenRouter API key                              |
| `AZURE_OPENAI_API_KEY`        | —                              | Azure OpenAI API key                            |
| `AZURE_OPENAI_ENDPOINT`       | —                              | Azure OpenAI endpoint URL                       |
| `AZURE_OPENAI_API_VERSION`    | `2024-02-01`                   | Azure OpenAI API version                        |
| `OLLAMA_BASE_URL`             | `http://localhost:11434/v1`    | Ollama server base URL (OpenAI-compatible)      |
| `OLLAMA_API_KEY`              | —                              | Bearer token for remote Ollama servers          |
| `DEFAULT_LLM_PROVIDER`        | `openai`                       | Default LLM provider                            |
| `DEFAULT_LLM_MODEL`           | `gpt-4o`                       | Default model name                              |
| `DEFAULT_SEGMENTATION_MODEL`  | `totalsegmentator`             | Active segmentation model                       |
| `DICOMWEB_WADO_ROOT`          | —                              | WADO-RS retrieve URL (see DICOMweb section)     |
| `DICOMWEB_QIDO_ROOT`          | —                              | QIDO-RS search URL                              |
| `DICOMWEB_WADO_URI_ROOT`      | —                              | WADO-URI base URL                               |
| `DICOMWEB_STATIC_WADO`        | `false`                        | Set `true` for static / S3 servers              |
| `DICOMWEB_SINGLEPART`         | —                              | e.g. `bulkdata,video`                           |
| `DICOMWEB_URL`                | —                              | Shortcut: sets all three roots to the same URL  |
| `CUSTOM_SEG_ENDPOINTS`        | —                              | `id:url` pairs, comma-separated                 |
| `TOTALSEGMENTATOR_TASK`       | `total`                        | TotalSegmentator task                           |
| `TOTALSEGMENTATOR_FAST`       | `false`                        | Use fast mode for TotalSegmentator              |
| `CHAT_HISTORY_DIR`            | `/tmp/ohif-ai-chat-history`    | Directory for server-side chat history files    |
| `PORT`                        | `8000`                         | Backend server port                             |
| `DEBUG`                       | `false`                        | Enable debug logging                            |

### DICOMweb Configuration

The agent needs DICOMweb endpoints to fetch DICOM series for segmentation and radiomics. The configuration mirrors the **OHIF data source configuration** exactly, so you can copy values straight from your `appConfig.js` / `default.js`.

#### How the URL is supplied

| Source | When it applies |
|--------|-----------------|
| **OHIF viewer** (automatic) | The viewer reads `extensionManager.getActiveDataSource()[0].getConfig()` and sends `wadoRoot`, `qidoRoot`, `staticWado`, `singlepart` in every chat request. No backend configuration needed for normal browser usage. |
| **Environment variables** | Fallback for scripted / API usage without a live OHIF session, or to override what the viewer sends. |

#### Environment variables

The env var names map 1-to-1 to the OHIF data source configuration fields:

| Env var | OHIF field | Description |
|---------|-----------|-------------|
| `DICOMWEB_WADO_ROOT` | `configuration.wadoRoot` | WADO-RS base URL — used by all retrieve tools |
| `DICOMWEB_QIDO_ROOT` | `configuration.qidoRoot` | QIDO-RS base URL — used for metadata search |
| `DICOMWEB_WADO_URI_ROOT` | `configuration.wadoUriRoot` | WADO-URI base URL |
| `DICOMWEB_STATIC_WADO` | `configuration.staticWado` | `true` for static/S3 servers |
| `DICOMWEB_SINGLEPART` | `configuration.singlepart` | `"bulkdata,video"` etc. |
| `DICOMWEB_URL` | — | Backward-compat shortcut: sets all three roots to the same URL |

#### Examples

```bash
# AWS S3 / CloudFront static WADO (copy from the appConfig.js example above)
DICOMWEB_WADO_ROOT=https://d14fa38qiwhyfd.cloudfront.net/dicomweb
DICOMWEB_QIDO_ROOT=https://d14fa38qiwhyfd.cloudfront.net/dicomweb
DICOMWEB_WADO_URI_ROOT=https://d14fa38qiwhyfd.cloudfront.net/dicomweb
DICOMWEB_STATIC_WADO=true
DICOMWEB_SINGLEPART=bulkdata,video

# Orthanc (simple)
DICOMWEB_WADO_ROOT=http://orthanc:8042/wado
DICOMWEB_QIDO_ROOT=http://orthanc:8042/wado

# dcm4chee
DICOMWEB_WADO_ROOT=http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs
DICOMWEB_QIDO_ROOT=http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs
```

When the env vars are set, they are injected into the study context the agent sees, so the agent never asks the user for a DICOMweb URL. All tools (`run_totalsegmentator`, `run_nnunet`, `run_custom_segmentation`, `convert_dicom_seg_to_nifti`, `extract_radiomics`) accept the URL as an optional parameter and fall back to these env vars when it is omitted.

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

Returns available LLM models (static cloud providers + live Ollama models) and segmentation models.

### `GET /api/ollama/models?base_url=<url>`

Probes an Ollama server and returns its model list. Used by the Settings panel to populate the model dropdown dynamically.

- `base_url` query param overrides the configured `OLLAMA_BASE_URL` so you can test connectivity before saving.
- Forwards the request's `Authorization: Bearer <token>` header to the Ollama server.

**Response:**
```json
{"models": [{"id": "qwen3:32b", "name": "qwen3:32b", "provider": "ollama"}], "base_url": "https://..."}
```

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

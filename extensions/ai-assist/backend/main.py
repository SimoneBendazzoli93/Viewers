"""
OHIF AI Assistant Backend

FastAPI application providing:
  POST /api/chat/stream       – streaming chat endpoint (SSE)
  GET  /api/models            – list all available LLM and segmentation models
  GET  /api/ollama/models     – probe an Ollama server and return its model list
  GET  /health                – health check
"""
from __future__ import annotations

import json
import logging
import sys
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from config import settings
from agent import stream_agent_response

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("ohif-ai-assist")

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="OHIF AI Assistant",
    description="AI agent backend for the OHIF Viewer – segmentation, radiomics, reports",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ────────────────────────────────────────────────────────────────────

class AgentRequestConfig(BaseModel):
    llm_provider: str = Field(default="openai")
    llm_model: str = Field(default="gpt-4o")
    segmentation_model: str = Field(default="totalsegmentator")
    api_key: Optional[str] = None


class DicomSegInfo(BaseModel):
    seriesInstanceUID: str
    seriesDescription: Optional[str] = None
    referencedSeriesInstanceUID: Optional[str] = None


class StudyContext(BaseModel):
    studyInstanceUID: Optional[str] = None
    seriesInstanceUID: Optional[str] = None
    sopInstanceUID: Optional[str] = None
    patientName: Optional[str] = None
    studyDate: Optional[str] = None
    modality: Optional[str] = None

    # DICOMweb configuration — mirrors the OHIF data source configuration.
    # The viewer populates these from extensionManager.getActiveDataSource()[0].getConfig().
    dicomwebUrl: Optional[str] = None      # legacy single-URL field (backward compat)
    wadoRoot: Optional[str] = None         # WADO-RS base URL for retrieve operations
    qidoRoot: Optional[str] = None         # QIDO-RS base URL for search operations
    wadoUriRoot: Optional[str] = None      # WADO-URI base URL
    staticWado: Optional[bool] = None      # server serves static (pre-generated) files
    singlepart: Optional[str] = None       # comma-sep modalities: "bulkdata,video"

    availableSegmentations: Optional[list[DicomSegInfo]] = None


class HistoryMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[HistoryMessage] = Field(default_factory=list)
    study_context: Optional[StudyContext] = None
    config: AgentRequestConfig = Field(default_factory=AgentRequestConfig)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "1.0.0",
        "chat_history_dir": str(settings.chat_history_dir),
    }


# ── Chat history persistence ──────────────────────────────────────────────────

class ChatHistoryMessage(BaseModel):
    role: str
    content: str
    timestamp: Optional[str] = None
    toolName: Optional[str] = None
    toolStatus: Optional[str] = None
    toolResult: Optional[str] = None


class ChatHistorySaveRequest(BaseModel):
    messages: list[ChatHistoryMessage]


@app.get("/api/chat/history/{study_uid}")
async def get_chat_history(study_uid: str):
    """
    Load persisted chat history for a study from the server's chat_history_dir.
    Returns an empty list if no history file exists yet.
    """
    history_file = settings.chat_history_dir / f"{study_uid}.json"
    if not history_file.exists():
        return {"messages": [], "path": str(history_file)}
    try:
        content = history_file.read_text(encoding="utf-8")
        messages = json.loads(content)
        return {"messages": messages, "path": str(history_file)}
    except Exception as exc:
        logger.error("Failed to read chat history for %s: %s", study_uid, exc)
        return {"messages": [], "path": str(history_file), "error": str(exc)}


@app.post("/api/chat/history/{study_uid}")
async def save_chat_history(study_uid: str, body: ChatHistorySaveRequest):
    """
    Persist chat history for a study to the server's chat_history_dir.
    Creates the file if it does not exist; overwrites it otherwise.
    """
    history_file = settings.chat_history_dir / f"{study_uid}.json"
    try:
        history_file.write_text(
            json.dumps([m.model_dump(exclude_none=True) for m in body.messages], indent=2),
            encoding="utf-8",
        )
        logger.info("Saved chat history for %s → %s (%d messages)", study_uid, history_file, len(body.messages))
        return {"status": "ok", "path": str(history_file), "count": len(body.messages)}
    except Exception as exc:
        logger.error("Failed to save chat history for %s: %s", study_uid, exc)
        return {"status": "error", "error": str(exc)}


@app.delete("/api/chat/history/{study_uid}")
async def delete_chat_history(study_uid: str):
    """Delete the persisted chat history file for a study."""
    history_file = settings.chat_history_dir / f"{study_uid}.json"
    if history_file.exists():
        history_file.unlink()
        logger.info("Deleted chat history for %s", study_uid)
    return {"status": "ok"}


async def _fetch_ollama_models(base_url: str, api_key: str | None = None) -> list[dict]:
    """
    Query an OpenAI-compatible /models endpoint and return a list of model dicts.
    The server is expected to return {"object": "list", "data": [{"id": "...", ...}]}.
    Returns an empty list if the server is unreachable.
    """
    target_url = f"{base_url.rstrip('/')}/models"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key[:8]}***"  # log truncated key

    logger.info("Fetching Ollama models from: %s | auth: %s", target_url, "yes" if api_key else "no")

    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"  # restore full key for actual request

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(target_url, headers=headers)
            logger.info("Ollama /models response: HTTP %d", resp.status_code)
            logger.debug("Ollama /models response headers: %s", dict(resp.headers))
            resp.raise_for_status()
            data = resp.json()
            logger.debug("Ollama /models raw body: %s", data)
            models = [
                {
                    "id": m["id"],
                    "name": m["id"],
                    "provider": "ollama",
                    "description": m.get("description", ""),
                }
                for m in data.get("data", [])
            ]
            logger.info("Ollama returned %d model(s)", len(models))
            return models
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Ollama /models HTTP error: %d %s | body: %s",
            exc.response.status_code,
            exc.response.reason_phrase,
            exc.response.text[:500],
        )
        return []
    except httpx.RequestError as exc:
        logger.error("Ollama /models network error: %s — %s", type(exc).__name__, exc)
        return []
    except Exception as exc:
        logger.error("Ollama /models unexpected error: %s — %s", type(exc).__name__, exc)
        return []


@app.get("/api/ollama/models")
async def ollama_models(
    base_url: str = Query(default=None, description="Ollama base URL to probe"),
    authorization: str | None = Header(default=None),
):
    """
    Probe an Ollama server and return its installed model list.

    - `base_url` query param overrides the configured OLLAMA_BASE_URL so the
      config panel can test connectivity to a new URL before saving.
    - Passes the `Authorization` request header to Ollama (Bearer token).
    """
    url = base_url or settings.ollama_base_url
    logger.info("ollama_models endpoint called | base_url param=%r | using url=%s", base_url, url)
    logger.info("Authorization header present: %s", "yes" if authorization else "no")

    api_key = None
    if authorization and authorization.lower().startswith("bearer "):
        api_key = authorization[7:]
        logger.info("Using API key from request Authorization header (len=%d)", len(api_key))
    elif not authorization:
        api_key = settings.ollama_api_key
        logger.info(
            "No Authorization header — using OLLAMA_API_KEY from settings: %s",
            "set" if api_key else "not set",
        )
    else:
        logger.warning("Authorization header present but not Bearer scheme: %r", authorization[:20])

    models = await _fetch_ollama_models(url, api_key)
    logger.info("Returning %d model(s) to client", len(models))
    return {"models": models, "base_url": url}


@app.get("/api/models")
async def list_models():
    """Return available LLM models (Ollama list fetched live) and segmentation models."""
    # Static models for cloud providers
    llm_models = [
        {"id": "gpt-4o",            "name": "GPT-4o",            "provider": "openai"},
        {"id": "gpt-4o-mini",       "name": "GPT-4o Mini",       "provider": "openai"},
        {"id": "claude-opus-4-6",   "name": "Claude Opus 4.6",   "provider": "anthropic"},
        {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "provider": "anthropic"},
    ]

    # Live Ollama models
    ollama_models_list = await _fetch_ollama_models(
        settings.ollama_base_url, settings.ollama_api_key
    )
    llm_models.extend(ollama_models_list)

    seg_models = [
        {
            "id": "totalsegmentator",
            "name": "TotalSegmentator",
            "description": "Segment 117 anatomical structures",
            "type": "totalsegmentator",
        },
        {
            "id": "nnunet-autopet",
            "name": "AutoPET (nnU-Net)",
            "description": "Whole-body lesion detection for PET/CT",
            "type": "nnunet",
        },
    ]

    # Add custom endpoints from settings
    if settings.custom_seg_endpoints:
        for pair in settings.custom_seg_endpoints.split(","):
            pair = pair.strip()
            if ":" in pair:
                model_id, endpoint = pair.split(":", 1)
                seg_models.append({
                    "id": model_id.strip(),
                    "name": model_id.strip(),
                    "description": "Custom endpoint",
                    "type": "custom",
                    "endpoint": endpoint.strip(),
                })

    return {"llm": llm_models, "segmentation": seg_models}


@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest):
    """
    Streaming chat endpoint using Server-Sent Events (SSE).
    The response body contains SSE data frames for the frontend to consume.
    """
    logger.info(
        "Chat request: provider=%s model=%s seg=%s message_len=%d",
        request.config.llm_provider,
        request.config.llm_model,
        request.config.segmentation_model,
        len(request.message),
    )

    study_ctx = request.study_context.model_dump() if request.study_context else None
    history = [h.model_dump() for h in request.history]

    async def event_generator():
        try:
            async for chunk in stream_agent_response(
                message=request.message,
                history=history,
                study_context=study_ctx,
                llm_provider=request.config.llm_provider,  # type: ignore[arg-type]
                llm_model=request.config.llm_model,
                segmentation_model=request.config.segmentation_model,
                api_key=request.config.api_key,
            ):
                yield chunk
        except Exception as exc:
            logger.exception("Agent error: %s", exc)
            error_event = json.dumps({"type": "error", "content": str(exc)})
            yield f"data: {error_event}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level="debug" if settings.debug else "info",
    )

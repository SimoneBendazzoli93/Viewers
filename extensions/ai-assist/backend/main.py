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


class StudyContext(BaseModel):
    studyInstanceUID: Optional[str] = None
    seriesInstanceUID: Optional[str] = None
    sopInstanceUID: Optional[str] = None
    patientName: Optional[str] = None
    studyDate: Optional[str] = None
    modality: Optional[str] = None
    dicomwebUrl: Optional[str] = None


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
    return {"status": "ok", "version": "1.0.0"}


async def _fetch_ollama_models(base_url: str, api_key: str | None = None) -> list[dict]:
    """
    Query an OpenAI-compatible /models endpoint and return a list of model dicts.
    The server is expected to return {"object": "list", "data": [{"id": "...", ...}]}.
    Returns an empty list if the server is unreachable.
    """
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(f"{base_url.rstrip('/')}/models", headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return [
                {
                    "id": m["id"],
                    "name": m["id"],
                    "provider": "ollama",
                    "description": m.get("description", ""),
                }
                for m in data.get("data", [])
            ]
    except Exception as exc:
        logger.warning("Could not reach Ollama at %s: %s", base_url, exc)
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
    api_key = None
    if authorization and authorization.lower().startswith("bearer "):
        api_key = authorization[7:]
    elif not authorization:
        api_key = settings.ollama_api_key

    models = await _fetch_ollama_models(url, api_key)
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

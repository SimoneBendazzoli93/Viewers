"""
OHIF AI Assistant Backend

FastAPI application providing:
  POST /api/chat/stream            – streaming chat endpoint (SSE)
  GET  /api/chat/history/{uid}     – load persisted chat history
  POST /api/chat/history/{uid}     – save chat history
  DELETE /api/chat/history/{uid}   – delete chat history
  GET  /api/radiomics/{study_uid}  – return the latest radiomics CSV for a study (404 if none)
  GET  /api/models                 – list all available LLM and segmentation models
  GET  /api/ollama/models          – probe an Ollama server and return its model list
  GET  /api/files/download?path=…  – serve a result file produced by an agent tool
  GET  /health                     – health check
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from config import settings
from agent import stream_agent_response
from pathlib import Path
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
    language: str = Field(default="English")


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
            "id": "monet-bundle",
            "name": "MONet Bundle",
            "description": "nnUNet-based segmentation",
            "type": "monet",
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


@app.get("/api/reports/{study_uid}")
async def list_reports(study_uid: str):
    """
    Return a list of all saved radiology reports for a study, newest first.

    Reports are stored at:
        {reports_output_dir}/{study_uid}/v{NNN}_{YYYYMMDD_HHMMSS}.md

    Each entry contains the version number, filename, creation time (from
    mtime), and file size in bytes.  Returns an empty list (not 404) when no
    reports exist yet so the frontend can safely poll.
    """
    study_dir = settings.reports_output_dir / study_uid
    if not study_dir.is_dir():
        return {"reports": []}

    reports = []
    for md_file in sorted(
        study_dir.glob("v[0-9][0-9][0-9]_*.md"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    ):
        stem = md_file.stem                        # e.g. "v003_20240115_143022"
        version = int(stem.split("_")[0][1:])      # "v003" → 3
        stat = md_file.stat()
        reports.append({
            "version": version,
            "filename": md_file.name,
            "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "size": stat.st_size,
        })

    return {"reports": reports}


@app.get("/api/reports/{study_uid}/{filename}")
async def get_report(study_uid: str, filename: str):
    """
    Return the Markdown content of a specific report version.

    Security:
      - ``filename`` must end in ``.md`` and contain no path separators.
      - The resolved path must stay within ``reports_output_dir``.
    """
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    if not filename.endswith(".md"):
        raise HTTPException(status_code=400, detail="Only .md report files are served here.")

    report_file = (settings.reports_output_dir / study_uid / filename).resolve()
    if not str(report_file).startswith(str(settings.reports_output_dir.resolve())):
        raise HTTPException(status_code=403, detail="Access denied.")
    if not report_file.exists():
        raise HTTPException(status_code=404, detail="Report not found.")

    content = report_file.read_text(encoding="utf-8")
    logger.info("Serving report %s for study %s", filename, study_uid)
    return {"content": content, "filename": filename, "study_uid": study_uid}


@app.get("/api/radiomics/{study_uid}")
async def get_radiomics(study_uid: str):
    """
    Return the most recently generated radiomics CSV for a study.

    The radiomics tool stores results at:
        {radiomics_output_dir}/{study_uid}/{series_uid}/radiomics_features.csv

    When multiple series extractions exist the most recently modified file is
    returned.  Responds with 404 when no CSV has been generated yet.
    """
    study_dir = settings.radiomics_output_dir / study_uid
    if not study_dir.is_dir():
        raise HTTPException(status_code=404, detail="No radiomics results found for this study.")

    # Collect all radiomics_features.csv files under any series subdirectory.
    csv_files = sorted(
        study_dir.glob("*/radiomics_features.csv"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not csv_files:
        raise HTTPException(status_code=404, detail="No radiomics results found for this study.")

    latest = csv_files[0]
    logger.info("Serving radiomics CSV for study %s → %s", study_uid, latest)
    return FileResponse(
        path=str(latest),
        filename="radiomics_features.csv",
        media_type="text/csv",
    )


@app.get("/api/files/download")
async def download_file(path: str = Query(..., description="Absolute path to the file on the server")):
    """
    Serve a result file (CSV, NIfTI, JSON, …) produced by an agent tool.

    Security: only paths that are strict children of the configured output
    directories are served. Anything outside those dirs returns 403.
    """
    file_path = Path(path).resolve()

    allowed_dirs = [
        settings.radiomics_output_dir.resolve(),
        settings.segmentation_output_dir.resolve(),
    ]
    if not any(str(file_path).startswith(str(d)) for d in allowed_dirs):
        raise HTTPException(status_code=403, detail="Access to this path is not allowed.")

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found.")

    # Determine media type from suffix
    suffix = file_path.suffix.lower()
    media_types = {
        ".csv":     "text/csv",
        ".json":    "application/json",
        ".nii":     "application/octet-stream",
        ".gz":      "application/octet-stream",
    }
    media_type = media_types.get(suffix, "application/octet-stream")

    return FileResponse(
        path=str(file_path),
        filename=file_path.name,
        media_type=media_type,
    )


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
                language=request.config.language,
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

"""
Configuration management for the AI Assistant backend.
All settings can be overridden via environment variables or a .env file.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Server ──────────────────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False
    cors_origins: list[str] = ["*"]  # tighten in production

    # ── LLM defaults (can be overridden per-request) ──────────────────────
    default_llm_provider: Literal["openai", "anthropic", "ollama", "openrouter", "azure"] = "openai"
    default_llm_model: str = "gpt-4o"

    # Provider API keys (set via environment variables)
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    openrouter_api_key: str | None = None
    azure_openai_api_key: str | None = None
    azure_openai_endpoint: str | None = None
    azure_openai_api_version: str = "2024-02-01"

    # Base URL for an OpenAI-compatible Ollama server.
    # Local Ollama:  http://localhost:11434/v1
    # Remote server: https://maia-chat.app.cloud.cbh.kth.se/api
    # The /models and /chat/completions paths are appended automatically.
    ollama_base_url: str = "http://localhost:11434/v1"
    # Optional Bearer token for remote Ollama servers that require authentication
    ollama_api_key: str | None = None

    # ── DICOMweb ──────────────────────────────────────────────────────────
    # Default DICOMweb WADO-RS base URL used when the OHIF viewer does not
    # send one in the study context (e.g. for programmatic / scripted usage).
    # When set, tools that require a DICOMweb URL will use it automatically
    # and the agent will never need to ask the user for it.
    # Example: http://orthanc:8042/wado   or   http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs
    dicomweb_url: str | None = None

    # ── Segmentation ─────────────────────────────────────────────────────
    default_segmentation_model: str = "totalsegmentator"

    # Directory where DICOM files are temporarily cached
    dicom_cache_dir: Path = Path("/tmp/ohif-ai-dicom-cache")

    # Directory where segmentation masks are saved
    segmentation_output_dir: Path = Path("/tmp/ohif-ai-seg-output")

    # Directory where radiomics results are saved
    radiomics_output_dir: Path = Path("/tmp/ohif-ai-radiomics-output")

    # TotalSegmentator task (see TotalSegmentator docs)
    totalsegmentator_task: str = "total"
    totalsegmentator_fast: bool = False  # use --fast flag for quicker (lower quality) inference

    # Custom segmentation endpoints (comma-separated "id:url" pairs)
    # e.g. "my-liver:http://localhost:9001,my-lung:http://localhost:9002"
    custom_seg_endpoints: str = ""

    # ── Radiomics ─────────────────────────────────────────────────────────
    radiomics_params_file: Path | None = None  # optional PyRadiomics params YAML

    # ── Chat history ──────────────────────────────────────────────────────
    # Directory where per-study chat history JSON files are stored when the
    # frontend uses the "server" storage backend.
    # Each study gets its own file: <chat_history_dir>/<studyInstanceUID>.json
    chat_history_dir: Path = Path("/tmp/ohif-ai-chat-history")


settings = Settings()

# Ensure output dirs exist on startup
settings.dicom_cache_dir.mkdir(parents=True, exist_ok=True)
settings.segmentation_output_dir.mkdir(parents=True, exist_ok=True)
settings.radiomics_output_dir.mkdir(parents=True, exist_ok=True)
settings.chat_history_dir.mkdir(parents=True, exist_ok=True)

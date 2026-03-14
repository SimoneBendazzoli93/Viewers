"""
Factory for creating LLM instances based on provider configuration.
Supports: OpenAI, Anthropic, Ollama, OpenRouter, Azure OpenAI.
"""
from __future__ import annotations

from typing import Literal

from langchain_core.language_models import BaseChatModel

from config import settings


LLMProvider = Literal["openai", "anthropic", "ollama", "openrouter", "azure"]


def create_llm(
    provider: LLMProvider | None = None,
    model: str | None = None,
    api_key: str | None = None,
    temperature: float = 0.1,
    streaming: bool = True,
) -> BaseChatModel:
    """
    Instantiate and return a LangChain chat model for the given provider.

    Args:
        provider: LLM provider name. Defaults to settings.default_llm_provider.
        model: Model identifier. Defaults to settings.default_llm_model.
        api_key: API key (overrides settings if provided).
        temperature: Sampling temperature.
        streaming: Enable streaming output.

    Returns:
        A LangChain BaseChatModel instance.

    Raises:
        ValueError: If the provider is unknown or the package is not installed.
    """
    provider = provider or settings.default_llm_provider
    model = model or settings.default_llm_model

    if provider == "openai":
        try:
            from langchain_openai import ChatOpenAI
        except ImportError:
            raise ValueError("langchain-openai is not installed.")
        return ChatOpenAI(
            model=model,
            temperature=temperature,
            streaming=streaming,
            api_key=api_key or settings.openai_api_key,
        )

    elif provider == "anthropic":
        try:
            from langchain_anthropic import ChatAnthropic
        except ImportError:
            raise ValueError("langchain-anthropic is not installed.")
        return ChatAnthropic(
            model=model,
            temperature=temperature,
            streaming=streaming,
            api_key=api_key or settings.anthropic_api_key,
        )

    elif provider == "ollama":
        # The Ollama server exposes an OpenAI-compatible API, so we use
        # ChatOpenAI with the configured base URL.
        # For local Ollama:  OLLAMA_BASE_URL=http://localhost:11434/v1
        # For remote server: OLLAMA_BASE_URL=https://host/api
        try:
            from langchain_openai import ChatOpenAI
        except ImportError:
            raise ValueError("langchain-openai is not installed.")
        resolved_key = api_key or settings.ollama_api_key or "ollama"
        return ChatOpenAI(
            model=model,
            temperature=temperature,
            streaming=streaming,
            base_url=settings.ollama_base_url,
            api_key=resolved_key,
        )

    elif provider == "openrouter":
        # OpenRouter uses the OpenAI-compatible API
        try:
            from langchain_openai import ChatOpenAI
        except ImportError:
            raise ValueError("langchain-openai is not installed.")
        return ChatOpenAI(
            model=model,
            temperature=temperature,
            streaming=streaming,
            api_key=api_key or settings.openrouter_api_key,
            base_url="https://openrouter.ai/api/v1",
        )

    elif provider == "azure":
        try:
            from langchain_openai import AzureChatOpenAI
        except ImportError:
            raise ValueError("langchain-openai is not installed.")
        return AzureChatOpenAI(
            azure_deployment=model,
            azure_endpoint=settings.azure_openai_endpoint or "",
            api_version=settings.azure_openai_api_version,
            api_key=api_key or settings.azure_openai_api_key,
            temperature=temperature,
            streaming=streaming,
        )

    else:
        raise ValueError(f"Unknown LLM provider: {provider!r}")

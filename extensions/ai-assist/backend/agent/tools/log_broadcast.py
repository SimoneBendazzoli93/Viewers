"""
Thread-safe log buffer for streaming long-running tool output to the UI.

Tools emit log lines via :func:`emit` while the agent drains them into SSE
``tool_log`` events from the async heartbeat / log-drain coroutines.
"""
from __future__ import annotations

import threading
from collections import deque

_MAX_LINES = 500

_lock = threading.Lock()
_active = False
_buffer: deque[str] = deque(maxlen=_MAX_LINES)


def activate() -> None:
    """Begin collecting log lines for the current tool execution."""
    global _active
    with _lock:
        _buffer.clear()
        _active = True


def deactivate() -> None:
    """Stop collecting log lines."""
    global _active
    with _lock:
        _active = False


def emit(line: str) -> None:
    """Append a log line when broadcasting is active."""
    text = line.rstrip()
    if not text:
        return
    with _lock:
        if _active:
            _buffer.append(text)


def drain() -> list[str]:
    """Return and clear all pending log lines."""
    with _lock:
        lines = list(_buffer)
        _buffer.clear()
        return lines

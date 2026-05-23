"""
AI Radiology Agent using LangGraph ReAct pattern.

The agent is equipped with tools for:
- Organ segmentation (TotalSegmentator, nnU-Net, custom endpoints)
- Radiomics feature extraction (PyRadiomics)
- Structured report generation

It streams events (thoughts, tool calls, final answers) back to the FastAPI
endpoint via an async generator.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator, Optional

logger = logging.getLogger("ohif-ai-assist.agent")

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage
from langgraph.prebuilt import create_react_agent

from config import settings
from .llm_factory import create_llm, LLMProvider
from .tools import (
    run_totalsegmentator,
    run_monet_segmentation,
    list_monet_tasks,
    run_custom_segmentation,
    extract_radiomics,
    generate_radiology_report,
    convert_dicom_seg_to_nifti,
)

SYSTEM_PROMPT = """You are an expert AI radiology assistant integrated into the OHIF medical imaging viewer.

You assist radiologists and medical professionals with:
1. **Organ Segmentation** - Automatically segment anatomical structures using TotalSegmentator or nnU-Net models.
2. **Radiomics Extraction** - Extract quantitative imaging features from DICOM series using PyRadiomics.
3. **Report Generation** - Generate structured radiology reports in standard clinical format.
4. **Study Analysis** - Answer questions about the current DICOM study.
5. **DICOM SEG Integration** - Use existing DICOM segmentation objects already present in the study.

List MONet tasks using the tool `list_monet_tasks`.
When given a task, follow these priorities:

**Segmentation mask selection:**
- If the study context includes `availableSegmentations`, ALWAYS prefer those over running a new
  segmentation model. Pass the `seg_series_instance_uid` directly to `extract_radiomics`, or call
  `convert_dicom_seg_to_nifti` first to get the NIfTI mask path(s).
- Only call TotalSegmentator / nnU-Net if no DICOM SEG is available in the study.

**Description of the segmentation:**
- Analyze the segmentation mask using the tool `convert_dicom_seg_to_nifti` to get a description of the segmentation mask.
- The description should include the following information, justifying the information provided:
  - The number of segments in the segmentation mask
  - The name of the segments(e.g. "Liver", "Lesion_1")
  - Their volume in milliliters
  - The number of connected components in the segmentation mask, important for counting the number of objects in the segmentation mask, and their size in milliliters and voxels. This information can be used to provide a consideration about the quality of the segmentation.
  - The key observations and clinical implications of the segmentation mask.
  - The considerations about the quality of the segmentation, justified by the information provided in the previous points.
  - The recommendation for the next steps, based on the information provided in the previous points.
- If no additional steps are needed, just return the description of the segmentation mask and provide the option to download the segmentation masks as nifti files.

**Radiomics:**
- When a DICOM SEG is available, pass its `seg_series_instance_uid` to `extract_radiomics` so
  features are computed per anatomical segment rather than on the whole volume.
- Report per-segment feature summaries (mean HU, volume, entropy, etc.) in the final answer.

**Report generation:**
- Reference DICOM SEG segment names by their label (e.g. "Liver", "Lesion_1") when describing findings.
- Include radiomics highlights per segment when available. Perform a thorough analysis of the radiomics features and the segmentation mask, and provide a detailed description of the findings.
- As `additional_findings`, include the segmentation mask analysis performed by the tool `convert_dicom_seg_to_nifti` and the radiomics features extracted by the tool `extract_radiomics`.
- Always check the modality of the series under examination and set it for the `modality` parameter of the `generate_radiology_report` tool.

**General:**
- Think step-by-step about what tools you need.
- Always compile the report AFTER collecting all available data.
- Be precise with UIDs and parameters.
- Be ALWAYS sure that there is a segmentation mask available for the study, if not, run the segmentation model to generate a mask.
- If something fails, explain the error clearly and suggest alternatives.
- The `dicomweb_url` parameter in every tool maps to the WADO-RS retrieve
  endpoint (`wadoRoot` in the study context). It is **optional** — when omitted
  the server falls back to its configured `DICOMWEB_WADO_ROOT` env var.
  Never ask the user for a DICOMweb URL; always use `wadoRoot` from the study
  context (or omit the parameter entirely if absent).
- When a tool result mentions a downloadable file (e.g. CSV, NIfTI, JSON), tell the user
  to **click the download button on the tool card** in the chat. Never
  output raw `/api/files/...` paths or internal server paths — they are not
  directly clickable in the user's browser. Be sure to generate the exact download URL that the user can click on to download the file, referring to the /api endpoint of the backend.
- Never call the tool `extract_radiomics` unless it is explicitly requested by the user.

Current study context will be provided in the user message when available.
The `availableSegmentations` field lists DICOM SEG series already loaded in the viewer.
"""


def _save_report(study_uid: str, content: str) -> tuple[Path, int]:
    """
    Persist *content* as a versioned Markdown file under
    ``reports_output_dir / study_uid /``.

    Versioning is sequential: count existing ``v[0-9][0-9][0-9]_*.md`` files
    and use ``len + 1`` as the new version.  The filename also embeds the
    current timestamp so reports are self-identifying on disk.

    Returns:
        (filepath, version_number)
    """
    study_dir = settings.reports_output_dir / study_uid
    study_dir.mkdir(parents=True, exist_ok=True)

    existing = sorted(study_dir.glob("v[0-9][0-9][0-9]_*.md"))
    version = len(existing) + 1
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filepath = study_dir / f"v{version:03d}_{timestamp}.md"
    filepath.write_text(content, encoding="utf-8")
    logger.info("Saved report v%d for study %s → %s", version, study_uid, filepath)
    return filepath, version


def _build_tools(segmentation_model: str) -> list:
    """Return tool list based on the active segmentation model."""
    seg_tools = {
        "totalsegmentator": run_totalsegmentator,
        "monet-bundle": run_monet_segmentation,
    }
    active_seg = seg_tools.get(segmentation_model, run_monet_segmentation)

    return [
        convert_dicom_seg_to_nifti,
        active_seg,
        run_custom_segmentation,
        extract_radiomics,
        generate_radiology_report,
    ]


async def stream_agent_response(
    message: str,
    history: list[dict],
    study_context: Optional[dict],
    llm_provider: LLMProvider,
    llm_model: str,
    segmentation_model: str,
    api_key: Optional[str] = None,
    language: str = "English",
) -> AsyncIterator[str]:
    """
    Run the ReAct agent and yield Server-Sent Events (SSE) data strings.

    Uses an asyncio.Queue so that a background heartbeat coroutine can inject
    ``tool_progress`` events every few seconds while a long-running tool is
    executing.  The event loop is free during ``run_in_executor`` awaits inside
    LangGraph, so the heartbeat *will* run even when the tool thread is busy.

    Yields:
        SSE data lines in the format ``data: <json>\\n\\n``
    """
    llm = create_llm(
        provider=llm_provider,
        model=llm_model,
        api_key=api_key,
        streaming=True,
    )

    tools = _build_tools(segmentation_model)
    agent = create_react_agent(llm, tools)

    # Build message history for the agent
    language_instruction = f"\n\n**Language requirement:** Always respond in {language}, regardless of the language used by the user."
    lc_messages: list = [SystemMessage(content=SYSTEM_PROMPT + language_instruction)]

    for h in history:
        role = h.get("role", "")
        content = h.get("content", "")
        if role == "user":
            lc_messages.append(HumanMessage(content=content))
        elif role == "assistant":
            lc_messages.append(AIMessage(content=content))

    # Append study context to the user message.
    user_content = message
    if study_context:
        effective_wado = (
            study_context.get("wadoRoot")
            or study_context.get("dicomwebUrl")
            or settings.dicomweb_wado_root
            or settings.dicomweb_url
        )
        effective_qido = (
            study_context.get("qidoRoot")
            or settings.dicomweb_qido_root
            or settings.dicomweb_url
            or effective_wado
        )
        patches: dict = {}
        if effective_wado and not study_context.get("wadoRoot"):
            patches["wadoRoot"] = effective_wado
        if effective_qido and not study_context.get("qidoRoot"):
            patches["qidoRoot"] = effective_qido
        if settings.dicomweb_static_wado and study_context.get("staticWado") is None:
            patches["staticWado"] = settings.dicomweb_static_wado
        if settings.dicomweb_singlepart and not study_context.get("singlepart"):
            patches["singlepart"] = settings.dicomweb_singlepart
        if patches:
            study_context = {**study_context, **patches}

        ctx_lines = "\n".join(f"  {k}: {v}" for k, v in study_context.items() if v is not None and v != "")
        user_content = f"{message}\n\n[Current Study Context]\n{ctx_lines}"
    else:
        wado = settings.dicomweb_wado_root or settings.dicomweb_url
        qido = settings.dicomweb_qido_root or settings.dicomweb_url or wado
        if wado:
            ctx_parts = [f"  wadoRoot: {wado}"]
            if qido and qido != wado:
                ctx_parts.append(f"  qidoRoot: {qido}")
            if settings.dicomweb_static_wado:
                ctx_parts.append(f"  staticWado: true")
            if settings.dicomweb_singlepart:
                ctx_parts.append(f"  singlepart: {settings.dicomweb_singlepart}")
            user_content = f"{message}\n\n[Current Study Context]\n" + "\n".join(ctx_parts)

    lc_messages.append(HumanMessage(content=user_content))

    # ── Shared mutable state accessed by both coroutines ──────────────────────
    # Using a dict avoids needing `nonlocal` inside nested async functions.
    state = {
        "final_answer": "",
        "tool_running": False,    # True while a tool thread is executing
        "tool_start_time": 0.0,   # monotonic time when the current tool started
        "report_study_uid": None, # set when generate_radiology_report is invoked
        # Token buffering: accumulate LLM tokens before sending SSE events so
        # the frontend receives larger, evenly-spaced chunks rather than a
        # rapid trickle of single-character events.
        "text_buffer": "",
        "text_buffer_ts": 0.0,    # monotonic time of the last buffer flush
    }
    # Flush the text buffer after this many chars or seconds (whichever comes first).
    TEXT_BUFFER_CHARS = 50
    TEXT_FLUSH_INTERVAL = 0.25   # seconds

    # SSE events are funnelled through this queue so the heartbeat and the
    # agent event loop can both produce output concurrently.
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    # ── Background coroutine: drain astream_events → queue ────────────────────
    async def _consume_agent_events() -> None:
        try:
            async for event in agent.astream_events(
                {"messages": lc_messages},
                version="v2",
                stream_mode="values",
            ):
                kind = event.get("event", "")
                data = event.get("data", {})

                if kind == "on_chat_model_stream":
                    chunk = data.get("chunk")
                    if chunk and hasattr(chunk, "content") and chunk.content:
                        token = chunk.content
                        state["final_answer"] += token
                        state["text_buffer"] += token
                        now = time.monotonic()
                        if (
                            len(state["text_buffer"]) >= TEXT_BUFFER_CHARS
                            or (now - state["text_buffer_ts"]) >= TEXT_FLUSH_INTERVAL
                        ):
                            await queue.put(_sse({"type": "observation", "content": state["text_buffer"]}))
                            state["text_buffer"] = ""
                            state["text_buffer_ts"] = now

                elif kind == "on_tool_start":
                    state["tool_running"] = True
                    state["tool_start_time"] = time.monotonic()
                    tool_name = event.get("name", "tool")
                    tool_input = data.get("input", {})
                    # Remember the study UID so we can save the final report.
                    if tool_name == "generate_radiology_report":
                        state["report_study_uid"] = (
                            tool_input.get("study_instance_uid")
                            or (study_context or {}).get("studyInstanceUID")
                        )
                    await queue.put(_sse({
                        "type": "tool_start",
                        "toolName": tool_name,
                        "toolInput": tool_input,
                        "content": f"Running tool: {tool_name}",
                    }))

                elif kind == "on_tool_end":
                    state["tool_running"] = False
                    tool_name = event.get("name", "tool")
                    tool_output = data.get("output", "")
                    download_url: str | None = None
                    try:
                        parsed = json.loads(tool_output)
                        display = parsed.get("message", tool_output)
                        download_url = parsed.get("download_url")
                    except Exception:
                        display = str(tool_output)[:500]
                    sse_payload: dict = {
                        "type": "tool_end",
                        "toolName": tool_name,
                        "toolOutput": display,
                        "content": display,
                    }
                    if download_url:
                        sse_payload["downloadUrl"] = download_url
                    await queue.put(_sse(sse_payload))

                elif kind == "on_chat_model_end":
                    output = data.get("output")
                    if output and hasattr(output, "content") and output.content:
                        state["final_answer"] = output.content

        finally:
            # Flush any tokens that didn't reach the chunk threshold.
            if state["text_buffer"]:
                await queue.put(_sse({"type": "observation", "content": state["text_buffer"]}))
                state["text_buffer"] = ""
            # Signal the consumer that we're done regardless of how we exited.
            await queue.put(None)

    # ── Background coroutine: heartbeat → queue ───────────────────────────────
    # Runs every HEARTBEAT_INTERVAL seconds; while a tool is active it emits a
    # tool_progress event so the UI shows elapsed time instead of a frozen spinner.
    HEARTBEAT_INTERVAL = 5  # seconds

    async def _heartbeat() -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            if state["tool_running"]:
                elapsed = int(time.monotonic() - state["tool_start_time"])
                await queue.put(_sse({
                    "type": "tool_progress",
                    "elapsed": elapsed,
                    "content": f"{elapsed}s elapsed",
                }))

    # ── Start both tasks and drain the queue ──────────────────────────────────
    agent_task = asyncio.create_task(_consume_agent_events())
    hb_task = asyncio.create_task(_heartbeat())

    try:
        while True:
            item = await queue.get()
            if item is None:  # sentinel: agent finished
                break
            yield item
    finally:
        hb_task.cancel()
        # Absorb the CancelledError so it doesn't propagate
        try:
            await hb_task
        except asyncio.CancelledError:
            pass

    yield _sse({"type": "final", "content": state["final_answer"]})

    # Persist the report and notify the frontend.
    # The save happens after the final event so the user already sees the text;
    # the report_saved event triggers a refetch that reveals the Reports tab.
    if state.get("report_study_uid") and state["final_answer"].strip():
        try:
            filepath, version = _save_report(
                state["report_study_uid"], state["final_answer"]
            )
            yield _sse({
                "type": "report_saved",
                "content": "",
                "filename": filepath.name,
                "version": version,
            })
        except Exception as exc:
            logger.error("Failed to save report: %s", exc)

    yield "data: [DONE]\n\n"


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"

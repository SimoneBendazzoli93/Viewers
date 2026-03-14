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

import json
from typing import AsyncIterator, Optional

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage
from langgraph.prebuilt import create_react_agent

from .llm_factory import create_llm, LLMProvider
from .tools import (
    run_totalsegmentator,
    run_nnunet,
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

When given a task, follow these priorities:

**Segmentation mask selection:**
- If the study context includes `availableSegmentations`, ALWAYS prefer those over running a new
  segmentation model. Pass the `seg_series_instance_uid` directly to `extract_radiomics`, or call
  `convert_dicom_seg_to_nifti` first to get the NIfTI mask path(s).
- Only call TotalSegmentator / nnU-Net if no DICOM SEG is available in the study.

**Radiomics:**
- When a DICOM SEG is available, pass its `seg_series_instance_uid` to `extract_radiomics` so
  features are computed per anatomical segment rather than on the whole volume.
- Report per-segment feature summaries (mean HU, volume, entropy, etc.) in the final answer.

**Report generation:**
- Reference DICOM SEG segment names by their label (e.g. "Liver", "Lesion_1") when describing findings.
- Include radiomics highlights per segment when available.

**General:**
- Think step-by-step about what tools you need.
- Always compile the report AFTER collecting all available data.
- Be precise with UIDs and parameters.
- If something fails, explain the error clearly and suggest alternatives.

Current study context will be provided in the user message when available.
The `availableSegmentations` field lists DICOM SEG series already loaded in the viewer.
"""


def _build_tools(segmentation_model: str) -> list:
    """Return tool list based on the active segmentation model."""
    seg_tools = {
        "totalsegmentator": run_totalsegmentator,
        "nnunet-autopet": run_nnunet,
    }
    active_seg = seg_tools.get(segmentation_model, run_totalsegmentator)

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
) -> AsyncIterator[str]:
    """
    Run the ReAct agent and yield Server-Sent Events (SSE) data strings.

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
    lc_messages: list = [SystemMessage(content=SYSTEM_PROMPT)]

    for h in history:
        role = h.get("role", "")
        content = h.get("content", "")
        if role == "user":
            lc_messages.append(HumanMessage(content=content))
        elif role == "assistant":
            lc_messages.append(AIMessage(content=content))

    # Append study context to the user message
    user_content = message
    if study_context:
        ctx_lines = "\n".join(f"  {k}: {v}" for k, v in study_context.items() if v)
        user_content = f"{message}\n\n[Current Study Context]\n{ctx_lines}"

    lc_messages.append(HumanMessage(content=user_content))

    final_answer = ""

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
                final_answer += token
                yield _sse({"type": "observation", "content": token})

        elif kind == "on_tool_start":
            tool_name = event.get("name", "tool")
            tool_input = data.get("input", {})
            yield _sse({
                "type": "tool_start",
                "toolName": tool_name,
                "toolInput": tool_input,
                "content": f"Running tool: {tool_name}",
            })

        elif kind == "on_tool_end":
            tool_name = event.get("name", "tool")
            tool_output = data.get("output", "")
            # Try to parse output for nicer display
            try:
                parsed = json.loads(tool_output)
                display = parsed.get("message", tool_output)
            except Exception:
                display = str(tool_output)[:500]

            yield _sse({
                "type": "tool_end",
                "toolName": tool_name,
                "toolOutput": display,
                "content": display,
            })

        elif kind == "on_chat_model_end":
            # Final message from the LLM (may be empty if tool call)
            output = data.get("output")
            if output and hasattr(output, "content") and output.content:
                final_answer = output.content

    # Emit final answer
    yield _sse({"type": "final", "content": final_answer})
    yield "data: [DONE]\n\n"


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"

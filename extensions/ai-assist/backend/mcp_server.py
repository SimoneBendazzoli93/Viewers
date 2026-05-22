"""
MCP (Model Context Protocol) server for OHIF AI Assistant.

Exposes the backend's medical imaging tools as MCP tools so any MCP-compatible
AI agent (Claude Desktop, Cursor, custom agents, etc.) can call them directly.

Usage
-----
Stdio transport (default — works with Claude Desktop, Cursor, mcp CLI):

    cd extensions/ai-assist/backend
    python mcp_server.py

HTTP/SSE transport (for remote agents or testing via browser):

    python mcp_server.py --transport sse --port 8001

Configuration
-------------
Same environment variables as the FastAPI backend (config.py):

    DICOMWEB_URL=http://your-orthanc/wado   # DICOMweb WADO-RS base URL
    OPENAI_API_KEY=sk-...                    # LLM key (for generate_report)
    ANTHROPIC_API_KEY=sk-ant-...             # alternative LLM key
    (see config.py for the full list)

Claude Desktop integration example (claude_desktop_config.json)
---------------------------------------------------------------
{
  "mcpServers": {
    "ohif-ai": {
      "command": "python",
      "args": ["/path/to/extensions/ai-assist/backend/mcp_server.py"],
      "env": {
        "DICOMWEB_URL": "http://localhost:8042/wado"
      }
    }
  }
}
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

# Ensure the backend package root is on sys.path when run directly.
sys.path.insert(0, str(Path(__file__).parent))

from fastmcp import FastMCP

from agent.tools.segmentation import (
    run_totalsegmentator,
    run_monet_segmentation,
    run_custom_segmentation,
)
from agent.tools.dicom_seg import convert_dicom_seg_to_nifti
from agent.tools.radiomics import extract_radiomics
from agent.tools.report import generate_radiology_report

# ---------------------------------------------------------------------------
# Server instance
# ---------------------------------------------------------------------------

mcp = FastMCP(
    name="OHIF AI Assistant",
    instructions=(
        "Medical imaging AI tools for the OHIF Viewer. "
        "These tools operate on DICOM data fetched via a DICOMweb endpoint "
        "and can perform anatomical segmentation, radiomics feature extraction, "
        "segmentation mask analysis, and structured radiology report generation. "
        "All tools accept a study_instance_uid and series_instance_uid to identify "
        "the target DICOM data, plus an optional dicomweb_url that overrides the "
        "server-side DICOMWEB_URL environment variable."
    ),
)

# ---------------------------------------------------------------------------
# Segmentation tools
# ---------------------------------------------------------------------------


@mcp.tool()
def segment_totalsegmentator(
    study_instance_uid: str,
    series_instance_uid: str,
    dicomweb_url: Optional[str] = None,
    structures: Optional[list[str]] = None,
    task: str = "total",
    fast: bool = False,
) -> str:
    """
    Run TotalSegmentator on a DICOM series to segment anatomical structures.

    TotalSegmentator supports 117 structures in CT images (organs, bones,
    muscles, vessels). Returns per-structure NIfTI mask paths and a success
    summary.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID to segment.
        dicomweb_url: DICOMweb WADO-RS base URL.
            Falls back to the DICOMWEB_URL environment variable.
        structures: Optional subset of structures to segment, e.g.
            ["liver", "spleen", "aorta"].  Omit to segment all 117.
        task: TotalSegmentator task name (default: "total").
        fast: Use --fast mode (lower resolution, ~3× faster inference).

    Returns:
        JSON string with "status", "output_dir", "structures_segmented", and
        "num_structures" on success, or "error" on failure.
    """
    return run_totalsegmentator.invoke({
        "study_instance_uid": study_instance_uid,
        "series_instance_uid": series_instance_uid,
        "dicomweb_url": dicomweb_url,
        "structures": structures,
        "task": task,
        "fast": fast,
    })


@mcp.tool()
def segment_monet_bundle(
    study_instance_uid: str,
    series_instance_uid: str,
    dicomweb_url: Optional[str] = None,
) -> str:
    """
    Run a Monet segmentation model on a DICOM series.

    Monet is a segmentation model that can be used to segment anatomical structures.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID.
        dicomweb_url: DICOMweb WADO-RS base URL.
            Falls back to the DICOMWEB_URL environment variable.

    Returns:
        JSON string with "status", "output_dir", and "files" on success,
        or "error" on failure.
    """
    return run_monet_segmentation.invoke({
        "study_instance_uid": study_instance_uid,
        "series_instance_uid": series_instance_uid,
        "dicomweb_url": dicomweb_url,
    })


@mcp.tool()
def segment_custom_endpoint(
    study_instance_uid: str,
    series_instance_uid: str,
    model_id: str,
    endpoint_url: str,
    dicomweb_url: Optional[str] = None,
) -> str:
    """
    Call a custom REST segmentation endpoint with a DICOM series.

    The endpoint must accept a POST request with JSON body:
        {
          "dicomweb_url": "<wado-rs base url>",
          "study_uid":    "<study instance uid>",
          "series_uid":   "<series instance uid>",
          "model_id":     "<model_id>"
        }
    and return JSON with at least a "status" field.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID.
        model_id: Identifier for the custom model (passed in the request body).
        endpoint_url: Full URL of the segmentation REST endpoint.
        dicomweb_url: DICOMweb WADO-RS base URL.
            Falls back to the DICOMWEB_URL environment variable.

    Returns:
        The raw JSON response from the custom endpoint.
    """
    return run_custom_segmentation.invoke({
        "study_instance_uid": study_instance_uid,
        "series_instance_uid": series_instance_uid,
        "model_id": model_id,
        "endpoint_url": endpoint_url,
        "dicomweb_url": dicomweb_url,
    })


# ---------------------------------------------------------------------------
# Segmentation analysis tool
# ---------------------------------------------------------------------------


@mcp.tool()
def analyze_segmentation_mask(
    study_instance_uid: str,
    seg_series_instance_uid: str,
    dicomweb_url: Optional[str] = None,
) -> str:
    """
    Fetch a DICOM SEG series and analyse its segmentation masks.

    Converts each segment to a binary NIfTI mask and computes:
    - Volume in mL per segment
    - Number of connected components per segment (with per-component sizes)
    - NIfTI file paths (pass these to extract_radiomics_features as mask_path)

    Use this tool to understand what structures are present in a segmentation
    and to obtain mask paths for downstream radiomics extraction.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        seg_series_instance_uid: Series Instance UID of the DICOM SEG series.
        dicomweb_url: DICOMweb WADO-RS base URL.
            Falls back to the DICOMWEB_URL environment variable.

    Returns:
        JSON string with "segments" (label → nifti path), "volumes_ml",
        "connected_components", and "num_segments".
    """
    return convert_dicom_seg_to_nifti.invoke({
        "study_instance_uid": study_instance_uid,
        "seg_series_instance_uid": seg_series_instance_uid,
        "dicomweb_url": dicomweb_url,
    })


# ---------------------------------------------------------------------------
# Radiomics tool
# ---------------------------------------------------------------------------


@mcp.tool()
def extract_radiomics_features(
    study_instance_uid: str,
    series_instance_uid: str,
    dicomweb_url: Optional[str] = None,
    mask_path: Optional[str] = None,
    seg_series_instance_uid: Optional[str] = None,
    feature_classes: Optional[list[str]] = None,
) -> str:
    """
    Extract radiomics features from a DICOM series using PyRadiomics.

    Mask resolution priority (highest to lowest):
      1. mask_path — explicit NIfTI file path (e.g. from analyze_segmentation_mask)
      2. seg_series_instance_uid — DICOM SEG series, auto-fetched and converted
      3. Whole-volume mask — used when no mask is provided

    Returns feature highlights inline and saves the full feature set as a CSV.

    Available feature_classes: "firstorder", "shape", "glcm", "glrlm",
    "glszm", "ngtdm", "gldm".

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID for the image series.
        dicomweb_url: DICOMweb WADO-RS base URL.
            Falls back to the DICOMWEB_URL environment variable.
        mask_path: Path to a NIfTI mask file (.nii.gz).
        seg_series_instance_uid: Series Instance UID of a DICOM SEG series
            to use as the segmentation mask.
        feature_classes: Feature classes to extract. Defaults to
            ["firstorder", "shape", "glcm", "glrlm", "glszm"].

    Returns:
        JSON string with "status", "highlights" (key features per segment),
        "csv_path", "total_features", and "segments".
    """
    return extract_radiomics.invoke({
        "study_instance_uid": study_instance_uid,
        "series_instance_uid": series_instance_uid,
        "dicomweb_url": dicomweb_url,
        "mask_path": mask_path,
        "seg_series_instance_uid": seg_series_instance_uid,
        "feature_classes": feature_classes,
    })


# ---------------------------------------------------------------------------
# Report generation tool
# ---------------------------------------------------------------------------


@mcp.tool()
def generate_radiology_report(
    study_instance_uid: str,
    series_instance_uid: str,
    modality: str = "CT",
    clinical_indication: Optional[str] = None,
    segmentation_results_path: Optional[str] = None,
    radiomics_results_path: Optional[str] = None,
    additional_findings: Optional[str] = None,
) -> str:
    """
    Generate a structured radiology report for the given study.

    Compiles patient/study metadata from cached DICOM files, segmentation
    findings, and radiomics features into a structured report using PATIENT
    INFORMATION / CLINICAL INDICATION / TECHNIQUE / FINDINGS / IMPRESSION
    sections.

    Call this after segment_totalsegmentator and/or extract_radiomics_features
    to produce a comprehensive report that includes quantitative findings.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID.
        modality: Imaging modality: "CT", "MR", "PET", etc.
        clinical_indication: Reason for the examination.
        segmentation_results_path: Path to the segmentation output directory
            (the "output_dir" value returned by the segmentation tools).
        radiomics_results_path: Path to a radiomics features JSON file
            (e.g. the features_<label>.json produced by extract_radiomics_features).
        additional_findings: Any extra clinical context to include.

    Returns:
        JSON string with "status", "report_prompt" (filled template text),
        and "patient_info".
    """
    return generate_radiology_report.invoke({
        "study_instance_uid": study_instance_uid,
        "series_instance_uid": series_instance_uid,
        "modality": modality,
        "clinical_indication": clinical_indication,
        "segmentation_results_path": segmentation_results_path,
        "radiomics_results_path": radiomics_results_path,
        "additional_findings": additional_findings,
    })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="OHIF AI Assistant MCP Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport type: 'stdio' (default, for Claude Desktop / CLI) or "
             "'sse' (HTTP server-sent events, for remote agents).",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind when using --transport sse (default: 127.0.0.1).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8001,
        help="Port to listen on when using --transport sse (default: 8001).",
    )
    args = parser.parse_args()

    if args.transport == "sse":
        mcp.run(transport="sse", host=args.host, port=args.port)
    else:
        mcp.run(transport="stdio")

"""
Segmentation tools for the AI agent.

Supports:
- TotalSegmentator (117 anatomical structures)
- nnU-Net models (e.g., AutoPET)
- Custom REST endpoint models
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

import httpx
from langchain_core.tools import tool

from config import settings
from .dicom_utils import fetch_series_to_dir


# ── TotalSegmentator ────────────────────────────────────────────────────────

@tool
def run_totalsegmentator(
    study_instance_uid: str,
    series_instance_uid: str,
    dicomweb_url: str,
    structures: Optional[list[str]] = None,
    task: str = "total",
    fast: bool = False,
) -> str:
    """
    Run TotalSegmentator on a DICOM series to segment anatomical structures.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID to segment.
        dicomweb_url: DICOMweb WADO-RS base URL to fetch the series from.
        structures: Optional list of specific structures to segment.
        task: TotalSegmentator task name (default: 'total').
        fast: Use fast mode (lower resolution, faster inference).

    Returns:
        JSON string with segmentation results including output paths and structure list.
    """
    series_dir = settings.dicom_cache_dir / study_instance_uid / series_instance_uid
    output_dir = settings.segmentation_output_dir / study_instance_uid / series_instance_uid / "totalsegmentator"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Fetch DICOM files
    dcm_files = fetch_series_to_dir(dicomweb_url, study_instance_uid, series_instance_uid, series_dir)
    if not dcm_files:
        return json.dumps({"error": "No DICOM files found for the requested series."})

    # Build TotalSegmentator command
    cmd = [
        "TotalSegmentator",
        "-i", str(series_dir),
        "-o", str(output_dir),
        "--task", task,
    ]
    if fast:
        cmd.append("--fast")
    if structures:
        cmd.extend(["--roi_subset", *structures])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            return json.dumps({
                "error": "TotalSegmentator failed",
                "stderr": result.stderr[-2000:],
            })
    except subprocess.TimeoutExpired:
        return json.dumps({"error": "TotalSegmentator timed out (>10 min)."})
    except FileNotFoundError:
        return json.dumps({
            "error": "TotalSegmentator is not installed. Install with: pip install TotalSegmentator"
        })

    # List output segmentation files
    seg_files = list(output_dir.glob("*.nii.gz"))
    structure_names = [f.stem.replace(".nii", "") for f in seg_files]

    return json.dumps({
        "status": "success",
        "output_dir": str(output_dir),
        "structures_segmented": structure_names,
        "num_structures": len(structure_names),
        "message": f"Successfully segmented {len(structure_names)} structures.",
    })


# ── nnU-Net ──────────────────────────────────────────────────────────────────

@tool
def run_nnunet(
    study_instance_uid: str,
    series_instance_uid: str,
    dicomweb_url: str,
    dataset_id: int = 220,
    configuration: str = "3d_fullres",
    fold: str = "all",
) -> str:
    """
    Run an nnU-Net model on a DICOM series.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID.
        dicomweb_url: DICOMweb WADO-RS base URL.
        dataset_id: nnU-Net dataset ID (default 220 = AutoPET).
        configuration: nnU-Net configuration (default '3d_fullres').
        fold: Fold to use (default 'all' = ensemble).

    Returns:
        JSON string with segmentation result.
    """
    series_dir = settings.dicom_cache_dir / study_instance_uid / series_instance_uid
    output_dir = (
        settings.segmentation_output_dir
        / study_instance_uid
        / series_instance_uid
        / f"nnunet_{dataset_id}"
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    dcm_files = fetch_series_to_dir(dicomweb_url, study_instance_uid, series_instance_uid, series_dir)
    if not dcm_files:
        return json.dumps({"error": "No DICOM files found."})

    try:
        import nnunetv2  # noqa: F401 – check install
    except ImportError:
        return json.dumps({
            "error": "nnunetv2 is not installed. Install with: pip install nnunetv2"
        })

    cmd = [
        "nnUNetv2_predict",
        "-i", str(series_dir),
        "-o", str(output_dir),
        "-d", str(dataset_id),
        "-c", configuration,
        "-f", fold,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
        if result.returncode != 0:
            return json.dumps({
                "error": "nnU-Net prediction failed",
                "stderr": result.stderr[-2000:],
            })
    except subprocess.TimeoutExpired:
        return json.dumps({"error": "nnU-Net prediction timed out."})

    seg_files = list(output_dir.glob("*.nii.gz"))
    return json.dumps({
        "status": "success",
        "output_dir": str(output_dir),
        "files": [f.name for f in seg_files],
        "message": f"nnU-Net inference complete. {len(seg_files)} output file(s).",
    })


# ── Custom REST endpoint segmentation ────────────────────────────────────────

@tool
def run_custom_segmentation(
    study_instance_uid: str,
    series_instance_uid: str,
    dicomweb_url: str,
    model_id: str,
    endpoint_url: str,
) -> str:
    """
    Call a custom REST segmentation endpoint with the series DICOM files.

    The endpoint is expected to accept a POST request with:
      - JSON body: { "dicomweb_url": str, "study_uid": str, "series_uid": str }
    and return:
      - JSON: { "status": "success"|"error", "message": str, ... }

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID.
        dicomweb_url: DICOMweb source URL.
        model_id: Identifier of the custom model.
        endpoint_url: Full URL of the segmentation REST endpoint.

    Returns:
        JSON string with the endpoint response.
    """
    payload = {
        "dicomweb_url": dicomweb_url,
        "study_uid": study_instance_uid,
        "series_uid": series_instance_uid,
        "model_id": model_id,
    }
    try:
        resp = httpx.post(endpoint_url, json=payload, timeout=600.0)
        resp.raise_for_status()
        return resp.text
    except httpx.HTTPStatusError as exc:
        return json.dumps({
            "error": f"Endpoint returned HTTP {exc.response.status_code}",
            "detail": exc.response.text[:1000],
        })
    except Exception as exc:
        return json.dumps({"error": str(exc)})

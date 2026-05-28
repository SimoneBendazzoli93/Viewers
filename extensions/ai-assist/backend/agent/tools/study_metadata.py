"""
Study metadata tool — list series in a study via QIDO-RS.
"""
from __future__ import annotations

import json
from typing import Optional

from langchain_core.tools import tool

from .dicom_utils import fetch_study_series_metadata, resolve_dicomweb_url


@tool
def get_study_metadata(
    study_instance_uid: str,
    dicomweb_url: Optional[str] = None,
) -> str:
    """
    List all DICOM series in a study with modality and series instance UIDs.

    Use this tool when you need to know what imaging series exist in the study
    (modalities, descriptions, series numbers) before choosing which series to
    segment, analyze, or report on.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        dicomweb_url: DICOMweb WADO-RS base URL (``wadoRoot`` from study context).
            Optional — falls back to the server's DICOMWEB_WADO_ROOT env var.

    Returns:
        JSON string with study_instance_uid, series_count, and a series list.
        Each series entry contains series_instance_uid, modality, series_description,
        and series_number.
    """
    try:
        url = resolve_dicomweb_url(dicomweb_url)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    try:
        metadata = fetch_study_series_metadata(
            study_uid=study_instance_uid,
            dicomweb_url=url,
        )
        return json.dumps(metadata)
    except Exception as exc:
        return json.dumps({
            "error": "Failed to fetch study metadata",
            "detail": str(exc),
            "study_instance_uid": study_instance_uid,
        })

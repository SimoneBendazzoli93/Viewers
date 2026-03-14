"""
Utility functions for fetching and handling DICOM data from a DICOMweb server.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Optional

import pydicom
from dicomweb_client.api import DICOMwebClient

from config import settings


def resolve_dicomweb_url(provided: str | None) -> str:
    """
    Return *provided* if non-empty, otherwise fall back to the server-level
    ``DICOMWEB_URL`` environment variable.  Raises ``ValueError`` if neither
    is available so callers get a clear error instead of a silent None.
    """
    url = provided or settings.dicomweb_url
    if not url:
        raise ValueError(
            "No DICOMweb URL available. Either pass dicomweb_url explicitly "
            "or set DICOMWEB_URL in the backend environment."
        )
    return url


def fetch_series_to_dir(
    dicomweb_url: str,
    study_uid: str,
    series_uid: str,
    output_dir: Path,
    auth_token: Optional[str] = None,
) -> list[Path]:
    """
    Fetch all instances for a series from a DICOMweb WADO-RS endpoint.
    Returns a list of saved DICOM file paths.
    """
    headers = {}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"

    client = DICOMwebClient(url=dicomweb_url, headers=headers)
    instances = client.retrieve_series(
        study_instance_uid=study_uid,
        series_instance_uid=series_uid,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for i, ds in enumerate(instances):
        path = output_dir / f"instance_{i:05d}.dcm"
        ds.save_as(str(path))
        saved.append(path)

    return sorted(saved)


def get_study_metadata(
    dicomweb_url: str,
    study_uid: str,
    auth_token: Optional[str] = None,
) -> dict:
    """Return study-level metadata as a dict."""
    headers = {}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"

    client = DICOMwebClient(url=dicomweb_url, headers=headers)
    series_list = client.search_for_series(study_instance_uid=study_uid)
    return {
        "study_instance_uid": study_uid,
        "series": [
            {
                "SeriesInstanceUID": s.get("0020000E", {}).get("Value", [""])[0],
                "Modality": s.get("00080060", {}).get("Value", [""])[0],
                "SeriesDescription": s.get("0008103E", {}).get("Value", [""])[0],
                "SeriesNumber": s.get("00200011", {}).get("Value", [None])[0],
            }
            for s in series_list
        ],
    }


def dicom_dir_to_patient_info(dcm_dir: Path) -> dict:
    """Read first DICOM file in a directory and extract patient/study info."""
    dcm_files = sorted(dcm_dir.glob("*.dcm"))
    if not dcm_files:
        return {}
    ds = pydicom.dcmread(str(dcm_files[0]), stop_before_pixels=True)
    return {
        "PatientName": str(getattr(ds, "PatientName", "")),
        "PatientID": str(getattr(ds, "PatientID", "")),
        "StudyDate": str(getattr(ds, "StudyDate", "")),
        "Modality": str(getattr(ds, "Modality", "")),
        "StudyDescription": str(getattr(ds, "StudyDescription", "")),
        "SeriesDescription": str(getattr(ds, "SeriesDescription", "")),
        "InstitutionName": str(getattr(ds, "InstitutionName", "")),
    }

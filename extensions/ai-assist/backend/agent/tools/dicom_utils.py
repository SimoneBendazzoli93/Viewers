"""
Utility functions for fetching and handling DICOM data from a DICOMweb server.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import pydicom
from dicomweb_client.api import DICOMwebClient

from config import settings


# ── DICOMweb configuration dataclass ─────────────────────────────────────────

@dataclass
class DicomWebConfig:
    """
    Resolved DICOMweb endpoint configuration.

    Mirrors the OHIF data source configuration fields so values can be
    copied directly from appConfig.js / default.js.
    """
    wado_root: str                              # WADO-RS base URL (retrieve)
    qido_root: str = ""                         # QIDO-RS base URL (search)
    wado_uri_root: str = ""                     # WADO-URI base URL
    static_wado: bool = False                   # server serves static files
    singlepart: list[str] = field(default_factory=list)  # e.g. ["bulkdata", "video"]
    omit_quotation_for_multipart: bool = True   # content-negotiation tweak
    auth_token: Optional[str] = None


def resolve_dicomweb_config(
    provided_wado_root: str | None = None,
    provided_url: str | None = None,
) -> DicomWebConfig:
    """
    Build a :class:`DicomWebConfig` from the provided values, falling back to
    environment variables.

    Resolution order for the WADO-RS root:
      1. *provided_wado_root*  (``wadoRoot`` from the study context)
      2. *provided_url*        (``dicomwebUrl`` from the study context, legacy)
      3. ``DICOMWEB_WADO_ROOT`` env var
      4. ``DICOMWEB_URL`` env var (backward-compat shortcut)

    Raises ``ValueError`` if no URL can be determined.
    """
    wado_root = (
        provided_wado_root
        or provided_url
        or settings.dicomweb_wado_root
        or settings.dicomweb_url
    )
    if not wado_root:
        raise ValueError(
            "No DICOMweb WADO-RS URL available. "
            "Pass wadoRoot / dicomweb_url explicitly or set DICOMWEB_WADO_ROOT "
            "(or DICOMWEB_URL) in the backend environment."
        )

    qido_root = settings.dicomweb_qido_root or settings.dicomweb_url or wado_root
    wado_uri_root = settings.dicomweb_wado_uri_root or settings.dicomweb_url or wado_root

    singlepart: list[str] = []
    if settings.dicomweb_singlepart:
        singlepart = [s.strip() for s in settings.dicomweb_singlepart.split(",") if s.strip()]

    return DicomWebConfig(
        wado_root=wado_root,
        qido_root=qido_root,
        wado_uri_root=wado_uri_root,
        static_wado=settings.dicomweb_static_wado,
        singlepart=singlepart,
        omit_quotation_for_multipart=settings.dicomweb_omit_quotation_for_multipart,
    )


# Thin wrapper kept for backward compatibility with callers that just need a URL string.
def resolve_dicomweb_url(provided: str | None) -> str:
    """Return the WADO-RS root URL, raising ValueError if unavailable."""
    cfg = resolve_dicomweb_config(provided_wado_root=provided)
    return cfg.wado_root


# ── DICOMwebClient factory ────────────────────────────────────────────────────

def _client_headers(cfg: DicomWebConfig) -> dict[str, str]:
    headers: dict[str, str] = {}
    if cfg.auth_token:
        headers["Authorization"] = f"Bearer {cfg.auth_token}"
    # For static WADO servers the Accept header must be permissive; the server
    # won't do content negotiation, it just serves pre-generated files.
    if cfg.static_wado:
        headers.setdefault(
            "Accept",
            'multipart/related; type="application/octet-stream", */*',
        )
    return headers


def _build_client(cfg: DicomWebConfig) -> DICOMwebClient:
    """Build a WADO-RS :class:`DICOMwebClient`."""
    return DICOMwebClient(url=cfg.wado_root, headers=_client_headers(cfg))


def _build_qido_client(cfg: DicomWebConfig) -> DICOMwebClient:
    """Build a QIDO-RS :class:`DICOMwebClient` for search/metadata operations."""
    qido_root = cfg.qido_root or cfg.wado_root
    return DICOMwebClient(url=qido_root, headers=_client_headers(cfg))


def _qido_tag_value(dataset: dict, tag: str, keyword: str, default: str = "") -> str:
    """Extract a single string value from a QIDO-RS JSON dataset entry."""
    entry = dataset.get(keyword) or dataset.get(tag) or {}
    if not isinstance(entry, dict):
        return str(entry) if entry is not None else default
    values = entry.get("Value") or []
    if not values:
        return default
    value = values[0]
    return str(value) if value is not None else default


# ── Public helpers ────────────────────────────────────────────────────────────

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

    *dicomweb_url* is the WADO-RS base URL (``wadoRoot``).
    """
    cfg = resolve_dicomweb_config(provided_wado_root=dicomweb_url)
    cfg.auth_token = auth_token
    client = _build_client(cfg)

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


def fetch_study_series_metadata(
    study_uid: str,
    dicomweb_url: str | None = None,
    auth_token: Optional[str] = None,
) -> dict:
    """
    Query QIDO-RS for all series in a study.

    Returns a dict with ``study_instance_uid`` and a ``series`` list; each entry
    includes ``series_instance_uid``, ``modality``, and optional description/number.
    """
    cfg = resolve_dicomweb_config(provided_wado_root=dicomweb_url)
    cfg.auth_token = auth_token
    client = _build_qido_client(cfg)

    series_list = client.search_for_series(study_instance_uid=study_uid)
    series_entries: list[dict] = []
    for s in series_list:
        series_uid = _qido_tag_value(s, "0020000E", "SeriesInstanceUID")
        if not series_uid:
            continue
        series_number_raw = _qido_tag_value(s, "00200011", "SeriesNumber")
        series_entries.append({
            "series_instance_uid": series_uid,
            "modality": _qido_tag_value(s, "00080060", "Modality"),
            "series_description": _qido_tag_value(s, "0008103E", "SeriesDescription"),
            "series_number": int(series_number_raw) if series_number_raw.isdigit() else series_number_raw,
        })

    return {
        "study_instance_uid": study_uid,
        "series_count": len(series_entries),
        "series": series_entries,
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

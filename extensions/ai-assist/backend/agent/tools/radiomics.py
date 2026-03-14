"""
Radiomics feature extraction tool using PyRadiomics.
"""
from __future__ import annotations

import csv
import json
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
from langchain_core.tools import tool

from config import settings
from .dicom_utils import fetch_series_to_dir, resolve_dicomweb_url
from .dicom_seg import convert_seg_file_to_nifti


def _convert_dcm_to_nifti(dcm_dir: Path, out_path: Path) -> bool:
    """Convert a DICOM series directory to a NIfTI file using SimpleITK."""
    try:
        import SimpleITK as sitk

        reader = sitk.ImageSeriesReader()
        dicom_names = reader.GetGDCMSeriesFileNames(str(dcm_dir))
        if not dicom_names:
            return False
        reader.SetFileNames(dicom_names)
        image = reader.Execute()
        sitk.WriteImage(image, str(out_path))
        return True
    except Exception:
        return False


@tool
def extract_radiomics(
    study_instance_uid: str,
    series_instance_uid: str,
    dicomweb_url: Optional[str] = None,
    mask_path: Optional[str] = None,
    seg_series_instance_uid: Optional[str] = None,
    feature_classes: Optional[list[str]] = None,
) -> str:
    """
    Extract radiomics features from a DICOM series using PyRadiomics.

    Mask priority (highest to lowest):
      1. mask_path  – explicit NIfTI mask file path (e.g. from a prior
                      convert_dicom_seg_to_nifti call)
      2. seg_series_instance_uid – a DICOM SEG series in the same study;
                      the tool will fetch and convert it automatically,
                      then run radiomics per segment
      3. whole-volume mask – computed when no mask is available

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID for the image series.
        dicomweb_url: DICOMweb WADO-RS base URL to fetch the image.
            Optional — falls back to the server's DICOMWEB_URL env var.
        mask_path: Optional explicit path to a NIfTI (.nii.gz) mask file.
        seg_series_instance_uid: Optional Series Instance UID of a DICOM SEG
            series in the same study to use as the segmentation mask.
        feature_classes: Optional list of PyRadiomics feature classes to
            extract. Defaults to ['firstorder', 'shape', 'glcm', 'glrlm', 'glszm'].

    Returns:
        JSON string with extracted features or error message.
        When a DICOM SEG is used, results are returned per segment.
    """
    try:
        url = resolve_dicomweb_url(dicomweb_url)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})
    try:
        import radiomics
        from radiomics import featureextractor
    except ImportError:
        return json.dumps({
            "error": "PyRadiomics is not installed. Install with: pip install pyradiomics"
        })

    try:
        import SimpleITK as sitk
    except ImportError:
        return json.dumps({
            "error": "SimpleITK is not installed. Install with: pip install SimpleITK"
        })

    series_dir = settings.dicom_cache_dir / study_instance_uid / series_instance_uid
    radiomics_dir = settings.radiomics_output_dir / study_instance_uid / series_instance_uid
    radiomics_dir.mkdir(parents=True, exist_ok=True)

    # Fetch and convert image series
    dcm_files = fetch_series_to_dir(url, study_instance_uid, series_instance_uid, series_dir)
    if not dcm_files:
        return json.dumps({"error": "No DICOM files found for the requested series."})

    image_nifti = radiomics_dir / "image.nii.gz"
    if not _convert_dcm_to_nifti(series_dir, image_nifti):
        return json.dumps({"error": "Failed to convert DICOM series to NIfTI."})

    # ── Resolve mask(s) ──────────────────────────────────────────────────────
    # Priority: explicit mask_path > DICOM SEG series > whole-volume fallback

    masks: dict[str, str] = {}  # label → nifti path

    if mask_path and Path(mask_path).exists():
        masks["provided_mask"] = mask_path

    elif seg_series_instance_uid:
        seg_cache_dir = settings.dicom_cache_dir / study_instance_uid / seg_series_instance_uid
        seg_output_dir = (
            settings.segmentation_output_dir
            / study_instance_uid
            / seg_series_instance_uid
            / "dicom_seg"
        )
        seg_dcm_files = fetch_series_to_dir(
            url, study_instance_uid, seg_series_instance_uid, seg_cache_dir
        )
        if not seg_dcm_files:
            return json.dumps({"error": f"No DICOM SEG files found for series {seg_series_instance_uid}."})
        try:
            masks = convert_seg_file_to_nifti(seg_dcm_files[0], seg_output_dir)
        except Exception as exc:
            return json.dumps({"error": f"DICOM SEG conversion failed: {exc}"})
        if not masks:
            return json.dumps({"error": "DICOM SEG file contained no segments."})

    else:
        # Whole-volume mask
        img = sitk.ReadImage(str(image_nifti))
        mask_arr = np.ones(sitk.GetArrayFromImage(img).shape, dtype=np.uint8)
        mask_img = sitk.GetImageFromArray(mask_arr)
        mask_img.CopyInformation(img)
        whole_mask_path = str(radiomics_dir / "whole_mask.nii.gz")
        sitk.WriteImage(mask_img, whole_mask_path)
        masks["whole_volume"] = whole_mask_path

    # ── Configure PyRadiomics extractor ──────────────────────────────────────
    if settings.radiomics_params_file and settings.radiomics_params_file.exists():
        extractor = featureextractor.RadiomicsFeatureExtractor(str(settings.radiomics_params_file))
    else:
        extractor = featureextractor.RadiomicsFeatureExtractor()
        selected_classes = feature_classes or ["firstorder", "shape", "glcm", "glrlm", "glszm"]
        extractor.disableAllFeatures()
        for cls in selected_classes:
            extractor.enableFeatureClassByName(cls)

    # ── Run extraction per segment ────────────────────────────────────────────
    per_segment: dict[str, dict] = {}

    for label, mask_file in masks.items():
        try:
            result = extractor.execute(str(image_nifti), str(mask_file))
        except Exception as exc:
            per_segment[label] = {"error": str(exc)}
            continue

        features = {
            k: float(v) if hasattr(v, "item") else str(v)
            for k, v in result.items()
            if not k.startswith("diagnostics_")
        }
        per_segment[label] = features

        seg_json = radiomics_dir / f"features_{label}.json"
        seg_json.write_text(json.dumps(features, indent=2))

    total_features = sum(len(v) for v in per_segment.values() if "error" not in v)
    mask_source = (
        "DICOM SEG" if seg_series_instance_uid
        else ("provided mask" if mask_path else "whole volume")
    )

    # ── Write CSV with all extracted features ─────────────────────────────────
    csv_path = radiomics_dir / "radiomics_features.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "study_instance_uid", "series_instance_uid", "mask_source",
            "segment", "feature_class", "feature_name", "value",
        ])
        for segment_label, features in per_segment.items():
            if "error" in features:
                continue
            for feat_key, feat_val in features.items():
                parts = feat_key.split("_")
                feature_class = parts[1] if len(parts) >= 3 else "unknown"
                feature_name = "_".join(parts[2:]) if len(parts) >= 3 else feat_key
                writer.writerow([
                    study_instance_uid,
                    series_instance_uid,
                    mask_source,
                    segment_label,
                    feature_class,
                    feature_name,
                    feat_val,
                ])

    # ── Build compact highlights for the LLM ─────────────────────────────────
    # The full feature set lives in the CSV. The tool return only includes a
    # curated subset so the SSE event, the LangGraph ToolMessage context, and
    # React state all stay small (a few KB instead of 50 KB+).
    _HIGHLIGHT_NAMES = frozenset({
        # Shape
        "Elongation", "Sphericity", "MeshVolume", "VoxelVolume",
        # First-order
        "Mean", "Median", "StandardDeviation", "Entropy", "Skewness",
        # GLCM
        "Correlation", "JointEnergy", "Contrast",
        # GLRLM
        "RunLengthNonUniformity", "ShortRunEmphasis",
        # GLSZM
        "ZoneVariance",
    })
    highlights: dict[str, dict] = {}
    for label, features in per_segment.items():
        if "error" in features:
            highlights[label] = {"error": features["error"]}
            continue
        highlights[label] = {
            k: v for k, v in features.items()
            if "_".join(k.split("_")[2:]) in _HIGHLIGHT_NAMES
        }

    download_url = f"/api/files/download?path={csv_path}"

    return json.dumps({
        "status": "success",
        "mask_source": mask_source,
        "segments": list(per_segment.keys()),
        "num_segments": len(per_segment),
        "total_features": total_features,
        "csv_path": str(csv_path),
        "download_url": download_url,
        "highlights": highlights,
        "message": (
            f"Extracted {total_features} radiomics features for "
            f"{len(per_segment)} segment(s) ({mask_source}): "
            f"{', '.join(per_segment.keys())}. "
            f"Full results in CSV (download_url). Key highlights included."
        ),
    })

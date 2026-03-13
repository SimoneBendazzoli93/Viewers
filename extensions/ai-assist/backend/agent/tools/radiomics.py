"""
Radiomics feature extraction tool using PyRadiomics.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
from langchain_core.tools import tool

from config import settings
from .dicom_utils import fetch_series_to_dir


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
    dicomweb_url: str,
    mask_path: Optional[str] = None,
    feature_classes: Optional[list[str]] = None,
) -> str:
    """
    Extract radiomics features from a DICOM series using PyRadiomics.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID for the image series.
        dicomweb_url: DICOMweb WADO-RS base URL to fetch the image.
        mask_path: Optional path to a NIfTI (.nii.gz) mask file.
                   If not provided, a whole-volume mask is used.
        feature_classes: Optional list of PyRadiomics feature classes to extract.
                         Defaults to ['firstorder', 'shape', 'glcm', 'glrlm', 'glszm'].

    Returns:
        JSON string with extracted features or error message.
    """
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

    # Fetch DICOM files
    dcm_files = fetch_series_to_dir(dicomweb_url, study_instance_uid, series_instance_uid, series_dir)
    if not dcm_files:
        return json.dumps({"error": "No DICOM files found for the requested series."})

    # Convert to NIfTI
    image_nifti = radiomics_dir / "image.nii.gz"
    if not _convert_dcm_to_nifti(series_dir, image_nifti):
        return json.dumps({"error": "Failed to convert DICOM series to NIfTI."})

    # Build or load mask
    if mask_path and Path(mask_path).exists():
        mask_nifti = mask_path
    else:
        # Create a whole-volume binary mask
        img = sitk.ReadImage(str(image_nifti))
        mask_arr = np.ones(sitk.GetArrayFromImage(img).shape, dtype=np.uint8)
        mask_img = sitk.GetImageFromArray(mask_arr)
        mask_img.CopyInformation(img)
        mask_nifti = str(radiomics_dir / "whole_mask.nii.gz")
        sitk.WriteImage(mask_img, mask_nifti)

    # Configure extractor
    params: dict = {}
    if settings.radiomics_params_file and settings.radiomics_params_file.exists():
        extractor = featureextractor.RadiomicsFeatureExtractor(str(settings.radiomics_params_file))
    else:
        extractor = featureextractor.RadiomicsFeatureExtractor()
        selected_classes = feature_classes or ["firstorder", "shape", "glcm", "glrlm", "glszm"]
        extractor.disableAllFeatures()
        for cls in selected_classes:
            extractor.enableFeatureClassByName(cls)

    try:
        result = extractor.execute(str(image_nifti), str(mask_nifti))
    except Exception as exc:
        return json.dumps({"error": f"Radiomics extraction failed: {exc}"})

    # Convert to JSON-serialisable dict
    features = {
        k: float(v) if hasattr(v, "item") else str(v)
        for k, v in result.items()
        if not k.startswith("diagnostics_")
    }

    # Save to file
    output_json = radiomics_dir / "features.json"
    output_json.write_text(json.dumps(features, indent=2))

    return json.dumps({
        "status": "success",
        "num_features": len(features),
        "output_file": str(output_json),
        "features": features,
        "message": f"Extracted {len(features)} radiomics features.",
    })

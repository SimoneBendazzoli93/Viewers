"""
DICOM SEG to NIfTI conversion tool.

Fetches a DICOM SEG series from a DICOMweb endpoint and converts each
segment to a binary NIfTI mask file, properly aligned to the image volume
geometry (spacing, origin, direction cosines).

Uses highdicom for robust SEG parsing; falls back to a pydicom-only
implementation if highdicom is not installed.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional
from scipy.ndimage.measurements import label as scipy_label
import numpy as np
import pydicom
from langchain_core.tools import tool

from config import settings
from .dicom_utils import fetch_series_to_dir, resolve_dicomweb_url
import SimpleITK as sitk
import highdicom as hd
logger = logging.getLogger(__name__)

def convert_seg_file_to_nifti(seg_file_path, output_nifti_path, ref_dicom_dir):
    """
    Converts a DICOM SEG file to a NIfTI file using highdicom, perfectly
    matching the spatial dimensions of the reference DICOM series.
    """
    print(f"Loading reference DICOM series from: {ref_dicom_dir}")

    # 1. Use SimpleITK to find and sort the reference DICOM files properly
    series_reader = sitk.ImageSeriesReader()
    print(f"Reference directory: {ref_dicom_dir}")
    dicom_names = series_reader.GetGDCMSeriesFileNames(str(ref_dicom_dir))
    if not dicom_names:
        raise FileNotFoundError(f"No DICOM files found in reference directory: {ref_dicom_dir}")

    # Read the full 3D reference image to get spatial metadata
    series_reader.SetFileNames(dicom_names)
    ref_image = series_reader.Execute()
    print(f"Reference volume size: {ref_image.GetSize()}")

    # 2. Extract SOPInstanceUIDs in the exact order SimpleITK sorted them.
    # This guarantees the segmentation's Z-axis will strictly match the NIfTI reference volume.
    print("Extracting SOPInstanceUIDs for accurate slice alignment...")
    source_uids = []
    for f in dicom_names:
        # We only need the metadata, so stop_before_pixels saves memory and time
        dcm = pydicom.dcmread(f, stop_before_pixels=True)
        source_uids.append(dcm.SOPInstanceUID)

    # 3. Read the DICOM SEG file using highdicom
    print(f"Loading DICOM SEG: {seg_file_path}")
    masks = {}
    seg = hd.seg.segread(seg_file_path)
    for seg_num in seg.segment_numbers:
        desc = seg.get_segment_description(seg_num)
        label = desc.segment_label or f"Segment_{seg_num}"
        if (output_nifti_path / f"seg_{seg_num}_{label}.nii.gz").exists():
            print(f"Segment {seg_num} found in {output_nifti_path}")
            masks[label] = str(output_nifti_path / f"seg_{seg_num}_{label}.nii.gz")
            continue
        # 4. Extract the segmentation array
        print("Mapping DICOM SEG frames to source reference slices...")
        # combine_segments=True merges all classes into a single 3D integer label mask
        # The output array shape is automatically (slices, rows, columns)
        mask_array = seg.get_pixels_by_source_instance(
            source_sop_instance_uids=source_uids,
            segment_numbers=[seg_num],
            combine_segments=True,
            skip_overlap_checks=True  # Allows merging safely even if structures spatially overlap
        )

        # Ensure it's treated as unsigned integers for NIfTI segmentation labels
        mask_array = mask_array.astype(np.uint16)

        # 5. Convert the resulting NumPy array back into a SimpleITK image
        seg_image = sitk.GetImageFromArray(mask_array)

        # 6. Copy spatial metadata (Origin, Spacing, Direction/Cosines) from the reference image
        seg_image.CopyInformation(ref_image)

        # 7. Write the aligned mask to a NIfTI file
        sitk.WriteImage(seg_image, output_nifti_path / f"seg_{seg_num}_{label}.nii.gz")
        print(f"Successfully saved perfectly aligned NIfTI mask to: {output_nifti_path}")
        masks[label] = str(output_nifti_path / f"seg_{seg_num}_{label}.nii.gz")
    return masks



# ── LangChain tool ────────────────────────────────────────────────────────────

@tool
def convert_dicom_seg_to_nifti(
    study_instance_uid: str,
    seg_series_instance_uid: str,
    img_series_instance_uid: str,
    dicomweb_url: Optional[str] = None,
) -> str:
    """
    Fetch a DICOM SEG series from DICOMweb and convert each segment to a
    binary NIfTI mask file (.nii.gz), one file per anatomical structure.

    Use this tool BEFORE running extract_radiomics when a DICOM SEG is
    available in the study, so that region-specific radiomics features can
    be computed.
    The image series is the series that contains the image that was used to generate the segmentation mask.
    It is used to get the spatial metadata of the image that was used to generate the segmentation mask.
    This is crucial for the correct alignment of the segmentation mask to the image.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        seg_series_instance_uid: Series Instance UID of the DICOM SEG series.
        img_series_instance_uid: Series Instance UID of the DICOM image series.
        dicomweb_url: DICOMweb WADO-RS base URL (e.g. http://orthanc:8042/wado).
            Optional — falls back to the server's DICOMWEB_URL env var.

    Returns:
        JSON with segment labels and the path to each NIfTI mask file.
    """
    try:
        url = resolve_dicomweb_url(dicomweb_url)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    seg_dir = settings.segmentation_output_dir / study_instance_uid / img_series_instance_uid
    output_dir = settings.segmentation_output_dir / study_instance_uid / img_series_instance_uid
    image_dir = settings.dicom_cache_dir / study_instance_uid / img_series_instance_uid

    dcm_files = fetch_series_to_dir(url, study_instance_uid, seg_series_instance_uid, seg_dir)
    if not dcm_files:
        return json.dumps({"error": "No DICOM SEG files found for the given series UID."})

    # A DICOM SEG series is typically a single multi-frame file
    seg_file = dcm_files[0]

    try:
        masks = convert_seg_file_to_nifti(seg_file, output_dir, image_dir)
        volumes_ml = {}
        connected_components = {}
        for label, path in masks.items():
            mask = sitk.ReadImage(path)
            volume = mask.GetSpacing()[0] * mask.GetSpacing()[1] * mask.GetSpacing()[2] * np.sum(sitk.GetArrayFromImage(mask)) / 1000.0
            volumes_ml[label] = volume
            structure = np.ones((3, 3, 3), dtype=np.int32)
            labeled_array, num_features = scipy_label(sitk.GetArrayFromImage(mask), structure)
            connected_components[label] = {"total": num_features}
            for i in range(1, num_features + 1):
                connected_components[label][f"component_{i}_size_voxels"] = int(np.sum(labeled_array == i))
                connected_components[label][f"component_{i}_size_ml"] = int(connected_components[label][f"component_{i}_size_voxels"] * mask.GetSpacing()[0] * mask.GetSpacing()[1] * mask.GetSpacing()[2] / 1000.0)

    except Exception as exc:
        logger.exception("DICOM SEG conversion error")
        return json.dumps({"error": f"Conversion failed: {exc}"})

    if not masks:
        return json.dumps({"error": "No segments found in the DICOM SEG file."})

    return json.dumps({
        "status": "success",
        "seg_series_instance_uid": seg_series_instance_uid,
        "segments": {label: path for label, path in masks.items()},
        "num_segments": len(masks),
        "volumes_ml": volumes_ml,
        "connected_components": connected_components,
        "message": (
            f"Converted {len(masks)} segment(s): {', '.join(masks.keys())}. "
            "Pass the mask path(s) to extract_radiomics."
        ),
    })

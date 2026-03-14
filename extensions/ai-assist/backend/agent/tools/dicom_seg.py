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

import numpy as np
import pydicom
from langchain_core.tools import tool

from config import settings
from .dicom_utils import fetch_series_to_dir, resolve_dicomweb_url
import SimpleITK as sitk
logger = logging.getLogger(__name__)


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _iop_to_direction(iop: list[float]) -> tuple[float, ...]:
    """
    Build a 9-element direction cosine tuple (row, col, normal) from a
    6-element ImageOrientationPatient list.
    """
    row = np.array(iop[:3])
    col = np.array(iop[3:])
    normal = np.cross(row, col)
    return tuple(row.tolist() + col.tolist() + normal.tolist())


def _convert_seg_pydicom(
    seg_dcm: pydicom.Dataset,
    output_dir: Path,
) -> dict[str, str]:
    """
    Pure pydicom + SimpleITK DICOM SEG → NIfTI conversion.

    Returns a dict mapping segment label → absolute NIfTI path.
    """
    import SimpleITK as sitk

    pixel_array: np.ndarray = seg_dcm.pixel_array  # (frames, rows, cols) or (rows, cols)
    if pixel_array.ndim == 2:
        pixel_array = pixel_array[np.newaxis, ...]

    n_frames, rows, cols = pixel_array.shape

    # ── Segment metadata ──
    segments: dict[int, str] = {}
    for seg_desc in getattr(seg_dcm, "SegmentSequence", []):
        seg_num = int(seg_desc.SegmentNumber)
        label = getattr(seg_desc, "SegmentLabel", f"Segment_{seg_num}")
        segments[seg_num] = label

    if not segments:
        segments[1] = "Segment_1"

    # ── Per-frame geometry ──
    frame_to_seg: dict[int, int] = {}
    ipp_list: list[list[float]] = []
    iop: list[float] = [1, 0, 0, 0, 1, 0]
    pixel_spacing: list[float] = [1.0, 1.0]

    per_frame = getattr(seg_dcm, "PerFrameFunctionalGroupsSequence", None)
    if per_frame:
        for i, fg in enumerate(per_frame):
            # Segment assignment
            seg_id_seq = getattr(fg, "SegmentIdentificationSequence", None)
            if seg_id_seq:
                frame_to_seg[i] = int(seg_id_seq[0].ReferencedSegmentNumber)
            else:
                frame_to_seg[i] = 1

            # Image position
            plane_pos = getattr(fg, "PlanePositionSequence", None)
            if plane_pos:
                ipp_list.append([float(v) for v in plane_pos[0].ImagePositionPatient])
            else:
                ipp_list.append([0.0, 0.0, float(i)])

            # Orientation (only need once)
            if i == 0:
                plane_ori = getattr(fg, "PlaneOrientationSequence", None)
                if plane_ori:
                    iop = [float(v) for v in plane_ori[0].ImageOrientationPatient]
                pix_meas = getattr(fg, "PixelMeasuresSequence", None)
                if pix_meas:
                    pixel_spacing = [float(v) for v in pix_meas[0].PixelSpacing]
    else:
        # Fallback: shared functional groups or top-level tags
        shared = getattr(seg_dcm, "SharedFunctionalGroupsSequence", [None])[0]
        if shared:
            plane_ori = getattr(shared, "PlaneOrientationSequence", None)
            if plane_ori:
                iop = [float(v) for v in plane_ori[0].ImageOrientationPatient]
            pix_meas = getattr(shared, "PixelMeasuresSequence", None)
            if pix_meas:
                pixel_spacing = [float(v) for v in pix_meas[0].PixelSpacing]

        ipp = [float(v) for v in getattr(seg_dcm, "ImagePositionPatient", [0, 0, 0])]
        ipp_list = [ipp for _ in range(n_frames)]
        for i in range(n_frames):
            frame_to_seg[i] = 1

    # ── Sort frames by position along the normal ──
    normal = np.cross(np.array(iop[:3]), np.array(iop[3:]))
    positions = [float(np.dot(normal, np.array(ipp))) for ipp in ipp_list]
    sorted_idx = np.argsort(positions)
    pixel_array = pixel_array[sorted_idx]
    ipp_list = [ipp_list[i] for i in sorted_idx]
    frame_to_seg = {new_i: frame_to_seg[old_i] for new_i, old_i in enumerate(sorted_idx)}

    # ── z-spacing ──
    z_spacing = 1.0
    if len(positions) > 1:
        sorted_pos = sorted(positions)
        z_spacing = abs(sorted_pos[1] - sorted_pos[0]) if sorted_pos[1] != sorted_pos[0] else 1.0

    origin = tuple(ipp_list[0]) if ipp_list else (0.0, 0.0, 0.0)
    direction = _iop_to_direction(iop)

    # ── Write one NIfTI per segment ──
    results: dict[str, str] = {}
    for seg_num, label in segments.items():
        mask = np.zeros((n_frames, rows, cols), dtype=np.uint8)
        for frame_idx, s_num in frame_to_seg.items():
            if s_num == seg_num and frame_idx < n_frames:
                mask[frame_idx] = (pixel_array[frame_idx] > 0).astype(np.uint8)

        mask_img = sitk.GetImageFromArray(mask)
        mask_img.SetSpacing((pixel_spacing[1], pixel_spacing[0], z_spacing))
        mask_img.SetOrigin(origin)
        mask_img.SetDirection(direction)

        safe_label = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)
        out_path = output_dir / f"seg_{seg_num}_{safe_label}.nii.gz"
        sitk.WriteImage(mask_img, str(out_path))
        logger.info("Wrote mask for segment '%s' → %s", label, out_path)
        results[label] = str(out_path)

    return results


def convert_seg_file_to_nifti(seg_dcm_path: Path, output_dir: Path) -> dict[str, str]:
    """
    Convert a single DICOM SEG file to per-segment NIfTI masks.
    Tries highdicom first; falls back to the pure-pydicom implementation.
    Returns {segment_label: nifti_path}.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        import highdicom as hd
        import SimpleITK as sitk

        seg = hd.seg.segread(str(seg_dcm_path))
        results: dict[str, str] = {}

        source_uids = [uids[2] for uids in seg.get_source_image_uids()]

        for seg_num in seg.segment_numbers:
            desc = seg.get_segment_description(seg_num)
            label = desc.segment_label or f"Segment_{seg_num}"

            # get_pixels_by_segment returns (frames, rows, cols, 1) for binary segs
            try:
                # 2. Reconstruct the full pixel array for this specific segment
                arr = seg.get_pixels_by_source_instance(
                    source_sop_instance_uids=source_uids,
                    segment_numbers=[seg_num],
                    ignore_spatial_locations=True # Useful if you are just looking to extract the raw mask stack
                )
                mask = arr[..., 0].astype(np.uint8)
            except Exception as exc:
                logger.warning("highdicom get_pixels_by_source_instance failed for seg %d: %s", seg_num, exc)
                continue

            mask_img = sitk.GetImageFromArray(mask)

            shared = getattr(seg, "SharedFunctionalGroupsSequence", None)
            if shared and len(shared) > 0:
                shared_group = shared[0]

                # --- 1. Pixel Spacing & Thickness ---
                pix_meas = getattr(shared_group, "PixelMeasuresSequence", None)
                if pix_meas and len(pix_meas) > 0:
                    meas = pix_meas[0]
                    if hasattr(meas, "PixelSpacing") and len(meas.PixelSpacing) >= 2:
                        ps = [float(v) for v in meas.PixelSpacing]
                        st = float(getattr(meas, "SliceThickness", 1.0))
                        mask_img.SetSpacing((ps[1], ps[0], st))

                # --- 2. Image Orientation (Direction) ---
                plane_orient = getattr(shared_group, "PlaneOrientationSequence", None)
                if plane_orient and len(plane_orient) > 0:
                    orient = plane_orient[0]
                    if hasattr(orient, "ImageOrientationPatient") and len(orient.ImageOrientationPatient) >= 6:
                        iop = [float(v) for v in orient.ImageOrientationPatient]
                        row_cosine = np.array(iop[0:3])
                        col_cosine = np.array(iop[3:6])
                        slice_cosine = np.cross(row_cosine, col_cosine)

                        direction_matrix = (
                            row_cosine[0], row_cosine[1], row_cosine[2],
                            col_cosine[0], col_cosine[1], col_cosine[2],
                            slice_cosine[0], slice_cosine[1], slice_cosine[2]
                        )
                        mask_img.SetDirection(direction_matrix)

            # --- 3. Image Origin (from Per-Frame Groups) ---
            per_frame_groups = getattr(seg, "PerFrameFunctionalGroupsSequence", None)
            if per_frame_groups and len(per_frame_groups) > 0:
                # Grab the first frame to establish the origin of the 3D volume
                first_frame = per_frame_groups[0]
                plane_pos = getattr(first_frame, "PlanePositionSequence", None)

                if plane_pos and len(plane_pos) > 0:
                    pos = plane_pos[0]

                    # Safely check if ImagePositionPatient exists and has 3 coordinates
                    if hasattr(pos, "ImagePositionPatient") and len(pos.ImagePositionPatient) >= 3:
                        origin = [float(v) for v in pos.ImagePositionPatient]
                        mask_img.SetOrigin(tuple(origin))
            safe_label = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)
            out_path = output_dir / f"seg_{seg_num}_{safe_label}.nii.gz"
            sitk.WriteImage(mask_img, str(out_path))
            logger.info("highdicom: wrote mask for '%s' → %s", label, out_path)
            results[label] = str(out_path)

        if results:
            return results
        # Fall through to pydicom if highdicom returned nothing
    except ImportError:
        logger.debug("highdicom not installed, using pydicom fallback")
    except Exception as exc:
        logger.warning("highdicom conversion failed (%s), falling back to pydicom", exc)

    ds = pydicom.dcmread(str(seg_dcm_path))
    return _convert_seg_pydicom(ds, output_dir)


# ── LangChain tool ────────────────────────────────────────────────────────────

@tool
def convert_dicom_seg_to_nifti(
    study_instance_uid: str,
    seg_series_instance_uid: str,
    dicomweb_url: Optional[str] = None,
) -> str:
    """
    Fetch a DICOM SEG series from DICOMweb and convert each segment to a
    binary NIfTI mask file (.nii.gz), one file per anatomical structure.

    Use this tool BEFORE running extract_radiomics when a DICOM SEG is
    available in the study, so that region-specific radiomics features can
    be computed.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        seg_series_instance_uid: Series Instance UID of the DICOM SEG series.
        dicomweb_url: DICOMweb WADO-RS base URL (e.g. http://orthanc:8042/wado).
            Optional — falls back to the server's DICOMWEB_URL env var.

    Returns:
        JSON with segment labels and the path to each NIfTI mask file.
    """
    try:
        url = resolve_dicomweb_url(dicomweb_url)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    seg_dir = settings.dicom_cache_dir / study_instance_uid / seg_series_instance_uid
    output_dir = settings.segmentation_output_dir / study_instance_uid / seg_series_instance_uid / "dicom_seg"

    dcm_files = fetch_series_to_dir(url, study_instance_uid, seg_series_instance_uid, seg_dir)
    if not dcm_files:
        return json.dumps({"error": "No DICOM SEG files found for the given series UID."})

    # A DICOM SEG series is typically a single multi-frame file
    seg_file = dcm_files[0]

    try:
        masks = convert_seg_file_to_nifti(seg_file, output_dir)
        volumes_ml = {}
        for label, path in masks.items():
            mask = sitk.ReadImage(path)
            volume = mask.GetSpacing()[0] * mask.GetSpacing()[1] * mask.GetSpacing()[2] * np.sum(sitk.GetArrayFromImage(mask)) / 1000.0
            volumes_ml[label] = volume
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
        "message": (
            f"Converted {len(masks)} segment(s): {', '.join(masks.keys())}. "
            "Pass the mask path(s) to extract_radiomics."
        ),
    })

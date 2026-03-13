"""
Radiology report generation tool.
Uses the LLM to write a structured report based on study metadata,
segmentation results, and radiomics features.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from langchain_core.tools import tool

from config import settings
from .dicom_utils import dicom_dir_to_patient_info


REPORT_TEMPLATE = """
You are an expert radiologist. Write a professional, structured radiology report
based on the information provided below.

Format the report with these sections:
1. PATIENT INFORMATION
2. CLINICAL INDICATION
3. TECHNIQUE
4. FINDINGS
5. IMPRESSION

Be concise and clinically accurate. Use standard radiological terminology.

Study Information:
{study_info}

{segmentation_summary}

{radiomics_summary}

{additional_context}
"""


@tool
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

    This tool compiles study metadata, segmentation findings, and radiomics
    features into a comprehensive report template that will be filled in by
    the LLM. Returns the report prompt so the main agent can generate the
    actual text.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID.
        modality: Imaging modality (e.g., CT, MR, PET).
        clinical_indication: Reason for the examination.
        segmentation_results_path: Path to segmentation output directory.
        radiomics_results_path: Path to radiomics features JSON file.
        additional_findings: Any additional clinical context.

    Returns:
        JSON string with the report prompt and available data summary.
    """
    # Gather patient/study info from cached DICOM files
    series_dir = settings.dicom_cache_dir / study_instance_uid / series_instance_uid
    patient_info = dicom_dir_to_patient_info(series_dir) if series_dir.exists() else {}

    study_info_parts = [
        f"Modality: {modality}",
        f"Patient: {patient_info.get('PatientName', 'N/A')}",
        f"Patient ID: {patient_info.get('PatientID', 'N/A')}",
        f"Study Date: {patient_info.get('StudyDate', 'N/A')}",
        f"Study Description: {patient_info.get('StudyDescription', 'N/A')}",
        f"Series Description: {patient_info.get('SeriesDescription', 'N/A')}",
        f"Institution: {patient_info.get('InstitutionName', 'N/A')}",
        f"Study UID: {study_instance_uid}",
    ]
    if clinical_indication:
        study_info_parts.append(f"Clinical Indication: {clinical_indication}")

    # Segmentation summary
    seg_summary = ""
    if segmentation_results_path and Path(segmentation_results_path).exists():
        seg_files = list(Path(segmentation_results_path).glob("*.nii.gz"))
        structures = [f.stem.replace(".nii", "") for f in seg_files]
        if structures:
            seg_summary = (
                f"Segmentation Results:\n"
                f"The following structures were automatically segmented: "
                f"{', '.join(structures[:20])}"
                + (" (and more)" if len(structures) > 20 else "")
            )

    # Radiomics summary
    rad_summary = ""
    if radiomics_results_path and Path(radiomics_results_path).exists():
        try:
            features = json.loads(Path(radiomics_results_path).read_text())
            key_features = {
                k: v for k, v in features.items()
                if any(kw in k.lower() for kw in ["mean", "median", "energy", "volume", "surface"])
            }
            top_features = dict(list(key_features.items())[:10])
            rad_summary = (
                f"Radiomics Features (selected):\n"
                + "\n".join(f"  {k}: {v:.4f}" if isinstance(v, float) else f"  {k}: {v}"
                            for k, v in top_features.items())
            )
        except Exception:
            pass

    prompt = REPORT_TEMPLATE.format(
        study_info="\n".join(study_info_parts),
        segmentation_summary=seg_summary or "Segmentation: Not performed.",
        radiomics_summary=rad_summary or "Radiomics: Not performed.",
        additional_context=additional_findings or "",
    )

    return json.dumps({
        "status": "ready",
        "report_prompt": prompt,
        "patient_info": patient_info,
        "message": (
            "Report data compiled successfully. "
            "The LLM will now generate the structured report."
        ),
    })

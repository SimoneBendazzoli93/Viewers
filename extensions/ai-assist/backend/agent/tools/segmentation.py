"""
Segmentation tools for the AI agent.

Supports:
- TotalSegmentator (117 anatomical structures)
- MONet bundles (nnUNet-based segmentation)
- Custom REST endpoint models
"""
from __future__ import annotations

import json
import shutil
import subprocess
import requests
import tempfile
from pathlib import Path
from typing import Any, Optional

import httpx
import pydicom
from langchain_core.tools import tool

from config import settings
from .dicom_utils import fetch_series_to_dir, resolve_dicomweb_url
from .log_broadcast import emit as emit_tool_log
from python_on_whales import docker
import uuid
import logging
import time
from kubernetes import client as k8s_client, config as k8s_config, watch as k8s_watch
logger = logging.getLogger("ohif-ai-assist.tools.segmentation")
# ── TotalSegmentator ────────────────────────────────────────────────────────

@tool
def run_totalsegmentator(
    study_instance_uid: str,
    series_instance_uid: str,
    dicomweb_url: Optional[str] = None,
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
            Optional — falls back to the server's DICOMWEB_URL env var.
        structures: Optional list of specific structures to segment.
        task: TotalSegmentator task name (default: 'total').
        fast: Use fast mode (lower resolution, faster inference).

    Returns:
        JSON string with segmentation results including output paths and structure list.
    """
    try:
        url = resolve_dicomweb_url(dicomweb_url)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    series_dir = settings.dicom_cache_dir / study_instance_uid / series_instance_uid
    output_dir = settings.segmentation_output_dir / study_instance_uid / series_instance_uid / "totalsegmentator"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Fetch DICOM files
    dcm_files = fetch_series_to_dir(url, study_instance_uid, series_instance_uid, series_dir)
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

def resolve_monet_task_key(task: str) -> str:
    """Resolve a task id (config key or task_name field) to the tasks dict key."""
    tasks = settings.monet_bundle_config.get("tasks", {})
    if task in tasks:
        return task
    for key, cfg in tasks.items():
        if cfg.get("task_name") == task:
            return key
    raise KeyError(f"Unknown MONet task: {task}")


def read_dicom_seg_metadata(dcm_path: Path, fallback_image_series_uid: str) -> dict[str, str]:
    """Read Study/Series UIDs and referenced image series from a DICOM SEG file."""
    ds = pydicom.dcmread(str(dcm_path), stop_before_pixels=True)
    study_uid = str(getattr(ds, "StudyInstanceUID", "") or "")
    seg_series_uid = str(getattr(ds, "SeriesInstanceUID", "") or "")
    image_series_uid = fallback_image_series_uid

    ref_sequence = getattr(ds, "ReferencedSeriesSequence", None)
    if ref_sequence:
        ref_item = ref_sequence[0]
        image_series_uid = str(getattr(ref_item, "SeriesInstanceUID", image_series_uid) or image_series_uid)

    return {
        "study_instance_uid": study_uid,
        "seg_series_instance_uid": seg_series_uid,
        "image_series_instance_uid": image_series_uid,
    }


def _decode_docker_log_entry(entry: str | bytes | tuple) -> str:
    if isinstance(entry, tuple):
        payload = entry[1] if len(entry) > 1 else entry[0]
        if isinstance(payload, bytes):
            return payload.decode("utf-8", errors="replace").rstrip()
        return str(payload).rstrip()
    if isinstance(entry, bytes):
        return entry.decode("utf-8", errors="replace").rstrip()
    return str(entry).rstrip()


def _k8s_container_status(pod, container_name: str, *, init: bool = False):
    statuses = (
        pod.status.init_container_statuses if init else pod.status.container_statuses
    ) or []
    return next((s for s in statuses if s.name == container_name), None)


def _k8s_container_state_label(status) -> str | None:
    if not status or not status.state:
        return None
    if status.state.running is not None:
        return "running"
    if status.state.terminated is not None:
        return "terminated"
    if status.state.waiting is not None:
        return "waiting"
    return None


def _k8s_wait_for_container(
    v1,
    namespace: str,
    pod_name: str,
    container_name: str,
    *,
    init: bool = False,
    want: frozenset[str] = frozenset({"running", "terminated"}),
    timeout: int = 3600,
    poll: float = 2,
) -> str:
    """Poll until the container is running or terminated (logs are not available while waiting)."""
    waited = 0.0
    while waited < timeout:
        pod = v1.read_namespaced_pod(name=pod_name, namespace=namespace)
        status = _k8s_container_status(pod, container_name, init=init)
        state = _k8s_container_state_label(status)
        if state in want:
            return state
        reason = ""
        if status and status.state and status.state.waiting:
            reason = status.state.waiting.reason or ""
        emit_tool_log(
            f"Waiting for {'initContainer' if init else 'container'} "
            f"'{container_name}' (state={state or 'unknown'}, reason={reason or 'n/a'})"
        )
        time.sleep(poll)
        waited += poll
    raise TimeoutError(
        f"Timed out waiting for {'initContainer' if init else 'container'} "
        f"'{container_name}' in pod '{pod_name}'"
    )


def _k8s_emit_log_lines(pod_name: str, container_name: str, logs: str, *, kind: str) -> None:
    prefix = f"[{kind}:{container_name}]"
    for line in logs.splitlines():
        if not line:
            continue
        logger.info("K8s pod [%s] (%s %s): %s", pod_name, kind, container_name, line)
        emit_tool_log(f"{prefix} {line}")


def _k8s_stream_container_logs(
    v1,
    namespace: str,
    pod_name: str,
    container_name: str,
    *,
    kind: str,
) -> None:
    """Stream logs while the container is running; falls back to a one-shot read after exit."""
    prefix = f"[{kind}:{container_name}]"
    try:
        w = k8s_watch.Watch()
        for line in w.stream(
            v1.read_namespaced_pod_log,
            name=pod_name,
            namespace=namespace,
            container=container_name,
            follow=True,
            timestamps=True,
            _preload_content=False,
        ):
            logger.info("K8s pod [%s] (%s %s): %s", pod_name, kind, container_name, line)
            emit_tool_log(f"{prefix} {line}")
    except k8s_client.exceptions.ApiException as e:
        if e.status != 400:
            raise
        # Container not ready yet — caller should wait and retry.
        raise


def _k8s_follow_container_logs(
    v1,
    namespace: str,
    pod_name: str,
    container_name: str,
    *,
    init: bool = False,
    kind: str,
    timeout: int = 3600,
) -> None:
    """Wait for a container, stream logs while it runs, or fetch them after it exits."""
    state = _k8s_wait_for_container(
        v1, namespace, pod_name, container_name, init=init, timeout=timeout
    )

    streamed = False
    if state == "running":
        try:
            _k8s_stream_container_logs(
                v1, namespace, pod_name, container_name, kind=kind
            )
            streamed = True
        except k8s_client.exceptions.ApiException:
            pass

    if state != "terminated":
        _k8s_wait_for_container(
            v1,
            namespace,
            pod_name,
            container_name,
            init=init,
            want=frozenset({"terminated"}),
            timeout=timeout,
        )

    pod = v1.read_namespaced_pod(name=pod_name, namespace=namespace)
    status = _k8s_container_status(pod, container_name, init=init)
    if status and status.state and status.state.terminated:
        exit_code = status.state.terminated.exit_code
        if exit_code != 0:
            raise RuntimeError(
                f"{'initContainer' if init else 'container'} '{container_name}' "
                f"exited with code {exit_code}"
            )

    if not streamed:
        logs = v1.read_namespaced_pod_log(
            name=pod_name,
            namespace=namespace,
            container=container_name,
            timestamps=True,
        )
        _k8s_emit_log_lines(pod_name, container_name, logs, kind=kind)


def run_monet_bundle_kubernetes(series_dir: Path, output_dir: Path, task_name: str, image: str) -> str:
    random_name = str(uuid.uuid4())
    pod_name = f"monet-bundle-{random_name}"
    logger.info("Running MONet bundle: %s on %s -> %s", image, series_dir, output_dir)
    emit_tool_log(f"Starting MONet pod '{pod_name}'")
    emit_tool_log(f"Image: {image}")
    emit_tool_log(f"Task: {task_name}")
    emit_tool_log(f"Input: {series_dir} -> /var/holoscan/input")
    emit_tool_log(f"Output: {output_dir} -> /var/holoscan/output")

    namespace = settings.namespace
    orthanc_url = settings.orthanc_url
    k8s_config.load_incluster_config()
    v1 = k8s_client.CoreV1Api()

    study_instance_uid = str(series_dir).split("/")[-2]
    series_instance_uid = str(series_dir).split("/")[-1]

    pod_manifest = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": pod_name,
        },
        "spec": {
            "volumes": [
                {"name": "data", "emptyDir": {}},
                #{
                #    "name": "data",
                #    "persistentVolumeClaim": {
                #         "claimName": "test-storage",
                #         "claimName": "test-storage",
                # }
            ],
            "initContainers": [
                {
                    "name": "orthanc-download",
                    "image": "python:3.10",
                    "command": [
                        "sh",
                        "-c",
                        f"""set -e
StudyID=$(curl -s -X POST {orthanc_url}/tools/find \\
  -d '{{"Level": "Study", "Query": {{"StudyInstanceUID": "{study_instance_uid}"}}}}' | python3 -c "import sys, json; print(json.load(sys.stdin)[0])")
curl {orthanc_url}/studies/$StudyID/archive > /var/holoscan/data/$StudyID.zip
mkdir -p /var/holoscan/data/{study_instance_uid}
python3 -m zipfile -e /var/holoscan/data/$StudyID.zip /var/holoscan/data/{study_instance_uid}
""",
                    ],
                    "resources": {
                        "requests": {"cpu": "100m", "memory": "50Mi"},
                        "limits": {"cpu": "100m", "memory": "50Mi"},
                    },
                    "volumeMounts": [
                        {"name": "data", "mountPath": "/var/holoscan/data"}
                        ],
                },
                {
                    "name": "brats-met-container",
                    "image": image,
                    "imagePullPolicy": "Always",
                    "resources": {
                        "requests": {"cpu": "2000m", "memory": "4Gi"},
                        "limits": {"cpu": "2000m", "memory": "4Gi"},
                    },
                    "env": [
                        {"name": "TRITON_SERVER_NETLOC", "value": "demo-maia-pacs-stack-triton:8080"},
                        {"name": "HOLOSCAN_INPUT_PATH", "value": f"/var/holoscan/data/{study_instance_uid}"},
                        {"name": "HOLOSCAN_OUTPUT_PATH", "value": f"/var/holoscan/data/{study_instance_uid}"},
                        {"name": "SEGMENTATION_TASK_CONFIG_FILE", "value": "/etc/holoscan/Segmentation_Task.yaml"},
                        {"name": "SEGMENTATION_TASK_NAME", "value": task_name},
                    ],
                    "volumeMounts": [
                        {"name": "data", "mountPath": "/var/holoscan/data"}
                        ],
                },
            ],
            "containers": [
                {
                    "name": "orthanc-uploader",
                    "image": "curlimages/curl:latest",
                    "command": [
                        "/bin/sh",
                        "-c",
                        f"for FILE in /var/holoscan/data/{study_instance_uid}/*.dcm; do curl -X POST {orthanc_url}/instances --data-binary @$FILE && echo 'Uploaded $FILE'; done",
                    ],
                    "volumeMounts": [
                        {"name": "data", "mountPath": "/var/holoscan/data"}
                        ],
                    "resources": {
                        "requests": {"cpu": "100m", "memory": "50Mi"},
                        "limits": {"cpu": "100m", "memory": "50Mi"},
                    },
                }
            ],
        },
    }

    try:
        v1.create_namespaced_pod(namespace=namespace, body=pod_manifest)
        emit_tool_log(f"Pod '{pod_name}' creation requested.")
    except k8s_client.exceptions.ApiException as e:
        emit_tool_log(f"Exception when creating pod: {e}")
        raise

    emit_tool_log(f"Pod '{pod_name}' created")

    try:
        pod_spec = v1.read_namespaced_pod(name=pod_name, namespace=namespace).spec

        for ic in pod_spec.init_containers or []:
            emit_tool_log(f"Following initContainer '{ic.name}' logs...")
            _k8s_follow_container_logs(
                v1,
                namespace,
                pod_name,
                ic.name,
                init=True,
                kind="initContainer",
            )

        for container in pod_spec.containers or []:
            emit_tool_log(f"Following container '{container.name}' logs...")
            _k8s_follow_container_logs(
                v1,
                namespace,
                pod_name,
                container.name,
                init=False,
                kind="container",
            )

        pod_status = v1.read_namespaced_pod_status(name=pod_name, namespace=namespace)
        phase = pod_status.status.phase
        emit_tool_log(f"Pod '{pod_name}' finished with phase: {phase}")
        if phase == "Failed":
            raise RuntimeError(f"Pod '{pod_name}' failed.")
    finally:
        try:
            v1.delete_namespaced_pod(name=pod_name, namespace=namespace)
            emit_tool_log(f"Pod '{pod_name}' deleted.")
        except k8s_client.exceptions.ApiException as e:
            logger.warning("Failed to delete pod '%s': %s", pod_name, e)

    return json.dumps({"status": "success", "output_dir": str(output_dir)})

def run_monet_bundle_docker(series_dir: Path, output_dir: Path, task_name: str, image: str) -> str:
    random_name = str(uuid.uuid4())
    container_name = f"monet-bundle-{random_name}"
    docker_image = image
    logger.info("Running MONet bundle: %s on %s -> %s", docker_image, series_dir, output_dir)
    emit_tool_log(f"Starting MONet container '{container_name}'")
    emit_tool_log(f"Image: {docker_image}")
    emit_tool_log(f"Task: {task_name}")
    emit_tool_log(f"Input: {series_dir} -> /var/holoscan/input")
    emit_tool_log(f"Output: {output_dir} -> /var/holoscan/output")

    container = docker.run(
        image=docker_image,
        gpus="device=0",
        name=container_name,
        volumes=[
            (series_dir, "/var/holoscan/input"),
            (output_dir, "/var/holoscan/output"),
        ],
        envs={
            "SEGMENTATION_TASK_CONFIG_FILE": "/etc/holoscan/Segmentation_Task.yaml",
            "SEGMENTATION_TASK_NAME": task_name,
        },
        shm_size="2g",
        detach=True,
    )

    try:
        log_stream = docker.container.logs(container, stream=True, follow=True)
        for entry in log_stream:
            line = _decode_docker_log_entry(entry)
            if not line:
                continue
            logger.info("MONet [%s]: %s", container_name, line)
            emit_tool_log(line)

        exit_code = docker.container.wait(container)
        if isinstance(exit_code, list):
            exit_code = exit_code[0] if exit_code else 1
        if exit_code != 0:
            raise RuntimeError(f"MONet container exited with code {exit_code}")

        emit_tool_log(f"Container '{container_name}' finished successfully")
    finally:
        try:
            docker.container.remove(container, force=True)
        except Exception as exc:
            logger.warning("Failed to remove container %s: %s", container_name, exc)

    return json.dumps({"status": "success", "output_dir": str(output_dir)})

@tool
def list_monet_tasks() -> list[str]:
    """
    List all available Monet tasks.

    Returns:
        List of available Monet tasks.
    """
    tasks = settings.monet_bundle_config.get("tasks", {})
    return [
        cfg.get("task_name", key)
        for key, cfg in tasks.items()
    ]

@tool
def run_monet_segmentation(
    study_instance_uid: str,
    series_instance_uid: str,
    task: str,
    dicomweb_url: Optional[str] = None,
) -> str:
    """
    Run a Monet segmentation model on a DICOM series.

    Args:
        study_instance_uid: DICOM Study Instance UID.
        series_instance_uid: DICOM Series Instance UID.
        dicomweb_url: DICOMweb WADO-RS base URL.
            Optional — falls back to the server's DICOMWEB_URL env var.
        task: Task name to run.
    Returns:
        JSON string with segmentation result.
    """
    try:
        url = resolve_dicomweb_url(dicomweb_url)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    series_dir = settings.dicom_cache_dir / study_instance_uid / series_instance_uid
    output_dir = (
        settings.segmentation_output_dir
        / study_instance_uid
        / series_instance_uid
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir.chmod(0o777)

    if not series_dir.exists():
        dcm_files = fetch_series_to_dir(url, study_instance_uid, series_instance_uid, series_dir)
        if not dcm_files:
            return json.dumps({"error": "No DICOM files found."})

    try:
        series_dir = settings.host_dicom_cache_dir / study_instance_uid / series_instance_uid
        output_dir = settings.host_segmentation_output_dir / study_instance_uid / series_instance_uid
        task_key = resolve_monet_task_key(task)
        task_cfg = settings.monet_bundle_config["tasks"][task_key]
        task_name = task_cfg["task_name"]
        image = task_cfg["image"]
        backend_type = settings.backend_type
        if backend_type == "docker":
            result = run_monet_bundle_docker(series_dir, output_dir, task_name, image)
        elif backend_type == "kubernetes":
            result = run_monet_bundle_kubernetes(series_dir, output_dir, task_name, image)
        else:
            raise ValueError(f"Invalid backend type: {backend_type}")
    except Exception as e:
        logger.error(f"MONet prediction failed: {e}")
        logger.exception(e)
        emit_tool_log(f"MONet prediction failed: {e}")
        return json.dumps({
            "error": "MONet prediction failed",
            "detail": str(e)
        })

    output_dir = (
        settings.segmentation_output_dir
        / study_instance_uid
        / series_instance_uid
    )
    seg_files = list(output_dir.glob("*.dcm"))
    if not seg_files:
        if backend_type == "kubernetes":
            orthanc_url = settings.orthanc_url
            study_instance_uid = study_instance_uid

            response = requests.post(f"{orthanc_url}/tools/find", json={"Level": "Study", "Query": {"StudyInstanceUID": study_instance_uid}})
            orthanc_study_id = response.json()[0]


            seg_files = []
            response = requests.get(f"{orthanc_url}/studies/{orthanc_study_id}")
            series_ids = response.json()["Series"]
            for series_id in series_ids:
                response = requests.get(f"{orthanc_url}/series/{series_id}")
                series_data = response.json()
                if series_data["MainDicomTags"]["Modality"] == "SEG":
                    instance_ids = series_data["Instances"]
                    for instance_id in instance_ids:
                        response = requests.get(f"{orthanc_url}/instances/{instance_id}/file")
                        with open(f"{output_dir}/{instance_id}.dcm", "wb") as f:
                            f.write(response.content)
                            seg_files.append(f"{output_dir}/{instance_id}.dcm")
        else:
            return json.dumps({
                "status": "success",
                "output_dir": str(output_dir),
                "files": [],
                "message": "MONet inference complete but no DICOM SEG files were found in the output directory.",
            })

    seg_meta = read_dicom_seg_metadata(seg_files[0], series_instance_uid)
    study_uid = seg_meta["study_instance_uid"] or study_instance_uid
    seg_series_uid = seg_meta["seg_series_instance_uid"]
    image_series_uid = seg_meta["image_series_instance_uid"] or series_instance_uid

    series_to_load = list(dict.fromkeys([uid for uid in [image_series_uid, seg_series_uid] if uid]))

    return json.dumps({
        "status": "success",
        "output_dir": str(output_dir),
        "files": [f.name for f in seg_files],
        "study_instance_uid": study_uid,
        "seg_series_instance_uid": seg_series_uid,
        "image_series_instance_uid": image_series_uid,
        "viewer_reload": {
            "mode": "segmentation",
            "studyInstanceUID": study_uid,
            "seriesInstanceUIDs": series_to_load,
            "initialSeriesInstanceUID": image_series_uid,
            "segSeriesInstanceUID": seg_series_uid,
        },
        "message": (
            f"MONet inference complete. {len(seg_files)} DICOM SEG file(s) generated. "
            "Open the viewer in Segmentation mode to review the new segmentation."
        ),
    })


# ── Custom REST endpoint segmentation ────────────────────────────────────────

@tool
def run_custom_segmentation(
    study_instance_uid: str,
    series_instance_uid: str,
    model_id: str,
    endpoint_url: str,
    dicomweb_url: Optional[str] = None,
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
        model_id: Identifier of the custom model.
        endpoint_url: Full URL of the segmentation REST endpoint.
        dicomweb_url: DICOMweb source URL.
            Optional — falls back to the server's DICOMWEB_URL env var.

    Returns:
        JSON string with the endpoint response.
    """
    try:
        url = resolve_dicomweb_url(dicomweb_url)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    payload = {
        "dicomweb_url": url,
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

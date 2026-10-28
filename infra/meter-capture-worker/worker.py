"""Single-job pull worker. The dedicated bearer only reaches the scoped Edge gateway."""
from __future__ import annotations

import base64
import hashlib
import json
import multiprocessing
import os
import signal
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.request
import uuid

from domain import MAX_BYTES, VERSION, InvalidInput, validate_job, validate_panel_job
from panel import MAX_EVIDENCE_BYTES, failed_result as failed_panel_result, survey
from recognize import NoRedirect, https_base, recognize, request_headers, request_json, require_cpu_avx


class Gateway:
    def __init__(self):
        self.base = https_base(os.environ["METER_CAPTURE_API_BASE_URL"])
        self.token = os.environ["METER_CAPTURE_WORKER_TOKEN"]
        if len(self.token) < 32:
            raise InvalidInput("worker_token_too_short")

    def post(self, action: str, body: dict):
        return request_json(self.base + "/worker/" + action, self.token, body, 90)

    def download(self, job: dict, destination: Path, route: str = "media"):
        media = job["media"][0]
        request = urllib.request.Request(self.base + "/worker/" + route, json.dumps({
            "jobId": job["jobId"], "leaseToken": job["leaseToken"], "mediaId": media["id"],
        }).encode(), request_headers(self.token))
        size = 0
        digest = hashlib.sha256()
        with urllib.request.build_opener(NoRedirect).open(request, timeout=90) as response, destination.open("xb") as stream:
            while chunk := response.read(256 * 1024):
                size += len(chunk)
                if size > MAX_BYTES or size > media["sizeBytes"]:
                    raise InvalidInput("download_size_mismatch")
                digest.update(chunk)
                stream.write(chunk)
        if size != media["sizeBytes"] or digest.hexdigest() != media["sha256"]:
            raise InvalidInput("download_digest_mismatch")


def limit_child():
    # CPU/address-space bounded by compose as well; all decoded files go to a bounded tmpfs.
    if os.name == "posix":
        import resource
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CPU, (240, 245))
        resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024 * 1024, 128 * 1024 * 1024))


def child_job(job: dict, original: str, directory: str, output):
    try:
        limit_child()
        output.send(recognize(job, Path(original), Path(directory)))
    except Exception as error:
        output.send({"failure": str(error) if isinstance(error, InvalidInput) else "recognition_failed"})
    finally:
        output.close()


def child_panel_job(job: dict, original: str, directory: str, output):
    try:
        limit_child()
        output.send(survey(job, Path(original), Path(directory)))
    except Exception as error:
        output.send({"failure": str(error) if isinstance(error, InvalidInput) else "recognition_failed"})
    finally:
        output.close()


def isolated(target, job: dict, original: Path, temporary: str) -> dict:
    """Run one decode/recognition child under the 300 s hard limit; the parent never decodes media."""
    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    child = context.Process(target=target, args=(job, str(original), temporary, send))
    child.start()
    send.close()
    if receive.poll(300):
        result = receive.recv()
    else:
        result = {"failure": "recognition_timeout"}
    if child.is_alive():
        if os.name == "posix":
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                child.terminate()
        else:
            child.terminate()
    child.join(5)
    if child.is_alive():
        child.kill()
        child.join(5)
    receive.close()
    return result


def failed_result(job: dict, code: str) -> dict:
    reader = {"value": None, "registerCode": job["meter"]["registerCode"], "unit": "kWh",
              "frames": [], "version": VERSION, "status": "error"}
    return {"server": dict(reader), "ai": dict(reader), "identity": {"qrTokens": [], "ambiguous": True},
            "issues": [code], "mediaValidated": False, "durationSeconds": None}


def process(gateway: Gateway, job: dict):
    with tempfile.TemporaryDirectory(prefix="meter-") as temporary:
        directory = Path(temporary)
        original = directory / "original.media"
        try:
            gateway.download(job, original)
            result = isolated(child_job, job, original, temporary)
            if "failure" in result:
                result = failed_result(job, result["failure"])
            else:
                evidence = result.pop("evidence")
                uploaded: dict[str, str] = {}
                for frame in evidence:
                    local = Path(frame["localPath"])
                    if not local.resolve().is_relative_to(directory.resolve()):
                        raise InvalidInput("invalid_evidence_path")
                    image = local.read_bytes()
                    receipt = gateway.post("evidence", {
                        "jobId": job["jobId"], "leaseToken": job["leaseToken"],
                        "timestampSeconds": frame["timestampSeconds"], "sha256": hashlib.sha256(image).hexdigest(),
                        "dataBase64": base64.b64encode(image).decode(),
                    })
                    uploaded[str(local)] = receipt["objectKey"]
                for source in ("server", "ai"):
                    for frame in result[source]["frames"]:
                        frame["objectKey"] = uploaded[frame.pop("localPath")]
                result["evidence"] = [{"timestampSeconds": frame["timestampSeconds"], "objectKey": uploaded[frame["localPath"]]}
                                      for frame in evidence]
        except Exception as error:
            result = failed_result(job, str(error) if isinstance(error, InvalidInput) else "worker_processing_failed")
        # Completion is lease/idempotency checked server-side. A network failure is NOT silently replayed.
        gateway.post("complete", {"jobId": job["jobId"], "leaseToken": job["leaseToken"], "result": result})


def upload_panel_evidence(gateway: Gateway, job: dict, result: dict, directory: Path) -> dict:
    """Upload each distinct JPEG once (by SHA-256) and cite only objectKeys this job's gateway returned."""
    root = directory.resolve()
    uploaded: dict[str, tuple[str, float]] = {}
    declared = job["media"][0].get("durationSeconds")

    def upload(item: dict) -> dict:
        local = Path(item["localPath"])
        if not local.resolve().is_relative_to(root):
            raise InvalidInput("invalid_evidence_path")
        # The receipt accepts timestamps up to the declared duration + 1 s; the survey already drops later frames.
        if declared is not None and item["timestampSeconds"] > declared + 1:
            raise InvalidInput("evidence_after_declared_duration")
        image = local.read_bytes()
        if not 0 < len(image) <= MAX_EVIDENCE_BYTES or image[:3] != b"\xff\xd8\xff":
            raise InvalidInput("invalid_evidence")
        digest = hashlib.sha256(image).hexdigest()
        if digest not in uploaded:
            receipt = gateway.post("panel/evidence", {
                "jobId": job["jobId"], "leaseToken": job["leaseToken"], "timestampSeconds": item["timestampSeconds"],
                "sha256": digest, "dataBase64": base64.b64encode(image).decode(),
            })
            key = receipt.get("objectKey") if isinstance(receipt, dict) else None
            if not isinstance(key, str) or not key.endswith("/" + digest + ".jpg"):
                raise InvalidInput("invalid_evidence_receipt")
            uploaded[digest] = (key, item["timestampSeconds"])
        # Identical bytes are one object with the timestamp of their single receipt.
        key, timestamp = uploaded[digest]
        return {"objectKey": key, "sha256": digest, "sizeBytes": len(image), "timestampSeconds": timestamp}

    for detection in result["detections"]:
        detection["crop"] = upload(detection["crop"])
        frames: list[dict] = []
        for frame in detection["frames"]:
            receipt = upload(frame)
            if all(item["objectKey"] != receipt["objectKey"] for item in frames):
                frames.append({"objectKey": receipt["objectKey"], "timestampSeconds": receipt["timestampSeconds"]})
        detection["frames"] = frames
    return result


def process_panel(gateway: Gateway, job: dict):
    with tempfile.TemporaryDirectory(prefix="meter-panel-") as temporary:
        directory = Path(temporary)
        original = directory / "original.media"
        validated, duration = False, None
        try:
            gateway.download(job, original, "panel/media")
            result = isolated(child_panel_job, job, original, temporary)
            if "failure" in result:
                result = failed_panel_result(result["failure"])
            else:
                validated, duration = result["mediaValidated"], result["durationSeconds"]
                result = upload_panel_evidence(gateway, job, result, directory)
        except Exception as error:
            result = failed_panel_result(str(error) if isinstance(error, InvalidInput) else "worker_processing_failed",
                                         validated, duration)
        lease = {"jobId": job["jobId"], "leaseToken": job["leaseToken"]}
        try:
            gateway.post("panel/complete", {**lease, "result": result})
        except urllib.error.HTTPError as error:
            # A result the server rejects (422) would be rejected again on every lease: record it once instead,
            # as "unreadable" because the server retries "error" with further paid AI calls.
            # Network failures and other statuses are NOT replayed.
            if error.code != 422 or result["ai"]["status"] == "error":
                raise
            gateway.post("panel/complete", {**lease, "result": failed_panel_result(
                "worker_result_rejected", result["mediaValidated"], result["durationSeconds"], status="unreadable")})


def work_once(gateway: Gateway, worker_id: str) -> bool:
    """Single-meter captures first; a panel job is claimed only when no capture job is waiting."""
    job = gateway.post("claim", {"workerId": worker_id})
    if job is not None:
        process(gateway, validate_job(job))
        print(json.dumps({"event": "meter_capture_processed", "jobId": job["jobId"]}), flush=True)
        return True
    job = gateway.post("panel/claim", {"workerId": worker_id})
    if job is not None:
        process_panel(gateway, validate_panel_job(job))
        print(json.dumps({"event": "meter_panel_processed", "jobId": job["jobId"]}), flush=True)
        return True
    return False


def main():
    require_cpu_avx()
    gateway = Gateway()
    worker_id = os.environ.get("METER_CAPTURE_WORKER_ID", "meter-" + str(uuid.uuid4()))
    while True:
        try:
            if not work_once(gateway, worker_id):
                time.sleep(5)
        except Exception:
            print(json.dumps({"event": "meter_capture_worker_error"}), flush=True)
            # Claim leases recover explicitly server-side; failed completion never mutates a reading.
            time.sleep(10)


if __name__ == "__main__":
    main()

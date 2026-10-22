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
import urllib.request
import uuid

from domain import MAX_BYTES, VERSION, InvalidInput, validate_job
from recognize import NoRedirect, https_base, recognize, request_json


class Gateway:
    def __init__(self):
        self.base = https_base(os.environ["METER_CAPTURE_API_BASE_URL"])
        self.token = os.environ["METER_CAPTURE_WORKER_TOKEN"]
        if len(self.token) < 32:
            raise InvalidInput("worker_token_too_short")

    def post(self, action: str, body: dict):
        return request_json(self.base + "/worker/" + action, self.token, body, 90)

    def download(self, job: dict, destination: Path):
        media = job["media"][0]
        request = urllib.request.Request(self.base + "/worker/media", json.dumps({
            "jobId": job["jobId"], "leaseToken": job["leaseToken"], "mediaId": media["id"],
        }).encode(), {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
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


def child_job(job: dict, original: str, directory: str, output):
    try:
        # CPU/address-space bounded by compose as well; all decoded files go to a bounded tmpfs.
        if os.name == "posix":
            import resource
            os.setsid()
            resource.setrlimit(resource.RLIMIT_CPU, (240, 245))
            resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024 * 1024, 128 * 1024 * 1024))
        output.send(recognize(job, Path(original), Path(directory)))
    except Exception as error:
        output.send({"failure": str(error) if isinstance(error, InvalidInput) else "recognition_failed"})
    finally:
        output.close()


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
            context = multiprocessing.get_context("spawn")
            receive, send = context.Pipe(duplex=False)
            child = context.Process(target=child_job, args=(job, str(original), temporary, send))
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


def main():
    gateway = Gateway()
    worker_id = os.environ.get("METER_CAPTURE_WORKER_ID", "meter-" + str(uuid.uuid4()))
    while True:
        try:
            job = gateway.post("claim", {"workerId": worker_id})
            if job is None:
                time.sleep(5)
                continue
            process(gateway, validate_job(job))
            print(json.dumps({"event": "meter_capture_processed", "jobId": job["jobId"]}), flush=True)
        except Exception:
            print(json.dumps({"event": "meter_capture_worker_error"}), flush=True)
            # Claim leases recover explicitly server-side; failed completion never mutates a reading.
            time.sleep(10)


if __name__ == "__main__":
    main()

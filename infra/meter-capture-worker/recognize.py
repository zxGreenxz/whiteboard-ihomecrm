"""Bounded FFmpeg/OpenCV/PaddleOCR pipeline. Heavy dependencies load only in a job child."""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

from domain import MAX_AI_FRAMES, MAX_SECONDS, VERSION, InvalidInput, ai_prompt, ocr_reading, ocr_candidates, parse_ai, stable_reading

AI_MODEL = "cx/gpt-6.1-terra"
AI_REASONING = "medium"
AI_DETAIL = "original"
RECOGNITION_BUDGET_SECONDS = 240
OCR_FRAME_RESERVE_SECONDS = 20


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise InvalidInput("redirect_not_allowed")


def https_base(value: str) -> str:
    url = urllib.parse.urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise InvalidInput("https_endpoint_required")
    return value.rstrip("/")


def request_headers(token: str) -> dict[str, str]:
    return {"Authorization": "Bearer " + token, "Content-Type": "application/json",
            "User-Agent": "ihome-meter-capture/1"}


def request_json(url: str, token: str, body: dict, timeout: int = 45, limit: int = 256_000) -> Any:
    request = urllib.request.Request(url, json.dumps(body).encode(), request_headers(token))
    with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
        raw = response.read(limit + 1)
        if len(raw) > limit:
            raise InvalidInput("response_too_large")
        return json.loads(raw)


def run_process(args: list[str], timeout: int = 45) -> str:
    # No shell, no stdin, fixed protocol whitelist: media cannot open network URLs/playlists.
    completed = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, check=False)
    if completed.returncode != 0:
        raise InvalidInput("media_decoder_failed")
    if len(completed.stdout) > 128_000:
        raise InvalidInput("decoder_response_too_large")
    return completed.stdout.decode("utf-8")


def probe_media(path: Path, is_video: bool) -> float:
    data = json.loads(run_process([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-show_entries",
        "format=duration,format_name:stream=codec_type,width,height,duration", "-of", "json", str(path),
    ], 15))
    videos = [stream for stream in data.get("streams", []) if stream.get("codec_type") == "video"]
    if len(videos) != 1:
        raise InvalidInput("one_video_stream_required")
    stream = videos[0]
    if not 0 < int(stream.get("width", 0)) * int(stream.get("height", 0)) <= 20_000_000:
        raise InvalidInput("media_dimensions_limit")
    if not is_video:
        return 0.0
    duration = float(data.get("format", {}).get("duration", stream.get("duration", "nan")))
    if not 0 < duration <= MAX_SECONDS:
        raise InvalidInput("video_duration_limit")
    if not set(data.get("format", {}).get("format_name", "").split(",")) & {"mov", "mp4", "matroska", "webm"}:
        raise InvalidInput("unsupported_video_container")
    return duration


def extract_frames(path: Path, output: Path, is_video: bool, fps: int,
                   scale: str = "scale=w='min(1600,iw)':h=-2") -> list[tuple[float, Path]]:
    output.mkdir(exist_ok=True)
    filter_value = (f"fps={fps}," if is_video else "") + scale
    run_process([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file",
        "-threads", "1", "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn", "-t", str(MAX_SECONDS),
        "-vf", filter_value, "-frames:v", str(MAX_SECONDS * fps if is_video else 1),
        "-threads", "1", "-q:v", "3", str(output / "%04d.jpg"),
    ], 60)
    files = sorted(output.glob("*.jpg"))
    if not files:
        raise InvalidInput("no_decodable_frames")
    return [(round(index / fps, 3) if is_video else 0.0, item) for index, item in enumerate(files)]


def inspect_frames(frames: list[tuple[float, Path]], expected_qr: str) -> tuple[list[dict], set[str]]:
    import cv2
    cv2.setNumThreads(1)
    detector = cv2.QRCodeDetector()
    result: list[dict] = []
    all_qr: set[str] = set()
    for timestamp, path in frames:
        image = cv2.imread(str(path))
        if image is None:
            continue
        grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        quality = float(cv2.Laplacian(grey, cv2.CV_64F).var())
        found, decoded, points, _ = detector.detectAndDecodeMulti(image)
        tokens = {token for token in decoded if token} if found else set()
        if not tokens:
            token, _, _ = detector.detectAndDecode(image)
            if token:
                tokens.add(token)
        all_qr.update(tokens)
        # A detected second QR, even unreadable, is not a safe identity match.
        count = len(points) if found and points is not None else len(tokens)
        result.append({"timestamp": timestamp, "path": path, "quality": quality, "multipleQr": count > 1,
                       "qr": tokens, "identity": tokens == {expected_qr} and count == 1})
    return result, all_qr


def representatives(frames: list[dict], maximum: int = MAX_AI_FRAMES) -> list[dict]:
    """Quality-only temporal bins; selection never depends on OCR digits or prior readings."""
    if len(frames) <= maximum:
        return frames
    chosen = []
    for index in range(maximum):
        start = index * len(frames) // maximum
        end = (index + 1) * len(frames) // maximum
        chosen.append(max(frames[start:end], key=lambda frame: frame["quality"]))
    return chosen


def require_cpu_avx():
    """Pinned Linux Paddle wheels need AVX; reject before a native SIGILL or claim."""
    if sys.platform != "linux":
        return
    try:
        flags = [line.split(":", 1)[1].split() for line in Path("/proc/cpuinfo").read_text().splitlines()
                 if line.split(":", 1)[0].strip() == "flags"]
    except OSError as error:
        raise InvalidInput("ocr_cpu_capability_unknown") from error
    if not flags or any("avx" not in core for core in flags):
        raise InvalidInput("ocr_cpu_avx_required")


class PaddleReader:
    def __init__(self):
        require_cpu_avx()
        from paddleocr import PaddleOCR
        model_root = Path(os.environ.get("METER_OCR_MODELS", "/opt/models"))
        det = model_root / "PP-OCRv5_mobile_det"
        rec = model_root / "en_PP-OCRv5_mobile_rec"
        if not (det / "inference.json").is_file() or not (rec / "inference.json").is_file():
            raise InvalidInput("ocr_models_missing")
        self.engine = PaddleOCR(
            text_detection_model_name="PP-OCRv5_mobile_det", text_detection_model_dir=str(det),
            text_recognition_model_name="en_PP-OCRv5_mobile_rec", text_recognition_model_dir=str(rec),
            use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False,
            device="cpu", enable_mkldnn=False, cpu_threads=1,
        )

    def read(self, path: Path) -> list[dict]:
        # A full portrait frame downsamples the tiny LCD labels too much. Locate
        # complete LCD panels using pixels only, retaining their unit/register.
        # AI still receives the independent full frames, never these OCR tokens.
        import cv2
        image = cv2.imread(str(path))
        if image is None:
            raise InvalidInput("no_decodable_frames")
        regions = lcd_regions(image)
        self.can_fallback = len(regions) == 1
        return self._read_regions(image, regions or [(0, 0, image.shape[1], image.shape[0])])

    def read_full_frame(self, path: Path) -> list[dict]:
        import cv2
        image = cv2.imread(str(path))
        if image is None:
            raise InvalidInput("no_decodable_frames")
        return self._read_regions(image, [(0, 0, image.shape[1], image.shape[0])])

    def _read_regions(self, image, regions) -> list[dict]:
        output = []
        for region, (x, y, width, height) in enumerate(regions):
            for result in self.engine.predict(input=image[y:y+height, x:x+width]):
                values = result.json
                if isinstance(values, str):
                    values = json.loads(values)
                data = values.get("res", values)
                for text, score, polygon in zip(data.get("rec_texts", []), data.get("rec_scores", []), data.get("rec_polys", [])):
                    xs = [x + float(point[0]) for point in polygon]
                    ys = [y + float(point[1]) for point in polygon]
                    output.append({"text": text, "score": float(score), "region": region,
                                   "box": [min(xs), min(ys), max(xs), max(ys)]})
        return output


def read_ocr_frame(reader, path: Path, timestamp: float, meter: dict, deadline: float):
    tokens = reader.read(path)
    args = (meter["registerCode"], meter["decimalPlaces"], meter.get("serialNumber"))
    # Retry missing context, never a multiple-panel or conflicting reading. The
    # full frame must independently provide digits, decimal, register and unit.
    if not ocr_candidates(tokens, *args) and reader.can_fallback and deadline-time.monotonic() >= OCR_FRAME_RESERVE_SECONDS:
        tokens = reader.read_full_frame(path)
    return ocr_reading(tokens, timestamp, *args)


def lcd_regions(image) -> list[tuple[int, int, int, int]]:
    """Bounded, geometry-only LCD crops. Never locate digits or insert a decimal.

    Keep all candidate panels: selecting just the clearest could hide a second
    meter. Grey/mechanical or ambiguous geometry falls back to the full image.
    Originals and evidence are never rewritten by this preprocessing.
    """
    import cv2
    import numpy as np
    height, width = image.shape[:2]
    scale = min(1.0, 1280 / max(height, width))
    small = cv2.resize(image, None, fx=scale, fy=scale) if scale < 1 else image
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([20, 15, 25]), np.array([100, 180, 235]))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 11), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    found = []
    sh, sw = small.shape[:2]
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if not (2 < w / max(h, 1) < 9 and w > sw * .2 and h > sh * .02
                and w*h < sw*sh*.3 and cv2.contourArea(contour)/(w*h) > .55):
            continue
        # Margin preserves the complete display boundary and small label edges.
        pad = max(3, round(h * .08))
        left, top = max(0, int((x-pad)/scale)), max(0, int((y-pad)/scale))
        right, bottom = min(width, int((x+w+pad)/scale)), min(height, int((y+h+pad)/scale))
        found.append((left, top, right-left, bottom-top))
    return sorted(found) if len(found) <= 2 else []


def read_ai(frames: list[dict], meter: dict, *, timeout: float = 90) -> tuple[list, bool, str]:
    base = os.environ.get("METER_CAPTURE_AI_BASE_URL", "").strip()
    key = os.environ.get("METER_CAPTURE_AI_KEY", "").strip()
    model = os.environ.get("METER_CAPTURE_AI_MODEL", AI_MODEL).strip() or AI_MODEL
    if not base or not key:
        raise InvalidInput("ai_not_configured")
    if not 0 < len(frames) <= MAX_AI_FRAMES:
        raise InvalidInput("invalid_ai_frame_count")
    content: list[dict] = [{"type": "text", "text": ai_prompt(meter["registerCode"], meter["decimalPlaces"])}]
    for index, frame in enumerate(frames):
        content.extend([
            {"type": "text", "text": f"frameIndex={index}"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(frame["path"].read_bytes()).decode(), "detail": AI_DETAIL}},
        ])
    response = request_json(https_base(base) + "/chat/completions", key, {
        "model": model, "reasoning_effort": AI_REASONING, "messages": [{"role": "user", "content": content}],
        "response_format": {"type": "json_object"}, "max_tokens": 4000, "stream": False,
    }, timeout=timeout)
    choices = response.get("choices", []) if isinstance(response, dict) else []
    if not choices or choices[0].get("finish_reason") != "stop":
        raise InvalidInput("ai_incomplete")
    readings, single = parse_ai(choices[0].get("message", {}).get("content"),
                                [frame["timestamp"] for frame in frames], meter["registerCode"], meter["decimalPlaces"])
    return readings, single, f"{model};reasoning={AI_REASONING};detail={AI_DETAIL}"


def recognize(job: dict, path: Path, directory: Path) -> dict[str, Any]:
    deadline = time.monotonic() + RECOGNITION_BUDGET_SECONDS
    meter = job["meter"]
    is_video = job["media"][0]["mimeType"].startswith("video/")
    duration = probe_media(path, is_video)
    issues: list[str] = []
    server_readings, ai_readings = [], []
    server_status = ai_status = "unreadable"
    server_value = ai_value = None
    server_times, ai_times, server_issues, ai_issues = [], [], [], []
    ai_version = f"{os.environ.get('METER_CAPTURE_AI_MODEL', AI_MODEL).strip() or AI_MODEL};reasoning={AI_REASONING};detail={AI_DETAIL}"
    single_meter, multiple_qr = True, False
    qr_tokens: set[str] = set()
    by_time: dict[float, dict] = {}
    reader = None
    server_seen: set[float] = set()
    for fps in ([5, 10] if is_video else [5]):
        # Leave room for FFmpeg (60s), inspection and the reader still needed.
        # A dense retry must not consume a valid first-pass AI result by hitting
        # the process's 300s hard limit and replacing it with a failed job.
        dense_budget = 60 + 20 + (90 if ai_status == "unreadable" else OCR_FRAME_RESERVE_SECONDS)
        if fps == 10 and deadline - time.monotonic() < dense_budget:
            issues.append("recognition_time_budget_exhausted")
            break
        inspected, found_qr = inspect_frames(extract_frames(path, directory / f"frames{fps}", is_video, fps), meter["qrToken"])
        qr_tokens.update(found_qr)
        multiple_qr = multiple_qr or any(frame["multipleQr"] for frame in inspected)
        selected = representatives(inspected)
        # Preserve the exact bytes cited by an earlier pass at the same timestamp.
        selected = [by_time.setdefault(frame["timestamp"], frame) for frame in selected]
        # HTTP inference and local CPU OCR have independent inputs and resources.
        # Start AI first so a slow CPU cannot starve the primary model entirely.
        executor, pending_ai = None, None
        if ai_status != "error" and ai_value is None:
            remaining = deadline - time.monotonic()
            if remaining <= 5:
                issues.append("ai_time_budget_exhausted")
                single_meter = False
            else:
                executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="meter-ai")
                pending_ai = executor.submit(read_ai, selected, meter, timeout=min(90, remaining - 5))
        try:
            if server_status != "error" and server_value is None:
                try:
                    for frame in selected:
                        # by_time keeps the exact first-pass bytes at overlapping timestamps.
                        if frame["timestamp"] in server_seen:
                            continue
                        if deadline - time.monotonic() < OCR_FRAME_RESERVE_SECONDS:
                            issues.append("server_time_budget_exhausted")
                            break
                        reader = reader or PaddleReader()
                        reading = read_ocr_frame(reader, frame["path"], frame["timestamp"], meter, deadline)
                        server_seen.add(frame["timestamp"])
                        if reading:
                            server_readings.append(reading)
                    # Dense retries add evidence, never erase an earlier conflicting value.
                    server_value, server_times, server_issues = stable_reading(server_readings, is_video)
                    server_status = "ok" if server_value is not None else "unreadable"
                except Exception:
                    # Provider errors may contain image data or credentials. Keep only the code.
                    server_value, server_times, server_status = None, [], "error"
                    issues.append("server_reader_error")
            if pending_ai is not None:
                try:
                    observations, same_meter, ai_version = pending_ai.result(timeout=max(0, deadline - time.monotonic()))
                    ai_readings.extend(observations)
                    single_meter = single_meter and same_meter
                    ai_value, ai_times, ai_issues = stable_reading(ai_readings, is_video)
                    ai_status = "ok" if ai_value is not None else "unreadable"
                except FutureTimeoutError:
                    issues.append("ai_reader_error" if pending_ai.done() else "ai_time_budget_exhausted")
                    ai_value, ai_times, ai_status, single_meter = None, [], "error", False
                except Exception:
                    ai_value, ai_times, ai_status, single_meter = None, [], "error", False
                    issues.append("ai_reader_error")
        finally:
            if executor is not None:
                # Do not let a stuck provider extend the job at executor shutdown.
                # The parent receives the result then terminates any live child.
                executor.shutdown(wait=False, cancel_futures=True)
        # Retry missing evidence, not service failures; an already stable reader
        # keeps its first result and is not called again at the other reader's expense.
        if not is_video or (server_status != "unreadable" and ai_status != "unreadable"):
            break
    issues.extend("server_" + issue for issue in server_issues)
    issues.extend("ai_" + issue for issue in ai_issues)
    evidence_times = sorted(set(server_times + ai_times))
    # Keep useful visual evidence even when both readers abstain.
    if not evidence_times:
        evidence_times = [frame["timestamp"] for frame in representatives(sorted(by_time.values(), key=lambda frame: frame["timestamp"]), 3)]
    frames_by_time = {timestamp: by_time[timestamp] for timestamp in evidence_times}
    ambiguous = multiple_qr or qr_tokens != {meter["qrToken"]} or not single_meter or any(not frame["identity"] for frame in frames_by_time.values())
    if ambiguous:
        issues.append("identity_requires_review")
    if server_value is not None and ai_value is not None and server_value != ai_value:
        issues.append("readers_disagree")
    def result(value, times, status, version):
        retained = [timestamp for timestamp in times if timestamp in frames_by_time]
        if status == "ok" and len(retained) < (2 if is_video else 1):
            value, status = None, "unreadable"
            issues.append("insufficient_retained_evidence")
        return {"value": value, "registerCode": meter["registerCode"], "unit": "kWh", "status": status,
                "version": version, "frames": [{"timestampSeconds": timestamp, "localPath": str(by_time[timestamp]["path"])}
                                                for timestamp in retained]}
    return {
        "server": result(server_value, server_times, server_status, VERSION),
        "ai": result(ai_value, ai_times, ai_status, ai_version),
        "identity": {"qrTokens": sorted(qr_tokens), "ambiguous": ambiguous},
        "issues": sorted(set(issues)), "mediaValidated": True, "durationSeconds": duration if is_video else None,
        "evidence": [{"timestampSeconds": timestamp, "localPath": str(frame["path"])} for timestamp, frame in frames_by_time.items()],
    }

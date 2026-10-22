"""Bounded FFmpeg/OpenCV/PaddleOCR pipeline. Heavy dependencies load only in a job child."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import subprocess
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

from domain import MAX_AI_FRAMES, MAX_SECONDS, VERSION, InvalidInput, ai_prompt, ocr_reading, parse_ai, stable_reading


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise InvalidInput("redirect_not_allowed")


def https_base(value: str) -> str:
    url = urllib.parse.urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise InvalidInput("https_endpoint_required")
    return value.rstrip("/")


def request_json(url: str, token: str, body: dict, timeout: int = 45, limit: int = 256_000) -> Any:
    request = urllib.request.Request(url, json.dumps(body).encode(), {
        "Authorization": "Bearer " + token, "Content-Type": "application/json",
    })
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


def extract_frames(path: Path, output: Path, is_video: bool, fps: int) -> list[tuple[float, Path]]:
    output.mkdir(exist_ok=True)
    filter_value = (f"fps={fps}," if is_video else "") + "scale=w='min(1600,iw)':h=-2"
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


class PaddleReader:
    def __init__(self):
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
            device="cpu", enable_mkldnn=False, cpu_threads=2,
        )

    def read(self, path: Path) -> list[dict]:
        # OCR's text detector selects ROIs, preserving the unit/register and full original for evidence.
        output = []
        for result in self.engine.predict(input=str(path)):
            values = result.json
            if isinstance(values, str):
                values = json.loads(values)
            data = values.get("res", values)
            for text, score, polygon in zip(data.get("rec_texts", []), data.get("rec_scores", []), data.get("rec_polys", [])):
                xs = [float(point[0]) for point in polygon]
                ys = [float(point[1]) for point in polygon]
                output.append({"text": text, "score": float(score), "box": [min(xs), min(ys), max(xs), max(ys)]})
        return output


def read_ai(frames: list[dict], meter: dict) -> tuple[list, bool, str]:
    base = os.environ.get("METER_CAPTURE_AI_BASE_URL", "").strip()
    key = os.environ.get("METER_CAPTURE_AI_KEY", "").strip()
    model = os.environ.get("METER_CAPTURE_AI_MODEL", "cx/gpt-5.6-terra(low)").strip()
    if not base or not key:
        raise InvalidInput("ai_not_configured")
    content: list[dict] = [{"type": "text", "text": ai_prompt(meter["registerCode"], meter["decimalPlaces"])}]
    for index, frame in enumerate(frames):
        content.extend([
            {"type": "text", "text": f"frameIndex={index}"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(frame["path"].read_bytes()).decode()}},
        ])
    response = request_json(https_base(base) + "/chat/completions", key, {
        "model": model, "messages": [{"role": "user", "content": content}],
        "response_format": {"type": "json_object"}, "max_tokens": 4000, "stream": False,
    }, timeout=60)
    choices = response.get("choices", []) if isinstance(response, dict) else []
    if not choices or choices[0].get("finish_reason") != "stop":
        raise InvalidInput("ai_incomplete")
    readings, single = parse_ai(choices[0].get("message", {}).get("content"),
                                [frame["timestamp"] for frame in frames], meter["registerCode"], meter["decimalPlaces"])
    return readings, single, model


def recognize(job: dict, path: Path, directory: Path) -> dict[str, Any]:
    meter = job["meter"]
    is_video = job["media"][0]["mimeType"].startswith("video/")
    duration = probe_media(path, is_video)
    selected, qr_tokens = inspect_frames(extract_frames(path, directory / "frames5", is_video, 5), meter["qrToken"])
    multiple_qr = any(frame["multipleQr"] for frame in selected)
    selected = representatives(selected)
    issues: list[str] = []
    server_readings = []
    server_status = "unreadable"
    try:
        reader = PaddleReader()
        for frame in selected:
            reading = ocr_reading(reader.read(frame["path"]), frame["timestamp"], meter["registerCode"], meter["decimalPlaces"], meter.get("serialNumber"))
            if reading:
                server_readings.append(reading)
        server_value, server_times, server_issues = stable_reading(server_readings, is_video)
        if not server_value and is_video:
            denser, more_qr = inspect_frames(extract_frames(path, directory / "frames10", True, 10), meter["qrToken"])
            qr_tokens.update(more_qr)
            multiple_qr = multiple_qr or any(frame["multipleQr"] for frame in denser)
            selected = representatives(denser)
            server_readings = []
            for frame in selected:
                reading = ocr_reading(reader.read(frame["path"]), frame["timestamp"], meter["registerCode"], meter["decimalPlaces"], meter.get("serialNumber"))
                if reading:
                    server_readings.append(reading)
            server_value, server_times, server_issues = stable_reading(server_readings, is_video)
        server_status = "ok" if server_value is not None else "unreadable"
        issues.extend("server_" + issue for issue in server_issues)
    except Exception:
        # Never log provider exception text: it can include image data or credentials.
        server_value, server_times, server_status = None, [], "error"
        issues.append("server_reader_error")
    ai_status, ai_value, ai_times, ai_version = "error", None, [], os.environ.get("METER_CAPTURE_AI_MODEL", "cx/gpt-5.6-terra(low)")
    single_meter = False
    try:
        ai_readings, single_meter, ai_version = read_ai(selected, meter)
        ai_value, ai_times, ai_issues = stable_reading(ai_readings, is_video)
        ai_status = "ok" if ai_value is not None else "unreadable"
        issues.extend("ai_" + issue for issue in ai_issues)
    except Exception:
        issues.append("ai_reader_error")
    by_time = {frame["timestamp"]: frame for frame in selected}
    evidence_times = sorted(set(server_times + ai_times))[:3]
    # Keep useful visual evidence even when both readers abstain.
    if not evidence_times:
        evidence_times = [frame["timestamp"] for frame in selected[:3]]
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

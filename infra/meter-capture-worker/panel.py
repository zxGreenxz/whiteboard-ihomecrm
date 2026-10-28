"""Panel ("cả bảng") survey: one photo/clip of several meters -> per-meter detections, crops and frames.

The AI receives only frames, never CRM rooms, labels or previous readings; people confirm every reading.
OpenCV/NumPy load only inside the job child. Decisions on decoded geometry are plain Python.
"""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
import math
import os
from pathlib import Path
import re
import time
from typing import Any

from domain import InvalidInput, panel_prompt, parse_panel_ai
from recognize import AI_DETAIL, AI_MODEL, AI_REASONING, extract_frames, https_base, probe_media, representatives, request_json

PANEL_FPS = 2
PANEL_MAX_FRAMES = 12
# Long side capped at 2560 and never upscaled: the measured 1440x2560 photos and 1920x1080 clip frames stay native.
PANEL_SCALE = "scale=w='if(gte(iw,ih),min(2560,iw),-2)':h='if(gte(iw,ih),-2,min(2560,ih))'"
PANEL_BUDGET_SECONDS = 240
PANEL_AI_TIMEOUT_SECONDS = 120
EVIDENCE_RESERVE_SECONDS = 20
MAX_EVIDENCE_BYTES = 3 * 1024 * 1024
MAX_EVIDENCE_FRAMES = 3
MAX_QR_TOKENS = 4
# Padding is a fraction of the frame (as the measured prototype): it absorbs the model's box error.
CROP_PADDING = 0.06
QR_BOX_MARGIN = 0.10
# Observations are compared at one scale so a closer, larger view is not penalised against a distant one.
SHARPNESS_WIDTH = 320
QR_TOKEN = re.compile(r"ihome-meter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def ai_model() -> str:
    return os.environ.get("METER_CAPTURE_AI_MODEL", AI_MODEL).strip() or AI_MODEL


def ai_version() -> str:
    return f"{ai_model()};reasoning={AI_REASONING};detail={AI_DETAIL};panel/1"


def failed_result(code: str, media_validated: bool = False, duration: float | None = None) -> dict[str, Any]:
    return {"mediaValidated": media_validated, "durationSeconds": duration, "issues": [code],
            "ai": {"status": "error", "version": ai_version()}, "detections": []}


def _cv2():
    import cv2
    cv2.setNumThreads(1)
    return cv2


def load_image(path: Path):
    import numpy as np
    cv2 = _cv2()
    # cv2.imread cannot open non-ASCII Windows paths; decode the bytes instead.
    image = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise InvalidInput("no_decodable_frames")
    return image


def image_quality(image) -> float:
    cv2 = _cv2()
    return float(cv2.Laplacian(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())


def pixel_box(shape, box, padding: float = 0.0) -> tuple[int, int, int, int]:
    """Normalised 0-1000 box (+ padding as a fraction of the frame) -> clamped, non-empty pixel rectangle."""
    height, width = shape[:2]
    x0, y0, x1, y1 = box
    left = max(0, math.floor((x0 / 1000 - padding) * width))
    top = max(0, math.floor((y0 / 1000 - padding) * height))
    right = min(width, max(left + 1, math.ceil((x1 / 1000 + padding) * width)))
    bottom = min(height, max(top + 1, math.ceil((y1 / 1000 + padding) * height)))
    return left, top, right, bottom


def region_sharpness(image, box) -> float:
    """Laplacian variance of the meter's own box, never of its digits' meaning."""
    cv2 = _cv2()
    left, top, right, bottom = pixel_box(image.shape, box)
    grey = cv2.cvtColor(image[top:bottom, left:right], cv2.COLOR_BGR2GRAY)
    scale = SHARPNESS_WIDTH / grey.shape[1]
    grey = cv2.resize(grey, (SHARPNESS_WIDTH, max(1, round(grey.shape[0] * scale))),
                      interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def qr_codes(image) -> list[tuple[str, float, float]]:
    """iHome meter tokens with their centre normalised 0-1000. Other QR content is ignored and never logged."""
    cv2 = _cv2()
    detector = cv2.QRCodeDetector()
    height, width = image.shape[:2]
    found, decoded, points, _ = detector.detectAndDecodeMulti(image)
    pairs = list(zip(decoded, points)) if found and points is not None else []
    if not any(token for token, _ in pairs):
        token, corners, _ = detector.detectAndDecode(image)
        pairs = [(token, corners)] if token and corners is not None else []
    codes = []
    for token, corners in pairs:
        if token and QR_TOKEN.fullmatch(token):
            x, y = corners.reshape(-1, 2).mean(axis=0)
            codes.append((token, float(x) * 1000 / width, float(y) * 1000 / height))
    return codes


def encode_jpeg(image, quality: int = 90) -> bytes:
    cv2 = _cv2()
    while True:
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            raise InvalidInput("evidence_encoding_failed")
        if encoded.size <= MAX_EVIDENCE_BYTES:
            return encoded.tobytes()
        height, width = image.shape[:2]
        if min(height, width) < 64:
            raise InvalidInput("evidence_too_large")
        image = cv2.resize(image, (int(width * .8), int(height * .8)), interpolation=cv2.INTER_AREA)


def save_crop(image, box, destination: Path) -> None:
    left, top, right, bottom = pixel_box(image.shape, box, CROP_PADDING)
    destination.write_bytes(encode_jpeg(image[top:bottom, left:right]))


def save_frame(frame: dict, image, destination: Path) -> Path:
    """Cite the exact JPEG the model read; re-encode only if it exceeds the evidence limit."""
    if frame["path"].stat().st_size <= MAX_EVIDENCE_BYTES:
        return frame["path"]
    destination.write_bytes(encode_jpeg(image))
    return destination


def select_frames(extracted: list[tuple[float, Path]]) -> list[dict]:
    """At most 12 frames spread over the clip, the sharpest of each time bin; never chosen by content."""
    frames = []
    for timestamp, path in extracted:
        try:
            quality = image_quality(load_image(path))
        except InvalidInput:
            continue
        frames.append({"timestamp": timestamp, "path": path, "quality": quality})
    if not frames:
        raise InvalidInput("no_decodable_frames")
    return representatives(frames, PANEL_MAX_FRAMES)


def inside(box, x: float, y: float, margin: float = 0.0) -> bool:
    x0, y0, x1, y1 = box
    dx, dy = (x1 - x0) * margin, (y1 - y0) * margin
    return x0 - dx <= x <= x1 + dx and y0 - dy <= y <= y1 + dy


def associate_qr(meters: list[dict], codes: list[list[tuple[str, float, float]]]) -> tuple[list[set[str]], set[str]]:
    """A token belongs to the meters whose box holds its centre in the same frame; only when no box does,
    to those whose box expanded by 10% does. Several owners stay ambiguous for the server and reviewer."""
    tokens: list[set[str]] = [set() for _ in meters]
    seen: set[str] = set()
    placed: set[str] = set()
    for frame_index, found in enumerate(codes):
        boxes = [(number, observation["box"]) for number, meter in enumerate(meters)
                 for observation in meter["observations"] if observation["frameIndex"] == frame_index]
        for token, x, y in found:
            seen.add(token)
            owners = [number for number, box in boxes if inside(box, x, y)] or \
                     [number for number, box in boxes if inside(box, x, y, QR_BOX_MARGIN)]
            for number in owners:
                tokens[number].add(token)
            if owners:
                placed.add(token)
    return tokens, seen - placed


def read_panel_ai(frames: list[dict], *, timeout: float) -> list[dict]:
    base = os.environ.get("METER_CAPTURE_AI_BASE_URL", "").strip()
    key = os.environ.get("METER_CAPTURE_AI_KEY", "").strip()
    if not base or not key:
        raise InvalidInput("ai_not_configured")
    if not 0 < len(frames) <= PANEL_MAX_FRAMES:
        raise InvalidInput("invalid_ai_frame_count")
    content: list[dict] = [{"type": "text", "text": panel_prompt()}]
    for index, frame in enumerate(frames):
        content.extend([
            {"type": "text", "text": f"frameIndex={index}"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(frame["path"].read_bytes()).decode(), "detail": AI_DETAIL}},
        ])
    response = request_json(https_base(base) + "/chat/completions", key, {
        "model": ai_model(), "reasoning_effort": AI_REASONING, "messages": [{"role": "user", "content": content}],
        "response_format": {"type": "json_object"}, "max_tokens": 16000, "stream": False,
    }, timeout=timeout, limit=1_000_000)
    choices = response.get("choices") if isinstance(response, dict) else None
    choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
    if choice.get("finish_reason") != "stop":
        raise InvalidInput("ai_incomplete")
    message = choice.get("message")
    return parse_panel_ai(message.get("content") if isinstance(message, dict) else None, len(frames))


def detect(frames: list[dict], directory: Path, deadline: float) -> dict[str, Any]:
    version = ai_version()

    def error(code: str) -> dict[str, Any]:
        return {"issues": [code], "ai": {"status": "error", "version": version}, "detections": []}

    images = [load_image(frame["path"]) for frame in frames]
    budget = deadline - EVIDENCE_RESERVE_SECONDS - time.monotonic()
    if budget <= 5:
        return error("ai_time_budget_exhausted")
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="meter-panel-ai")
    try:
        pending = executor.submit(read_panel_ai, frames, timeout=min(PANEL_AI_TIMEOUT_SECONDS, budget))
        # Local QR decoding overlaps the provider call; neither sees the other's output.
        codes = [qr_codes(image) for image in images]
        try:
            meters = pending.result(timeout=max(0, deadline - EVIDENCE_RESERVE_SECONDS - time.monotonic()))
        except FutureTimeoutError:
            return error("ai_reader_error" if pending.done() else "ai_time_budget_exhausted")
        except InvalidInput as failure:
            return error(str(failure))
        except Exception:
            # Provider errors may contain image data or credentials. Keep only the code.
            return error("ai_reader_error")
    finally:
        # Do not let a stuck provider extend the job; the parent terminates a live child.
        executor.shutdown(wait=False, cancel_futures=True)
    tokens, outside = associate_qr(meters, codes)
    issues = {"qr_outside_meters"} if outside else set()
    evidence = directory / "panel-evidence"
    evidence.mkdir(exist_ok=True)
    frame_files: dict[int, Path] = {}

    def frame_file(index: int) -> Path:
        if index not in frame_files:
            frame_files[index] = save_frame(frames[index], images[index], evidence / f"frame-{index:02d}.jpg")
        return frame_files[index]

    detections = []
    for number, meter in enumerate(meters):
        # Rank this meter's own views by sharpness of its box (motion blur loses), earliest view on ties.
        ranked = sorted(meter["observations"],
                        key=lambda item: (-region_sharpness(images[item["frameIndex"]], item["box"]), item["frameIndex"]))
        best = ranked[0]
        crop = evidence / f"crop-{number:02d}.jpg"
        save_crop(images[best["frameIndex"]], best["box"], crop)
        found = sorted(tokens[number])
        if len(found) > MAX_QR_TOKENS:
            issues.add("qr_tokens_truncated")
        detections.append({
            "index": number, "label": meter["label"], "registerCode": meter["registerCode"], "display": meter["display"],
            "value": meter["value"], "clear": meter["clear"], "qrTokens": found[:MAX_QR_TOKENS],
            "crop": {"localPath": str(crop), "timestampSeconds": frames[best["frameIndex"]]["timestamp"]},
            "frames": [{"localPath": str(frame_file(index)), "timestampSeconds": frames[index]["timestamp"]}
                       for index in sorted(item["frameIndex"] for item in ranked[:MAX_EVIDENCE_FRAMES])],
        })
    return {"issues": sorted(issues), "ai": {"status": "ok" if meters else "unreadable", "version": version},
            "detections": detections}


def survey(job: dict, path: Path, directory: Path) -> dict[str, Any]:
    """Contract result "panel/1" with local evidence paths; the parent uploads them and substitutes objectKeys."""
    deadline = time.monotonic() + PANEL_BUDGET_SECONDS
    is_video = job["media"][0]["mimeType"].startswith("video/")
    duration = probe_media(path, is_video)
    frames = select_frames(extract_frames(path, directory / "panel-frames", is_video, PANEL_FPS, scale=PANEL_SCALE))
    media = {"mediaValidated": True, "durationSeconds": duration if is_video else None}
    try:
        return {**media, **detect(frames, directory, deadline)}
    except Exception as error:
        # The original already decoded within limits; keep that fact and report only a code.
        return failed_result(str(error) if isinstance(error, InvalidInput) else "recognition_failed", True, media["durationSeconds"])

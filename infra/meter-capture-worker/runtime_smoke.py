"""Synthetic runtime smoke, executed inside the built image without network or credentials.

This checks adapter/model/codec integration; it is not a real-meter accuracy benchmark.
"""
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

import cv2
import numpy as np

from domain import ocr_reading, stable_reading
import panel as meter_panel
from recognize import PaddleReader, extract_frames, inspect_frames, lcd_regions, probe_media, run_process, read_ocr_frame


QR = "ihome-meter:11111111-1111-4111-8111-111111111111"
VALUE = "12345.67"
REGISTER = "1.8.0"


def panel(unit="kWh", value=VALUE, register=REGISTER):
    """High contrast LCD-style fixture with separate register, value and unit text."""
    image = np.full((720, 1280, 3), 245, dtype=np.uint8)
    cv2.rectangle(image, (340, 190), (1220, 510), (220, 230, 220), -1)
    cv2.putText(image, register, (390, 285), cv2.FONT_HERSHEY_SIMPLEX, 1.8, (15, 15, 15), 3, cv2.LINE_AA)
    cv2.putText(image, value, (390, 420), cv2.FONT_HERSHEY_SIMPLEX, 2.6, (15, 15, 15), 4, cv2.LINE_AA)
    cv2.putText(image, unit, (900, 420), cv2.FONT_HERSHEY_SIMPLEX, 1.8, (15, 15, 15), 3, cv2.LINE_AA)
    qr = cv2.QRCodeEncoder_create().encode(QR)
    qr = cv2.copyMakeBorder(qr, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
    qr = cv2.resize(qr, (280, 280), interpolation=cv2.INTER_NEAREST)
    image[220:500, 30:310] = cv2.cvtColor(qr, cv2.COLOR_GRAY2BGR)
    return image


PANEL_TOKENS = ["ihome-meter:" + "-".join(digit * size for size in (8, 4, 4, 4, 12)) for digit in "abc"]
PANEL_BOXES = [[125, 150, 438, 850], [563, 150, 875, 850]]


def panel_scene(blur_first=False):
    """Two meters with their own QR inside their box, plus a third QR on the wall outside every meter."""
    image = np.full((1000, 1600, 3), 235, dtype=np.uint8)
    for left, label, value in ((200, "1.05", "14243.3"), (900, "1.06", "08037.6")):
        cv2.rectangle(image, (left, 150), (left + 500, 850), (40, 40, 40), 4)
        cv2.putText(image, label, (left + 30, 230), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (20, 20, 20), 3, cv2.LINE_AA)
        cv2.putText(image, value, (left + 30, 360), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (20, 20, 20), 4, cv2.LINE_AA)
    for token, (x, y) in zip(PANEL_TOKENS, ((300, 450), (1000, 450), (20, 20))):
        code = cv2.copyMakeBorder(cv2.QRCodeEncoder_create().encode(token), 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
        image[y:y + 220, x:x + 220] = cv2.cvtColor(cv2.resize(code, (220, 220), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)
    if blur_first:
        # Horizontal motion blur over the whole first meter, its QR included.
        image[150:851, 200:701] = cv2.blur(image[150:851, 200:701], (45, 1))
    return image


def panel_reply(frames):
    meters = [{"label": label, "registerCode": "total", "display": "mechanical", "value": value, "clear": True,
               "observations": [{"frameIndex": index, "box": box} for index in frames]}
              for (label, value), box in zip((("1.05", "14243.3"), ("1.06", "08037.6")), PANEL_BOXES)]
    return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"meters": meters})}}]}


def panel_smoke(directory: Path) -> dict:
    """Real FFmpeg/OpenCV panel path: long-side frame cap, QR-in-box association, sharpest crop.

    The model reply is a fixed fixture: no network, credentials or AI accuracy claim.
    """
    for size, expected in (((3000, 2000), (1706, 2560)), ((2000, 3000), (2560, 1706)), ((1600, 1000), (1000, 1600))):
        source = directory / f"scale-{size[0]}x{size[1]}.png"
        assert cv2.imwrite(str(source), np.full((size[1], size[0], 3), 128, dtype=np.uint8))
        scaled = extract_frames(source, directory / f"scaled-{size[0]}x{size[1]}", False, meter_panel.PANEL_FPS, scale=meter_panel.PANEL_SCALE)
        assert meter_panel.load_image(scaled[0][1]).shape[:2] == expected, (size, meter_panel.load_image(scaled[0][1]).shape)
    environment = {"METER_CAPTURE_AI_BASE_URL": "https://fixture.invalid/v1", "METER_CAPTURE_AI_KEY": "fixture-key",
                   "METER_CAPTURE_AI_MODEL": ""}
    photo = directory / "panel.jpg"
    assert cv2.imwrite(str(photo), panel_scene(), [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert probe_media(photo, False) == 0
    (directory / "panel-photo").mkdir()
    with patch.dict(os.environ, environment), patch("panel.request_json", return_value=panel_reply([0])) as ai:
        photo_result = meter_panel.survey({"media": [{"mimeType": "image/jpeg"}]}, photo, directory / "panel-photo")
    assert len([item for item in ai.call_args.args[2]["messages"][0]["content"] if item["type"] == "image_url"]) == 1
    assert photo_result["ai"]["status"] == "ok" and photo_result["mediaValidated"], photo_result
    assert [item["qrTokens"] for item in photo_result["detections"]] == [[PANEL_TOKENS[0]], [PANEL_TOKENS[1]]], photo_result
    assert photo_result["issues"] == ["qr_outside_meters"], photo_result
    for detection, box in zip(photo_result["detections"], PANEL_BOXES):
        crop = Path(detection["crop"]["localPath"]).read_bytes()
        assert crop[:3] == b"\xff\xd8\xff" and len(crop) <= meter_panel.MAX_EVIDENCE_BYTES
        # Box plus 6% of the 1600x1000 frame on each side (about 693x820 px), clamped to the frame.
        left, top, right, bottom = meter_panel.pixel_box((1000, 1600), box, meter_panel.CROP_PADDING)
        assert abs(right - left - 693) <= 1 and bottom - top == 820, (left, top, right, bottom)
        assert cv2.imdecode(np.frombuffer(crop, np.uint8), cv2.IMREAD_COLOR).shape[:2] == (bottom - top, right - left), detection
        assert [frame["timestampSeconds"] for frame in detection["frames"]] == [0.0]

    # Meter A is motion-blurred in every frame but the fourth (1.5 s); meter B is always sharp.
    for index in range(6):
        assert cv2.imwrite(str(directory / f"panel-{index:02d}.png"), panel_scene(blur_first=index != 3))
    clip = directory / "panel.mp4"
    run_process([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file",
        "-threads", "1", "-framerate", "2", "-i", str(directory / "panel-%02d.png"), "-an", "-c:v", "libx264",
        "-crf", "18", "-pix_fmt", "yuv420p", "-r", "2", "-threads", "1", str(clip),
    ], 45)
    (directory / "panel-clip").mkdir()
    with patch.dict(os.environ, environment), patch("panel.request_json", return_value=panel_reply(range(6))) as ai:
        # The browser-declared duration bounds receipt timestamps (+1 s); real frames of a 3 s clip all stay.
        clip_result = meter_panel.survey({"media": [{"mimeType": "video/mp4", "durationSeconds": 3.0}]}, clip,
                                         directory / "panel-clip")
    assert len([item for item in ai.call_args.args[2]["messages"][0]["content"] if item["type"] == "image_url"]) == 6
    assert 2.8 <= clip_result["durationSeconds"] <= 3.2, clip_result
    first, second = clip_result["detections"]
    assert first["crop"]["timestampSeconds"] == 1.5, first
    assert 1.5 in [frame["timestampSeconds"] for frame in first["frames"]] and len(first["frames"]) == 3, first
    assert first["qrTokens"] == [PANEL_TOKENS[0]] and second["qrTokens"] == [PANEL_TOKENS[1]], clip_result
    return {"photoQrTokens": [len(item["qrTokens"]) for item in photo_result["detections"]],
            "photoIssues": photo_result["issues"], "clipCropTimestamp": first["crop"]["timestampSeconds"],
            "clipFramesSent": 6}


def main():
    assert not any(os.environ.get(key) for key in (
        "METER_CAPTURE_AI_KEY", "METER_CAPTURE_API_BASE_URL", "METER_CAPTURE_WORKER_TOKEN",
        "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ACCESS_TOKEN",
    )), "Synthetic runtime smoke must not receive backend or model credentials"
    assert version("paddleocr") == "3.2.0"
    assert version("paddlepaddle") == "3.1.1"
    assert version("paddlex") == "3.2.0"
    assert cv2.__version__ == "4.10.0"
    layout = np.full((1400, 900, 3), 245, dtype=np.uint8)
    cv2.rectangle(layout, (100, 200), (750, 360), (130, 155, 135), -1)
    crops = lcd_regions(layout)
    assert len(crops) == 1 and crops[0][0] < 100 and crops[0][1] < 200
    assert crops[0][0]+crops[0][2] > 750 and crops[0][1]+crops[0][3] > 360
    cv2.rectangle(layout, (100, 700), (750, 860), (130, 155, 135), -1)
    assert len(lcd_regions(layout)) == 2, "Second meter panel must not be discarded"
    assert lcd_regions(np.full_like(layout, 220)) == [], "Grey frames retain whole-frame OCR"
    with TemporaryDirectory(prefix="meter-runtime-") as tmp:
        directory = Path(tmp)
        image = directory / "meter.jpg"
        assert cv2.imwrite(str(image), panel(), [cv2.IMWRITE_JPEG_QUALITY, 96])
        assert probe_media(image, False) == 0
        photo_frames = extract_frames(image, directory / "photo", False, 5)
        assert len(photo_frames) == 1
        photo_state, qr_tokens = inspect_frames(photo_frames, QR)
        assert qr_tokens == {QR} and photo_state[0]["identity"], "JPEG QR identity did not decode"

        reader = PaddleReader()  # Real pinned model files and real Paddle CPU inference.
        photo_tokens = reader.read(photo_frames[0][1])
        photo_reading = ocr_reading(photo_tokens, 0, REGISTER, 2, None)
        assert photo_reading is not None and photo_reading.value == VALUE, json.dumps(photo_tokens)

        outside=panel()
        cv2.rectangle(outside,(340,190),(1220,510),(245,245,245),-1)
        cv2.rectangle(outside,(340,190),(1000,510),(130,155,135),-1)
        cv2.putText(outside,REGISTER,(390,285),cv2.FONT_HERSHEY_SIMPLEX,1.8,(15,15,15),3,cv2.LINE_AA)
        cv2.putText(outside,VALUE,(390,420),cv2.FONT_HERSHEY_SIMPLEX,2.6,(15,15,15),4,cv2.LINE_AA)
        cv2.putText(outside,"kWh",(1040,420),cv2.FONT_HERSHEY_SIMPLEX,1.5,(15,15,15),3,cv2.LINE_AA)
        outside_path=directory/"outside-unit.png";assert cv2.imwrite(str(outside_path),outside)
        assert len(lcd_regions(outside))==1
        assert ocr_reading(reader.read(outside_path),0,REGISTER,2,None) is None
        restored=read_ocr_frame(reader,outside_path,0,{"registerCode":REGISTER,"decimalPlaces":2},float("inf"))
        assert restored is not None and restored.value==VALUE,"Full-frame fallback must retain outside unit labels"

        # One second of voltage, then two seconds of the configured kWh register.
        # FFmpeg encodes and the production extractor decodes an actual H.264 MP4.
        for index in range(15):
            frame = panel("V", "230.00", "32.7.0") if index < 5 else panel()
            assert cv2.imwrite(str(directory / f"input-{index:02d}.png"), frame)
        clip = directory / "meter.mp4"
        run_process([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-protocol_whitelist", "file", "-threads", "1", "-framerate", "5",
            "-i", str(directory / "input-%02d.png"), "-an", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-r", "10", "-threads", "1", str(clip),
        ], 45)
        duration = probe_media(clip, True)
        assert 2.8 <= duration <= 3.2, duration
        clip_frames = extract_frames(clip, directory / "clip5", True, 5)
        assert len(clip_frames) == 15, len(clip_frames)
        clip_state, clip_qr = inspect_frames(clip_frames, QR)
        assert clip_qr == {QR} and all(frame["identity"] for frame in clip_state)

        # Read the voltage state and two independent target-register timestamps.
        voltage = ocr_reading(reader.read(clip_frames[0][1]), clip_frames[0][0], REGISTER, 2, None)
        assert voltage is None, "Voltage was accepted as the configured energy register"
        readings = []
        for index in (7, 11):
            timestamp, path = clip_frames[index]
            reading = ocr_reading(reader.read(path), timestamp, REGISTER, 2, None)
            assert reading is not None and reading.value == VALUE, f"Clip OCR failed at {timestamp}"
            readings.append(reading)
        value, timestamps, issues = stable_reading(readings, True)
        assert value == VALUE and len(timestamps) == 2 and not issues, (value, timestamps, issues)
        dense_frames = extract_frames(clip, directory / "clip10", True, 10)
        assert len(dense_frames) == 30
        panel_dir = directory / "panel"
        panel_dir.mkdir()
        panel_receipt = panel_smoke(panel_dir)
        print(json.dumps({
            "meter_runtime_smoke": "pass", "fixture": "synthetic-lcd-style",
            "photoValue": photo_reading.value, "clipValue": value,
            "evidenceTimestamps": timestamps, "frames5fps": len(clip_frames),
            "frames10fps": len(dense_frames), "durationSeconds": duration,
            "paddleocr": version("paddleocr"), "paddlepaddle": version("paddlepaddle"),
            "opencv": cv2.__version__, "realMeterAccuracyMeasured": False, "panel": panel_receipt,
        }, sort_keys=True))


if __name__ == "__main__":
    if sys.argv[1:] == ["--panel-only"]:
        # Same panel checks without Paddle models, e.g. on a developer machine with FFmpeg on PATH.
        with TemporaryDirectory(prefix="meter-panel-smoke-") as tmp:
            print(json.dumps({"meter_panel_smoke": "pass", "realMeterAccuracyMeasured": False,
                              **panel_smoke(Path(tmp))}, sort_keys=True))
    else:
        main()

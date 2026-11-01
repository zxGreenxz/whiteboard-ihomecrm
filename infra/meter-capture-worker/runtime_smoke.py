"""Synthetic runtime smoke, executed inside the built image without network or credentials.

This checks adapter/model/codec integration; it is not a real-meter accuracy benchmark.
"""
from importlib.metadata import version
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import cv2
import numpy as np

from domain import ocr_reading, stable_reading
from recognize import PaddleReader, extract_frames, inspect_frames, probe_media, run_process


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


def main():
    assert not any(os.environ.get(key) for key in (
        "METER_CAPTURE_AI_KEY", "METER_CAPTURE_API_BASE_URL", "METER_CAPTURE_WORKER_TOKEN",
        "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ACCESS_TOKEN",
    )), "Synthetic runtime smoke must not receive backend or model credentials"
    assert version("paddleocr") == "3.2.0"
    assert version("paddlepaddle") == "3.1.1"
    assert version("paddlex") == "3.2.0"
    assert cv2.__version__ == "4.10.0"
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
        print(json.dumps({
            "meter_runtime_smoke": "pass", "fixture": "synthetic-lcd-style",
            "photoValue": photo_reading.value, "clipValue": value,
            "evidenceTimestamps": timestamps, "frames5fps": len(clip_frames),
            "frames10fps": len(dense_frames), "durationSeconds": duration,
            "paddleocr": version("paddleocr"), "paddlepaddle": version("paddlepaddle"),
            "opencv": cv2.__version__, "realMeterAccuracyMeasured": False,
        }, sort_keys=True))


if __name__ == "__main__":
    main()

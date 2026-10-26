import json
from pathlib import Path
import unittest
from unittest.mock import patch

from domain import InvalidInput, Reading, ai_prompt, exact_value, ocr_reading, parse_ai, stable_reading, validate_job
from recognize import https_base, probe_media, representatives


def token(text, box, score=0.99):
    return {"text": text, "box": box, "score": score}


class RecognitionRules(unittest.TestCase):
    def test_decimals_never_inferred_or_rounded(self):
        self.assertEqual(exact_value("00012,30", 2), "00012.30")
        for value in ["1230", "12.3", "12.300", "1e2", 12.3, "NaN", "-2.00", "12 .30"]:
            with self.assertRaises(InvalidInput, msg=str(value)):
                exact_value(value, 2)

    def test_video_needs_different_timestamps(self):
        repeated = [Reading("00012.30", "1.8.0", 0)] * 3
        self.assertIsNone(stable_reading(repeated, True)[0])
        repeated.append(Reading("00012.30", "1.8.0", 0.2))
        self.assertEqual(stable_reading(repeated, True)[:2], ("00012.30", [0, 0.2]))
        self.assertEqual(stable_reading(repeated[:1], False)[0], "00012.30")

    def test_video_does_not_take_maximum_or_majority(self):
        readings = [Reading("0010", "total", 1), Reading("0010", "total", 2), Reading("0011", "total", 3)]
        self.assertIsNone(stable_reading(readings, True)[0])
        self.assertIsNone(stable_reading([Reading("0010", "1.8.0", 1), Reading("0010", "2.8.0", 2)], True)[0])

    def test_retained_timestamps_keep_the_span_that_proved_stability(self):
        value, timestamps, issues = stable_reading([Reading("0010", "total", t) for t in [0, .02, .04, .06, 2]], True)
        self.assertEqual(value, "0010")
        self.assertEqual(timestamps, [0, .04, 2])
        self.assertEqual(issues, [])

    def test_ocr_requires_register_unit_and_numeric_proximity(self):
        values = [token("1.8.0", [0, 0, 30, 10]), token("0123.4", [10, 20, 90, 40]), token("kWh", [100, 22, 130, 38]), token("SERIAL77", [0, 100, 100, 110])]
        reading = ocr_reading(values, 1.5, "1.8.0", 1, "SERIAL77")
        self.assertEqual(reading, Reading("0123.4", "1.8.0", 1.5))
        self.assertIsNone(ocr_reading(values, 1.5, "2.8.0", 1, "SERIAL77"))
        self.assertIsNone(ocr_reading([item for item in values if item["text"] != "kWh"], 1.5, "1.8.0", 1, None))
        distant = [token("1.8.0", [0, 0, 30, 10]), token("0123.4", [10, 20, 90, 40]), token("kWh", [100, 400, 130, 410])]
        self.assertIsNone(ocr_reading(distant, 1.5, "1.8.0", 1, None))

    def test_ocr_abstains_multiple_numbers_or_weak_digits(self):
        values = [token("123 kWh", [0, 0, 90, 30]), token("456 kWh", [0, 40, 90, 60])]
        self.assertIsNone(ocr_reading(values, 0, "total", 0, None))
        self.assertIsNone(ocr_reading([token("123 kWh", [0, 0, 90, 30], .91)], 0, "total", 0, None))
        self.assertEqual(ocr_reading(values[:1], 0, "total", 0, None).value, "123")

    def test_lcd_unit_above_fraction_still_requires_visible_decimal(self):
        values = [token("E", [0, 20, 10, 40]), token("0123.4", [30, 20, 150, 60]),
                  token("kWh", [125, 5, 150, 25])]
        self.assertEqual(ocr_reading(values, 0, "E", 1, None).value, "0123.4")
        values[1]["text"] = "01234"
        self.assertIsNone(ocr_reading(values, 0, "E", 1, None))
        values[1]["text"] = "0123.4"
        values[2]["text"] = "A"
        self.assertIsNone(ocr_reading(values, 0, "E", 1, None))

    def test_panel_tokens_cannot_borrow_register_or_unit_from_another_panel(self):
        values = [dict(token("E", [0, 20, 10, 40]), region=0),
                  dict(token("0123.4", [30, 20, 150, 60]), region=1),
                  dict(token("kWh", [155, 22, 180, 38]), region=1)]
        self.assertIsNone(ocr_reading(values, 0, "E", 1, None))
        values[0]["region"] = 1
        values[2]["region"] = 0
        self.assertIsNone(ocr_reading(values, 0, "E", 1, None))

    def test_ocr_rejects_a_confident_tail_beside_weak_integer_digits(self):
        values = [token("4967", [0, 20, 70, 40], .6), token("0.4", [73, 20, 100, 40]), token("kWh", [110, 22, 140, 38])]
        self.assertIsNone(ocr_reading(values, 0, "total", 1, None))
        # Do not join a complete integer and a separate fraction either.
        values[0]["score"] = .99
        self.assertIsNone(ocr_reading(values, 0, "total", 1, None))

    def test_ocr_rejects_duplicate_values_on_two_meters_or_a_distant_register(self):
        values = [token("123 kWh", [0, 0, 90, 30]), token("123 kWh", [0, 100, 90, 130])]
        self.assertIsNone(ocr_reading(values, 0, "total", 0, None))
        values = [token("1.8.0", [500, 0, 550, 10]), token("123.4 kWh", [0, 20, 120, 40])]
        self.assertIsNone(ocr_reading(values, 0, "1.8.0", 1, None))

    def test_ai_structured_schema_no_extra_fields_unknown_frames_or_fences(self):
        item = {"frameIndex": 0, "value": "0012.3", "registerCode": "1.8.0", "unit": "kWh", "clear": True}
        source = {"singleMeter": True, "readings": [item]}
        self.assertEqual(parse_ai(json.dumps(source), [1], "1.8.0", 1), ([Reading("0012.3", "1.8.0", 1)], True))
        bad = [dict(source, explanation="guess"), dict(source, singleMeter=1),
               dict(source, readings=[dict(item, frameIndex=2)]), dict(source, readings=[dict(item, frameIndex=True)]),
               dict(source, readings=[dict(item, value=12.3)]), dict(source, readings=[dict(item, unit="V")]),
               dict(source, readings=[dict(item, registerCode="2.8.0")]), dict(source, readings=[dict(item, clear=False)]),
               dict(source, readings=[item, item])]
        for value in bad:
            with self.assertRaises(InvalidInput, msg=str(value)):
                parse_ai(json.dumps(value), [1, 2], "1.8.0", 1)
        with self.assertRaises(InvalidInput):
            parse_ai("```json\n" + json.dumps(source) + "\n```", [1], "1.8.0", 1)

    def test_ai_can_abstain_or_identify_multiple_meters(self):
        raw = {"singleMeter": False, "readings": [{"frameIndex": 0, "value": None, "registerCode": None, "unit": None, "clear": False}]}
        self.assertEqual(parse_ai(json.dumps(raw), [0], "1.8.0", 0), ([], False))
        prompt = ai_prompt("1.8.0", 1)
        self.assertNotIn("previous", prompt)
        self.assertNotIn("OCR result", prompt)

    def test_ai_must_account_for_every_frame_and_cannot_read_ambiguous_meters(self):
        item = {"frameIndex": 0, "value": "0012.3", "registerCode": "1.8.0", "unit": "kWh", "clear": True}
        with self.assertRaisesRegex(InvalidInput, "invalid_ai_schema"):
            parse_ai(json.dumps({"singleMeter": True, "readings": [item]}), [0, .2], "1.8.0", 1)
        with self.assertRaisesRegex(InvalidInput, "ambiguous_ai_meter"):
            parse_ai(json.dumps({"singleMeter": False, "readings": [item]}), [0], "1.8.0", 1)

    def test_selection_uses_quality_and_time_not_digits(self):
        frames = [{"timestamp": index, "quality": index % 3, "ocrValue": "9999"} for index in range(60)]
        chosen = representatives(frames, 4)
        self.assertEqual([frame["timestamp"] for frame in chosen], [2, 17, 32, 47])

    def test_external_urls_and_redirect_credentials_are_not_accepted(self):
        self.assertEqual(https_base("https://gateway.test/v1/"), "https://gateway.test/v1")
        for url in ["http://gateway.test", "file:///tmp/clip", "https://user:password@gateway.test", "https://gateway.test/?key=secret", "https://gateway.test/#fragment"]:
            with self.assertRaises(InvalidInput):
                https_base(url)

    def test_probe_rejects_overlong_or_multiple_streams(self):
        valid = {"format": {"duration": "60", "format_name": "mov,mp4"}, "streams": [{"codec_type": "video", "width": 1920, "height": 1080}]}
        with patch("recognize.run_process", return_value=json.dumps(valid)):
            self.assertEqual(probe_media(Path("clip.mp4"), True), 60)
        for raw in [dict(valid, format={"duration": "60.1", "format_name": "mp4"}), dict(valid, streams=valid["streams"] * 2),
                    dict(valid, format={"duration": "NaN", "format_name": "mp4"}),
                    dict(valid, streams=[{"codec_type": "video", "width": 20000, "height": 20000}])]:
            with patch("recognize.run_process", return_value=json.dumps(raw)), self.assertRaises(InvalidInput):
                probe_media(Path("clip.mp4"), True)

    def test_job_cannot_inject_urls_or_oversized_media(self):
        capture = "11111111-1111-4111-8111-111111111111"
        job = {"jobId": capture, "captureId": capture, "organizationId": capture, "leaseToken": capture,
               "meter": {"qrToken": "ihome-meter:fixture", "registerCode": "1.8.0", "decimalPlaces": 1},
               "media": [{"id": capture, "sizeBytes": 100, "sha256": "a" * 64, "kind": "image", "mimeType": "image/jpeg"}]}
        self.assertIs(validate_job(job), job)
        job["media"][0]["sizeBytes"] = 101 * 1024 * 1024
        with self.assertRaises(InvalidInput):
            validate_job(job)


if __name__ == "__main__":
    unittest.main()

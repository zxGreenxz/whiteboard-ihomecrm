"""Synthetic pipeline fixtures exercise decisions without claiming measured OCR accuracy."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from domain import Reading
from recognize import recognize


QR = "ihome-meter:11111111-1111-4111-8111-111111111111"
METER = {"qrToken": QR, "registerCode": "1.8.0", "decimalPlaces": 1, "serialNumber": "SERIAL"}


def frames():
    return [{"timestamp": t, "path": Path(f"fixture-{t}.jpg"), "quality": 100, "identity": True,
             "qr": {QR}, "multipleQr": False} for t in [0.0, 0.2, 0.4]]


def tokens(value):
    return [{"text": "1.8.0", "box": [0, 0, 50, 10], "score": .99},
            {"text": value + " kWh", "box": [0, 20, 150, 40], "score": .99}]


class PipelineTests(unittest.TestCase):
    def run_case(self, source=None, server_values=None, ai_readings=None, multiple=False):
        source = source or frames()
        server_values = server_values or ["0012.3"] * 3
        ai_readings = ai_readings or [Reading("0012.3", "1.8.0", 0), Reading("0012.3", "1.8.0", .2)]
        job = {"meter": METER, "media": [{"mimeType": "video/mp4"}]}
        with TemporaryDirectory() as directory, patch("recognize.probe_media", return_value=1), \
                patch("recognize.extract_frames", return_value=[]), \
                patch("recognize.inspect_frames", return_value=(source, {QR})), \
                patch("recognize.PaddleReader") as reader, \
                patch("recognize.read_ai", return_value=(ai_readings, not multiple, "fixture-model")) as ai:
            reader.return_value.read.side_effect = [tokens(value) for value in server_values]
            output = recognize(job, Path("fixture.mp4"), Path(directory))
            return output, ai.call_args[0][0]

    def test_two_independent_readers_produce_exact_same_frames_and_preserve_evidence(self):
        output, ai_frames = self.run_case()
        self.assertEqual(output["server"]["value"], "0012.3")
        self.assertEqual(output["ai"]["value"], "0012.3")
        self.assertEqual(output["issues"], [])
        self.assertFalse(output["identity"]["ambiguous"])
        self.assertEqual(len(output["evidence"]), 3)
        self.assertEqual([frame["timestamp"] for frame in ai_frames], [0, .2, .4])
        self.assertNotIn("ocr", ai_frames[0])

    def test_changed_digit_is_never_reconciled_by_larger_value(self):
        output, _ = self.run_case(ai_readings=[Reading("0012.8", "1.8.0", 0), Reading("0012.8", "1.8.0", .2)])
        self.assertIn("readers_disagree", output["issues"])
        self.assertEqual(output["server"]["value"], "0012.3")
        self.assertEqual(output["ai"]["value"], "0012.8")

    def test_zooming_past_qr_or_second_meter_is_review_not_verified_identity(self):
        for missing_qr in [True, False]:
            source = frames()
            if missing_qr:
                source[1]["identity"] = False
            output, _ = self.run_case(source=source, multiple=not missing_qr)
            self.assertTrue(output["identity"]["ambiguous"])
            self.assertIn("identity_requires_review", output["issues"])

    def test_unreadable_second_qr_in_any_frame_is_ambiguous(self):
        source = frames()
        source[2]["multipleQr"] = True
        output, _ = self.run_case(source=source)
        self.assertTrue(output["identity"]["ambiguous"])

    def test_server_retry_is_denser_and_ai_reads_final_independent_selection(self):
        job = {"meter": METER, "media": [{"mimeType": "video/mp4"}]}
        with TemporaryDirectory() as directory, patch("recognize.probe_media", return_value=1), \
                patch("recognize.extract_frames", return_value=[]) as extract, \
                patch("recognize.inspect_frames", return_value=(frames(), {QR})), \
                patch("recognize.PaddleReader") as reader, \
                patch("recognize.read_ai", return_value=([Reading("0012.3", "1.8.0", 0), Reading("0012.3", "1.8.0", .2)], True, "fixture")):
            reader.return_value.read.side_effect = [[], [], []] + [tokens("0012.3")] * 3
            output = recognize(job, Path("fixture.mp4"), Path(directory))
            self.assertEqual([call.args[-1] for call in extract.call_args_list], [5, 10])
            self.assertEqual(output["server"]["status"], "ok")

    def test_ai_outage_keeps_original_validation_and_server_result(self):
        job = {"meter": METER, "media": [{"mimeType": "video/mp4"}]}
        with TemporaryDirectory() as directory, patch("recognize.probe_media", return_value=1), \
                patch("recognize.extract_frames", return_value=[]), \
                patch("recognize.inspect_frames", return_value=(frames(), {QR})), \
                patch("recognize.PaddleReader") as reader, patch("recognize.read_ai", side_effect=TimeoutError("fixture")):
            reader.return_value.read.return_value = tokens("0012.3")
            output = recognize(job, Path("fixture.mp4"), Path(directory))
            self.assertTrue(output["mediaValidated"])
            self.assertEqual(output["ai"]["status"], "error")
            self.assertEqual(output["server"]["value"], "0012.3")
            self.assertIn("ai_reader_error", output["issues"])


if __name__ == "__main__":
    unittest.main()

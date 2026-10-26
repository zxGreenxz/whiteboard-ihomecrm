"""Synthetic pipeline fixtures exercise decisions without claiming measured OCR accuracy."""
from concurrent.futures import Future
from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from domain import InvalidInput, Reading
from recognize import read_ai, recognize, request_json, require_cpu_avx
from worker import Gateway


QR = "ihome-meter:11111111-1111-4111-8111-111111111111"
METER = {"qrToken": QR, "registerCode": "1.8.0", "decimalPlaces": 1, "serialNumber": "SERIAL"}


def frames():
    return [{"timestamp": t, "path": Path(f"fixture-{t}.jpg"), "quality": 100, "identity": True,
             "qr": {QR}, "multipleQr": False} for t in [0.0, 0.2, 0.4]]


def tokens(value):
    return [{"text": "1.8.0", "box": [0, 0, 50, 10], "score": .99},
            {"text": value + " kWh", "box": [0, 20, 150, 40], "score": .99}]


class PipelineTests(unittest.TestCase):
    def test_linux_cpu_preflight_fails_before_loading_native_ocr(self):
        with patch("recognize.sys.platform", "linux"), patch("recognize.Path.read_text") as read:
            for cpu in ("flags : sse sse2", "flags : avx2", "flags : avx\nflags : sse2", ""):
                read.return_value = cpu
                with self.assertRaisesRegex(InvalidInput, "ocr_cpu_avx_required"):
                    require_cpu_avx()
            read.return_value = "flags : sse2 avx avx2\nflags : avx"
            require_cpu_avx()
            read.side_effect = OSError("unavailable")
            with self.assertRaisesRegex(InvalidInput, "ocr_cpu_capability_unknown"):
                require_cpu_avx()

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
            reader.return_value.read.side_effect = [tokens(value) if value is not None else [] for value in server_values]
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

    def test_disjoint_reader_timestamps_retain_evidence_for_both(self):
        source = frames() + [{**frame, "timestamp": frame["timestamp"] + 1} for frame in frames()]
        output, _ = self.run_case(source=source, server_values=["0012.3"] * 3 + [None] * 3,
                                 ai_readings=[Reading("0012.3", "1.8.0", t) for t in [1, 1.2, 1.4]])
        self.assertEqual(output["server"]["status"], "ok")
        self.assertEqual(output["ai"]["status"], "ok")
        self.assertEqual(len(output["evidence"]), 6)
        self.assertEqual(len(output["server"]["frames"]), 3)
        self.assertEqual(len(output["ai"]["frames"]), 3)
        self.assertNotIn("insufficient_retained_evidence", output["issues"])

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

    def test_server_retry_is_denser_without_calling_a_stable_ai_again(self):
        job = {"meter": METER, "media": [{"mimeType": "video/mp4"}]}
        dense = [{**frame, "timestamp": round(frame["timestamp"] + .1, 1)} for frame in frames()]
        with TemporaryDirectory() as directory, patch("recognize.probe_media", return_value=1), \
                patch("recognize.extract_frames", return_value=[]) as extract, \
                patch("recognize.inspect_frames", side_effect=[(frames(), {QR}), (dense, {QR})]), \
                patch("recognize.PaddleReader") as reader, \
                patch("recognize.read_ai", return_value=([Reading("0012.3", "1.8.0", 0), Reading("0012.3", "1.8.0", .2)], True, "fixture")) as ai:
            reader.return_value.read.side_effect = [[], [], []] + [tokens("0012.3")] * 3
            output = recognize(job, Path("fixture.mp4"), Path(directory))
            self.assertEqual([call.args[-1] for call in extract.call_args_list], [5, 10])
            self.assertEqual(output["server"]["status"], "ok")
            self.assertEqual(ai.call_count, 1)

    def test_dense_retry_reads_only_new_ocr_timestamps_and_keeps_initial_observations(self):
        job = {"meter": METER, "media": [{"mimeType": "video/mp4"}]}
        dense = [frames()[0], {**frames()[1], "timestamp": .3, "path": Path("fixture-fresh.jpg")}, frames()[2]]
        with TemporaryDirectory() as directory, patch("recognize.probe_media", return_value=1), \
                patch("recognize.extract_frames", return_value=[]), \
                patch("recognize.inspect_frames", side_effect=[(frames(), {QR}), (dense, {QR})]), \
                patch("recognize.PaddleReader") as reader, \
                patch("recognize.read_ai", return_value=([Reading("0012.3", "1.8.0", 0), Reading("0012.3", "1.8.0", .2)], True, "fixture")):
            reader.return_value.read.side_effect = [tokens("0012.3"), [], [], tokens("0012.3")]
            output = recognize(job, Path("fixture.mp4"), Path(directory))
            self.assertEqual(reader.return_value.read.call_count, 4)
            self.assertEqual(output["server"]["value"], "0012.3")
            self.assertEqual([frame["timestampSeconds"] for frame in output["server"]["frames"]], [0, .3])
            self.assertEqual(reader.return_value.read.call_args.args[0], Path("fixture-fresh.jpg"))

    def test_dense_server_retry_does_not_erase_a_conflicting_initial_digit(self):
        output, _ = self.run_case(server_values=["0012.3", "0012.4", None] + ["0012.3"] * 3)
        self.assertEqual(output["server"]["status"], "unreadable")
        self.assertIsNone(output["server"]["value"])
        self.assertIn("server_different_values_or_registers", output["issues"])

    def test_ai_insufficient_frames_trigger_dense_retry_without_ocr_hints(self):
        job = {"meter": METER, "media": [{"mimeType": "video/mp4"}]}
        observations = [([Reading("0012.3", "1.8.0", 0)], True, "fixture"),
                        ([Reading("0012.3", "1.8.0", .2)], True, "fixture")]
        with TemporaryDirectory() as directory, patch("recognize.probe_media", return_value=1), \
                patch("recognize.extract_frames", return_value=[]) as extract, \
                patch("recognize.inspect_frames", return_value=(frames(), {QR})), \
                patch("recognize.PaddleReader") as reader, patch("recognize.read_ai", side_effect=observations) as ai:
            reader.return_value.read.return_value = tokens("0012.3")
            output = recognize(job, Path("fixture.mp4"), Path(directory))
            self.assertEqual([call.args[-1] for call in extract.call_args_list], [5, 10])
            self.assertEqual(ai.call_count, 2)
            self.assertEqual(reader.return_value.read.call_count, 3)
            self.assertEqual(output["ai"]["value"], "0012.3")
            self.assertEqual([frame["timestampSeconds"] for frame in output["ai"]["frames"]], [0, .2])
            self.assertNotIn("ocr", ai.call_args.args[0][0])

    def test_dense_ai_retry_cannot_replace_a_conflicting_initial_value(self):
        job = {"meter": METER, "media": [{"mimeType": "video/mp4"}]}
        observations = [([Reading("0012.3", "1.8.0", 0)], True, "fixture"),
                        ([Reading("0012.8", "1.8.0", .2), Reading("0012.8", "1.8.0", .4)], True, "fixture")]
        with TemporaryDirectory() as directory, patch("recognize.probe_media", return_value=1), \
                patch("recognize.extract_frames", return_value=[]), \
                patch("recognize.inspect_frames", return_value=(frames(), {QR})), \
                patch("recognize.PaddleReader") as reader, patch("recognize.read_ai", side_effect=observations):
            reader.return_value.read.return_value = tokens("0012.3")
            output = recognize(job, Path("fixture.mp4"), Path(directory))
            self.assertEqual(output["ai"]["status"], "unreadable")
            self.assertIsNone(output["ai"]["value"])
            self.assertIn("ai_different_values_or_registers", output["issues"])

    def test_cpu_budget_preserves_completed_ai_and_does_not_start_a_dense_pass(self):
        clock = {"now": 0}
        future = Future()
        future.set_result(([Reading("0012.3", "1.8.0", 0), Reading("0012.3", "1.8.0", .2)], True, "fixture"))
        def slow_read(_):
            clock["now"] = 225
            return tokens("0012.3")
        with TemporaryDirectory() as directory, patch("recognize.time.monotonic", side_effect=lambda: clock["now"]), \
                patch("recognize.probe_media", return_value=1), patch("recognize.extract_frames", return_value=[]) as extract, \
                patch("recognize.inspect_frames", return_value=(frames(), {QR})), \
                patch("recognize.PaddleReader") as reader, patch("recognize.ThreadPoolExecutor") as pool:
            pool.return_value.submit.return_value = future
            reader.return_value.read.side_effect = slow_read
            output = recognize({"meter": METER, "media": [{"mimeType": "video/mp4"}]}, Path("fixture.mp4"), Path(directory))
            self.assertEqual(reader.return_value.read.call_count, 1)
            self.assertEqual(extract.call_count, 1)
            self.assertEqual(output["ai"]["value"], "0012.3")
            self.assertEqual(len(output["ai"]["frames"]), 2)
            self.assertEqual(output["server"]["status"], "unreadable")
            self.assertIn("server_time_budget_exhausted", output["issues"])
            self.assertIn("recognition_time_budget_exhausted", output["issues"])
            pool.return_value.shutdown.assert_called_once_with(wait=False, cancel_futures=True)

    def test_ai_timeout_is_clamped_to_remaining_budget_after_decoding(self):
        clock = {"now": 0}
        future = Future()
        future.set_result(([Reading("0012.3", "1.8.0", 0), Reading("0012.3", "1.8.0", .2)], True, "fixture"))
        def slow_inspection(*_):
            clock["now"] = 225
            return frames(), {QR}
        with TemporaryDirectory() as directory, patch("recognize.time.monotonic", side_effect=lambda: clock["now"]), \
                patch("recognize.probe_media", return_value=1), patch("recognize.extract_frames", return_value=[]), \
                patch("recognize.inspect_frames", side_effect=slow_inspection), \
                patch("recognize.PaddleReader") as reader, patch("recognize.ThreadPoolExecutor") as pool:
            pool.return_value.submit.return_value = future
            output = recognize({"meter": METER, "media": [{"mimeType": "video/mp4"}]}, Path("fixture.mp4"), Path(directory))
            self.assertEqual(pool.return_value.submit.call_args.kwargs["timeout"], 10)
            reader.assert_not_called()
            self.assertEqual(output["ai"]["value"], "0012.3")

    def test_pending_provider_does_not_make_executor_shutdown_wait_past_budget(self):
        clock = {"now": 0}
        future = Future()
        def slow_read(_):
            clock["now"] = 241
            return tokens("0012.3")
        with TemporaryDirectory() as directory, patch("recognize.time.monotonic", side_effect=lambda: clock["now"]), \
                patch("recognize.probe_media", return_value=1), patch("recognize.extract_frames", return_value=[]), \
                patch("recognize.inspect_frames", return_value=(frames(), {QR})), \
                patch("recognize.PaddleReader") as reader, patch("recognize.ThreadPoolExecutor") as pool:
            pool.return_value.submit.return_value = future
            reader.return_value.read.side_effect = slow_read
            output = recognize({"meter": METER, "media": [{"mimeType": "video/mp4"}]}, Path("fixture.mp4"), Path(directory))
            self.assertTrue(output["mediaValidated"])
            self.assertEqual(output["ai"]["status"], "error")
            self.assertIn("ai_time_budget_exhausted", output["issues"])
            pool.return_value.shutdown.assert_called_once_with(wait=False, cancel_futures=True)

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


class HttpBoundaryTests(unittest.TestCase):
    @staticmethod
    def gateway_response(request, timeout, body):
        # The configured production gateway returns 403/1010 for urllib's
        # generic identity. Use the worker's own identity, never a browser UA.
        if request.get_header("User-agent") != "ihome-meter-capture/1":
            raise urllib.error.HTTPError(request.full_url, 403, "client_identity_required", {}, None)
        return io.BytesIO(body)

    def test_json_gateway_and_ai_requests_identify_the_worker(self):
        with patch("recognize.urllib.request.build_opener") as opener:
            opener.return_value.open.side_effect = lambda request, timeout: self.gateway_response(request, timeout, b'{"ok":true}')
            self.assertEqual(request_json("https://gateway.invalid/chat/completions", "fixture-key", {}), {"ok": True})

    def test_ai_uses_measured_sol_settings_and_receives_only_images_and_configuration(self):
        response = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"singleMeter": True, "readings": [
            {"frameIndex": 0, "value": "0012.3", "registerCode": "1.8.0", "unit": "kWh", "clear": True},
        ]})}}]}
        with TemporaryDirectory() as directory, patch.dict("os.environ", {
            "METER_CAPTURE_AI_BASE_URL": "https://gateway.invalid/v1", "METER_CAPTURE_AI_KEY": "fixture", "METER_CAPTURE_AI_MODEL": "",
        }), patch("recognize.request_json", return_value=response) as gateway:
            path = Path(directory) / "fixture.jpg"
            path.write_bytes(b"synthetic-image")
            readings, single, version = read_ai([{"timestamp": 0, "path": path, "ocr": "do-not-send"}],
                                               {**METER, "previousReading": "do-not-send"})
            payload = gateway.call_args.args[2]
            self.assertEqual(payload["model"], "cx/gpt-6.1-sol")
            self.assertEqual(payload["reasoning_effort"], "medium")
            self.assertEqual(gateway.call_args.kwargs["timeout"], 90)
            self.assertEqual(payload["messages"][0]["content"][2]["image_url"]["detail"], "original")
            self.assertNotIn("do-not-send", json.dumps(payload))
            self.assertEqual(readings, [Reading("0012.3", "1.8.0", 0)])
            self.assertTrue(single)
            self.assertEqual(version, "cx/gpt-6.1-sol;reasoning=medium;detail=original")

    def test_original_download_uses_the_same_identity_and_keeps_digest_validation(self):
        original = b"fixture-original"
        media = {"id": "capture", "sizeBytes": len(original), "sha256": hashlib.sha256(original).hexdigest()}
        with TemporaryDirectory() as directory, patch.dict("os.environ", {
            "METER_CAPTURE_API_BASE_URL": "https://gateway.invalid/function",
            "METER_CAPTURE_WORKER_TOKEN": "fixture-token-" * 4,
        }), patch("worker.urllib.request.build_opener") as opener:
            opener.return_value.open.side_effect = lambda request, timeout: self.gateway_response(request, timeout, original)
            destination = Path(directory) / "original"
            Gateway().download({"jobId": "job", "leaseToken": "lease", "media": [media]}, destination)
            self.assertEqual(destination.read_bytes(), original)
            with self.assertRaisesRegex(InvalidInput, "download_digest_mismatch"):
                Gateway().download({"jobId": "job", "leaseToken": "lease", "media": [{**media, "sha256": "0" * 64}]},
                                   Path(directory) / "invalid-digest")


if __name__ == "__main__":
    unittest.main()

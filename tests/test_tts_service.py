import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import uuid

from tts_service import TTSManager, TTSError, PiperWorker, _encode_mp3, _matches_file, _voice_files


REVISION = "a" * 40
MANIFEST = {"repository": "rhasspy/piper-voices", "revision": REVISION,
            "voices": {"one": {"files": {}}, "two": {"files": {}}}}


class FakeWorker:
    def __init__(self, manifest, voice, cache_dir):
        self.voice, self.closed, self.started = voice, False, False
        self.failure = None

    def start(self, timeout):
        self.started = True

    def synthesize(self, text, length_scale, timeout):
        if self.failure:
            raise self.failure
        return b"mp3:" + text.encode()

    def close(self):
        self.closed = True


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.manifest = Path(self.temporary.name) / "voices.json"
        self.manifest.write_text(json.dumps(MANIFEST))
        self.workers = []
        self.now = 0

        def factory(*args):
            worker = FakeWorker(*args)
            self.workers.append(worker)
            return worker

        self.manager = TTSManager(manifest_path=self.manifest, worker_factory=factory,
                                  clock=lambda: self.now, lease_seconds=180, max_sessions=1)
        self.addCleanup(self.manager.shutdown)
        self.session_id = str(uuid.uuid4())

    def create(self):
        return self.manager.create("alice", self.session_id, "one", 1, REVISION)

    def assertStatus(self, status, function, *args):
        with self.assertRaises(TTSError) as context:
            function(*args)
        self.assertEqual(context.exception.status, status)

    def test_mp3_voice_switch_speed_and_close(self):
        self.create()
        first = self.workers[0]
        self.assertEqual(self.manager.synthesize("alice", self.session_id, "Hello", "one", 1), b"mp3:Hello")
        self.manager.configure("alice", self.session_id, "one", 0.5)
        self.assertEqual(len(self.workers), 1)
        self.manager.configure("alice", self.session_id, "two", 0.5)
        self.assertTrue(first.closed)
        self.assertEqual(self.workers[1].voice, "two")
        self.manager.close("alice", self.session_id)
        self.manager.close("alice", self.session_id)
        self.assertTrue(self.workers[1].closed)
        self.assertEqual(self.manager._sessions, {})

    def test_ownership_applies_to_all_operations(self):
        self.create()
        for function, args in (
            (self.manager.synthesize, ("bob", self.session_id, "x", "one", 1)),
            (self.manager.configure, ("bob", self.session_id, "two", 1)),
            (self.manager.heartbeat, ("bob", self.session_id)),
            (self.manager.close, ("bob", self.session_id)),
        ):
            self.assertStatus(404, function, *args)
        self.assertFalse(self.workers[0].closed)

    def test_expired_lease_cleans_worker_but_heartbeat_renews(self):
        self.create()
        self.now = 170
        self.manager.heartbeat("alice", self.session_id)
        self.now = 181
        self.manager.expire()
        self.assertFalse(self.workers[0].closed)
        self.now = 350
        self.manager.expire()
        self.assertTrue(self.workers[0].closed)
        self.assertStatus(404, self.manager.heartbeat, "alice", self.session_id)

    def test_close_before_activation_is_tombstoned(self):
        self.manager.close("alice", self.session_id)
        self.assertStatus(410, self.create)
        self.assertEqual(self.workers, [])

    def test_close_during_model_load_does_not_resurrect_worker(self):
        entered, released = threading.Event(), threading.Event()
        failures = []

        def factory(*args):
            worker = FakeWorker(*args)
            worker.start = lambda timeout: (entered.set(), released.wait(2))
            self.workers.append(worker)
            return worker

        self.manager._factory = factory

        def load():
            try:
                self.create()
            except TTSError as error:
                failures.append(error.status)

        thread = threading.Thread(target=load)
        thread.start()
        self.assertTrue(entered.wait(1))
        self.manager.close("alice", self.session_id)
        released.set()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [404])
        self.assertTrue(self.workers[0].closed)
        self.assertEqual(self.manager._sessions, {})

    def test_limits_and_model_revision_validation(self):
        self.assertStatus(409, self.manager.create, "alice", self.session_id, "one", 1, "old")
        for scale in (True, 0, float("nan"), float("inf"), "1"):
            self.assertStatus(400, self.manager.create, "alice", self.session_id, "one", scale, REVISION)
        self.create()
        self.assertStatus(503, self.manager.create, "alice", str(uuid.uuid4()), "one", 1, REVISION)
        self.assertStatus(413, self.manager.synthesize, "alice", self.session_id, "x" * 5001, "one", 1)

    def test_stale_settings_do_not_synthesize_or_destroy_current_session(self):
        self.create()
        self.manager.configure("alice", self.session_id, "one", 0.5)
        self.assertStatus(409, self.manager.synthesize, "alice", self.session_id, "old", "one", 1)
        self.assertFalse(self.workers[0].closed)
        self.assertEqual(self.manager.synthesize("alice", self.session_id, "new", "one", 0.5), b"mp3:new")

    def test_timeout_disposes_session_instead_of_reusing_stale_ipc(self):
        self.create()
        self.workers[0].failure = TTSError(504, "Timed out")
        self.assertStatus(504, self.manager.synthesize, "alice", self.session_id, "x", "one", 1)
        self.assertTrue(self.workers[0].closed)
        self.assertStatus(404, self.manager.heartbeat, "alice", self.session_id)

    def test_excess_admission_does_not_wait_or_cancel_active_request(self):
        self.create()
        session = self.manager._sessions[self.session_id]
        for _ in range(3):
            session.admission.acquire()
        try:
            self.assertStatus(503, self.manager.synthesize, "alice", self.session_id, "x", "one", 1)
            self.assertFalse(self.workers[0].closed)
        finally:
            for _ in range(3):
                session.admission.release()

    def test_two_concurrent_phrases_wait_and_keep_ipc_serialized(self):
        self.create()
        entered, released = threading.Event(), threading.Event()
        calls, outputs, failures = [], {}, []

        def render(text, length_scale, timeout):
            calls.append(text)
            if text == "first":
                entered.set()
                released.wait(2)
            return text.encode()

        self.workers[0].synthesize = render

        def request(text):
            try:
                outputs[text] = self.manager.synthesize("alice", self.session_id, text, "one", 1)
            except Exception as error:
                failures.append(error)

        first = threading.Thread(target=request, args=("first",))
        second = threading.Thread(target=request, args=("second",))
        first.start()
        self.assertTrue(entered.wait(1))
        second.start()
        self.assertEqual(calls, ["first"])
        released.set()
        first.join(2)
        second.join(2)
        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(calls, ["first", "second"])
        self.assertEqual(outputs, {"first": b"first", "second": b"second"})
        self.assertFalse(self.workers[0].closed)

    def test_close_cancels_queued_phrase_without_invoking_worker(self):
        self.create()
        session = self.manager._sessions[self.session_id]
        entered, released = threading.Event(), threading.Event()
        failures, calls = [], []

        def render(text, length_scale, timeout):
            calls.append(text)
            entered.set()
            released.wait(2)
            return text.encode()

        self.workers[0].synthesize = render

        def request(text):
            try:
                self.manager.synthesize("alice", self.session_id, text, "one", 1)
            except TTSError as error:
                failures.append((text, error.status))

        first = threading.Thread(target=request, args=("first",))
        second = threading.Thread(target=request, args=("second",))
        first.start()
        self.assertTrue(entered.wait(1))
        second.start()
        self.manager.close("alice", self.session_id)
        second.join(1)
        self.assertFalse(second.is_alive())
        self.assertIn(("second", 404), failures)
        released.set()
        first.join(2)
        self.assertFalse(first.is_alive())
        self.assertEqual(calls, ["first"])
        self.assertIn(("first", 404), failures)
        self.assertTrue(self.workers[0].closed)
        # Both admitted operations release their bounded slots after cancellation.
        self.assertTrue(all(session.admission.acquire(blocking=False) for _ in range(3)))

    def test_lock_wait_timeout_leaves_healthy_worker_active(self):
        self.create()
        session = self.manager._sessions[self.session_id]
        self.manager.synthesis_timeout = 0.01
        session.operation.acquire()
        try:
            self.assertStatus(503, self.manager.synthesize, "alice", self.session_id, "x", "one", 1)
        finally:
            session.operation.release()
        self.assertFalse(self.workers[0].closed)

    def test_failed_start_closes_worker_and_releases_capacity(self):
        def factory(*args):
            worker = FakeWorker(*args)
            worker.start = Mock(side_effect=TTSError(503, "Load failure"))
            self.workers.append(worker)
            return worker
        self.manager._factory = factory
        self.assertStatus(503, self.create)
        self.assertTrue(self.workers[0].closed)
        self.assertEqual(self.manager._sessions, {})

    def test_shutdown_closes_all_workers_and_rejects_future_loads(self):
        self.create()
        self.manager.shutdown()
        self.assertTrue(self.workers[0].closed)
        self.assertStatus(503, self.manager.create, "alice", str(uuid.uuid4()), "one", 1, REVISION)

    def test_checksum_rejects_corrupt_cache(self):
        target = Path(self.temporary.name) / "model"
        target.write_bytes(b"hello")
        metadata = {"size_bytes": 5, "md5_digest": "5d41402abc4b2a76b9719d911017c592"}
        self.assertTrue(_matches_file(target, metadata))
        target.write_bytes(b"wrong")
        self.assertFalse(_matches_file(target, metadata))

    def test_manifest_paths_and_revisions_are_not_client_controlled(self):
        manifest = {**MANIFEST, "voices": {"one": {"files": {"../model.onnx": {}}}}}
        with self.assertRaisesRegex(ValueError, "asset path"):
            _voice_files(manifest, "one", self.temporary.name)
        manifest = {**MANIFEST, "revision": "main"}
        with self.assertRaisesRegex(ValueError, "immutable"):
            _voice_files(manifest, "one", self.temporary.name)

    @patch("tts_service.urlopen")
    def test_interrupted_download_reuses_one_partial_and_commits_atomically(self, urlopen):
        manifest = {**MANIFEST, "voices": {"one": {"files": {
            "en/model.onnx": {"size_bytes": 5},
            "en/model.onnx.json": {"size_bytes": 2},
        }}}}
        partial = Path(self.temporary.name) / REVISION / "en/model.onnx.download"
        partial.parent.mkdir(parents=True)
        partial.write_bytes(b"an interrupted download")
        urlopen.side_effect = [io.BytesIO(b"model"), io.BytesIO(b"{}")]
        model = _voice_files(manifest, "one", self.temporary.name)
        self.assertEqual(model.read_bytes(), b"model")
        self.assertEqual(Path(str(model) + ".json").read_bytes(), b"{}")
        self.assertFalse(partial.exists())
        self.assertFalse(list(partial.parent.glob("*.download")))

    @patch("tts_service.urlopen")
    def test_failed_download_removes_partial_file(self, urlopen):
        manifest = {**MANIFEST, "voices": {"one": {"files": {"en/model.onnx": {}}}}}
        response = urlopen.return_value.__enter__.return_value
        response.read.side_effect = [b"partial", OSError("Connection interrupted")]
        with self.assertRaisesRegex(OSError, "Connection interrupted"):
            _voice_files(manifest, "one", self.temporary.name)
        self.assertFalse(list(Path(self.temporary.name).rglob("*.download")))
        self.assertFalse(list(Path(self.temporary.name).rglob("*.onnx")))

    @patch("tts_service.subprocess.Popen")
    def test_encoder_timeout_kills_and_reaps_encoder(self, popen):
        import subprocess
        encoder = popen.return_value
        encoder.communicate.side_effect = [subprocess.TimeoutExpired("ffmpeg", 30), (b"", b"")]
        with self.assertRaises(subprocess.TimeoutExpired):
            _encode_mp3(b"wav")
        encoder.kill.assert_called_once()
        self.assertEqual(encoder.communicate.call_count, 2)

    @patch("tts_service.os.killpg")
    def test_close_terminates_group_and_reaps_process(self, killpg):
        worker = PiperWorker(MANIFEST, "one", self.temporary.name)
        worker.process, worker.connection = Mock(), Mock()
        worker.process.pid = 12345
        worker.process.is_alive.side_effect = [True, False]
        worker.close()
        killpg.assert_called_once()
        worker.process.join.assert_called_once_with(timeout=2)
        worker.connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()

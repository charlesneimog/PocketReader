"""Optional server speech: one disposable Piper process per open reader.

Only this child process imports Piper/ONNX. Closing a session terminates its
process group (including an in-flight ffmpeg encoder), returning native memory
to the OS. Document parsing and layout stay entirely in the browser.
"""

import hashlib
import importlib.util
import io
import json
import logging
import math
import multiprocessing
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
from urllib.request import urlopen
import wave


logger = logging.getLogger("localreader.tts")
MANIFEST_PATH = Path(__file__).parent / "assets" / "tts-voices.json"


class TTSError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _session_id(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value.lower():
            raise ValueError()
    except (ValueError, AttributeError):
        raise TTSError(400, "Session id must be a UUID") from None
    return value.lower()


def _settings(manifest, voice, length_scale):
    if not isinstance(voice, str) or voice not in manifest["voices"]:
        raise TTSError(400, "Unsupported voice")
    if (
        isinstance(length_scale, bool)
        or not isinstance(length_scale, (float, int))
        or not math.isfinite(length_scale)
        or not 0.25 <= length_scale <= 4
    ):
        raise TTSError(400, "lengthScale must be between 0.25 and 4")
    return voice, float(length_scale)


def _matches_file(path, metadata):
    if not path.is_file():
        return False
    size = metadata.get("size_bytes")
    if size is not None and path.stat().st_size != size:
        return False
    for algorithm, field in (("sha256", "sha256"), ("md5", "md5_digest")):
        expected = metadata.get(field)
        if expected:
            digest = hashlib.new(algorithm)
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected.lower():
                return False
    return True


def _voice_files(manifest, voice_id, cache_dir):
    """Download only allowlisted immutable assets, atomically and with integrity checks."""
    import fcntl  # Linux self-hosted server/container

    revision = manifest["revision"]
    repository = manifest["repository"]
    if not re.fullmatch(r"[a-fA-F0-9]{40}", revision):
        raise ValueError("Voice manifest requires an immutable revision")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
        raise ValueError("Invalid model repository")
    root = Path(cache_dir) / revision
    root.mkdir(parents=True, exist_ok=True)
    model_path = None
    for relative_path, metadata in manifest["voices"][voice_id]["files"].items():
        relative = PurePosixPath(relative_path)
        if relative.is_absolute() or ".." in relative.parts or "\\" in relative_path:
            raise ValueError("Invalid voice asset path")
        # Download the model/config only; model cards and training samples are unnecessary.
        if not relative_path.endswith((".onnx", ".onnx.json")):
            continue
        destination = root.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.with_suffix(destination.suffix + ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not _matches_file(destination, metadata):
                # Only one writer holds this asset lock. A fixed partial name
                # bounds disk use when SIGTERM interrupts a model download and
                # skips finally; the next activation truncates that partial.
                temporary = destination.with_name(destination.name + ".download")
                try:
                    with temporary.open("wb") as target:
                        url = f"https://huggingface.co/{repository}/resolve/{revision}/{relative_path}"
                        with urlopen(url, timeout=30) as response:
                            shutil.copyfileobj(response, target, 1024 * 1024)
                    if not _matches_file(temporary, metadata):
                        raise RuntimeError("Downloaded voice asset failed integrity validation")
                    os.replace(temporary, destination)
                finally:
                    temporary.unlink(missing_ok=True)
        if relative_path.endswith(".onnx"):
            model_path = destination
    if model_path is None or not Path(str(model_path) + ".json").is_file():
        raise RuntimeError("Voice manifest is missing its ONNX model/configuration")
    return model_path


def _encode_mp3(wav_data):
    encoder = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-vn", "-codec:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        audio, error = encoder.communicate(wav_data, timeout=30)
    except BaseException:
        encoder.kill()
        encoder.communicate()
        raise
    if encoder.returncode or not audio:
        raise RuntimeError("MP3 encoding failed: " + error.decode("utf-8", "replace")[:300])
    return audio


def _worker_main(connection, manifest, voice_id, cache_dir):
    try:
        os.setsid()
        from piper import PiperVoice, SynthesisConfig

        path = _voice_files(manifest, voice_id, cache_dir)
        voice = PiperVoice.load(str(path), use_cuda=False)
        connection.send({"ok": True})
        while True:
            request = connection.recv()
            audio = io.BytesIO()
            settings = SynthesisConfig(
                length_scale=request["lengthScale"],
                noise_scale=0.667, noise_w_scale=0.8, normalize_audio=False,
            )
            with wave.open(audio, "wb") as wav_file:
                voice.synthesize_wav(request["text"], wav_file, syn_config=settings)
            connection.send({"ok": True, "audio": _encode_mp3(audio.getvalue())})
    except (EOFError, BrokenPipeError):
        pass
    except Exception:
        logger.exception("Speech worker failed")
        try:
            connection.send({"ok": False})
        except (EOFError, OSError):
            pass
    finally:
        connection.close()


class PiperWorker:
    """Single serialized IPC stream; any timeout permanently disposes the stream."""

    def __init__(self, manifest, voice, cache_dir):
        self.manifest, self.voice, self.cache_dir = manifest, voice, str(cache_dir)
        self.process = self.connection = None
        self._lock = threading.Lock()
        self._closed = False

    def start(self, timeout):
        with self._lock:
            if self._closed:
                raise TTSError(404, "Speech session closed")
            context = multiprocessing.get_context("spawn")
            self.connection, child = context.Pipe()
            self.process = context.Process(
                target=_worker_main,
                args=(child, self.manifest, self.voice, self.cache_dir),
                daemon=True,
            )
            try:
                self.process.start()
            except BaseException:
                self.connection.close()
                self.process = None
                raise
            finally:
                child.close()
        self._receive(timeout)

    def _receive(self, timeout):
        try:
            if not self.connection.poll(timeout):
                raise TTSError(504, "Speech worker timed out")
            response = self.connection.recv()
            if not response.get("ok"):
                raise TTSError(503, "Speech worker failed")
            return response
        except (EOFError, OSError, TypeError, ValueError):
            raise TTSError(503, "Speech worker disconnected") from None

    def synthesize(self, text, length_scale, timeout):
        try:
            self.connection.send({"text": text, "lengthScale": length_scale})
            return self._receive(timeout)["audio"]
        except (EOFError, OSError, TypeError):
            raise TTSError(503, "Speech worker disconnected") from None

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            process, connection = self.process, self.connection
            if process is not None:
                # Also clean up encoders if the Piper process already exited.
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    if process.is_alive():
                        process.terminate()
                if process.is_alive():
                    process.join(timeout=2)
                    if process.is_alive():
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            process.kill()
                        process.join(timeout=2)
                else:
                    process.join(timeout=0)
            if connection is not None:
                connection.close()


class _Session:
    def __init__(self, owner, voice, length_scale, worker, now):
        self.owner, self.voice, self.length_scale = owner, voice, length_scale
        self.worker, self.last_seen = worker, now
        self.operation = threading.Lock()
        self.admission = threading.BoundedSemaphore(3)
        self.closed = False


class TTSManager:
    def __init__(self, *, manifest_path=MANIFEST_PATH, cache_dir="data/tts-models",
                 enabled=True, max_sessions=2, lease_seconds=180,
                 startup_timeout=180, synthesis_timeout=45,
                 worker_factory=PiperWorker, clock=time.monotonic):
        with open(manifest_path, encoding="utf-8") as source:
            self.manifest = json.load(source)
        self.cache_dir, self.enabled = cache_dir, enabled
        self.max_sessions = max(1, max_sessions)
        self.lease_seconds = max(10, lease_seconds)
        self.startup_timeout, self.synthesis_timeout = startup_timeout, synthesis_timeout
        self._factory, self._clock = worker_factory, clock
        self._sessions, self._tombstones = {}, {}
        self._lock, self._stop = threading.Lock(), threading.Event()
        self._reaper = None

    @classmethod
    def from_environment(cls):
        configured = os.environ.get("TTS_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
        available = importlib.util.find_spec("piper") is not None and shutil.which("ffmpeg") is not None
        return cls(
            enabled=configured and available,
            cache_dir=os.environ.get("TTS_MODEL_CACHE_DIR", "data/tts-models"),
            max_sessions=int(os.environ.get("TTS_MAX_SESSIONS", "2")),
            lease_seconds=int(os.environ.get("TTS_SESSION_LEASE_SECONDS", "180")),
        )

    def capabilities(self):
        return {"enabled": self.enabled, "voices": list(self.manifest["voices"]),
                "modelRevision": self.manifest["revision"]}

    def start(self):
        if self._reaper is not None:
            return
        self._reaper = threading.Thread(target=self._reap_loop, name="tts-expiry", daemon=True)
        self._reaper.start()

    def _reap_loop(self):
        while not self._stop.wait(min(15, self.lease_seconds / 2)):
            self.expire()

    def _get(self, owner, session_id):
        session = self._sessions.get(session_id)
        if session is None or session.owner != owner or session.closed:
            raise TTSError(404, "Speech session not found")
        session.last_seen = self._clock()
        return session

    def _response(self, session_id, session):
        return {"id": session_id, "voice": session.voice, "lengthScale": session.length_scale,
                "modelRevision": self.manifest["revision"], "leaseSeconds": self.lease_seconds}

    def create(self, owner, session_id, voice, length_scale, model_revision):
        session_id = _session_id(session_id)
        voice, length_scale = _settings(self.manifest, voice, length_scale)
        if model_revision != self.manifest["revision"]:
            raise TTSError(409, "Client and server voice model revisions differ")
        if not self.enabled or self._stop.is_set():
            raise TTSError(503, "Server speech is unavailable")
        self.expire()
        with self._lock:
            if self._stop.is_set():
                raise TTSError(503, "Server speech is shutting down")
            if (owner, session_id) in self._tombstones:
                raise TTSError(410, "Speech session already closed")
            if session_id in self._sessions:
                raise TTSError(409, "Speech session already exists")
            if len(self._sessions) >= self.max_sessions:
                raise TTSError(503, "All server speech sessions are busy")
            session = _Session(owner, voice, length_scale,
                               self._factory(self.manifest, voice, self.cache_dir), self._clock())
            session.operation.acquire()
            self._sessions[session_id] = session
        try:
            session.worker.start(self.startup_timeout)
            with self._lock:
                self._get(owner, session_id)
                return self._response(session_id, session)
        except TTSError as error:
            if error.status >= 500:
                self.close(owner, session_id)
            raise
        except Exception:
            self.close(owner, session_id)
            raise
        finally:
            session.operation.release()

    def _operate(self, owner, session_id, callback):
        session_id = _session_id(session_id)
        with self._lock:
            session = self._get(owner, session_id)
            if not session.admission.acquire(blocking=False):
                raise TTSError(503, "Speech session is busy")
        acquired = False
        try:
            # Prefetch may request the next phrase while the current one renders.
            # Bound both admission and waiting; short waits let close cancel the
            # queue even if a native worker has not finished terminating yet.
            deadline = time.monotonic() + self.synthesis_timeout
            while not acquired:
                if session.closed:
                    raise TTSError(404, "Speech session closed")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TTSError(503, "Speech session is busy")
                acquired = session.operation.acquire(timeout=min(0.1, remaining))
            with self._lock:
                self._get(owner, session_id)
            try:
                result = callback(session)
                with self._lock:
                    self._get(owner, session_id)
                return result
            except TTSError as error:
                if error.status >= 500:
                    self.close(owner, session_id)
                raise
            except Exception:
                self.close(owner, session_id)
                raise
        finally:
            if acquired:
                session.operation.release()
            session.admission.release()

    def configure(self, owner, session_id, voice, length_scale):
        voice, length_scale = _settings(self.manifest, voice, length_scale)

        def update(session):
            if session.voice != voice:
                # A new process releases all memory associated with the old model.
                session.worker.close()
                with self._lock:
                    if session.closed:
                        raise TTSError(404, "Speech session closed")
                    session.worker = self._factory(self.manifest, voice, self.cache_dir)
                session.worker.start(self.startup_timeout)
            session.voice, session.length_scale = voice, length_scale
            return self._response(session_id, session)

        return self._operate(owner, session_id, update)

    def synthesize(self, owner, session_id, text, voice, length_scale):
        voice, length_scale = _settings(self.manifest, voice, length_scale)
        if not isinstance(text, str) or not text.strip():
            raise TTSError(400, "A phrase is required")
        if len(text) > 5000:
            raise TTSError(413, "Phrase exceeds 5000 characters")

        def render(session):
            if session.voice != voice or session.length_scale != length_scale:
                raise TTSError(409, "Speech settings changed; discard the outdated phrase")
            return session.worker.synthesize(text, length_scale, self.synthesis_timeout)

        return self._operate(owner, session_id, render)

    def heartbeat(self, owner, session_id):
        with self._lock:
            return self._response(session_id, self._get(owner, _session_id(session_id)))

    def close(self, owner, session_id):
        session_id = _session_id(session_id)
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None and session.owner != owner:
                raise TTSError(404, "Speech session not found")
            self._tombstones[(owner, session_id)] = self._clock() + max(300, self.startup_timeout + 60)
            # Bound idempotent-close bookkeeping, including unknown UUIDs.
            while len(self._tombstones) > 4096:
                self._tombstones.pop(next(iter(self._tombstones)))
            if session is not None:
                self._sessions.pop(session_id)
                session.closed = True
        if session is not None:
            session.worker.close()

    def expire(self):
        now = self._clock()
        with self._lock:
            stale = []
            for sid, session in list(self._sessions.items()):
                if now - session.last_seen >= self.lease_seconds:
                    self._sessions.pop(sid)
                    session.closed = True
                    self._tombstones[(session.owner, sid)] = now + 300
                    stale.append(session)
            self._tombstones = {key: until for key, until in self._tombstones.items() if until > now}
        for session in stale:
            session.worker.close()

    def shutdown(self):
        self._stop.set()
        with self._lock:
            sessions = [(session.owner, sid) for sid, session in self._sessions.items()]
        for owner, session_id in sessions:
            self.close(owner, session_id)
        if self._reaper is not None:
            self._reaper.join(timeout=2)

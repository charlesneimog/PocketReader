from email.message import Message
import io
import json
import unittest
from unittest.mock import Mock

from server import APIHandler
from tts_service import TTSError


SESSION = "12345678-1234-1234-1234-123456789abc"


class Request(APIHandler):
    """Exercise real handlers without binding a socket or running a server."""
    def __init__(self, method, path, data=None, *, owner="alice", manager=None, raw=None):
        self.command, self.path = method, path
        self.client_address = ("127.0.0.1", 12345)
        self.headers = Message()
        self.headers["Origin"] = "https://reader.example"
        body = raw if raw is not None else json.dumps(data or {}).encode()
        self.headers["Content-Length"] = str(len(body))
        self.rfile, self.wfile = io.BytesIO(body), io.BytesIO()
        self.owner, self.tts_manager = owner, manager
        self.status, self.response_headers = None, []
        self.ALLOWED_ORIGINS = ["https://reader.example"]
        self.ALLOW_ANY_ORIGIN = False

    def _get_auth_email(self):
        return self.owner

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.response_headers.append((name, value))

    def end_headers(self):
        pass

    def run(self):
        getattr(self, "do_" + self.command)()
        return self

    def json(self):
        return json.loads(self.wfile.getvalue())


class ServerSpeechTests(unittest.TestCase):
    def test_capabilities_disabled_without_dependencies_or_manager(self):
        request = Request("GET", "/api/tts/capabilities").run()
        self.assertEqual(request.status, 200)
        self.assertFalse(request.json()["enabled"])

    def test_all_routes_require_authentication(self):
        for method, path in (("GET", "/api/tts/capabilities"),
                             ("POST", "/api/tts/sessions"),
                             ("PUT", f"/api/tts/sessions/{SESSION}"),
                             ("DELETE", f"/api/tts/sessions/{SESSION}"),
                             ("POST", f"/api/tts/sessions/{SESSION}/heartbeat"),
                             ("POST", f"/api/tts/sessions/{SESSION}/phrases")):
            manager = Mock()
            request = Request(method, path, owner=None, manager=manager).run()
            self.assertEqual(request.status, 401)
            self.assertEqual(manager.mock_calls, [])

    def test_activation_passes_model_revision_and_owner(self):
        manager = Mock()
        manager.create.return_value = {"id": SESSION}
        request = Request("POST", "/api/tts/sessions", manager=manager, data={
            "id": SESSION, "voice": "one", "lengthScale": 0.5, "modelRevision": "revision",
        }).run()
        self.assertEqual(request.status, 201)
        manager.create.assert_called_once_with("alice", SESSION, "one", 0.5, "revision")

    def test_phrase_response_is_binary_mp3_with_single_cors_origin(self):
        manager = Mock()
        manager.synthesize.return_value = b"\xff\xfbMP3"
        request = Request("POST", f"/api/tts/sessions/{SESSION}/phrases", manager=manager,
                          data={"text": "Hello", "voice": "one", "lengthScale": 1}).run()
        self.assertEqual(request.status, 200)
        self.assertEqual(request.wfile.getvalue(), b"\xff\xfbMP3")
        self.assertIn(("Content-Type", "audio/mpeg"), request.response_headers)
        self.assertIn(("Cache-Control", "no-store"), request.response_headers)
        self.assertEqual([value for name, value in request.response_headers
                          if name == "Access-Control-Allow-Origin"], ["https://reader.example"])
        manager.synthesize.assert_called_once_with("alice", SESSION, "Hello", "one", 1)

    def test_update_heartbeat_and_delete_pass_owner(self):
        manager = Mock()
        manager.configure.return_value = manager.heartbeat.return_value = {"id": SESSION}
        request = Request("PUT", f"/api/tts/sessions/{SESSION}", manager=manager,
                          data={"voice": "two", "lengthScale": 2}).run()
        self.assertEqual(request.status, 200)
        manager.configure.assert_called_once_with("alice", SESSION, "two", 2)
        Request("POST", f"/api/tts/sessions/{SESSION}/heartbeat", manager=manager).run()
        manager.heartbeat.assert_called_once_with("alice", SESSION)
        request = Request("DELETE", f"/api/tts/sessions/{SESSION}", manager=manager).run()
        manager.close.assert_called_once_with("alice", SESSION)
        self.assertEqual(request.status, 200)

    def test_invalid_oversized_and_nonobject_json_never_reach_worker(self):
        for raw, status in ((b"{", 400), (b"[]", 400), (b"x" * 65537, 413)):
            manager = Mock()
            request = Request("POST", "/api/tts/sessions", manager=manager, raw=raw).run()
            self.assertEqual(request.status, status)
            self.assertEqual(manager.mock_calls, [])

    def test_service_error_status_is_preserved(self):
        manager = Mock()
        manager.synthesize.side_effect = TTSError(409, "Settings changed")
        request = Request("POST", f"/api/tts/sessions/{SESSION}/phrases", manager=manager).run()
        self.assertEqual(request.status, 409)
        self.assertEqual(request.json(), {"error": "Settings changed"})

    def test_cors_does_not_match_origin_prefixes(self):
        request = Request("OPTIONS", "/api/tts/sessions")
        request.headers.replace_header("Origin", "https://reader.example.evil.test")
        request.run()
        self.assertEqual(request.status, 204)
        self.assertFalse(any(name == "Access-Control-Allow-Origin" for name, _ in request.response_headers))


if __name__ == "__main__":
    unittest.main()

import io
import json
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock

import app
from reading_reminder_service import ReadingReminderService
from server import APIHandler


class ReadingReminderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original_path = app.DB_PATH
        app.DB_PATH = f"{self.directory.name}/database.db"
        app.init_db()
        app.create_user("reader@example.com", "strong-password")
        self.sent = []
        self.current = datetime(2026, 9, 7, 22, tzinfo=timezone.utc)
        self.service = ReadingReminderService(
            repository=app, send_email=lambda *args: self.sent.append(args),
            now=lambda: self.current, public_app_url="https://reader.example.com/",
        )

    def tearDown(self):
        app.DB_PATH = self.original_path
        self.directory.cleanup()

    def enable(self, zone="America/Sao_Paulo", time="19:00"):
        app.update_reading_reminder_preference("reader@example.com", True, zone, time)

    def test_opt_in_and_local_time_with_persisted_duplicate_prevention(self):
        self.assertFalse(app.get_reading_reminder_preference("reader@example.com")["enabled"])
        self.assertEqual(self.service.run_once(), 0)
        self.enable()
        self.current = datetime(2026, 9, 7, 21, 59, tzinfo=timezone.utc)
        self.assertEqual(self.service.run_once(), 0)
        self.current = datetime(2026, 9, 7, 22, tzinfo=timezone.utc)
        self.assertEqual(self.service.run_once(), 1)
        app.init_db()  # Restarting the database must preserve the delivery claim.
        self.assertEqual(self.service.run_once(), 0)
        self.assertIn("https://reader.example.com/", self.sent[0][2])
        self.current = datetime(2026, 9, 8, 22, tzinfo=timezone.utc)
        self.assertEqual(self.service.run_once(), 1)
        app.update_reading_reminder_preference("reader@example.com", False, "UTC", "19:00")
        self.current = datetime(2026, 9, 9, 22, tzinfo=timezone.utc)
        self.assertEqual(self.service.run_once(), 0)

    def test_synced_activity_suppresses_only_the_local_day(self):
        self.enable(time="23:00")
        self.current = datetime(2026, 9, 8, 2, tzinfo=timezone.utc)
        original = app.get_reward_state
        try:
            app.get_reward_state = lambda _: {"activeTimeByDay": {"2026-09-07": 1000}}
            self.assertEqual(self.service.run_once(), 0)
            app.get_reward_state = lambda _: {"activeTimeByDay": {"2026-09-06": 1000}}
            self.assertEqual(self.service.run_once(), 1)
        finally:
            app.get_reward_state = original

    def test_failed_send_retries_but_success_recording_failure_keeps_claim(self):
        self.enable()
        self.service.send_email = Mock(side_effect=OSError("SMTP unavailable"))
        with self.assertLogs("localreader.reading_reminder", level="ERROR"):
            self.assertEqual(self.service.run_once(), 0)
        self.service.send_email = lambda *args: self.sent.append(args)
        original = app.complete_email_digest_delivery
        try:
            app.complete_email_digest_delivery = Mock(side_effect=OSError("database unavailable"))
            with self.assertLogs("localreader.reading_reminder", level="ERROR"):
                self.service.run_once()
        finally:
            app.complete_email_digest_delivery = original
        self.assertEqual(self.service.run_once(), 0)
        self.assertEqual(len(self.sent), 1)

    def test_dst_repeated_hour_sends_once_and_skipped_hour_catches_up(self):
        self.enable("America/New_York", "01:30")
        self.current = datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc)
        self.assertEqual(self.service.run_once(), 1)
        self.current = datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc)
        self.assertEqual(self.service.run_once(), 0)
        self.enable("America/New_York", "02:30")
        self.current = datetime(2026, 3, 8, 7, tzinfo=timezone.utc)
        self.assertEqual(self.service.run_once(), 1)

    def put_preference(self, payload, authenticated=True):
        handler = object.__new__(APIHandler)
        handler.path = "/api/reading-reminder-preferences"
        body = json.dumps(payload).encode()
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler._require_auth = Mock(return_value="reader@example.com" if authenticated else None)
        handler._send_json = Mock()
        handler._send_error = Mock()
        handler.do_PUT()
        return handler

    def test_api_validates_input_and_scopes_preference_to_signed_in_account(self):
        valid = {"enabled": True, "time": "18:45", "timezone": "America/Sao_Paulo"}
        for field, value in [("time", "24:00"), ("time", "9:00"), ("timezone", "invalid"), ("enabled", "true")]:
            with self.subTest(field=field, value=value):
                handler = self.put_preference({**valid, field: value})
                self.assertEqual(handler._send_error.call_args.args[0], 400)
        self.assertEqual(self.put_preference([])._send_error.call_args.args[0], 400)
        self.put_preference(valid, authenticated=False)
        self.assertFalse(app.get_reading_reminder_preference("reader@example.com")["enabled"])
        handler = self.put_preference({**valid, "email": "someone-else@example.com"})
        self.assertEqual(handler._send_json.call_args.args, (200, valid))
        self.assertFalse(app.get_reading_reminder_preference("someone-else@example.com")["enabled"])


if __name__ == "__main__":
    unittest.main()

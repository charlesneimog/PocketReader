#!/usr/bin/env python3
import json
import re
import os
import asyncio
import base64
import hashlib
import hmac
import secrets
import smtplib
import logging
import mimetypes
from copy import deepcopy
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import default
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote, quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import unicodedata
import app
from reading_digest_service import ReadingDigestService
from reading_reminder_service import ReadingReminderService

HOST = "0.0.0.0"
PORT = 8000


AUTH_SECRET = os.environ.get("AUTH_SECRET") or secrets.token_urlsafe(32)
AUTH_TOKEN_TTL_SECONDS = int(os.environ.get("AUTH_TOKEN_TTL_SECONDS", "604800"))  # 7 days


LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").strip().upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("localreader.server")

# Ensure proper JS MIME types (important for ES modules)
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")

# Webfonts (Android PWAs can be picky about MIME types)
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("font/otf", ".otf")


STATIC_ROOT = os.environ.get("STATIC_ROOT") or os.path.dirname(os.path.abspath(__file__))
STATIC_ROOT = os.path.abspath(STATIC_ROOT)
PUBLIC_APP_URL = (os.environ.get("PUBLIC_APP_URL") or "").strip()


async def translate_text_for_api(text, target, translator_factory=None):
    """Translate through Google's GTX endpoint and fail on upstream errors.

    googletrans normally returns its input text as dummy data when Google
    responds with an error. Using raise_exception=True is essential here:
    otherwise the API reports HTTP 200 and the Portuguese Piper voice receives
    the original English sentence.
    """
    if translator_factory is None:
        from googletrans import Translator

        translator_factory = Translator

    async with translator_factory(
        service_urls=["translate.googleapis.com"],
        raise_exception=True,
    ) as translator:
        result = await translator.translate(text, src="auto", dest=target)

    translated = str(getattr(result, "text", "") or "").strip()
    if not translated:
        raise RuntimeError("Translation provider returned empty text")

    return {
        "translatedText": translated,
        "detectedSource": getattr(result, "src", None),
        "target": getattr(result, "dest", None) or target,
    }


def _read_version_from_frontend_config(static_root: str) -> str:
    config_path = os.path.join(static_root, "src", "config.js")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return ""

    def _extract_number(field_name: str) -> int | None:
        m = re.search(rf"{field_name}\s*:\s*(\d+)", content)
        if not m:
            return None
        try:
            return int(m.group(1))
        except Exception:
            return None

    major = _extract_number("VERSION_MAJOR")
    minor = _extract_number("VERSION_MINOR")
    patch = _extract_number("VERSION_PATCH")
    build = _extract_number("VERSION_BUILD")

    if None in {major, minor, patch, build}:
        return ""

    return f"{major}.{minor}.{patch}+{build}"


def _read_version_from_sw(static_root: str) -> str:
    sw_path = os.path.join(static_root, "sw.js")
    try:
        with open(sw_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return ""

    m = re.search(r'const\s+APP_VERSION\s*=\s*["\']([^"\']+)["\']', content)
    if not m:
        return ""

    return (m.group(1) or "").strip().lstrip("vV")


def _resolve_server_app_version() -> str:
    env_version = (os.environ.get("APP_VERSION") or os.environ.get("SERVER_VERSION") or "").strip()
    if env_version:
        return env_version.lstrip("vV")

    config_version = _read_version_from_frontend_config(STATIC_ROOT)
    if config_version:
        return config_version

    sw_version = _read_version_from_sw(STATIC_ROOT)
    if sw_version:
        return sw_version

    return "unknown"


SERVER_APP_VERSION = _resolve_server_app_version()


def _guess_content_type(path: str) -> str:
    ct, _ = mimetypes.guess_type(path)
    if ct:
        return ct
    # Better defaults for common web assets
    if path.endswith(".js"):
        return "application/javascript"
    if path.endswith(".wasm"):
        return "application/wasm"
    if path.endswith(".css"):
        return "text/css"
    if path.endswith(".webmanifest"):
        return "application/manifest+json"
    if path.endswith(".mjs"):
        return "application/javascript"
    return "application/octet-stream"


def _set_no_cache_headers(handler: BaseHTTPRequestHandler) -> None:
    """Prevent browsers, service workers, and reverse proxies from reusing stale app files."""
    handler.send_header(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
    )
    handler.send_header("Pragma", "no-cache")
    handler.send_header("Expires", "0")
    handler.send_header("Surrogate-Control", "no-store")
    handler.send_header("X-Accel-Expires", "0")
    handler.send_header("X-PocketReader-Version", SERVER_APP_VERSION)


def _safe_static_path(url_path: str) -> str | None:
    """Map a URL path to a file under STATIC_ROOT, preventing path traversal."""
    if not url_path:
        return None

    # Strip query/fragment if passed accidentally
    path = url_path.split("?", 1)[0].split("#", 1)[0]

    # Allow hosting under /PocketReader/ (GitHub Pages) as well as at root.
    if path.startswith("/PocketReader/"):
        path = path[len("/PocketReader") :]
    elif path == "/PocketReader":
        path = "/"

    if path in {"", "/"}:
        path = "/index.html"

    # Normalize and ensure it's within STATIC_ROOT
    rel = path.lstrip("/")
    # Avoid backslash on Windows-like paths
    rel = rel.replace("\\", "/")
    full = os.path.abspath(os.path.join(STATIC_ROOT, rel))
    if not full.startswith(STATIC_ROOT + os.sep):
        return None
    return full


def _normalize_public_app_url(value: str) -> str:
    s = (value or "").strip()
    if not s:
        return ""
    # Ensure trailing slash for consistent joins
    return s if s.endswith("/") else (s + "/")


def _rewrite_manifest(manifest: dict, public_app_url: str) -> dict:
    """Rewrite the manifest for a self-hosted base URL.

    Notes:
      - PWA manifests are same-origin; this rewrite mainly updates paths/scope so
        the manifest matches the served location.
      - The original project uses /PocketReader/ for GitHub Pages; for self-host
        we commonly serve at /.
    """
    url = _normalize_public_app_url(public_app_url)
    if not url:
        return manifest

    parsed = urlparse(url)
    base_path = parsed.path or "/"
    if not base_path.endswith("/"):
        base_path += "/"
    start_url = base_path + "index.html"

    out = deepcopy(manifest)
    # Keep a stable id within the same origin, but aligned to the base path.
    out["id"] = start_url
    out["start_url"] = start_url
    out["scope"] = base_path

    # Optional: replace the scope extension origin if present.
    try:
        if isinstance(out.get("scope_extensions"), list) and out["scope_extensions"]:
            first = out["scope_extensions"][0]
            if isinstance(first, dict) and first.get("type") == "origin":
                first["origin"] = url
    except Exception:
        pass

    return out


_CONTROL_CHARS_RE = re.compile(r"[\u0000-\u001F\u007F]+")


def _normalize_file_id(value: str) -> str:
    """Normalize file identifiers coming from URLs/forms.

    Removes ASCII control chars (incl. CR/LF/TAB) and trims.
    Collapses whitespace so that folded header artifacts do not break lookups.
    """
    if not isinstance(value, str):
        return ""
    s = _CONTROL_CHARS_RE.sub(" ", value)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(raw: str) -> bytes:
    padding = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode((raw + padding).encode("ascii"))


def _env_truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def issue_auth_token(email: str, ttl_seconds: int = AUTH_TOKEN_TTL_SECONDS) -> str:
    exp = int((datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)).timestamp())
    payload = json.dumps({"email": email, "exp": exp}, separators=(",", ":")).encode("utf-8")
    payload_b64 = _b64url_encode(payload)
    sig = hmac.new(AUTH_SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = _b64url_encode(sig)
    return f"{payload_b64}.{sig_b64}"


def verify_auth_token(token: str) -> str | None:
    if not token or "." not in token:
        return None
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        expected_sig = hmac.new(
            AUTH_SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
        ).digest()
        provided_sig = _b64url_decode(sig_b64)
        if not hmac.compare_digest(expected_sig, provided_sig):
            return None
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        exp = int(payload.get("exp", 0))
        if exp <= int(datetime.now(timezone.utc).timestamp()):
            return None
        email = payload.get("email")
        return email if isinstance(email, str) and email.strip() else None
    except Exception:
        return None


def _parse_multipart_form_data(content_type: str, body: bytes) -> tuple[dict, dict]:
    """Parse multipart/form-data without using deprecated cgi.

    Returns (fields, files) where:
      - fields: {name: str}
      - files: {name: {filename, content_type, content(bytes)}}
    """
    if not content_type or not content_type.startswith("multipart/form-data"):
        return {}, {}

    # The email parser expects a full message; synthesize minimal headers.
    msg = BytesParser(policy=default).parsebytes(
        b"Content-Type: " + content_type.encode("utf-8") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    if not msg.is_multipart():
        return {}, {}

    fields: dict[str, str] = {}
    files: dict[str, dict] = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        filename = part.get_param("filename", header="content-disposition")
        payload = part.get_payload(decode=True) or b""
        if filename is not None:
            files[name] = {
                "filename": filename,
                "content_type": part.get_content_type(),
                "content": payload,
            }
        else:
            charset = part.get_content_charset() or "utf-8"
            try:
                fields[name] = payload.decode(charset, errors="replace")
            except LookupError:
                fields[name] = payload.decode("utf-8", errors="replace")

    return fields, files


def _send_email_smtp(to_email: str, subject: str, body: str, html_body: str = "") -> None:
    host = os.environ.get("SMTP_HOST", "")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASS", "")
    sender = os.environ.get("SMTP_FROM", user)
    use_tls = (os.environ.get("SMTP_USE_TLS", "true").strip().lower() in {"1", "true", "yes"})

    if not host or not sender or not user or not password:
        raise RuntimeError("SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM)")

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.ehlo()
        if use_tls:
            smtp.starttls()
            smtp.ehlo()
        smtp.login(user, password)
        smtp.send_message(msg)


def _smtp_is_configured() -> bool:
    return all(
        (os.environ.get(name) or "").strip()
        for name in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS")
    ) and bool((os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER") or "").strip())


class APIHandler(BaseHTTPRequestHandler):
    # Read allowed origins from environment variable, fallback to defaults
    ALLOWED_ORIGINS = [
        o.strip()
        for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "http://127.0.0.1:8080,https://charlesneimog.github.io,http://localhost:8080"
        ).split(",")
        if o.strip()
    ]
    # Useful for reverse-proxy/public-domain deployments where many origins may hit the API.
    # When enabled, the server reflects the request Origin instead of requiring explicit allow-list entries.
    ALLOW_ANY_ORIGIN = _env_truthy(os.environ.get("ALLOW_ANY_ORIGIN"))
    
    def _is_origin_allowed(self, origin: str) -> bool:
        if not origin:
            return False
        if self.ALLOW_ANY_ORIGIN:
            return True
        for allowed_origin in self.ALLOWED_ORIGINS:
            allowed_origin = (allowed_origin or "").strip()
            if not allowed_origin:
                continue
            if allowed_origin == "*":
                return True
            # Historically we used prefix-matching (startswith). Keep that behavior
            # for compatibility with older deployments.
            if origin.startswith(allowed_origin):
                return True
        return False

    @staticmethod
    def _split_header_tokens(value: str) -> list[str]:
        if not value:
            return []
        out = []
        seen = set()
        for token in value.split(","):
            item = (token or "").strip()
            if not item:
                continue
            key = item.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
        return out

    def _set_cors_headers(self):
        """Set CORS headers to allow browser requests.

        Also supports Chrome's Private Network Access ("local address space")
        preflight by returning `Access-Control-Allow-Private-Network: true`.
        """
        origin = (self.headers.get("Origin") or "").strip()
        origin_allowed = self._is_origin_allowed(origin)
        vary_tokens = []

        if origin_allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
            vary_tokens.append("Origin")

        requested_method = (self.headers.get("Access-Control-Request-Method") or "").strip().upper()
        allowed_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
        if requested_method and requested_method not in allowed_methods:
            allowed_methods.append(requested_method)

        requested_headers_raw = self.headers.get("Access-Control-Request-Headers") or ""
        requested_headers = self._split_header_tokens(requested_headers_raw)
        base_headers = ["Content-Type", "Authorization", "Access-Control-Request-Private-Network"]
        merged_headers = []
        seen = set()
        for hdr in base_headers + requested_headers:
            key = hdr.lower()
            if key in seen:
                continue
            seen.add(key)
            merged_headers.append(hdr)

        self.send_header("Access-Control-Allow-Methods", ", ".join(allowed_methods))
        self.send_header("Access-Control-Allow-Headers", ", ".join(merged_headers))
        self.send_header("Access-Control-Allow-Credentials", "true")
        # Cache preflight for a bit to reduce OPTIONS spam
        self.send_header("Access-Control-Max-Age", "600")

        # Chrome Private Network Access (PNA)
        # If the browser is trying to reach a private/local IP behind this hostname,
        # it will send a preflight request with this header.
        is_pna_preflight = (self.headers.get("Access-Control-Request-Private-Network") or "").strip().lower() == "true"
        if is_pna_preflight:
            vary_tokens.append("Access-Control-Request-Private-Network")
        if requested_method:
            vary_tokens.append("Access-Control-Request-Method")
        if requested_headers_raw:
            vary_tokens.append("Access-Control-Request-Headers")

        # Chrome checks this on PNA preflight; keeping it on allowed CORS responses is harmless
        # and avoids edge cases with proxies/caches during rollout differences.
        if origin_allowed:
            self.send_header("Access-Control-Allow-Private-Network", "true")

        if vary_tokens:
            self.send_header("Vary", ", ".join(vary_tokens))

    def _set_cross_origin_isolation_headers(self) -> None:
        """Set headers required for crossOriginIsolated mode.

        Required for SharedArrayBuffer and cross-origin isolated contexts.
        """
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Access-Control-Allow-Origin", "*")

    def _should_apply_coi_headers(self, path: str) -> bool:
        """Decide whether to apply Cross-Origin Isolation headers."""
        p = (path or "").split("?", 1)[0].split("#", 1)[0]
        if p in {"", "/", "/index.html"}:
            return True
        if p.startswith("/api/") or p in {"/api"}:
            return True
        pl = p.lower()
        return pl.endswith((
            ".html",
            ".js",
            ".mjs",
            ".wasm",
            ".worker.js",
            ".css",
            ".webmanifest",
        ))

    def _get_auth_email(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        token = auth[len("Bearer ") :].strip()
        return verify_auth_token(token)

    def _require_auth(self):
        email = self._get_auth_email()
        if not email:
            logger.info("Unauthorized request: method=%s path=%s ip=%s", self.command, self.path, self.client_address[0])
            self._send_json(401, {"error": "Unauthorized"})
            return None
        return email
    
    def _send_json(self, status_code, data):
        """Send JSON response."""
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self._set_cors_headers()
        # Apply COI headers for API responses to support WASM threading.
        # This is safe to send broadly and keeps behavior consistent.
        self._set_cross_origin_isolation_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def _send_error(self, status_code, message):
        """Send error response."""
        self._send_json(status_code, {"error": message})
    
    def do_OPTIONS(self):
        """Handle preflight requests."""
        logger.debug("CORS preflight: path=%s origin=%s", self.path, self.headers.get("Origin", ""))
        # 204 is typical for preflight and avoids implying a body
        self.send_response(204)
        self._set_cors_headers()
        # Ensure COI headers exist on preflight responses as well.
        self._set_cross_origin_isolation_headers()
        self.end_headers()
    
    def do_GET(self):
        """Handle GET requests."""
        parsed = urlparse(self.path)
        path = parsed.path

        logger.debug("GET %s ip=%s", path, self.client_address[0])

        # Serve the web UI + static assets (anything not under /api/*)
        if not path.startswith("/api/") and path not in {"/api"}:
            self._serve_static(path)
            return
        
        # GET /api/ping - Simple health check
        if path == "/api/ping":
            logger.debug("Ping")
            self._send_json(
                200,
                {
                    "status": "ok",
                    "message": "Server is running",
                    "version": SERVER_APP_VERSION,
                    "server_version": SERVER_APP_VERSION,
                },
            )
            return

        # GET /api/auth/me
        if path == "/api/auth/me":
            email = self._get_auth_email()
            if not email:
                self._send_json(200, {"authenticated": False})
                return
            self._send_json(200, {"authenticated": True, "email": email})
            return

        # All other API routes require auth
        user_email = self._require_auth()
        if not user_email:
            return

        if path == "/api/reading-reminder-preferences":
            self._send_json(200, app.get_reading_reminder_preference(user_email))
            return

        if path == "/api/reading-digest-preferences":
            self._send_json(200, app.get_email_digest_preference(user_email))
            return
        
        # GET /api/files - List all files
        if path == "/api/rewards":
            self._send_json(200, {"snapshot": app.get_reward_state(user_email)})
            return

        # GET /api/files - List all files
        if path == "/api/files":
            files = app.get_files(owner_email=user_email)
            deleted = app.get_deleted_files(owner_email=user_email)

            # Emit tombstones as lightweight entries so other instances can purge local copies.
            for d in deleted:
                actual = (d.get("actual_filename") or "").strip()
                deleted_at = d.get("deleted_at")
                if not actual:
                    continue
                fmt = "epub" if actual.lower().endswith(".epub") else "pdf"
                files.append(
                    {
                        "filename": actual,
                        "title": actual,
                        "format": fmt,
                        "reading_position": None,
                        "voice": None,
                        "translation_target": None,
                        "translation_mode": None,
                        "created_at": deleted_at,
                        "updated_at": deleted_at,
                        "position_updated_at": deleted_at,
                        "highlights_updated_at": deleted_at,
                        "voice_updated_at": deleted_at,
                        "translation_updated_at": deleted_at,
                        "deleted": True,
                        "deleted_at": deleted_at,
                    }
                )

            logger.info(
                "List files: owner=%s count=%d tombstones=%d",
                user_email,
                len(files),
                len(deleted),
            )
            self._send_json(200, {"files": files})
            return
        
        # GET /api/files/{file_id}/download
        match = re.match(r'^/api/files/(.+)/download$', path)
        if match:
            file_id = _normalize_file_id(unquote(match.group(1)))
            logger.info("Download request: owner=%s file_id=%s", user_email, file_id)

            if app.is_file_deleted(file_id, owner_email=user_email):
                self._send_json(410, {"error": "File deleted", "deleted": True})
                return
            
            file_data = app.get_file_blob(file_id, owner_email=user_email)
            if file_data:
                # Extract filename from file_id (format: "file::filename::size::timestamp")
                filename = file_id
                if file_id.startswith("file::"):
                    parts = file_id.split("::")
                    if len(parts) >= 2:
                        filename = parts[1]  # Get the actual filename
                
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                filename = unicodedata.normalize("NFC", filename)
                ascii_filename = filename.encode("ascii", "ignore").decode("ascii") or "download"
                quoted_filename = quote(filename)
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{ascii_filename}"; filename*=UTF-8\'\'{quoted_filename}'
                )
                self._set_cors_headers()
                self._set_cross_origin_isolation_headers()
                self.end_headers()
                self.wfile.write(file_data)
                logger.info("Download served: owner=%s bytes=%d filename=%s", user_email, len(file_data), filename)
            else:
                self._send_error(404, "File not found")
            return
        
        # GET /api/files/{file_id}/highlights
        match = re.match(r'^/api/files/(.+)/highlights$', path)
        if match:
            file_id = _normalize_file_id(unquote(match.group(1)))
            logger.info("Get highlights: owner=%s file_id=%s", user_email, file_id)
            
            highlights = app.get_highlights(file_id, owner_email=user_email)
            if highlights is not None:
                self._send_json(200, {"highlights": highlights})
            else:
                self._send_json(200, {"highlights": []})
            return
        
        # GET /api/files/{file_id}
        match = re.match(r'^/api/files/(.+)$', path)
        if match:
            file_id = _normalize_file_id(unquote(match.group(1)))
            logger.debug("Check file exists: owner=%s file_id=%s", user_email, file_id)
            
            # Get file metadata
            file_data = app.get_file_data(file_id, owner_email=user_email)
            if file_data:
                logger.debug("File exists: owner=%s file_id=%s", user_email, file_id)
                self._send_json(200, {
                    "exists": True,
                    "file_id": file_data.get("filename"),
                    "title": file_data.get("title"),
                    "format": file_data.get("format"),
                    "reading_position": file_data.get("reading_position"),
                    "voice": file_data.get("voice"),
                    "translation_target": file_data.get("translation_target"),
                    "translation_mode": file_data.get("translation_mode"),
                    "created_at": file_data.get("created_at"),
                    "updated_at": file_data.get("updated_at"),
                    "position_updated_at": file_data.get("position_updated_at"),
                    "highlights_updated_at": file_data.get("highlights_updated_at"),
                    "voice_updated_at": file_data.get("voice_updated_at"),
                    "translation_updated_at": file_data.get("translation_updated_at"),
                })
            else:
                logger.debug("File not found: owner=%s file_id=%s", user_email, file_id)
                if app.is_file_deleted(file_id, owner_email=user_email):
                    self._send_json(410, {"exists": False, "deleted": True, "file_id": file_id})
                else:
                    self._send_json(404, {"exists": False, "file_id": file_id})
            return
        
        self._send_error(404, "Not found")

    def _serve_static(self, url_path: str) -> None:
        full_path = _safe_static_path(url_path)
        if not full_path:
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            _set_no_cache_headers(self)
            if self._should_apply_coi_headers(url_path):
                self._set_cross_origin_isolation_headers()
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        if not os.path.exists(full_path) or not os.path.isfile(full_path):
            logger.info("Static 404: url_path=%s resolved=%s", url_path, full_path)
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            _set_no_cache_headers(self)
            if self._should_apply_coi_headers(url_path):
                self._set_cross_origin_isolation_headers()
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        try:
            # Rewrite manifest dynamically if PUBLIC_APP_URL is set.
            if full_path.endswith("manifest.webmanifest"):
                with open(full_path, "rb") as f:
                    raw = f.read()
                try:
                    manifest = json.loads(raw.decode("utf-8"))
                except Exception:
                    manifest = None

                if isinstance(manifest, dict) and PUBLIC_APP_URL:
                    manifest = _rewrite_manifest(manifest, PUBLIC_APP_URL)
                    data = json.dumps(manifest, ensure_ascii=False, indent=4).encode("utf-8")
                else:
                    data = raw
                content_type = "application/manifest+json"
            else:
                content_type = _guess_content_type(full_path)
                with open(full_path, "rb") as f:
                    data = f.read()

            self.send_response(200)
            self.send_header("Content-Type", content_type)
            if self._should_apply_coi_headers(url_path):
                self._set_cross_origin_isolation_headers()
            _set_no_cache_headers(self)

            # Allow service worker to control the whole origin even if installed from /PocketReader/
            if url_path.startswith("/PocketReader/") and full_path.endswith("sw.js"):
                self.send_header("Service-Worker-Allowed", "/")

            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            logger.exception("Static file serve failed: path=%s", url_path)
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            _set_no_cache_headers(self)
            if self._should_apply_coi_headers(url_path):
                self._set_cross_origin_isolation_headers()
            self.end_headers()
            self.wfile.write(f"Internal server error: {e}".encode("utf-8"))
    
    def do_POST(self):
        """Handle POST requests."""
        parsed = urlparse(self.path)
        path = parsed.path

        # POST /api/auth/signup
        if path == "/api/auth/signup":
            logger.info("Signup attempt")
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            email = (data.get("email") or "").strip()
            password = data.get("password") or ""

            if not email or not password:
                self._send_error(400, "Missing 'email' or 'password'")
                return

            ok = app.create_user(email, password)
            if not ok:
                logger.info("Signup failed: email=%s", (email or "").strip().lower())
                self._send_error(400, "Signup failed (email may already exist or password too short)")
                return

            logger.info("Signup success: email=%s", email.strip().lower())

            # Best-effort welcome email (uses SMTP settings; ignored if not configured)
            try:
                app_name = os.environ.get("APP_NAME", "PocketReader")
                _send_email_smtp(
                    email.strip().lower(),
                    f"Welcome to {app_name}",
                    f"Your {app_name} account was created successfully.\n",
                )
            except Exception as e:
                logger.warning("Signup email not sent: email=%s err=%s", email.strip().lower(), e)

            token = issue_auth_token(email.strip().lower())
            self._send_json(201, {"success": True, "token": token})
            return

        # POST /api/auth/login
        if path == "/api/auth/login":
            logger.info("Login attempt")
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            email = (data.get("email") or "").strip()
            password = data.get("password") or ""
            if not email or not password:
                self._send_error(400, "Missing 'email' or 'password'")
                return

            if not app.verify_user(email, password):
                logger.info("Login failed: email=%s", email.strip().lower())
                self._send_error(401, "Invalid credentials")
                return

            logger.info("Login success: email=%s", email.strip().lower())

            token = issue_auth_token(email.strip().lower())
            self._send_json(200, {"success": True, "token": token})
            return

        # POST /api/auth/request-password-reset
        if path == "/api/auth/request-password-reset":
            logger.info("Password reset request")
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            email = (data.get("email") or "").strip().lower()
            # Always return OK to avoid account enumeration.
            self._send_json(200, {"success": True})

            if not email or not app.user_exists(email):
                return

            reset_token = secrets.token_urlsafe(32)
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            if not app.create_password_reset(email, reset_token, expires_at):
                return

            logger.info("Password reset token created: email=%s", email)

            try:
                app_name = os.environ.get("APP_NAME", "PocketReader")
                subject = f"{app_name} password reset"
                body = (
                    f"You requested a password reset for {app_name}.\n\n"
                    f"Reset code: {reset_token}\n\n"
                    f"This code expires in 1 hour. If you did not request this, you can ignore this email.\n"
                )
                _send_email_smtp(email, subject, body)
            except Exception as e:
                # Log but do not leak details to the client.
                logger.warning("Failed to send reset email: email=%s err=%s", email, e)
            return

        # POST /api/auth/reset-password
        if path == "/api/auth/reset-password":
            logger.info("Password reset attempt")
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            email = (data.get("email") or "").strip().lower()
            token = (data.get("token") or "").strip()
            new_password = data.get("newPassword") or ""

            if not email or not token or not new_password:
                self._send_error(400, "Missing 'email', 'token', or 'newPassword'")
                return
            if len(new_password) < 8:
                self._send_error(400, "Password must be at least 8 characters")
                return

            if not app.consume_password_reset(email, token):
                logger.info("Password reset failed: email=%s reason=invalid_or_expired", email)
                self._send_error(400, "Invalid or expired reset token")
                return

            if not app.set_user_password(email, new_password):
                logger.warning("Password reset failed: email=%s reason=db_update_failed", email)
                self._send_error(400, "Failed to set password")
                return

            logger.info("Password reset success: email=%s", email)

            token_auth = issue_auth_token(email)
            self._send_json(200, {"success": True, "token": token_auth})
            return

        # All non-auth routes below require auth
        user_email = self._require_auth()
        if not user_email:
            return

        # POST /api/translate
        if path == "/api/translate":
            logger.info("Translate request: owner=%s", user_email)
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            text = (data.get("text") or "").strip()
            target = (data.get("target") or os.environ.get("TRANSLATE_TARGET_LANG") or "pt").strip()

            if not text:
                self._send_error(400, "Missing 'text' field")
                return

            # Basic safety/size cap (Google Translate web endpoints are not designed for huge payloads)
            if len(text) > 5000:
                self._send_error(413, "Text too long (max 5000 chars)")
                return

            try:
                translation = asyncio.run(translate_text_for_api(text, target))
                logger.info(
                    "Translate success: owner=%s source=%s target=%s input_chars=%d output_chars=%d",
                    user_email,
                    translation.get("detectedSource") or "unknown",
                    translation.get("target") or target,
                    len(text),
                    len(translation.get("translatedText") or ""),
                )
                self._send_json(200, translation)
                return
            except ImportError:
                self._send_error(
                    501,
                    "Translation support not installed on server. Install googletrans==4.0.2.",
                )
                return
            except Exception as e:
                logger.exception("Translation failed: owner=%s", user_email)
                self._send_error(500, f"Translation failed: {str(e)}")
                return
        
        # POST /api/files
        if path == "/api/files":
            logger.info("Upload attempt: owner=%s", user_email)
            try:
                content_type = self.headers.get("Content-Type", "")

                if not content_type.startswith("multipart/form-data"):
                    self._send_error(400, "Expected multipart/form-data")
                    return

                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                fields, files = _parse_multipart_form_data(content_type, body)

                file_id = _normalize_file_id(fields.get("file_id") or "")
                title = _normalize_file_id(fields.get("title") or "")
                format_type = (fields.get("format") or "").strip()
                voice = (fields.get("voice") or "").strip() or None

                file_data = None
                file_part = files.get("file")
                if file_part:
                    file_data = file_part.get("content")

                logger.info(
                    "Upload received: owner=%s file_id=%s format=%s bytes=%d",
                    user_email,
                    file_id,
                    format_type,
                    (len(file_data) if file_data else 0),
                )
                
                if not all([file_id, title, format_type, file_data]):
                    self._send_error(400, "Missing required fields: file_id, title, format, file")
                    return
                
                try:
                    result_id = app.add_file_with_id(
                        file_id,
                        title,
                        file_data,
                        format_type,
                        voice,
                        owner_email=user_email,
                    )
                except app.FileDeletedError:
                    logger.info("Upload rejected (tombstoned): owner=%s file_id=%s", user_email, file_id)
                    self._send_json(410, {"error": "File is marked deleted on server", "deleted": True})
                    return

                logger.info("Upload stored: owner=%s file_id=%s", user_email, result_id)
                
                self._send_json(201, {
                    "success": True,
                    "file_id": result_id,
                    "message": "File uploaded successfully"
                })
                return
                
            except Exception as e:
                logger.exception("Upload failed: owner=%s", user_email)
                self._send_error(500, f"Upload failed: {str(e)}")
                return
        
        self._send_error(404, "Not found")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        user_email = self._require_auth()
        if not user_email:
            return

        # DELETE /api/files/{file_id}
        match = re.match(r'^/api/files/(.+)$', path)
        if match:
            file_id = _normalize_file_id(unquote(match.group(1)))
            logger.info("Delete request: owner=%s file_id=%s", user_email, file_id)

            ok = app.mark_file_deleted(file_id, owner_email=user_email)
            if ok:
                self._send_json(200, {"success": True, "deleted": True})
            else:
                self._send_error(400, "Invalid file id")
            return

        self._send_error(404, "Not found")
    
    def do_PUT(self):
        """Handle PUT requests."""
        parsed = urlparse(self.path)
        path = parsed.path

        user_email = self._require_auth()
        if not user_email:
            return
        
        # Read request body
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode()) if body else {}
        except Exception as e:
            self._send_error(400, f"Invalid JSON: {str(e)}")
            return

        if path == "/api/reading-reminder-preferences":
            if not isinstance(data, dict) or not isinstance(data.get("enabled"), bool):
                self._send_error(400, "Missing or invalid 'enabled' field")
                return
            timezone_name = data.get("timezone")
            reminder_time = data.get("time")
            if not isinstance(reminder_time, str) or not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", reminder_time):
                self._send_error(400, "Time must be HH:MM in 24-hour format")
                return
            try:
                if not isinstance(timezone_name, str):
                    raise ValueError("Missing timezone")
                ZoneInfo(timezone_name)
            except (ZoneInfoNotFoundError, ValueError):
                self._send_error(400, "Unknown IANA timezone")
                return
            app.update_reading_reminder_preference(user_email, data["enabled"], timezone_name, reminder_time)
            self._send_json(200, app.get_reading_reminder_preference(user_email))
            return

        if path == "/api/reading-digest-preferences":
            enabled = data.get("enabled")
            timezone_name = str(data.get("timezone") or "UTC").strip()
            if not isinstance(enabled, bool):
                self._send_error(400, "Missing or invalid 'enabled' field")
                return
            try:
                ZoneInfo(timezone_name)
            except (ZoneInfoNotFoundError, ValueError):
                self._send_error(400, "Unknown IANA timezone")
                return
            if not app.update_email_digest_preference(user_email, enabled, timezone_name):
                self._send_error(400, "Unable to save reading email preference")
                return
            self._send_json(
                200,
                {"success": True, "enabled": enabled, "timezone": timezone_name},
            )
            return
        
        # PUT /api/files/{file_id}/position
        if path == "/api/rewards":
            snapshot = data.get("snapshot")
            if not isinstance(snapshot, dict):
                self._send_error(400, "Missing or invalid 'snapshot' field")
                return
            try:
                app.update_reward_state(user_email, snapshot)
            except ValueError as error:
                self._send_error(413, str(error))
                return
            self._send_json(200, {"success": True})
            return

        # PUT /api/files/{file_id}/position
        match = re.match(r'^/api/files/(.+)/position$', path)
        if match:
            file_id = _normalize_file_id(unquote(match.group(1)))
            position = data.get("position")

            logger.info(
                "Update position: owner=%s file_id=%s has_position=%s",
                user_email,
                file_id,
                position is not None,
            )
            
            if position is None:
                self._send_error(400, "Missing 'position' field")
                return
            
            success = app.update_position_by_file_id(file_id, str(position), owner_email=user_email)
            
            if success:
                self._send_json(200, {"success": True, "message": "Position updated"})
            else:
                self._send_error(404, "File not found")
            return
        
        # PUT /api/files/{file_id}/voice
        match = re.match(r'^/api/files/(.+)/voice$', path)
        if match:
            file_id = _normalize_file_id(unquote(match.group(1)))
            voice = data.get("voice")

            logger.info(
                "Update voice: owner=%s file_id=%s has_voice=%s",
                user_email,
                file_id,
                bool(voice),
            )
            
            if not voice:
                self._send_error(400, "Missing 'voice' field")
                return
            
            success = app.update_voice_by_file_id(file_id, voice, owner_email=user_email)
            
            if success:
                self._send_json(200, {"success": True, "message": "Voice updated"})
            else:
                self._send_error(404, "File not found")
            return
        
        # PUT /api/files/{file_id}/highlights
        match = re.match(r'^/api/files/(.+)/highlights$', path)
        if match:
            file_id = _normalize_file_id(unquote(match.group(1)))
            highlights = data.get("highlights")

            logger.info(
                "Update highlights: owner=%s file_id=%s count=%d",
                user_email,
                file_id,
                (len(highlights) if isinstance(highlights, list) else 0),
            )
            
            if not isinstance(highlights, list):
                self._send_error(400, "Missing or invalid 'highlights' field")
                return
            
            count = app.update_highlights(file_id, highlights, owner_email=user_email)
            logger.info("Highlights updated: owner=%s file_id=%s written=%d", user_email, file_id, count)
            
            self._send_json(200, {
                "success": True,
                "message": f"Updated {count} highlights"
            })
            return

        # PUT /api/files/{file_id}/translation-settings
        match = re.match(r'^/api/files/(.+)/translation-settings$', path)
        if match:
            file_id = _normalize_file_id(unquote(match.group(1)))
            target = (data.get("target") or "").strip()
            mode = (data.get("mode") or "").strip().lower()

            logger.info(
                "Update translation settings: owner=%s file_id=%s mode=%s target=%s",
                user_email,
                file_id,
                mode,
                target,
            )

            if mode not in {"read", "show", "off"}:
                self._send_error(400, "Missing or invalid 'mode' field (read|show|off)")
                return

            if not target:
                target = "pt"

            success = app.update_translation_settings_by_file_id(
                file_id,
                target,
                mode,
                owner_email=user_email,
            )

            if success:
                self._send_json(200, {"success": True, "message": "Translation settings updated"})
            else:
                self._send_error(404, "File not found")
            return
        
        self._send_error(404, "Not found")
    
    # NOTE: multipart parsing is handled by email.parser (stdlib) for correctness with binary files.
    
    def log_message(self, format, *args):
        """Log requests to stdout."""
        logger.info("HTTP: %s", format % args)


def main():
    # Initialize database
    app.init_db()
    logger.info("Database initialized at %s", app.DB_PATH)
    
    # Start server
    server = ThreadingHTTPServer((HOST, PORT), APIHandler)
    logger.info("Server running on http://%s:%s", HOST, PORT)
    logger.info("Static root: %s", STATIC_ROOT)
    logger.info("Server app version: %s", SERVER_APP_VERSION)
    # Helpful for diagnosing missing static files in container builds
    try:
        probe = os.path.join(STATIC_ROOT, "thirdparty", "foliate-js", "epubcfi.js")
        logger.info("Static probe: %s exists=%s", probe, os.path.exists(probe))
    except Exception:
        pass
    logger.info("CORS allowed origins: %s", ",".join([o.strip() for o in APIHandler.ALLOWED_ORIGINS if o.strip()]))
    logger.info("CORS allow any origin: %s", APIHandler.ALLOW_ANY_ORIGIN)
    logger.debug("API endpoints: GET /api/files, GET /api/files/{file_id}, GET /api/files/{file_id}/download, GET /api/files/{file_id}/highlights")
    logger.debug("API endpoints: POST /api/files, DELETE /api/files/{file_id}, PUT /api/files/{file_id}/position|voice|highlights")
    logger.debug("API endpoints: GET|PUT /api/reading-digest-preferences")

    reminder_service = None
    if _env_truthy(os.environ.get("READING_REMINDER_ENABLED", "true")):
        if _smtp_is_configured():
            reminder_service = ReadingReminderService(
                repository=app,
                send_email=_send_email_smtp,
                app_name=os.environ.get("APP_NAME", "PocketReader"),
                public_app_url=PUBLIC_APP_URL,
                poll_interval_seconds=int(os.environ.get("READING_REMINDER_POLL_SECONDS", "60")),
            )
            reminder_service.start()
            logger.info("Reading reminder scheduler started")
        else:
            logger.warning("Reading reminders enabled but SMTP is not configured")

    digest_service = None
    if _env_truthy(os.environ.get("READING_DIGEST_ENABLED", "true")):
        if _smtp_is_configured():
            digest_service = ReadingDigestService(
                repository=app,
                send_email=_send_email_smtp,
                app_name=os.environ.get("APP_NAME", "PocketReader"),
                public_app_url=PUBLIC_APP_URL,
                poll_interval_seconds=int(os.environ.get("READING_DIGEST_POLL_SECONDS", "900")),
                weekly_hour=int(os.environ.get("READING_DIGEST_WEEKLY_HOUR", "18")),
                monthly_hour=int(os.environ.get("READING_DIGEST_MONTHLY_HOUR", "9")),
                yearly_hour=int(os.environ.get("READING_DIGEST_YEARLY_HOUR", "18")),
            )
            digest_service.start()
            logger.info("Reading email digest scheduler started")
        else:
            logger.warning("Reading email digests enabled but SMTP is not configured")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down server...")
        server.shutdown()
    finally:
        if digest_service:
            digest_service.stop()
        if reminder_service:
            reminder_service.stop()


if __name__ == "__main__":
    main()

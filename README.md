<p align="center">
  <h1 align="center">PocketReader</h1>
  <p align="center">
    <a href="https://charlesneimog.github.io/PocketReader">
      <img src="assets/icons/icon.svg" width="10%" alt="Logo">
    </a>
  </p>
</p>

**PocketReader** is a privacy-focused, offline PDF & EPUB reader with natural-sounding text-to-speech using **Piper**.  
It runs entirely in your browser and can be installed as a **Progressive Web App (PWA)** for desktop or mobile.

---

## Features

- Open and read local **PDF** and **EPUB** files directly in the browser.  
- **Local TTS** using *Piper* (on-device / WASM builds) for natural speech.  
- **Offline-first:** works fully offline once models are loaded.  
- **Word and sentence-level highlights** with persistent storage (IndexedDB).  
- **Document gallery** with progressive thumbnails and resume support.  
- **EPUB** rendering via *Foliate-view* (annotations, CFIs).  
- **PDF** rendering via *PDF.js* with sentence extraction and layout cleanup.  
- **Accessible UI**, keyboard navigation, and per-sentence playback control.  
- **No required remote storage service or telemetry.**
- Optional sync through either a self-hosted server or Google Drive.

## Usage

1. Click **Open Document** to choose a PDF or EPUB file.
2. Use the floating toolbar for playback and highlight controls.
3. Press **Home** to access the saved documents gallery.
4. Your progress, highlights, and files persist locally in IndexedDB.

**Keyboard shortcuts:**

| Key     | Action                     |
| ------- | -------------------------- |
| `Space` | Play / Pause TTS           |
| `h`     | Highlight current sentence |
| `c`     | Comment current sentence   |
| `t`     | Translate current sentence |
| `f`     | Toggle fullscreen          |

---

## Architecture Overview

For runtime call flows, ownership boundaries, design rationale, invariants, and future simplification candidates, see [Application architecture](docs/app-architecture.md).

* `index.html` — App shell and main UI
* `sw.js`, `manifest.webmanifest` — PWA configuration
* `src/`

  * `app.js` — Main orchestrator (global `app` instance)
  * `core/` — State, cache, and event management
  * `modules/`

    * `pdf/` — PDF.js integration, sentence parsing, highlight overlays
    * `epub/` — EPUB loader using *Foliate-view*
    * `tts/` — Piper TTS, audio synthesis queue, WebAudio engine
    * `storage/` — IndexedDB persistence for progress/highlights/files
    * `ui/` — Toolbar, highlighting, and controls
* `thirdparty/` — Vendor libraries (PDF.js, Foliate, Piper builds)

Built with **WebAssembly**, **ONNX**, **Piper-TTS**, and **Foliate-JS**.

---

## Development

* Static web app, no bundler needed for development.
* Serve locally (see Quick Start) and edit directly under `src/`.
* Debug via browser console — most runtime messages appear in the UI info box.
* Selfhost server (save pdf files, highlights, and current reading position).

---

## Contributing

Contributions are welcome!
Please:

1. Open an issue describing your proposal or bug.
2. Create a feature branch for your work.
3. Keep pull requests focused and include a brief test description.

---

## Privacy

* 100% client-side; no network requests or remote analytics.
* Self host for sync between devices + translation.
* Documents, highlights, and progress are stored locally (IndexedDB).
* Users have full control of their data.

---

## How to Selfhost

Copy `.env.default` to `.env`. Edit `.env`.

then run:

```
docker-compose build --no-cache
docker-compose up -d
```

If you will host the site in another domain than [charlesneimog.github.io](charlesneimog.github.io), add this domain in `ALLOWED_ORIGINS`, multiple domains can be used using commas.

For public HTTPS frontends calling this server on a private network (Chrome Private Network Access), keep your frontend domain(s) in `ALLOWED_ORIGINS`.
If you need to accept many public domains, set `ALLOW_ANY_ORIGIN=true`.

The server handles preflight (`OPTIONS`) and returns `Access-Control-Allow-Private-Network: true` when requested by the browser preflight and the origin is allowed.

If you want the same server to also serve the web UI (so you can open `http(s)://<server>:8997/` and get the app), set:

`PUBLIC_APP_URL=http://192.168.15.10:8997/`

You can configure the target translation language (used by `t`) with `TRANSLATE_TARGET_LANG` in `compose.yml` (example: `pt`, `es`, `fr`).

Put the domain where the selfhost will be accessible in the `Server Link` in the `PocketReader` configuration.

To enable browser-to-Drive sync, follow [the Google Drive registration guide](assets/GOOGLE_DRIVE_SETUP.md). Users can then choose **Continue with Google** in the cloud configuration panel.

### Reading reminders

Sign in to your self-hosted account, then enable **Settings → Reading reminders** and
choose a daily time (default 19:00). Reminders use your browser's timezone and the
same SMTP configuration as password recovery. They are off by default per account.

The server sends a short email with a link to `PUBLIC_APP_URL` when there is no synced
reading activity for that local day. Use a full `https://` or `http://` URL. Reading
while offline may still result in a reminder until your activity syncs.

The server checks every 60 seconds and records deliveries in SQLite to avoid repeat
emails for the same local date, including after restarts. If the server starts after
your chosen time, it can send that day's reminder before midnight; previous days are
not caught up. Failed SMTP sends are retried on a later check. An interrupted send
may be skipped to avoid duplicates. Set `READING_REMINDER_ENABLED=false` to disable
reminders for the deployment; `READING_REMINDER_POLL_SECONDS` controls polling
(minimum 60 seconds). The server must be running and SMTP configured for delivery.

### Reading summary emails

Self-hosted accounts receive reading summaries through the same SMTP configuration used for password recovery:

- weekly on Saturday at 18:00, covering Monday through Saturday;
- monthly on the first day at 09:00, covering the previous calendar month;
- yearly on December 31 at 18:00, covering the current calendar year.

The schedule is evaluated in the IANA timezone reported by the user's browser. Delivery is idempotent, so restarting the scheduler does not send the same period twice. Users can turn all reading summary emails off in **Settings → Reading summary emails**.

Messages are sent as multipart email with an HTML reading story and a plain-text fallback. The HTML view includes period totals, only the trees completed during that period rendered with PocketReader's catalog SVGs, and the reflections saved when those trees were planted.

Preview the sample email locally without sending it:

```bash
python scripts/preview_reading_digest.py
```

Open the printed `file:///tmp/pocketreader-reading-summary.html` URL in a browser. To preview persisted trees and planting reflections for an account, add `--email reader@example.com`; `--period YYYY-MM`, `--database PATH`, and `--output PATH` can be used when needed.

Required SMTP variables are `SMTP_HOST`, `SMTP_PORT`, `SMTP_USE_TLS`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. The optional `READING_DIGEST_*` variables in `.env.default` control scheduler polling and local delivery hours. Set `READING_DIGEST_ENABLED=false` to disable the service for the entire deployment.

---

### Credits

Created by **Charles K. Neimog**

With appreciation to the creators of **Piper**, **Foliate-JS**, **PDF.js**, and the open-source community.

---

### Links

* [Demo (GitHub Pages)](https://charlesneimog.github.io/PocketReader/)
* [Source Repository](https://github.com/charlesneimog/PocketReader)
* [Privacy Policy](https://charlesneimog.github.io/PocketReader/privacy.html)
* [Terms of Service](https://charlesneimog.github.io/PocketReader/terms.html)

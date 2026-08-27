# Wear LLM — an on-watch local LLM voice assistant

A React Native app for **Wear OS** that runs a **real LLM entirely on the watch**, driven by
voice — for **chat**, **~90 on-device tools**, an **in-app browser**, and **watch-face
complications**. The language model and all tool logic run on the watch; only the tools you'd
expect to reach out (weather, news, a web page) touch the network.

Verified working on a **Google Pixel Watch 3** (Wear OS 5, Android 14, 32-bit `armeabi-v7a`).

| Spoken on the watch | What happens |
|---|---|
| "What is the capital of Japan?" | *chats* → "The capital of Japan is Tokyo." (spoken as it generates) |
| "Set a timer for 5 minutes" | starts a 5-minute timer |
| "What's my heart rate?" | reads the optical HR sensor → "72 beats per minute" |
| "Convert 5 miles to km" | "5 miles is 8.0467 km" |
| "Show me a picture of a red panda" | fetches a Creative-Commons image and shows it on-watch |
| "Open google.com" | renders the page **in the app** (reader browser) |
| "Show me a compass" | opens a live magnetometer compass dial |

## Screenshots

<table>
  <tr>
    <td align="center"><img src="screenshots/01-ready.png" width="190" alt="Ready screen"><br><sub><b>Ready</b></sub></td>
    <td align="center"><img src="screenshots/02-voice.png" width="190" alt="System voice dictation"><br><sub><b>Voice input</b></sub></td>
    <td align="center"><img src="screenshots/03-thinking.png" width="190" alt="Thinking indicator"><br><sub><b>Thinking…</b></sub></td>
    <td align="center"><img src="screenshots/04-answer.png" width="190" alt="Streamed on-watch answer"><br><sub><b>On-watch answer</b></sub></td>
  </tr>
</table>

<sub>Every screenshot is from a Pixel Watch 3 — the LLM runs on the watch itself. Answered by SmolLM2-360M on-device.</sub>

## How it works

The Pixel Watch 3 runs a **fully 32-bit userspace** (`armeabi-v7a` only, ~0.5 GB free RAM).
Every mainstream on-device LLM library for React Native (llama.rn, ExecuTorch, MLC, MediaPipe,
LiteRT) is **arm64-only** and won't build for it. So instead:

1. **`llama.cpp` is cross-compiled for `armeabi-v7a`** as a small static HTTP server
   (`llama-server`) and shipped inside the APK as `jniLibs/armeabi-v7a/libllamaserver.so`. The
   one thing that blocks a 32-bit build — an optional FP16 NEON kernel that uses ARMv8-only
   intrinsics — is turned off with `-DGGML_LLAMAFILE=OFF`. See
   [`native/build-llama-server.sh`](native/build-llama-server.sh).
2. On launch, a **native module** (`LlamaServerModule.kt`) execs that binary so it listens on
   `127.0.0.1:8080` **on the watch**.
3. **Voice** uses the watch's built-in Google speech recognition (`SpeechModule.kt`,
   `ACTION_RECOGNIZE_SPEECH`) — the most accurate on-device option. A fully hands-free offline
   **[Vosk](https://alphacephei.com/vosk/)** path (`VoskModule.kt`, silence endpointing) is also
   in the tree.
4. The **RN UI** (`App.tsx`) takes the transcript and decides: **run a tool, open a screen
   (browser / compass / picture), or chat**. Chat streams token-by-token, and the answer is
   **spoken aloud as it generates**, sentence by sentence (`TtsModule.kt`, `speakAdd`).

**LLM model (on-device):** [SmolLM2-360M-Instruct](https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF)
(Q4_K_M, ~260 MB, Apache-2.0). Tiny, so expect short answers and the occasional mistake;
throughput is ~1–4 tokens/sec.

## Function-calling (on-device tools)

The app executes actions on the watch, not just chats about them — **~90 tools**. Tool-calling
runs on the **same SmolLM2-360M** that powers chat (there's no RAM for a second model), via two
layers in [`tools.ts`](tools.ts):

1. **Instant regex fast-path** (`parseCommandLocally`) recognises common phrasings with **zero
   inference latency** — essential at ~1–4 tok/s.
2. **Grammar-constrained LLM fallback** (`classifyToolLLM`) for the rest: one
   `/v1/chat/completions` call with `response_format: { type: "json_object", schema }`, so
   llama.cpp compiles the JSON schema to a sampling grammar and the output is **always valid
   tool JSON** even though SmolLM2 isn't a function-calling fine-tune. Biased to `{"tool":"none"}`
   when unsure, so it fails *safe* to chat.

Anything that isn't a tool is handled as normal streaming chat. Most tools run natively in
[`ToolsModule.kt`](android/app/src/main/java/com/wearllmapp/ToolsModule.kt); the network/knowledge
ones run in JS. **Permission** legend below: _none_; _grant_ (a one-time runtime prompt);
_write-settings_ (the "Modify system settings" special access, see below).

### The tools

**Clock & reminders** — `set_timer`, `set_alarm`, `show_timers`, `show_alarms`, `dismiss_alarm`,
`get_time`, `get_date`, `post_reminder` (notification).

**Knowledge & reference** — `search_wikipedia`, `calculate` (safe local evaluator), `dictionary` /
`define_word`, `thesaurus`, `rhymes`, `convert_units` (length/weight/temp/volume/speed/area/data),
`convert_currency`, `world_time`, `get_timezone`, `days_until`, `moon_phase`, `sun_times`,
`translate`, `crypto_price`, `random_pick` (coin/dice/number/list).

**News & web** — `news` (Google News RSS), `web_search`, `open_url`, `show_picture`
(Creative-Commons image). See **In-app browser** and **Pictures** below.

**Communication & contacts** — `dial_phone`, `compose_sms`, `compose_email`, `read_contacts`
(grant), `create_contact` (grant). `check_phone_connection` (paired-phone status).

**Calendar** — `read_calendar` (grant), `create_event` (grant).

**Location & maps** — `show_on_map`, `nearby` ("nearest coffee shop"), `where_am_i`
(reverse-geocode, grant), `save_location` / `saved_locations` (grant).

**Health & sensors** — `heart_rate` (BODY_SENSORS), `step_count` / `get_daily_activity`
(ACTIVITY_RECOGNITION), `start_exercise` / `stop_exercise` (Health Services), `compass_heading`,
`show_compass` (visual dial), `ambient_light`, `spirit_level`.

**Device status (read)** — `get_battery`, `battery_health` (temp/charging), `check_connectivity`,
`wifi_signal`, `bluetooth_status`, `free_storage`, `get_volume`, `get_ringer_mode`,
`count_photos` / `count_songs` / `count_videos` (media, grant).

**Device controls** — `set_volume`, `media_control` (play/pause/skip), `play_song`, `now_playing`
(active media session), `flashlight`, `vibrate_watch`, `copy_to_clipboard`, `open_app`,
`set_brightness`*, `set_screen_timeout`*, `set_text_size`*, `toggle_24hour`*,
`toggle_adaptive_brightness`* (`* = write-settings`), `set_ringer_mode` / `do_not_disturb` (⚠ see below).

**Notes & lists** — `note_add`, `note_list`, `todo_add`, `todo_list`, `todo_done` (local storage).

> `set_ringer_mode` / `do_not_disturb` are implemented but **this watch exposes no
> notification-policy-access grant screen**, so they report that it's blocked. Left in for
> watches that allow it.

**Not possible on this hardware** (verified against the device): toggling Wi-Fi/Bluetooth/airplane/
DND directly (all `WRITE_SECURE_SETTINGS`, not grantable — the assistant can only *open* the
settings screen); `read_sms` (**no SMS provider**); a torch (no camera flash); an on-watch WebView
browser (**no WebView engine** — see below). Contact/email editors and system URL-opening are
**Wear framework stubs** that forward to the paired phone.

### In-app browser

Wear OS ships **no system WebView** (the `webviewupdate` service is absent), and a full bundled
engine like GeckoView needs an unpublished `compileSdk` and far more RAM than the watch has. So
`web_search` and `open_url` open a **reader browser inside the app**: the page is fetched through
[r.jina.ai](https://jina.ai/reader) (which returns clean markdown — KBs, not ~1 MB of raw HTML,
and renders JS pages), then rendered natively as text with **tappable links** and **history**
(Back / Done). `web_search` uses DuckDuckGo Lite so results come back as links you can tap.
`BrowserActivity.kt` keeps a WebView path for Wear devices that *do* ship one; this one falls back
to the reader.

### Pictures & the visual compass

- **`show_picture`** ("show me a picture of a red panda") fetches a Creative-Commons image via
  **[Openverse](https://openverse.org/)** and displays it full-screen with title/creator/licence.
- **`show_compass`** opens a live compass dial (an `Svg` ring that rotates off the
  accelerometer + magnetometer, streamed from native `startCompass`/`stopCompass` events).

### Watch-face complications

[`Complications.kt`](android/app/src/main/java/com/wearllmapp/Complications.kt) exposes six
`ComplicationDataSourceService`s you can add from your watch face's complication picker (they
appear as **WearLLM: …**):

| Complication | Type | Source |
|---|---|---|
| **Ask** | short text | tap → launches the assistant |
| **Steps** | ranged-value ring (goal 10k) | live step counter |
| **Heart rate** | short text | last reading (cached when you use the `heart_rate` tool) |
| **Weather** | short text | latest temp (cached when you use the `weather` tool) |
| **Battery temp** | short text | live battery temperature |
| **Next event** | short text | live next calendar event |

### The "Modify system settings" grant

The five `write-settings` tools (brightness, screen timeout, text size, 24-hour clock, adaptive
brightness) need Android's **WRITE_SETTINGS** special access. On first use the app opens the
"Modify system settings" screen; because Wear's per-app UI is limited, the reliable way is one
adb command:

```bash
adb shell appops set com.wearllmapp WRITE_SETTINGS allow    # revoke with `... default`
```

Runtime-permission tools (contacts, calendar, body sensors, activity, location, notifications,
media) just prompt on the watch the first time — tap **Allow**. The `now_playing` tool needs
notification-listener access, granted via
`adb shell cmd notification allow_listener com.wearllmapp/com.wearllmapp.MediaListener`.

### Adding a tool

1. **Recognise it** — add a case to `parseCommandLocally` and/or the schema + examples in
   `classifyToolLLM` (`tools.ts`).
2. **Execute it** — add a `@ReactMethod` to `ToolsModule.kt` (or a JS helper), and dispatch from
   `executeTool` in `tools.ts`, returning the spoken confirmation.
3. If it fires a new intent, add a `<queries>` entry to the manifest.

## Toolchain

| | Version |
|---|---|
| React Native | 0.87.0 (New Architecture + Hermes) |
| Gradle / AGP / Kotlin | 9.4.1 / 9.2.x / 2.2.0 |
| **JDK** | **21** (Android Studio's JBR) — AGP does **not** support JDK 25 |
| NDK | 27.1.12297006 |
| compileSdk / target / min | 36 / 36 / **26** (SDK Platform 37 isn't published; watchface libs need minSdk 26) |
| ABI | `armeabi-v7a` only (explicit `abiFilters`) |

Key AndroidX/GMS deps: `play-services-wearable` (paired-phone info), `wear-remote-interactions`
(open URLs on the phone), `health-services-client` (exercise), `watchface-complications-data-source`.
Health Services declares minSdk 30, allowed via `tools:overrideLibrary`.

## Build & run

```bash
# one-shot: build the standalone release APK, install, provision model, launch
./scripts/build-and-run.sh
```

Or step by step:

```bash
./native/build-llama-server.sh                       # (once) rebuild the on-device server binary
export JAVA_HOME=/home/mk/android-studio/jbr ANDROID_HOME=/home/mk/Android/Sdk
cd android && ./gradlew :app:assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
./scripts/provision-model.sh SmolLM2-360M-Instruct-Q4_K_M.gguf   # push the model (once)
# then tap the mic on the watch and ask a question or run a tool
```

## Notes & gotchas

- **The model is not in the APK** (~260 MB); `provision-model.sh` pushes it to the app's external
  files dir.
- **Cleartext to localhost:** release builds disable cleartext HTTP; `network_security_config.xml`
  re-enables it **only** for `127.0.0.1`/`localhost` so the app can reach its own server. HTTPS to
  everything else is unaffected.
- **External fetches need a real User-Agent.** Wikimedia (and some others) `403` okhttp's default
  UA, so all outbound fetches send a descriptive `User-Agent` (see `apiFetch` in `tools.ts`).
- **A correct system clock** is needed for TLS (weather/news/Wikipedia and the network recognizer).
- **Tools run on one model** — function-calling shares SmolLM2 with chat by design; a second model
  won't fit the ~0.5 GB free RAM. The regex fast-path + grammar-constrained fallback is how you get
  reliable tool JSON out of a 360M model.
- The on-device server survives force-stop; the module **reuses** a running server on relaunch.

## Layout

- `App.tsx` — the watch UI (chat, tool routing, in-app browser, compass, picture viewer, streaming TTS).
- `tools.ts` — function-calling: regex fast-path, grammar-constrained fallback, tool execution, reader browser, image/knowledge fetches.
- `android/app/src/main/java/com/wearllmapp/`
  - `LlamaServerModule.kt` — spawns/monitors the on-device LLM server.
  - `ToolsModule.kt` — the native half of most tools (sensors, intents, providers, phone hand-off).
  - `Complications.kt` — the six watch-face complication data sources.
  - `BrowserActivity.kt` — WebView browser (for Wear devices that have WebView).
  - `MediaListener.kt` — NotificationListenerService enabling `now_playing`.
  - `SpeechModule.kt` / `VoskModule.kt` — system dictation / offline hands-free recognition.
  - `TtsModule.kt` — speaks answers aloud (streaming via `speakAdd`).
- `android/app/src/main/jniLibs/armeabi-v7a/libllamaserver.so` — the 32-bit llama.cpp server.
- `native/build-llama-server.sh` — reproduces that binary. `scripts/` — provisioning & build helpers.

## License

MIT — see [LICENSE](LICENSE). Bundled components keep their own licenses:
[llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT),
[Vosk](https://github.com/alphacep/vosk-api) (Apache-2.0), the
[SmolLM2-360M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct) LLM
(Apache-2.0), and the [Vosk small English](https://alphacephei.com/vosk/models) model (Apache-2.0).
Knowledge/media tools call public APIs (Open-Meteo, Wikipedia, Openverse, Datamuse, DuckDuckGo,
r.jina.ai, frankfurter.dev) at runtime.

# Wear LLM — an on-watch local LLM voice assistant

A React Native app for **Wear OS** that runs a **real LLM entirely on the watch** and is
driven by voice — for both **chat** and **on-device tool calls** (set a timer, set an alarm,
open an app). Nothing leaves the device — no phone, no laptop, no cloud.

Verified working on a **Google Pixel Watch 3** (Wear OS, Android 14).

| Spoken/typed on the watch | What happens, entirely on-device |
|---|---|
| "What is the capital of Japan" | *chats* → "The capital of Japan is Tokyo." |
| "What is the tallest mountain on Earth?" | *chats* → "…Mount Everest, at ~8,848.85 meters." |
| "Set a timer for 5 minutes" | *runs a tool* → starts a 5-minute timer, says "Timer set for 5 minutes." |
| "Wake me at 7 am" | *runs a tool* → sets a 7:00 AM alarm |
| "Open settings" | *runs a tool* → launches the Settings app |

## Screenshots

<table>
  <tr>
    <td align="center"><img src="screenshots/01-ready.png" width="190" alt="Ready screen"><br><sub><b>Ready</b></sub></td>
    <td align="center"><img src="screenshots/02-voice.png" width="190" alt="System voice dictation"><br><sub><b>Voice input</b></sub></td>
    <td align="center"><img src="screenshots/03-thinking.png" width="190" alt="Thinking indicator"><br><sub><b>Thinking…</b></sub></td>
    <td align="center"><img src="screenshots/04-answer.png" width="190" alt="Streamed on-watch answer"><br><sub><b>On-watch answer</b></sub></td>
  </tr>
</table>

<sub>Every screenshot is from a Pixel Watch 3 — the LLM runs on the watch itself, no phone or cloud. Answered by SmolLM2-360M on-device.</sub>

## How it works

The Pixel Watch 3 runs a **fully 32-bit userspace** (`armeabi-v7a` only, ~0.5 GB free RAM).
Every mainstream on-device LLM library for React Native (llama.rn, ExecuTorch, MLC,
MediaPipe, LiteRT) is **arm64-only** and won't build for it. So instead:

1. **`llama.cpp` is cross-compiled for `armeabi-v7a`** as a small static HTTP server
   (`llama-server`) and shipped inside the APK as `jniLibs/armeabi-v7a/libllamaserver.so`.
   The one thing that blocks a 32-bit build — an optional FP16 NEON kernel that uses
   ARMv8-only intrinsics — is turned off with `-DGGML_LLAMAFILE=OFF`. See
   [`native/build-llama-server.sh`](native/build-llama-server.sh).
2. On launch, a **native module** (`LlamaServerModule.kt`) execs that binary (extracted to
   the app's `nativeLibraryDir`) so it listens on `127.0.0.1:8080` **on the watch**.
3. **Voice** uses the watch's **built-in Google speech recognition** (`SpeechModule.kt`, the
   `ACTION_RECOGNIZE_SPEECH` dictation UI) — the most accurate option, all on-device. You tap
   ✓/send to confirm the transcript; that tap is unavoidable on Wear (Gboard's dictation is an
   editor, not a bindable `RecognitionService` — the watch ships none, so `SpeechRecognizer`'s
   hands-free `onEndOfSpeech` isn't available to apps). A fully **hands-free** on-device path via
   offline **[Vosk](https://alphacephei.com/vosk/)** (`VoskModule.kt`, silence endpointing, no
   tap) is also in the tree — swap `Speech.listen` → `Vosk.listen` in `App.tsx` if you'd trade
   some accuracy for hands-free.
4. The **RN UI** (`App.tsx`) takes the transcript and decides: **run a tool or chat**
   (see below). Chat streams the answer back token-by-token over plain HTTP; a tool call is
   executed on the watch. Either way the result is **spoken aloud** through the watch speaker
   via the system Text-To-Speech engine (`TtsModule.kt`).

**LLM model (on-device):** [SmolLM2-360M-Instruct](https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF)
(Q4_K_M, ~260 MB, Apache-2.0). Tiny, so expect short, simple answers and the occasional
mistake; throughput is ~1–4 tokens/sec depending on thermal state.

The optional hands-free Vosk path uses [vosk-model-small-en-us-0.15](https://alphacephei.com/vosk/models)
(~40 MB, Apache-2.0) — the small model is real-time on this CPU; the larger lgraph model is more
accurate but too slow to keep up with live audio here.

## Function-calling (on-device tools)

The app can **execute actions on the watch**, not just chat about them — 32 tools spanning the
clock, contacts, calendar, device controls, media, and live knowledge (weather, news, Wikipedia).
Ask it to set a timer, get the weather, call someone, or turn up the brightness and it performs
the action and speaks a confirmation.

**One model, two modes.** There isn't RAM for a second model (the smallest dedicated
function-calling model that fits alongside the UI is Google's FunctionGemma-270M — and it's a
tool-calling *foundation*, not a chatbot). So tool-calling runs on the **same SmolLM2-360M**
that powers chat, via two layers in [`tools.ts`](tools.ts):

1. **Instant regex fast-path** (`parseCommandLocally`) recognises the common phrasings with
   **zero inference latency** — essential when the watch does ~1–4 tok/s. This handles
   `set a timer for 5 minutes`, `wake me at 6:30 am`, `open settings`, `what time is it`, etc.
2. **Grammar-constrained LLM fallback** (`classifyToolLLM`) for anything the regex misses: one
   `/v1/chat/completions` call with `response_format: { type: "json_object", schema: … }`.
   llama.cpp compiles that JSON schema to a sampling grammar, so the model's output is
   **always structurally-valid tool JSON** even though SmolLM2 isn't a function-calling
   fine-tune. It's biased to `{"tool":"none"}` when unsure, so it fails *safe* to chat.

If neither layer produces a tool call, the utterance is handled as normal streaming chat —
so ordinary questions are never hijacked, and never pay for an extra model round-trip.

**Why the regex does the heavy lifting:** on a 360M model the LLM's *tool selection* is weak
(it will occasionally pick the wrong tool) and slow (~20–30 s/call on the watch). The regex
path makes the common commands instant and deterministic; the LLM is a best-effort fallback.

### Tools

**32 tools.** Most are executed natively in [`ToolsModule.kt`](android/app/src/main/java/com/wearllmapp/ToolsModule.kt);
the knowledge tools (`search_wikipedia`, `news`, `weather`) and `calculate` run in JS
([`tools.ts`](tools.ts)). The **Permission** column: _none_ = no permission; _grant_ = a one-time
runtime prompt on first use; _write-settings_ = the one-time "Modify system settings" grant.

**Clock & reminders**

| Tool | Say | Mechanism | Permission |
|---|---|---|---|
| `set_timer` | "set a timer for 10 minutes" | `AlarmClock.ACTION_SET_TIMER` | none |
| `set_alarm` | "wake me at 6:30 am" | `AlarmClock.ACTION_SET_ALARM` | none |
| `show_timers` | "show my timers" | `ACTION_SHOW_TIMERS` | none |
| `show_alarms` | "show my alarms" | `ACTION_SHOW_ALARMS` | none |
| `dismiss_alarm` | "dismiss the alarm" | `ACTION_DISMISS_ALARM` | SET_ALARM (normal) |
| `get_time` / `get_date` | "what time is it" | local JS | none |

**Knowledge & web**

| Tool | Say | Mechanism | Permission |
|---|---|---|---|
| `search_wikipedia` | "look up penguins on wikipedia" | Wikipedia REST API (HTTPS) | none |
| `news` | "what's the news" | Google News RSS | none |
| `weather` | "weather in Tokyo" | Open-Meteo (+ coarse location if no city) | none / grant |
| `calculate` | "what's 15 times 7" | safe local evaluator | none |
| `web_search` | "search the web for otter facts" | `ACTION_WEB_SEARCH` (→ phone) | none |

**Communication & personal data**

| Tool | Say | Mechanism | Permission |
|---|---|---|---|
| `dial_phone` | "call 555 1234" | `ACTION_DIAL` → dialer | none |
| `compose_sms` | "text 5551234 running late" | `smsto:` → Messages | none |
| `compose_email` | "email bob@x.com" | `mailto:` → phone (EmailStub) | none |
| `read_contacts` | "what's Dave's number" | ContactsContract query | grant |
| `create_contact` | "add a contact named Sam 555-2020" | ContactsContract write | grant |
| `read_calendar` | "what's on my calendar today" | CalendarContract query | grant |
| `create_event` | "schedule a meeting at 9am" | CalendarContract write | grant |

**Device controls**

| Tool | Say | Mechanism | Permission |
|---|---|---|---|
| `set_volume` | "set volume to 40%" / "turn it up" | `AudioManager` | none |
| `media_control` | "pause the music" / "skip" | `dispatchMediaKeyEvent` | none |
| `get_battery` | "how much battery do I have" | `BatteryManager` | none |
| `flashlight` | "turn on the flashlight" | launch ClockworkFlashlight | none |
| `show_on_map` | "show Central Park on the map" | `geo:` → Maps | none |
| `open_app` | "open Play Store" | `queryIntentActivities(LAUNCHER)` | none |
| `set_brightness` | "set brightness to 80%" | `Settings.System` | write-settings |
| `set_screen_timeout` | "keep the screen on for 30 seconds" | `Settings.System` | write-settings |
| `set_text_size` | "make the text bigger" | `Settings.System` (font scale) | write-settings |
| `toggle_24hour` | "use 24-hour time" | `Settings.System` | write-settings |
| `toggle_adaptive_brightness` | "turn on auto brightness" | `Settings.System` | write-settings |
| `set_ringer_mode` | "set it to vibrate" | `AudioManager.ringerMode` | ⚠️ blocked¹ |
| `do_not_disturb` | "turn on do not disturb" | `setInterruptionFilter` | ⚠️ blocked¹ |

¹ `set_ringer_mode`/`do_not_disturb` are implemented but **this watch has no notification-policy-access
grant screen**, so switching to silent/vibrate/DND fails with a spoken explanation. Left in for watches that do expose it.

**Not possible on this hardware** (verified against the device): toggling Wi-Fi/Bluetooth/airplane/DND
or theater/bedtime/water-lock (all `WRITE_SECURE_SETTINGS`, not grantable to a normal app — the assistant can
only *open* the relevant settings screen); `read_sms` (the watch has **no SMS provider**); a real flashlight
"off" or a torch (no camera flash unit); `SET_STOPWATCH` (intent absent). Contact/email editors and the
browser are **Wear framework stubs** that forward to the paired phone.

`AndroidManifest.xml` declares `<queries>` (intent filters + explicit `<package>` visibility for the clock,
dialer, Messages, Maps, settings, and framework-stubs apps) so these hand-offs work under Android 11+
package visibility without `QUERY_ALL_PACKAGES`.

### The "Modify system settings" grant

Five tools write a system setting — `set_brightness`, `set_screen_timeout`, `set_text_size`,
`toggle_24hour`, `toggle_adaptive_brightness`. Android gates these behind **WRITE_SETTINGS**, a
*special access* the user grants once — it is **not** a normal runtime-permission prompt.

The app declares `<uses-permission android:name="android.permission.WRITE_SETTINGS" />`, and the
first time one of these tools runs it checks `Settings.System.canWrite()`; if that's false it
opens the **Modify system settings** screen for WearLLM and asks you to try again. Toggle it on
for WearLLM, then repeat the command.

Because Wear OS's per-app special-access UI is limited (the intent lands on the main Settings
screen rather than a dedicated toggle), the reliable way on this watch is one adb command:

```bash
adb shell appops set com.wearllmapp WRITE_SETTINGS allow
```

To revoke it later: `adb shell appops set com.wearllmapp WRITE_SETTINGS default`. The other
tools that need permission (contacts, calendar, weather-by-location) use ordinary runtime prompts
that appear on the watch the first time you use them — just tap **Allow**.

### Adding a tool

1. **Recognise it** — add a case to `parseCommandLocally` (fast path) and/or extend the schema
   + examples in `classifyToolLLM` (`tools.ts`).
2. **Execute it** — add a `@ReactMethod` to `ToolsModule.kt`, and dispatch to it from
   `executeTool` in `tools.ts`, returning the spoken confirmation string.
3. If it needs a new intent action, add a matching `<queries>` entry to the manifest.

## Toolchain

Bleeding-edge as of Aug 2026 — all confirmed building & running:

| | Version |
|---|---|
| React Native | 0.87.0 (New Architecture + Hermes) |
| Gradle / AGP / Kotlin | 9.4.1 / 9.2.x / 2.2.0 |
| **JDK** | **21** (Android Studio's JBR) — AGP does **not** support JDK 25 |
| NDK | 27.1.12297006 |
| compileSdk / target / min | 36 / 36 / 24 (SDK Platform 37 isn't published yet; 36 builds fine) |
| ABI | `armeabi-v7a` only |

## Build & run

```bash
# one-shot: build the standalone release APK, install, provision model, launch
./scripts/build-and-run.sh
```

Or step by step:

```bash
# 1. (once) rebuild the on-device server binary — only if you change llama.cpp
./native/build-llama-server.sh

# 2. build + install the standalone app (JS bundled in; no Metro needed)
export JAVA_HOME=/home/mk/android-studio/jbr
export ANDROID_HOME=/home/mk/Android/Sdk
cd android && ./gradlew :app:assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk

# 3. put the model on the watch (once; persists across reboots/updates)
./scripts/provision-model.sh SmolLM2-360M-Instruct-Q4_K_M.gguf

# 4. launch, then tap the mic on the watch and ask a question or run a tool
```

For UI iteration you can also run a debug build with Metro over USB:
`adb reverse tcp:8081 tcp:8081 && npx react-native start`, then `assembleDebug`/install.

## Notes & gotchas

- **The model is not in the APK** (it's ~260 MB). `provision-model.sh` pushes it to the app's
  external files dir. To make a truly one-tap install, bundle it in
  `android/app/src/main/assets/` and copy to `filesDir` on first launch (bigger APK).
- **Cleartext to localhost:** release builds disable cleartext HTTP; `res/xml/network_security_config.xml`
  re-enables it **only** for `127.0.0.1`/`localhost` so the app can reach its own server.
- **Voice needs a correct system clock.** If the watch's date is wrong, TLS fails
  (`ERR_CERT_DATE_INVALID`) and the network speech recognizer won't initialize. Fix it on the
  watch (Settings → System → Date & time → automatic) or by pairing to a phone.
- **Tools run on one model.** Function-calling shares SmolLM2 with chat by design — running a
  second model (e.g. a dedicated FC model) alongside the RN/Hermes UI overruns the watch's
  ~0.5 GB free RAM. The regex fast-path + grammar-constrained fallback is how you get reliable
  tool JSON out of a 360M model. See `tools.ts`.
- The on-device server survives the app being force-stopped; the module **reuses** a running
  server on relaunch instead of spawning a second one.

## Layout

- `App.tsx` — the watch UI (round-screen layout, live listening view, streaming chat, tool routing).
- `tools.ts` — function-calling: regex fast-path, grammar-constrained LLM fallback, tool execution.
- `android/app/src/main/java/com/wearllmapp/LlamaServerModule.kt` — spawns/monitors the on-device LLM server.
- `android/app/src/main/java/com/wearllmapp/ToolsModule.kt` — executes tool calls (timer/alarm/open-app) via intents.
- `android/app/src/main/java/com/wearllmapp/SpeechModule.kt` — built-in system speech recognition (dictation).
- `android/app/src/main/java/com/wearllmapp/VoskModule.kt` — on-device speech recognition (hands-free, optional).
- `android/app/src/main/java/com/wearllmapp/TtsModule.kt` — speaks the answer/confirmation aloud.
- `android/app/src/main/jniLibs/armeabi-v7a/libllamaserver.so` — the 32-bit llama.cpp server.
- `native/build-llama-server.sh` — reproduces that binary.
- `scripts/` — provision the models, build-and-run helpers.

## License

MIT — see [LICENSE](LICENSE). Bundled components keep their own licenses:
[llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT),
[Vosk](https://github.com/alphacep/vosk-api) (Apache-2.0), the
[SmolLM2-360M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct)
LLM (Apache-2.0), and the [Vosk small English](https://alphacephei.com/vosk/models) model (Apache-2.0).

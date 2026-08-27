package com.wearllmapp

import android.Manifest
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import org.vosk.LibVosk
import org.vosk.LogLevel
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * Fully on-device speech recognition with Vosk (offline Kaldi engine).
 *
 * Unlike the system dictation, this streams partial results and — crucially — **auto-returns
 * the transcript the instant you stop talking** (Vosk's silence endpointing), with no send
 * button. `listen()` resolves with the final text; the app then answers automatically.
 */
class VoskModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private var model: Model? = null
  private var speechService: SpeechService? = null
  private var pending: Promise? = null
  private var resolved = false
  private val main = Handler(Looper.getMainLooper())

  override fun getName() = "Vosk"

  // Required so JS NativeEventEmitter(Vosk) doesn't warn.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  private fun emit(event: String, data: String?) {
    reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(event, data)
  }

  /** Unpacked model dir in app-internal storage (no scoped-storage limits). */
  private fun modelDir(): File = File(reactContext.filesDir, "vosk-model")

  /** Provisioned model zip in the app's external files dir (a single-file `adb push`). */
  private fun modelZip(): File = File(reactContext.getExternalFilesDir(null), "vosk-model.zip")

  @ReactMethod
  fun modelExists(promise: Promise) {
    promise.resolve(File(modelDir(), "am").exists() || modelZip().exists())
  }

  @ReactMethod
  fun modelPath(promise: Promise) {
    promise.resolve(modelZip().absolutePath)
  }

  /** Unzip the provisioned model into internal storage on first use (or when the zip changes). */
  private fun ensureModel(): File {
    val dir = modelDir()
    val zip = modelZip()
    val marker = File(dir, ".provisioned")
    val tag = if (zip.exists()) zip.length().toString() else ""
    // Already unpacked and matches the current zip → use it.
    if (File(dir, "am").exists() && (tag.isEmpty() || (marker.exists() && marker.readText() == tag))) {
      return dir
    }
    if (!zip.exists()) throw IllegalStateException("Vosk model not provisioned at ${zip.absolutePath}")
    val tmp = File(reactContext.filesDir, "vosk-unzip-tmp")
    tmp.deleteRecursively()
    tmp.mkdirs()
    ZipInputStream(FileInputStream(zip)).use { zin ->
      var entry = zin.nextEntry
      while (entry != null) {
        val out = File(tmp, entry.name)
        if (entry.isDirectory) {
          out.mkdirs()
        } else {
          out.parentFile?.mkdirs()
          FileOutputStream(out).use { fos -> zin.copyTo(fos) }
        }
        zin.closeEntry()
        entry = zin.nextEntry
      }
    }
    // The zip has a single top-level model folder; move it into place.
    val top =
        tmp.listFiles()?.firstOrNull { File(it, "am").exists() }
            ?: tmp.listFiles()?.firstOrNull { it.isDirectory }
            ?: throw IllegalStateException("Unexpected model zip layout")
    dir.deleteRecursively()
    if (!top.renameTo(dir)) top.copyRecursively(dir, overwrite = true)
    tmp.deleteRecursively()
    File(dir, ".provisioned").writeText(tag)
    return dir
  }

  /** Load the model once (unzipping on first run). Resolves when the recognizer is ready. */
  @ReactMethod
  fun prepare(promise: Promise) {
    if (model != null) {
      promise.resolve(true)
      return
    }
    Thread {
          try {
            LibVosk.setLogLevel(LogLevel.WARNINGS)
            val dir = ensureModel()
            model = Model(dir.absolutePath)
            promise.resolve(true)
          } catch (e: Throwable) {
            promise.reject("load_failed", e.message, e)
          }
        }
        .also { it.isDaemon = true }
        .start()
  }

  @ReactMethod
  fun listen(promise: Promise) {
    if (ContextCompat.checkSelfPermission(reactContext, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      promise.reject("no_permission", "RECORD_AUDIO not granted")
      return
    }
    val m = model
    if (m == null) {
      promise.reject("not_ready", "Model not loaded; call prepare() first")
      return
    }
    if (pending != null) {
      promise.reject("busy", "Already listening")
      return
    }
    pending = promise
    resolved = false
    main.post {
      try {
        val recognizer = Recognizer(m, 16000.0f)
        val svc = SpeechService(recognizer, 16000.0f)
        speechService = svc
        svc.startListening(
            object : RecognitionListener {
              override fun onPartialResult(hypothesis: String?) {
                val t = parse(hypothesis, "partial")
                if (!t.isNullOrBlank()) emit("VoskPartial", t)
              }

              override fun onResult(hypothesis: String?) {
                // Endpoint reached (you stopped talking) with recognized speech → done.
                val t = parse(hypothesis, "text")
                if (!t.isNullOrBlank()) finish(t)
              }

              override fun onFinalResult(hypothesis: String?) {
                if (resolved) return
                val t = parse(hypothesis, "text")
                if (!t.isNullOrBlank()) finish(t) else fail("no_match", "No speech recognized")
              }

              override fun onError(e: Exception?) = fail("recognition_error", e?.message ?: "error")

              override fun onTimeout() {
                if (!resolved) fail("timeout", "Listening timed out")
              }
            })
      } catch (e: Throwable) {
        fail("start_failed", e.message ?: "start failed")
      }
    }
  }

  private fun parse(json: String?, key: String): String? =
      json?.let { runCatching { JSONObject(it).optString(key) }.getOrNull() }

  private fun finish(text: String) {
    if (resolved) return
    resolved = true
    stopService()
    val p = pending
    pending = null
    p?.resolve(text)
  }

  private fun fail(code: String, msg: String) {
    if (resolved) return
    resolved = true
    stopService()
    val p = pending
    pending = null
    p?.reject(code, msg)
  }

  private fun stopService() {
    main.post {
      try {
        speechService?.stop()
        speechService?.shutdown()
      } catch (_: Exception) {}
      speechService = null
    }
  }

  @ReactMethod
  fun cancel(promise: Promise) {
    fail("cancelled", "cancelled")
    promise.resolve(true)
  }

  override fun invalidate() {
    super.invalidate()
    stopService()
    main.post {
      try { model?.close() } catch (_: Exception) {}
      model = null
    }
  }
}

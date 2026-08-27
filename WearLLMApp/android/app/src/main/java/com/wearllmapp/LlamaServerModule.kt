package com.wearllmapp

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Runs the on-device llama.cpp HTTP server (a native armeabi-v7a binary shipped inside the APK
 * as jniLibs/armeabi-v7a/libllamaserver.so) as a child process, listening on 127.0.0.1.
 *
 * The RN/JS side then talks to it over plain HTTP (fetch) at http://127.0.0.1:<port>.
 * The whole LLM runs on the watch — no phone, no laptop, no cloud.
 */
class LlamaServerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private var process: Process? = null
  private var logThread: Thread? = null

  override fun getName() = "LlamaServer"

  private fun serverBinaryPath(): String {
    // Native libs are extracted here (android:extractNativeLibs="true"); this dir is executable.
    val nativeDir = reactContext.applicationInfo.nativeLibraryDir
    return "$nativeDir/libllamaserver.so"
  }

  private fun probeHealth(port: Int): Boolean {
    return try {
      val c = URL("http://127.0.0.1:$port/health").openConnection() as HttpURLConnection
      c.connectTimeout = 1200
      c.readTimeout = 1200
      val code = c.responseCode
      c.disconnect()
      code == 200
    } catch (_: Exception) {
      false
    }
  }

  /** Where the app expects the GGUF model. Provisioned via `adb push` to the app's external files dir. */
  @ReactMethod
  fun modelPath(promise: Promise) {
    val ext = reactContext.getExternalFilesDir(null)
    promise.resolve(File(ext, "model.gguf").absolutePath)
  }

  @ReactMethod
  fun modelExists(promise: Promise) {
    val ext = reactContext.getExternalFilesDir(null)
    val f = File(ext, "model.gguf")
    promise.resolve(f.exists() && f.length() > 1_000_000L)
  }

  @ReactMethod
  fun isRunning(promise: Promise) {
    promise.resolve(process?.isAlive == true)
  }

  /**
   * Start the server. Resolves once /health returns 200 (model loaded) or rejects on timeout.
   * @param port  TCP port on 127.0.0.1
   * @param nThreads  inference threads (2-3 is best on the watch; leave a core for the UI/OS)
   * @param nCtx  context window in tokens (keep small on the watch, e.g. 1024)
   */
  @ReactMethod
  fun start(port: Int, nThreads: Int, nCtx: Int, promise: Promise) {
    try {
      // A server may already be listening — reused across app restarts, or if this call is
      // retried while a previous spawn is still loading. Adopt it instead of spawning again
      // (a second process could not bind the port anyway).
      if (probeHealth(port)) {
        promise.resolve("reused")
        return
      }

      val alreadySpawned = process?.isAlive == true
      if (!alreadySpawned) {
        val bin = serverBinaryPath()
        if (!File(bin).exists()) {
          promise.reject("no_binary", "Server binary missing at $bin")
          return
        }
        val model = File(reactContext.getExternalFilesDir(null), "model.gguf")
        if (!model.exists()) {
          promise.reject("no_model", "Model missing at ${model.absolutePath}")
          return
        }

        val cmd = listOf(
            bin,
            "-m", model.absolutePath,
            "--host", "127.0.0.1",
            "--port", port.toString(),
            "-c", nCtx.toString(),
            "-t", nThreads.toString(),
            "--no-warmup",
            "--jinja"
        )
        Log.i("LlamaServer", "starting: ${cmd.joinToString(" ")}")
        val pb = ProcessBuilder(cmd)
        pb.redirectErrorStream(true)
        pb.directory(reactContext.filesDir)
        // Ensure the child process finds libc++_shared.so etc. that ship next to it.
        pb.environment()["LD_LIBRARY_PATH"] =
            reactContext.applicationInfo.nativeLibraryDir + ":/system/lib"
        val p = pb.start()
        process = p

        // Drain output to logcat so we can diagnose from `adb logcat`.
        logThread = Thread {
          try {
            p.inputStream.bufferedReader().forEachLine { Log.i("LlamaServerProc", it) }
          } catch (_: Exception) {}
        }.also { it.isDaemon = true; it.start() }
      }

      // Poll /health until the model finishes loading. A cold load on the watch (paging a
      // ~260 MB model in from storage while the CPU is busy) can take a while, so allow 150s.
      Thread {
        val p = process
        var ok = false
        val deadline = System.currentTimeMillis() + 150_000
        while (System.currentTimeMillis() < deadline) {
          if (p != null && !p.isAlive) break
          if (probeHealth(port)) { ok = true; break }
          Thread.sleep(750)
        }
        when {
          ok -> promise.resolve("started")
          p != null && !p.isAlive ->
              promise.reject("exited", "Server exited during startup (see logcat LlamaServerProc)")
          else -> promise.reject("timeout", "Server did not become healthy in time")
        }
      }.also { it.isDaemon = true }.start()
    } catch (e: Exception) {
      promise.reject("start_failed", e.message, e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      process?.destroy()
      process = null
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("stop_failed", e.message, e)
    }
  }

  override fun invalidate() {
    super.invalidate()
    process?.destroy()
    process = null
  }
}

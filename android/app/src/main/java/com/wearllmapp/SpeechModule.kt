package com.wearllmapp

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Voice input via the system speech-recognition UI (ACTION_RECOGNIZE_SPEECH).
 *
 * On this hardware (Pixel Watch 3) there is no bindable RecognitionService, so the in-app
 * SpeechRecognizer API is unavailable — the system dictation activity is the only path, and
 * it's also the most reliable one on Wear OS: it owns the mic (no RECORD_AUDIO needed in our
 * app) and renders the native round-screen dictation UI.
 *
 * It **auto-submits when you stop talking**: the recognizer detects trailing silence, returns
 * the transcript in EXTRA_RESULTS, and `listen()` resolves — the app then answers automatically.
 */
class SpeechModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val REQ = 4711
  private var pending: Promise? = null

  private val activityListener: ActivityEventListener =
      object : BaseActivityEventListener() {
        override fun onActivityResult(
            activity: Activity,
            requestCode: Int,
            resultCode: Int,
            data: Intent?
        ) {
          if (requestCode != REQ) return
          val p = pending ?: return
          pending = null
          if (resultCode == Activity.RESULT_OK && data != null) {
            val text = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (text != null) p.resolve(text) else p.reject("no_match", "No speech recognized")
          } else {
            p.reject("cancelled", "Speech input cancelled")
          }
        }
      }

  init {
    reactContext.addActivityEventListener(activityListener)
  }

  override fun getName() = "Speech"

  @ReactMethod
  fun listen(prompt: String, promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("no_activity", "No current activity")
      return
    }
    if (pending != null) {
      promise.reject("busy", "Already listening")
      return
    }
    pending = promise
    try {
      val intent =
          Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            // WEB_SEARCH = short-query model: the recognizer returns as soon as you stop
            // talking, with no "review & send" compose step (that's the FREE_FORM/dictation
            // model). This is what makes voice auto-submit hands-free on Wear.
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
            putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
          }
      activity.startActivityForResult(intent, REQ)
    } catch (e: Exception) {
      pending = null
      promise.reject("no_recognizer", "Speech recognition unavailable: ${e.message}", e)
    }
  }
}

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
 * Voice input using the system speech-recognition UI (ACTION_RECOGNIZE_SPEECH).
 *
 * On Wear OS this is the recommended, most reliable path: it delegates the mic and recognition
 * to the guaranteed-present system component (Google), renders the native round-screen dictation
 * UI, and needs no RECORD_AUDIO permission in our app.
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
            val results = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            val text = results?.firstOrNull()
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
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
      }
      activity.startActivityForResult(intent, REQ)
    } catch (e: Exception) {
      pending = null
      promise.reject("no_recognizer", "Speech recognition unavailable: ${e.message}", e)
    }
  }
}

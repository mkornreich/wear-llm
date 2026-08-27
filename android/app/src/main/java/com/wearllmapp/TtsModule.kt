package com.wearllmapp

import android.speech.tts.TextToSpeech
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.Locale

/** Speaks text aloud through the watch speaker using the system Text-To-Speech engine. */
class TtsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), TextToSpeech.OnInitListener {

  private var tts: TextToSpeech? = TextToSpeech(reactContext, this)
  private var ready = false

  override fun onInit(status: Int) {
    if (status == TextToSpeech.SUCCESS) {
      tts?.language = Locale.US
      ready = true
    }
  }

  override fun getName() = "Tts"

  @ReactMethod
  fun speak(text: String) {
    val t = tts ?: return
    if (!ready || text.isBlank()) return
    t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "wearllm")
  }

  /** Queue a chunk after whatever is already speaking (for streaming answers sentence-by-sentence). */
  @ReactMethod
  fun speakAdd(text: String) {
    val t = tts ?: return
    if (!ready || text.isBlank()) return
    t.speak(text, TextToSpeech.QUEUE_ADD, null, "wearllm-${text.hashCode()}")
  }

  @ReactMethod
  fun stop() {
    tts?.stop()
  }

  override fun invalidate() {
    super.invalidate()
    tts?.stop()
    tts?.shutdown()
    tts = null
  }
}

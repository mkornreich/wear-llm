package com.wearllmapp

import android.app.Activity
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * A minimal bundled web browser (Android WebView) for the `web_search` tool.
 *
 * NOTE: this Pixel Watch 3 ships no System WebView (and a full engine like GeckoView needs an
 * unpublished compileSdk and far more RAM than the watch has), so on this device web_search
 * falls back to Wikipedia — ToolsModule.webSearch checks WebView availability first and this
 * activity finishes quietly if the engine is missing. On Wear devices that DO have WebView, it
 * renders the page.
 */
class BrowserActivity : Activity() {
  private var web: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      val w = WebView(this).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        webViewClient = WebViewClient()
      }
      web = w
      setContentView(w)
      w.loadUrl(intent.getStringExtra("url") ?: "https://www.google.com")
    } catch (e: Throwable) {
      finish() // no WebView engine on this device
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    val w = web
    if (w != null && w.canGoBack()) w.goBack() else super.onBackPressed()
  }

  override fun onDestroy() {
    web?.destroy()
    super.onDestroy()
  }
}

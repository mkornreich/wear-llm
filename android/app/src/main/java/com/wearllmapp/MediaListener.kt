package com.wearllmapp

import android.service.notification.NotificationListenerService

/**
 * A do-nothing NotificationListenerService. Its only purpose is to exist and be enabled so that
 * MediaSessionManager.getActiveSessions() will hand us the active media session for the
 * `now_playing` tool — that call requires the caller to be an enabled notification listener.
 *
 * On this watch there's no settings screen to grant "notification access", so it's enabled via
 * adb:  adb shell cmd notification allow_listener com.wearllmapp/com.wearllmapp.MediaListener
 */
class MediaListener : NotificationListenerService()

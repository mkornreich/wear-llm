package com.wearllmapp

import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.ContentValues
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.SearchManager
import android.bluetooth.BluetoothManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ResolveInfo
import android.content.ComponentName
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Geocoder
import android.media.MediaMetadata
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.location.Location
import android.location.LocationManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Settings
import android.view.KeyEvent
import androidx.health.services.client.HealthServices
import androidx.health.services.client.data.DataType
import androidx.health.services.client.data.ExerciseConfig
import androidx.health.services.client.data.ExerciseType
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.text.SimpleDateFormat
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import com.google.common.util.concurrent.FutureCallback
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.MoreExecutors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Executes the assistant's function calls as on-device actions.
 *
 * Two kinds of tool:
 *   - Intent tools (no dangerous permission): timers/alarms (AlarmClock), open_app,
 *     compose_email (mailto), show_on_map (geo:), flashlight (launch the clock flashlight app).
 *   - Provider tools (runtime permission, requested from JS before the call): read/create
 *     contacts (ContactsContract) and read/create calendar events (CalendarContract) — done
 *     directly through the ContentResolver because the watch's editor intents are stubbed
 *     (create contact/email) or absent (create event).
 */
class ToolsModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Tools"

  private fun fire(intent: Intent, promise: Promise, ok: String) {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      val act = ctx.currentActivity
      if (act != null) act.startActivity(intent) else ctx.startActivity(intent)
      promise.resolve(ok)
    } catch (e: ActivityNotFoundException) {
      promise.reject("no_app", "No app on the watch can handle that")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // --- Clock -----------------------------------------------------------------
  @ReactMethod
  fun setTimer(seconds: Int, label: String, promise: Promise) {
    val i = Intent(AlarmClock.ACTION_SET_TIMER).apply {
      putExtra(AlarmClock.EXTRA_LENGTH, seconds)
      putExtra(AlarmClock.EXTRA_SKIP_UI, true)
      if (label.isNotBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, label)
    }
    fire(i, promise, "ok")
  }

  @ReactMethod
  fun setAlarm(hour: Int, minute: Int, label: String, promise: Promise) {
    val i = Intent(AlarmClock.ACTION_SET_ALARM).apply {
      putExtra(AlarmClock.EXTRA_HOUR, hour)
      putExtra(AlarmClock.EXTRA_MINUTES, minute)
      putExtra(AlarmClock.EXTRA_SKIP_UI, true)
      if (label.isNotBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, label)
    }
    fire(i, promise, "ok")
  }

  // --- App launch ------------------------------------------------------------
  @ReactMethod
  fun openApp(query: String, promise: Promise) {
    val pm = ctx.packageManager
    val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    val acts: List<ResolveInfo> = pm.queryIntentActivities(main, 0)
    val q = query.trim().lowercase()

    var best: ResolveInfo? = null
    var bestScore = 0
    for (ri in acts) {
      val label = ri.loadLabel(pm).toString().lowercase()
      val score = when {
        label == q -> 100
        label.startsWith(q) -> 80
        label.contains(q) -> 60
        q.contains(label) && label.length >= 3 -> 40
        else -> 0
      }
      if (score > bestScore) {
        bestScore = score
        best = ri
      }
    }

    val hit = best
    if (hit == null || bestScore == 0) {
      promise.reject("not_found", "No app matching '$query'")
      return
    }
    val launch = pm.getLaunchIntentForPackage(hit.activityInfo.packageName)
    if (launch == null) {
      promise.reject("not_found", "Can't launch '$query'")
      return
    }
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      ctx.startActivity(launch)
      promise.resolve(hit.loadLabel(pm).toString())
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // --- Flashlight (launch the Wear flashlight app; no torch flash unit exists) ---
  @ReactMethod
  fun flashlight(on: Boolean, promise: Promise) {
    val launch = ctx.packageManager.getLaunchIntentForPackage("com.google.android.clockwork.flashlight")
    if (launch == null) {
      promise.reject("not_found", "Flashlight app not available")
      return
    }
    fire(launch, promise, if (on) "on" else "off")
  }

  // --- Map -------------------------------------------------------------------
  @ReactMethod
  fun showOnMap(query: String, promise: Promise) {
    val i = Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(query)))
    fire(i, promise, "ok")
  }

  // --- Email (compose; the watch mailto handler forwards to the phone) --------
  @ReactMethod
  fun composeEmail(to: String, subject: String, body: String, promise: Promise) {
    val i = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:")).apply {
      if (to.isNotBlank()) putExtra(Intent.EXTRA_EMAIL, arrayOf(to))
      if (subject.isNotBlank()) putExtra(Intent.EXTRA_SUBJECT, subject)
      if (body.isNotBlank()) putExtra(Intent.EXTRA_TEXT, body)
    }
    fire(i, promise, "ok")
  }

  // --- Contacts --------------------------------------------------------------
  @ReactMethod
  fun readContacts(query: String, promise: Promise) {
    try {
      val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
      val proj = arrayOf(
          ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
          ContactsContract.CommonDataKinds.Phone.NUMBER)
      var sel: String? = null
      var args: Array<String>? = null
      if (query.isNotBlank()) {
        sel = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?"
        args = arrayOf("%${query.trim()}%")
      }
      val cur = ctx.contentResolver.query(uri, proj, sel, args,
          "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC")
      val out = ArrayList<String>()
      val seen = HashSet<String>()
      cur?.use {
        while (it.moveToNext() && out.size < 5) {
          val name = it.getString(0) ?: continue
          val num = it.getString(1) ?: ""
          if (seen.add(name)) out.add(if (num.isBlank()) name else "$name: $num")
        }
      }
      if (out.isEmpty()) promise.reject("not_found", "No contact matching '$query'")
      else promise.resolve(out.joinToString("; "))
    } catch (e: SecurityException) {
      promise.reject("permission", "Contacts permission not granted")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun createContact(name: String, phone: String, email: String, promise: Promise) {
    try {
      val ops = ArrayList<ContentProviderOperation>()
      ops.add(ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
          .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
          .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null).build())
      ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
          .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
          .withValue(ContactsContract.Data.MIMETYPE,
              ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name).build())
      if (phone.isNotBlank()) {
        ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE,
                ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
            .withValue(ContactsContract.CommonDataKinds.Phone.TYPE,
                ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE).build())
      }
      if (email.isNotBlank()) {
        ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE,
                ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, email)
            .withValue(ContactsContract.CommonDataKinds.Email.TYPE,
                ContactsContract.CommonDataKinds.Email.TYPE_HOME).build())
      }
      ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
      promise.resolve("ok")
    } catch (e: SecurityException) {
      promise.reject("permission", "Contacts permission not granted")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // --- Calendar --------------------------------------------------------------
  @ReactMethod
  fun readCalendar(days: Int, promise: Promise) {
    try {
      val now = System.currentTimeMillis()
      val end = now + days.coerceAtLeast(1) * 86_400_000L
      val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
      ContentUris.appendId(builder, now)
      ContentUris.appendId(builder, end)
      val proj = arrayOf(
          CalendarContract.Instances.TITLE,
          CalendarContract.Instances.BEGIN,
          CalendarContract.Instances.ALL_DAY)
      val cur = ctx.contentResolver.query(builder.build(), proj, null, null,
          "${CalendarContract.Instances.BEGIN} ASC")
      val fmt = SimpleDateFormat("EEE h:mm a", Locale.US)
      val out = ArrayList<String>()
      cur?.use {
        while (it.moveToNext() && out.size < 5) {
          val title = it.getString(0) ?: "(no title)"
          val begin = it.getLong(1)
          val allDay = it.getInt(2) == 1
          out.add(if (allDay) title else "$title ${fmt.format(Date(begin))}")
        }
      }
      if (out.isEmpty()) promise.resolve("") // caller speaks a "nothing scheduled" line
      else promise.resolve(out.joinToString("; "))
    } catch (e: SecurityException) {
      promise.reject("permission", "Calendar permission not granted")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun createEvent(title: String, location: String, startMs: Double, endMs: Double, promise: Promise) {
    try {
      val calCur = ctx.contentResolver.query(
          CalendarContract.Calendars.CONTENT_URI,
          arrayOf(CalendarContract.Calendars._ID),
          "${CalendarContract.Calendars.VISIBLE}=1 AND " +
              "${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}>=" +
              "${CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR}",
          null, null)
      var calId = -1L
      calCur?.use { if (it.moveToFirst()) calId = it.getLong(0) }
      if (calId < 0) {
        promise.reject("no_calendar", "No writable calendar found")
        return
      }
      val values = ContentValues().apply {
        put(CalendarContract.Events.DTSTART, startMs.toLong())
        put(CalendarContract.Events.DTEND, endMs.toLong())
        put(CalendarContract.Events.TITLE, title)
        if (location.isNotBlank()) put(CalendarContract.Events.EVENT_LOCATION, location)
        put(CalendarContract.Events.CALENDAR_ID, calId)
        put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
      }
      val uri = ctx.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
      if (uri != null) promise.resolve("ok")
      else promise.reject("tool_failed", "Could not create event")
    } catch (e: SecurityException) {
      promise.reject("permission", "Calendar permission not granted")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // --- Location (best-effort last-known fix for the weather tool) -------------
  @ReactMethod
  fun getLastLocation(promise: Promise) {
    try {
      val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
      var best: Location? = null
      for (p in listOf(LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER, LocationManager.GPS_PROVIDER)) {
        try {
          val l = lm.getLastKnownLocation(p)
          if (l != null && (best == null || l.time > best!!.time)) best = l
        } catch (_: SecurityException) {}
      }
      val loc = best
      if (loc == null) promise.reject("no_location", "No location available")
      else promise.resolve("${loc.latitude},${loc.longitude}")
    } catch (e: SecurityException) {
      promise.reject("permission", "Location permission not granted")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // --- Volume (AudioManager; no permission for music/alarm streams) -----------
  private fun streamOf(name: String): Int = when (name) {
    "alarm" -> AudioManager.STREAM_ALARM
    "ring" -> AudioManager.STREAM_RING
    "call" -> AudioManager.STREAM_VOICE_CALL
    "notification" -> AudioManager.STREAM_NOTIFICATION
    else -> AudioManager.STREAM_MUSIC
  }

  @ReactMethod
  fun setVolume(stream: String, percent: Int, promise: Promise) {
    try {
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val s = streamOf(stream)
      val vol = (percent.coerceIn(0, 100) * am.getStreamMaxVolume(s) / 100.0).roundToInt()
      am.setStreamVolume(s, vol, 0)
      promise.resolve("ok")
    } catch (e: SecurityException) {
      promise.reject("policy", "Changing this volume needs Do Not Disturb access, which this watch blocks")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun adjustVolume(stream: String, up: Boolean, promise: Promise) {
    try {
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      am.adjustStreamVolume(streamOf(stream), if (up) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER, 0)
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // --- Battery ---------------------------------------------------------------
  @ReactMethod
  fun getBatteryLevel(promise: Promise) {
    try {
      val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
      val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
      promise.resolve("$level,${bm.isCharging}")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // --- Open a URL: real on-watch browser → paired phone (RemoteIntent) → bundled WebView → fail ---
  private fun openUrlInternal(rawUrl: String, promise: Promise) {
    val u = if (rawUrl.startsWith("http")) rawUrl else "https://$rawUrl"
    // 1) A real installed browser (Samsung Internet, WristWeb, …) that bundles its own engine.
    //    Exclude the framework stub AND the Wear companion redirect (needs a privileged perm we
    //    can't hold) AND our own app.
    val view = Intent(Intent.ACTION_VIEW, Uri.parse(u)).addCategory(Intent.CATEGORY_BROWSABLE)
    val h = view.resolveActivity(ctx.packageManager)
    if (h != null && !h.packageName.contains("frameworkpackagestubs") &&
        h.packageName != "com.google.android.wearable.app" && h.packageName != ctx.packageName) {
      fire(Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), promise, "browser")
      return
    }
    // 2) No on-watch browser — open it on the paired phone (RemoteActivityHelper).
    try {
      val remote = Intent(Intent.ACTION_VIEW).addCategory(Intent.CATEGORY_BROWSABLE).setData(Uri.parse(u))
      Futures.addCallback(
          androidx.wear.remote.interactions.RemoteActivityHelper(ctx).startRemoteActivity(remote, null),
          object : FutureCallback<Void> {
            override fun onSuccess(result: Void?) { promise.resolve("phone") }
            override fun onFailure(t: Throwable) { promise.reject("no_browser", t.message ?: "Couldn't open it on your phone") }
          },
          MoreExecutors.directExecutor())
    } catch (e: Exception) {
      promise.reject("no_browser", e.message)
    }
  }

  @ReactMethod
  fun webSearch(query: String, promise: Promise) =
      openUrlInternal("https://www.google.com/search?q=" + Uri.encode(query), promise)

  @ReactMethod
  fun openUrl(url: String, promise: Promise) = openUrlInternal(url, promise)

  // --- Media playback (media-button events to the active session) ------------
  @ReactMethod
  fun mediaControl(action: String, promise: Promise) {
    try {
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val code = when (action) {
        "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
        "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
        "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
        "previous" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
        else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
      }
      am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
      am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // --- Phone / SMS (open pre-filled; the user confirms) ----------------------
  @ReactMethod
  fun dialPhone(number: String, promise: Promise) {
    fire(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number))), promise, "ok")
  }

  @ReactMethod
  fun composeSms(number: String, body: String, promise: Promise) {
    val i = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number))).apply {
      if (body.isNotBlank()) putExtra("sms_body", body)
    }
    fire(i, promise, "ok")
  }

  // --- Clock management ------------------------------------------------------
  @ReactMethod
  fun showTimers(promise: Promise) = fire(Intent(AlarmClock.ACTION_SHOW_TIMERS), promise, "ok")

  @ReactMethod
  fun showAlarms(promise: Promise) = fire(Intent(AlarmClock.ACTION_SHOW_ALARMS), promise, "ok")

  @ReactMethod
  fun dismissAlarm(promise: Promise) {
    val i = Intent(AlarmClock.ACTION_DISMISS_ALARM)
        .putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE, AlarmClock.ALARM_SEARCH_MODE_NEXT)
    fire(i, promise, "ok")
  }

  // --- System settings (WRITE_SETTINGS; one-time user grant) -----------------
  private fun ensureWriteSettings(promise: Promise): Boolean {
    if (Settings.System.canWrite(ctx)) return true
    try {
      ctx.startActivity(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS)
          .setData(Uri.parse("package:${ctx.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {}
    promise.reject("needs_write_settings", "Grant 'Modify system settings', then try again")
    return false
  }

  @ReactMethod
  fun setBrightness(percent: Int, promise: Promise) {
    if (!ensureWriteSettings(promise)) return
    try {
      Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
      Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS, (percent.coerceIn(1, 100) * 255 / 100.0).roundToInt())
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun setScreenTimeout(seconds: Int, promise: Promise) {
    if (!ensureWriteSettings(promise)) return
    try {
      Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, seconds.coerceAtLeast(1) * 1000)
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun setTextSize(scale: Double, promise: Promise) {
    if (!ensureWriteSettings(promise)) return
    try {
      Settings.System.putFloat(ctx.contentResolver, Settings.System.FONT_SCALE, scale.toFloat())
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun set24Hour(on: Boolean, promise: Promise) {
    if (!ensureWriteSettings(promise)) return
    try {
      Settings.System.putString(ctx.contentResolver, Settings.System.TIME_12_24, if (on) "24" else "12")
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun setAdaptiveBrightness(on: Boolean, promise: Promise) {
    if (!ensureWriteSettings(promise)) return
    try {
      Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, if (on) 1 else 0)
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // --- Ringer / Do Not Disturb (ACCESS_NOTIFICATION_POLICY) ------------------
  // The grant screen does not resolve on this watch, so these report that it's blocked.
  private fun ensurePolicy(promise: Promise): NotificationManager? {
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.isNotificationPolicyAccessGranted) return nm
    val i = Intent("android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (i.resolveActivity(ctx.packageManager) != null) {
      try { ctx.startActivity(i) } catch (_: Exception) {}
      promise.reject("needs_policy", "Grant Do Not Disturb access, then try again")
    } else {
      promise.reject("no_policy", "This watch doesn't let apps control Do Not Disturb / silent mode")
    }
    return null
  }

  @ReactMethod
  fun setRingerMode(mode: String, promise: Promise) {
    val target = when (mode) {
      "silent" -> AudioManager.RINGER_MODE_SILENT
      "vibrate" -> AudioManager.RINGER_MODE_VIBRATE
      else -> AudioManager.RINGER_MODE_NORMAL
    }
    if (target != AudioManager.RINGER_MODE_NORMAL && ensurePolicy(promise) == null) return
    try {
      (ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager).ringerMode = target
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun doNotDisturb(on: Boolean, promise: Promise) {
    val nm = ensurePolicy(promise) ?: return
    try {
      nm.setInterruptionFilter(if (on) NotificationManager.INTERRUPTION_FILTER_NONE else NotificationManager.INTERRUPTION_FILTER_ALL)
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // === Status reads (no permission) =========================================
  @ReactMethod
  fun checkConnectivity(promise: Promise) {
    try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val caps = cm.getNetworkCapabilities(cm.activeNetwork)
      val online = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
      val transport = when {
        caps == null -> "none"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "Bluetooth"
        else -> "other"
      }
      val metered = caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
      promise.resolve("$online|$transport|$metered")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun getVolume(stream: String, promise: Promise) {
    try {
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val s = streamOf(stream)
      promise.resolve((am.getStreamVolume(s) * 100.0 / am.getStreamMaxVolume(s)).roundToInt().toString())
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun getRingerMode(promise: Promise) {
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    promise.resolve(when (am.ringerMode) {
      AudioManager.RINGER_MODE_SILENT -> "silent"
      AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
      else -> "normal"
    })
  }

  @ReactMethod
  fun freeStorage(promise: Promise) {
    try {
      val s = StatFs(ctx.filesDir.absolutePath)
      promise.resolve("${s.availableBytes / (1024 * 1024)}|${s.totalBytes / (1024 * 1024)}")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun batteryHealth(promise: Promise) {
    try {
      val bi = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val temp = bi?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1
      val plugged = bi?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
      val health = bi?.getIntExtra(BatteryManager.EXTRA_HEALTH, 0) ?: 0
      val level = (ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager)
          .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
      val tC = if (temp > 0) "${(temp / 10.0).roundToInt()}" else "?"
      val src = when (plugged) {
        BatteryManager.BATTERY_PLUGGED_AC -> "charging on AC"
        BatteryManager.BATTERY_PLUGGED_USB -> "charging over USB"
        BatteryManager.BATTERY_PLUGGED_WIRELESS -> "charging wirelessly"
        else -> "on battery"
      }
      val h = when (health) {
        BatteryManager.BATTERY_HEALTH_OVERHEAT -> "overheating"
        BatteryManager.BATTERY_HEALTH_COLD -> "cold"
        BatteryManager.BATTERY_HEALTH_DEAD, BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "poor"
        else -> "good"
      }
      promise.resolve("Battery is at $level percent, ${tC}°C, $src, health $h.")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun wifiSignal(promise: Promise) {
    try {
      val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      if (!wm.isWifiEnabled) { promise.resolve("off"); return }
      @Suppress("DEPRECATION") val rssi = wm.connectionInfo.rssi
      promise.resolve("${WifiManager.calculateSignalLevel(rssi, 5)}|4|$rssi")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun bluetoothStatus(promise: Promise) {
    try {
      val ad = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
          ?: run { promise.resolve("This watch has no Bluetooth."); return }
      if (!ad.isEnabled) { promise.resolve("Bluetooth is off."); return }
      val names = try { ad.bondedDevices?.mapNotNull { it.name }?.take(4) ?: emptyList() } catch (_: SecurityException) { emptyList() }
      promise.resolve(if (names.isEmpty()) "Bluetooth is on." else "Bluetooth is on, paired with ${names.joinToString(", ")}.")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun copyToClipboard(text: String, promise: Promise) {
    try {
      (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
          .setPrimaryClip(ClipData.newPlainText("WearLLM", text))
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun worldTime(zoneId: String, promise: Promise) {
    try {
      promise.resolve(ZonedDateTime.now(ZoneId.of(zoneId)).format(DateTimeFormatter.ofPattern("h:mm a, EEE", Locale.US)))
    } catch (e: Exception) {
      promise.reject("bad_zone", "Unknown time zone", e)
    }
  }

  @ReactMethod
  fun timeZone(promise: Promise) {
    val tz = TimeZone.getDefault()
    val offMin = tz.getOffset(System.currentTimeMillis()) / 60_000
    val sign = if (offMin >= 0) "+" else "-"
    val name = tz.getDisplayName(tz.inDaylightTime(Date()), TimeZone.LONG)
    promise.resolve("You're in $name, GMT$sign${abs(offMin / 60)}:${"%02d".format(abs(offMin % 60))} (${tz.id}).")
  }

  @ReactMethod
  fun vibrateWatch(pattern: String, promise: Promise) {
    try {
      val v = ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
      val timings = when (pattern) {
        "double" -> longArrayOf(0, 120, 120, 120)
        "sos" -> longArrayOf(0, 100, 80, 100, 80, 100, 200, 250, 120, 250, 120, 250, 200, 100, 80, 100, 80, 100)
        else -> longArrayOf(0, 250)
      }
      v.vibrate(VibrationEffect.createWaveform(timings, -1))
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun deviceInfo(promise: Promise) {
    val name = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    var face = ""
    for (key in listOf("clockwork_current_watch_face_component", "clockwork_current_watch_face", "current_watchface", "watchface_component")) {
      try {
        val v = Settings.Secure.getString(ctx.contentResolver, key)
        if (!v.isNullOrBlank()) { face = v.substringBefore('/').substringAfterLast('.'); break }
      } catch (_: Exception) {}
    }
    promise.resolve("$name|$face")
  }

  // === Sensors (one-shot reads) =============================================
  private fun readSensorOnce(type: Int, timeoutMs: Long, promise: Promise, extract: (FloatArray) -> String?) {
    val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val sensor = sm.getDefaultSensor(type) ?: run { promise.reject("no_sensor", "This watch has no such sensor"); return }
    val done = AtomicBoolean(false)
    val handler = Handler(Looper.getMainLooper())
    lateinit var listener: SensorEventListener
    val timeout = Runnable { if (done.compareAndSet(false, true)) { sm.unregisterListener(listener); promise.reject("timeout", "No reading in time") } }
    listener = object : SensorEventListener {
      override fun onSensorChanged(e: SensorEvent) {
        if (done.get()) return
        val out = extract(e.values) ?: return
        if (done.compareAndSet(false, true)) { handler.removeCallbacks(timeout); sm.unregisterListener(this); promise.resolve(out) }
      }
      override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }
    sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_FASTEST)
    handler.postDelayed(timeout, timeoutMs)
  }

  @ReactMethod
  fun heartRate(promise: Promise) =
      readSensorOnce(Sensor.TYPE_HEART_RATE, 12_000, promise) { v -> if (v[0] > 0f) v[0].roundToInt().toString() else null }

  @ReactMethod
  fun ambientLight(promise: Promise) =
      readSensorOnce(Sensor.TYPE_LIGHT, 4_000, promise) { v -> v[0].roundToInt().toString() }

  @ReactMethod
  fun spiritLevel(promise: Promise) =
      readSensorOnce(Sensor.TYPE_ACCELEROMETER, 3_000, promise) { v ->
        val x = v[0]; val y = v[1]; val z = v[2]
        val pitch = Math.toDegrees(atan2(y.toDouble(), sqrt((x * x + z * z).toDouble()))).roundToInt()
        val roll = Math.toDegrees(atan2(x.toDouble(), sqrt((y * y + z * z).toDouble()))).roundToInt()
        "$pitch|$roll"
      }

  @ReactMethod
  fun stepCount(promise: Promise) =
      readSensorOnce(Sensor.TYPE_STEP_COUNTER, 5_000, promise) { v ->
        val total = v[0].toLong()
        val p = ctx.getSharedPreferences("wearllm_steps", Context.MODE_PRIVATE)
        val doy = java.util.Calendar.getInstance().get(java.util.Calendar.DAY_OF_YEAR)
        var base = p.getLong("base", -1L)
        if (p.getInt("day", -1) != doy || base < 0 || base > total) {
          base = total
          p.edit().putInt("day", doy).putLong("base", base).apply()
        }
        (total - base).toString()
      }

  @ReactMethod
  fun compassHeading(promise: Promise) {
    val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    val mag = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
    if (acc == null || mag == null) { promise.reject("no_sensor", "No compass sensors on this watch"); return }
    val done = AtomicBoolean(false)
    val handler = Handler(Looper.getMainLooper())
    var g: FloatArray? = null
    var m: FloatArray? = null
    lateinit var listener: SensorEventListener
    val timeout = Runnable { if (done.compareAndSet(false, true)) { sm.unregisterListener(listener); promise.reject("timeout", "Couldn't get a heading") } }
    listener = object : SensorEventListener {
      override fun onSensorChanged(e: SensorEvent) {
        if (done.get()) return
        if (e.sensor.type == Sensor.TYPE_ACCELEROMETER) g = e.values.clone()
        if (e.sensor.type == Sensor.TYPE_MAGNETIC_FIELD) m = e.values.clone()
        val gg = g; val mm = m
        if (gg != null && mm != null) {
          val r = FloatArray(9)
          if (SensorManager.getRotationMatrix(r, null, gg, mm)) {
            val o = FloatArray(3)
            SensorManager.getOrientation(r, o)
            var az = Math.toDegrees(o[0].toDouble())
            if (az < 0) az += 360
            if (done.compareAndSet(false, true)) { handler.removeCallbacks(timeout); sm.unregisterListener(this); promise.resolve(az.roundToInt().toString()) }
          }
        }
      }
      override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }
    sm.registerListener(listener, acc, SensorManager.SENSOR_DELAY_UI)
    sm.registerListener(listener, mag, SensorManager.SENSOR_DELAY_UI)
    handler.postDelayed(timeout, 4_000)
  }

  // === Live compass (streams heading to JS for the visual compass) ==========
  private var compassListener: SensorEventListener? = null
  private var compassG: FloatArray? = null
  private var compassM: FloatArray? = null

  @ReactMethod
  fun startCompass() {
    if (compassListener != null) return
    val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
    val mag = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) ?: return
    val l = object : SensorEventListener {
      override fun onSensorChanged(e: SensorEvent) {
        if (e.sensor.type == Sensor.TYPE_ACCELEROMETER) compassG = e.values.clone()
        if (e.sensor.type == Sensor.TYPE_MAGNETIC_FIELD) compassM = e.values.clone()
        val g = compassG; val m = compassM
        if (g != null && m != null) {
          val r = FloatArray(9)
          if (SensorManager.getRotationMatrix(r, null, g, m)) {
            val o = FloatArray(3)
            SensorManager.getOrientation(r, o)
            var az = Math.toDegrees(o[0].toDouble())
            if (az < 0) az += 360
            val params = Arguments.createMap().apply { putDouble("heading", az) }
            try {
              ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                  .emit("CompassHeading", params)
            } catch (_: Exception) {}
          }
        }
      }
      override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }
    compassListener = l
    sm.registerListener(l, acc, SensorManager.SENSOR_DELAY_UI)
    sm.registerListener(l, mag, SensorManager.SENSOR_DELAY_UI)
  }

  @ReactMethod
  fun stopCompass() {
    val l = compassListener ?: return
    (ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager).unregisterListener(l)
    compassListener = null
    compassG = null
    compassM = null
  }

  // Required by RN's NativeEventEmitter (no-ops).
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  // === Location (FINE) + reverse geocode ====================================
  @ReactMethod
  fun whereAmI(promise: Promise) {
    try {
      val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
      var best: Location? = null
      for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
        try { val l = lm.getLastKnownLocation(p); if (l != null && (best == null || l.time > best!!.time)) best = l } catch (_: SecurityException) {}
      }
      val loc = best ?: run { promise.reject("no_location", "No location fix yet"); return }
      try {
        @Suppress("DEPRECATION")
        val a = Geocoder(ctx, Locale.getDefault()).getFromLocation(loc.latitude, loc.longitude, 1)?.firstOrNull()
        if (a != null) {
          val parts = listOfNotNull(a.thoroughfare, a.locality ?: a.subAdminArea, a.adminArea)
          if (parts.isNotEmpty()) { promise.resolve(parts.joinToString(", ")); return }
        }
      } catch (_: Exception) {}
      promise.resolve("${"%.4f".format(loc.latitude)}, ${"%.4f".format(loc.longitude)}")
    } catch (e: SecurityException) {
      promise.reject("permission", "Location permission not granted")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // === Saved locations (FINE location + reverse geocode, stored locally) =====
  @ReactMethod
  fun saveLocation(promise: Promise) {
    try {
      val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
      var best: Location? = null
      for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
        try { val l = lm.getLastKnownLocation(p); if (l != null && (best == null || l.time > best!!.time)) best = l } catch (_: SecurityException) {}
      }
      val loc = best ?: run { promise.reject("no_location", "No location fix yet"); return }
      var name = "${"%.4f".format(loc.latitude)}, ${"%.4f".format(loc.longitude)}"
      try {
        @Suppress("DEPRECATION")
        val a = Geocoder(ctx, Locale.getDefault()).getFromLocation(loc.latitude, loc.longitude, 1)?.firstOrNull()
        if (a != null) {
          val parts = listOfNotNull(a.thoroughfare, a.locality ?: a.subAdminArea)
          if (parts.isNotEmpty()) name = parts.joinToString(", ")
        }
      } catch (_: Exception) {}
      val arr = loadArr("locations")
      arr.put(org.json.JSONObject()
          .put("name", name).put("lat", loc.latitude).put("lon", loc.longitude)
          .put("time", System.currentTimeMillis()))
      saveArr("locations", arr)
      promise.resolve(name)
    } catch (e: SecurityException) {
      promise.reject("permission", "Location permission not granted")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun listSavedLocations(promise: Promise) {
    val arr = loadArr("locations")
    if (arr.length() == 0) { promise.resolve(""); return }
    val out = ArrayList<String>()
    var i = arr.length() - 1
    while (i >= 0 && out.size < 5) { out.add(arr.getJSONObject(i).getString("name")); i-- }
    promise.resolve(out.joinToString("; "))
  }

  // === Notifications (POST_NOTIFICATIONS) ===================================
  @ReactMethod
  fun postReminder(title: String, text: String, promise: Promise) {
    try {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val chId = "wearllm_reminders"
      nm.createNotificationChannel(NotificationChannel(chId, "Reminders", NotificationManager.IMPORTANCE_HIGH))
      val n = Notification.Builder(ctx, chId)
          .setSmallIcon(ctx.applicationInfo.icon)
          .setContentTitle(if (title.isBlank()) "Reminder" else title)
          .setContentText(text)
          .setAutoCancel(true)
          .build()
      nm.notify((System.currentTimeMillis() % 100_000).toInt(), n)
      promise.resolve("ok")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // === Notes & to-dos (local SharedPreferences) =============================
  private fun loadArr(key: String): org.json.JSONArray =
      try { org.json.JSONArray(ctx.getSharedPreferences("wearllm_notes", Context.MODE_PRIVATE).getString(key, "[]")) } catch (_: Exception) { org.json.JSONArray() }

  private fun saveArr(key: String, arr: org.json.JSONArray) {
    ctx.getSharedPreferences("wearllm_notes", Context.MODE_PRIVATE).edit().putString(key, arr.toString()).apply()
  }

  @ReactMethod
  fun noteAdd(text: String, promise: Promise) {
    val a = loadArr("notes"); a.put(text); saveArr("notes", a); promise.resolve(a.length().toString())
  }

  @ReactMethod
  fun noteList(promise: Promise) {
    val a = loadArr("notes")
    val sb = StringBuilder()
    for (i in 0 until a.length()) { if (i > 0) sb.append("; "); sb.append(a.getString(i)) }
    promise.resolve(sb.toString())
  }

  @ReactMethod
  fun todoAdd(text: String, promise: Promise) {
    val a = loadArr("todos"); a.put(text); saveArr("todos", a); promise.resolve(a.length().toString())
  }

  @ReactMethod
  fun todoList(promise: Promise) {
    val a = loadArr("todos")
    val sb = StringBuilder()
    for (i in 0 until a.length()) { if (i > 0) sb.append("; "); sb.append("${i + 1}. ${a.getString(i)}") }
    promise.resolve(sb.toString())
  }

  @ReactMethod
  fun todoDone(query: String, promise: Promise) {
    val a = loadArr("todos")
    val q = query.trim().lowercase()
    val idx = q.toIntOrNull()
    var removed: String? = null
    val out = org.json.JSONArray()
    for (i in 0 until a.length()) {
      val item = a.getString(i)
      val match = if (idx != null) i == idx - 1 else item.lowercase().contains(q)
      if (match && removed == null) removed = item else out.put(item)
    }
    saveArr("todos", out)
    if (removed != null) promise.resolve(removed) else promise.reject("not_found", "No matching to-do")
  }

  // Cache a small value for watch-face complications to read (see Complications.kt).
  @ReactMethod
  fun cachePut(key: String, value: String, promise: Promise) {
    ctx.getSharedPreferences("wearllm_cache", Context.MODE_PRIVATE).edit()
        .putString(key, value).putLong("${key}_time", System.currentTimeMillis()).apply()
    promise.resolve(true)
  }

  // === Media library counts (READ_MEDIA_*) ==================================
  @ReactMethod
  fun mediaCount(type: String, promise: Promise) {
    try {
      val uri = when (type) {
        "audio" -> MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        "video" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        else -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
      }
      ctx.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns._ID), null, null, null).use { c ->
        promise.resolve((c?.count ?: 0).toString())
      }
    } catch (e: SecurityException) {
      promise.reject("permission", "Media permission not granted")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // === Phone bridge (play-services-wearable) ================================
  @ReactMethod
  fun phoneConnection(promise: Promise) {
    try {
      com.google.android.gms.wearable.Wearable.getNodeClient(ctx).connectedNodes
          .addOnSuccessListener { nodes ->
            if (nodes.isEmpty()) promise.resolve("none")
            else { val n = nodes[0]; promise.resolve("${n.displayName}|${n.isNearby}") }
          }
          .addOnFailureListener { e -> promise.reject("wear_failed", e.message) }
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // === Now playing (MediaSessionManager via the enabled NotificationListener) ===
  @ReactMethod
  fun nowPlaying(promise: Promise) {
    try {
      val enabled = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: ""
      if (!enabled.contains(ctx.packageName)) {
        val i = Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (i.resolveActivity(ctx.packageManager) != null) {
          try { ctx.startActivity(i) } catch (_: Exception) {}
          promise.reject("needs_access", "Enable notification access, then try again")
        } else {
          promise.reject("no_access", "This watch can't grant notification access from settings")
        }
        return
      }
      val msm = ctx.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
      val sessions = msm.getActiveSessions(ComponentName(ctx, MediaListener::class.java))
      val ctrl = sessions.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: sessions.firstOrNull()
      val md = ctrl?.metadata
      val title = md?.getString(MediaMetadata.METADATA_KEY_TITLE)
      if (title.isNullOrBlank()) { promise.resolve(""); return }
      val artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST)
      promise.resolve(if (artist.isNullOrBlank()) title else "$title|$artist")
    } catch (e: SecurityException) {
      promise.reject("no_access", "Notification access not granted")
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // === Health Services — exercise + daily activity ==========================
  @ReactMethod
  fun startExercise(kind: String, promise: Promise) {
    try {
      val type = when (kind) {
        "run" -> ExerciseType.RUNNING
        "bike" -> ExerciseType.BIKING
        "hike" -> ExerciseType.HIKING
        else -> ExerciseType.WALKING
      }
      val config = ExerciseConfig.builder(type).setDataTypes(setOf(DataType.CALORIES_TOTAL)).build()
      val client = HealthServices.getClient(ctx).exerciseClient
      Futures.addCallback(client.startExerciseAsync(config), object : FutureCallback<Void> {
        override fun onSuccess(result: Void?) {
          ctx.getSharedPreferences("wearllm_ex", Context.MODE_PRIVATE).edit()
              .putLong("start", System.currentTimeMillis()).putString("kind", kind).apply()
          promise.resolve("ok")
        }
        override fun onFailure(t: Throwable) { promise.reject("unsupported", t.message) }
      }, MoreExecutors.directExecutor())
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  @ReactMethod
  fun stopExercise(promise: Promise) {
    val prefs = ctx.getSharedPreferences("wearllm_ex", Context.MODE_PRIVATE)
    val start = prefs.getLong("start", 0L)
    val kind = prefs.getString("kind", "workout") ?: "workout"
    try {
      Futures.addCallback(HealthServices.getClient(ctx).exerciseClient.endExerciseAsync(), object : FutureCallback<Void> {
        override fun onSuccess(result: Void?) {
          prefs.edit().remove("start").apply()
          val mins = if (start > 0) ((System.currentTimeMillis() - start) / 60_000).toInt() else 0
          promise.resolve(if (mins > 0) "Ended your $kind after about $mins minute${if (mins == 1) "" else "s"}." else "Ended your $kind.")
        }
        override fun onFailure(t: Throwable) { promise.reject("no_exercise", t.message) }
      }, MoreExecutors.directExecutor())
    } catch (e: Exception) {
      promise.reject("tool_failed", e.message, e)
    }
  }

  // Step-derived daily summary (reliable; the passive-monitoring API needs a background
  // service accumulating over time and wouldn't have data on first use).
  @ReactMethod
  fun dailyActivity(promise: Promise) =
      readSensorOnce(Sensor.TYPE_STEP_COUNTER, 5_000, promise) { v ->
        val total = v[0].toLong()
        val p = ctx.getSharedPreferences("wearllm_steps", Context.MODE_PRIVATE)
        val doy = java.util.Calendar.getInstance().get(java.util.Calendar.DAY_OF_YEAR)
        var base = p.getLong("base", -1L)
        if (p.getInt("day", -1) != doy || base < 0 || base > total) {
          base = total
          p.edit().putInt("day", doy).putLong("base", base).apply()
        }
        val steps = total - base
        "Today you've taken about $steps steps — roughly ${(steps * 0.04).toInt()} calories and ${"%.1f".format(steps * 0.0008)} km."
      }

  // === Play a song by name ===================================================
  @ReactMethod
  fun playSong(query: String, promise: Promise) {
    // Preferred: hand the query to a media app that searches & plays.
    val playFromSearch = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH).apply {
      putExtra(SearchManager.QUERY, query)
      putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
    }
    if (playFromSearch.resolveActivity(ctx.packageManager) != null) {
      fire(playFromSearch, promise, "played")
      return
    }
    // Fallback (this watch): open YouTube Music so the user can play it there.
    val yt = ctx.packageManager.getLaunchIntentForPackage("com.google.android.apps.youtube.music")
    if (yt != null) {
      yt.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try { ctx.startActivity(yt); promise.resolve("opened"); return } catch (_: Exception) {}
    }
    promise.reject("no_player", "No music app can search and play here")
  }
}

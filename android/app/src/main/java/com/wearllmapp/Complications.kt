package com.wearllmapp

import android.app.PendingIntent
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

private fun ctext(s: String): ComplicationText = PlainComplicationText.Builder(s).build()
private fun shortText(text: String, desc: String) =
    ShortTextComplicationData.Builder(ctext(text), ctext(desc)).build()

/** Tap → open the assistant. */
class AssistantComplication : ComplicationDataSourceService() {
  override fun getPreviewData(type: ComplicationType): ComplicationData = shortText("Ask", "Open WearLLM")

  override fun onComplicationRequest(request: ComplicationRequest, listener: ComplicationRequestListener) {
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val pi = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    listener.onComplicationData(
        ShortTextComplicationData.Builder(ctext("Ask"), ctext("Open WearLLM")).setTapAction(pi).build())
  }
}

/** Battery temperature (°C). */
class BatteryTempComplication : ComplicationDataSourceService() {
  override fun getPreviewData(type: ComplicationType): ComplicationData = shortText("24°", "Battery temp")

  override fun onComplicationRequest(request: ComplicationRequest, listener: ComplicationRequestListener) {
    val bi = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val t = bi?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1
    val c = if (t > 0) (t / 10.0).roundToInt() else -1
    listener.onComplicationData(shortText(if (c > 0) "$c°" else "—", "Battery temperature"))
  }
}

/** Next upcoming calendar event (needs READ_CALENDAR). */
class NextEventComplication : ComplicationDataSourceService() {
  override fun getPreviewData(type: ComplicationType): ComplicationData = shortText("9:00 Standup", "Next event")

  override fun onComplicationRequest(request: ComplicationRequest, listener: ComplicationRequestListener) {
    val s = try {
      val now = System.currentTimeMillis()
      val b = CalendarContract.Instances.CONTENT_URI.buildUpon()
      ContentUris.appendId(b, now)
      ContentUris.appendId(b, now + 7L * 86_400_000L)
      contentResolver.query(
          b.build(),
          arrayOf(CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN),
          null, null, "${CalendarContract.Instances.BEGIN} ASC").use { c ->
        if (c != null && c.moveToFirst()) {
          val title = c.getString(0) ?: "Event"
          val t = SimpleDateFormat("h:mm", Locale.US).format(Date(c.getLong(1)))
          "$t $title"
        } else "Clear"
      }
    } catch (e: SecurityException) { "—" } catch (e: Exception) { "—" }
    listener.onComplicationData(shortText(s.take(20), "Next event"))
  }
}

/** Steps today as a goal-progress ring toward 10,000. */
class StepsComplication : ComplicationDataSourceService() {
  override fun getPreviewData(type: ComplicationType): ComplicationData =
      RangedValueComplicationData.Builder(6500f, 0f, 10000f, ctext("Steps today")).setText(ctext("6.5k")).build()

  private fun ranged(steps: Int): ComplicationData {
    val label = if (steps >= 1000) "%.1fk".format(steps / 1000.0) else steps.toString()
    return RangedValueComplicationData.Builder(
        steps.coerceIn(0, 10000).toFloat(), 0f, 10000f, ctext("$steps steps today"))
        .setText(ctext(label)).build()
  }

  private fun todaySteps(total: Long): Int {
    val p = getSharedPreferences("wearllm_steps", Context.MODE_PRIVATE)
    val doy = Calendar.getInstance().get(Calendar.DAY_OF_YEAR)
    var base = p.getLong("base", -1L)
    if (p.getInt("day", -1) != doy || base < 0 || base > total) {
      base = total
      p.edit().putInt("day", doy).putLong("base", base).apply()
    }
    return (total - base).toInt()
  }

  override fun onComplicationRequest(request: ComplicationRequest, listener: ComplicationRequestListener) {
    val sm = getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
    if (sensor == null) { listener.onComplicationData(ranged(0)); return }
    val handler = Handler(Looper.getMainLooper())
    val done = AtomicBoolean(false)
    lateinit var l: SensorEventListener
    val timeout = Runnable { if (done.compareAndSet(false, true)) { sm.unregisterListener(l); listener.onComplicationData(ranged(0)) } }
    l = object : SensorEventListener {
      override fun onSensorChanged(e: SensorEvent) {
        if (done.compareAndSet(false, true)) {
          handler.removeCallbacks(timeout)
          sm.unregisterListener(this)
          listener.onComplicationData(ranged(todaySteps(e.values[0].toLong())))
        }
      }
      override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }
    sm.registerListener(l, sensor, SensorManager.SENSOR_DELAY_FASTEST)
    handler.postDelayed(timeout, 4_000)
  }
}

/** Last heart-rate reading (cached when the heart_rate tool runs; live HR is too slow for a complication). */
class HeartRateComplication : ComplicationDataSourceService() {
  override fun getPreviewData(type: ComplicationType): ComplicationData = shortText("72", "Heart rate")

  override fun onComplicationRequest(request: ComplicationRequest, listener: ComplicationRequestListener) {
    val hr = getSharedPreferences("wearllm_cache", Context.MODE_PRIVATE).getString("hr", null)
    listener.onComplicationData(shortText(hr ?: "—", "Heart rate (bpm)"))
  }
}

/** Latest weather (cached when the weather tool runs). */
class WeatherComplication : ComplicationDataSourceService() {
  override fun getPreviewData(type: ComplicationType): ComplicationData = shortText("72°", "Weather")

  override fun onComplicationRequest(request: ComplicationRequest, listener: ComplicationRequestListener) {
    val w = getSharedPreferences("wearllm_cache", Context.MODE_PRIVATE).getString("weather", null)
    listener.onComplicationData(shortText(w ?: "—", "Weather"))
  }
}

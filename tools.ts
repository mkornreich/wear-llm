/**
 * On-device function-calling for the watch assistant.
 *
 * Runs on the same SmolLM2-360M that powers chat (no RAM for a second model). Two layers
 * decide whether an utterance is a command:
 *   1. `parseCommandLocally` — a fast regex parser that recognises common phrasings instantly
 *      (the watch does ~1-4 tok/s, so avoiding a model round-trip matters).
 *   2. `classifyToolLLM` — for phrasings the regex misses, one JSON-schema-constrained call to
 *      llama.cpp. The grammar guarantees structurally-valid tool JSON.
 * Anything that isn't a command falls through to normal streaming chat.
 *
 * Tools are executed by the native `Tools` module (Android intents / ContentResolver), except
 * search_wikipedia which is a plain HTTPS fetch here in JS.
 */
import {NativeModules, PermissionsAndroid} from 'react-native';

const {Tools} = NativeModules;

// Wikimedia (and potentially other APIs) reject the default okhttp User-Agent with a 403, so
// every external fetch goes through this wrapper with a descriptive UA. (capital-F names so a
// blanket apiFetch()->apiFetch() rename doesn't touch these.)
const API_UA = 'WearLLMApp/1.0 (https://github.com/mkornreich/wearllmapp; on-watch assistant)';
const rawFetch = fetch;
function apiFetch(url: string, init?: any): Promise<any> {
  return rawFetch(url, {...init, headers: {'User-Agent': API_UA, ...(init && init.headers)}});
}

export type ToolCall =
  | {tool: 'set_timer'; seconds: number; human: string; label?: string}
  | {tool: 'set_alarm'; hour24: number; minute: number; human: string; label?: string}
  | {tool: 'open_app'; app: string}
  | {tool: 'get_time'}
  | {tool: 'get_date'}
  | {tool: 'flashlight'; on: boolean}
  | {tool: 'show_on_map'; query: string}
  | {tool: 'search_wikipedia'; query: string}
  | {tool: 'read_contacts'; query: string}
  | {tool: 'create_contact'; name: string; phone?: string; email?: string}
  | {tool: 'compose_email'; to?: string; subject?: string; body?: string}
  | {tool: 'read_calendar'; days: number}
  | {tool: 'create_event'; title: string; location?: string; startMs: number; endMs: number; human: string}
  | {tool: 'news'}
  | {tool: 'calculate'; expression: string}
  | {tool: 'weather'; city?: string}
  | {tool: 'get_battery'}
  | {tool: 'set_volume'; stream: 'music' | 'alarm' | 'ring' | 'call'; percent?: number; direction?: 'up' | 'down'}
  | {tool: 'media_control'; action: 'play' | 'pause' | 'next' | 'previous' | 'playpause'}
  | {tool: 'web_search'; query: string}
  | {tool: 'dial_phone'; number: string}
  | {tool: 'compose_sms'; number?: string; body?: string}
  | {tool: 'show_timers'}
  | {tool: 'show_alarms'}
  | {tool: 'dismiss_alarm'}
  | {tool: 'set_brightness'; percent: number}
  | {tool: 'set_screen_timeout'; seconds: number}
  | {tool: 'set_text_size'; scale: number}
  | {tool: 'toggle_24hour'; on: boolean}
  | {tool: 'toggle_adaptive_brightness'; on: boolean}
  | {tool: 'set_ringer_mode'; mode: 'normal' | 'vibrate' | 'silent'}
  | {tool: 'do_not_disturb'; on: boolean}
  | {tool: 'check_connectivity'}
  | {tool: 'compass_heading'}
  | {tool: 'get_volume'; stream: 'music' | 'alarm' | 'ring' | 'call'}
  | {tool: 'vibrate_watch'; pattern: 'single' | 'double' | 'sos'}
  | {tool: 'free_storage'}
  | {tool: 'battery_health'}
  | {tool: 'get_ringer_mode'}
  | {tool: 'wifi_signal'}
  | {tool: 'ambient_light'}
  | {tool: 'spirit_level'}
  | {tool: 'copy_to_clipboard'; text: string}
  | {tool: 'bluetooth_status'}
  | {tool: 'heart_rate'}
  | {tool: 'step_count'}
  | {tool: 'where_am_i'}
  | {tool: 'post_reminder'; title?: string; text: string}
  | {tool: 'convert_units'; value: number; from: string; to: string}
  | {tool: 'convert_currency'; amount: number; from: string; to: string}
  | {tool: 'sun_times'; city?: string}
  | {tool: 'define_word'; word: string}
  | {tool: 'days_until'; date: string}
  | {tool: 'crypto_price'; coin: string}
  | {tool: 'random_pick'; kind: 'coin' | 'dice' | 'number' | 'list'; min?: number; max?: number; options?: string[]}
  | {tool: 'moon_phase'}
  | {tool: 'world_time'; city: string}
  | {tool: 'note_add'; text: string}
  | {tool: 'note_list'}
  | {tool: 'todo_add'; text: string}
  | {tool: 'todo_list'}
  | {tool: 'todo_done'; which: string}
  | {tool: 'count_photos'}
  | {tool: 'count_songs'}
  | {tool: 'count_videos'}
  | {tool: 'check_phone_connection'}
  | {tool: 'now_playing'}
  | {tool: 'translate'; text: string; lang: string}
  | {tool: 'tip'; amount: number; percent?: number}
  | {tool: 'start_exercise'; kind: string}
  | {tool: 'stop_exercise'}
  | {tool: 'get_daily_activity'}
  | {tool: 'get_timezone'}
  | {tool: 'show_compass'}
  | {tool: 'dictionary'; word: string}
  | {tool: 'thesaurus'; word: string}
  | {tool: 'rhymes'; word: string}
  | {tool: 'play_song'; query: string}
  | {tool: 'nearby'; query: string}
  | {tool: 'save_location'}
  | {tool: 'saved_locations'}
  | {tool: 'show_picture'; query: string}
  | {tool: 'open_url'; url: string};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n: number) => String(n).padStart(2, '0');

function humanDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const h = seconds / 3600;
    return `${h} hour${h > 1 ? 's' : ''}`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m} minute${m > 1 ? 's' : ''}`;
  }
  return `${seconds} second${seconds !== 1 ? 's' : ''}`;
}

function fmt12h(hour24: number, minute: number): string {
  const ap = hour24 >= 12 ? 'PM' : 'AM';
  let h = hour24 % 12;
  if (h === 0) h = 12;
  return `${h}:${pad2(minute)} ${ap}`;
}

function fmtWhen(d: Date): string {
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const day = sameDay(d, today) ? 'today' : sameDay(d, tomorrow) ? 'tomorrow' : DAYS[d.getDay()];
  return `${day} at ${fmt12h(d.getHours(), d.getMinutes())}`;
}

// start/end epoch-ms for a new event, from an optional spoken time (defaults to the next hour).
function computeEventTimes(opts: {hour?: number; minute?: number; tomorrow?: boolean; durationMin?: number}): {startMs: number; endMs: number} {
  const now = new Date();
  let start: Date;
  if (opts.hour != null && isFinite(opts.hour)) {
    start = new Date(now);
    start.setHours(opts.hour, opts.minute || 0, 0, 0);
    if (opts.tomorrow) start.setDate(start.getDate() + 1);
    else if (start.getTime() < now.getTime()) start.setDate(start.getDate() + 1);
  } else {
    start = new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000); // next hour boundary
  }
  const startMs = start.getTime();
  return {startMs, endMs: startMs + (opts.durationMin || 60) * 60_000};
}

// ---------------------------------------------------------------------------
// Word-number parsing (dictation sometimes spells small numbers out)
// ---------------------------------------------------------------------------
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};
function toNum(token: string | undefined): number | null {
  if (!token) return null;
  const t = token.trim().toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return t in WORD_NUM ? WORD_NUM[t] : null;
}
const NUM = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)';

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /\+?\d[\d\s-]{5,}\d/;

// ---------------------------------------------------------------------------
// Layer 1 — instant local parsing of common phrasings
// ---------------------------------------------------------------------------
export function parseCommandLocally(text: string): ToolCall | null {
  const raw = text.trim();
  const t = raw.toLowerCase().replace(/[.?!]+$/, '');

  // get_time / get_date
  if (/\bwhat(?:'s| is)?\s+the\s+time\b|\bwhat\s+time\s+is\s+it\b|\bcurrent\s+time\b/.test(t)) return {tool: 'get_time'};
  if (/\bwhat(?:'s| is)?\s+(?:the|today'?s)\s+date\b|\bwhat\s+day\s+is\s+it\b|\bwhat'?s\s+today\b/.test(t)) return {tool: 'get_date'};

  // set_timer
  if (/\btimer\b/.test(t) && /\b(set|start|make|create|timer)\b/.test(t)) {
    const m = new RegExp(`${NUM}\\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours)\\b`).exec(t);
    const n = m ? toNum(m[1]) : null;
    if (m && n != null) {
      const seconds = /^h/.test(m[2]) ? n * 3600 : /^m/.test(m[2]) ? n * 60 : n;
      return {tool: 'set_timer', seconds, human: humanDuration(seconds)};
    }
  }

  // set_alarm
  if (/\balarm\b/.test(t) || /\bwake me\b/.test(t)) {
    const m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(t);
    if (m) {
      let hour = parseInt(m[1], 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      const mer = (m[3] || '').replace(/\./g, '');
      if (hour <= 23 && minute <= 59) {
        if (mer === 'pm' && hour < 12) hour += 12;
        if (mer === 'am' && hour === 12) hour = 0;
        return {tool: 'set_alarm', hour24: hour, minute, human: fmt12h(hour, minute)};
      }
    }
  }

  // flashlight
  if (/\b(flashlight|torch|flash ?light)\b/.test(t)) {
    const off = /\b(off|turn it off|stop|disable)\b/.test(t);
    return {tool: 'flashlight', on: !off};
  }

  // show a picture (Creative Commons via Openverse) — handled visually in App.tsx
  {
    const m = /\bshow (?:me )?(?:a |an )?(?:picture|image|photo|pic) of\s+(.+)/i.exec(t) || /\b(?:picture|image|photo) of\s+(.+)/i.exec(t) || /\bwhat does\s+(.+?)\s+look like\b/i.exec(t);
    if (m && m[1]) return {tool: 'show_picture', query: m[1].replace(/^(a|an|the)\s+/i, '').trim()};
  }

  // search_wikipedia (very specific keyword)
  if (/\bwikipedia\b/.test(t)) {
    const m =
      /(?:search|look up)\s+wikipedia\s+(?:for\s+|about\s+)?(.+)/.exec(t) ||
      /(?:search|look up)\s+(.+?)\s+(?:on|in)\s+wikipedia/.exec(t) ||
      /wikipedia\s+(?:for\s+|about\s+)?(.+)/.exec(t) ||
      /(?:what(?:'s| is)|who(?:'s| is)|tell me about)\s+(.+?)\s+(?:on|in|from)\s+wikipedia/.exec(t);
    if (m && m[1]) return {tool: 'search_wikipedia', query: m[1].trim()};
    const q = t.replace(/\b(on|in|search|look up|for|about|the)\b/g, ' ').replace(/wikipedia/g, ' ').replace(/\s+/g, ' ').trim();
    if (q) return {tool: 'search_wikipedia', query: q};
  }

  // show_on_map
  {
    const m =
      /(?:navigate to|directions to)\s+(.+)/.exec(t) ||
      /(?:show|find|pull up|map)\s+(.+?)\s+on (?:the|a) map/.exec(t) ||
      /(.+?)\s+on (?:the|a) map/.exec(t) ||
      /^map\s+(.+)/.exec(t);
    if (m && m[1]) {
      const q = m[1].replace(/^(?:me|the|a)\s+/, '').trim();
      if (q) return {tool: 'show_on_map', query: q};
    }
  }

  // read_calendar (question forms only — create forms handled below)
  if (/\b(calendar|schedule|agenda)\b/.test(t) && /\b(what|show|my|any|do i|check|see)\b/.test(t) && !/\b(create|add|new|set up|schedule (?:a|an|my))\b/.test(t)) {
    const days = /\btomorrow\b/.test(t) ? 2 : /\bweek\b/.test(t) ? 7 : 1;
    return {tool: 'read_calendar', days};
  }
  if (/\b(?:do i have|any)\b[\s\S]*\b(events?|meetings?|appointments?)\b/.test(t)) {
    return {tool: 'read_calendar', days: /\btomorrow\b/.test(t) ? 2 : /\bweek\b/.test(t) ? 7 : 1};
  }
  if (/\bwhat(?:'s| is)?\s+(?:my\s+)?(?:next|first)\s+(?:event|meeting|appointment)\b/.test(t)) {
    return {tool: 'read_calendar', days: 7};
  }

  // create_event
  if (/\b(create|add|schedule|set up|make|new)\b[\s\S]*\b(event|meeting|appointment)\b/.test(t)) {
    const tm =
      /(?:called|titled|named|for|about)\s+(.+?)(?:\s+(?:at|on|tomorrow|today)\b[\s\S]*)?$/.exec(t) ||
      /(?:event|meeting|appointment)\s+(.+)/.exec(t);
    let title = tm && tm[1] ? tm[1].trim() : 'New event';
    const tt = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(t);
    let hour: number | undefined;
    let minute = 0;
    if (tt) {
      hour = parseInt(tt[1], 10);
      minute = tt[2] ? parseInt(tt[2], 10) : 0;
      const mer = (tt[3] || '').replace(/\./g, '');
      if (mer === 'pm' && hour < 12) hour += 12;
      if (mer === 'am' && hour === 12) hour = 0;
    }
    const {startMs, endMs} = computeEventTimes({hour, minute, tomorrow: /\btomorrow\b/.test(t)});
    return {tool: 'create_event', title, startMs, endMs, human: fmtWhen(new Date(startMs))};
  }

  // read_contacts
  {
    const m =
      /what(?:'s| is)\s+(.+?)(?:'s)?\s+(?:number|phone number|phone|contact)\b/.exec(t) ||
      /(?:find|look up|show|get)\s+(?:the\s+)?(?:number|phone|contact)\s+(?:for|of)\s+(.+)/.exec(t) ||
      /(?:find|look up)\s+(.+?)(?:'s)?\s+(?:number|contact)\b/.exec(t) ||
      /(?:contact|number)\s+(?:for|of)\s+(.+)/.exec(t);
    if (m && m[1]) return {tool: 'read_contacts', query: m[1].trim()};
  }

  // create_contact (use original casing for name/email)
  if (/\b(create|add|make|save|new)\b[\s\S]*\bcontact\b/.test(t)) {
    const phone = (PHONE_RE.exec(raw) || [])[0]?.replace(/\s/g, '');
    const email = (EMAIL_RE.exec(raw) || [])[0];
    const nm =
      /(?:named|called|for)\s+([A-Za-z][A-Za-z ]*?)(?:\s+(?:at|with|number|email|\d|[\w.+-]+@)[\s\S]*)?$/.exec(raw) ||
      /contact\s+([A-Za-z][A-Za-z ]*?)(?:\s+(?:at|with|number|email|\d|[\w.+-]+@)[\s\S]*)?$/i.exec(raw);
    const name = nm && nm[1] ? nm[1].trim() : undefined;
    if (name) return {tool: 'create_contact', name, phone, email};
  }

  // compose_email
  if (/\b(send|write|compose)\b[\s\S]*\bemail\b/.test(t)) {
    const to = (EMAIL_RE.exec(raw) || [])[0] || '';
    return {tool: 'compose_email', to, subject: '', body: ''};
  }

  // battery
  if (/\bbattery\b/.test(t) || (/\bcharge\b/.test(t) && /\b(what|how much|level|percent|left|remaining|status)\b/.test(t))) {
    if (/\b(health|temperature|temp|hot|cold|degrees|warm)\b/.test(t)) return {tool: 'battery_health'};
    return {tool: 'get_battery'};
  }

  // volume
  if (/\bvolume\b/.test(t) || /\b(louder|quieter|turn it up|turn it down|mute)\b/.test(t)) {
    const stream = /\balarm\b/.test(t) ? 'alarm' : /\b(ring|ringer)\b/.test(t) ? 'ring' : /\b(call|voice)\b/.test(t) ? 'call' : 'music';
    if (/\bmute\b/.test(t)) return {tool: 'set_volume', stream, percent: 0};
    const pm = /(\d{1,3})\s*(?:percent|%)/.exec(t) || /volume\s+(?:to|at)\s+(\d{1,3})/.exec(t);
    if (pm) return {tool: 'set_volume', stream, percent: Math.min(100, parseInt(pm[1], 10))};
    if (/\b(full|max|maximum)\b/.test(t)) return {tool: 'set_volume', stream, percent: 100};
    if (/\bhalf\b/.test(t)) return {tool: 'set_volume', stream, percent: 50};
    if (/\b(up|louder|raise|increase|higher)\b/.test(t)) return {tool: 'set_volume', stream, direction: 'up'};
    if (/\b(down|quieter|lower|decrease|softer)\b/.test(t)) return {tool: 'set_volume', stream, direction: 'down'};
  }

  // media playback
  if (/\b(pause|resume|unpause)\b/.test(t) && /\b(music|song|track|audio|playback|it)\b/.test(t)) {
    return {tool: 'media_control', action: /\bpause\b/.test(t) ? 'pause' : 'play'};
  }
  if (/\b(next|skip)\b[\s\S]*\b(song|track|music)\b/.test(t) || /^skip$/.test(t)) return {tool: 'media_control', action: 'next'};
  if (/\b(previous|last|go back)\b[\s\S]*\b(song|track|music)\b/.test(t)) return {tool: 'media_control', action: 'previous'};
  if (/\b(play|pause)\s+(?:the\s+|my\s+)?(music|song)\s*$/.test(t)) return {tool: 'media_control', action: /pause/.test(t) ? 'pause' : 'playpause'};
  // play a specific song/artist (not bare "play music", handled above)
  {
    const m = /^(?:play|put on)\s+(?:the song\s+|some\s+)?(.+)/.exec(t);
    if (m && m[1] && !/^(music|the music|my music|a song|song|something|it)$/.test(m[1].trim())) return {tool: 'play_song', query: m[1].trim()};
  }

  // web search
  {
    const m = /(?:search\s+(?:the\s+)?web|search\s+google|google|search)\s+(?:for\s+)?(.+)/.exec(t);
    if (m && m[1] && !/\bwikipedia\b/.test(t)) return {tool: 'web_search', query: m[1].trim()};
  }

  // dial
  {
    const m = /\b(?:call|dial|phone)\s+(?:the\s+)?([\d][\d\s\-()+]{3,})/.exec(raw);
    if (m) return {tool: 'dial_phone', number: m[1].replace(/[^\d+]/g, '')};
  }

  // sms
  if (/\b(text|sms|send a (?:text|message))\b/.test(t)) {
    const numM = /([\d][\d\s\-()+]{4,})/.exec(raw);
    const bodyM = /(?:saying|that says|:)\s+(.+)$/i.exec(raw);
    return {tool: 'compose_sms', number: numM ? numM[1].replace(/[^\d+]/g, '') : '', body: bodyM ? bodyM[1].trim() : ''};
  }

  // show timers / show alarms / dismiss alarm (set_timer & set_alarm already ran above)
  if (/\btimers?\b/.test(t) && /\b(show|see|check|my|running|left|remaining|how (?:much|long))\b/.test(t)) return {tool: 'show_timers'};
  if (/\balarms?\b/.test(t) && /\b(dismiss|stop|turn off|silence|cancel)\b/.test(t)) return {tool: 'dismiss_alarm'};
  if (/\balarms?\b/.test(t) && /\b(show|see|check|list|my|what)\b/.test(t)) return {tool: 'show_alarms'};

  // brightness / adaptive brightness
  if (/\bbright(?:ness)?\b/.test(t) || /\bdim\b/.test(t)) {
    if (/\b(adaptive|auto)\b/.test(t)) return {tool: 'toggle_adaptive_brightness', on: !/\b(off|manual|disable)\b/.test(t)};
    const pm = /(\d{1,3})\s*(?:percent|%)/.exec(t) || /bright(?:ness)?\s+(?:to|at)\s+(\d{1,3})/.exec(t);
    if (pm) return {tool: 'set_brightness', percent: Math.min(100, parseInt(pm[1], 10))};
    if (/\b(dim|dimmer|darker)\b/.test(t)) return {tool: 'set_brightness', percent: 15};
    if (/\b(bright|brighter|brightest|max)\b/.test(t)) return {tool: 'set_brightness', percent: 100};
  }

  // screen timeout
  if (/\bscreen\b[\s\S]*\b(timeout|time out|stay|awake|on)\b/.test(t) || /\bkeep (?:the )?screen\b/.test(t)) {
    const m = new RegExp(`${NUM}\\s*(sec|secs|second|seconds|min|mins|minute|minutes)`).exec(t);
    const n = m ? toNum(m[1]) : null;
    if (m && n != null) return {tool: 'set_screen_timeout', seconds: /^m/.test(m[2]) ? n * 60 : n};
  }

  // text size
  if (/\b(text size|font size|font|text)\b/.test(t) && /\b(big|bigger|large|larger|small|smaller|normal|increase|decrease|huge|tiny)\b/.test(t)) {
    const scale = /\b(biggest|largest|huge)\b/.test(t) ? 1.3
      : /\b(big|bigger|large|larger|increase)\b/.test(t) ? 1.15
      : /\b(smallest|tiny)\b/.test(t) ? 0.85
      : /\b(small|smaller|decrease)\b/.test(t) ? 0.9 : 1.0;
    return {tool: 'set_text_size', scale};
  }

  // 24-hour clock
  if (/\b(24[\s-]?hour|military time|12[\s-]?hour)\b/.test(t)) return {tool: 'toggle_24hour', on: /\b(24|military)\b/.test(t)};

  // ringer read (question forms) before the setters
  if (/\b(ringer|silent|vibrate)\b/.test(t) && /\b(is it|is my|what'?s|what is|current|check|am i)\b/.test(t)) return {tool: 'get_ringer_mode'};
  // do not disturb / ringer (setters)
  if (/\b(do not disturb|don'?t disturb|dnd)\b/.test(t)) return {tool: 'do_not_disturb', on: !/\b(off|disable|turn off|stop|end)\b/.test(t)};
  if (/\bvibrate\b/.test(t) && /\b(mode|ringer|only|set|to)\b/.test(t)) return {tool: 'set_ringer_mode', mode: 'vibrate'};
  if (/\b(silent|silence)\b/.test(t) && !/\b(timer|alarm|music|the alarm)\b/.test(t)) return {tool: 'set_ringer_mode', mode: 'silent'};
  if (/\b(ringer|ring|sound)\b[\s\S]*\b(on|normal|back)\b/.test(t)) return {tool: 'set_ringer_mode', mode: 'normal'};

  // news
  if (/\b(news|headlines)\b/.test(t)) return {tool: 'news'};

  // weather
  if (/\b(weather|forecast|temperature)\b/.test(t)) {
    const m = /(?:weather|forecast|temperature)\s+(?:in|for|at)\s+(.+)/.exec(t) || /\b(?:in|for)\s+(.+?)\s+(?:weather|forecast)\b/.exec(t);
    const city = m && m[1] ? m[1].trim() : undefined;
    return {tool: 'weather', city};
  }

  // calculate — needs a digit AND a math operator/verb (so it doesn't steal "at 5 pm" etc.)
  if (/[0-9]/.test(t) && /(plus|minus|times|multiplied|divided|\bover\b|percent|%|\bx\b|\+|-|\*|\/|\^|to the power|square root|sqrt|calculate|compute|how much is)/.test(t)) {
    return {tool: 'calculate', expression: raw};
  }

  // sensors & health
  if (/\b(show|open|pull up|display)\b[\s\S]*\bcompass\b/.test(t)) return {tool: 'show_compass'};
  if (/\b(heart rate|pulse|bpm|how fast is my heart|heartbeat)\b/.test(t)) return {tool: 'heart_rate'};
  if (/\b(step count|how many steps|steps today|steps have i|my steps)\b/.test(t)) return {tool: 'step_count'};
  if (/\b(compass|which way( am i)?|what direction|heading|which way is|facing)\b/.test(t)) return {tool: 'compass_heading'};
  if (/\b(how (bright|dark) is it|light level|ambient light|how much light|lux)\b/.test(t)) return {tool: 'ambient_light'};
  if (/\b(spirit level|bubble level|is (it|this|that) level|am i level)\b/.test(t)) return {tool: 'spirit_level'};

  // status reads
  if (/\b(am i online|am i offline|am i connected|internet connection|do i have (internet|wi.?fi|a connection|data)|check.*connection)\b/.test(t)) return {tool: 'check_connectivity'};
  if (/\b(wi.?fi signal|signal strength|how (good|strong) is (my |the )?wi.?fi)\b/.test(t)) return {tool: 'wifi_signal'};
  if (/\bbluetooth\b/.test(t)) return {tool: 'bluetooth_status'};
  if (/\b(storage|free space|disk space|space left|how much (space|storage))\b/.test(t)) return {tool: 'free_storage'};
  if (/\b(what'?s (the )?volume|how loud|current volume|volume level)\b/.test(t)) return {tool: 'get_volume', stream: 'music'};

  // saved locations
  if (/\b(save (my|this) location|remember (my|this) (location|spot|place)|bookmark (my|this) location|save where i am|drop a pin)\b/.test(t)) return {tool: 'save_location'};
  if (/\b(saved locations|my (saved )?locations|recent locations|where have i saved|what locations have i saved|list (my )?saved)\b/.test(t)) return {tool: 'saved_locations'};

  // location / world time / sun
  if (/\b(where am i|where are we|my location|what'?s my location)\b/.test(t)) return {tool: 'where_am_i'};
  {
    const m = /\b(?:time in|what time is it in|what'?s the time in)\s+(.+)/.exec(t);
    if (m && m[1]) return {tool: 'world_time', city: m[1].trim()};
  }
  if (/\b(sunrise|sunset|sun ?rise|sun ?set|when does the sun (rise|set))\b/.test(t)) {
    const m = /\bin\s+(.+)/.exec(t);
    return {tool: 'sun_times', city: m ? m[1].trim() : undefined};
  }
  if (/\b(moon phase|phase of the moon|full moon|is it a (full|new) moon)\b/.test(t)) return {tool: 'moon_phase'};

  // nearby places (opens Maps searching around the user)
  {
    const m = /\b(?:nearest|closest|nearby)\s+(.+)/i.exec(t) || /\b(.+?)\s+near me\b/i.exec(t) || /\bfind\s+(?:the\s+)?(?:nearest|closest)\s+(.+)/i.exec(t);
    if (m && m[1]) {
      const q = m[1].replace(/\bnear me\b/i, '').replace(/^(a|an|the)\s+/, '').trim();
      if (q) return {tool: 'nearby', query: q};
    }
    if (/\b(what'?s (around here|nearby)|places near me|around here)\b/.test(t)) return {tool: 'nearby', query: 'places'};
  }

  // conversions
  {
    const CUR = /\b(usd|eur|gbp|jpy|cad|aud|chf|cny|inr|dollars?|euros?|pounds?|yen|rupees?|bucks?|quid)\b/;
    const m = /convert\s+([\d.]+)\s+(\S+)\s+(?:to|in|into)\s+(\S+)/.exec(t) || /how many\s+(\S+)\s+(?:is|are|in)\s+([\d.]+)\s+(\S+)/.exec(t);
    if (m) {
      const howmany = /^how many/.test(t);
      const value = parseFloat(howmany ? m[2] : m[1]);
      const from = (howmany ? m[3] : m[2]).replace(/[?.!]+$/, '');
      const to = (howmany ? m[1] : m[3]).replace(/[?.!]+$/, '');
      if (isFinite(value)) {
        if (CUR.test(from) || CUR.test(to)) return {tool: 'convert_currency', amount: value, from: curCode(from), to: curCode(to)};
        return {tool: 'convert_units', value, from, to};
      }
    }
  }

  // rhymes / thesaurus / dictionary / days-until / crypto
  {
    const m = /\b(?:rhymes?\s+(?:with|for)|what rhymes with)\s+(.+)/i.exec(t);
    if (m && m[1]) return {tool: 'rhymes', word: m[1].trim()};
  }
  {
    const m = /\b(?:synonyms?\s+(?:for|of)|thesaurus|another word for|other words for|what'?s another word for)\s+(.+)/i.exec(t);
    if (m && m[1]) return {tool: 'thesaurus', word: m[1].trim()};
  }
  {
    const m = /\blook up\s+(.+?)\s+in the dictionary\b/i.exec(t) || /\bdictionary\s+(?:definition (?:of|for)\s+|entry for\s+)?(.+)/i.exec(t);
    if (m && m[1]) return {tool: 'dictionary', word: m[1].trim()};
  }
  {
    const m = /\b(?:define|definition of)\s+(.+)/.exec(t) || /\bwhat does\s+(.+?)\s+mean\b/.exec(t);
    if (m && m[1]) return {tool: 'define_word', word: m[1].trim()};
  }
  {
    const m = /\b(?:how many days|days)\s+(?:until|till|to)\s+(.+)/.exec(t) || /\bhow long until\s+(.+)/.exec(t);
    if (m && m[1]) return {tool: 'days_until', date: m[1].trim()};
  }
  {
    const m = /\b(?:price of|how much is)\s+(bitcoin|btc|ethereum|eth|dogecoin|doge|solana|sol|cardano|ada|ripple|xrp|litecoin|ltc)\b/.exec(t) || /\b(bitcoin|btc|ethereum|eth|dogecoin|doge)\b[\s\S]*\bprice\b/.exec(t);
    if (m && m[1]) return {tool: 'crypto_price', coin: m[1]};
  }

  // random
  if (/\bflip a coin\b|\bheads or tails\b/.test(t)) return {tool: 'random_pick', kind: 'coin'};
  if (/\broll (?:a |the )?(?:dice|die|d6)\b/.test(t)) return {tool: 'random_pick', kind: 'dice'};
  {
    const m = /random number(?:\s+between\s+(\d+)\s+and\s+(\d+))?/.exec(t);
    if (m) return {tool: 'random_pick', kind: 'number', min: m[1] ? +m[1] : undefined, max: m[2] ? +m[2] : undefined};
  }

  // reminders / notes / to-dos
  {
    const m = /\bremind me to\s+(.+)/.exec(raw);
    if (m && m[1]) return {tool: 'post_reminder', text: m[1].trim()};
  }
  {
    const m = /\b(?:take a note|make a note|new note|note that|jot down)\b[:,]?\s*(.+)/i.exec(raw);
    if (m && m[1] && m[1].trim()) return {tool: 'note_add', text: m[1].trim()};
  }
  if (/\b(read (?:my )?notes|show (?:my )?notes|what are my notes|my notes)\b/.test(t)) return {tool: 'note_list'};
  {
    const m = /\b(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:my\s+)?(?:to.?do|todo|task)/i.exec(raw);
    if (m && m[1]) return {tool: 'todo_add', text: m[1].trim()};
  }
  if (/\b(?:what'?s on|show|read|check)\b[\s\S]*\b(?:to.?do|todo|task)\b/.test(t) || /\bmy (?:to.?do|todo|task) list\b/.test(t)) return {tool: 'todo_list'};
  {
    const m = /\b(?:check off|cross off|mark|complete|finished?|done with)\s+(.+?)(?:\s+(?:off|as done))?$/i.exec(raw);
    if (m && m[1] && /\b(to.?do|todo|task|list|off|done)\b/.test(t)) return {tool: 'todo_done', which: m[1].trim()};
  }

  // media counts
  if (/\bhow many (photos|pictures|images)\b|\bphoto count\b/.test(t)) return {tool: 'count_photos'};
  if (/\bhow many (songs|tracks|audio files?)\b|\bhow much music\b/.test(t)) return {tool: 'count_songs'};
  if (/\bhow many videos\b|\bvideo count\b/.test(t)) return {tool: 'count_videos'};

  // phone / media session / translate / tip / exercise
  if (/\b(is my phone (connected|near|paired|there)|phone connection|connected to (my )?phone)\b/.test(t)) return {tool: 'check_phone_connection'};
  if (/\b(what'?s playing|now playing|current song|what song is (this|playing)|what am i listening to|name of this song|what is this song|identify this song|what'?s this song)\b/.test(t)) return {tool: 'now_playing'};
  {
    const m = /\btranslate\s+(.+?)\s+(?:in ?to|to)\s+([a-z]+)\b/i.exec(raw) || /how do you say\s+(.+?)\s+in\s+([a-z]+)\b/i.exec(raw);
    if (m) return {tool: 'translate', text: m[1].trim(), lang: m[2].trim()};
  }
  if (/\btip\b/.test(t) && /\d/.test(t)) {
    const amtM = /\$?\s*(\d+(?:\.\d+)?)/.exec(t.replace(/(\d+)\s*(?:percent|%)/, ''));
    const pctM = /(\d+)\s*(?:percent|%)/.exec(t);
    if (amtM) return {tool: 'tip', amount: parseFloat(amtM[1]), percent: pctM ? parseInt(pctM[1], 10) : undefined};
  }
  if (/\b(start|begin|track)\b[\s\S]*\b(walk|run|running|jog|bike|biking|cycling|hike|hiking|workout|exercise)\b/.test(t)) {
    const kind = /\b(run|jog)/.test(t) ? 'run' : /\b(bike|cycl)/.test(t) ? 'bike' : /\bhik/.test(t) ? 'hike' : 'walk';
    return {tool: 'start_exercise', kind};
  }
  if (/\b(stop|end|finish)\b[\s\S]*\b(workout|exercise|walk|run|running|ride|hike)\b/.test(t)) return {tool: 'stop_exercise'};
  if (/\b(how active|my activity|activity summary|daily activity|how far have i walked)\b/.test(t)) return {tool: 'get_daily_activity'};
  if (/\b(time ?zone|what zone am i|which time ?zone)\b/.test(t)) return {tool: 'get_timezone'};

  // vibrate / clipboard
  if (/\b(vibrate|buzz)\b[\s\S]*\b(watch|wrist|me)\b|\bbuzz me\b/.test(t)) {
    return {tool: 'vibrate_watch', pattern: /\bsos\b/.test(t) ? 'sos' : /\b(twice|double)\b/.test(t) ? 'double' : 'single'};
  }
  {
    const m = /\bcopy\s+(.+?)\s+to (?:the )?clipboard\b/i.exec(raw) || /\bcopy to clipboard[:,]?\s+(.+)/i.exec(raw);
    if (m && m[1]) return {tool: 'copy_to_clipboard', text: m[1].trim()};
  }

  // open_url — "open google.com", "go to youtube dot com", "open https://site.com/path?q=1"
  {
    // dictation often spells out "dot"/"slash"; normalise before matching.
    const spoken = raw.trim().replace(/\s+dot\s+/gi, '.').replace(/\s+slash\s+/gi, '/');
    const m = /^(?:open|go to|visit|launch|navigate to|pull up)\s+(?:the\s+)?(?:website\s+|url\s+|page\s+|site\s+)?((?:https?:\/\/)?[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)?)$/i.exec(spoken);
    if (m && m[1]) return {tool: 'open_url', url: m[1].replace(/\s+/g, '')};
  }

  // open_app (generic verbs last)
  const open = /^(?:open|launch)\s+(?:the\s+)?(.+?)(?:\s+app)?$/.exec(t);
  if (open && !/\btimer\b|\balarm\b|\bstopwatch\b/.test(t)) {
    const app = open[1].replace(/^(a|an|the)\s+/, '').trim();
    if (app) return {tool: 'open_app', app};
  }

  return null;
}

export function looksLikeCommand(text: string): boolean {
  return /\b(timer|alarm|stopwatch|remind|wake me|open|launch|what time|what day|the date|today'?s date|flashlight|torch|wikipedia|map|navigate|directions|calendar|schedule|agenda|meeting|appointment|contact|number|email|news|headlines|weather|forecast|temperature|calculate|plus|minus|times|divided|battery|charge|volume|louder|quieter|mute|play|pause|skip|next song|call|dial|text|sms|message|brightness|dim|screen|font|24.hour|do not disturb|dnd|silent|vibrate|ringer|search|heart rate|pulse|steps|compass|which way|facing|online|offline|connected|wi.?fi|bluetooth|storage|space|location|where am i|sunrise|sunset|moon|convert|how many|define|definition|days until|bitcoin|ethereum|crypto|coin|dice|random|note|to.?do|task|photos|pictures|videos|songs|clipboard|copy|buzz|light|level|playing|listening|phone|translate|say in|tip|workout|exercise|walk|run|hike|active|time ?zone|dictionary|thesaurus|synonym|another word|rhyme|nearby|nearest|closest|near me|around here|save.*location|saved location|remember this|my location|this song)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Layer 2 — JSON-schema-constrained tool classification on the same model
// ---------------------------------------------------------------------------
const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: {
      type: 'string',
      enum: ['set_timer', 'set_alarm', 'open_app', 'get_time', 'get_date', 'flashlight',
        'show_on_map', 'search_wikipedia', 'read_contacts', 'create_contact', 'compose_email',
        'read_calendar', 'create_event', 'news', 'calculate', 'weather', 'get_battery',
        'set_volume', 'media_control', 'web_search', 'dial_phone', 'compose_sms', 'show_timers',
        'show_alarms', 'dismiss_alarm', 'set_brightness', 'set_screen_timeout', 'set_text_size',
        'toggle_24hour', 'toggle_adaptive_brightness', 'set_ringer_mode', 'do_not_disturb',
        'check_connectivity', 'compass_heading', 'get_volume', 'vibrate_watch', 'free_storage',
        'battery_health', 'get_ringer_mode', 'wifi_signal', 'ambient_light', 'spirit_level',
        'copy_to_clipboard', 'bluetooth_status', 'heart_rate', 'step_count', 'where_am_i',
        'post_reminder', 'convert_units', 'convert_currency', 'sun_times', 'define_word',
        'days_until', 'crypto_price', 'random_pick', 'moon_phase', 'world_time', 'note_add',
        'note_list', 'todo_add', 'todo_list', 'todo_done', 'count_photos', 'count_songs',
        'count_videos', 'check_phone_connection', 'now_playing', 'translate', 'tip',
        'start_exercise', 'stop_exercise', 'get_daily_activity', 'get_timezone', 'show_compass',
        'dictionary', 'thesaurus', 'rhymes', 'play_song', 'nearby', 'save_location',
        'saved_locations', 'open_url', 'none'],
    },
    amount: {type: 'integer'},
    unit: {type: 'string', enum: ['seconds', 'minutes', 'hours']},
    hour: {type: 'integer'},
    minute: {type: 'integer'},
    meridiem: {type: 'string', enum: ['am', 'pm', 'none']},
    tomorrow: {type: 'boolean'},
    app: {type: 'string'},
    query: {type: 'string'},
    name: {type: 'string'},
    phone: {type: 'string'},
    email: {type: 'string'},
    to: {type: 'string'},
    subject: {type: 'string'},
    body: {type: 'string'},
    title: {type: 'string'},
    location: {type: 'string'},
    days: {type: 'integer'},
    on: {type: 'boolean'},
    expression: {type: 'string'},
    city: {type: 'string'},
    stream: {type: 'string', enum: ['music', 'alarm', 'ring', 'call']},
    percent: {type: 'integer'},
    direction: {type: 'string', enum: ['up', 'down']},
    action: {type: 'string', enum: ['play', 'pause', 'next', 'previous', 'playpause']},
    number: {type: 'string'},
    seconds: {type: 'integer'},
    scale: {type: 'number'},
    mode: {type: 'string', enum: ['normal', 'vibrate', 'silent']},
    value: {type: 'number'},
    from: {type: 'string'},
    word: {type: 'string'},
    date: {type: 'string'},
    coin: {type: 'string'},
    kind: {type: 'string', enum: ['coin', 'dice', 'number', 'list']},
    min: {type: 'number'},
    max: {type: 'number'},
    options: {type: 'array', items: {type: 'string'}},
    text: {type: 'string'},
    which: {type: 'string'},
    pattern: {type: 'string', enum: ['single', 'double', 'sos']},
    lang: {type: 'string'},
    url: {type: 'string'},
    label: {type: 'string'},
  },
  required: ['tool'],
};

const CLASSIFY_SYSTEM =
  'You turn a smartwatch user\'s request into ONE tool call, as a JSON object.\n' +
  'Tools:\n' +
  '- set_timer {amount, unit: seconds|minutes|hours}\n' +
  '- set_alarm {hour 1-12, minute, meridiem: am|pm|none}\n' +
  '- open_app {app}\n' +
  '- get_time {} / get_date {}\n' +
  '- flashlight {on: true|false}\n' +
  '- show_on_map {query}  (a place or search)\n' +
  '- search_wikipedia {query}\n' +
  '- read_contacts {query: a name to look up}\n' +
  '- create_contact {name, phone?, email?}\n' +
  '- compose_email {to?, subject?, body?}\n' +
  '- read_calendar {days: 1 today, 2 tomorrow, 7 week}\n' +
  '- create_event {title, hour?, minute?, meridiem?, tomorrow?, location?}\n' +
  '- news {}  (top headlines)\n' +
  '- calculate {expression}  (a math expression)\n' +
  '- weather {city?}  (omit city for current location)\n' +
  '- get_battery {}\n' +
  '- set_volume {stream: music|alarm|ring|call, percent? or direction: up|down}\n' +
  '- media_control {action: play|pause|next|previous|playpause}\n' +
  '- web_search {query}\n' +
  '- dial_phone {number}\n' +
  '- compose_sms {number?, body?}\n' +
  '- show_timers {} / show_alarms {} / dismiss_alarm {}\n' +
  '- set_brightness {percent} / set_screen_timeout {seconds} / set_text_size {scale}\n' +
  '- toggle_24hour {on} / toggle_adaptive_brightness {on}\n' +
  '- set_ringer_mode {mode: normal|vibrate|silent} / do_not_disturb {on}\n' +
  '- check_connectivity {} / wifi_signal {} / bluetooth_status {} / free_storage {} / battery_health {} / get_volume {stream} / get_ringer_mode {}\n' +
  '- heart_rate {} / step_count {} / compass_heading {} / ambient_light {} / spirit_level {}\n' +
  '- where_am_i {} / world_time {city} / sun_times {city?}\n' +
  '- convert_units {value, from, to} / convert_currency {amount, from, to} / define_word {word} / days_until {date} / crypto_price {coin}\n' +
  '- random_pick {kind: coin|dice|number|list, min?, max?, options?} / moon_phase {}\n' +
  '- vibrate_watch {pattern: single|double|sos} / copy_to_clipboard {text} / post_reminder {title?, text}\n' +
  '- note_add {text} / note_list {} / todo_add {text} / todo_list {} / todo_done {which}\n' +
  '- count_photos {} / count_songs {} / count_videos {}\n' +
  '- check_phone_connection {} / now_playing {} / translate {text, lang} / tip {amount, percent?}\n' +
  '- start_exercise {kind: walk|run|bike|hike} / stop_exercise {} / get_daily_activity {}\n' +
  'If it is ordinary conversation, no tool clearly fits, or you are unsure, respond {"tool":"none"}.\n' +
  'Reply with ONLY the JSON object, nothing else.\n' +
  'Examples:\n' +
  '"set a timer for 5 minutes" -> {"tool":"set_timer","amount":5,"unit":"minutes"}\n' +
  '"wake me at 6:30 am" -> {"tool":"set_alarm","hour":6,"minute":30,"meridiem":"am"}\n' +
  '"turn on the flashlight" -> {"tool":"flashlight","on":true}\n' +
  '"show me Central Park on the map" -> {"tool":"show_on_map","query":"Central Park"}\n' +
  '"look up penguins on wikipedia" -> {"tool":"search_wikipedia","query":"penguins"}\n' +
  '"what is Dave\'s number" -> {"tool":"read_contacts","query":"Dave"}\n' +
  '"add a contact named Sam 555-2020" -> {"tool":"create_contact","name":"Sam","phone":"5552020"}\n' +
  '"email bob@x.com" -> {"tool":"compose_email","to":"bob@x.com"}\n' +
  '"what\'s on my calendar today" -> {"tool":"read_calendar","days":1}\n' +
  '"schedule a meeting called standup at 9am" -> {"tool":"create_event","title":"standup","hour":9,"meridiem":"am"}\n' +
  '"what\'s the news" -> {"tool":"news"}\n' +
  '"what is 15 times 7" -> {"tool":"calculate","expression":"15 * 7"}\n' +
  '"weather in Tokyo" -> {"tool":"weather","city":"Tokyo"}\n' +
  '"what\'s the weather" -> {"tool":"weather"}\n' +
  '"set volume to 40%" -> {"tool":"set_volume","stream":"music","percent":40}\n' +
  '"turn it up" -> {"tool":"set_volume","stream":"music","direction":"up"}\n' +
  '"how much battery do I have" -> {"tool":"get_battery"}\n' +
  '"pause the music" -> {"tool":"media_control","action":"pause"}\n' +
  '"skip this song" -> {"tool":"media_control","action":"next"}\n' +
  '"call 555 1234" -> {"tool":"dial_phone","number":"5551234"}\n' +
  '"text 5551234 running late" -> {"tool":"compose_sms","number":"5551234","body":"running late"}\n' +
  '"search the web for otter facts" -> {"tool":"web_search","query":"otter facts"}\n' +
  '"set brightness to 80%" -> {"tool":"set_brightness","percent":80}\n' +
  '"keep the screen on for 30 seconds" -> {"tool":"set_screen_timeout","seconds":30}\n' +
  '"make the text bigger" -> {"tool":"set_text_size","scale":1.15}\n' +
  '"use 24 hour time" -> {"tool":"toggle_24hour","on":true}\n' +
  '"turn on do not disturb" -> {"tool":"do_not_disturb","on":true}\n' +
  '"set it to vibrate" -> {"tool":"set_ringer_mode","mode":"vibrate"}\n' +
  '"dismiss the alarm" -> {"tool":"dismiss_alarm"}\n' +
  '"show my timers" -> {"tool":"show_timers"}\n' +
  '"what\'s my heart rate" -> {"tool":"heart_rate"}\n' +
  '"how many steps today" -> {"tool":"step_count"}\n' +
  '"which way am I facing" -> {"tool":"compass_heading"}\n' +
  '"am I online" -> {"tool":"check_connectivity"}\n' +
  '"where am I" -> {"tool":"where_am_i"}\n' +
  '"what time is it in London" -> {"tool":"world_time","city":"London"}\n' +
  '"convert 5 miles to km" -> {"tool":"convert_units","value":5,"from":"miles","to":"km"}\n' +
  '"how many dollars is 20 euros" -> {"tool":"convert_currency","amount":20,"from":"EUR","to":"USD"}\n' +
  '"define serendipity" -> {"tool":"define_word","word":"serendipity"}\n' +
  '"flip a coin" -> {"tool":"random_pick","kind":"coin"}\n' +
  '"roll a dice" -> {"tool":"random_pick","kind":"dice"}\n' +
  '"add milk to my to-do list" -> {"tool":"todo_add","text":"milk"}\n' +
  '"what\'s on my to-do list" -> {"tool":"todo_list"}\n' +
  '"take a note: door code 1234" -> {"tool":"note_add","text":"door code 1234"}\n' +
  '"remind me to stretch" -> {"tool":"post_reminder","text":"stretch"}\n' +
  '"how many photos do I have" -> {"tool":"count_photos"}\n' +
  '"is my phone connected" -> {"tool":"check_phone_connection"}\n' +
  '"what\'s playing" -> {"tool":"now_playing"}\n' +
  '"translate hello to Spanish" -> {"tool":"translate","text":"hello","lang":"Spanish"}\n' +
  '"tip on 50 dollars" -> {"tool":"tip","amount":50}\n' +
  '"20% tip on 45" -> {"tool":"tip","amount":45,"percent":20}\n' +
  '"start a walk" -> {"tool":"start_exercise","kind":"walk"}\n' +
  '"stop my workout" -> {"tool":"stop_exercise"}\n' +
  '"how active have I been today" -> {"tool":"get_daily_activity"}\n' +
  '"look up serendipity in the dictionary" -> {"tool":"dictionary","word":"serendipity"}\n' +
  '"synonyms for happy" -> {"tool":"thesaurus","word":"happy"}\n' +
  '"what rhymes with cat" -> {"tool":"rhymes","word":"cat"}\n' +
  '"play bohemian rhapsody" -> {"tool":"play_song","query":"bohemian rhapsody"}\n' +
  '"nearest coffee shop" -> {"tool":"nearby","query":"coffee shop"}\n' +
  '"save my location" -> {"tool":"save_location"}\n' +
  '"what locations have I saved" -> {"tool":"saved_locations"}\n' +
  '"open google.com" -> {"tool":"open_url","url":"google.com"}\n' +
  '"tell me a joke" -> {"tool":"none"}';

function normalizeRaw(r: any): ToolCall | null {
  if (!r || typeof r !== 'object') return null;
  const s = (v: any) => (typeof v === 'string' ? v.trim() : '');
  switch (r.tool) {
    case 'set_timer': {
      const amt = Number(r.amount);
      if (!isFinite(amt) || amt <= 0) return null;
      const unit = r.unit === 'hours' ? 3600 : r.unit === 'seconds' ? 1 : 60;
      const seconds = Math.round(amt * unit);
      return {tool: 'set_timer', seconds, human: humanDuration(seconds), label: s(r.label) || undefined};
    }
    case 'set_alarm': {
      let hour = Number(r.hour);
      const minute = isFinite(Number(r.minute)) ? Number(r.minute) : 0;
      if (!isFinite(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      if (r.meridiem === 'pm' && hour < 12) hour += 12;
      if (r.meridiem === 'am' && hour === 12) hour = 0;
      return {tool: 'set_alarm', hour24: hour, minute, human: fmt12h(hour, minute), label: s(r.label) || undefined};
    }
    case 'open_app':
      return s(r.app) ? {tool: 'open_app', app: s(r.app)} : null;
    case 'get_time':
      return {tool: 'get_time'};
    case 'get_date':
      return {tool: 'get_date'};
    case 'flashlight':
      return {tool: 'flashlight', on: r.on !== false};
    case 'show_on_map':
      return s(r.query) ? {tool: 'show_on_map', query: s(r.query)} : null;
    case 'search_wikipedia':
      return s(r.query) ? {tool: 'search_wikipedia', query: s(r.query)} : null;
    case 'read_contacts':
      return {tool: 'read_contacts', query: s(r.query)};
    case 'create_contact':
      return s(r.name) ? {tool: 'create_contact', name: s(r.name), phone: s(r.phone) || undefined, email: s(r.email) || undefined} : null;
    case 'compose_email':
      return {tool: 'compose_email', to: s(r.to), subject: s(r.subject), body: s(r.body)};
    case 'read_calendar': {
      const d = Number(r.days);
      return {tool: 'read_calendar', days: isFinite(d) && d > 0 ? d : 1};
    }
    case 'create_event': {
      if (!s(r.title)) return null;
      let hour = isFinite(Number(r.hour)) ? Number(r.hour) : undefined;
      const minute = isFinite(Number(r.minute)) ? Number(r.minute) : 0;
      if (hour != null && r.meridiem === 'pm' && hour < 12) hour += 12;
      if (hour != null && r.meridiem === 'am' && hour === 12) hour = 0;
      const {startMs, endMs} = computeEventTimes({hour, minute, tomorrow: r.tomorrow === true});
      return {tool: 'create_event', title: s(r.title), location: s(r.location) || undefined, startMs, endMs, human: fmtWhen(new Date(startMs))};
    }
    case 'news':
      return {tool: 'news'};
    case 'calculate':
      return s(r.expression) ? {tool: 'calculate', expression: s(r.expression)} : null;
    case 'weather':
      return {tool: 'weather', city: s(r.city) || undefined};
    case 'get_battery':
      return {tool: 'get_battery'};
    case 'set_volume': {
      const stream = ['music', 'alarm', 'ring', 'call'].includes(r.stream) ? r.stream : 'music';
      if (r.direction === 'up' || r.direction === 'down') return {tool: 'set_volume', stream, direction: r.direction};
      const p = Number(r.percent);
      return isFinite(p) ? {tool: 'set_volume', stream, percent: Math.max(0, Math.min(100, Math.round(p)))} : null;
    }
    case 'media_control': {
      const a = ['play', 'pause', 'next', 'previous', 'playpause'].includes(r.action) ? r.action : 'playpause';
      return {tool: 'media_control', action: a};
    }
    case 'web_search':
      return s(r.query) ? {tool: 'web_search', query: s(r.query)} : null;
    case 'dial_phone': {
      const n = s(r.number).replace(/[^\d+]/g, '');
      return n ? {tool: 'dial_phone', number: n} : null;
    }
    case 'compose_sms':
      return {tool: 'compose_sms', number: s(r.number).replace(/[^\d+]/g, ''), body: s(r.body)};
    case 'show_timers':
      return {tool: 'show_timers'};
    case 'show_alarms':
      return {tool: 'show_alarms'};
    case 'dismiss_alarm':
      return {tool: 'dismiss_alarm'};
    case 'set_brightness': {
      const p = Number(r.percent);
      return isFinite(p) ? {tool: 'set_brightness', percent: Math.max(1, Math.min(100, Math.round(p)))} : null;
    }
    case 'set_screen_timeout': {
      const sec = Number(r.seconds);
      return isFinite(sec) && sec > 0 ? {tool: 'set_screen_timeout', seconds: Math.round(sec)} : null;
    }
    case 'set_text_size': {
      const sc = Number(r.scale);
      return isFinite(sc) && sc > 0 ? {tool: 'set_text_size', scale: Math.max(0.7, Math.min(1.4, sc))} : null;
    }
    case 'toggle_24hour':
      return {tool: 'toggle_24hour', on: r.on !== false};
    case 'toggle_adaptive_brightness':
      return {tool: 'toggle_adaptive_brightness', on: r.on !== false};
    case 'set_ringer_mode':
      return {tool: 'set_ringer_mode', mode: ['normal', 'vibrate', 'silent'].includes(r.mode) ? r.mode : 'normal'};
    case 'do_not_disturb':
      return {tool: 'do_not_disturb', on: r.on !== false};
    case 'check_connectivity': return {tool: 'check_connectivity'};
    case 'compass_heading': return {tool: 'compass_heading'};
    case 'get_volume': return {tool: 'get_volume', stream: ['music', 'alarm', 'ring', 'call'].includes(r.stream) ? r.stream : 'music'};
    case 'vibrate_watch': return {tool: 'vibrate_watch', pattern: ['single', 'double', 'sos'].includes(r.pattern) ? r.pattern : 'single'};
    case 'free_storage': return {tool: 'free_storage'};
    case 'battery_health': return {tool: 'battery_health'};
    case 'get_ringer_mode': return {tool: 'get_ringer_mode'};
    case 'wifi_signal': return {tool: 'wifi_signal'};
    case 'ambient_light': return {tool: 'ambient_light'};
    case 'spirit_level': return {tool: 'spirit_level'};
    case 'copy_to_clipboard': return s(r.text) ? {tool: 'copy_to_clipboard', text: s(r.text)} : null;
    case 'bluetooth_status': return {tool: 'bluetooth_status'};
    case 'heart_rate': return {tool: 'heart_rate'};
    case 'step_count': return {tool: 'step_count'};
    case 'where_am_i': return {tool: 'where_am_i'};
    case 'post_reminder': return s(r.text) ? {tool: 'post_reminder', title: s(r.title) || undefined, text: s(r.text)} : null;
    case 'convert_units': {
      const v = Number(r.value);
      return isFinite(v) && s(r.from) && s(r.to) ? {tool: 'convert_units', value: v, from: s(r.from), to: s(r.to)} : null;
    }
    case 'convert_currency': {
      const a = Number(r.amount);
      return isFinite(a) && s(r.from) && s(r.to) ? {tool: 'convert_currency', amount: a, from: s(r.from), to: s(r.to)} : null;
    }
    case 'sun_times': return {tool: 'sun_times', city: s(r.city) || undefined};
    case 'define_word': return s(r.word) ? {tool: 'define_word', word: s(r.word)} : null;
    case 'days_until': return s(r.date) ? {tool: 'days_until', date: s(r.date)} : null;
    case 'crypto_price': return s(r.coin) ? {tool: 'crypto_price', coin: s(r.coin)} : null;
    case 'random_pick':
      return {
        tool: 'random_pick',
        kind: ['coin', 'dice', 'number', 'list'].includes(r.kind) ? r.kind : 'coin',
        min: isFinite(Number(r.min)) ? Number(r.min) : undefined,
        max: isFinite(Number(r.max)) ? Number(r.max) : undefined,
        options: Array.isArray(r.options) ? r.options.map(String) : undefined,
      };
    case 'moon_phase': return {tool: 'moon_phase'};
    case 'world_time': return s(r.city) ? {tool: 'world_time', city: s(r.city)} : null;
    case 'note_add': return s(r.text) ? {tool: 'note_add', text: s(r.text)} : null;
    case 'note_list': return {tool: 'note_list'};
    case 'todo_add': return s(r.text) ? {tool: 'todo_add', text: s(r.text)} : null;
    case 'todo_list': return {tool: 'todo_list'};
    case 'todo_done': return s(r.which) ? {tool: 'todo_done', which: s(r.which)} : null;
    case 'count_photos': return {tool: 'count_photos'};
    case 'count_songs': return {tool: 'count_songs'};
    case 'count_videos': return {tool: 'count_videos'};
    case 'check_phone_connection': return {tool: 'check_phone_connection'};
    case 'now_playing': return {tool: 'now_playing'};
    case 'translate': return s(r.text) && s(r.lang) ? {tool: 'translate', text: s(r.text), lang: s(r.lang)} : null;
    case 'tip': {
      const a = Number(r.amount);
      return isFinite(a) ? {tool: 'tip', amount: a, percent: isFinite(Number(r.percent)) ? Number(r.percent) : undefined} : null;
    }
    case 'start_exercise': return {tool: 'start_exercise', kind: s(r.kind) || 'walk'};
    case 'stop_exercise': return {tool: 'stop_exercise'};
    case 'get_daily_activity': return {tool: 'get_daily_activity'};
    case 'get_timezone': return {tool: 'get_timezone'};
    case 'show_compass': return {tool: 'show_compass'};
    case 'dictionary': return s(r.word) ? {tool: 'dictionary', word: s(r.word)} : null;
    case 'thesaurus': return s(r.word) ? {tool: 'thesaurus', word: s(r.word)} : null;
    case 'rhymes': return s(r.word) ? {tool: 'rhymes', word: s(r.word)} : null;
    case 'play_song': return s(r.query) ? {tool: 'play_song', query: s(r.query)} : null;
    case 'nearby': return s(r.query) ? {tool: 'nearby', query: s(r.query)} : null;
    case 'save_location': return {tool: 'save_location'};
    case 'saved_locations': return {tool: 'saved_locations'};
    case 'open_url': return s(r.url) ? {tool: 'open_url', url: s(r.url)} : null;
    default:
      return null;
  }
}

export function classifyToolLLM(
  text: string,
  base: string,
  registerXhr: (xhr: XMLHttpRequest) => void,
): Promise<ToolCall | null> {
  const attempt = (withSchema: boolean) =>
    new Promise<ToolCall | null>((resolve) => {
      const body: any = {
        messages: [
          {role: 'system', content: CLASSIFY_SYSTEM},
          {role: 'user', content: text},
        ],
        temperature: 0,
        max_tokens: 90,
        stream: false,
        cache_prompt: true,
        response_format: withSchema ? {type: 'json_object', schema: TOOL_SCHEMA} : {type: 'json_object'},
      };
      const xhr = new XMLHttpRequest();
      registerXhr(xhr);
      xhr.open('POST', `${base}/v1/chat/completions`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          resolve(withSchema ? attempt(false) : (null as any));
          return;
        }
        try {
          const j = JSON.parse(xhr.responseText);
          const content: string = j.choices?.[0]?.message?.content ?? '';
          const match = content.match(/\{[\s\S]*\}/);
          resolve(normalizeRaw(JSON.parse(match ? match[0] : content)));
        } catch {
          resolve(null);
        }
      };
      xhr.onerror = () => resolve(null);
      xhr.onabort = () => resolve(null);
      xhr.send(JSON.stringify(body));
    });
  return attempt(true);
}

// ---------------------------------------------------------------------------
// Wikipedia (plain HTTPS, gives the assistant real knowledge beyond the tiny LLM)
// ---------------------------------------------------------------------------
function firstSentences(txt: string, n: number): string {
  const parts = txt.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  return parts.slice(0, n).join(' ').trim();
}

async function searchWikipedia(query: string): Promise<string> {
  try {
    const s = await apiFetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=${encodeURIComponent(query)}`,
    );
    const sj = await s.json();
    const title = sj?.query?.search?.[0]?.title;
    if (!title) return `I couldn't find a Wikipedia article about ${query}.`;
    const r = await apiFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    const j = await r.json();
    const extract: string = j?.extract || '';
    if (!extract) return `I found ${title} but couldn't read a summary.`;
    return firstSentences(extract, 2);
  } catch {
    return `I couldn't reach Wikipedia.`;
  }
}

async function grant(perm: any): Promise<boolean> {
  try {
    return (await PermissionsAndroid.request(perm)) === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unit conversion (offline)
// ---------------------------------------------------------------------------
const U: Record<string, [string, number]> = {};
function addU(dim: string, factor: number, ...names: string[]) {
  for (const n of names) U[n] = [dim, factor];
}
addU('len', 1, 'm', 'meter', 'meters', 'metre', 'metres');
addU('len', 1000, 'km', 'kilometer', 'kilometers', 'kilometre');
addU('len', 0.01, 'cm', 'centimeter', 'centimeters');
addU('len', 0.001, 'mm', 'millimeter', 'millimeters');
addU('len', 1609.344, 'mi', 'mile', 'miles');
addU('len', 0.9144, 'yd', 'yard', 'yards');
addU('len', 0.3048, 'ft', 'foot', 'feet');
addU('len', 0.0254, 'in', 'inch', 'inches');
addU('wt', 1, 'g', 'gram', 'grams');
addU('wt', 1000, 'kg', 'kilogram', 'kilograms', 'kilo', 'kilos');
addU('wt', 0.001, 'mg', 'milligram', 'milligrams');
addU('wt', 453.592, 'lb', 'lbs', 'pound', 'pounds');
addU('wt', 28.3495, 'oz', 'ounce', 'ounces');
addU('wt', 6350.29, 'stone', 'stones', 'st');
addU('vol', 1, 'l', 'liter', 'liters', 'litre', 'litres');
addU('vol', 0.001, 'ml', 'milliliter', 'milliliters');
addU('vol', 3.78541, 'gal', 'gallon', 'gallons');
addU('vol', 0.236588, 'cup', 'cups');
addU('vol', 0.473176, 'pt', 'pint', 'pints');
addU('vol', 0.946353, 'qt', 'quart', 'quarts');
addU('spd', 1, 'ms', 'mps');
addU('spd', 0.277778, 'kph', 'kmh');
addU('spd', 0.44704, 'mph');
addU('spd', 0.514444, 'knot', 'knots', 'kt');
addU('area', 1, 'sqm', 'm2');
addU('area', 0.092903, 'sqft', 'ft2');
addU('area', 4046.86, 'acre', 'acres');
addU('area', 10000, 'hectare', 'hectares', 'ha');
addU('data', 1, 'b', 'byte', 'bytes');
addU('data', 1024, 'kb', 'kilobyte', 'kilobytes');
addU('data', 1048576, 'mb', 'megabyte', 'megabytes');
addU('data', 1073741824, 'gb', 'gigabyte', 'gigabytes');
addU('data', 1099511627776, 'tb', 'terabyte', 'terabytes');

function convertUnits(value: number, from: string, to: string): string {
  const k = (s: string) => s.toLowerCase().replace(/[\s.°]/g, '');
  const f0 = k(from);
  const t0 = k(to);
  const isT = (x: string) => /^(c|celsius|f|fahrenheit|k|kelvin)$/.test(x);
  if (isT(f0) || isT(t0)) {
    let c: number;
    if (f0[0] === 'c') c = value;
    else if (f0[0] === 'f') c = ((value - 32) * 5) / 9;
    else c = value - 273.15;
    let o: number;
    if (t0[0] === 'c') o = c;
    else if (t0[0] === 'f') o = (c * 9) / 5 + 32;
    else o = c + 273.15;
    return `${value}° ${from} is ${Math.round(o * 10) / 10}° ${to}.`;
  }
  const a = U[f0] || U[f0.replace(/s$/, '')];
  const b = U[t0] || U[t0.replace(/s$/, '')];
  if (!a || !b || a[0] !== b[0]) return `I can't convert ${from} to ${to}.`;
  return `${value} ${from} is ${Math.round((value * a[1]) / b[1] * 10000) / 10000} ${to}.`;
}

function curCode(w: string): string {
  const m: Record<string, string> = {
    dollar: 'USD', dollars: 'USD', buck: 'USD', bucks: 'USD', euro: 'EUR', euros: 'EUR',
    pound: 'GBP', pounds: 'GBP', quid: 'GBP', yen: 'JPY', rupee: 'INR', rupees: 'INR',
    yuan: 'CNY', franc: 'CHF', francs: 'CHF',
  };
  const k = w.toLowerCase();
  return m[k] || m[k.replace(/s$/, '')] || w.toUpperCase();
}

async function convertCurrency(amount: number, from: string, to: string): Promise<string> {
  const F = from.toUpperCase();
  const T = to.toUpperCase();
  try {
    const r = await apiFetch(`https://api.frankfurter.dev/v1/latest?amount=${amount}&base=${F}&symbols=${T}`);
    const v = (await r.json())?.rates?.[T];
    if (v == null) return `I couldn't convert ${F} to ${T}.`;
    return `${amount} ${F} is ${Math.round(v * 100) / 100} ${T}.`;
  } catch {
    return `I couldn't reach the currency service.`;
  }
}

function fmtHM(hhmm: string): string {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return fmt12h(h, m || 0);
}

async function sunTimes(city?: string): Promise<string> {
  try {
    let lat: number;
    let lon: number;
    let place: string;
    if (city) {
      const hit = (await (await apiFetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)).json())?.results?.[0];
      if (!hit) return `I couldn't find ${city}.`;
      lat = hit.latitude; lon = hit.longitude; place = hit.name;
    } else {
      if (!(await grant(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION))) return 'Tell me a city, like "sunset in Paris".';
      try { const p = String(await Tools.getLastLocation()).split(','); lat = +p[0]; lon = +p[1]; place = 'your area'; }
      catch { return "I couldn't get your location. Try naming a city."; }
    }
    const d = (await (await apiFetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=auto`)).json())?.daily;
    if (!d) return "I couldn't get sun times.";
    return `In ${place}, sunrise is ${fmtHM(d.sunrise[0].split('T')[1])} and sunset is ${fmtHM(d.sunset[0].split('T')[1])}.`;
  } catch {
    return "I couldn't reach the sun-times service.";
  }
}

async function defineWord(word: string): Promise<string> {
  try {
    const r = await apiFetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!r.ok) return `I couldn't find "${word}" in the dictionary.`;
    const m = (await r.json())?.[0]?.meanings?.[0];
    const def = m?.definitions?.[0];
    if (!def?.definition) return `I couldn't find "${word}" in the dictionary.`;
    let out = word;
    if (m.partOfSpeech) out += ` (${m.partOfSpeech})`;
    out += `: ${def.definition}`;
    if (def.example) out += ` For example: ${def.example}`;
    return out;
  } catch {
    return `I couldn't reach the dictionary.`;
  }
}

const HOLIDAYS: Record<string, [number, number]> = {
  christmas: [11, 25], 'new year': [0, 1], "new year's": [0, 1], halloween: [9, 31],
  valentines: [1, 14], "valentine's": [1, 14], "new years": [0, 1],
};
function daysUntil(input: string): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const q = input.trim().toLowerCase();
  let target: Date | null = null;
  if (q in HOLIDAYS) {
    const [mo, d] = HOLIDAYS[q];
    target = new Date(now.getFullYear(), mo, d);
    if (target.getTime() < now.getTime()) target = new Date(now.getFullYear() + 1, mo, d);
  } else {
    const p = Date.parse(input);
    if (!isNaN(p)) { target = new Date(p); target.setHours(0, 0, 0, 0); }
  }
  if (!target) return `I couldn't understand the date "${input}".`;
  const days = Math.round((target.getTime() - now.getTime()) / 86_400_000);
  if (days === 0) return `${input} is today.`;
  if (days < 0) return `${input} was ${-days} day${-days > 1 ? 's' : ''} ago.`;
  return `${days} day${days > 1 ? 's' : ''} until ${input}.`;
}

const COIN_ID: Record<string, string> = {
  btc: 'bitcoin', bitcoin: 'bitcoin', eth: 'ethereum', ethereum: 'ethereum', doge: 'dogecoin',
  dogecoin: 'dogecoin', sol: 'solana', solana: 'solana', ada: 'cardano', cardano: 'cardano',
  xrp: 'ripple', ripple: 'ripple', ltc: 'litecoin', litecoin: 'litecoin', bnb: 'binancecoin',
};
async function cryptoPrice(coin: string): Promise<string> {
  const id = COIN_ID[coin.toLowerCase()] || coin.toLowerCase();
  try {
    const p = (await (await apiFetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`)).json())?.[id]?.usd;
    if (p == null) return `I couldn't get a price for ${coin}.`;
    return `${coin} is $${p}.`;
  } catch {
    return `I couldn't reach the price service.`;
  }
}

function randomPick(c: {kind: string; min?: number; max?: number; options?: string[]}): string {
  switch (c.kind) {
    case 'coin':
      return Math.random() < 0.5 ? 'Heads.' : 'Tails.';
    case 'dice':
      return `You rolled a ${1 + Math.floor(Math.random() * 6)}.`;
    case 'number': {
      const lo = c.min ?? 1;
      const hi = c.max ?? 100;
      return `${lo + Math.floor(Math.random() * (hi - lo + 1))}.`;
    }
    case 'list': {
      const o = c.options || [];
      return o.length ? `${o[Math.floor(Math.random() * o.length)]}.` : 'Give me some options to pick from.';
    }
    default:
      return Math.random() < 0.5 ? 'Heads.' : 'Tails.';
  }
}

function moonPhase(): string {
  const names = ['a new moon', 'a waxing crescent', 'a first-quarter moon', 'a waxing gibbous',
    'a full moon', 'a waning gibbous', 'a last-quarter moon', 'a waning crescent'];
  const synodic = 2551442.8;
  const knownNew = 947182440; // 2000-01-06 18:14 UTC, seconds
  const phase = (((Date.now() / 1000 - knownNew) % synodic) + synodic) % synodic / synodic;
  const illum = Math.round(((1 - Math.cos(phase * 2 * Math.PI)) / 2) * 100);
  return `The moon is ${names[Math.round(phase * 8) % 8]}, about ${illum}% illuminated.`;
}

async function worldTimeFor(city: string): Promise<string> {
  try {
    const hit = (await (await apiFetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)).json())?.results?.[0];
    if (!hit) return `I couldn't find ${city}.`;
    return `In ${hit.name}, it's ${await Tools.worldTime(hit.timezone)}.`;
  } catch {
    return `I couldn't get the time for ${city}.`;
  }
}

const LANG: Record<string, string> = {
  spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', japanese: 'ja',
  chinese: 'zh', mandarin: 'zh', korean: 'ko', russian: 'ru', arabic: 'ar', hindi: 'hi',
  dutch: 'nl', polish: 'pl', turkish: 'tr', swedish: 'sv', greek: 'el', hebrew: 'he',
  thai: 'th', vietnamese: 'vi', english: 'en',
};
async function translateText(text: string, lang: string): Promise<string> {
  const code = LANG[lang.toLowerCase()] || lang.toLowerCase().slice(0, 2);
  try {
    const tr = (await (await apiFetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${code}`)).json())?.responseData?.translatedText;
    return tr ? `In ${lang}: ${tr}` : `I couldn't translate that.`;
  } catch {
    return "I couldn't reach the translation service.";
  }
}

function tipCalc(amount: number, percent = 18): string {
  const tip = (amount * percent) / 100;
  return `A ${percent}% tip on $${amount} is $${Math.round(tip * 100) / 100}, for a total of $${Math.round((amount + tip) * 100) / 100}.`;
}

async function thesaurus(word: string): Promise<string> {
  try {
    const arr = await (await apiFetch(`https://api.datamuse.com/words?max=6&rel_syn=${encodeURIComponent(word)}`)).json();
    const syns = (Array.isArray(arr) ? arr : []).map((x: any) => x.word).slice(0, 6);
    return syns.length ? `Synonyms for ${word}: ${syns.join(', ')}.` : `I couldn't find synonyms for ${word}.`;
  } catch {
    return "I couldn't reach the thesaurus.";
  }
}

// Fetch a Creative-Commons image (Openverse, the search.creativecommons.org backend).
export async function fetchPicture(
  query: string,
): Promise<{url: string; title: string; creator: string; license: string} | null> {
  try {
    const j = await (await apiFetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=1&mature=false`)).json();
    const r = j?.results?.[0];
    if (!r?.url) return null;
    return {
      url: r.url,
      title: r.title || query,
      creator: r.creator || 'Unknown',
      license: `CC ${(r.license || '').toUpperCase()} ${r.license_version || ''}`.trim(),
    };
  } catch {
    return null;
  }
}

// In-app reader browser: fetch a page through r.jina.ai (returns clean, small markdown —
// KBs, not the ~1 MB of raw HTML — and renders JS pages server-side) and parse title/text/links.
export type Page = {url: string; title: string; text: string; links: {text: string; href: string}[]};
export async function fetchPage(url: string): Promise<Page | null> {
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const txt = await (await apiFetch(`https://r.jina.ai/${u}`)).text();
    const title = (/^Title:\s*(.+)$/m.exec(txt)?.[1] || u).trim();
    const idx = txt.indexOf('Markdown Content:');
    // Strip images up front so they aren't captured as links.
    const body = (idx >= 0 ? txt.slice(idx + 'Markdown Content:'.length) : txt).replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    const links: {text: string; href: string}[] = [];
    body.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m: string, text: string, href: string) => {
      const t = text.trim();
      if (links.length < 25 && t && !/^image\b/i.test(t) && t.length > 1) {
        const dd = /[?&]uddg=([^&]+)/.exec(href); // decode DuckDuckGo redirect → real URL
        links.push({text: t.slice(0, 80), href: dd ? decodeURIComponent(dd[1]) : href});
      }
      return m;
    });
    const text = body
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // links -> their text
      .replace(/^\s*\|.*\|\s*$/gm, '')             // table rows
      .replace(/^\s*[-|:=\s]{3,}\s*$/gm, '')       // table separators / rules
      .replace(/[*_`>#]/g, '')                     // markdown emphasis/heading marks
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4000);
    return {url: u, title, text, links};
  } catch {
    return null;
  }
}

async function rhymes(word: string): Promise<string> {
  try {
    const arr = await (await apiFetch(`https://api.datamuse.com/words?max=8&rel_rhy=${encodeURIComponent(word)}`)).json();
    const r = (Array.isArray(arr) ? arr : []).map((x: any) => x.word).slice(0, 8);
    return r.length ? `Words that rhyme with ${word}: ${r.join(', ')}.` : `I couldn't find rhymes for ${word}.`;
  } catch {
    return "I couldn't reach the rhyme service.";
  }
}

// Formatters for native piped results
function cardinal(deg: number): string {
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8];
}
function lightDesc(lux: number): string {
  return lux < 10 ? 'very dark' : lux < 50 ? 'dim' : lux < 300 ? 'indoor light' : lux < 1000 ? 'bright indoors' : lux < 10000 ? 'overcast daylight' : 'bright sunlight';
}

// ---------------------------------------------------------------------------
// News (Google News RSS)
// ---------------------------------------------------------------------------
function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .trim();
}

async function getNews(): Promise<string> {
  try {
    const r = await apiFetch('https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en');
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)]
      .map((m) => decodeXml(m[1]).replace(/\s+-\s+[^-]+$/, '')) // drop the " - Source" suffix
      .filter(Boolean)
      .slice(0, 4);
    if (!items.length) return "I couldn't get the news right now.";
    return `Top headlines: ${items.join('. ')}.`;
  } catch {
    return "I couldn't reach the news.";
  }
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo — no API key)
// ---------------------------------------------------------------------------
const WMO: Record<number, string> = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'heavy rain showers', 85: 'snow showers', 86: 'snow showers',
  95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};

async function getWeather(city?: string): Promise<string> {
  try {
    let lat: number;
    let lon: number;
    let place: string;
    if (city) {
      const g = await apiFetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
      const hit = (await g.json())?.results?.[0];
      if (!hit) return `I couldn't find ${city}.`;
      lat = hit.latitude;
      lon = hit.longitude;
      place = hit.name;
    } else {
      if (!(await grant(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION))) {
        return 'I need location permission — or tell me a city, like "weather in London".';
      }
      try {
        const parts = String(await Tools.getLastLocation()).split(',');
        lat = Number(parts[0]);
        lon = Number(parts[1]);
        place = 'your area';
      } catch {
        return "I couldn't get your location. Try \"weather in <city>\".";
      }
    }
    const w = await apiFetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`,
    );
    const c = (await w.json())?.current;
    if (!c) return "I couldn't get the weather.";
    const desc = WMO[c.weather_code] ?? 'unclear skies';
    const t = Math.round(c.temperature_2m);
    try { Tools.cachePut('weather', `${t}°`); } catch {} // for the weather complication
    return `It's ${t}°F and ${desc} in ${place}.`;
  } catch {
    return "I couldn't reach the weather service.";
  }
}

// ---------------------------------------------------------------------------
// Calculator (safe recursive-descent evaluator — no eval)
// ---------------------------------------------------------------------------
function toExpression(rawText: string): string {
  let s = ` ${rawText.toLowerCase()} `;
  s = s.replace(/what(?:'s| is)|calculate|compute|how much is|equals?|the answer to|please|\?/g, ' ');
  s = s.replace(/(?:square root of|sqrt of|sqrt|√)\s*(\d+\.?\d*)/g, '($1 ^ 0.5)');
  s = s
    .replace(/\bplus\b/g, '+')
    .replace(/\b(?:minus|less)\b/g, '-')
    .replace(/\b(?:times|multiplied by)\b/g, '*')
    .replace(/\bx\b/g, '*')
    .replace(/\b(?:divided by|over)\b/g, '/')
    .replace(/\b(?:to the power of|power of)\b/g, '^')
    .replace(/\bpercent of\b|%\s*of\b/g, '* 0.01 *')
    .replace(/\bpercent\b|%/g, '* 0.01')
    .replace(/\bof\b/g, '*')
    .replace(/[^0-9+\-*/^(). ]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function evalMath(expr: string): number | null {
  const tokens = expr.match(/(\d+\.?\d*|\.\d+|[+\-*/^()])/g);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const eat = () => tokens[i++];
  const parseExpr = (): number => {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = eat();
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = (): number => {
    let v = parsePow();
    while (peek() === '*' || peek() === '/') {
      const op = eat();
      const r = parsePow();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parsePow = (): number => {
    const v = parseUnary();
    if (peek() === '^') {
      eat();
      return Math.pow(v, parsePow());
    }
    return v;
  };
  const parseUnary = (): number => {
    if (peek() === '-') {
      eat();
      return -parseUnary();
    }
    if (peek() === '+') {
      eat();
      return parseUnary();
    }
    return parseAtom();
  };
  const parseAtom = (): number => {
    if (peek() === '(') {
      eat();
      const v = parseExpr();
      if (peek() === ')') eat();
      return v;
    }
    return parseFloat(eat());
  };
  try {
    const v = parseExpr();
    return i === tokens.length && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Execution — perform the action, return a short spoken confirmation
// ---------------------------------------------------------------------------
export async function executeTool(call: ToolCall): Promise<string> {
  switch (call.tool) {
    case 'set_timer':
      try {
        await Tools.setTimer(call.seconds, call.label ?? '');
        return `Timer set for ${call.human}.`;
      } catch {
        return `I couldn't start a ${call.human} timer.`;
      }
    case 'set_alarm':
      try {
        await Tools.setAlarm(call.hour24, call.minute, call.label ?? '');
        return `Alarm set for ${call.human}.`;
      } catch {
        return `I couldn't set an alarm for ${call.human}.`;
      }
    case 'open_app':
      try {
        return `Opening ${await Tools.openApp(call.app)}.`;
      } catch {
        return `I couldn't find an app called ${call.app}.`;
      }
    case 'get_time':
      return `It's ${fmt12h(new Date().getHours(), new Date().getMinutes())}.`;
    case 'get_date': {
      const d = new Date();
      return `Today is ${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}.`;
    }
    case 'flashlight':
      try {
        await Tools.flashlight(call.on);
        return call.on ? 'Turning the flashlight on.' : 'Opening the flashlight.';
      } catch {
        return `I couldn't open the flashlight.`;
      }
    case 'show_on_map':
      try {
        await Tools.showOnMap(call.query);
        return `Showing ${call.query} on the map.`;
      } catch {
        return `I couldn't open the map.`;
      }
    case 'search_wikipedia':
      return searchWikipedia(call.query);
    case 'read_contacts':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.READ_CONTACTS))) {
        return 'I need permission to read your contacts.';
      }
      try {
        return await Tools.readContacts(call.query);
      } catch {
        return call.query ? `I couldn't find ${call.query} in your contacts.` : `I couldn't read your contacts.`;
      }
    case 'create_contact':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.WRITE_CONTACTS))) {
        return 'I need permission to add contacts.';
      }
      try {
        await Tools.createContact(call.name, call.phone ?? '', call.email ?? '');
        return `Added ${call.name} to your contacts.`;
      } catch {
        return `I couldn't add ${call.name}.`;
      }
    case 'compose_email':
      try {
        await Tools.composeEmail(call.to ?? '', call.subject ?? '', call.body ?? '');
        return call.to ? `Composing an email to ${call.to}.` : 'Composing an email.';
      } catch {
        return `I couldn't open the email composer.`;
      }
    case 'read_calendar':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.READ_CALENDAR))) {
        return 'I need permission to read your calendar.';
      }
      try {
        const events = await Tools.readCalendar(call.days);
        return events ? `Coming up: ${events}.` : 'You have nothing scheduled.';
      } catch {
        return `I couldn't read your calendar.`;
      }
    case 'create_event':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.WRITE_CALENDAR))) {
        return 'I need permission to add calendar events.';
      }
      try {
        await Tools.createEvent(call.title, call.location ?? '', call.startMs, call.endMs);
        return `Added "${call.title}" to your calendar for ${call.human}.`;
      } catch {
        return `I couldn't add that event.`;
      }
    case 'news':
      return getNews();
    case 'weather':
      return getWeather(call.city);
    case 'calculate': {
      const v = evalMath(toExpression(call.expression));
      if (v == null) return `I couldn't work that out.`;
      return `That's ${Math.round(v * 1e6) / 1e6}.`;
    }
    case 'get_battery':
      try {
        const [lvl, chg] = String(await Tools.getBatteryLevel()).split(',');
        return `Battery is at ${lvl} percent${chg === 'true' ? ' and charging' : ''}.`;
      } catch {
        return `I couldn't read the battery level.`;
      }
    case 'set_volume':
      try {
        if (call.direction) {
          await Tools.adjustVolume(call.stream, call.direction === 'up');
          return call.direction === 'up' ? 'Turning it up.' : 'Turning it down.';
        }
        await Tools.setVolume(call.stream, call.percent ?? 50);
        return `${call.stream === 'music' ? 'Volume' : `${call.stream} volume`} set to ${call.percent}%.`;
      } catch {
        return `I couldn't change the volume.`;
      }
    case 'media_control':
      try {
        await Tools.mediaControl(call.action);
        return call.action === 'next' ? 'Skipping ahead.' : call.action === 'previous' ? 'Going back.' : call.action === 'pause' ? 'Paused.' : 'Playing.';
      } catch {
        return `I couldn't control playback.`;
      }
    case 'web_search':
      try {
        const r = await Tools.webSearch(call.query);
        return r === 'phone' ? `Searching the web for ${call.query} on your phone.`
          : r === 'browser' ? `Opening your browser to search for ${call.query}.`
          : `Searching for ${call.query}.`;
      } catch (e: any) {
        if (e?.code === 'no_browser' || e?.code === 'no_app') {
          // No browser on watch or phone — answer from Wikipedia instead.
          return searchWikipedia(call.query);
        }
        return `I couldn't start a web search.`;
      }
    case 'dial_phone':
      try {
        await Tools.dialPhone(call.number);
        return `Calling ${call.number}.`;
      } catch {
        return `I couldn't open the dialer.`;
      }
    case 'compose_sms':
      try {
        await Tools.composeSms(call.number ?? '', call.body ?? '');
        return call.number ? `Texting ${call.number}.` : 'Opening a new text.';
      } catch {
        return `I couldn't open messages.`;
      }
    case 'show_timers':
      try {
        await Tools.showTimers();
        return 'Here are your timers.';
      } catch {
        return `I couldn't open your timers.`;
      }
    case 'show_alarms':
      try {
        await Tools.showAlarms();
        return 'Here are your alarms.';
      } catch {
        return `I couldn't open your alarms.`;
      }
    case 'dismiss_alarm':
      try {
        await Tools.dismissAlarm();
        return 'Dismissing the alarm.';
      } catch {
        return `I couldn't dismiss the alarm.`;
      }
    case 'set_brightness':
      try {
        await Tools.setBrightness(call.percent);
        return `Brightness set to ${call.percent}%.`;
      } catch (e: any) {
        return e?.code === 'needs_write_settings' ? `First allow WearLLM to modify system settings, then try again.` : `I couldn't change the brightness.`;
      }
    case 'set_screen_timeout':
      try {
        await Tools.setScreenTimeout(call.seconds);
        return `Screen will stay on for ${call.seconds} seconds.`;
      } catch (e: any) {
        return e?.code === 'needs_write_settings' ? `First allow WearLLM to modify system settings, then try again.` : `I couldn't change the screen timeout.`;
      }
    case 'set_text_size':
      try {
        await Tools.setTextSize(call.scale);
        return `Text size updated.`;
      } catch (e: any) {
        return e?.code === 'needs_write_settings' ? `First allow WearLLM to modify system settings, then try again.` : `I couldn't change the text size.`;
      }
    case 'toggle_24hour':
      try {
        await Tools.set24Hour(call.on);
        return call.on ? 'Switched to 24-hour time.' : 'Switched to 12-hour time.';
      } catch (e: any) {
        return e?.code === 'needs_write_settings' ? `First allow WearLLM to modify system settings, then try again.` : `I couldn't change the clock format.`;
      }
    case 'toggle_adaptive_brightness':
      try {
        await Tools.setAdaptiveBrightness(call.on);
        return call.on ? 'Adaptive brightness on.' : 'Adaptive brightness off.';
      } catch (e: any) {
        return e?.code === 'needs_write_settings' ? `First allow WearLLM to modify system settings, then try again.` : `I couldn't change adaptive brightness.`;
      }
    case 'set_ringer_mode':
      try {
        await Tools.setRingerMode(call.mode);
        return `Ringer set to ${call.mode}.`;
      } catch (e: any) {
        return e?.code === 'no_policy' ? `This watch doesn't let apps switch to silent or vibrate.`
          : e?.code === 'needs_policy' ? `First grant Do Not Disturb access, then try again.`
          : `I couldn't change the ringer.`;
      }
    case 'do_not_disturb':
      try {
        await Tools.doNotDisturb(call.on);
        return call.on ? 'Do Not Disturb on.' : 'Do Not Disturb off.';
      } catch (e: any) {
        return e?.code === 'no_policy' ? `This watch doesn't let apps control Do Not Disturb.`
          : e?.code === 'needs_policy' ? `First grant Do Not Disturb access, then try again.`
          : `I couldn't change Do Not Disturb.`;
      }
    case 'check_connectivity':
      try {
        const [on, tr, me] = String(await Tools.checkConnectivity()).split('|');
        return on === 'true' ? `You're online over ${tr}${me === 'true' ? ' (metered)' : ''}.` : `You appear to be offline.`;
      } catch { return "I couldn't check the connection."; }
    case 'compass_heading':
      try { const d = parseInt(await Tools.compassHeading(), 10); return `You're facing ${cardinal(d)}, ${d}°.`; } catch { return "I couldn't get a compass heading."; }
    case 'get_volume':
      try { return `${call.stream === 'music' ? 'Media' : call.stream} volume is at ${await Tools.getVolume(call.stream)}%.`; } catch { return "I couldn't read the volume."; }
    case 'vibrate_watch':
      try { await Tools.vibrateWatch(call.pattern); return 'Buzzing your watch.'; } catch { return "I couldn't vibrate."; }
    case 'free_storage':
      try { const [f, t] = String(await Tools.freeStorage()).split('|'); return `${f} MB free of ${t} MB.`; } catch { return "I couldn't read storage."; }
    case 'battery_health':
      try { return await Tools.batteryHealth(); } catch { return "I couldn't read battery details."; }
    case 'get_ringer_mode':
      try { return `The ringer is set to ${await Tools.getRingerMode()}.`; } catch { return "I couldn't read the ringer mode."; }
    case 'wifi_signal':
      try {
        const r = await Tools.wifiSignal();
        if (r === 'off') return 'Wi-Fi is off.';
        const [lvl, mx] = String(r).split('|');
        const bars = ['no', 'weak', 'fair', 'good', 'strong', 'excellent'][+lvl] || 'some';
        return `Wi-Fi signal is ${bars} (${lvl} of ${mx}).`;
      } catch { return "I couldn't read the Wi-Fi signal."; }
    case 'ambient_light':
      try { const lux = parseInt(await Tools.ambientLight(), 10); return `It's ${lightDesc(lux)}, about ${lux} lux.`; } catch { return "I couldn't read the light sensor."; }
    case 'spirit_level':
      try {
        const [p, r] = String(await Tools.spiritLevel()).split('|');
        const level = Math.abs(+p) <= 2 && Math.abs(+r) <= 2 ? ' — that\'s level' : '';
        return `Pitch ${p}°, roll ${r}°${level}.`;
      } catch { return "I couldn't read the level."; }
    case 'copy_to_clipboard':
      try { await Tools.copyToClipboard(call.text); return 'Copied to the clipboard.'; } catch { return "I couldn't copy that."; }
    case 'bluetooth_status':
      await grant(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
      try { return await Tools.bluetoothStatus(); } catch { return "I couldn't read Bluetooth."; }
    case 'heart_rate':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.BODY_SENSORS))) return 'I need permission to read your heart rate.';
      try {
        const bpm = await Tools.heartRate();
        try { Tools.cachePut('hr', String(bpm)); } catch {} // for the heart-rate complication
        return `Your heart rate is ${bpm} beats per minute.`;
      } catch { return "I couldn't get a reading — hold still and try again."; }
    case 'step_count':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION))) return 'I need permission to count your steps.';
      try { return `You've taken about ${await Tools.stepCount()} steps today.`; } catch { return "I couldn't read your step count."; }
    case 'where_am_i':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION))) return 'I need location permission to find where you are.';
      try { return `You're near ${await Tools.whereAmI()}.`; } catch { return "I couldn't get your location."; }
    case 'post_reminder':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS))) return 'I need permission to post notifications.';
      try { await Tools.postReminder(call.title ?? '', call.text); return `Reminder posted: ${call.text}.`; } catch { return "I couldn't post the reminder."; }
    case 'convert_units':
      return convertUnits(call.value, call.from, call.to);
    case 'convert_currency':
      return convertCurrency(call.amount, call.from, call.to);
    case 'sun_times':
      return sunTimes(call.city);
    case 'define_word':
      return defineWord(call.word);
    case 'days_until':
      return daysUntil(call.date);
    case 'crypto_price':
      return cryptoPrice(call.coin);
    case 'random_pick':
      return randomPick(call);
    case 'moon_phase':
      return moonPhase();
    case 'world_time':
      return worldTimeFor(call.city);
    case 'note_add':
      try { await Tools.noteAdd(call.text); return `Noted: ${call.text}.`; } catch { return "I couldn't save that note."; }
    case 'note_list':
      try { const n = await Tools.noteList(); return n ? `Your notes: ${n}.` : 'You have no notes yet.'; } catch { return "I couldn't read your notes."; }
    case 'todo_add':
      try { await Tools.todoAdd(call.text); return `Added to your to-do list: ${call.text}.`; } catch { return "I couldn't add that."; }
    case 'todo_list':
      try { const t = await Tools.todoList(); return t ? `Your to-do list: ${t}.` : 'Your to-do list is empty.'; } catch { return "I couldn't read your to-do list."; }
    case 'todo_done':
      try { return `Checked off: ${await Tools.todoDone(call.which)}.`; } catch { return `I couldn't find that on your to-do list.`; }
    case 'count_photos':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES))) return 'I need permission to see your photos.';
      try { return `You have ${await Tools.mediaCount('images')} photos on your watch.`; } catch { return "I couldn't count your photos."; }
    case 'count_songs':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO))) return 'I need permission to see your music.';
      try { return `You have ${await Tools.mediaCount('audio')} audio files on your watch.`; } catch { return "I couldn't count your music."; }
    case 'count_videos':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO))) return 'I need permission to see your videos.';
      try { return `You have ${await Tools.mediaCount('video')} videos on your watch.`; } catch { return "I couldn't count your videos."; }
    case 'check_phone_connection':
      try {
        const r = String(await Tools.phoneConnection());
        if (r === 'none') return "Your phone isn't connected right now.";
        const [name, near] = r.split('|');
        return `Connected to ${name}${near === 'true' ? ', nearby' : ' through the cloud'}.`;
      } catch { return "I couldn't check your phone connection."; }
    case 'now_playing':
      try {
        const r = String(await Tools.nowPlaying());
        if (!r) return 'Nothing is playing right now.';
        const [ti, ar] = r.split('|');
        return ar ? `Now playing: ${ti} by ${ar}.` : `Now playing: ${ti}.`;
      } catch (e: any) {
        return e?.code === 'no_access' ? `I need notification access to see what's playing, which this watch can't grant in settings.`
          : e?.code === 'needs_access' ? `Enable notification access for WearLLM, then try again.`
          : "I couldn't read what's playing.";
      }
    case 'translate':
      return translateText(call.text, call.lang);
    case 'tip':
      return tipCalc(call.amount, call.percent);
    case 'start_exercise':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.BODY_SENSORS))) return 'I need body-sensor permission to track a workout.';
      await grant(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);
      try { await Tools.startExercise(call.kind); return `Started tracking your ${call.kind}.`; }
      catch (e: any) { return e?.code === 'unsupported' ? `This watch can't track a ${call.kind} that way.` : `I couldn't start the workout.`; }
    case 'stop_exercise':
      try { return await Tools.stopExercise(); } catch { return "I couldn't stop the workout — is one running?"; }
    case 'get_daily_activity':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION))) return 'I need activity permission for that.';
      try { return await Tools.dailyActivity(); } catch { return "I couldn't read your activity."; }
    case 'get_timezone':
      try { return await Tools.timeZone(); } catch { return "I couldn't read your time zone."; }
    case 'show_compass':
      // Open a compass app if the watch has one, else speak the heading.
      try {
        return `Opening ${await Tools.openApp('compass')}.`;
      } catch {
        try {
          const d = parseInt(await Tools.compassHeading(), 10);
          return `No compass app here, but you're facing ${cardinal(d)}, ${d}°.`;
        } catch {
          return "I couldn't open a compass.";
        }
      }
    case 'dictionary':
      return defineWord(call.word);
    case 'thesaurus':
      return thesaurus(call.word);
    case 'rhymes':
      return rhymes(call.word);
    case 'play_song':
      try {
        const r = await Tools.playSong(call.query);
        return r === 'opened' ? `Opening YouTube Music — search for "${call.query}" there.` : `Playing ${call.query}.`;
      } catch (e: any) {
        return e?.code === 'no_player' ? `I don't have a music app that can play "${call.query}".` : `I couldn't play that.`;
      }
    case 'nearby':
      try {
        await Tools.showOnMap(call.query);
        return `Finding ${call.query} near you on the map.`;
      } catch {
        return "I couldn't open the map.";
      }
    case 'save_location':
      if (!(await grant(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION))) return 'I need location permission to save where you are.';
      try {
        return `Saved your location: ${await Tools.saveLocation()}.`;
      } catch {
        return "I couldn't get a location fix to save.";
      }
    case 'saved_locations':
      try {
        const l = await Tools.listSavedLocations();
        return l ? `Your recent saved locations: ${l}.` : "You haven't saved any locations yet.";
      } catch {
        return "I couldn't read your saved locations.";
      }
    case 'show_picture':
      // Normally intercepted in App.tsx to display the image; this is the spoken fallback.
      return `Say "show me a picture of ${call.query}".`;
    case 'open_url':
      try {
        const r = await Tools.openUrl(call.url);
        return r === 'phone' ? `Opening ${call.url} on your phone.` : `Opening ${call.url}.`;
      } catch {
        return `I couldn't open ${call.url} — there's no browser on the watch or phone.`;
      }
  }
}

// A tool result reads as a failure when its message opens with one of these phrases — the
// error strings executeTool returns are all phrased this way, so this reliably flags failures.
const FAIL_RE = /^(I couldn't|I can't|I need permission|This watch|First (allow|grant)|Give me|No web browser|Tell me a city|Sorry,)/i;

/**
 * The one entry point App.tsx calls. Returns {text, ok} if the utterance was a command
 * (already executed — ok=false means the tool call failed), or null for normal chat.
 */
export async function resolveCommand(
  text: string,
  base: string,
  registerXhr: (xhr: XMLHttpRequest) => void,
): Promise<{text: string; ok: boolean} | null> {
  let call = parseCommandLocally(text);
  if (!call && looksLikeCommand(text)) {
    call = await classifyToolLLM(text, base, registerXhr);
  }
  if (!call) return null;
  let out: string;
  try {
    out = await executeTool(call);
  } catch {
    out = `Sorry, that didn't work.`;
  }
  return {text: out, ok: !FAIL_RE.test(out)};
}

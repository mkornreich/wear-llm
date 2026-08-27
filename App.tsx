/**
 * WearLLMApp — a fully on-watch local LLM assistant.
 *
 *  Voice  : on-device Vosk recognition (native Vosk module) — streams live and auto-submits
 *           the moment you stop talking (silence endpointing), no button.
 *  LLM    : llama.cpp server running on the watch itself (native LlamaServer module),
 *           SmolLM2-360M-Instruct (Q4_K_M) over 127.0.0.1, streamed token-by-token.
 *  Speech : the answer is spoken aloud through the watch speaker (native Tts module).
 *  Tools  : on-device function-calling (see tools.ts) — commands like "set a timer for
 *           5 minutes", "wake me at 7am", or "open settings" are recognised and executed
 *           on the watch (native Tools module) instead of being chatted about.
 *
 * Nothing leaves the watch — no phone, no laptop, no cloud.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  Image,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, {Path, Circle, G, Text as SvgText} from 'react-native-svg';
import {resolveCommand, parseCommandLocally, fetchPicture, fetchPage} from './tools';
import type {Page} from './tools';

type Pic = {url: string; title: string; creator: string; license: string};

const {LlamaServer, Speech, Vosk, Tts, Tools} = NativeModules;

// Material Design "mic" icon (filled, 24×24) — the same glyph the system voice page uses.
const MIC_PATH =
  'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 ' +
  '2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z';

function MicIcon({size = 34, color = '#fff'}: {size?: number; color?: string}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={MIC_PATH} fill={color} />
    </Svg>
  );
}

function compassCardinal(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

// A live compass dial — the ring rotates so N points at true north; a fixed blue arrow at the
// top marks the direction the watch is facing.
function CompassDial({heading}: {heading: number}) {
  const size = 150;
  const c = size / 2;
  const r = c - 16;
  const cards: Array<[string, number]> = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={c} cy={c} r={r} stroke={C.surfaceHi} strokeWidth={2} fill="none" />
      <G rotation={-heading} origin={`${c}, ${c}`}>
        <Path d={`M ${c} ${c - r + 8} L ${c - 7} ${c} L ${c + 7} ${c} Z`} fill={C.danger} />
        <Path d={`M ${c} ${c + r - 8} L ${c - 7} ${c} L ${c + 7} ${c} Z`} fill={C.text2} />
        {cards.map(([label, deg]) => {
          const a = (deg * Math.PI) / 180;
          return (
            <SvgText
              key={label}
              x={c + (r - 12) * Math.sin(a)}
              y={c - (r - 12) * Math.cos(a) + 5}
              fill={label === 'N' ? C.danger : C.text2}
              fontSize={13}
              fontWeight="700"
              textAnchor="middle">
              {label}
            </SvgText>
          );
        })}
      </G>
      <Path d={`M ${c} 3 L ${c - 6} 14 L ${c + 6} 14 Z`} fill={C.accent} />
    </Svg>
  );
}

const PORT = 8080;
const N_THREADS = 3;
const N_CTX = 1024;
const MAX_TOKENS = 160;
const BASE = `http://127.0.0.1:${PORT}`;

const SYSTEM_PROMPT =
  'You are a concise, friendly voice assistant on a smartwatch. Answer in one or two short sentences.';

type Msg = {role: 'user' | 'assistant'; content: string; error?: boolean};
type Status = 'init' | 'starting' | 'ready' | 'no-model' | 'error';

// Round-screen safe inset: keep content off the bezel.
const {width} = Dimensions.get('window');
const INSET = Math.round(width * 0.12);

export default function App() {
  const [status, setStatus] = useState<Status>('init');
  const [statusMsg, setStatusMsg] = useState('Starting…');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [partial, setPartial] = useState('');
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [livePartial, setLivePartial] = useState('');
  const [compass, setCompass] = useState<number | null>(null); // null = not showing the compass
  const [pic, setPic] = useState<Pic | null>(null); // a Creative-Commons image to display
  const [page, setPage] = useState<Page | null>(null); // the in-app reader browser
  const [browserLoading, setBrowserLoading] = useState(false);
  const pageRef = useRef<Page | null>(null);
  const historyRef = useRef<Page[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const isListeningRef = useRef(false);
  const activeXhrRef = useRef<XMLHttpRequest | null>(null);
  // Bumped by Clear; onSpeak bails if it changes mid-flight (e.g. Clear during a tool call).
  const genRef = useRef(0);
  // System prompt, augmented at boot with the watch's name + current watch face.
  const sysPromptRef = useRef(SYSTEM_PROMPT);
  const pulse = useRef(new Animated.Value(0)).current;

  // Breathing pulse on the mic while listening, so it's obviously live.
  useEffect(() => {
    if (!listening) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
        Animated.timing(pulse, {toValue: 0, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [listening, pulse]);

  // Live transcription: show words as Vosk recognizes them.
  useEffect(() => {
    if (!Vosk) return;
    const emitter = new NativeEventEmitter(Vosk);
    const sub = emitter.addListener('VoskPartial', (t: string) => setLivePartial(t));
    return () => sub.remove();
  }, []);

  // Live compass heading while the visual compass is open.
  const compassOn = compass !== null;
  useEffect(() => {
    if (!compassOn || !Tools) return;
    const emitter = new NativeEventEmitter(Tools);
    const sub = emitter.addListener('CompassHeading', (e: {heading: number}) => setCompass(e.heading));
    return () => sub.remove();
  }, [compassOn]);

  const closeCompass = useCallback(() => {
    try {
      Tools?.stopCompass();
    } catch {}
    setCompass(null);
  }, []);

  const closePic = useCallback(() => setPic(null), []);

  // In-app reader browser. `push` records the current page for the Back button.
  const openBrowser = useCallback(async (url: string, push = false) => {
    if (push && pageRef.current) historyRef.current.push(pageRef.current);
    setBrowserLoading(true);
    const gen = genRef.current;
    const p = await fetchPage(url);
    if (genRef.current !== gen) return;
    setBrowserLoading(false);
    const next = p || {url, title: "Couldn't load page", text: `I couldn't open ${url}.`, links: []};
    pageRef.current = next;
    setPage(next);
  }, []);

  const browserBack = useCallback(() => {
    const prev = historyRef.current.pop();
    pageRef.current = prev ?? null;
    setPage(prev ?? null);
    if (!prev) setBrowserLoading(false);
  }, []);

  const closeBrowser = useCallback(() => {
    historyRef.current = [];
    pageRef.current = null;
    setPage(null);
    setBrowserLoading(false);
  }, []);

  // --- Boot: ensure model is present, then start the on-watch server ---
  useEffect(() => {
    (async () => {
      try {
        const hasModel = await LlamaServer.modelExists();
        if (!hasModel) {
          const p = await LlamaServer.modelPath();
          setStatus('no-model');
          setStatusMsg(`Model not found.\nPush it to:\n${p}`);
          return;
        }
        setStatus('starting');
        setStatusMsg('Loading model on watch…');
        // Tell the model what device it's on (name + current watch face).
        try {
          const [name, face] = String(await Tools.deviceInfo()).split('|');
          let sp = SYSTEM_PROMPT + ` You run entirely on the user's ${name || 'smartwatch'}`;
          if (face) sp += `, which is currently showing the ${face} watch face`;
          sysPromptRef.current = sp + '.';
        } catch {}
        await LlamaServer.start(PORT, N_THREADS, N_CTX);
        setStatus('ready');
        setStatusMsg('');
      } catch (e: any) {
        setStatus('error');
        setStatusMsg(`Server error:\n${e?.message ?? e}`);
      }
    })();
  }, []);

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: true}));
  }, []);

  // --- Stream a completion from the on-watch server, token by token ---
  const streamAnswer = useCallback(
    (history: Msg[]) =>
      new Promise<void>((resolve) => {
        const body = JSON.stringify({
          messages: [{role: 'system', content: sysPromptRef.current}, ...history],
          stream: true,
          max_tokens: MAX_TOKENS,
          temperature: 0.7,
          cache_prompt: true,
        });
        const xhr = new XMLHttpRequest();
        activeXhrRef.current = xhr;
        xhr.open('POST', `${BASE}/v1/chat/completions`);
        xhr.setRequestHeader('Content-Type', 'application/json');
        let seen = 0;
        let acc = '';
        let spokenLen = 0; // chars of `acc` already handed to TTS
        const flush = () => {
          const chunk = xhr.responseText.slice(seen);
          seen = xhr.responseText.length;
          for (const line of chunk.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const delta = j.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                acc += delta;
                setPartial(acc);
                scrollDown();
              }
            } catch {}
          }
          // Speak sentences aloud as soon as they're complete (reads while generating).
          const seg = acc.slice(spokenLen);
          const m = seg.match(/^[\s\S]*[.!?…](?=\s)/);
          if (m && m[0].trim()) {
            try {
              Tts?.speakAdd(m[0].trim());
            } catch {}
            spokenLen += m[0].length;
          }
        };
        xhr.onprogress = flush;
        xhr.onload = () => {
          flush();
          activeXhrRef.current = null;
          const answer = acc.trim();
          setMessages((m) => [...m, {role: 'assistant', content: answer || '…'}]);
          setPartial('');
          setThinking(false);
          // Speak whatever sentence(s) streaming didn't already queue.
          const tail = acc.slice(spokenLen).trim();
          if (tail) {
            try {
              Tts?.speakAdd(tail);
            } catch {}
          }
          resolve();
        };
        // Aborted by the Clear button while generating — just unwind quietly.
        xhr.onabort = () => {
          activeXhrRef.current = null;
          resolve();
        };
        xhr.onerror = () => {
          activeXhrRef.current = null;
          setMessages((m) => [...m, {role: 'assistant', content: '(error reaching model)'}]);
          setPartial('');
          setThinking(false);
          resolve();
        };
        xhr.send(body);
      }),
    [scrollDown],
  );

  const onSpeak = useCallback(async () => {
    if (status !== 'ready' || listening || thinking) return;
    try {
      Tts?.stop();
      // Built-in device speech recognition (the system dictation UI).
      const text: string = await Speech.listen('Ask me anything');
      if (!text?.trim()) return;

      const utterance = text.trim();

      // "show me a compass" opens the visual compass screen instead of a spoken answer.
      const pc = parseCommandLocally(utterance);
      if (pc?.tool === 'show_compass') {
        try {
          Tools.startCompass();
        } catch {}
        setCompass(0);
        return;
      }
      // "open google.com" / "search the web for X" render in the in-app reader browser.
      if (pc?.tool === 'open_url') {
        historyRef.current = [];
        pageRef.current = null;
        openBrowser(pc.url, false);
        return;
      }
      if (pc?.tool === 'web_search') {
        historyRef.current = [];
        pageRef.current = null;
        openBrowser(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(pc.query)}`, false);
        return;
      }
      // "show me a picture of X" fetches a Creative-Commons image and displays it.
      if (pc?.tool === 'show_picture') {
        setThinking(true);
        scrollDown();
        const gen = genRef.current;
        const found = await fetchPicture(pc.query);
        if (genRef.current !== gen) return;
        setThinking(false);
        if (found) {
          setPic(found);
          try {
            Tts?.speak(`Here's a picture of ${pc.query}.`);
          } catch {}
        } else {
          setMessages((m) => [...m, {role: 'assistant', content: `I couldn't find a picture of ${pc.query}.`, error: true}]);
          try {
            Tts?.speak('I couldn\'t find a picture.');
          } catch {}
        }
        return;
      }

      const next = [...messages, {role: 'user' as const, content: utterance}];
      setMessages(next);
      setThinking(true);
      scrollDown();

      // Function-calling first: if this is a command (set a timer, open an app, …),
      // execute it on the watch and speak a confirmation instead of chatting.
      const gen = genRef.current;
      const cmd = await resolveCommand(utterance, BASE, (xhr) => {
        activeXhrRef.current = xhr;
      });
      if (genRef.current !== gen) return; // Cleared mid-flight — drop this turn.
      if (cmd) {
        activeXhrRef.current = null;
        // Show the tool result; a failed tool call renders as a distinct error bubble.
        setMessages((m) => [...m, {role: 'assistant', content: cmd.text, error: !cmd.ok}]);
        setThinking(false);
        try {
          Tts?.speak(cmd.text);
        } catch {}
        scrollDown();
        return;
      }

      // Not a command — normal streaming chat.
      await streamAnswer(next);
    } catch (e) {
      setThinking(false);
    }
  }, [status, listening, thinking, messages, streamAnswer, scrollDown]);

  const onStopListening = useCallback(() => {
    Vosk?.cancel().catch(() => {});
    setListening(false);
    isListeningRef.current = false;
    setLivePartial('');
  }, []);

  const onClear = useCallback(() => {
    Tts?.stop();
    // Invalidate any command/chat turn currently in flight (tool classification too).
    genRef.current += 1;
    // Abort an in-progress answer if the model is still generating.
    activeXhrRef.current?.abort();
    activeXhrRef.current = null;
    setThinking(false);
    setMessages([]);
    setPartial('');
  }, []);

  const disabled = status !== 'ready' || listening || thinking;

  return (
    <View style={styles.root}>
      <View style={[styles.safe, {paddingHorizontal: INSET, paddingVertical: INSET * 0.6}]}>
        <Text style={styles.title}>Wear LLM</Text>

        {status !== 'ready' ? (
          <View style={styles.center}>
            {(status === 'init' || status === 'starting') && (
              <ActivityIndicator size="small" color={C.accent} />
            )}
            <Text style={styles.status}>{statusMsg}</Text>
          </View>
        ) : compass !== null ? (
          <View style={styles.center}>
            <CompassDial heading={compass} />
            <Text style={styles.compassLabel}>
              {Math.round(compass)}° {compassCardinal(compass)}
            </Text>
          </View>
        ) : pic !== null ? (
          <View style={styles.center}>
            <Image source={{uri: pic.url}} style={styles.pic} resizeMode="contain" />
            <Text style={styles.picCaption} numberOfLines={2}>{pic.title}</Text>
            <Text style={styles.picLicense} numberOfLines={1}>
              {pic.creator} · {pic.license}
            </Text>
          </View>
        ) : browserLoading || page ? (
          <ScrollView ref={scrollRef} style={styles.chat} contentContainerStyle={styles.browserContent}>
            {browserLoading && !page ? (
              <View style={styles.center}>
                <ActivityIndicator size="small" color={C.accent} />
                <Text style={styles.status}>Loading…</Text>
              </View>
            ) : page ? (
              <>
                <Text style={styles.browserUrl} numberOfLines={1}>{page.url.replace(/^https?:\/\//, '')}</Text>
                <Text style={styles.browserTitle}>{page.title}</Text>
                {browserLoading && <ActivityIndicator size="small" color={C.accent} style={{marginVertical: 6}} />}
                {!!page.text && <Text style={styles.browserText}>{page.text}</Text>}
                {page.links.length > 0 && <Text style={styles.browserLinksHdr}>Links</Text>}
                {page.links.map((l, i) => (
                  <TouchableOpacity key={i} onPress={() => openBrowser(l.href, true)} activeOpacity={0.6}>
                    <Text style={styles.browserLink} numberOfLines={2}>{l.text || l.href}</Text>
                  </TouchableOpacity>
                ))}
              </>
            ) : null}
          </ScrollView>
        ) : listening ? (
          <View style={styles.center}>
            <View style={styles.listenDotWrap}>
              <Animated.View
                style={[
                  styles.listenHalo,
                  {
                    opacity: pulse.interpolate({inputRange: [0, 1], outputRange: [0.4, 0]}),
                    transform: [
                      {scale: pulse.interpolate({inputRange: [0, 1], outputRange: [1, 1.9]})},
                    ],
                  },
                ]}
              />
              <Animated.View
                style={[
                  styles.listenDot,
                  {transform: [{scale: pulse.interpolate({inputRange: [0, 1], outputRange: [1, 1.12]})}]},
                ]}>
                <MicIcon size={34} />
              </Animated.View>
            </View>
            <Text style={styles.listenLabel}>Listening…</Text>
            <Text style={styles.listenPartial} numberOfLines={3}>
              {livePartial || 'Say your question…'}
            </Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            style={styles.chat}
            contentContainerStyle={styles.chatContent}
            onContentSizeChange={scrollDown}>
            {messages.length === 0 && !thinking && (
              <Text style={styles.hint}>Ask a question or try to run a tool.</Text>
            )}
            {messages.map((m, i) => (
              <View
                key={i}
                style={[
                  m.role === 'user' ? styles.userBubble : styles.botBubble,
                  m.error && styles.errorBubble,
                ]}>
                <Text
                  style={[
                    m.role === 'user' ? styles.userText : styles.botText,
                    m.error && styles.errorText,
                  ]}>
                  {m.error ? `⚠  ${m.content}` : m.content}
                </Text>
              </View>
            ))}
            {thinking && (
              <View style={[styles.botBubble, styles.thinkingBubble]}>
                {/* Blue spinner stays visible the whole time it's thinking/streaming. */}
                <ActivityIndicator size="small" color={C.accent} style={styles.thinkingSpinner} />
                <Text style={styles.botText}>
                  {partial.trim() ? partial.replace(/\s+$/, '') : 'Thinking…'}
                </Text>
              </View>
            )}
          </ScrollView>
        )}

        <View style={styles.controls}>
          {browserLoading || page ? (
            <>
              <TouchableOpacity style={styles.clearBtn} onPress={browserBack} activeOpacity={0.7}>
                <Text style={styles.clearText}>‹</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.stopBtn} onPress={closeBrowser} activeOpacity={0.7}>
                <Text style={styles.stopText}>Done</Text>
              </TouchableOpacity>
            </>
          ) : compass !== null ? (
            <TouchableOpacity style={styles.stopBtn} onPress={closeCompass} activeOpacity={0.7}>
              <Text style={styles.stopText}>Done</Text>
            </TouchableOpacity>
          ) : pic !== null ? (
            <TouchableOpacity style={styles.stopBtn} onPress={closePic} activeOpacity={0.7}>
              <Text style={styles.stopText}>Done</Text>
            </TouchableOpacity>
          ) : listening ? (
            <TouchableOpacity style={styles.stopBtn} onPress={onStopListening} activeOpacity={0.7}>
              <Text style={styles.stopText}>Stop</Text>
            </TouchableOpacity>
          ) : (
            <>
              {(messages.length > 0 || thinking) && (
                // Always tappable — even mid-generation it aborts the answer and clears.
                <TouchableOpacity style={styles.clearBtn} onPress={onClear} activeOpacity={0.7}>
                  <Text style={styles.clearText}>✕</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.mic, disabled && styles.micDisabled]}
                onPress={onSpeak}
                disabled={disabled}
                activeOpacity={0.7}>
                <MicIcon size={34} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * Apple-inspired dark palette, matching the design tokens from the scrapefrontend project
 * (Apple.com / SF Pro design language). SF Pro isn't available on Android, so we use the
 * system font with Apple's color, pill, and tight-letter-spacing treatment.
 */
const C = {
  bg: '#000000', // pure black, like the Wear voice page
  surface: '#202124', // Google dark grey
  surface2: '#2b2b2e', // circular-button / bubble grey (matches the voice-page mic)
  surfaceHi: '#3c4043', // lighter grey (sent bubble)
  text: '#ffffff',
  text2: '#9aa0a6', // Google secondary grey
  text3: '#80868b',
  accent: '#8ab4f8', // Google blue (used sparingly, e.g. spinner)
  onStrong: '#ffffff',
  danger: '#f28b82', // Google red
};

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  safe: {flex: 1, alignItems: 'stretch', justifyContent: 'space-between'},
  title: {color: C.text, fontSize: 15, fontWeight: '500', textAlign: 'center', marginBottom: 4},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  status: {color: C.text2, fontSize: 13, textAlign: 'center', marginTop: 10, lineHeight: 18},
  chat: {flex: 1, width: '100%'},
  chatContent: {paddingVertical: 4, paddingBottom: 10},
  hint: {color: C.text3, fontSize: 13, textAlign: 'center', marginTop: 22},
  // Monochrome grey bubbles (Wear/Google style).
  userBubble: {
    backgroundColor: C.surfaceHi,
    borderRadius: 20,
    paddingHorizontal: 13,
    paddingVertical: 8,
    marginVertical: 3,
    alignSelf: 'flex-end',
    maxWidth: '86%',
  },
  botBubble: {
    backgroundColor: C.surface2,
    borderRadius: 20,
    paddingHorizontal: 13,
    paddingVertical: 8,
    marginVertical: 3,
    alignSelf: 'flex-start',
    maxWidth: '90%',
  },
  userText: {color: C.text, fontSize: 13, lineHeight: 18},
  botText: {color: C.text, fontSize: 13, lineHeight: 18, flexShrink: 1},
  // A failed tool call is shown distinctly (danger border + red text + ⚠), not as a normal reply.
  errorBubble: {backgroundColor: '#2a1d1d', borderWidth: 1, borderColor: C.danger},
  errorText: {color: C.danger},
  thinkingBubble: {flexDirection: 'row', alignItems: 'flex-start'},
  thinkingSpinner: {marginRight: 8, marginTop: 1},
  // Live listening view (Vosk path) — big grey mic like the voice page.
  listenDotWrap: {width: 96, height: 96, alignItems: 'center', justifyContent: 'center', marginBottom: 14},
  listenHalo: {position: 'absolute', width: 76, height: 76, borderRadius: 38, backgroundColor: C.surface2},
  listenDot: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: C.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listenLabel: {color: C.text, fontSize: 14, fontWeight: '500'},
  compassLabel: {color: C.text, fontSize: 18, fontWeight: '600', marginTop: 12, fontVariant: ['tabular-nums']},
  // In-app reader browser.
  browserContent: {paddingVertical: 4, paddingBottom: 14},
  browserUrl: {color: C.text3, fontSize: 10, marginBottom: 3},
  browserTitle: {color: C.text, fontSize: 15, fontWeight: '600', marginBottom: 6, lineHeight: 20},
  browserText: {color: C.text2, fontSize: 12, lineHeight: 17},
  browserLinksHdr: {color: C.text3, fontSize: 10, letterSpacing: 0.6, marginTop: 14, marginBottom: 2},
  browserLink: {color: C.accent, fontSize: 12, lineHeight: 16, paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.surface2},
  pic: {width: Math.round(width * 0.64), height: Math.round(width * 0.64), borderRadius: 10, backgroundColor: C.surface2},
  picCaption: {color: C.text, fontSize: 12, textAlign: 'center', marginTop: 8, maxWidth: '80%'},
  picLicense: {color: C.text3, fontSize: 10, textAlign: 'center', marginTop: 2},
  listenPartial: {color: C.text2, fontSize: 14, lineHeight: 19, textAlign: 'center', marginTop: 10},
  stopBtn: {backgroundColor: C.surface2, borderRadius: 980, paddingVertical: 10, paddingHorizontal: 30},
  stopText: {color: C.text, fontSize: 13, fontWeight: '500'},
  // Bottom controls: a big circular grey mic (like the voice page), clear to its left.
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    marginBottom: INSET * 0.3,
  },
  clearBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  clearText: {color: C.text2, fontSize: 17, lineHeight: 20},
  mic: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: C.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micDisabled: {opacity: 0.45},
});

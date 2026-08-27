/**
 * WearLLMApp — a fully on-watch local LLM assistant.
 *
 *  Voice  : on-device Vosk recognition (native Vosk module) — streams live and auto-submits
 *           the moment you stop talking (silence endpointing), no button.
 *  LLM    : llama.cpp server running on the watch itself (native LlamaServer module),
 *           SmolLM2-360M-Instruct (Q4_K_M) over 127.0.0.1, streamed token-by-token.
 *  Speech : the answer is spoken aloud through the watch speaker (native Tts module).
 *
 * Nothing leaves the watch — no phone, no laptop, no cloud.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, {Path} from 'react-native-svg';

const {LlamaServer, Speech, Vosk, Tts} = NativeModules;

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

const PORT = 8080;
const N_THREADS = 3;
const N_CTX = 1024;
const MAX_TOKENS = 160;
const BASE = `http://127.0.0.1:${PORT}`;

const SYSTEM_PROMPT =
  'You are a concise, friendly voice assistant on a smartwatch. Answer in one or two short sentences.';

type Msg = {role: 'user' | 'assistant'; content: string};
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
  const scrollRef = useRef<ScrollView>(null);
  const isListeningRef = useRef(false);
  const activeXhrRef = useRef<XMLHttpRequest | null>(null);
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
          messages: [{role: 'system', content: SYSTEM_PROMPT}, ...history],
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
        };
        xhr.onprogress = flush;
        xhr.onload = () => {
          flush();
          activeXhrRef.current = null;
          const answer = acc.trim();
          setMessages((m) => [...m, {role: 'assistant', content: answer || '…'}]);
          setPartial('');
          setThinking(false);
          if (answer) {
            try {
              Tts?.speak(answer);
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

      const next = [...messages, {role: 'user' as const, content: text.trim()}];
      setMessages(next);
      setThinking(true);
      scrollDown();
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
              <Text style={styles.hint}>Tap the mic and ask a question.</Text>
            )}
            {messages.map((m, i) => (
              <View key={i} style={m.role === 'user' ? styles.userBubble : styles.botBubble}>
                <Text style={m.role === 'user' ? styles.userText : styles.botText}>
                  {m.content}
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
          {listening ? (
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

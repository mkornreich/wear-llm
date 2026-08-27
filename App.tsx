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

const {LlamaServer, Vosk, Tts} = NativeModules;

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
  const [caretOn, setCaretOn] = useState(true);
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

  // Blink a caret while the model is generating, so it's obvious it's working.
  useEffect(() => {
    if (!thinking) return;
    const id = setInterval(() => setCaretOn((c) => !c), 450);
    return () => clearInterval(id);
  }, [thinking]);

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
        // Warm up the on-device speech recognizer in the background.
        try {
          if (await Vosk.modelExists()) {
            await Vosk.prepare();
          }
        } catch {}
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
    if (isListeningRef.current) return;
    try {
      Tts?.stop();
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;

      setLivePartial('');
      setListening(true);
      isListeningRef.current = true;
      // Resolves the instant you stop talking (Vosk silence endpointing).
      const text: string = await Vosk.listen();
      setListening(false);
      isListeningRef.current = false;
      setLivePartial('');
      if (!text?.trim()) return;

      const next = [...messages, {role: 'user' as const, content: text.trim()}];
      setMessages(next);
      setThinking(true);
      scrollDown();
      await streamAnswer(next);
    } catch (e) {
      setListening(false);
      isListeningRef.current = false;
      setLivePartial('');
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
                <Text style={styles.listenDotIcon}>🎤</Text>
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
              <View style={styles.botBubble}>
                {partial.trim() ? (
                  <Text style={styles.botText}>
                    {partial.replace(/\s+$/, '')}
                    <Text style={styles.caret}>{caretOn ? '▋' : ' '}</Text>
                  </Text>
                ) : (
                  <View style={styles.thinkingRow}>
                    <ActivityIndicator size="small" color={C.accent} />
                    <Text style={styles.thinkingText}>Thinking…</Text>
                  </View>
                )}
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
                <Text style={styles.micText}>{thinking ? '…' : '🎤 Speak'}</Text>
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
  bg: '#000000',
  surface: '#1c1c1e',
  surface2: '#2c2c2e',
  text: '#f5f5f7',
  text2: '#a1a1a6',
  text3: '#8e8e93',
  accent: '#2997ff',
  accentBtn: '#0a84ff',
  onStrong: '#ffffff',
  danger: '#ff6961',
};

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  safe: {flex: 1, alignItems: 'stretch', justifyContent: 'space-between'},
  title: {
    color: C.text,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.3,
    textAlign: 'center',
    marginBottom: 3,
  },
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  status: {color: C.text2, fontSize: 12, textAlign: 'center', marginTop: 10, lineHeight: 16, letterSpacing: -0.1},
  chat: {flex: 1, width: '100%'},
  chatContent: {paddingVertical: 4, paddingBottom: 10},
  hint: {color: C.text3, fontSize: 12, textAlign: 'center', marginTop: 22, letterSpacing: -0.1},
  userBubble: {
    backgroundColor: C.accentBtn,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginVertical: 3,
    alignSelf: 'flex-end',
    maxWidth: '86%',
  },
  botBubble: {
    backgroundColor: C.surface2,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginVertical: 3,
    alignSelf: 'flex-start',
    maxWidth: '90%',
  },
  userText: {color: C.onStrong, fontSize: 13, lineHeight: 17, letterSpacing: -0.1},
  botText: {color: C.text, fontSize: 13, lineHeight: 18, letterSpacing: -0.1, flexShrink: 1},
  thinkingRow: {flexDirection: 'row', alignItems: 'center'},
  thinkingText: {color: C.text2, fontSize: 13, marginLeft: 8},
  caret: {color: C.accent, fontSize: 13},
  // Live listening view.
  listenDotWrap: {width: 72, height: 72, alignItems: 'center', justifyContent: 'center', marginBottom: 12},
  listenHalo: {
    position: 'absolute',
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.accentBtn,
  },
  listenDot: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.accentBtn,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listenDotIcon: {fontSize: 24},
  listenLabel: {color: C.accent, fontSize: 14, fontWeight: '600', letterSpacing: -0.2},
  listenPartial: {
    color: C.text,
    fontSize: 14,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 10,
    letterSpacing: -0.1,
  },
  stopBtn: {
    backgroundColor: C.surface2,
    borderRadius: 980,
    paddingVertical: 9,
    paddingHorizontal: 28,
  },
  stopText: {color: C.text, fontSize: 13, fontWeight: '600', letterSpacing: -0.2},
  // Bottom control row, centered so it stays clear of the round bezel.
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    marginBottom: INSET * 0.5,
  },
  clearBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: C.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  clearText: {color: C.text2, fontSize: 15, fontWeight: '500', lineHeight: 18},
  mic: {
    backgroundColor: C.accentBtn,
    borderRadius: 980,
    paddingVertical: 9,
    paddingHorizontal: 22,
  },
  micDisabled: {backgroundColor: C.surface2},
  micText: {color: C.onStrong, fontSize: 13, fontWeight: '600', letterSpacing: -0.2},
});

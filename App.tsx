/**
 * WearLLMApp — a fully on-watch local LLM assistant.
 *
 *  Voice  : system dictation (native Speech module) — auto-submits when you stop talking
 *  LLM    : llama.cpp server running on the watch itself (native LlamaServer module),
 *           SmolLM2-360M-Instruct (Q4_K_M) over 127.0.0.1, streamed token-by-token.
 *  Speech : the answer is spoken aloud through the watch speaker (native Tts module).
 *
 * Nothing leaves the watch — no phone, no laptop, no cloud.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  Dimensions,
  NativeModules,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const {LlamaServer, Speech, Tts} = NativeModules;

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
  const scrollRef = useRef<ScrollView>(null);

  // Blink a caret while the model is generating, so it's obvious it's working.
  useEffect(() => {
    if (!thinking) return;
    const id = setInterval(() => setCaretOn((c) => !c), 450);
    return () => clearInterval(id);
  }, [thinking]);

  // Whenever we return to the foreground (e.g. after backing out of the dictation
  // screen because it didn't catch anything), drop back to a clean, usable main page.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        setListening(false);
      }
    });
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
        xhr.onerror = () => {
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
      setListening(true);
      // Opens the dictation UI; resolves with the transcript as soon as you stop talking.
      const text: string = await Speech.listen('Ask me anything');
      setListening(false);
      if (!text?.trim()) return;

      const next = [...messages, {role: 'user' as const, content: text.trim()}];
      setMessages(next);
      setThinking(true);
      scrollDown();
      await streamAnswer(next);
    } catch (e) {
      setListening(false);
      setThinking(false);
    }
  }, [status, listening, thinking, messages, streamAnswer, scrollDown]);

  const onClear = useCallback(() => {
    Tts?.stop();
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
              <ActivityIndicator size="small" color="#4da3ff" />
            )}
            <Text style={styles.status}>{statusMsg}</Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            style={styles.chat}
            contentContainerStyle={styles.chatContent}
            onContentSizeChange={scrollDown}>
            {messages.length === 0 && !thinking && !listening && (
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
                    <ActivityIndicator size="small" color="#4da3ff" />
                    <Text style={styles.thinkingText}>Thinking…</Text>
                  </View>
                )}
              </View>
            )}
          </ScrollView>
        )}

        <View style={styles.controls}>
          {messages.length > 0 && (
            <TouchableOpacity
              style={[styles.clearBtn, (thinking || listening) && styles.micDisabled]}
              onPress={onClear}
              disabled={thinking || listening}
              activeOpacity={0.7}>
              <Text style={styles.clearText}>✕</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.mic, disabled && styles.micDisabled]}
            onPress={onSpeak}
            disabled={disabled}
            activeOpacity={0.7}>
            <Text style={styles.micText}>
              {listening ? '● Listening' : thinking ? '…' : '🎤 Speak'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#000'},
  safe: {flex: 1, alignItems: 'stretch', justifyContent: 'space-between'},
  title: {color: '#4da3ff', fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 2},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  status: {color: '#bbb', fontSize: 11, textAlign: 'center', marginTop: 8, lineHeight: 15},
  chat: {flex: 1, width: '100%'},
  chatContent: {paddingVertical: 4, paddingBottom: 10},
  hint: {color: '#777', fontSize: 11, textAlign: 'center', marginTop: 20},
  userBubble: {backgroundColor: '#1e3a5f', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7, marginVertical: 3, alignSelf: 'flex-end', maxWidth: '88%'},
  botBubble: {backgroundColor: '#1c1c1e', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7, marginVertical: 3, alignSelf: 'flex-start', maxWidth: '92%'},
  userText: {color: '#cfe4ff', fontSize: 12, lineHeight: 16},
  botText: {color: '#eaeaea', fontSize: 12, lineHeight: 17, flexShrink: 1},
  thinkingRow: {flexDirection: 'row', alignItems: 'center'},
  thinkingText: {color: '#9ac4ff', fontSize: 12, marginLeft: 8, fontStyle: 'italic'},
  caret: {color: '#4da3ff', fontSize: 12},
  // Bottom control row, centered so it stays clear of the round bezel.
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    marginBottom: INSET * 0.5,
  },
  clearBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#2a2a2c',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  clearText: {color: '#ff8a80', fontSize: 15, fontWeight: '700', lineHeight: 18},
  mic: {
    backgroundColor: '#0a84ff',
    borderRadius: 22,
    paddingVertical: 7,
    paddingHorizontal: 20,
  },
  micDisabled: {backgroundColor: '#333'},
  micText: {color: '#fff', fontSize: 12, fontWeight: '600'},
});

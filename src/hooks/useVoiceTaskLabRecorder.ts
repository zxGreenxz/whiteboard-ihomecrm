import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_SECONDS = 60;
const MAX_BYTES = 10 * 1024 * 1024;
type RecorderState = 'idle' | 'requesting' | 'recording' | 'stopping' | 'recorded';
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechEvent = { results: ArrayLike<SpeechResult> };
type BrowserRecognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type SpeechWindow = Window & { SpeechRecognition?: new () => BrowserRecognition; webkitSpeechRecognition?: new () => BrowserRecognition };
function speechConstructor() { const scope = window as SpeechWindow; return scope.SpeechRecognition ?? scope.webkitSpeechRecognition; }

export function useVoiceTaskLabRecorder(maxBytes = MAX_BYTES) {
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [audio, setAudio] = useState<{ blob: Blob; url: string } | null>(null);
  const [browserTranscript, setBrowserTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const epoch = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const speech = useRef<BrowserRecognition | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const objectUrl = useRef<string | null>(null);
  const interval = useRef<number>();
  const deadline = useRef<number>();

  const clearTimers = useCallback(() => { window.clearInterval(interval.current); window.clearTimeout(deadline.current); }, []);
  const stopTracks = useCallback(() => { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; }, []);
  const release = useCallback(() => {
    clearTimers();
    const activeRecorder = recorder.current;
    recorder.current = null;
    if (activeRecorder) {
      activeRecorder.ondataavailable = null; activeRecorder.onstop = null; activeRecorder.onerror = null;
      if (activeRecorder.state !== 'inactive') { try { activeRecorder.stop(); } catch { /* Tracks below still release the microphone. */ } }
    }
    const activeSpeech = speech.current;
    speech.current = null;
    if (activeSpeech) { activeSpeech.onend = null; activeSpeech.onerror = null; activeSpeech.onresult = null; try { activeSpeech.abort(); } catch { /* An ended recognition session has no live resource. */ } }
    stopTracks();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, [clearTimers, stopTracks]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current += 1; release(); }; }, [release]);
  const clear = useCallback(() => {
    epoch.current += 1; release();
    setAudio(null); setBrowserTranscript(null); setState('idle'); setSeconds(0); setError(null);
  }, [release]);
  const stop = useCallback(() => {
    clearTimers();
    if (recorder.current?.state === 'recording') { setState('stopping'); recorder.current.stop(); stopTracks(); }
    else if (speech.current) { setState('stopping'); speech.current.stop(); }
  }, [clearTimers, stopTracks]);

  const start = useCallback(async (source: '9router' | 'browser') => {
    clear();
    const token = epoch.current;
    const current = () => alive.current && token === epoch.current;
    const fail = (message: string) => { if (!current()) return; epoch.current += 1; release(); setState('idle'); setError(message); };
    if (!window.isSecureContext) { fail('Micro cần HTTPS. Mở đường dẫn HTTPS trên điện thoại hoặc dùng localhost trên máy thử nghiệm.'); return; }
    setState('requesting');
    const beginTimer = () => {
      const startedAt = Date.now();
      interval.current = window.setInterval(() => { if (current()) setSeconds(Math.min(MAX_SECONDS, Math.floor((Date.now() - startedAt) / 1000))); }, 200);
      deadline.current = window.setTimeout(stop, MAX_SECONDS * 1000);
    };
    if (source === 'browser') {
      const Recognition = speechConstructor();
      if (!Recognition) { fail('Trình duyệt này chưa hỗ trợ nhận dạng giọng nói. Bạn có thể ghi âm qua 9Router hoặc nhập văn bản.'); return; }
      try {
        const recognition = new Recognition();
        speech.current = recognition;
        recognition.lang = 'vi-VN'; recognition.continuous = true; recognition.interimResults = true;
        let recognized = '';
        recognition.onresult = event => {
          if (!current()) return;
          recognized = Array.from(event.results).map(result => result[0].transcript).join(' ').trim();
          setBrowserTranscript(recognized);
        };
        recognition.onerror = event => { fail(event.error === 'not-allowed' ? 'Chưa có quyền micro. Hãy cho phép micro trong cài đặt trình duyệt rồi thử lại.' : 'Trình duyệt chưa nhận được lời nói. Thử lại hoặc nhập văn bản.'); };
        recognition.onend = () => {
          if (!current()) return;
          clearTimers(); speech.current = null;
          setState(recognized ? 'recorded' : 'idle');
          if (!recognized) setError('Chưa nhận được lời nói. Hãy thử lại hoặc nhập văn bản.');
        };
        recognition.start(); setState('recording'); beginTimer();
      } catch { fail('Không khởi động được nhận dạng của trình duyệt. Bạn vẫn có thể nhập văn bản.'); }
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { fail('Trình duyệt này chưa hỗ trợ ghi âm. Hãy dùng Safari/Chrome mới hoặc nhập văn bản.'); return; }
    try {
      const granted = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!current()) { granted.getTracks().forEach(track => track.stop()); return; }
      stream.current = granted;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      const capture = new MediaRecorder(granted, mimeType ? { mimeType } : undefined);
      recorder.current = capture;
      const chunks: Blob[] = [];
      let size = 0;
      capture.ondataavailable = event => {
        if (!current() || !event.data.size) return;
        size += event.data.size;
        if (size > maxBytes) { fail(`Bản ghi vượt ${maxBytes / 1024 / 1024} MiB. Hãy ghi lại ngắn hơn.`); return; }
        chunks.push(event.data);
      };
      capture.onerror = () => fail('Ghi âm bị gián đoạn. Kiểm tra micro rồi thử lại.');
      capture.onstop = () => {
        if (!current()) return;
        clearTimers(); stopTracks(); recorder.current = null;
        const blob = new Blob(chunks, { type: capture.mimeType || chunks[0]?.type || 'application/octet-stream' });
        if (!blob.size) { fail('Chưa thu được âm thanh. Hãy thử ghi lại.'); return; }
        objectUrl.current = URL.createObjectURL(blob);
        setAudio({ blob, url: objectUrl.current }); setState('recorded');
      };
      capture.start(1000); setState('recording'); beginTimer();
    } catch (cause) {
      const denied = cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
      fail(denied ? 'Chưa có quyền micro. Hãy cho phép micro trong cài đặt trình duyệt rồi thử lại.' : 'Không mở được micro. Kiểm tra thiết bị hoặc dùng nhập văn bản.');
    }
  }, [clear, clearTimers, release, stop, stopTracks, maxBytes]);

  return { state, seconds, audio, browserTranscript, error, start, stop, clear, browserSupported: !!speechConstructor() };
}

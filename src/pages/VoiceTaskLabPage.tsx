import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, AudioLines, Check, ChevronDown, FileText, FlaskConical, Keyboard, Loader2, Mic, RefreshCw, Settings2, ShieldCheck, Square, WandSparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AccessPanel, AudioPreview, DraftPanel, SummaryPanel } from '@/components/voice-task-lab/LabPanels';
import { EvaluationPanel } from '@/components/voice-task-lab/EvaluationPanel';
import { useVoiceTaskLabRecorder } from '@/hooks/useVoiceTaskLabRecorder';
import { errorMessage, isCanceled, labClient, LabApiError, type LabClient } from '@/lib/voice-task-lab/client';
import { createReview, type EvaluationSummary, type Prediction, type ProviderStatus, type ReviewForm, type TranscriptSource } from '@/lib/voice-task-lab/model';
import { cn } from '@/lib/utils';

type Busy = 'connection' | 'transcription' | 'extraction' | 'saving' | 'export' | null;
const sourceLabels: Record<TranscriptSource, string> = { '9router': 'Âm thanh qua 9Router', browser: 'Nhận dạng trình duyệt', manual: 'Văn bản nhập tay' };

type Props = { client?: LabClient; accessMode?: 'code' | 'app'; maxAudioBytes?: number };
export default function VoiceTaskLabPage({ client = labClient, accessMode = 'code', maxAudioBytes = 10 * 1024 * 1024 }: Props = {}) {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [chatModel, setChatModel] = useState('');
  const [sttModel, setSttModel] = useState('');
  const [mode, setMode] = useState<TranscriptSource>('9router');
  const [transcript, setTranscript] = useState('');
  const [transcriptMeta, setTranscriptMeta] = useState<{ source: TranscriptSource; sttModel: string | null; elapsedMs: number | null }>({ source: 'manual', sttModel: null, elapsedMs: null });
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<EvaluationSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const recorder = useVoiceTaskLabRecorder(maxAudioBytes);
  const active = useRef<{ id: number; controller: AbortController } | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const alert = useRef<HTMLDivElement>(null);
  const stageHeading = useRef<HTMLDivElement>(null);
  const recording = ['recording', 'requesting', 'stopping'].includes(recorder.state);
  const locked = !!busy || recording;
  const stale = !!prediction && transcript.trim() !== prediction.transcript;
  const canExtract = !!status?.providerReady && !!chatModel;
  const canTranscribe = !!status?.providerReady && !!sttModel;

  const begin = useCallback((operation: Exclude<Busy, null>) => {
    active.current?.controller.abort();
    const pending = { id: ++sequence.current, controller: new AbortController() };
    active.current = pending; setBusy(operation); setError(null);
    return pending;
  }, []);
  const current = useCallback((id: number) => mounted.current && active.current?.id === id, []);
  const finish = useCallback((id: number) => { if (current(id)) { active.current = null; setBusy(null); } }, [current]);
  const report = useCallback((cause: unknown, id: number) => {
    if (!current(id) || isCanceled(cause)) return;
    if (cause instanceof LabApiError && (cause.status === 401 || cause.status === 403)) setStatus(null);
    setError(errorMessage(cause));
  }, [current]);
  const applyStatus = useCallback((value: ProviderStatus) => {
    setStatus(value);
    setChatModel(previous => value.chatModels.includes(previous) ? previous : value.defaultChatModel && value.chatModels.includes(value.defaultChatModel) ? value.defaultChatModel : value.chatModels[0] ?? '');
    setSttModel(previous => value.sttModels.includes(previous) ? previous : value.defaultSttModel && value.sttModels.includes(value.defaultSttModel) ? value.defaultSttModel : value.sttModels[0] ?? '');
  }, []);
  const refresh = useCallback(async (code?: string) => {
    const pending = begin('connection');
    try {
      if (code !== undefined && client.session) await client.session(code, pending.controller.signal);
      const next = await client.status(pending.controller.signal);
      if (!current(pending.id)) return;
      setInitialized(true);
      if (!next.authenticated) { setStatus(null); return; }
      applyStatus(next);
      try {
        const data = await client.evaluations(pending.controller.signal);
        if (current(pending.id)) { setSummary(data.summary); setSummaryError(null); }
      } catch (cause) { if (current(pending.id) && !isCanceled(cause)) setSummaryError('Chưa tải được thống kê. Bấm tải lại kết nối để thử lại.'); }
    } catch (cause) { report(cause, pending.id); if (current(pending.id)) setInitialized(true); }
    finally { finish(pending.id); }
  }, [applyStatus, begin, current, finish, report, client]);

  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; active.current?.controller.abort(); }; }, [refresh]);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);
  useEffect(() => { stageHeading.current?.focus(); }, [stage]);
  useEffect(() => {
    if (mode === 'browser' && recorder.state === 'recorded' && recorder.browserTranscript) {
      setTranscript(recorder.browserTranscript); setTranscriptMeta({ source: 'browser', sttModel: null, elapsedMs: null });
    }
  }, [mode, recorder.state, recorder.browserTranscript]);

  const cancel = () => { active.current?.controller.abort(); active.current = null; sequence.current += 1; setBusy(null); };
  const newTrial = () => { cancel(); recorder.clear(); setTranscript(''); setPrediction(null); setSavedId(null); setTranscriptMeta({ source: 'manual', sttModel: null, elapsedMs: null }); setStage(1); setError(null); };
  const selectMode = (next: TranscriptSource) => { if (next === mode) return; newTrial(); setMode(next); };
  const startRecording = () => { setError(null); setTranscript(''); setPrediction(null); setSavedId(null); void recorder.start(mode === 'browser' ? 'browser' : '9router'); };
  const transcribe = async () => {
    if (!recorder.audio || !canTranscribe) return;
    const pending = begin('transcription');
    try {
      const result = await client.transcribe(recorder.audio.blob, sttModel, pending.controller.signal);
      if (!current(pending.id)) return;
      if (!result.transcript.trim()) { setError('Chưa nhận được lời nói trong bản ghi. Thử ghi lại hoặc nhập văn bản.'); return; }
      setTranscript(result.transcript); setTranscriptMeta({ source: '9router', sttModel: result.model, elapsedMs: result.elapsedMs });
    } catch (cause) { report(cause, pending.id); } finally { finish(pending.id); }
  };
  const extract = async () => {
    if (!transcript.trim() || !canExtract) return;
    const pending = begin('extraction');
    const text = transcript.trim();
    const meta = { ...transcriptMeta };
    try {
      const result = await client.extract(text, chatModel, pending.controller.signal);
      if (!current(pending.id)) return;
      setPrediction({ id: crypto.randomUUID(), transcript: text, transcriptSource: meta.source, sttModel: meta.sttModel, chatModel: result.model, predicted: createReview(result.draft).predicted, warnings: result.warnings, referenceTime: result.referenceTime, latencyMs: { transcription: meta.elapsedMs, extraction: result.elapsedMs } });
      setSavedId(null); setStage(2);
    } catch (cause) { report(cause, pending.id); } finally { finish(pending.id); }
  };
  const save = async (values: ReviewForm) => {
    if (!prediction || stale) return;
    const pending = begin('saving');
    try {
      await client.save({ id: prediction.id, transcript: prediction.transcript, transcriptSource: prediction.transcriptSource, sttModel: prediction.sttModel, chatModel: prediction.chatModel, predicted: { ...prediction.predicted }, latencyMs: prediction.latencyMs, ...values }, pending.controller.signal);
      if (!current(pending.id)) return;
      setSavedId(prediction.id);
      try {
        const data = await client.evaluations(pending.controller.signal);
        if (current(pending.id)) { setSummary(data.summary); setSummaryError(null); }
      } catch (cause) { if (current(pending.id) && !isCanceled(cause)) setSummaryError('Đã lưu đánh giá, nhưng chưa tải lại được thống kê. Bấm tải lại kết nối để cập nhật.'); }
    } catch (cause) { report(cause, pending.id); } finally { finish(pending.id); }
  };
  const download = async () => {
    const pending = begin('export');
    try {
      const data = await client.export(pending.controller.signal);
      if (!current(pending.id)) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `voice-task-evaluations-${new Date().toISOString().slice(0, 10)}.json`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { report(cause, pending.id); } finally { finish(pending.id); }
  };

  return <div className="min-h-dvh bg-[#f6f7f3] font-sans text-slate-800 selection:bg-teal-100">
    <header className="border-b border-slate-200/70 bg-white/70"><div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-4 sm:px-8"><a href="#" onClick={event => event.preventDefault()} className="flex items-center gap-2.5" aria-label="iHomeCRM Voice Lab"><span className="flex size-9 items-center justify-center rounded-xl bg-teal-900 text-white"><AudioLines className="size-5" /></span><span className="text-sm font-semibold tracking-tight text-slate-800">iHomeCRM<span className="ml-1.5 font-normal text-slate-400">/ voice lab</span></span></a><span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-200/80 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800"><FlaskConical className="size-3" />Bản thử nghiệm</span></div></header>
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-7 sm:px-8 sm:pt-10">
      <div className="mb-6 sm:mb-8"><p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-700">Bớt gõ chữ · Thêm thời gian</p><h1 className="max-w-xl text-[28px] font-semibold leading-[1.2] tracking-[-0.035em] text-slate-900 sm:text-4xl">Thử tạo việc bằng giọng nói</h1><p className="mt-3 max-w-lg text-sm leading-6 text-slate-500">Bạn nói việc cần làm. AI sắp xếp thông tin.<br className="sm:hidden" /> Bạn là người kiểm tra kết quả.</p></div>
      <div ref={alert} tabIndex={-1} className="outline-none">{error && <div role="alert" className="mb-5 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-800"><AlertCircle className="mt-0.5 size-5 shrink-0" /><p className="flex-1">{error}</p><Button aria-label="Đóng thông báo lỗi" type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-rose-700" onClick={() => setError(null)}><X className="size-4" /></Button></div>}</div>
      {!initialized ? <div role="status" className="flex min-h-60 items-center justify-center gap-3 text-sm text-slate-500"><Loader2 className="size-5 animate-spin" />Đang mở bản thử nghiệm…</div> : !status ? <div className="max-w-lg"><>{accessMode === 'code' ? <AccessPanel busy={!!busy} onSubmit={code => void refresh(code)} /> : <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold">Chưa mở được bản thử nghiệm</h2><p className="mt-2 text-sm leading-6">Kiểm tra phiên đăng nhập CRM và quyền xem Công việc rồi thử lại.</p><Button disabled={!!busy} onClick={() => void refresh()} className="mt-4">Thử lại</Button><a href="/login" className="ml-4 text-sm underline">Đăng nhập lại</a></div>}</></div> : <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-9">
        <div className="min-w-0">
          <nav aria-label="Các bước thử nghiệm" className="mb-6 grid grid-cols-3 gap-1 rounded-2xl border border-slate-200/70 bg-white/70 p-1.5">{([{ number: 1, label: 'Ghi âm' }, { number: 2, label: 'Công việc' }, { number: 3, label: 'Đánh giá' }] as const).map(step => <button key={step.number} type="button" disabled={locked || (step.number > 1 && !prediction)} aria-current={stage === step.number ? 'step' : undefined} onClick={() => setStage(step.number)} className={cn('flex min-h-12 items-center justify-center gap-1.5 rounded-xl px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 sm:gap-2 sm:text-sm', stage === step.number ? 'bg-teal-900 text-white shadow-sm' : 'text-slate-400 enabled:hover:bg-slate-50 enabled:hover:text-slate-700', 'disabled:cursor-default')}><span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[10px]', stage === step.number ? 'bg-white/15' : 'bg-slate-100')}>{step.number < stage ? <Check className="size-3" /> : step.number}</span>{step.label}</button>)}</nav>
          <div ref={stageHeading} tabIndex={-1} className="outline-none" aria-live="polite"><span className="sr-only">Bước {stage}: {stage === 1 ? 'Ghi âm' : stage === 2 ? 'Công việc' : 'Đánh giá'}</span></div>
          <section hidden={stage !== 1} className="space-y-5">
            <div className="flex gap-1 rounded-xl bg-slate-200/50 p-1" aria-label="Nguồn lời nói">{([{ value: '9router', label: 'Ghi âm', Icon: Mic }, { value: 'browser', label: 'Trình duyệt', Icon: AudioLines }, { value: 'manual', label: 'Nhập chữ', Icon: Keyboard }] as const).map(option => <button key={option.value} type="button" disabled={locked || (option.value === 'browser' && !recorder.browserSupported)} aria-pressed={mode === option.value} onClick={() => selectMode(option.value)} className={cn('flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600', mode === option.value ? 'bg-white text-teal-900 shadow-sm' : 'text-slate-500', 'disabled:opacity-50')}><option.Icon className="size-3.5 shrink-0" />{option.label}</button>)}</div>
            {(!status.providerReady || status.sttModels.length === 0) && <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4"><p className="flex items-center gap-2 text-sm font-semibold text-amber-900"><AlertCircle className="size-4 shrink-0" />{!status.providerReady ? '9Router chưa sẵn sàng' : 'Chưa có model nhận dạng âm thanh'}</p><p className="mt-2 text-xs leading-5 text-amber-800">{status.capabilityError || 'Máy chủ chưa công bố model STT. Bạn vẫn có thể ghi và nghe lại, chọn nhận dạng trình duyệt hoặc nhập văn bản.'}{!status.providerReady && ' Phân tích công việc cần kết nối 9Router hoạt động.'}</p><Button type="button" variant="outline" disabled={locked} onClick={() => void refresh()} className="mt-3 h-10 rounded-xl border-amber-200 bg-white/70 text-xs text-amber-900"><RefreshCw className={cn('size-3.5', busy === 'connection' && 'animate-spin')} />Tải lại kết nối</Button></div>}
            {mode !== 'manual' && <div className="relative overflow-hidden rounded-[28px] border border-teal-100/80 bg-gradient-to-b from-[#eaf3ef] to-[#f5f9f6] px-5 pb-5 pt-7 text-center">
              <div className="mx-auto mb-5 inline-flex items-center gap-1.5 rounded-full border border-teal-200/60 bg-white/70 px-3 py-1 text-[10px] font-medium text-teal-800"><span className={cn('size-1.5 rounded-full', recorder.state === 'recording' ? 'animate-pulse bg-rose-500' : 'bg-teal-600')} />{recorder.state === 'recording' ? 'Đang lắng nghe' : mode === 'browser' ? 'Nhận dạng của trình duyệt' : 'Nhận dạng qua 9Router'}</div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-900">{recorder.state === 'recording' ? 'Cứ nói tự nhiên…' : recorder.audio || recorder.state === 'recorded' ? 'Đã nhận lời nói của bạn' : 'Bạn muốn giao việc gì?'}</h2>
              <p className="mx-auto mt-2 max-w-xs text-xs leading-5 text-slate-500">Nói rõ việc cần làm, tòa nhà, phòng,<br />người nhận và thời hạn nếu có.</p>
              <div className="my-7 flex justify-center"><div className={cn('rounded-full border p-3', recorder.state === 'recording' ? 'border-rose-200 bg-rose-100/40' : 'border-teal-200/60 bg-teal-100/40')}><Button type="button" disabled={!!busy || recorder.state === 'requesting' || recorder.state === 'stopping'} onClick={recorder.state === 'recording' ? recorder.stop : startRecording} aria-label={recorder.state === 'recording' ? 'Dừng ghi âm' : 'Bắt đầu ghi âm'} className={cn('size-24 rounded-full shadow-lg transition-transform enabled:hover:scale-105 [&_svg]:size-9', recorder.state === 'recording' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-teal-800 shadow-teal-900/15 hover:bg-teal-900')}>{recorder.state === 'requesting' || recorder.state === 'stopping' ? <Loader2 className="animate-spin" /> : recorder.state === 'recording' ? <Square className="fill-current" /> : <Mic strokeWidth={1.5} />}</Button></div></div>
              <p role="status" className="text-sm font-semibold tabular-nums text-slate-800">{recorder.state === 'requesting' ? 'Đang chờ quyền micro…' : recorder.state === 'stopping' ? 'Đang hoàn tất bản ghi…' : recording ? `00:${String(recorder.seconds).padStart(2, '0')} / 01:00` : recorder.state === 'recorded' ? 'Bấm micro để ghi lại' : 'Chạm để bắt đầu nói'}</p>
              <p className="mt-1.5 text-[11px] text-slate-400">Tối đa 60 giây · {maxAudioBytes / 1024 / 1024} MiB · Không tự bật micro</p>
              {recording && <Button type="button" variant="ghost" onClick={recorder.clear} className="mt-3 h-10 rounded-xl text-slate-600">Hủy ghi âm</Button>}
              {mode === 'browser' && <p className="mt-4 rounded-xl bg-white/70 p-3 text-left text-xs leading-5 text-teal-900">Bạn đã chọn nhận dạng của trình duyệt. Âm thanh không được nhận dạng qua 9Router; thống kê lưu nguồn “browser”.</p>}
              {recorder.audio && <AudioPreview url={recorder.audio.url} />}
              {mode === '9router' && recorder.audio && <Button type="button" disabled={locked || !canTranscribe} onClick={() => void transcribe()} className="mt-4 h-12 w-full rounded-xl bg-teal-800 text-sm hover:bg-teal-900">{busy === 'transcription' ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}{busy === 'transcription' ? 'Đang nhận dạng lời nói…' : 'Chuyển thành văn bản'}</Button>}
            </div>}
            {recorder.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-800">{recorder.error}</p>}
            {mode === '9router' && !recorder.audio && !recording && <div className="rounded-2xl border border-slate-200/70 bg-white/60 p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Gợi ý cách nói</p><p className="mt-2 text-sm leading-6 text-slate-600">“Sửa vòi nước phòng 201 tòa 1392QT, giao anh Nam, trước 5 giờ chiều ngày mai, việc gấp.”</p></div>}
            {(mode === 'manual' || transcript || (mode === 'browser' && recorder.browserTranscript)) && <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"><label htmlFor="voice-transcript" className="flex items-center gap-2 text-sm font-semibold text-slate-800"><FileText className="size-4 text-teal-700" />{mode === 'manual' ? 'Nhập việc cần làm' : 'Văn bản đã nhận dạng'}</label><Textarea id="voice-transcript" value={recording && mode === 'browser' ? recorder.browserTranscript ?? '' : transcript} onChange={event => { setTranscript(event.target.value); setTranscriptMeta({ source: 'manual', sttModel: null, elapsedMs: null }); }} disabled={locked} maxLength={12000} placeholder="Ví dụ: Sửa vòi nước phòng 201…" className="mt-3 min-h-36 rounded-xl border-slate-200 bg-slate-50/50 text-base leading-7" /><p className="mt-2 text-[11px] leading-5 text-slate-400">{transcriptMeta.source === 'manual' ? (mode === 'manual' ? 'Nguồn: nhập tay. Chỉ đo bước AI trích xuất công việc.' : 'Văn bản đã sửa; lượt này chỉ đánh giá bước trích xuất (nguồn: nhập tay).') : 'Bạn có thể sửa lỗi nhận dạng trước khi phân tích.'} {transcript.length}/12.000 ký tự</p>{stale && <p role="status" className="mt-3 text-xs leading-5 text-amber-800">Văn bản đã thay đổi. Phân tích lại để cập nhật bản nháp.</p>}<Button type="button" disabled={locked || !transcript.trim() || !canExtract} onClick={() => void extract()} className="mt-4 h-12 w-full rounded-xl bg-teal-800 text-sm hover:bg-teal-900">{busy === 'extraction' ? <Loader2 className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}{busy === 'extraction' ? 'Đang hiểu công việc…' : prediction ? 'Phân tích lại công việc' : 'Phân tích công việc'}{busy !== 'extraction' && <ArrowRight className="size-4" />}</Button></div>}
            <details className="rounded-2xl border border-slate-200/80 bg-white/60 p-4"><summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-slate-500"><Settings2 className="size-4" />Model đang sử dụng<ChevronDown className="ml-auto size-4" /></summary><div className="mt-4 space-y-4"><label className="block text-xs text-slate-500">Nhận dạng âm thanh (STT)<select value={sttModel} disabled={locked || !status.sttModels.length} onChange={event => setSttModel(event.target.value)} className="mt-1.5 h-11 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">{!status.sttModels.length && <option value="">Chưa có model STT</option>}{status.sttModels.map(model => <option key={model} value={model}>{model}</option>)}</select></label><label className="block text-xs text-slate-500">Trích xuất công việc<select value={chatModel} disabled={locked || !status.chatModels.length} onChange={event => setChatModel(event.target.value)} className="mt-1.5 h-11 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">{!status.chatModels.length && <option value="">Chưa có model trích xuất</option>}{status.chatModels.map(model => <option key={model} value={model}>{model}</option>)}</select></label><p className="break-words text-[11px] leading-5 text-slate-400">Chỉ dùng model được máy chủ cho phép. Nguồn hiện tại: {sourceLabels[transcript ? transcriptMeta.source : mode]}.</p><Button type="button" variant="outline" disabled={locked} onClick={() => void refresh()} className="h-10 w-full rounded-xl text-xs"><RefreshCw className="size-3.5" />Tải lại kết nối và thống kê</Button></div></details>
          </section>
          {prediction && <><div hidden={stage !== 2}><DraftPanel prediction={prediction} stale={stale} busy={locked} onReview={() => setStage(3)} onEdit={() => setStage(1)} /></div><div hidden={stage !== 3}><EvaluationPanel key={prediction.id} prediction={prediction} busy={locked} saving={busy === 'saving'} stale={stale} saved={savedId === prediction.id} deviceStorage={accessMode === 'app'} onSave={values => void save(values)} onNew={newTrial} /></div></>}
          {(busy === 'transcription' || busy === 'extraction') && <div role="status" className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-teal-50 p-3 text-xs text-teal-900"><span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />{busy === 'transcription' ? 'Đang nhận dạng âm thanh…' : 'Đang phân tích công việc…'}</span><Button type="button" variant="ghost" onClick={cancel} className="h-9 px-2 text-xs">Hủy xử lý</Button></div>}
          <p className="mt-6 flex items-start justify-center gap-1.5 text-center text-[10px] leading-5 text-slate-400"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" />Không tạo hay thay đổi dữ liệu công việc trong CRM.</p>
        </div>
        <div className="lg:sticky lg:top-6"><SummaryPanel deviceStorage={accessMode === 'app'} summary={summary} error={summaryError} busy={locked} onExport={() => void download()} /></div>
      </div>}
    </main>
  </div>;
}

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { useAiRouting, verifyModel, type AiApp, type AiProvider, type AiRoute, type AiSettings } from '@/hooks/useAiRouting';

const names: Record<AiApp,string> = { quick_read: 'Báo chi nhanh', wallet_read: 'Ví cá nhân', meter_vision: 'Đọc ảnh đồng hồ', quick_stt: 'Chép giọng nói' };
const sources = { nous: 'Hermes/Nous · gói ChatGPT', '9router': '9router · GPT và Antigravity' };
type Row = AiSettings['apps'][number];
const selectStyle = 'mt-1 block w-full rounded-md border bg-background px-2 py-2 text-sm';

function AppRoutes({ row, data, busy, save }: { row: Row; data: AiSettings; busy: boolean; save: (routes: AiRoute[]) => void }) {
  const [draft, setDraft] = useState<AiRoute[]>(() => row.routes.length ? row.routes : [
    { provider: row.app === 'meter_vision' && data.meterNousReady === false ? '9router' : 'nous', model: '' },
    { provider: '9router', model: '' },
  ]);
  const update = (index: number, route: AiRoute) => setDraft(prev => prev.map((old, i) => i === index ? route : old));
  const available = (provider: AiProvider) => data.ready[provider] &&
    (row.app !== 'meter_vision' || provider !== 'nous' || data.meterNousReady !== false);
  const models = (provider: AiProvider) => available(provider)
    ? data.catalogs.find(c => c.provider === provider)?.models.filter(m => provider === 'nous' && row.app !== 'meter_vision'
      ? m.vision || m.text : m.vision && m.verified) ?? [] : [];
  const choices = draft.map(r => models(r.provider).find(m => m.id === r.model));
  const needsImage = choices.every(m => m && !m.vision);
  const valid = draft.length === 2 && choices.every(Boolean) && !needsImage &&
    (draft[0].provider !== draft[1].provider || draft[0].model !== draft[1].model);
  return <section className="rounded-lg border bg-card p-4 space-y-3" aria-label={names[row.app]}>
    <h2 className="font-semibold">{names[row.app]}</h2>
    {row.app === 'quick_stt' ? <p className="text-sm text-muted-foreground">Đang dùng luồng chép giọng OpenRouter hiện có. Ba kết nối được chọn chưa có model xác minh được cho API chép giọng của CRM.</p> : <>
      <p className="text-sm text-muted-foreground">{row.routes.length
        ? 'Đã lưu: ' + row.routes.map(r => sources[r.provider] + ' / ' + r.model).join(' → ')
        : 'Đang dùng cấu hình hiện hành của ứng dụng.'}</p>
      <div className="grid gap-4 sm:grid-cols-2">{draft.map((r, index) => <fieldset key={index} className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">{index ? 'Dự phòng' : 'Ưu tiên'}</legend>
        <label className="block text-sm">Nguồn<select className={selectStyle} value={r.provider} onChange={e => update(index, { provider: e.target.value as AiProvider, model: '' })}>
          {Object.entries(sources).map(([id, name]) => <option key={id} value={id} disabled={!available(id as AiProvider)}>{name}</option>)}</select></label>
        <label className="block text-sm">Model<select className={selectStyle} value={r.model} onChange={e => update(index, { ...r, model: e.target.value })}>
          <option value="">Chọn model</option>
          {r.model && !models(r.provider).some(m => m.id === r.model) && <option value={r.model} disabled>{r.model} · ngoài danh mục</option>}
          {models(r.provider).map(m => <option value={m.id} key={m.id}>{m.id}{!m.vision && ' · chỉ văn bản'}{!m.verified && (m.tested ? ' · lần thử chưa đạt' : ' · chưa thử')}</option>)}</select></label>
      </fieldset>)}</div>
      {needsImage && <p role="status" className="text-sm">Chọn ít nhất một model đọc được ảnh để dùng với hóa đơn.</p>}
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !valid || JSON.stringify(row.routes) === JSON.stringify(draft)} onClick={() => save(draft)}>Lưu lựa chọn</Button>
        {row.routes.length > 0 && <Button disabled={busy} variant="outline" onClick={() => save([])}>Trở về cấu hình hiện hành</Button>}</div>
    </>}
  </section>;
}

export default function AiRoutingPage() {
  const { query, change } = useAiRouting();
  const data = query.data;
  const sequence = useRef(0);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => () => { sequence.current++; }, []);
  async function testModels(catalog: AiSettings['catalogs'][number]) {
    const run = ++sequence.current;
    setTesting(true);
    let passed = 0;
    const remaining = catalog.models.filter(m => (m.vision || m.text) && !m.verified);
    const pending = remaining.filter(m => !m.tested);
    const candidates = pending.length ? pending : remaining;
    try {
      for (const [index, model] of candidates.entries()) {
        if (sequence.current !== run) return;
        setMessage('Đang thử ' + (index + 1) + '/' + candidates.length + ' · ' + model.id);
        const result = await verifyModel(catalog.provider, model.id, catalog.synced_at);
        if (sequence.current !== run) return;
        if (result.passed) passed++;
        if (result.stop) { setMessage('Đã dừng thử nguồn do trạng thái tài khoản hoặc hạn mức.'); return; }
      }
      setMessage('Đã thử xong. Có ' + passed + ' model mới trả đúng kết quả.');
    } catch (err) { if (sequence.current === run) setMessage(err instanceof Error ? err.message : 'Lỗi khi thử model.'); }
    finally { if (sequence.current === run) { setTesting(false); void query.refetch(); } }
  }
  return <MainLayout title="Nguồn AI" subtitle="Chọn model ưu tiên và dự phòng cho từng ứng dụng CRM.">
    <div className="mx-auto max-w-4xl space-y-4">
      {query.isPending && <p role="status">Đang tải cấu hình…</p>}
      {(query.isError || change.isError) && <div role="alert">{(query.error || change.error)?.message} <Button variant="outline" onClick={() => { change.reset(); void query.refetch(); }}>Tải lại</Button></div>}
      {data && <>
        {!data.enabled && <p role="status" className="rounded-md border p-3">Định tuyến theo ứng dụng đang tắt. Các lựa chọn đã lưu sẽ áp dụng khi dịch vụ được bật.</p>}
        <section className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Danh mục model</h2>
          <Button variant="outline" disabled={testing || change.isPending} onClick={() => change.mutate({ action: 'sync' })}><RefreshCw className="mr-2 h-4 w-4" />Đồng bộ model</Button></div>
          {message && <p role="status" className="text-sm">{message}</p>}
          {(Object.keys(sources) as AiProvider[]).map(provider => {
            const catalog = data.catalogs.find(c => c.provider === provider);
            return <details key={provider} className="rounded-md border p-3 text-sm"><summary className="cursor-pointer">{sources[provider]} · {catalog?.models.length ?? 0} model</summary>
              <p className="mt-2">{data.ready[provider] ? 'Đã cấu hình kết nối.' : 'Chưa cấu hình kết nối.'} {catalog && 'Đồng bộ lúc ' + new Date(catalog.synced_at).toLocaleString('vi-VN') + '.'}</p>
              {catalog && <><Button variant="outline" className="my-2" disabled={testing || change.isPending || !data.ready[provider] || !catalog.models.some(m => (m.vision || m.text) && !m.verified)} onClick={() => void testModels(catalog)}>Thử các model chưa đạt</Button>
                <p>{catalog.models.filter(m => m.verified).length} model đã trả đúng kết quả. Từng ứng dụng chỉ hiển thị model hỗ trợ đầu vào tương ứng.</p>
                <ul className="mt-2 max-h-48 overflow-auto">{catalog.models.filter(m => provider === 'nous' || m.verified).map(m => <li key={m.id}>
                  {m.id}{provider === 'nous' && <span className="text-muted-foreground"> · {m.vision ? 'ảnh' : m.text ? 'văn bản' : 'không dùng cho các tác vụ này'}{(m.vision || m.text) && (m.verified ? ' · đã thử đạt' : m.tested ? ' · lần thử chưa đạt' : ' · chưa thử')}</span>}
                </li>)}</ul></>}</details>;
          })}
          {data.syncErrors.length > 0 && <p role="alert">Chưa cập nhật được {data.syncErrors.map(p => sources[p]).join(', ')}. Danh mục đã lưu vẫn có thể xem.</p>}
          {change.isSuccess && !data.syncErrors.length && <p role="status">Đã cập nhật cấu hình.</p>}
        </section>
        {data.apps.map(row => <AppRoutes key={row.app + ':' + row.revision} row={row} data={data} busy={change.isPending} save={routes => change.mutate({ action: 'save', app: row.app, revision: row.revision, routes })} />)}
      </>}
    </div>
  </MainLayout>;
}

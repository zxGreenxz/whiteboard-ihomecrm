import { useState, type ReactNode } from 'react';
import { ArrowRight, Check, CircleHelp, Mail, Pencil, Plus, Smartphone } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cashbooks } from '@/lib/bank-reconciliation/demoFixtures';
import { routeDemoTransactions, saveDemoSourceRules, type DemoState } from '@/lib/bank-reconciliation/demoModel';
import { demoSources, mbDemoSample } from '@/lib/bank-reconciliation/sourceFixtures';
import { channelLabels, emailAddress, identityLabels, resolveSourceMessages, validateSourceRule, type SourceChannel, type SourceMessage, type SourceRule } from '@/lib/bank-reconciliation/sourceRules';

const nameOfBook = (id: string | null) => cashbooks.find(b => b.id === id)?.name ?? 'Chưa xác định sổ';
const nameOfSource = (id: string) => demoSources.find(s => s.id === id)?.name ?? id;
const bookIds = cashbooks.map(b => b.id);
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="br-field"><span>{label}</span>{children}</label>; }
function SourceSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <select value={value} onChange={e => onChange(e.target.value)}>{demoSources.map(s => <option key={s.id} value={s.id}>{s.name} · {s.kind === 'gmail' ? 'Gmail' : 'Android'}</option>)}</select>;
}
function ChannelSelect({ sourceId, value, onChange }: { sourceId: string; value: SourceChannel; onChange: (v: SourceChannel) => void }) {
  const channels: SourceChannel[] = demoSources.find(s => s.id === sourceId)?.kind === 'gmail' ? ['gmail'] : ['sms', 'notification'];
  return <select value={value} onChange={e => onChange(e.target.value as SourceChannel)}>{channels.map(c => <option key={c} value={c}>{channelLabels[c]}</option>)}</select>;
}

export default function SourceConfiguration({ state, onSave, onOpen }: { state: DemoState; onSave: (next: DemoState) => void; onOpen: (id: string) => void }) {
  const [sourceFilter, setSourceFilter] = useState('src-mbdemo');
  const [draft, setDraft] = useState<SourceRule | null>(null);
  const [sample, setSample] = useState<SourceMessage>({ ...mbDemoSample });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const rules = state.sourceRules.filter(r => !sourceFilter || r.sourceId === sourceFilter);
  const result = resolveSourceMessages([sample], state.sourceRules, sample.org);
  const draftRules = draft ? [...state.sourceRules.filter(r => r.id !== draft.id), draft] : state.sourceRules;
  const draftErrors = draft ? validateSourceRule(draft, demoSources, bookIds) : [];
  const draftResult = resolveSourceMessages([sample], draftRules, sample.org);
  const projected = draft ? routeDemoTransactions({ ...state, sourceRules: draftRules }) : state;
  const affected = projected.transactions.filter((t, i) => t.book !== state.transactions[i]?.book || t.routingIssue !== state.transactions[i]?.routingIssue);
  const patchDraft = (patch: Partial<SourceRule>) => { setDraft(d => d ? { ...d, ...patch } : d); setError(''); };
  function persist(nextRules: SourceRule[]) {
    try {
      const next = saveDemoSourceRules(state, nextRules, demoSources, bookIds, new Date().toISOString());
      onSave(next); setDraft(null); setError(''); setMessage(next.sourceHistory[0]!.detail);
    } catch (e) { setError(e instanceof Error ? e.message : 'Chưa lưu được quy tắc.'); }
  }
  function newRule(fromSample: boolean) {
    setError('');
    setDraft({ id: `demo-rule-${crypto.randomUUID()}`, org: 'DEMO', name: fromSample ? `${nameOfSource(sample.sourceId)} · ${channelLabels[sample.channel]}` : '',
      sourceId: fromSample ? sample.sourceId : 'src-mbdemo', channel: fromSample ? sample.channel : 'notification',
      identity: fromSample ? sample.channel === 'notification' ? sample.packageName : sample.channel === 'gmail' ? emailAddress(sample.sender) : sample.sender : '',
      textIncludes: '', accountToken: '', bookId: fromSample ? result.bookId ?? '' : '', enabled: true });
  }
  function sampleFor(channel: SourceChannel) {
    setSample(channel === 'notification' ? { ...mbDemoSample } : channel === 'sms' ? { ...mbDemoSample, channel, title: '', packageName: '', sender: 'MB-DEMO' }
      : { ...mbDemoSample, channel, sourceId: 'src-mail', packageName: '', sender: 'Ngân hàng DEMO <bank-alerts@example.test>' });
  }
  return <div className="br-source-config">
    <section className="br-table-card">
      <div className="br-section-heading br-source-heading"><div><h2>Nguồn nào → sổ ngân hàng nào?</h2><p>Đúng nguồn kết nối + đúng người gửi / ứng dụng + các điều kiện bổ sung → xác định sổ nhận.</p></div><button className="br-button br-primary" onClick={() => newRule(false)}><Plus size={16} />Thêm quy tắc</button></div>
      <div className="br-routing-steps"><span>1. Chọn nguồn đã kết nối</span><ArrowRight size={16} /><span>2. Nhận diện tin ngân hàng</span><ArrowRight size={16} /><span>3. Gắn đúng sổ quỹ</span></div>
      <div className="br-source-toolbar"><Field label="Xem quy tắc của nguồn"><select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="">Tất cả nguồn</option>{demoSources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><span>{state.sourceRules.filter(r => r.enabled).length} quy tắc đang bật · {state.transactions.filter(t => !t.book).length} khoản chưa rõ sổ</span></div>
      {message && <p className="br-source-feedback" role="status"><Check size={16} />{message}</p>}
      {error && !draft && <p className="br-error" role="alert">{error}</p>}
      <div className="br-rule-list">{rules.map(r => <article key={r.id} className={`br-routing-rule ${r.enabled ? '' : 'is-paused'}`}>
        <div className="br-routing-rule-top"><div>{r.channel === 'gmail' ? <Mail size={18} /> : <Smartphone size={18} />}<strong>{r.name}</strong><span className={`br-tag ${r.enabled ? 'exact' : ''}`}>{r.enabled ? 'Đang bật' : 'Tạm dừng'}</span></div><div className="br-actions"><button className="br-button" aria-label={`Sửa ${r.name}`} onClick={() => { setDraft({ ...r }); setError(''); }}><Pencil size={14} />Sửa</button><button className="br-button" aria-label={`${r.enabled ? 'Tạm dừng' : 'Bật'} ${r.name}`} onClick={() => persist(state.sourceRules.map(x => x.id === r.id ? { ...x, enabled: !x.enabled } : x))}>{r.enabled ? 'Tạm dừng' : 'Bật lại'}</button></div></div>
        <div className="br-rule-path"><div><small>Nguồn / loại tin</small><strong>{nameOfSource(r.sourceId)} · {channelLabels[r.channel]}</strong></div><ArrowRight size={16} /><div><small>{identityLabels[r.channel]}</small><code>{r.identity}</code></div><ArrowRight size={16} /><div><small>Sổ quỹ đích</small><strong className="br-green-text">{nameOfBook(r.bookId)}</strong></div></div>
        <p className="br-rule-conditions">{r.textIncludes.trim() ? `Nội dung có “${r.textIncludes}”` : 'Không giới hạn cụm từ nội dung'} · {r.accountToken.trim() ? `Tài khoản có dấu nhận diện ${r.accountToken}` : 'Áp dụng mọi tài khoản gửi từ nguồn và người gửi này'}</p>
      </article>)}{!rules.length && <p className="br-guide-note">Nguồn này chưa có quy tắc. Thêm quy tắc hoặc tạo từ tin thử bên dưới.</p>}</div>
      <div className="br-guide-note"><strong>Tất cả điều kiện trong một quy tắc phải cùng khớp.</strong><p>Ứng dụng dùng packageName, không dùng tên MB Bank. Gmail dùng địa chỉ gửi đầy đủ, không dùng tên hiển thị. Nhiều quy tắc cùng chỉ một sổ được chấp nhận; chỉ sang nhiều sổ thì chờ kiểm tra, không tự ưu tiên quy tắc đầu tiên.</p></div>
    </section>
    <section className="br-table-card"><div className="br-section-heading"><h2>Thử tin nhắn trước khi dùng quy tắc</h2><p>Sửa nội dung để xem vì sao vào sổ hoặc bị chặn. Tin thử không tạo thêm giao dịch và không ghi thu.</p></div>
      <div className="br-source-tester"><div><div className="br-actions br-sample-actions"><button className="br-button" onClick={() => sampleFor('notification')}>Mẫu app MBDemo</button><button className="br-button" onClick={() => sampleFor('sms')}>Mẫu SMS</button><button className="br-button" onClick={() => sampleFor('gmail')}>Mẫu Gmail</button></div>
        <div className="br-source-fields"><Field label="Nguồn của tin thử"><SourceSelect value={sample.sourceId} onChange={sourceId => setSample(s => ({ ...s, sourceId, channel: demoSources.find(x => x.id === sourceId)?.kind === 'gmail' ? 'gmail' : s.channel === 'gmail' ? 'sms' : s.channel }))} /></Field><Field label="Loại tin thử"><ChannelSelect sourceId={sample.sourceId} value={sample.channel} onChange={channel => setSample(s => ({ ...s, channel }))} /></Field>
          <Field label={identityLabels[sample.channel]}><input value={sample.channel === 'notification' ? sample.packageName : sample.sender} onChange={e => setSample(s => ({ ...s, [s.channel === 'notification' ? 'packageName' : 'sender']: e.target.value }))} /></Field><Field label="Tiêu đề tin thử"><input value={sample.title} onChange={e => setSample(s => ({ ...s, title: e.target.value }))} /></Field></div>
        <Field label="Nội dung tin thử"><textarea rows={4} value={sample.body} onChange={e => setSample(s => ({ ...s, body: e.target.value }))} /></Field></div>
        <div className={`br-routing-result ${result.status}`} aria-live="polite"><span className="br-eyebrow">KẾT QUẢ NHẬN DIỆN</span><h3>{result.status === 'resolved' ? nameOfBook(result.bookId) : result.status === 'conflict' ? 'Xung đột sổ nhận' : 'Chưa xác định sổ'}</h3><p>{result.status === 'resolved' ? `${result.ruleIds.length} quy tắc phù hợp. Có thể dùng sổ này để lọc hóa đơn; quản lý vẫn xác nhận khoản thu.` : 'Chưa được dùng khoản này để xác nhận thu hóa đơn.'}</p><ul>{result.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul><button className="br-button" onClick={() => newRule(true)}>Tạo quy tắc từ tin này</button></div>
      </div><div className="br-guide-note"><strong>Tình huống MBDemo đã có trong danh sách demo.</strong><p>DEMO-GD-MB01: 650.000đ, giả định bill D06 – DEMO-A còn nợ đúng số tiền này. Tên khách và công nợ là dữ liệu mẫu.</p><button className="br-button" onClick={() => onOpen('DEMO-GD-MB01')}>Xem giao dịch MBDemo <ArrowRight size={15} /></button></div>
    </section>
    <section className="br-table-card"><div className="br-section-heading"><h2>Lịch sử cấu hình trong phiên</h2><p>Lưu hoặc tạm dừng sẽ tính lại sổ của các giao dịch chưa khớp. Khoản đã khớp giữ sổ cũ; gỡ liên kết mới xét lại theo cấu hình hiện tại.</p></div><div className="br-source-history">{state.sourceHistory.length ? state.sourceHistory.slice(0, 8).map((h, i) => <p key={`${h.at}-${i}`}><small>{new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(h.at))} · Quản lý DEMO</small>{h.detail}</p>) : <p>Chưa thay đổi cấu hình mẫu.</p>}</div></section>
    <Dialog open={!!draft} onOpenChange={v => { if (!v) setDraft(null); }}><DialogContent className="br-rule-dialog"><DialogHeader><DialogTitle>{draft && state.sourceRules.some(r => r.id === draft.id) ? 'Sửa quy tắc nhận diện sổ' : 'Thêm quy tắc nhận diện sổ'}</DialogTitle><DialogDescription>Cấu hình chỉ lưu trong phiên demo. Tải lại trang sẽ khôi phục bộ mẫu.</DialogDescription></DialogHeader>{draft && <form onSubmit={e => { e.preventDefault(); if (!draftErrors.length) persist(draftRules); }}>
      <Field label="Tên quy tắc"><input required maxLength={120} value={draft.name} onChange={e => patchDraft({ name: e.target.value })} placeholder="Ví dụ: MBDemo nhận thông báo MB" /></Field>
      <div className="br-source-fields"><Field label="Nguồn kết nối"><SourceSelect value={draft.sourceId} onChange={sourceId => patchDraft({ sourceId, channel: demoSources.find(s => s.id === sourceId)?.kind === 'gmail' ? 'gmail' : draft.channel === 'gmail' ? 'sms' : draft.channel, identity: '' })} /></Field><Field label="Loại tin"><ChannelSelect sourceId={draft.sourceId} value={draft.channel} onChange={channel => patchDraft({ channel, identity: '' })} /></Field>
        <Field label={identityLabels[draft.channel]}><input required value={draft.identity} onChange={e => patchDraft({ identity: e.target.value })} placeholder={draft.channel === 'notification' ? 'com.mbbmobile' : draft.channel === 'gmail' ? 'bank-alerts@example.test' : 'MB-DEMO'} /></Field>
        <Field label="Sổ quỹ ngân hàng đích"><select required value={draft.bookId} onChange={e => patchDraft({ bookId: e.target.value })}><option value="">Chọn sổ ngân hàng</option>{cashbooks.map(b => <option key={b.id} value={b.id}>{b.name} · {b.bank} · {b.account}</option>)}</select></Field>
        <Field label="Tiêu đề / nội dung chứa (tùy chọn)"><input value={draft.textIncludes} onChange={e => patchDraft({ textIncludes: e.target.value })} placeholder="Ví dụ: Thông báo biến động số dư" /></Field>
        <Field label="Dấu tài khoản trong nội dung (tùy chọn)"><input value={draft.accountToken} onChange={e => patchDraft({ accountToken: e.target.value })} placeholder="Ví dụ: 00xxx123" /></Field></div>
      <p className="br-card-note">Sao chép đúng dấu tài khoản như trong tin, ví dụ 00xxx123. Nếu một nguồn và người gửi báo cho nhiều tài khoản, thêm dấu tài khoản để phân biệt. Để trống nghĩa là anh xác nhận mọi tin khớp điều kiện trên đều thuộc sổ đã chọn.</p>
      <label className="br-source-switch"><input type="checkbox" checked={draft.enabled} onChange={e => patchDraft({ enabled: e.target.checked })} />Bật quy tắc này</label>
      <div className="br-rule-impact"><strong>Xem trước khi lưu</strong><p>Tin đang thử: {draftResult.status === 'resolved' ? nameOfBook(draftResult.bookId) : draftResult.status === 'conflict' ? 'Xung đột — nhiều sổ cùng khớp' : 'Chưa có quy tắc khớp'}.</p><p>{affected.length} giao dịch chưa khớp sẽ đổi sổ hoặc trạng thái. Giao dịch đã khớp giữ nguyên.</p>{!!affected.length && <ul>{affected.slice(0, 5).map(t => <li key={t.id}>{t.id} → {t.routingIssue ? 'Chờ kiểm tra' : nameOfBook(t.book)}</li>)}</ul>}{draftResult.status === 'conflict' && <p className="br-warning"><CircleHelp size={16} />Lưu cấu hình này sẽ chặn gợi ý các khoản bị xung đột cho tới khi sửa quy tắc.</p>}</div>
      {!!draftErrors.length && <p className="br-error">{draftErrors.join(' ')}</p>}{error && <p className="br-error" role="alert">{error}</p>}
      <div className="br-actions br-confirm-actions"><button type="button" className="br-button" onClick={() => setDraft(null)}>Hủy</button><button type="submit" className="br-button br-primary" disabled={!!draftErrors.length}><Check size={16} />Lưu cấu hình mẫu</button></div>
    </form>}</DialogContent></Dialog>
  </div>;
}

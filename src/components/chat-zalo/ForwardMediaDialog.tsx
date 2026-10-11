import { useMemo, useRef, useState } from 'react';
import { FileImage, Loader2, Search, Share2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ForwardMediaResult } from '@/lib/zaloForwardMedia';
import LabelFilter from './LabelFilter';
import { conversationHasLabel } from './conversationState';
import { forwardMediaCaption, forwardMediaIssue, forwardMediaKind, forwardMediaName } from './forwardMediaState';
import type { ZaloConversation, ZaloLabel, ZaloMessage } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: ZaloMessage[];
  conversations: ZaloConversation[];
  labels: ZaloLabel[];
  accountNames?: Record<string, string>;
  sending: boolean;
  onSend: (ids: string[], requestId: string) => Promise<ForwardMediaResult>;
}

interface Recipient { id: string; name: string; detail: string }
interface Submission { requestId: string; recipients: Recipient[]; messages: ZaloMessage[] }
interface Session {
  selected: string[];
  submission?: Submission;
  phase: 'idle' | 'sending' | 'unknown' | 'confirmed';
  result?: ForwardMediaResult;
}
const EMPTY_SESSION: Session = { selected: [], phase: 'idle' };
const MAX_RECIPIENTS = 100;

/** Keep mounted: an unknown request survives closing the dialog and switching source media. */
export default function ForwardMediaDialog({ open, onOpenChange, messages, conversations, labels, accountNames, sending, onSend }: Props) {
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const sessionsRef = useRef(sessions);
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const sourceKey = JSON.stringify(messages.map(message => message.id ?? `${message.type}:${message.mediaUrl ?? ''}`));
  const session = sessions[sourceKey] ?? EMPTY_SESSION;
  const shownMessages = session.submission?.messages ?? messages;
  const issue = forwardMediaIssue(shownMessages);
  const busy = sending || session.phase === 'sending';
  const caption = forwardMediaCaption(shownMessages);
  const names = useMemo(() => {
    const result: Record<string, string> = {};
    for (const label of labels) if (label.accountName) result[label.accountId] = label.accountName;
    return { ...result, ...accountNames };
  }, [labels, accountNames]);
  const recipientDetail = (conversation: ZaloConversation) => `${conversation.isGroup ? 'Nhóm' : 'Cá nhân'} · Gửi bằng ${conversation.accountId ? names[conversation.accountId] || conversation.accountId : 'tài khoản chưa xác định'}`;
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('vi');
    return conversations.filter(conversation => conversationHasLabel(conversation, labelFilter) &&
      (!term || [conversation.name, conversation.phone, conversation.sub].some(value => value?.toLocaleLowerCase('vi').includes(term))));
  }, [conversations, search, labelFilter]);

  // Update the captured source, never whichever dialog happens to be open when a request resolves.
  const update = (key: string, change: (previous: Session) => Session) => {
    const next = { ...sessionsRef.current, [key]: change(sessionsRef.current[key] ?? EMPTY_SESSION) };
    sessionsRef.current = next;
    setSessions(next);
  };
  const toggle = (id: string) => update(sourceKey, previous => {
    if (previous.submission || sending) return previous;
    const selected = previous.selected.includes(id) ? previous.selected.filter(value => value !== id) : [...previous.selected, id].slice(0, MAX_RECIPIENTS);
    return { ...previous, selected };
  });
  const selectFiltered = () => update(sourceKey, previous => previous.submission || sending ? previous : {
    ...previous, selected: [...new Set([...previous.selected, ...filtered.map(conversation => conversation.id)])].slice(0, MAX_RECIPIENTS),
  });
  const submit = async () => {
    const current = sessionsRef.current[sourceKey] ?? EMPTY_SESSION;
    if (sending || current.phase === 'sending' || current.phase === 'confirmed') return;
    if (!current.submission && (forwardMediaIssue(messages) || !current.selected.length)) return;
    const submission = current.submission ?? {
      requestId: crypto.randomUUID(),
      recipients: current.selected.map(id => {
        const conversation = conversations.find(value => value.id === id);
        return { id, name: conversation?.name || id, detail: conversation ? recipientDetail(conversation) : 'Hội thoại đã chọn' };
      }),
      messages: messages.map(message => ({ ...message })),
    };
    update(sourceKey, previous => ({ ...previous, submission, phase: 'sending' }));
    try {
      const result = await onSend(submission.recipients.map(recipient => recipient.id), submission.requestId);
      update(sourceKey, previous => ({ ...previous, phase: 'confirmed', result }));
    } catch {
      // The same idempotent request also reconciles a response lost in transport.
      update(sourceKey, previous => ({ ...previous, phase: 'unknown' }));
    }
  };
  const startAnother = () => {
    if (busy || sessionsRef.current[sourceKey]?.phase !== 'confirmed') return;
    update(sourceKey, () => ({ selected: [], phase: 'idle' }));
    setSearch('');
    setLabelFilter(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className="w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:max-w-[560px] sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Share2 className="h-5 w-5 shrink-0" />Chuyển tiếp ảnh / tệp</DialogTitle>
          <DialogDescription>Chuyển tiếp nội dung gốc vào hội thoại đã chọn. Kiểm tra người nhận và tài khoản gửi trước khi tiếp tục.</DialogDescription>
        </DialogHeader>

        <section aria-label="Nội dung chuyển tiếp" className="min-w-0 rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium"><FileImage className="h-4 w-4 shrink-0" />{shownMessages.length > 1 ? `Album ${shownMessages.length} ảnh` : shownMessages[0] ? forwardMediaKind(shownMessages[0]) : 'Chưa có nội dung'}</p>
          <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto break-words [overflow-wrap:anywhere]">
            {shownMessages.map((message, index) => <li key={`${message.id}:${index}`}>{forwardMediaName(message)}</li>)}
          </ul>
          {caption && <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{caption}</p>}
        </section>
        {issue && <p id="forward-media-unavailable" role="alert" className="text-sm text-destructive">{issue}</p>}

        {!session.submission ? <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <LabelFilter labels={labels} selectedLabel={labelFilter} onSelect={setLabelFilter} />
            <label className="flex min-w-0 flex-[1_1_160px] items-center gap-2 rounded-md border px-2 py-1.5">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="sr-only">Tìm hội thoại nhận chuyển tiếp</span>
              <input className="w-full min-w-0 bg-transparent text-sm outline-none" value={search} onChange={event => setSearch(event.target.value)} placeholder="Tìm hội thoại…" />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>Đã chọn {session.selected.length}/{MAX_RECIPIENTS} hội thoại</span>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" disabled={busy || !filtered.length || session.selected.length === MAX_RECIPIENTS} onClick={selectFiltered}>{filtered.length > MAX_RECIPIENTS ? `Chọn ${MAX_RECIPIENTS} hội thoại đầu` : 'Chọn tất cả kết quả'}</Button>
              {!!session.selected.length && <Button size="sm" variant="ghost" disabled={busy} onClick={() => update(sourceKey, previous => ({ ...previous, selected: [] }))}>Bỏ chọn</Button>}
            </div>
          </div>
          <fieldset aria-label="Hội thoại nhận chuyển tiếp" className="max-h-60 min-w-0 overflow-y-auto rounded-lg border" disabled={busy}>
            {filtered.length ? filtered.map(conversation => {
              const checked = session.selected.includes(conversation.id);
              return <label key={conversation.id} className="flex min-w-0 cursor-pointer items-center gap-3 border-b p-3 last:border-b-0 has-[:checked]:bg-emerald-50">
                <input type="checkbox" className="h-4 w-4 shrink-0" checked={checked} disabled={!checked && session.selected.length >= MAX_RECIPIENTS} onChange={() => toggle(conversation.id)} />
                <span className="min-w-0 break-words [overflow-wrap:anywhere]"><span className="block text-sm font-medium">{conversation.name}</span><span className="block text-xs text-muted-foreground">{recipientDetail(conversation)}</span></span>
              </label>;
            }) : <p className="p-4 text-center text-sm text-muted-foreground">Không có hội thoại phù hợp.</p>}
          </fieldset>
        </> : <section aria-label="Kết quả từng hội thoại" className="min-w-0">
          <p className="mb-2 text-sm font-medium">Người nhận đã chốt · {session.submission.recipients.length}</p>
          <ul className="max-h-60 space-y-2 overflow-y-auto rounded-lg border p-3" aria-live="polite">
            {session.submission.recipients.map(recipient => {
              const result = session.result?.recipients.find(value => value.conversation_id === recipient.id);
              return <li key={recipient.id} className="min-w-0 border-b pb-2 last:border-b-0 last:pb-0 break-words [overflow-wrap:anywhere]">
                <p className="text-sm font-medium">{recipient.name}</p><p className="text-xs text-muted-foreground">{recipient.detail}</p>
                <p className={`mt-1 text-sm ${result?.status === 'rejected' ? 'text-destructive' : ''}`}>{result?.status === 'queued' ? 'Đã xếp hàng' : result?.status === 'rejected' ? `Không xếp hàng: ${result.error}` : session.phase === 'sending' ? 'Đang kiểm tra kết quả…' : 'Chưa xác nhận'}</p>
              </li>;
            })}
          </ul>
          {session.phase === 'confirmed' && <p role="status" className="mt-2 text-xs text-muted-foreground">Đã xếp hàng chỉ xác nhận yêu cầu được tiếp nhận, chưa xác nhận tin đã tới Zalo. Mở hội thoại để xem trạng thái gửi.</p>}
        </section>}

        {session.phase === 'unknown' && <div role="alert" className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
          Chưa xác nhận được kết quả. Danh sách người nhận được giữ nguyên. Bấm “Kiểm tra lại yêu cầu” để kiểm tra cùng yêu cầu, tránh xếp hàng trùng.
        </div>}
        {session.submission && <p className="break-all text-xs text-muted-foreground">Mã yêu cầu: {session.submission.requestId}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
          {session.phase === 'confirmed' ? <Button onClick={startAnother} disabled={busy}>Chuyển tiếp lần khác</Button> : <Button onClick={() => void submit()} aria-describedby={issue && !session.submission ? 'forward-media-unavailable' : undefined} disabled={busy || (!session.submission && (!!issue || !session.selected.length))}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{session.phase === 'unknown' ? 'Kiểm tra lại yêu cầu' : busy ? 'Đang xử lý…' : `Chuyển tiếp tới ${session.selected.length}`}
          </Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { authorizeGmail, loadGoogleAuth } from '@/lib/emailBills/googleAuth';
import { listGmailBills, readGmailProfile } from '@/lib/emailBills/gmail';
import { emailBillKey, emailBillRepository } from '@/lib/emailBills/importRpc';
import type { EmailBill, EmailBillSource, GmailSession } from '@/lib/emailBills/types';

/** This hook lives only inside the open dialog. No mailbox data enters query caches or storage. */
export function useEmailBillImport(organizationId: string, userId: string) {
  const clientId = String(import.meta.env.VITE_GMAIL_CLIENT_ID ?? '').trim();
  const [authReady, setAuthReady] = useState(false);
  const [mailbox, setMailbox] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bills, setBills] = useState<EmailBill[]>([]);
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const [searched, setSearched] = useState(false);
  const session = useRef<GmailSession | null>(null);
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const pending = useRef(false);
  const lastRange = useRef<{ from: string; to: string } | null>(null);

  const clearMailbox = useCallback(() => {
    session.current = null; lastRange.current = null;
    setMailbox(''); setBills([]); setImported(new Set());
    setNextPageToken(null); setFailedCount(0); setSearched(false);
  }, []);

  useEffect(() => {
    active.current = true;
    const version = ++generation.current;
    clearMailbox(); pending.current = false; setBusy(false); setError(null); setAuthReady(false);
    abort.current = null;
    if (clientId) void loadGoogleAuth().then(() => {
      if (active.current && generation.current === version) setAuthReady(true);
    }).catch(() => {
      if (active.current && generation.current === version) setError('Chưa tải được kết nối Google. Đóng màn hình rồi mở lại để thử.');
    });
    return () => {
      // Inactive rejects callbacks during unmount; the next effect increments
      // generation before activating work for its new scope.
      active.current = false; abort.current?.abort(); session.current = null;
    };
  }, [clientId, organizationId, userId, clearMailbox]);

  function start() {
    if (pending.current) return null;
    pending.current = true; setBusy(true); setError(null);
    abort.current?.abort(); abort.current = new AbortController();
    return { version: generation.current, signal: abort.current.signal };
  }
  const current = (version: number) => active.current && generation.current === version;
  function finish(version: number) { if (current(version)) { pending.current = false; setBusy(false); } }
  const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Chưa đọc được hóa đơn. Vui lòng thử lại.';

  async function connect() {
    if (!authReady || !clientId || !organizationId || !userId) return;
    const request = start(); if (!request) return;
    // Call synchronously from the click: awaiting script loading here would lose the popup gesture.
    const authorization = authorizeGmail(clientId);
    try {
      const access = await authorization;
      if (!current(request.version)) return;
      const email = await readGmailProfile(access, request.signal);
      if (!current(request.version)) return;
      clearMailbox(); session.current = access; setMailbox(email);
    } catch (cause) { if (current(request.version)) setError(message(cause)); }
    finally { finish(request.version); }
  }

  async function search(range: { from: string; to: string }, more = false) {
    const access = session.current;
    if (!access) { setError('Kết nối Gmail trước khi tìm hóa đơn.'); return; }
    if (access.expiresAt <= Date.now()) {
      ++generation.current; abort.current?.abort(); pending.current = false; setBusy(false); clearMailbox();
      setError('Kết nối Gmail đã hết hạn. Bấm kết nối lại để tiếp tục.'); return;
    }
    const request = start(); if (!request) return;
    const selectedRange = more && lastRange.current ? lastRange.current : range;
    try {
      const page = await listGmailBills(access, mailbox, selectedRange, more ? nextPageToken ?? undefined : undefined, request.signal);
      if (!current(request.version)) return;
      const sources = page.bills.filter(bill => bill.source.receipt_id && !bill.blocked).map(bill => bill.source);
      const already = await emailBillRepository.lookup(organizationId, sources);
      if (!current(request.version)) return;
      setBills(previous => [...new Map([...(more ? previous : []), ...page.bills].map(bill => [bill.source.message_id, bill])).values()]);
      setImported(previous => new Set([...(more ? previous : []), ...already]));
      setNextPageToken(page.nextPageToken); setFailedCount(previous => (more ? previous : 0) + page.failedCount); setSearched(true); lastRange.current = selectedRange;
    } catch (cause) { if (current(request.version)) setError(message(cause)); }
    finally { finish(request.version); }
  }
  function markImported(source: EmailBillSource) { setImported(previous => new Set([...previous, emailBillKey(source)])); }
  return { configured: !!clientId, authReady, connected: !!mailbox, mailbox, busy, error, bills, imported, nextPageToken, failedCount, searched, connect, search, markImported };
}

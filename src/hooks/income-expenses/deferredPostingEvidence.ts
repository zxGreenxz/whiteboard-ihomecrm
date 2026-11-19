// Ảnh chứng từ chọn TRƯỚC khi phiếu được lập — khối "Duyệt và Chi" của hộp chốt chi lợi nhuận cổ đông và hộp chi
// lương điều hành của chủ (chủ chốt 19/11/2026: một màn, bấm một nút là lập phiếu rồi Duyệt và Chi có ảnh).
//
// Cùng đường với hộp "Duyệt và Chi" của Thu chi / Chờ duyệt (IncomeExpensePostingDialog), không đường chứng từ mới:
//   chọn / dán ảnh → usePostingAttachmentDraft().upload: chỉ tải lên kho ảnh đính kèm (thư mục của người bấm), chưa
//     gắn phiếu nào; ô ảnh hiện ngay kèm %, tải tối đa PARALLEL_UPLOADS tấm, hỏng thì giữ tệp để "Thử lại";
//   phiếu lập xong → commitTo: MỘT lệnh annotate_income_expense_v1 thêm ảnh lên phiếu → adopt thành chứng từ
//     FINALIZED (commitPostingAttachmentChanges), chờ tối đa 20 giây như hộp Thu/Chi;
//   máy chủ không cho gắn ảnh lên phiếu (phiếu sổ tổng là hạng mục hạn chế) → ĐƯỜNG LÙI uploadFinanceEvidence: đúng
//     tệp đã nén vào kho chứng từ riêng, xoá bản trong kho ảnh (như fallbackToEvidenceStore của hộp Thu/Chi);
//   đóng hộp → huỷ lượt tải đang chạy, xoá các tệp đã tải mà chưa gắn phiếu.
// Không có ảnh cũ của phiếu, không gỡ ảnh khỏi phiếu, không hoa hồng — phiếu vừa lập chưa có ảnh nào.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { validateAttachmentFile } from '@/components/income-expenses/AttachmentUpload';
import type { EvidenceUploadStat, PendingEvidenceUpload } from '@/components/income-expenses/IncomeExpensePostingDialog';
import {
  adoptVoucherAttachmentsAsEvidence, uploadFinanceEvidence, usePostingAttachmentDraft,
} from '@/hooks/income-expenses/financeV2Mutations';
import { PARALLEL_UPLOADS } from '@/lib/evidenceUpload';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';
import { buildPostingEvidenceItems, pendingPreviewKey, type PostingEvidenceItem } from '@/lib/postingEvidenceItems';
import { warmUploadConnection } from '@/lib/storage/resilientUpload';
import { voucherOutcomeUnknown } from '@/lib/voucherFeedback';

/** Như hộp Thu/Chi (chủ chốt 30/09/2026): bước ghi ảnh lên phiếu chờ tối đa 20 giây. */
const DEFERRED_COMMIT_TIMEOUT_MS = 20_000;

const EVIDENCE_REQUIRED_MESSAGE = 'Thêm ít nhất một ảnh hoặc tệp chứng từ cho lần chi này.';

/** Kết quả chờ ảnh đang tải: `closed` — hộp đã đóng; `changed` — người dùng gỡ ảnh trong lúc chờ. */
export type DeferredUploadWait = 'ready' | 'closed' | 'changed';

export interface DeferredPostingEvidence {
  /** Ảnh đã nằm trong kho (chờ gắn phiếu) + ảnh đã gắn lên phiếu ở lượt trước. */
  items: PostingEvidenceItem[];
  /** Ảnh đã chọn mà chưa vào kho (đang tải / hỏng chờ thử lại). */
  pendingUploads: PendingEvidenceUpload[];
  localPreviews: Record<string, string>;
  uploadStats: Record<string, EvidenceUploadStat>;
  /** Số chứng từ đi đường lùi (kho chứng từ riêng, không hiện ở dòng thu chi). */
  fallbackCount: number;
  /** Ảnh / chứng từ đã sẵn (không tính ảnh đang tải) — kiểm "ít nhất một chứng từ". */
  readyCount: number;
  failedCount: number;
  /** Đang chờ ảnh tải xong sau khi bấm nút. */
  waiting: boolean;
  /** Đang ghi ảnh lên phiếu (annotate + adopt / đường lùi). */
  committing: boolean;
  addFiles: (files: FileList | File[] | null) => Promise<void>;
  /** Gỡ một ảnh vừa tải (chưa gắn phiếu): xoá luôn tệp. Ảnh đã gắn phiếu không gỡ ở đây. */
  remove: (url: string) => Promise<void>;
  retry: (id: string) => void;
  removePending: (id: string) => void;
  dropPreview: (url: string) => void;
  waitForUploads: () => Promise<DeferredUploadWait>;
  /**
   * Trước khi gửi (người bấm giữ sổ): phải có ít nhất một ảnh; ảnh đang tải thì chờ xong. Trả null khi sẵn sàng; câu
   * báo khi phải dừng; '' khi hộp đã đóng trong lúc chờ (dừng, không báo). Đọc bản mới nhất, không theo lần vẽ cũ.
   */
  ensureReady: (confirmLabel: string) => Promise<string | null>;
  /**
   * Gắn ảnh lên phiếu vừa lập rồi trả mã chứng từ cho lệnh Duyệt và Chi. Lượt trước đã gắn xong thì dùng lại đúng mã
   * đó (lệnh ghi sổ hỏng thì giao dịch lùi, chứng từ chưa bị dùng). Ném lỗi có câu tiếng Việt khi phải dừng; quá hạn
   * ⇒ FinancialWorkflowError 'unknown' (ảnh có thể đã lên phiếu — người gọi không làm tiếp, đối chiếu ở Thu chi).
   */
  commitTo: (voucherId: string, organizationId: string) => Promise<string[]>;
}

interface UploadSlots {
  active: number;
  queue: Array<() => void>;
}

function acquireSlot(slots: UploadSlots): Promise<void> {
  if (slots.active < PARALLEL_UPLOADS) {
    slots.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    slots.queue.push(() => {
      slots.active += 1;
      resolve();
    });
  });
}

function releaseSlot(slots: UploadSlots): void {
  slots.active = Math.max(0, slots.active - 1);
  slots.queue.shift()?.();
}

function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FinancialWorkflowError(
      `Mạng chậm — quá ${DEFERRED_COMMIT_TIMEOUT_MS / 1000} giây chưa xác nhận đã ghi ảnh lên phiếu. Chưa gửi lệnh duyệt và chi. Đóng hộp, mở phiếu ở Thu chi xem ảnh đã lên phiếu chưa rồi Duyệt và Chi ở đó.`,
      'unknown',
      [],
    )), DEFERRED_COMMIT_TIMEOUT_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Lỗi dừng có câu cho người dùng (không phải lỗi máy chủ cần dịch). */
export class DeferredEvidenceError extends Error {
  override readonly name = 'DeferredEvidenceError';
}

interface AppliedEvidence {
  voucherId: string;
  /** Ảnh đã nằm trên phiếu (gắn ở lượt trước trong lần mở này). */
  urls: string[];
  /** Mã chứng từ của phiếu sau lần gắn đó; null = ảnh đã lên phiếu nhưng chưa đọc được chứng từ. */
  evidenceIds: string[] | null;
}

/** `active` = hộp đang mở. Đóng hộp (active → false) hoặc gỡ component là hết một lần mở. */
export function useDeferredPostingEvidence(active: boolean): DeferredPostingEvidence {
  const { upload, commit, discard } = usePostingAttachmentDraft();

  const sessionRef = useRef(0);
  const [pendingUploads, setPendingState] = useState<PendingEvidenceUpload[]>([]);
  const pendingRef = useRef<PendingEvidenceUpload[]>([]);
  const setPending = useCallback((update: (prev: PendingEvidenceUpload[]) => PendingEvidenceUpload[]) => {
    const next = update(pendingRef.current);
    pendingRef.current = next;
    setPendingState(next);
  }, []);
  const pendingFilesRef = useRef(new Map<string, File>());
  const inFlightRef = useRef(new Map<string, { controller: AbortController; done: Promise<void> }>());
  const waitersRef = useRef(new Set<() => void>());
  const notifyInFlightChange = useCallback(() => {
    const waiters = [...waitersRef.current];
    waitersRef.current.clear();
    for (const wake of waiters) wake();
  }, []);
  const slotsRef = useRef<UploadSlots>({ active: 0, queue: [] });
  const seqRef = useRef(0);

  const [staged, setStagedState] = useState<string[]>([]);
  const stagedRef = useRef<string[]>([]);
  const setStaged = useCallback((next: string[]) => {
    stagedRef.current = next;
    setStagedState(next);
  }, []);
  /** Tệp ĐÃ NÉN của ảnh trong kho — đường lùi tải lại đúng tệp này, không tải ảnh gốc. */
  const stagedFilesRef = useRef(new Map<string, File>());

  const [applied, setAppliedState] = useState<AppliedEvidence | null>(null);
  const appliedRef = useRef<AppliedEvidence | null>(null);
  const setApplied = useCallback((next: AppliedEvidence | null) => {
    appliedRef.current = next;
    setAppliedState(next);
  }, []);
  const [fallback, setFallbackState] = useState<{ voucherId: string; ids: string[] } | null>(null);
  const fallbackRef = useRef<{ voucherId: string; ids: string[] } | null>(null);
  const setFallback = useCallback((next: { voucherId: string; ids: string[] } | null) => {
    fallbackRef.current = next;
    setFallbackState(next);
  }, []);

  const [uploadStats, setUploadStats] = useState<Record<string, EvidenceUploadStat>>({});
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({});
  const previewsRef = useRef(new Map<string, string>());
  const [waiting, setWaiting] = useState(false);
  const waitingRef = useRef(false);
  const removedWhileWaitingRef = useRef(false);
  const [committing, setCommitting] = useState(false);
  const committingRef = useRef(false);

  const addPreview = useCallback((key: string, file: File) => {
    if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return;
    let blobUrl: string;
    try {
      blobUrl = URL.createObjectURL(file);
    } catch {
      // Chỉ là ảnh xem trước: không tạo được URL tạm thì ô ảnh đọc từ kho như cũ.
      return;
    }
    previewsRef.current.set(key, blobUrl);
    setLocalPreviews(Object.fromEntries(previewsRef.current));
  }, []);
  const movePreview = useCallback((from: string, to: string) => {
    const blobUrl = previewsRef.current.get(from);
    if (!blobUrl) return;
    previewsRef.current.delete(from);
    previewsRef.current.set(to, blobUrl);
    setLocalPreviews(Object.fromEntries(previewsRef.current));
  }, []);
  const dropPreviews = useCallback((keys: string[]) => {
    for (const key of keys) {
      const blobUrl = previewsRef.current.get(key);
      if (!blobUrl) continue;
      previewsRef.current.delete(key);
      URL.revokeObjectURL(blobUrl);
    }
    setLocalPreviews(Object.fromEntries(previewsRef.current));
  }, []);

  /** Huỷ THẬT mọi lượt tải đang chạy và bỏ các ô ảnh chưa vào kho. */
  const abortPendingUploads = useCallback(() => {
    for (const { controller } of inFlightRef.current.values()) controller.abort();
    inFlightRef.current.clear();
    pendingFilesRef.current.clear();
    setPending(() => []);
    notifyInFlightChange();
  }, [setPending, notifyInFlightChange]);

  /**
   * Xoá khỏi kho mọi tệp tải lên trong lần mở này mà chưa gắn phiếu. Đang ghi ảnh dở dang thì KHÔNG xoá ở đây —
   * tệp có thể vừa nằm trên phiếu; bước ghi tự dọn khi nó hỏng.
   */
  const discardStaged = useCallback(() => {
    const urls = stagedRef.current;
    stagedRef.current = [];
    stagedFilesRef.current.clear();
    if (committingRef.current || urls.length === 0) return;
    void discard(urls);
  }, [discard]);

  const resetSession = useCallback(() => {
    for (const blobUrl of previewsRef.current.values()) URL.revokeObjectURL(blobUrl);
    previewsRef.current.clear();
    setLocalPreviews({});
    setStagedState([]);
    setUploadStats({});
    setApplied(null);
    setFallback(null);
    setWaiting(false);
  }, [setApplied, setFallback]);

  // Một lần mở = một phiên. Hết lần mở (đóng hộp, gỡ component) mà ảnh chưa gắn phiếu ⇒ tệp vừa tải là rác: xoá.
  useEffect(() => {
    if (!active) return;
    sessionRef.current += 1;
    warmUploadConnection();
    return () => {
      sessionRef.current += 1;
      abortPendingUploads();
      discardStaged();
      resetSession();
    };
  }, [active, abortPendingUploads, discardStaged, resetSession]);

  const startUpload = useCallback((id: string) => {
    const file = pendingFilesRef.current.get(id);
    if (!file) return;
    const session = sessionRef.current;
    const controller = new AbortController();
    const patch = (next: Partial<PendingEvidenceUpload>) =>
      setPending((prev) => prev.map((u) => (u.id === id ? { ...u, ...next } : u)));
    patch({ phase: 'queued', loaded: 0, attempt: 1 });
    const live = () => sessionRef.current === session && !controller.signal.aborted;
    const done = (async () => {
      await acquireSlot(slotsRef.current);
      try {
        if (!live()) return;
        patch({ phase: 'sending' });
        const res = await upload(file, {
          signal: controller.signal,
          onProgress: (p) => { if (live()) patch({ phase: p.phase, loaded: p.loaded, total: p.total, attempt: p.attempt }); },
        });
        if (!live()) {
          // Hộp đã đóng / ảnh đã bị gỡ trong lúc tải: tệp này không thuộc lần mở nào.
          if (res) void discard([res.url]);
          return;
        }
        if (!res) {
          patch({ phase: 'failed' }); // lý do đã được toast; tệp còn giữ để thử lại
          return;
        }
        pendingFilesRef.current.delete(id);
        setPending((prev) => prev.filter((u) => u.id !== id));
        stagedFilesRef.current.set(res.url, res.file);
        setStaged([...stagedRef.current, res.url]);
        movePreview(pendingPreviewKey(id), res.url);
        setUploadStats((prev) => ({ ...prev, [res.url]: { size: res.size, elapsedMs: res.elapsedMs } }));
      } finally {
        releaseSlot(slotsRef.current);
        if (inFlightRef.current.get(id)?.controller === controller) inFlightRef.current.delete(id);
        notifyInFlightChange();
      }
    })();
    inFlightRef.current.set(id, { controller, done });
  }, [upload, discard, setPending, setStaged, movePreview, notifyInFlightChange]);

  const addFiles = useCallback(async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files as ArrayLike<File>) : [];
    if (list.length === 0) return;
    warmUploadConnection();
    for (const file of list) {
      const invalid = validateAttachmentFile(file, { compressFirst: true });
      if (invalid) {
        toast.error(`“${file.name}”: ${invalid}`);
        continue;
      }
      seqRef.current += 1;
      const id = `u${seqRef.current}`;
      pendingFilesRef.current.set(id, file);
      addPreview(pendingPreviewKey(id), file);
      setPending((prev) => [...prev, { id, name: file.name, loaded: 0, total: file.size, attempt: 1, phase: 'queued' }]);
      startUpload(id);
    }
  }, [addPreview, setPending, startUpload]);

  const remove = useCallback(async (url: string) => {
    if (!stagedRef.current.includes(url)) return;
    setStaged(stagedRef.current.filter((u) => u !== url));
    stagedFilesRef.current.delete(url);
    dropPreviews([url]);
    await discard([url]);
  }, [discard, dropPreviews, setStaged]);

  const removePending = useCallback((id: string) => {
    if (waitingRef.current) removedWhileWaitingRef.current = true;
    inFlightRef.current.get(id)?.controller.abort();
    inFlightRef.current.delete(id);
    pendingFilesRef.current.delete(id);
    dropPreviews([pendingPreviewKey(id)]);
    setPending((prev) => prev.filter((u) => u.id !== id));
    notifyInFlightChange();
  }, [dropPreviews, setPending, notifyInFlightChange]);

  const dropPreview = useCallback((url: string) => { dropPreviews([url]); }, [dropPreviews]);

  const waitForUploads = useCallback(async (): Promise<DeferredUploadWait> => {
    if (inFlightRef.current.size === 0) return 'ready';
    const session = sessionRef.current;
    waitingRef.current = true;
    removedWhileWaitingRef.current = false;
    setWaiting(true);
    try {
      while (inFlightRef.current.size > 0 && sessionRef.current === session) {
        const changed = new Promise<void>((wake) => { waitersRef.current.add(wake); });
        await Promise.race([Promise.allSettled([...inFlightRef.current.values()].map((u) => u.done)), changed]);
      }
    } finally {
      waitingRef.current = false;
      if (sessionRef.current === session) setWaiting(false);
    }
    if (sessionRef.current !== session) return 'closed';
    if (removedWhileWaitingRef.current) {
      removedWhileWaitingRef.current = false;
      return 'changed';
    }
    return 'ready';
  }, []);

  const ensureReady = useCallback(async (confirmLabel: string): Promise<string | null> => {
    const readyNow = () => stagedRef.current.length + (appliedRef.current?.urls.length ?? 0) + (fallbackRef.current?.ids.length ?? 0);
    const waited = await waitForUploads();
    if (waited === 'closed') return '';
    if (waited === 'changed') {
      // Bộ ảnh đã khác lúc bấm: không tự chi bằng phần còn lại.
      return `Bạn vừa gỡ ảnh trong lúc chờ tải — kiểm tra lại ảnh chứng từ rồi bấm “${confirmLabel}” lần nữa.`;
    }
    const failed = pendingRef.current.filter((u) => u.phase === 'failed').length;
    if (failed > 0) return `Còn ${failed} ảnh chưa tải được. Bấm “Thử lại” trên ảnh đó, hoặc gỡ ảnh rồi bấm “${confirmLabel}”.`;
    if (readyNow() === 0) return EVIDENCE_REQUIRED_MESSAGE;
    return null;
  }, [waitForUploads]);

  const commitTo = useCallback(async (voucherId: string, organizationId: string): Promise<string[]> => {
    const prior = appliedRef.current?.voucherId === voucherId ? appliedRef.current : null;
    const priorFallback = fallbackRef.current?.voucherId === voucherId ? fallbackRef.current.ids : [];
    const add = [...stagedRef.current];
    if (add.length === 0) {
      if (!prior) return [...priorFallback];
      if (prior.evidenceIds) return [...prior.evidenceIds, ...priorFallback];
      // Lượt trước ảnh đã lên phiếu mà chưa đọc được chứng từ ⇒ đọc lại (adopt chỉ nhận ảnh đang nằm trên phiếu).
      const adopted = await adoptVoucherAttachmentsAsEvidence(voucherId);
      setApplied({ ...prior, evidenceIds: adopted.evidenceIds });
      return [...adopted.evidenceIds, ...priorFallback];
    }
    const session = sessionRef.current;
    committingRef.current = true;
    setCommitting(true);
    try {
      const res = await withDeadline(commit(voucherId, { add, remove: [] }));
      if (sessionRef.current !== session) {
        // Hộp bị đóng giữa chừng: gắn được thì tệp đã thuộc phiếu — giữ; không gắn được thì là rác.
        if (!res.ok) void discard(add);
        throw new DeferredEvidenceError('Hộp đã đóng trong lúc ghi ảnh lên phiếu — mở phiếu ở Thu chi để Duyệt và Chi.');
      }
      if (res.ok) {
        // Từ đây ảnh đã nằm trên phiếu — KHÔNG còn là rác.
        setStaged(stagedRef.current.filter((u) => !add.includes(u)));
        for (const u of add) stagedFilesRef.current.delete(u);
        const urls = [...(prior?.urls ?? []), ...add];
        if (res.evidenceReadFailed) {
          setApplied({ voucherId, urls, evidenceIds: null });
          throw new DeferredEvidenceError(res.message ?? 'Ảnh đã lưu trên phiếu nhưng chưa kiểm tra được chứng từ. Bấm "Làm tiếp" để đọc lại.');
        }
        setApplied({ voucherId, urls, evidenceIds: res.evidenceIds });
        return [...res.evidenceIds, ...priorFallback];
      }
      if (res.periodBlocked) throw new DeferredEvidenceError(res.message ?? 'Kỳ đã đóng — không ghi được ảnh lên phiếu.');
      // ĐƯỜNG LÙI (như hộp Thu/Chi): máy chủ không cho gắn ảnh lên phiếu ⇒ kho chứng từ riêng bằng đúng tệp đã nén;
      // thà ảnh không hiện ở dòng thu chi còn hơn chặn việc chi tiền.
      const ids: string[] = [];
      const moved: string[] = [];
      for (const url of add) {
        const file = stagedFilesRef.current.get(url);
        const id = file ? await uploadFinanceEvidence(file, organizationId) : null;
        if (!id) break; // uploadFinanceEvidence đã báo lý do
        ids.push(id);
        moved.push(url);
      }
      if (sessionRef.current !== session) {
        void discard(add);
        throw new DeferredEvidenceError('Hộp đã đóng trong lúc lưu chứng từ — mở phiếu ở Thu chi để Duyệt và Chi.');
      }
      const fallbackIds = [...priorFallback, ...ids];
      if (moved.length > 0) {
        setStaged(stagedRef.current.filter((u) => !moved.includes(u)));
        for (const u of moved) stagedFilesRef.current.delete(u);
        dropPreviews(moved);
        void discard(moved);
        setFallback({ voucherId, ids: fallbackIds });
      }
      if (moved.length < add.length) {
        throw new DeferredEvidenceError(`Chưa lưu được ảnh chứng từ: ${res.message ?? 'không gắn được ảnh lên phiếu'}. Kiểm tra ảnh rồi bấm "Làm tiếp".`);
      }
      toast.warning('Ảnh đã lưu làm chứng từ, nhưng chưa đính được lên phiếu (thiếu quyền sửa) — nó sẽ không hiện ở dòng thu chi.');
      return [...(prior?.evidenceIds ?? []), ...fallbackIds];
    } catch (error) {
      if (voucherOutcomeUnknown(error) && sessionRef.current === session) {
        // Chưa biết ảnh đã lên phiếu chưa: không còn coi là rác (đóng hộp không xoá).
        setStaged(stagedRef.current.filter((u) => !add.includes(u)));
        setApplied({ voucherId, urls: [...(prior?.urls ?? []), ...add], evidenceIds: null });
      }
      throw error;
    } finally {
      committingRef.current = false;
      if (sessionRef.current === session) setCommitting(false);
    }
  }, [commit, discard, dropPreviews, setApplied, setFallback, setStaged]);

  const items = useMemo(() => buildPostingEvidenceItems({
    attachments: applied?.urls ?? [],
    sessionUploaded: staged,
    skipped: [],
  }), [applied, staged]);
  const fallbackCount = fallback?.ids.length ?? 0;
  const failedCount = pendingUploads.filter((u) => u.phase === 'failed').length;

  return {
    items,
    pendingUploads,
    localPreviews,
    uploadStats,
    fallbackCount,
    readyCount: items.length + fallbackCount,
    failedCount,
    waiting,
    committing,
    addFiles,
    remove,
    retry: startUpload,
    removePending,
    dropPreview,
    waitForUploads,
    ensureReady,
    commitTo,
  };
}

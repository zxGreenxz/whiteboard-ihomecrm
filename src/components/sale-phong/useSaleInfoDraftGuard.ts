import { useEffect, useRef, useState } from 'react';

/** Legacy sale editors keep local input across refetches; changing entity is explicit. */
export function useSaleInfoDraftGuard(
  entityId: string,
  sourceSnapshot: string,
  draftSnapshot: string,
  busy: boolean,
  resetFromSource: () => void,
) {
  const baseline = useRef<{ id: string; source: string; draft: string }>();
  const current = useRef({ entityId, sourceSnapshot, draftSnapshot, busy, resetFromSource });
  current.current = { entityId, sourceSnapshot, draftSnapshot, busy, resetFromSource };
  const [, refresh] = useState(0);
  const dirty = baseline.current?.id === entityId && baseline.current.draft !== draftSnapshot;
  const stale = dirty && baseline.current?.source !== sourceSnapshot;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!busy && !dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy, dirty]);
  useEffect(() => {
    const latest = current.current;
    const previous = baseline.current;
    if (previous?.id === entityId && (latest.busy || previous.draft !== latest.draftSnapshot
      || previous.source === sourceSnapshot)) return;
    baseline.current = { id: entityId, source: sourceSnapshot, draft: sourceSnapshot };
    latest.resetFromSource();
    // A refetch deferred during upload (or while dirty) must be adopted once
    // that guard clears. An unchanged source must not undo a confirmed save.
  }, [entityId, sourceSnapshot, busy, dirty]);
  const reload = () => {
    if (current.current.busy) return;
    baseline.current = { id: entityId, source: sourceSnapshot, draft: sourceSnapshot };
    current.current.resetFromSource();
    refresh(value => value + 1);
  };
  const markSaved = () => {
    baseline.current = { id: entityId, source: sourceSnapshot, draft: draftSnapshot };
    refresh(value => value + 1);
  };
  return { dirty, stale, reload, markSaved };
}

export interface SaleInfoDraftState { dirty: boolean; busy: boolean }
export const confirmSaleInfoSwitch = (dirty: boolean) => !dirty || window.confirm('Còn thông tin sale chưa lưu. Bỏ bản nháp này và chuyển sang phòng/toà khác?');

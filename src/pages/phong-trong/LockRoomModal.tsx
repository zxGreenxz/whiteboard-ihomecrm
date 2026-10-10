import React, { useEffect, useState } from 'react';
import { useLockRoomForSale, useReleaseRoomSaleLock } from '@/hooks/useRoomSaleLocks';
import {
  SALE_LOCK_HOURS, SALE_LOCK_NOTE_MAX, saleLockErrorMessage, saleLockRemaining, type SaleLockHours,
} from '@/lib/roomSaleLockRpc';
import { Icon } from './icons';
import { fmtPrice, type Room } from './sampleData';

export interface SaleLockAction { room: Room; mode: 'lock' | 'release' }

/** "2026-10-11T03:00:00Z" → "10:00 11/10" theo giờ máy người dùng. */
function untilLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/**
 * Lock tạm 6/12/24 giờ (ẩn phòng khỏi danh sách sale, không khách/tiền/phiếu) hoặc gỡ lock.
 * Chỉ mount khi người dùng đã đăng nhập và có quyền: hook mutation đọc tổ chức đang chọn.
 */
export function LockRoomModal({ action, onClose, onDone }: {
  action: SaleLockAction | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const lock = useLockRoomForSale();
  const release = useReleaseRoomSaleLock();
  const [hours, setHours] = useState<SaleLockHours>(24);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const submitting = lock.isPending || release.isPending;
  const roomId = action?.room.id;
  const mode = action?.mode;
  useEffect(() => { setHours(24); setNote(''); setError(''); }, [roomId, mode]);
  if (!action) return null;
  const { room } = action;
  const label = room.code || String(room.no);
  const saleLock = room.saleLock;

  async function submit() {
    if (submitting) return;
    setError('');
    try {
      if (mode === 'lock') {
        const saved = await lock.mutateAsync({ roomId: room.id, hours, note: note.trim() || null });
        onDone(`Đã lock phòng ${label} đến ${untilLabel(saved.expires_at)}`);
      } else if (saleLock) {
        await release.mutateAsync(saleLock.id);
        onDone(`Đã gỡ lock phòng ${label}`);
      }
      onClose();
    } catch (e) {
      setError(saleLockErrorMessage(e));
    }
  }

  const title = mode === 'lock' ? 'Lock tạm phòng' : 'Gỡ lock phòng';
  return (
    <>
      <div className="qd-scrim show" onClick={submitting ? undefined : onClose} />
      <div className="qd-modal show" role="dialog" aria-modal="true" aria-label={title}>
        <div className="qd-head">
          <div className="qd-title"><Icon.Lock /><span>{title}</span></div>
          <button className="qd-x" onClick={onClose} aria-label="Đóng" disabled={submitting}><Icon.Close /></button>
        </div>
        <div className="qd-body">
          <div className="qd-room">
            <span className="qd-room-name">Phòng {label} · Tòa {room.buildingName}</span>
            <span className="qd-room-price">{fmtPrice(room.price)} tr/th</span>
          </div>
          {mode === 'lock' ? (
            <>
              <div className="qd-field">
                <span className="qd-field-lbl" id="lock-hours-lbl">Lock trong</span>
                <div className="qd-hours" role="radiogroup" aria-labelledby="lock-hours-lbl">
                  {SALE_LOCK_HOURS.map((h) => (
                    <button key={h} type="button" role="radio" aria-checked={hours === h} className="qd-hour"
                      onClick={() => setHours(h)} disabled={submitting}>{h} giờ</button>
                  ))}
                </div>
              </div>
              <label className="qd-field">
                <span className="qd-field-lbl">Ghi chú <i>(tùy chọn)</i></span>
                <input className="qd-input" value={note} maxLength={SALE_LOCK_NOTE_MAX} placeholder="VD: khách anh Tuấn hẹn chiều mai cọc"
                  onChange={(e) => setNote(e.target.value)} disabled={submitting} />
              </label>
              <p className="qd-hint">
                Phòng ẩn khỏi danh sách sale ngay, không tạo phiếu, không thu tiền. Hết {hours} giờ mà chưa ai tạo phiếu cọc thì phòng tự hiện lại.
              </p>
            </>
          ) : saleLock ? (
            <p className="qd-hint">
              Lock bởi {saleLock.lockedByMe ? 'bạn' : saleLock.lockedByName}, {saleLockRemaining(saleLock.expiresAt)}
              {saleLock.note ? ` · ${saleLock.note}` : ''}. Gỡ lock thì phòng hiện lại trên danh sách sale ngay.
            </p>
          ) : (
            <p className="qd-hint">Phòng không còn lock tạm.</p>
          )}
          {error && <p role="alert" className="qd-err">{error}</p>}
        </div>
        <div className="qd-actions">
          <button className="qd-btn qd-cancel" onClick={onClose} disabled={submitting}>Hủy</button>
          <button className="qd-btn qd-submit" onClick={submit} disabled={submitting || (mode === 'release' && !saleLock)}>
            {submitting ? 'Đang lưu…' : mode === 'lock' ? `Lock ${hours} giờ` : 'Gỡ lock'}
          </button>
        </div>
      </div>
    </>
  );
}

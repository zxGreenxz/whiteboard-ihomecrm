// =============================================
// RoomLifecycleSheet — panel "Chu trình phòng" trên /thu-tien
// (Plan 2 Task 7 Step 4, sau khi Task 6A ship read model).
//
// Khuôn sheet/scrim giống HandoverSheet. Chọn phòng của toà đang lọc →
// LifecycleTimeline vẽ toàn bộ vòng đời: thanh hợp đồng, khoảng trống, mốc
// tiền. ĐỌC-ONLY — panel này không ghi gì, và cố ý KHÔNG vào registry
// FEE_CATEGORIES (plan: "Chu trình phòng KHÔNG vào registry").
// =============================================

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useRooms } from '@/hooks/useRooms';
import { useRoomCashLifecycle } from '@/hooks/useRoomCashLifecycle';
import { LifecycleTimeline } from './LifecycleTimeline';

interface Props {
  show: boolean;
  onClose: () => void;
  /** Toà đang lọc trên /thu-tien — '' = chưa chọn toà. */
  buildingId: string;
  buildings: { id: string; name: string }[];
}

export function RoomLifecycleSheet({ show, onClose, buildingId, buildings }: Props) {
  // Toà xem trong sheet: mặc định theo toà đang lọc ngoài trang, đổi được.
  const [localBuilding, setLocalBuilding] = useState<string>('');
  const effBuilding = localBuilding || buildingId || buildings[0]?.id || '';

  const { data: rooms = [], isLoading: roomsLoading } = useRooms(effBuilding || undefined, {
    enabled: show && !!effBuilding,
  });
  const [roomId, setRoomId] = useState<string | null>(null);
  // Phòng đã chọn phải thuộc toà đang xem — đổi toà thì mời chọn lại.
  const effRoom = useMemo(
    () => (roomId && rooms.some((r: { id: string }) => r.id === roomId) ? roomId : null),
    [roomId, rooms],
  );

  const lifecycle = useRoomCashLifecycle(show ? effRoom : null);

  return (
    <>
      <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={onClose} />
      <div className={'sheet full' + (show ? ' show' : '')}>
        <div className="rp-topbar">
          <div>
            <div className="rp-title">Chu trình phòng</div>
            <div className="rp-sub">Toàn bộ vòng đời hợp đồng của một phòng trên trục thời gian</div>
          </div>
          <button type="button" className="rp-x" onClick={onClose}>
            <X />
          </button>
        </div>

        <div className="sheet-scroll rp-body">
          <div className="ho-form" style={{ paddingBottom: 0 }}>
            <label className="rp-dd">
              <span className="rp-dd-l">Toà nhà</span>
              <div className="rp-dd-sel">
                <select
                  value={effBuilding}
                  onChange={(e) => {
                    setLocalBuilding(e.target.value);
                    setRoomId(null);
                  }}
                >
                  {buildings.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            </label>
            <label className="rp-dd">
              <span className="rp-dd-l">Phòng</span>
              <div className="rp-dd-sel">
                <select
                  value={effRoom ?? ''}
                  onChange={(e) => setRoomId(e.target.value || null)}
                >
                  <option value="">
                    {roomsLoading ? 'Đang tải phòng…' : '— chọn phòng —'}
                  </option>
                  {rooms.map((r: { id: string; name: string }) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            </label>
          </div>

          {!effRoom ? (
            <div className="rl-empty">Chọn một phòng để xem chu trình.</div>
          ) : lifecycle.isLoading ? (
            <div className="rl-empty">Đang dựng timeline…</div>
          ) : lifecycle.isError ? (
            // 42501 (không có quyền xem toà) phải hiện nguyên văn — RPC fail-closed,
            // client không được dịch thành "phòng trống trơn".
            <div className="rl-problem">
              Không đọc được chu trình phòng:{' '}
              {lifecycle.error instanceof Error ? lifecycle.error.message : 'lỗi không rõ'}
            </div>
          ) : lifecycle.data ? (
            <LifecycleTimeline payload={lifecycle.data} />
          ) : null}
        </div>
      </div>
    </>
  );
}

// =============================================================================
// ContractLifecycleBand — dải "Vòng đời hợp đồng của phòng".
//
// Dùng CHUNG cho hồ sơ khoản chi và hồ sơ biến động. Tách ra vì hai màn phải
// hiện y hệt một dòng thời gian; để hai bản sao là mời lệch số. ĐỪNG fork nó.
//
// NHIỀU LANE theo lịch sử phòng: hợp đồng liền trước · hợp đồng của phiếu hoặc
// của biến động · hợp đồng kế tiếp · hợp đồng hiện tại. Bốn mốc mỗi lane, chữ
// lấy nguyên văn từ mẫu thiết kế (dòng 346–396 và 601–628).
//
// ⚠ Component này KHÔNG tính tiền. Mọi con số và mọi nhãn đã do
// `src/lib/contractLifecycle.ts` quyết định và đã có unit test. Ở đây chỉ vẽ.
//
// ⚠ Lỗi, thiếu quyền và số 0 là BA THỨ KHÁC NHAU và phải nhìn khác nhau.
// =============================================================================

import { useContractLifecycle } from '@/hooks/useContractLifecycle';
import type { LaneSubject, SectionStatus } from '@/lib/contractLifecycle';

interface Props {
  organizationId: string | null;
  roomId: string | null;
  /** Hợp đồng ĐÍCH — của phiếu đang mở hoặc của biến động đang xem. */
  contractId: string | null;
  subject: LaneSubject;
  /** Mốc ngày nghiệp vụ ('YYYY-MM-DD') — không lấy đồng hồ trong component. */
  businessDate: string;
  /** Chữ bên trái chân dải: 'Phiếu đang xem' hoặc 'Nguồn'. */
  sourceLabel: string;
  sourceText: string;
  /**
   * Dòng nhấn ở mốc thanh lý của lane đích. CHỈ dùng cho PHIẾU HOÀN — bản cũ
   * gắn nó cho mọi loại nên phiếu hoa hồng cũng hiện "Còn hoàn: <số hoa hồng>",
   * tức lấy số hoa hồng dán nhãn hoàn (Plan §3.2 cấm).
   */
  ghiChuHoan?: { text: string; mau: string } | null;
  hint?: string;
}

const laPhieuHoan = (s: LaneSubject) => s.kind === 'voucher' && s.voucherKind === 'refund';

/** Một dòng cảnh báo cho mỗi phần chưa chứng minh được. */
function DongTrangThai({ ten, st }: { ten: string; st: SectionStatus }) {
  if (st.kind === 'sufficient') return null;
  return (
    <div className="cs-life-warn" style={{ color: st.kind === 'error' ? 'var(--c-unpaid)' : 'var(--c-partial)' }}>
      <b>{ten}:</b> {st.reason}
    </div>
  );
}

export function ContractLifecycleBand({
  organizationId, roomId, contractId, subject, businessDate,
  sourceLabel, sourceText, ghiChuHoan, hint,
}: Props) {
  const q = useContractLifecycle({
    organizationId, roomId, targetContractId: contractId, subject, businessDate,
  });
  const v = q.data;

  return (
    <div className="cs-life">
      <div className="cs-life-top">
        <b>Vòng đời hợp đồng của phòng</b>
        <span>
          {q.isLoading ? 'Đang tra lịch sử phòng…'
            : q.isError ? 'Không đọc được lịch sử phòng — số liệu bên dưới chưa đầy đủ.'
            : !contractId ? 'Chưa gắn hợp đồng nên không dựng được vòng đời.'
            : !v ? 'Không tìm thấy hợp đồng.'
            : hint ?? 'Số liệu dựng từ chính các phiếu cọc, hoá đơn và bản ghi thanh lý'}
        </span>
      </div>

      {v && v.lanes.map((lane) => (
        <div className={`cs-lane${lane.target ? ' target' : ''}`} key={lane.contractId}>
          <div className="cs-lane-head">
            <span className="cs-role">{lane.role}</span>
            <b>{lane.contractNumber ?? '—'}</b>
            <span style={{ color: 'var(--ink-2)' }}>{lane.customer}</span>
            <span className="cs-lane-gap" />
            {!lane.trusted && (
              <span className="cs-tag" style={{ background: 'var(--line-2)', color: 'var(--c-partial)' }}>
                Lịch sử chưa tin cậy
              </span>
            )}
            <span className="cs-tag" style={{
              background: lane.tag === 'HĐ hiện tại' ? 'var(--brand-50)' : 'var(--line-2)',
              color: lane.tag === 'HĐ hiện tại' ? 'var(--brand)' : 'var(--ink-2)',
            }}>
              {lane.tag}
            </span>
          </div>
          <div className="cs-steps">
            {lane.steps.map((b, i) => {
              // Dòng nhấn của mốc cuối trên lane ĐÍCH: chỉ phiếu hoàn mới được
              // nói chuyện "đã hoàn / còn hoàn".
              const m2 = i === lane.steps.length - 1 && lane.target && ghiChuHoan && laPhieuHoan(subject)
                ? ghiChuHoan.text : b.m2;
              const m2c = i === lane.steps.length - 1 && lane.target && ghiChuHoan && laPhieuHoan(subject)
                ? ghiChuHoan.mau : b.m2c;
              return (
                <div className="cs-step" key={`${lane.contractId}:${i}`}>
                  <div className="cs-step-h">{b.h}</div>
                  <div className="cs-step-v">{b.v}</div>
                  <div className="cs-step-m">{b.m}</div>
                  {m2 && <div className="cs-step-m2" style={{ color: m2c }}>{m2}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {v && (
        <>
          <DongTrangThai ten="Lịch sử phòng" st={v.status.lanes} />
          <DongTrangThai ten="Nguồn cọc" st={v.status.deposit} />
          <DongTrangThai ten="Tiền thuê / phí" st={v.status.rent} />
          <DongTrangThai ten="Đối chiếu bút toán" st={v.status.postings} />
          <div className="cs-life-foot">
            <span>Phòng hiện tại: <b>{v.roomState.label}</b></span>
            <span>{sourceLabel}: <b className="mono">{sourceText}</b></span>
          </div>
        </>
      )}
    </div>
  );
}

// =============================================
// LifecycleTimeline — phần VẼ thuần của panel Chu trình phòng.
//
// Toàn bộ toán (miền trục, vị trí %, lane, kiểm vacancy) nằm ở
// src/lib/roomLifecycle.ts và có unit test riêng — component này chỉ đổ số ra
// hình. Trên khung điện thoại của /thu-tien: khối LANE ngang ở trên (mỗi hợp
// đồng một thanh, khoảng trống tô đỏ nhạt trên rãnh nền), CHUỖI SỰ KIỆN dọc ở
// dưới (mốc + nhãn + tiền) — đúng "desktop lane / mobile sequence" của plan,
// gói trong một layout vì sheet luôn hẹp.
// =============================================

import { useMemo } from 'react';
import {
  buildLanes, datePercent, eventLabel, timelineDomain, vacancyProblems,
  type LifecyclePayload,
} from '@/lib/roomLifecycle';
import './room-lifecycle.css';

const fmtMoney = (n: number) => Math.round(n).toLocaleString('vi-VN') + 'đ';
const fmtDate = (d: string) => {
  const t = new Date(d);
  return `${String(t.getDate()).padStart(2, '0')}/${String(t.getMonth() + 1).padStart(2, '0')}/${t.getFullYear()}`;
};
const todayISO = () => new Date().toISOString().slice(0, 10);

export function LifecycleTimeline({ payload }: { payload: LifecyclePayload }) {
  const today = todayISO();
  const domain = useMemo(
    () => timelineDomain(payload, today),
    [payload, today],
  );
  const lanes = useMemo(
    () => (domain ? buildLanes(payload, domain, today) : []),
    [payload, domain, today],
  );
  const problems = useMemo(() => vacancyProblems(payload), [payload]);
  // Sự kiện mới nhất lên đầu — người dùng thường hỏi "gần đây phòng này có gì".
  const eventsDesc = useMemo(
    () => payload.events.slice().sort((a, b) => (a.date < b.date ? 1 : -1)),
    [payload.events],
  );

  if (!domain) {
    return (
      <div className="rl-empty">
        Phòng này chưa có hợp đồng hay giao dịch nào — chưa có gì để vẽ.
      </div>
    );
  }

  const yearMarks = yearTicks(domain.min, domain.max);

  return (
    <div className="rl-wrap">
      {/* Server tính vacancy, client XÁC MINH — số không khớp thì nói thẳng
          thay vì vẽ bừa (fail-closed về hiển thị). */}
      {problems.length > 0 && (
        <div className="rl-problem">
          ⚠ Số liệu khoảng trống không tự khớp ({problems.length} vấn đề) — phần
          tô đỏ bên dưới chỉ mang tính tham khảo. Chi tiết đầu tiên: {problems[0]}
        </div>
      )}

      <div className="rl-lanes">
        {/* mốc năm */}
        <div className="rl-axis">
          {yearMarks.map((m) => (
            <span key={m.label} className="rl-tick" style={{ left: `${m.left}%` }}>
              {m.label}
            </span>
          ))}
        </div>

        {/* rãnh nền + khoảng trống */}
        <div className="rl-base">
          {payload.vacancies.map((v, i) => {
            const left = datePercent(v.fromDate, domain);
            const right = datePercent(v.toDate ?? today, domain);
            return (
              <span
                key={i}
                className="rl-vacancy"
                style={{ left: `${left}%`, width: `${Math.max(right - left, 0.4)}%` }}
                title={`Trống ${v.days} ngày · ${fmtDate(v.fromDate)} → ${v.toDate ? fmtDate(v.toDate) : 'nay'}`}
              />
            );
          })}
        </div>

        {lanes.map((lane) => (
          <div key={lane.contractId} className="rl-lane">
            <div className="rl-lane-label">
              <span className="rl-hd">{lane.contractNumber ?? lane.contractId.slice(0, 8)}</span>
              {lane.contract?.tenantName && <span className="rl-tenant">{lane.contract.tenantName}</span>}
            </div>
            <div className="rl-track">
              {lane.bars.map((b) => (
                <span
                  key={b.segIndex}
                  className={
                    'rl-bar' +
                    (b.openEnded ? ' open' : '') +
                    (b.trusted ? '' : ' untrusted') +
                    (b.openStarted ? ' nostart' : '')
                  }
                  style={{ left: `${b.left}%`, width: `${b.width}%` }}
                  title={
                    (b.trusted ? '' : '⚠ chuỗi mốc không đáng tin — ') +
                    (lane.contract?.status ?? '') +
                    (b.sourcePath ? ` · ${b.sourcePath}` : '')
                  }
                />
              ))}
              {/* chấm sự kiện của hợp đồng này */}
              {payload.events
                .filter((e) => e.contractId === lane.contractId && e.amount != null)
                .map((e, i) => {
                  const info = eventLabel(e.type);
                  return (
                    <span
                      key={`${e.type}-${e.date}-${i}`}
                      className={`rl-dot tone-${info.tone}${e.trusted ? '' : ' untrusted'}`}
                      style={{ left: `${datePercent(e.date, domain)}%` }}
                      title={`${info.label} · ${fmtDate(e.date)}${e.amount != null ? ` · ${fmtMoney(e.amount)}` : ''}`}
                    />
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      <div className="rl-legend">
        <span><i className="rl-bar-sample" /> đang ở / đã ở</span>
        <span><i className="rl-bar-sample untrusted" /> mốc không đáng tin</span>
        <span><i className="rl-vac-sample" /> phòng trống</span>
        <span><i className="rl-dot-sample tone-in" /> tiền vào</span>
        <span><i className="rl-dot-sample tone-out" /> tiền ra</span>
      </div>

      {/* Chuỗi sự kiện dọc */}
      <div className="rl-feed">
        {eventsDesc.map((e, i) => {
          const info = eventLabel(e.type);
          const contract = payload.contracts.find((c) => c.id === e.contractId);
          return (
            <div key={`${e.type}-${e.date}-${i}`} className={`rl-item tone-${info.tone}`}>
              <span className="rl-item-date">{fmtDate(e.date)}</span>
              <span className="rl-item-dot" />
              <span className="rl-item-body">
                <b>{info.label}</b>
                {contract?.number && <em> · {contract.number}</em>}
                {e.amount != null && e.amount !== 0 && (
                  <span className="rl-item-amount">{fmtMoney(e.amount)}</span>
                )}
                {!e.trusted && <span className="rl-item-warn"> · chưa vào sổ thật</span>}
              </span>
            </div>
          );
        })}
        {eventsDesc.length === 0 && <div className="rl-empty">Không có sự kiện nào trong khoảng đã chọn.</div>}
      </div>
    </div>
  );
}

/** Mốc năm trên trục (tối đa ~6 nhãn cho khỏi chèn nhau trong khung hẹp). */
function yearTicks(minMs: number, maxMs: number): { label: string; left: number }[] {
  const out: { label: string; left: number }[] = [];
  const y0 = new Date(minMs).getFullYear();
  const y1 = new Date(maxMs).getFullYear();
  const step = Math.max(1, Math.ceil((y1 - y0) / 6));
  for (let y = y0; y <= y1; y += step) {
    const t = new Date(`${y}-01-01`).getTime();
    if (t < minMs || t > maxMs) continue;
    out.push({ label: String(y), left: ((t - minMs) / (maxMs - minMs)) * 100 });
  }
  return out;
}

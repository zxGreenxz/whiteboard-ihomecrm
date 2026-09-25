// =============================================
// RoomContractLifecycleDrawer — Báo cáo Lợi Nhuận: bấm SỐ PHÒNG ở cột Khoản thu
// → panel phải "Vòng đời hợp đồng" của phòng trong năm; bấm một hợp đồng → chi
// tiết từ ngày vào tới ngày ra. Bản dựng theo mock Claude Design
// "Bao cao Loi Nhuan - Vong doi HD.dc.html".
//
// ĐỌC-ONLY. Toán nằm ở `@/lib/roomContractYear` (unit test); ở đây chỉ nối hook
// và vẽ. Tiền lấy từ `useContractLifecycle` — chưa chứng minh thì ghi
// "Chưa đủ dữ liệu", không in 0.
// =============================================

import { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeft, ChevronLeft, ChevronRight, LogIn, LogOut, X } from 'lucide-react';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useRoomCashLifecycle } from '@/hooks/useRoomCashLifecycle';
import { useContractLifecycle } from '@/hooks/useContractLifecycle';
import { useRoomContractExtras } from '@/hooks/useRoomContractExtras';
import { vnTodayISO } from '@/lib/vnDate';
import {
  END_LABEL, buildContractDetail, buildRoomYear,
  type EndKind, type EventKind, type Kpi, type LaneSource, type Tone,
} from '@/lib/roomContractYear';
import type { Lane } from '@/lib/contractLifecycle';
import './roomContractLifecycle.css';

// Bảng màu theo cách kết thúc — đúng ST của mock.
const KIND: Record<EndKind, { ink: string; bg: string; bar: string; ganttInk: string }> = {
  active: { ink: '#0e5c38', bg: '#dff3e9', bar: '#2fbf7f', ganttInk: '#06281b' },
  ontime: { ink: '#3f4f47', bg: '#eff3f0', bar: '#b9c6bf', ganttInk: '#14231c' },
  early: { ink: '#92400e', bg: '#fef3c7', bar: '#f5c77e', ganttInk: '#5c2a06' },
  forfeit: { ink: '#b91c1c', bg: '#fdecec', bar: '#f19a9a', ganttInk: '#5f0f0f' },
  room: { ink: '#6d28d9', bg: '#efe9fc', bar: '#c4b1f2', ganttInk: '#2e1065' },
  expired: { ink: '#9f1239', bg: '#fbe3e9', bar: '#f3b6c6', ganttInk: '#4c0519' },
};
const LEGEND: { kind: EndKind; label: string }[] = [
  { kind: 'active', label: END_LABEL.active },
  { kind: 'ontime', label: END_LABEL.ontime },
  { kind: 'early', label: END_LABEL.early },
  { kind: 'forfeit', label: END_LABEL.forfeit },
  { kind: 'room', label: END_LABEL.room },
  { kind: 'expired', label: END_LABEL.expired },
];
const TONE: Record<Tone, { ink: string; bg: string }> = {
  green: { ink: '#0e5c38', bg: '#dff3e9' },
  red: { ink: '#b91c1c', bg: '#fdecec' },
  amber: { ink: '#92400e', bg: '#fef3c7' },
  neutral: { ink: '#3f4f47', bg: '#eff3f0' },
  purple: { ink: '#6d28d9', bg: '#efe9fc' },
  pink: { ink: '#9f1239', bg: '#fbe3e9' },
};
const TEXT: Record<Tone | 'ink' | 'muted' | 'orange', string> = {
  green: '#047857', red: '#b91c1c', amber: '#b45309', neutral: '#6b7a73', purple: '#6d28d9',
  pink: '#9f1239', ink: '#14231c', muted: '#8a9992', orange: '#c2410c',
};
const KPI_COLOR: Record<Kpi['tone'], string> = { white: '#fff', mint: '#7fe0b4', gold: '#ffd98a', peach: '#ffb27a' };
const DOT: Record<EventKind, string> = {
  dep: '#0e9f6e', in: '#198653', inv: '#2fbf7f', owe: '#f59e0b', mark: '#6b7a73', out: '#ea580c',
  ref: '#c2410c', now: '#dc2626', future: '#fff', forfeit: '#dc2626', transfer: '#7c3aed',
};

interface Props {
  roomId: string;
  roomName: string;
  /** Năm mở đầu — năm của kỳ báo cáo đang xem. */
  initialYear: number;
  onClose: () => void;
}

export default function RoomContractLifecycleDrawer({ roomId, roomName, initialYear, onClose }: Props) {
  const todayISO = vnTodayISO();
  const [year, setYear] = useState(initialYear);
  const [sel, setSel] = useState<string | null>(null);

  const { selectedOrganizationId } = useOrganization();
  const room = useRoomCashLifecycle(roomId);
  const payload = room.data;

  // Hợp đồng đích chỉ quyết định nhãn vai — lane của MỌI hợp đồng trên phòng
  // đều được dựng. Lấy hợp đồng mới nhất cho ổn định.
  const target = useMemo(() => {
    const cs = [...(payload?.contracts ?? [])].sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
    return cs[cs.length - 1]?.id ?? null;
  }, [payload]);
  const money = useContractLifecycle({
    organizationId: selectedOrganizationId,
    roomId,
    targetContractId: target,
    subject: { kind: 'movement' },
    businessDate: todayISO,
  });
  const extras = useRoomContractExtras((payload?.contracts ?? []).map((c) => c.id));

  const lanes: LaneSource = useMemo(() => {
    if (money.isError || (!selectedOrganizationId && !!target)) return null;
    if (!money.data) return undefined;
    return new Map<string, Lane>(money.data.lanes.map((l) => [l.contractId, l]));
  }, [money.data, money.isError, selectedOrganizationId, target]);
  const moneyNotice = money.isError
    ? `Cọc & công nợ: ${(money.error as Error)?.message ?? 'không đọc được'}`
    : !selectedOrganizationId && target
      ? 'Cọc & công nợ: chưa chốt được tổ chức đang xem'
      : money.data && money.data.status.deposit.kind !== 'sufficient'
        ? `Cọc: ${'reason' in money.data.status.deposit ? money.data.status.deposit.reason : ''}`
        : null;

  const extrasData = extras.data ?? null;
  const yearView = useMemo(
    () => (payload ? buildRoomYear({ payload, todayISO, lanes, extras: extrasData, year }) : null),
    [payload, year, todayISO, lanes, extrasData],
  );
  const detail = useMemo(
    () => (payload && sel ? buildContractDetail({ payload, todayISO, lanes, extras: extrasData }, sel) : null),
    [payload, sel, todayISO, lanes, extrasData],
  );
  const inDetail = !!detail;
  // Đổi màn (danh sách ↔ chi tiết) hoặc đổi năm → cuộn về đầu, không giữ vị trí cũ.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: 0 }); }, [sel, year]);

  const title = inDetail ? `${detail.tenant} · ${detail.number}` : `Phòng ${roomName} · Vòng đời hợp đồng`;
  const buildingName = payload?.room.buildingName ?? '';
  const sub = inDetail
    ? `Phòng ${roomName}${buildingName ? ` · ${buildingName}` : ''} · Chi tiết hợp đồng từ ngày vào tới ngày ra`
    : `${buildingName ? `${buildingName} · ` : ''}Các hợp đồng có hiệu lực trong năm ${year}`;
  const kpis = inDetail ? detail.kpis : yearView?.kpis ?? [];

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="rcl-scrim" />
        <DialogPrimitive.Content className="rcl" aria-describedby={undefined}>
          <div className="rcl-hero">
            <div className="rcl-hero__top">
              {inDetail && (
                <button type="button" className="rcl-iconbtn rcl-iconbtn--ghost" onClick={() => setSel(null)} aria-label="Quay lại danh sách hợp đồng">
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}
              <div className="rcl-hero__room">{roomName}</div>
              <div className="rcl-hero__titles">
                <DialogPrimitive.Title className="rcl-hero__title">{title}</DialogPrimitive.Title>
                <div className="rcl-hero__sub">{sub}</div>
              </div>
              {!inDetail && yearView && (
                <div className="rcl-year">
                  <button type="button" onClick={() => setYear((y) => y - 1)} disabled={year <= yearView.minYear} aria-label="Năm trước">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span>Năm {year}</span>
                  <button type="button" onClick={() => setYear((y) => Math.min(yearView.maxYear, y + 1))} disabled={year >= yearView.maxYear} aria-label="Năm sau">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
              <DialogPrimitive.Close className="rcl-iconbtn" aria-label="Đóng">
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
            {kpis.length > 0 && (
              <div className="rcl-kpis">
                {kpis.map((k) => (
                  <div key={k.label}>
                    <div className="rcl-kpi__label">{k.label}</div>
                    <div className="rcl-kpi__value" style={{ color: KPI_COLOR[k.tone] }}>{k.value}</div>
                    {k.sub && <div className="rcl-kpi__sub">{k.sub}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rcl-scroll" ref={scrollRef}>
            <div className="rcl-stack">
              {room.isLoading && <div className="rcl-empty">Đang tải vòng đời hợp đồng…</div>}
              {room.isError && (
                <div className="rcl-alert">
                  {(room.error as Error)?.message ?? 'Không đọc được vòng đời hợp đồng của phòng'}
                  <button type="button" onClick={() => room.refetch()}>Thử lại</button>
                </div>
              )}
              {moneyNotice && payload && <div className="rcl-note">{moneyNotice}</div>}

              {!inDetail && yearView && (
                <>
                  <div className="rcl-card">
                    <div className="rcl-card__head rcl-card__head--tl">
                      <div className="rcl-h">Dòng thời gian {year}</div>
                      <div className="rcl-legend">
                        {LEGEND.map((l) => (
                          <span key={l.kind}><i style={{ background: KIND[l.kind].bar }} />{l.label}</span>
                        ))}
                        <span><i className="rcl-hatch" />Phòng trống</span>
                      </div>
                    </div>
                    <div className="rcl-tl">
                      <div className="rcl-tl__months">
                        {Array.from({ length: 12 }, (_, i) => (
                          <div key={i} style={{ color: i === yearView.currentMonth ? '#0e5c38' : undefined }}>T{i + 1}</div>
                        ))}
                      </div>
                      <div className="rcl-tl__area">
                        <div className="rcl-tl__grid">{Array.from({ length: 12 }, (_, i) => <div key={i} />)}</div>
                        <div className="rcl-tl__track rcl-hatch">
                          {yearView.bars.map((b) => (
                            <button
                              key={b.contractId}
                              type="button"
                              className="rcl-tl__bar"
                              title={b.title}
                              onClick={() => setSel(b.contractId)}
                              style={{ left: `${b.left}%`, width: `${b.width}%`, background: KIND[b.kind].bar, color: KIND[b.kind].ganttInk }}
                            >
                              {b.label}
                            </button>
                          ))}
                          {yearView.todayLeft !== null && <div className="rcl-tl__today" style={{ left: `${yearView.todayLeft}%` }} />}
                        </div>
                        {yearView.todayLeft !== null && (
                          <div className="rcl-tl__todaylbl">
                            <span style={{ left: `${yearView.todayLeft}%` }}>Hôm nay {todayISO.slice(8, 10)}/{todayISO.slice(5, 7)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="rcl-listhead">
                    <div className="rcl-h">Hợp đồng trong năm {year}</div>
                    <div className="rcl-pill">{yearView.contractCount} HĐ</div>
                    <div className="rcl-listhead__hint">Bấm vào một hợp đồng để xem chi tiết</div>
                  </div>
                  {yearView.diagnostics.map((d) => <div key={d} className="rcl-note">{d}</div>)}
                  {yearView.contractCount === 0 && (
                    <div className="rcl-empty rcl-empty--card">Phòng không có hợp đồng nào trong năm {year}</div>
                  )}
                  {yearView.items.map((it) =>
                    it.type === 'gap' ? (
                      <div key={it.key} className="rcl-gap"><i /><span>{it.text}</span><i /></div>
                    ) : (
                      <button key={it.key} type="button" className="rcl-contract" onClick={() => setSel(it.card.id)}>
                        <div className="rcl-contract__bar" style={{ background: KIND[it.card.kind].bar }} />
                        <div className="rcl-contract__main">
                          <div className="rcl-row">
                            <span className="rcl-contract__tenant">{it.card.tenant}</span>
                            <span className="rcl-code">{it.card.number}</span>
                            <span className="rcl-badge" style={{ color: KIND[it.card.kind].ink, background: KIND[it.card.kind].bg }}>{it.card.status}</span>
                          </div>
                          <div className="rcl-dates">
                            <span><LogIn className="h-4 w-4" style={{ color: '#198653' }} /><b>{it.card.inText}</b></span>
                            <span className="rcl-dates__line" />
                            <span><LogOut className="h-4 w-4" style={{ color: it.card.hasOut ? '#ea580c' : '#8a9992' }} /><b>{it.card.outText}</b></span>
                            {it.card.duration && <span className="rcl-muted rcl-nowrap">· {it.card.duration}</span>}
                          </div>
                          {it.card.reason && (
                            <div className="rcl-reason" style={{ color: KIND[it.card.kind].ink }}>{it.card.reason}</div>
                          )}
                          <div className="rcl-meta">
                            Giá thuê {it.card.rentText}/tháng · Cọc {it.card.depositText} · {it.card.invoiceCount} hoá đơn
                          </div>
                          <div className="rcl-chips">
                            {it.card.chips.map((ch) => (
                              <span key={ch.text} style={{ color: TONE[ch.tone].ink, background: TONE[ch.tone].bg }}>{ch.text}</span>
                            ))}
                          </div>
                        </div>
                        <div className="rcl-contract__side">
                          <div>
                            <div className="rcl-cap">ĐÃ THU {year}</div>
                            <div className="rcl-contract__paid">{new Intl.NumberFormat('vi-VN').format(it.card.paidYear)} ₫</div>
                          </div>
                          <span className="rcl-more">Chi tiết <ChevronRight className="h-4 w-4" /></span>
                        </div>
                      </button>
                    ),
                  )}
                </>
              )}

              {inDetail && (
                <>
                  <div className="rcl-card rcl-card--pad">
                    <div className="rcl-row">
                      <div className="rcl-h">Thời hạn hợp đồng</div>
                      <span className="rcl-badge" style={{ color: KIND[detail.kind].ink, background: KIND[detail.kind].bg }}>{detail.status}</span>
                      <div className="rcl-progress-text">{detail.progressText}</div>
                    </div>
                    {detail.reason && (
                      <div className="rcl-reasonbox" style={{ color: KIND[detail.kind].ink, background: KIND[detail.kind].bg }}>{detail.reason}</div>
                    )}
                    <div className="rcl-term">
                      <div><div className="rcl-cap">NGÀY VÀO</div><div className="rcl-term__v">{detail.inText}</div></div>
                      <div style={{ textAlign: 'right' }}><div className="rcl-cap">{detail.outLabel}</div><div className="rcl-term__v">{detail.outText}</div></div>
                    </div>
                    <div className="rcl-progress"><div style={{ width: `${detail.pct}%`, background: KIND[detail.kind].bar }} /></div>
                    <div className="rcl-tiles">
                      {detail.tiles.map((tl) => (
                        <div key={tl.label} className="rcl-tile">
                          <div className="rcl-tile__l">{tl.label}</div>
                          <div className="rcl-tile__v">{tl.value}</div>
                          <div className="rcl-tile__s">{tl.sub}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rcl-card">
                    <div className="rcl-card__head"><div className="rcl-h">Cọc &amp; công nợ hai chiều</div></div>
                    <div className="rcl-summary" style={{ color: TONE[detail.balances.summary.tone].ink, background: TONE[detail.balances.summary.tone].bg }}>
                      {detail.balances.summary.text}
                    </div>
                    <div className="rcl-bal">
                      {([['KHÁCH → CHỦ NHÀ', detail.balances.tenantRows], ['CHỦ NHÀ → KHÁCH', detail.balances.landRows]] as const).map(([h, rows]) => (
                        <div key={h} className="rcl-bal__box">
                          <div className="rcl-cap">{h}</div>
                          {rows.map((r) => (
                            <div key={r.label} className={`rcl-bal__row${r.strong ? ' rcl-bal__row--strong' : ''}`}>
                              <span>{r.label}</span>
                              <span style={{ color: r.tone === 'neutral' ? TEXT.ink : TEXT[r.tone] }}>{r.value}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rcl-card">
                    <div className="rcl-card__head">
                      <div className="rcl-h">Diễn biến từ ngày vào tới ngày ra</div>
                      <div className="rcl-pill">{detail.events.length} mốc</div>
                    </div>
                    <div className="rcl-events">
                      {detail.events.map((e, i) => {
                        const prev = detail.events[i - 1];
                        const next = detail.events[i + 1];
                        return (
                          <div key={e.key} className="rcl-ev">
                            <div className="rcl-ev__date">{e.date.slice(8, 10)}/{e.date.slice(5, 7)}/{e.date.slice(0, 4)}</div>
                            <div className="rcl-ev__rail">
                              <div style={{ height: 12, background: !prev ? 'transparent' : e.kind === 'future' ? '#dce3df' : '#cfe6d9' }} />
                              <div className="rcl-ev__dot" style={{ background: DOT[e.kind], borderColor: e.kind === 'future' ? '#b9c6bf' : '#fff' }} />
                              <div style={{ flex: 1, background: !next ? 'transparent' : next.kind === 'future' ? '#dce3df' : '#cfe6d9' }} />
                            </div>
                            <div className="rcl-ev__main">
                              <div className="rcl-ev__title" style={{ fontWeight: ['in', 'out', 'now', 'forfeit', 'transfer'].includes(e.kind) ? 700 : 600 }}>{e.title}</div>
                              <div className="rcl-ev__sub">{e.sub}</div>
                            </div>
                            <div className="rcl-ev__amt">
                              <div style={{ color: TEXT[e.amtTone] }}>{e.amt}</div>
                              <div className="rcl-ev__note" style={{ color: TEXT[e.noteTone] }}>{e.note}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

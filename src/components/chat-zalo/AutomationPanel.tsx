// =============================================================================
// AutomationPanel.tsx — tóm tắt tự động hoá ở cột phải (tab "Tự động hoá").
//
// BẢN NÀY THAY MỘT UI GIẢ. Bản trước hiện "Mỗi giờ · 08–20h", "8 môi giới",
// "10:00 (52')", bốn từ khoá hằng số và "đã trả lời 24 tin" — tất cả đều là chữ
// cứng port từ file design, không dòng nào đọc từ DB. Nguy hiểm của loại UI đó
// không phải là xấu mà là NÓI DỐI ĐÚNG GIỌNG THẬT: người dùng bật công tắc, đọc
// "10:00 (52')" rồi đi làm việc khác, tin không bao giờ tới, và không ai nghi
// màn hình cả vì nó vẫn hiển thị một con số rất tự tin.
//
// Nên quy tắc của file này: MỖI SỐ TRÊN MÀN PHẢI CÓ NGUỒN.
//   • giờ gửi / người nhận / chế độ hôm nay / từ khoá / cooldown ← `config` jsonb
//     (qua `chuanHoa*` — cùng hàm worker dùng để đọc, xem `automationConfig.ts`)
//   • lần chạy cuối ← bảng `zalo_automation_runs`, do worker ghi
// Thiếu nguồn thì viết thẳng "Chưa cấu hình" / "Chưa chạy lần nào", KHÔNG lấp
// bằng mặc định trông cho đẹp.
//
// Panel này chỉ ĐỌC và bật/tắt. Chỗ chỉnh là `AutomationSettingsDialog`, mở qua
// `onOpenSettings` — cột phải rộng ~330px, không phải chỗ dựng form 7 ngày.
// =============================================================================

import { useMemo } from 'react';
import { Image as ImageIcon, MessageSquare, Send, SlidersHorizontal, History, Loader2 } from 'lucide-react';
import { EMERALD, tagStyle } from './zaloTheme';
import { mono } from './infoCards';
import { useZaloAutomationConfigs, useZaloAutomationRuns } from '@/hooks/useZaloChat';
import type { ZaloAutomationRun } from '@/hooks/useZaloChat';
import { chuanHoaBroadcast, chuanHoaAutoReply, KHOA_NGAY } from './automationConfig';
import { nhanCuaNgay, nhanCuaLuot } from './automation/nhanCheDo';
import type { ZaloAutomations, ZaloConversation } from './types';

interface Props {
  automations: ZaloAutomations;
  onToggle: (key: 'broadcastOn' | 'autoReplyOn') => void;
  templates: { title: string; color: string }[];
  /** Danh sách hội thoại đầy đủ — dùng để đối chiếu người nhận đã lưu còn hợp lệ không. */
  conversations: ZaloConversation[];
  onOpenSettings: () => void;
}

/** Công tắc gạt (toggle switch) port từ design. */
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ position: 'relative', width: 38, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', flex: 'none', padding: 0, background: on ? 'hsl(152 69% 38%)' : 'hsl(210 16% 80%)', transition: 'background .15s' }}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .15s' }} />
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
      <span style={{ color: 'hsl(210 10% 45%)', flex: 'none' }}>{label}</span>
      {children}
    </div>
  );
}

/** Dòng thay cho các Row khi chưa có dữ liệu — nói rõ vì sao trống. */
function DongTrong({ children, dangTai }: { children: React.ReactNode; dangTai?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'hsl(210 10% 50%)', lineHeight: 1.5 }}>
      {dangTai ? <Loader2 size={12} className="animate-spin" style={{ flex: 'none' }} /> : null}
      <span>{children}</span>
    </div>
  );
}

const TEN_THU = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

// Bảng nhãn chế độ dùng chung với RunLog — xem `automation/nhanCheDo.ts`. Trước
// đây mỗi file giữ một bản chép; worker thêm một `mode` mới thì phải sửa hai nơi,
// quên một nơi thì badge hiện nhãn thô viết hoa mà không gate nào đỏ.

/** "hôm nay 08:30" / "29/08 08:30" — đủ để trả lời "lượt vừa rồi là bao giờ". */
function moTaLuc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x: number) => String(x).padStart(2, '0');
  const gio = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const homNay = new Date();
  const cungNgay = d.getDate() === homNay.getDate() && d.getMonth() === homNay.getMonth() && d.getFullYear() === homNay.getFullYear();
  return cungNgay ? `hôm nay ${gio}` : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${gio}`;
}

/** Rút gọn `reason` cho vừa cột hẹp. Nhật ký đầy đủ nằm ở màn cài đặt/RunLog —
 *  ở đây chỉ cần đủ để người đọc quyết định có cần mở ra xem không. */
function rutGon(s: string, n = 64): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const CHIP: React.CSSProperties = {
  background: 'hsl(210 20% 95%)', fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 6,
};

/** Tab "Tự động hoá": tóm tắt broadcast + auto-reply (số liệu THẬT) + thư viện mẫu tin. */
export default function AutomationPanel({ automations, onToggle, templates, conversations, onOpenSettings }: Props) {
  const cfgQuery = useZaloAutomationConfigs();
  const runsQuery = useZaloAutomationRuns();

  const rowBc = cfgQuery.data?.broadcast_vacant;
  const rowAr = cfgQuery.data?.auto_reply;

  // Chuẩn hoá bằng đúng hàm worker dùng: những gì hiện ở đây là những gì worker
  // sẽ đọc, kể cả khi bản ghi cũ thiếu khoá.
  const bc = useMemo(() => chuanHoaBroadcast(rowBc?.config), [rowBc?.config]);
  const ar = useMemo(() => chuanHoaAutoReply(rowAr?.config), [rowAr?.config]);

  // Người nhận đã lưu nhưng không còn là ứng viên hợp lệ (bị gỡ đánh dấu sale,
  // rời nhóm, thuộc tài khoản Zalo khác). Worker bỏ qua trong im lặng nên phải
  // đếm ở đây — cùng luật lọc với RecipientPicker, đừng nới một bên.
  const soLac = useMemo(() => {
    if (!rowBc || !conversations.length || !bc.recipients.length) return 0;
    const hopLe = new Set(conversations.filter((c) => c && (c.isGroup || c.isSalePartner)).map((c) => c.id));
    return bc.recipients.filter((id) => !hopLe.has(id)).length;
  }, [rowBc, conversations, bc.recipients]);

  // `getDay()` trả 0..6 và KHOA_NGAY xếp đúng thứ tự đó (0 = Chủ nhật) — nhưng
  // TypeScript ở đảo strict không biết điều đó, nên phải có nhánh dự phòng thay
  // vì ép kiểu: ép kiểu ở đây sẽ biến một lỗi lịch thành `undefined` chạy ngầm.
  const thuHomNay = new Date().getDay();
  const khoaHomNay = KHOA_NGAY[thuHomNay] ?? 'sun';
  const cheDoHomNay = bc.schedule.days[khoaHomNay];
  const nhanHomNay = nhanCuaNgay(cheDoHomNay);

  const luotCuoi: ZaloAutomationRun | undefined = runsQuery.data?.[0];
  const nhanLuot = luotCuoi ? nhanCuaLuot(luotCuoi.mode) : null;

  const dangTaiCfg = cfgQuery.isLoading;
  const loiCfg = cfgQuery.isError;

  return (
    <div className="wz-scroll" style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ------------------------------------------- Gửi ảnh phòng trống */}
      <div style={{ border: '1px solid hsl(152 35% 84%)', background: 'hsl(152 40% 98%)', borderRadius: 12, padding: '13px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 28, height: 28, borderRadius: 8, background: EMERALD, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><ImageIcon size={15} /></span>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>Gửi ảnh phòng trống định kỳ</div>
              <div style={{ fontSize: 11, color: 'hsl(152 50% 35%)', fontWeight: 600 }}>{automations.broadcastOn ? 'Đang chạy' : 'Đã tắt'}</div>
            </div>
          </div>
          <Toggle on={automations.broadcastOn} onClick={() => onToggle('broadcastOn')} />
        </div>

        <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5 }}>
          {dangTaiCfg ? (
            <DongTrong dangTai>Đang tải cấu hình…</DongTrong>
          ) : loiCfg ? (
            <DongTrong>Không tải được cấu hình — số liệu bên dưới bị ẩn để khỏi hiện nhầm.</DongTrong>
          ) : !rowBc ? (
            <DongTrong>Chưa cấu hình lần nào. Mở “Cài đặt chi tiết” để chọn người nhận và lịch gửi.</DongTrong>
          ) : (
            <>
              <Row label="Giờ gửi"><span style={{ fontWeight: 600, ...mono() }}>{bc.schedule.time}</span></Row>
              <Row label="Người nhận">
                <span style={{ fontWeight: 600 }}>
                  {bc.recipients.length ? `${bc.recipients.length} hội thoại` : 'chưa chọn ai'}
                </span>
              </Row>
              {soLac > 0 && (
                <div style={{ fontSize: 11, color: 'hsl(17 88% 38%)', lineHeight: 1.45 }}>
                  {soLac} người nhận đã lưu không còn hợp lệ (bị gỡ đánh dấu sale hoặc rời nhóm) — mở cài đặt để gỡ.
                </div>
              )}
              <Row label={`Hôm nay (${TEN_THU[thuHomNay] ?? 'hôm nay'})`}>
                <span style={tagStyle(nhanHomNay.tone, { fontSize: 10.5 })}>{nhanHomNay.ten}</span>
              </Row>
              <div style={{ fontSize: 11, color: 'hsl(210 10% 50%)', lineHeight: 1.45 }}>
                {bc.schedule.upgradeOnNewRooms ? 'Có phòng mới thì nâng lên bảng đầy đủ. ' : ''}
                {bc.schedule.skipIfUnchanged ? 'Danh sách y hệt lần trước thì bỏ lượt.' : ''}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ------------------------------------------------ Tự động trả lời */}
      <div style={{ border: '1px solid hsl(210 20% 90%)', borderRadius: 12, padding: '13px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 28, height: 28, borderRadius: 8, background: 'hsl(214 95% 93%)', color: 'hsl(224 76% 48%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><MessageSquare size={15} /></span>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>Tự động trả lời</div>
              <div style={{ fontSize: 11, color: 'hsl(210 10% 45%)' }}>Chỉ hội thoại đã đánh dấu sale</div>
            </div>
          </div>
          <Toggle on={automations.autoReplyOn} onClick={() => onToggle('autoReplyOn')} />
        </div>

        <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5 }}>
          {dangTaiCfg ? (
            <DongTrong dangTai>Đang tải cấu hình…</DongTrong>
          ) : loiCfg ? (
            <DongTrong>Không tải được cấu hình — số liệu bên dưới bị ẩn để khỏi hiện nhầm.</DongTrong>
          ) : !rowAr ? (
            <DongTrong>Chưa cấu hình lần nào. Mở “Cài đặt chi tiết” để đặt từ khoá và lời chào.</DongTrong>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                <span style={{ color: 'hsl(210 10% 45%)' }}>Từ khoá:</span>
                {ar.keywords.length === 0 ? (
                  <span style={{ fontSize: 11.5, color: 'hsl(17 88% 38%)', fontWeight: 600 }}>chưa có — sẽ không bao giờ trả lời</span>
                ) : (
                  <>
                    {ar.keywords.slice(0, 4).map((k) => (
                      <span key={k} style={CHIP}>{k}</span>
                    ))}
                    {ar.keywords.length > 4 && (
                      <span style={{ ...CHIP, color: 'hsl(210 10% 45%)' }}>+{ar.keywords.length - 4}</span>
                    )}
                  </>
                )}
              </div>
              <Row label="Từ khoá chặn"><span style={{ fontWeight: 600 }}>{ar.blockedKeywords.length} từ</span></Row>
              <Row label="Nghỉ giữa 2 lần"><span style={{ fontWeight: 600, ...mono() }}>{ar.cooldownMinutes} phút</span></Row>
              <Row label="Trần mỗi ngày"><span style={{ fontWeight: 600, ...mono() }}>{ar.dailyCap} tin</span></Row>
            </>
          )}
        </div>
      </div>

      {/* --------------------------------------------------- Lần chạy cuối */}
      <div style={{ border: '1px solid hsl(210 20% 90%)', borderRadius: 12, padding: '11px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: luotCuoi ? 7 : 0 }}>
          <History size={14} color="hsl(210 10% 45%)" style={{ flex: 'none' }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>Lần chạy cuối</span>
          {runsQuery.isLoading ? <Loader2 size={13} className="animate-spin" color="hsl(210 10% 55%)" /> : null}
          {!runsQuery.isLoading && !luotCuoi && (
            <span style={{ fontSize: 11.5, color: 'hsl(210 10% 50%)' }}>
              {runsQuery.isError ? 'Không tải được' : 'Chưa chạy lần nào'}
            </span>
          )}
        </div>
        {luotCuoi && nhanLuot && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <span style={{ ...mono({ fontSize: 11.5, color: 'hsl(210 10% 45%)' }) }}>{moTaLuc(luotCuoi.createdAt)}</span>
              <span style={tagStyle(nhanLuot.tone, { fontSize: 10.5 })}>{nhanLuot.ten}</span>
              <span style={{ fontSize: 11.5, color: 'hsl(210 10% 45%)' }}>
                {luotCuoi.kind === 'auto_reply' ? 'trả lời' : 'định kỳ'} · {luotCuoi.messagesCount} tin
              </span>
            </div>
            {luotCuoi.reason ? (
              // Nguyên văn worker ghi, chỉ cắt độ dài: đây là câu trả lời cho
              // "sao sáng nay không thấy tin", diễn giải lại là thêm chỗ nói sai.
              <div style={{ fontSize: 11.5, color: luotCuoi.mode === 'failed' ? 'hsl(0 70% 42%)' : 'hsl(210 10% 45%)', lineHeight: 1.45 }}>
                {rutGon(luotCuoi.reason)}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* -------------------------------------------------- Cài đặt chi tiết */}
      <button
        onClick={onOpenSettings}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, width: '100%', padding: '9px 0', borderRadius: 10, border: '1px solid hsl(152 40% 82%)', background: 'hsl(152 40% 96%)', color: EMERALD, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <SlidersHorizontal size={14} />
        Cài đặt chi tiết
      </button>

      {/* ------------------------------------------------- Thư viện mẫu tin */}
      <div style={{ border: '1px solid hsl(210 20% 90%)', borderRadius: 12, padding: '13px 14px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>Thư viện mẫu tin</span>
          <span style={{ fontSize: 11.5, color: EMERALD, fontWeight: 600, cursor: 'pointer' }}>+ Thêm</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {templates.map((t) => (
            <div key={t.title} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', borderTop: '1px solid hsl(210 20% 94%)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flex: 'none' }} />
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500 }}>{t.title}</span>
              <Send size={16} color={EMERALD} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

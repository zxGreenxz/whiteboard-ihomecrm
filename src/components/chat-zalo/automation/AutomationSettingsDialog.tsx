// =============================================================================
// AutomationSettingsDialog.tsx — màn cài đặt đầy đủ cho hai tính năng tự động.
//
// VÌ SAO LÀ DIALOG chứ không nằm trong cột phải: cột 3 của trang chat rộng
// ~300px. Bảng 7 thứ, danh sách người nhận, ba khối nội dung có thứ tự và năm ô
// chống spam không sống nổi ở đó — nhét vào là mỗi trường một dòng, cuộn mãi
// không hết, và người dùng mất khả năng nhìn cả cấu hình cùng lúc để hiểu nó sẽ
// gửi cái gì. `AutomationPanel` giữ vai trò tóm tắt + công tắc nhanh; chỗ này
// mới là nơi chỉnh.
//
// HAI ĐIỀU DỄ LÀM SAI, đã xử lý tường minh bên dưới:
//
// 1. NẠP MỘT LẦN MỖI LẦN MỞ. `useZaloAutomationConfigs` là một query — nó
//    refetch khi cửa sổ lấy lại focus, khi mạng nối lại, khi cache invalidate.
//    Đồng bộ state form theo `data` vô điều kiện nghĩa là người dùng gõ dở nửa
//    mẫu tin rồi alt-tab đi trả lời Zalo, quay lại thấy trắng. Nên có `daNap`:
//    hydrate đúng một lần cho mỗi lần mở dialog, đóng lại thì cờ reset.
//
// 2. CHUẨN HOÁ CẢ LÚC NẠP LẪN LÚC LƯU. Lúc nạp vì bản ghi cũ có thể thiếu khoá.
//    Lúc lưu vì đó là thứ giữ cho `zalo_automations.config` (cột jsonb tự do)
//    luôn đúng hình dạng worker chờ đợi — xem đầu `automationConfig.ts`.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Megaphone, MessageSquareReply, Users, CalendarClock, FileText, ShieldAlert, History } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useZaloAutomationConfigs, useSaveAutomation, useZaloAutomationRuns } from '@/hooks/useZaloChat';
import { chuanHoaBroadcast, chuanHoaAutoReply } from '../automationConfig';
import type { CauHinhBroadcast, CauHinhAutoReply } from '../automationConfig';
import type { ZaloConversation } from '@/components/chat-zalo/types';
import RecipientPicker from './RecipientPicker';
import SchedulePlanner from './SchedulePlanner';
import TemplateBuilder from './TemplateBuilder';
import AntiSpamFields from './AntiSpamFields';
import AutoReplyFields from './AutoReplyFields';
import RunLog from './RunLog';
import { CHU_MO, VIEN, KhoiCaiDat, BangCanhBao } from './uiChung';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  conversations: ZaloConversation[];
}

type Tab = 'broadcast' | 'reply' | 'nhatky';

export default function AutomationSettingsDialog({ open, onOpenChange, conversations }: Props) {
  const { data, isLoading } = useZaloAutomationConfigs(open);
  // Nhật ký chỉ nạp khi dialog mở — cùng lý do với cấu hình: đây là màn người
  // dùng chủ động mở, không phải thứ trang chat phải trả tiền băng thông cho.
  const { data: runs = [], isLoading: dangTaiRuns } = useZaloAutomationRuns(open);
  const luu = useSaveAutomation();

  const [tab, setTab] = useState<Tab>('broadcast');

  const [bcBat, setBcBat] = useState(false);
  const [bc, setBc] = useState<CauHinhBroadcast>(() => chuanHoaBroadcast(null));
  const [arBat, setArBat] = useState(false);
  const [ar, setAr] = useState<CauHinhAutoReply>(() => chuanHoaAutoReply(null));

  // Ảnh chụp lúc nạp, để biết có gì chưa lưu. Chỉ dùng cho chỉ báo — không phải
  // cơ chế đúng/sai, nên so bằng JSON là đủ.
  const [banDau, setBanDau] = useState<{ bc: string; ar: string }>({ bc: '', ar: '' });
  const daNap = useRef(false);

  useEffect(() => {
    // Đóng dialog → quên đi, lần mở sau nạp lại từ server.
    if (!open) { daNap.current = false; return; }
    if (daNap.current || !data) return;

    const rowBc = data.broadcast_vacant;
    const rowAr = data.auto_reply;
    const bcMoi = chuanHoaBroadcast(rowBc?.config);
    const arMoi = chuanHoaAutoReply(rowAr?.config);

    setBcBat(!!rowBc?.enabled);
    setBc(bcMoi);
    setArBat(!!rowAr?.enabled);
    setAr(arMoi);
    setBanDau({
      bc: JSON.stringify([!!rowBc?.enabled, bcMoi]),
      ar: JSON.stringify([!!rowAr?.enabled, arMoi]),
    });
    daNap.current = true;
  }, [open, data]);

  const bcDoi = useMemo(() => !!banDau.bc && JSON.stringify([bcBat, bc]) !== banDau.bc, [banDau.bc, bcBat, bc]);
  const arDoi = useMemo(() => !!banDau.ar && JSON.stringify([arBat, ar]) !== banDau.ar, [banDau.ar, arBat, ar]);
  const coDoi = tab === 'broadcast' ? bcDoi : arDoi;

  const luuTab = () => {
    if (tab === 'broadcast') {
      const sach = chuanHoaBroadcast(bc);
      luu.mutate(
        { kind: 'broadcast_vacant', enabled: bcBat, config: sach },
        {
          onSuccess: () => {
            // Ghi lại đúng thứ vừa gửi đi: giá trị có thể đã bị kẹp lúc chuẩn
            // hoá, nếu không đồng bộ thì form vẫn hiện số cũ và báo "chưa lưu".
            setBc(sach);
            setBanDau((s) => ({ ...s, bc: JSON.stringify([bcBat, sach]) }));
          },
        },
      );
    } else {
      const sach = chuanHoaAutoReply(ar);
      luu.mutate(
        { kind: 'auto_reply', enabled: arBat, config: sach },
        {
          onSuccess: () => {
            setAr(sach);
            setBanDau((s) => ({ ...s, ar: JSON.stringify([arBat, sach]) }));
          },
        },
      );
    }
  };

  const khongNguoiNhan = bc.recipients.length === 0;
  const khongKhoiNaoBat = bc.template.blocks.length === 0;
  const khongNgayNao = Object.values(bc.schedule.days).every((x) => x === 'off');
  const khongTuKhoa = ar.keywords.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[880px]">
        <DialogHeader>
          <DialogTitle>Cài đặt tự động hoá Zalo</DialogTitle>
          <DialogDescription>
            Hai tính năng chạy độc lập và lưu riêng — nút Lưu chỉ ghi tab đang mở.
          </DialogDescription>
        </DialogHeader>

        {isLoading && !daNap.current ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '34px 0', justifyContent: 'center', fontSize: 12.5, color: CHU_MO }}>
            <Loader2 size={15} className="animate-spin" />
            Đang tải cấu hình…
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="broadcast">
                <Megaphone className="mr-2 h-4 w-4" />Gửi phòng trống định kỳ
              </TabsTrigger>
              <TabsTrigger value="reply">
                <MessageSquareReply className="mr-2 h-4 w-4" />Tự động trả lời
              </TabsTrigger>
              <TabsTrigger value="nhatky">
                <History className="mr-2 h-4 w-4" />Nhật ký
              </TabsTrigger>
            </TabsList>

            {/* ------------------------------------------------ BROADCAST */}
            <TabsContent value="broadcast">
              <div style={{ maxHeight: '58vh', overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CongTacChinh
                  bat={bcBat}
                  onBat={setBcBat}
                  ten="Bật gửi phòng trống định kỳ"
                  moTa="Tắt thì mọi lịch và quy tắc bên dưới vẫn được giữ nguyên, chỉ là không có lượt nào chạy."
                />

                {bcBat && khongNguoiNhan && (
                  <BangCanhBao>
                    <b>Chưa chọn người nhận nào</b> — tính năng đang bật nhưng sẽ không gửi cho ai cả.
                    Chọn ít nhất một nhóm hoặc một hội thoại sale ở khối ngay dưới.
                  </BangCanhBao>
                )}
                {bcBat && khongNgayNao && (
                  <BangCanhBao>
                    Cả 7 ngày trong tuần đều đặt “Không gửi” — sẽ không có lượt định kỳ nào chạy.
                  </BangCanhBao>
                )}
                {bcBat && khongKhoiNaoBat && (
                  <BangCanhBao>
                    Không khối nội dung nào được bật — lượt gửi sẽ không có nội dung.
                  </BangCanhBao>
                )}

                <KhoiCaiDat
                  icon={<Users size={15} />}
                  tieuDe="Người nhận"
                  moTa="Chỉ nhóm và hội thoại đã đánh dấu sale mới hiện ở đây — khách thuê không bao giờ nhận bản tin rao phòng."
                >
                  <RecipientPicker
                    conversations={conversations}
                    value={bc.recipients}
                    onChange={(ids) => setBc({ ...bc, recipients: ids })}
                  />
                </KhoiCaiDat>

                <KhoiCaiDat
                  icon={<CalendarClock size={15} />}
                  tieuDe="Lịch gửi"
                  moTa="Bảng thứ quyết định chế độ cứng; hai quy tắc động chạy sau đó có thể nâng chế độ hoặc bỏ hẳn lượt."
                >
                  <SchedulePlanner value={bc.schedule} onChange={(s) => setBc({ ...bc, schedule: s })} />
                </KhoiCaiDat>

                <KhoiCaiDat
                  icon={<FileText size={15} />}
                  tieuDe="Nội dung tin"
                  moTa="Thứ tự khối chính là thứ tự gửi. Khối “chi tiết + ảnh từng phòng” chỉ chạy ở ngày ĐẦY ĐỦ."
                >
                  <TemplateBuilder
                    value={bc.template}
                    onChange={(t) => setBc({ ...bc, template: t })}
                    eventDriven={bc.eventDriven}
                    onEventDrivenChange={(e) => setBc({ ...bc, eventDriven: e })}
                  />
                </KhoiCaiDat>

                <KhoiCaiDat
                  icon={<ShieldAlert size={15} />}
                  tieuDe="Chống spam"
                  moTa="Khoảng cách an toàn cho nick Zalo. Nới ra thì gửi nhanh hơn và rủi ro bị khoá cao hơn."
                >
                  <AntiSpamFields value={bc.antiSpam} onChange={(a) => setBc({ ...bc, antiSpam: a })} />
                </KhoiCaiDat>
              </div>
            </TabsContent>

            {/* ----------------------------------------------- AUTO-REPLY */}
            <TabsContent value="reply">
              <div style={{ maxHeight: '58vh', overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <CongTacChinh
                  bat={arBat}
                  onBat={setArBat}
                  ten="Bật tự động trả lời"
                  moTa="Chỉ áp dụng cho hội thoại đã đánh dấu là sale/môi giới."
                />

                {arBat && khongTuKhoa && (
                  <BangCanhBao>
                    <b>Chưa có từ khoá kích hoạt nào</b> — tính năng đang bật nhưng sẽ không bao giờ trả lời.
                  </BangCanhBao>
                )}

                <KhoiCaiDat
                  icon={<MessageSquareReply size={15} />}
                  tieuDe="Điều kiện và nội dung trả lời"
                  moTa="Từ khoá chặn luôn thắng từ khoá kích hoạt: tin nào chạm danh sách chặn thì máy im lặng."
                >
                  <AutoReplyFields value={ar} onChange={setAr} />
                </KhoiCaiDat>
              </div>
            </TabsContent>

            {/* -------------------------------------------------- NHẬT KÝ */}
            <TabsContent value="nhatky">
              <div style={{ maxHeight: '58vh', overflowY: 'auto', paddingRight: 4 }}>
                <p style={{ fontSize: 12, color: CHU_MO, margin: '2px 0 10px' }}>
                  Mỗi lượt engine chạy đều ghi một dòng, <b>kể cả lượt quyết định không gửi</b>.
                  Nhật ký trống nhiều ngày trong khi tính năng đang bật là dấu hiệu tài khoản Zalo
                  đã rớt phiên — lúc đó tự động hoá ngừng trong im lặng.
                </p>
                <RunLog runs={runs} loading={dangTaiRuns} />
              </div>
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span style={{ fontSize: 11.5, color: coDoi && tab !== 'nhatky' ? 'hsl(17 88% 38%)' : CHU_MO, fontWeight: coDoi && tab !== 'nhatky' ? 600 : 400 }}>
            {tab === 'nhatky'
              ? 'Nhật ký chỉ đọc — worker là bên ghi.'
              : coDoi ? 'Có thay đổi chưa lưu ở tab này.' : 'Nút Lưu chỉ ghi tab đang mở.'}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={luu.isPending}>
              Đóng
            </Button>
            {tab !== 'nhatky' && (
              <Button onClick={luuTab} disabled={luu.isPending || isLoading}>
                {luu.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {tab === 'broadcast' ? 'Lưu lịch gửi' : 'Lưu tự động trả lời'}
              </Button>
            )}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Công tắc chính của một tab — tách ra vì hai tab dùng chung đúng một bố cục. */
function CongTacChinh({ bat, onBat, ten, moTa }: { bat: boolean; onBat: (v: boolean) => void; ten: string; moTa: string }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        border: `1px solid ${bat ? 'hsl(152 35% 84%)' : VIEN}`,
        background: bat ? 'hsl(152 40% 98%)' : 'transparent',
        borderRadius: 12, padding: '11px 14px',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{ten}</div>
        <p style={{ fontSize: 11.5, color: CHU_MO, margin: '3px 0 0', lineHeight: 1.5 }}>{moTa}</p>
      </div>
      <Switch checked={bat} onCheckedChange={onBat} />
    </div>
  );
}

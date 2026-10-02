import { QueryRegion } from '@/components/errors/QueryRegion';
import { LoadingState } from '@/components/loading/LoadingState';
import { focusFirstError } from '@/lib/formErrors';
import { actionErrorMessage } from '@/lib/actionFeedback';
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
  const configQuery = useZaloAutomationConfigs(open);
  const { data, isLoading } = configQuery;
  // Nhật ký chỉ nạp khi dialog mở — cùng lý do với cấu hình: đây là màn người
  // dùng chủ động mở, không phải thứ trang chat phải trả tiền băng thông cho.
  const runsQuery = useZaloAutomationRuns(open);
  const { data: runs = [], isLoading: dangTaiRuns } = runsQuery;
  const luu = useSaveAutomation();

  const [tab, setTab] = useState<Tab>('broadcast');
  const [errors,setErrors] = useState<Record<string,string>>({});
  const [serverError,setServerError] = useState('');

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
    if(configQuery.isError || !daNap.current) return;
    const fields:Record<string,string>={};
    if(tab==='broadcast' && bcBat){
      if(!bc.recipients.length) fields.recipients='Chọn ít nhất một người nhận trước khi bật lịch gửi.';
      if(!bc.template.blocks.length) fields.template='Chọn ít nhất một khối nội dung trước khi bật lịch gửi.';
    }
    if(tab==='reply' && arBat && !ar.keywords.length) fields.keywords='Thêm từ khóa kích hoạt trước khi bật tự động trả lời.';
    setErrors(fields);setServerError('');
    if(Object.keys(fields).length){void focusFirstError(fields,{order:['recipients','template','keywords']});return;}

    if (tab === 'broadcast') {
      const sach = chuanHoaBroadcast(bc);
      luu.mutate(
        { kind: 'broadcast_vacant', enabled: bcBat, config: sach },
        {
          onError: error => setServerError(actionErrorMessage(error,"Chưa lưu được cài đặt tự động hóa Zalo")),
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
          onError: error => setServerError(actionErrorMessage(error,"Chưa lưu được cài đặt tự động hóa Zalo")),
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

        {/* Chỉ phần cấu hình chờ dữ liệu; chân hộp (Đóng/Lưu) hiện ngay — Lưu vẫn khoá
            theo isLoading/isError như cũ. Chủ chốt 02/10/2026: khối xám, không chữ "Đang tải". */}
        <QueryRegion label="Cài đặt tự động hóa Zalo" queries={[configQuery]} skeleton="detail" rows={6}>
        {isLoading && !daNap.current ? (
          <LoadingState label="cấu hình" variant="detail" rows={6} />
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
                  <div data-field-name="recipients" tabIndex={-1} aria-invalid={!!errors.recipients} className="rounded aria-[invalid=true]:border aria-[invalid=true]:border-destructive">
                  <RecipientPicker
                    conversations={conversations}
                    value={bc.recipients}
                    onChange={(ids) => setBc({ ...bc, recipients: ids })}
                  />
                  {errors.recipients && <p role="alert" className="text-sm text-destructive">{errors.recipients}</p>}</div>
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
                  <div data-field-name="template" tabIndex={-1} aria-invalid={!!errors.template} className="rounded aria-[invalid=true]:border aria-[invalid=true]:border-destructive">
                  <TemplateBuilder
                    value={bc.template}
                    onChange={(t) => setBc({ ...bc, template: t })}
                    eventDriven={bc.eventDriven}
                    onEventDrivenChange={(e) => setBc({ ...bc, eventDriven: e })}
                  />
                  {errors.template && <p role="alert" className="text-sm text-destructive">{errors.template}</p>}</div>
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
                  <div data-field-name="keywords" tabIndex={-1} aria-invalid={!!errors.keywords} className="rounded aria-[invalid=true]:border aria-[invalid=true]:border-destructive"><AutoReplyFields value={ar} onChange={setAr} />{errors.keywords && <p role="alert" className="text-sm text-destructive">{errors.keywords}</p>}</div>
                </KhoiCaiDat>
              </div>
            </TabsContent>

            {/* -------------------------------------------------- NHẬT KÝ */}
            <TabsContent value="nhatky">
              <div style={{ maxHeight: '58vh', overflowY: 'auto', paddingRight: 4 }}>
                <p style={{ fontSize: 12, color: CHU_MO, margin: '2px 0 10px' }}>
                  Mỗi lượt tự động chạy đều ghi một dòng, <b>kể cả lượt quyết định không gửi</b>.
                  Nhật ký trống nhiều ngày trong khi tính năng đang bật là dấu hiệu tài khoản Zalo
                  đã rớt phiên — lúc đó tự động hoá ngừng trong im lặng.
                </p>
                <QueryRegion label="Nhật ký tự động hóa Zalo" queries={[runsQuery]} skeleton="table" rows={4}><RunLog runs={runs} loading={dangTaiRuns} /></QueryRegion>
              </div>
            </TabsContent>
          </Tabs>
        )}
        </QueryRegion>

        {serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}
        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span style={{ fontSize: 11.5, color: coDoi && tab !== 'nhatky' ? 'hsl(17 88% 38%)' : CHU_MO, fontWeight: coDoi && tab !== 'nhatky' ? 600 : 400 }}>
            {tab === 'nhatky'
              ? 'Nhật ký ghi lại kết quả xử lý tự động.'
              : coDoi ? 'Có thay đổi chưa lưu ở tab này.' : 'Nút Lưu chỉ ghi tab đang mở.'}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={luu.isPending}>
              Đóng
            </Button>
            {tab !== 'nhatky' && (
              <Button onClick={luuTab} disabled={luu.isPending || isLoading || configQuery.isError}>
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

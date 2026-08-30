// Bảng tình huống cho bộ quyết định broadcast. Đây là chỗ chủ dự án mô tả bằng
// lời ("đầy đủ khi nào, gọn khi nào — theo ngày VÀ theo việc có thêm phòng mới")
// nên nó phải kiểm được bằng bảng, không phải bằng cách chạy thử worker.
import { describe, it, expect } from 'vitest';
import { chuanHoaBroadcast } from '../lib/automation-config.js';
import {
  chonCheDo, chonLuotBoSung, conLaiTrongTran, gioVietNam,
  toiLuotTheoLich, trongKhungGio, vanTayDanhSach, TRE_TOI_DA_PHUT,
} from '../lib/automation-scenario.js';

/** 2026-08-31 là THỨ HAI. Chuỗi ISO có Z nên phải cộng 7h mới ra giờ VN. */
const vaoLuc = (isoVN) => new Date(`${isoVN}+07:00`);

const phong = (id, over = {}) => ({
  id, code: id.toUpperCase(), price: 4.5, status: 'free', availDate: null, ...over,
});

const cfg = (over = {}) => chuanHoaBroadcast({
  recipients: ['c1'],
  schedule: { time: '08:30', days: { mon: 'full', tue: 'compact', wed: 'compact', thu: 'compact', fri: 'compact', sat: 'compact', sun: 'off' } },
  ...over,
});

describe('gioVietNam', () => {
  it('đọc đúng ngày/thứ/phút theo múi giờ VN, không theo múi giờ máy chạy', () => {
    // 2026-08-31T01:00 UTC = 08:00 giờ VN, vẫn là thứ Hai.
    const t = gioVietNam(new Date('2026-08-31T01:00:00Z'));
    expect(t).toMatchObject({ ngay: '2026-08-31', thu: 'mon', gio: '08:00', phut: 480 });
  });

  it('cuối ngày UTC vẫn là NGÀY HÔM SAU ở Việt Nam', () => {
    // 23:00 UTC ngày 30 = 06:00 VN ngày 31. Nếu lấy nhầm ngày UTC thì sổ
    // "đã chạy hôm nay" sẽ lệch và engine gửi hai lần.
    const t = gioVietNam(new Date('2026-08-30T23:00:00Z'));
    expect(t.ngay).toBe('2026-08-31');
    expect(t.thu).toBe('mon');
  });
});

describe('vanTayDanhSach', () => {
  it('không đổi khi chỉ đảo thứ tự phòng', () => {
    const a = [phong('r1'), phong('r2')];
    expect(vanTayDanhSach(a)).toBe(vanTayDanhSach([...a].reverse()));
  });

  it('đổi khi giá đổi, khi trạng thái đổi, khi thêm phòng', () => {
    const goc = vanTayDanhSach([phong('r1')]);
    expect(vanTayDanhSach([phong('r1', { price: 5 })])).not.toBe(goc);
    expect(vanTayDanhSach([phong('r1', { status: 'soon' })])).not.toBe(goc);
    expect(vanTayDanhSach([phong('r1'), phong('r2')])).not.toBe(goc);
  });

  it('KHÔNG đổi khi sửa thứ người nhận không nhìn thấy', () => {
    // Ghi chú nội bộ đổi mà bảng gửi đi y hệt thì không phải "có thay đổi" —
    // nếu tính là thay đổi, quy tắc "bỏ lượt khi không đổi" sẽ vô hiệu.
    const a = vanTayDanhSach([{ ...phong('r1'), saleNote: 'x', description: 'y' }]);
    const b = vanTayDanhSach([{ ...phong('r1'), saleNote: 'ĐỔI HẾT', description: 'khác' }]);
    expect(a).toBe(b);
  });
});

describe('toiLuotTheoLich', () => {
  it('chưa tới giờ thì chưa chạy', () => {
    const r = toiLuotTheoLich({ now: vaoLuc('2026-08-31T07:00'), config: cfg(), stats: {} });
    expect(r.chay).toBe(false);
    expect(r.lyDo).toContain('Chưa tới giờ');
  });

  it('tới giờ thì chạy', () => {
    const r = toiLuotTheoLich({ now: vaoLuc('2026-08-31T08:30'), config: cfg(), stats: {} });
    expect(r.chay).toBe(true);
  });

  it('đã chạy hôm nay thì thôi', () => {
    const r = toiLuotTheoLich({
      now: vaoLuc('2026-08-31T09:00'), config: cfg(), stats: { lastScheduledDate: '2026-08-31' },
    });
    expect(r.chay).toBe(false);
    expect(r.lyDo).toContain('đã chạy');
  });

  it('trễ quá ngưỡng thì bỏ lượt thay vì gửi muộn', () => {
    const tre = 8 * 60 + 30 + TRE_TOI_DA_PHUT + 10; // phút trong ngày
    const gio = String(Math.floor(tre / 60)).padStart(2, '0');
    const phut = String(tre % 60).padStart(2, '0');
    const r = toiLuotTheoLich({ now: vaoLuc(`2026-08-31T${gio}:${phut}`), config: cfg(), stats: {} });
    expect(r.chay).toBe(false);
    expect(r.lyDo).toContain('bỏ lượt hôm nay');
  });
});

describe('trongKhungGio', () => {
  const anti = (from, to) => cfg({ antiSpam: { allowedHours: { from, to } } }).antiSpam;

  it('trong khung ban ngày', () => {
    expect(trongKhungGio(vaoLuc('2026-08-31T10:00'), anti('08:00', '20:00')).trong).toBe(true);
  });

  it('ngoài khung thì nêu lý do đọc được', () => {
    const r = trongKhungGio(vaoLuc('2026-08-31T22:00'), anti('08:00', '20:00'));
    expect(r.trong).toBe(false);
    expect(r.lyDo).toContain('08:00–20:00');
  });

  it('khung vắt qua nửa đêm vẫn hiểu đúng', () => {
    const a = anti('20:00', '08:00');
    expect(trongKhungGio(vaoLuc('2026-08-31T23:00'), a).trong).toBe(true);
    expect(trongKhungGio(vaoLuc('2026-08-31T02:00'), a).trong).toBe(true);
    expect(trongKhungGio(vaoLuc('2026-08-31T12:00'), a).trong).toBe(false);
  });
});

describe('chonCheDo — kịch bản theo NGÀY × THAY ĐỔI', () => {
  const rooms = [phong('r1'), phong('r2')];
  const hash = vanTayDanhSach(rooms);

  it('thứ Hai cài ĐẦY ĐỦ → full', () => {
    const r = chonCheDo({ now: vaoLuc('2026-08-31T08:30'), config: cfg(), stats: { lastRoomsHash: 'khac', knownRoomIds: ['r1', 'r2'] }, rooms });
    expect(r.mode).toBe('full');
    expect(r.reason).toContain('Thứ 2');
  });

  it('Chủ nhật cài "không gửi" → off', () => {
    const r = chonCheDo({ now: vaoLuc('2026-09-06T08:30'), config: cfg(), stats: {}, rooms });
    expect(r.mode).toBe('off');
    expect(r.reason).toContain('Chủ nhật');
  });

  it('ngày cài GỌN + danh sách y hệt → bỏ lượt', () => {
    const r = chonCheDo({
      now: vaoLuc('2026-09-01T08:30'), config: cfg(),
      stats: { lastRoomsHash: hash, knownRoomIds: ['r1', 'r2'] }, rooms,
    });
    expect(r.mode).toBe('skipped');
    expect(r.reason).toContain('không đổi');
  });

  it('ngày cài GỌN + có phòng MỚI → nâng thành ĐẦY ĐỦ', () => {
    const r = chonCheDo({
      now: vaoLuc('2026-09-01T08:30'), config: cfg(),
      stats: { lastRoomsHash: 'khac', knownRoomIds: ['r1'] }, rooms,
    });
    expect(r.mode).toBe('full');
    expect(r.reason).toContain('phòng trống MỚI');
    expect(r.phongMoi).toEqual(['r2']);
  });

  it('tắt quy tắc nâng cấp → giữ GỌN dù có phòng mới', () => {
    const r = chonCheDo({
      now: vaoLuc('2026-09-01T08:30'),
      config: cfg({ schedule: { time: '08:30', days: cfg().schedule.days, upgradeOnNewRooms: false } }),
      stats: { lastRoomsHash: 'khac', knownRoomIds: ['r1'] }, rooms,
    });
    expect(r.mode).toBe('compact');
  });

  it('tắt quy tắc bỏ lượt → vẫn gửi dù không đổi', () => {
    const r = chonCheDo({
      now: vaoLuc('2026-09-01T08:30'),
      config: cfg({ schedule: { time: '08:30', days: cfg().schedule.days, skipIfUnchanged: false } }),
      stats: { lastRoomsHash: hash, knownRoomIds: ['r1', 'r2'] }, rooms,
    });
    expect(r.mode).toBe('compact');
  });

  it('LẦN ĐẦU chạy (chưa có sổ phòng cũ) KHÔNG tự nâng thành đầy đủ', () => {
    // Nếu coi mọi phòng là "mới" ở lần đầu, người dùng vừa bật tính năng đã ăn
    // ngay một tràng tin chi tiết — đúng thứ làm nhóm tắt thông báo.
    const r = chonCheDo({ now: vaoLuc('2026-09-01T08:30'), config: cfg(), stats: {}, rooms });
    expect(r.mode).toBe('compact');
    expect(r.phongMoi).toEqual([]);
  });

  it('không còn phòng nào → bỏ lượt, không gửi bảng rỗng', () => {
    const r = chonCheDo({ now: vaoLuc('2026-08-31T08:30'), config: cfg(), stats: {}, rooms: [] });
    expect(r.mode).toBe('skipped');
    expect(r.reason).toContain('không gửi bảng rỗng');
  });
});

describe('chonLuotBoSung — gom sự kiện phòng mới trong ngày', () => {
  const rooms = [phong('r1'), phong('r2')];

  it('chưa có mốc so sánh thì chưa gửi bổ sung', () => {
    const r = chonLuotBoSung({ now: vaoLuc('2026-08-31T14:00'), config: cfg(), stats: {}, rooms });
    expect(r.gui).toBe(false);
  });

  it('thấy phòng mới lần đầu → bắt đầu đếm giờ gom', () => {
    const r = chonLuotBoSung({
      now: vaoLuc('2026-08-31T14:00'), config: cfg(),
      stats: { knownRoomIds: ['r1'] }, rooms,
    });
    expect(r.gui).toBe(false);
    expect(r.batDauGom).toBe(true);
    expect(r.phongMoi).toEqual(['r2']);
  });

  it('chưa đủ thời gian gom thì chưa gửi', () => {
    const r = chonLuotBoSung({
      now: vaoLuc('2026-08-31T14:10'), config: cfg(),
      stats: { knownRoomIds: ['r1'], pendingSince: vaoLuc('2026-08-31T14:00').toISOString() }, rooms,
    });
    expect(r.gui).toBe(false);
    expect(r.reason).toContain('Đang gom');
  });

  it('đủ thời gian gom thì gửi', () => {
    const r = chonLuotBoSung({
      now: vaoLuc('2026-08-31T15:00'), config: cfg(),
      stats: { knownRoomIds: ['r1'], pendingSince: vaoLuc('2026-08-31T14:00').toISOString() }, rooms,
    });
    expect(r.gui).toBe(true);
    expect(r.phongMoi).toEqual(['r2']);
  });

  it('đồng hồ gom tính từ lần ĐẦU thấy phòng mới, không bị phòng mới sau đẩy lùi', () => {
    // Phòng trống rả rích cả buổi: nếu mốc chờ bị đặt lại mỗi lần thấy phòng
    // mới thì tin bổ sung không bao giờ được gửi.
    const stats = { knownRoomIds: ['r1'], pendingSince: vaoLuc('2026-08-31T14:00').toISOString() };
    const themPhong = [...rooms, phong('r3')];
    const r = chonLuotBoSung({ now: vaoLuc('2026-08-31T14:50'), config: cfg(), stats, rooms: themPhong });
    expect(r.gui).toBe(true);
    expect(r.phongMoi.sort()).toEqual(['r2', 'r3']);
  });

  it('tắt gửi bổ sung thì không bao giờ gửi', () => {
    const r = chonLuotBoSung({
      now: vaoLuc('2026-08-31T15:00'),
      config: cfg({ eventDriven: { enabled: false } }),
      stats: { knownRoomIds: ['r1'], pendingSince: vaoLuc('2026-08-31T14:00').toISOString() }, rooms,
    });
    expect(r.gui).toBe(false);
  });
});

describe('conLaiTrongTran', () => {
  it('sổ đếm của ngày khác được coi như 0', () => {
    const r = conLaiTrongTran(vaoLuc('2026-08-31T10:00'), cfg(), { sentDate: '2026-08-30', sentToday: 100 });
    expect(r.daGui).toBe(0);
    expect(r.conLai).toBe(cfg().antiSpam.dailyCap);
  });

  it('đếm đúng phần còn lại trong ngày', () => {
    const c = cfg({ antiSpam: { dailyCap: 10 } });
    const r = conLaiTrongTran(vaoLuc('2026-08-31T10:00'), c, { sentDate: '2026-08-31', sentToday: 7 });
    expect(r.conLai).toBe(3);
  });

  it('không trả số âm khi đã vượt trần', () => {
    const c = cfg({ antiSpam: { dailyCap: 10 } });
    const r = conLaiTrongTran(vaoLuc('2026-08-31T10:00'), c, { sentDate: '2026-08-31', sentToday: 99 });
    expect(r.conLai).toBe(0);
  });
});

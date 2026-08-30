import { describe, expect, it } from 'vitest';

import {
  CHE_DO_NGAY,
  KHOA_NGAY,
  KHOI_MAC_DINH,
  MAC_DINH_AUTO_REPLY,
  MAC_DINH_BROADCAST,
  chuanHoaAutoReply,
  chuanHoaBroadcast,
} from '../automationConfig';

/**
 * ĐỐI CHIẾU HAI NỬA CỦA MỘT HỢP ĐỒNG.
 *
 * VÌ SAO FILE NÀY TỒN TẠI — để bắt lỗi "sửa một bên quên bên kia".
 *   `zalo_automations.config` là `jsonb` tự do. Web (`../automationConfig.ts`)
 *   GHI vào đó, worker (`worker/lib/automation-config.js`) ĐỌC ra. Không có kiểu,
 *   không có constraint, không có migration nào ép hai đầu khớp nhau — nên hai
 *   bản mặc định có thể trôi khỏi nhau mà mọi test khác vẫn xanh.
 *
 *   Kiểu trôi đó hỏng IM LẶNG và hỏng ĐÚNG CHỖ ĐAU: đổi `gapBetweenRecipientsSec`
 *   mặc định ở một bên thôi thì form web lưu 180 còn worker kẹp theo số khác, và
 *   thứ người dùng thấy trên màn hình không phải thứ máy sẽ gửi. Sai nhịp giãn là
 *   dấu hiệu bot — cái giá là Zalo khoá nick, không phải một dòng log.
 *
 *   Nên test này KHÔNG chép giá trị mong đợi vào đây (chép là đẻ ra bản sao thứ
 *   ba sẽ trôi tiếp). Nó NẠP THẬT cả hai module rồi so.
 *
 * VÌ SAO IMPORT ĐỘNG QUA BIẾN, KHÔNG PHẢI `import ... from '...js'`
 *   `tsconfig.app.json` không bật `allowJs`, nên mọi lời import tĩnh tới một file
 *   `.js` ngoài `src/` là một lỗi TypeScript (`TS7016`) — lỗi CẤU HÌNH, không
 *   liên quan gì tới thứ test này kiểm. Repo đã có sẵn lối đi cho đúng tình huống
 *   này: nạp bằng `await import(<biến>)` (xem
 *   `src/types/__tests__/scriptsMjsDeclarations.test.ts`). Đường dẫn vì thế phải
 *   ĐÚNG lúc chạy chứ trình biên dịch không đỡ được — bốn cấp `..` đưa từ
 *   `src/components/chat-zalo/__tests__/` về gốc repo, rồi mới xuống `worker/lib/`.
 */

/** Bề mặt của module worker mà test này dùng tới. */
interface HopDongWorker {
  KHOA_NGAY: string[];
  CHE_DO_NGAY: string[];
  KHOI_MAC_DINH: string[];
  MAC_DINH_BROADCAST: unknown;
  MAC_DINH_AUTO_REPLY: unknown;
  chuanHoaBroadcast: (raw: unknown) => unknown;
  chuanHoaAutoReply: (raw: unknown) => unknown;
}

// Kiểu `string` tường minh (không để suy ra literal) để trình biên dịch coi đây
// là specifier động và không đi phân giải file `.js` — xem ghi chú bên trên.
const DUONG_DAN_WORKER: string = '../../../../worker/lib/automation-config.js';

const worker = (await import(/* @vite-ignore */ DUONG_DAN_WORKER)) as HopDongWorker;

/**
 * Đầu vào rác: mỗi dòng là một cách config có thể xấu đi trong thực tế — bản ghi
 * cũ thiếu khoá, người dùng sửa tay trong DB, form web cũ ghi sai kiểu.
 */
const DAU_VAO_RAC: { ten: string; raw: unknown }[] = [
  { ten: 'object rỗng', raw: {} },
  { ten: 'null', raw: null },
  { ten: 'undefined', raw: undefined },
  { ten: 'không phải object (chuỗi)', raw: 'linh tinh' },
  { ten: 'mảng thay vì object', raw: [1, 2, 3] },
  { ten: 'giờ vô nghĩa 99:99', raw: { schedule: { time: '99:99' } } },
  { ten: 'giờ thiếu số 0 "8:5"', raw: { schedule: { time: '8:5' } } },
  { ten: 'giờ là số, không phải chuỗi', raw: { schedule: { time: 830 } } },
  { ten: 'blocks rỗng (tắt hết — HỢP LỆ)', raw: { template: { blocks: [] } } },
  {
    ten: 'blocks có khối lạ + trùng, sai thứ tự',
    raw: { template: { blocks: ['room_details', 'khong_co_that', 'room_details', 'link'] } },
  },
  { ten: 'blocks không phải mảng', raw: { template: { blocks: 'link' } } },
  { ten: 'shareUrl thừa khoảng trắng', raw: { template: { shareUrl: '  https://x.vn/a  ' } } },
  { ten: 'introText rỗng (lấy lại mặc định)', raw: { template: { introText: '   ' } } },
  { ten: 'giãn nhịp = 0 (kẹp lên trần dưới)', raw: { antiSpam: { gapBetweenRecipientsSec: 0 } } },
  {
    ten: 'số âm + vượt trần + số dạng chuỗi',
    raw: { antiSpam: { gapBetweenRecipientsSec: -5, dailyCap: 999999, maxRoomsPerRun: '7', gapBetweenRoomMsgsSec: 2.6 } },
  },
  { ten: 'allowedHours sai kiểu', raw: { antiSpam: { allowedHours: 'cả ngày' } } },
  { ten: 'days sai chế độ', raw: { schedule: { days: { mon: 'FULL', tue: 'off', sun: 123 } } } },
  { ten: 'cờ boolean dạng chuỗi', raw: { schedule: { upgradeOnNewRooms: 'false', skipIfUnchanged: false } } },
  { ten: 'eventDriven tắt + debounce rác', raw: { eventDriven: { enabled: false, debounceMinutes: 'x' } } },
  { ten: 'recipients trùng lặp + phần tử rác', raw: { recipients: ['a', 'a', ' b ', '', null, 7] } },
  { ten: 'recipients không phải mảng', raw: { recipients: 'a,b' } },
  { ten: 'keywords rỗng (tắt mềm — HỢP LỆ)', raw: { keywords: [] } },
  { ten: 'blockedKeywords rỗng (LẤY LẠI mặc định)', raw: { blockedKeywords: [] } },
  { ten: 'keywords viết HOA + trùng', raw: { keywords: ['PHÒNG', 'Phòng', 'GIÁ'] } },
  { ten: 'blockedKeywords tự đặt', raw: { blockedKeywords: ['CỌC', ' hợp đồng ', 'cọc'] } },
  { ten: 'replyIntro rỗng + cooldown rác', raw: { replyIntro: '', cooldownMinutes: 'x', dailyCap: 0, includeRoomList: false } },
];

describe('hợp đồng cấu hình tự động hoá Zalo — web ↔ worker', () => {
  it('chống-xanh-rỗng: nạp được module worker và nó có đủ bề mặt', () => {
    expect(typeof worker.chuanHoaBroadcast).toBe('function');
    expect(typeof worker.chuanHoaAutoReply).toBe('function');
    expect(Array.isArray(worker.KHOA_NGAY)).toBe(true);
    expect(DAU_VAO_RAC.length).toBeGreaterThanOrEqual(20);
  });

  it('KHOA_NGAY khớp nhau (thứ tự tính, vì 0 = Chủ nhật theo Date.getDay())', () => {
    expect(KHOA_NGAY).toEqual(worker.KHOA_NGAY);
    expect(KHOA_NGAY).toEqual(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  });

  it('CHE_DO_NGAY khớp nhau', () => {
    expect(CHE_DO_NGAY).toEqual(worker.CHE_DO_NGAY);
  });

  it('KHOI_MAC_DINH khớp nhau (thứ tự tính, đó là thứ tự khối trong tin)', () => {
    expect(KHOI_MAC_DINH).toEqual(worker.KHOI_MAC_DINH);
    expect(KHOI_MAC_DINH).toEqual(['link', 'table_image', 'room_details']);
  });

  it('MAC_DINH_BROADCAST khớp nhau tới từng giá trị', () => {
    expect(MAC_DINH_BROADCAST).toEqual(worker.MAC_DINH_BROADCAST);
  });

  it('MAC_DINH_AUTO_REPLY khớp nhau tới từng giá trị', () => {
    expect(MAC_DINH_AUTO_REPLY).toEqual(worker.MAC_DINH_AUTO_REPLY);
  });
});

describe('chuanHoaBroadcast — hai bản cho cùng kết quả', () => {
  for (const { ten, raw } of DAU_VAO_RAC) {
    it(`khớp với đầu vào: ${ten}`, () => {
      expect(chuanHoaBroadcast(raw)).toEqual(worker.chuanHoaBroadcast(raw));
    });
  }

  it('mặc định là điểm bất động: chuẩn hoá object rỗng ⇒ đúng bản mặc định', () => {
    expect(chuanHoaBroadcast({})).toEqual(MAC_DINH_BROADCAST);
    expect(worker.chuanHoaBroadcast({})).toEqual(MAC_DINH_BROADCAST);
  });

  it('blocks rỗng là lựa chọn HỢP LỆ — không bị dựng lại thành mặc định', () => {
    expect(chuanHoaBroadcast({ template: { blocks: [] } }).template.blocks).toEqual([]);
    expect(chuanHoaBroadcast({ template: { blocks: ['room_details', 'la', 'room_details', 'link'] } }).template.blocks)
      .toEqual(['room_details', 'link']);
  });

  it('trần dưới của giãn nhịp là phanh cứng: 0 ⇒ 30 giây', () => {
    expect(chuanHoaBroadcast({ antiSpam: { gapBetweenRecipientsSec: 0 } }).antiSpam.gapBetweenRecipientsSec).toBe(30);
  });
});

describe('chuanHoaAutoReply — hai bản cho cùng kết quả', () => {
  for (const { ten, raw } of DAU_VAO_RAC) {
    it(`khớp với đầu vào: ${ten}`, () => {
      expect(chuanHoaAutoReply(raw)).toEqual(worker.chuanHoaAutoReply(raw));
    });
  }

  it('mặc định là điểm bất động: chuẩn hoá object rỗng ⇒ đúng bản mặc định', () => {
    expect(chuanHoaAutoReply({})).toEqual(MAC_DINH_AUTO_REPLY);
    expect(worker.chuanHoaAutoReply({})).toEqual(MAC_DINH_AUTO_REPLY);
  });

  it('keywords rỗng = tắt mềm (giữ rỗng), blockedKeywords rỗng = lấy lại mặc định', () => {
    expect(chuanHoaAutoReply({ keywords: [] }).keywords).toEqual([]);
    expect(chuanHoaAutoReply({ blockedKeywords: [] }).blockedKeywords).toEqual(MAC_DINH_AUTO_REPLY.blockedKeywords);
  });
});

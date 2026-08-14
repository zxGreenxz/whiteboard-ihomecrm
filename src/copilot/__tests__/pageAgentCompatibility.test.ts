// Đọc BUNDLE THẬT của `page-agent` đang cài và đối chiếu với những gì ta khai.
//
// Test này CỐ Ý nhạy với phiên bản. Cả hàng rào UI-control đứng trên ba sự thật
// về thư viện; nâng phiên bản mà một trong ba đổi thì hàng rào dựng sai chỗ —
// và nó vẫn trông như đang hoạt động. Đỏ ở đây là tín hiệu đọc lại bundle, không
// phải tín hiệu sửa số cho xanh.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CSP_CAN_UNSAFE_EVAL,
  DUONG_DA_CHON,
  PHIEN_BAN_DA_DO,
  SU_THAT_DA_DO,
  TOOL_CHAY_MA,
  TOOL_MANG_CHI_SO,
} from '../pageAgentCompatibility';

const controller = readFileSync(
  'node_modules/@page-agent/page-controller/dist/lib/page-controller.js',
  'utf8',
);
const ui = readFileSync('node_modules/@page-agent/ui/dist/lib/page-agent-ui.js', 'utf8');
const pkg = JSON.parse(readFileSync('node_modules/page-agent/package.json', 'utf8')) as {
  version: string;
};

describe('phiên bản đang cài khớp phiên bản đã đo', () => {
  it('page-agent đúng bản đã khảo sát', () => {
    // Mọi khẳng định dưới đây đo trên bản này. Bản khác thì phải đo lại.
    expect(pkg.version).toBe(PHIEN_BAN_DA_DO);
  });
});

describe('sự thật 1+2: whitelist KHÔNG phải bộ lọc', () => {
  it('blacklist chặn, whitelist chỉ THÊM — heuristic vẫn chạy tiếp', () => {
    // Thân hàm thật:
    //   if (interactiveBlacklist.includes(element)) return false;
    //   if (interactiveWhitelist.includes(element)) return true;
    //   … heuristic bình thường …
    // Không có nhánh nào trả `false` cho "không nằm trong whitelist".
    const than = controller.slice(controller.indexOf('function isInteractiveElement'));
    const doan = than.slice(0, 600);

    expect(doan).toMatch(/interactiveBlacklist\.includes\(element\)\)\s*return false/);
    expect(doan).toMatch(/interactiveWhitelist\.includes\(element\)\)\s*return true/);

    // Đây là khẳng định đắt nhất: KHÔNG tồn tại "không trong whitelist ⇒ false".
    expect(doan).not.toMatch(/!\s*interactiveWhitelist\.includes\(element\)\)\s*return false/);
    expect(SU_THAT_DA_DO.whitelistLaBoLoc).toBe(false);
    expect(SU_THAT_DA_DO.blacklistThangWhitelist).toBe(true);
  });

  it('blacklist được kiểm TRƯỚC whitelist', () => {
    const than = controller.slice(controller.indexOf('function isInteractiveElement'), 0 + controller.indexOf('function isInteractiveElement') + 600);
    expect(than.indexOf('interactiveBlacklist')).toBeLessThan(than.indexOf('interactiveWhitelist'));
  });

  it('bộ duyệt đi vào shadow root và iframe — phần bù không dựng nổi từ light DOM', () => {
    // `document.querySelectorAll('*')` của mã ứng dụng không thấy hai chỗ này,
    // nên một blacklist dựng từ light DOM bỏ sót đúng những control khó thấy nhất.
    expect(controller).toMatch(/shadowRoot/);
    expect(controller).toMatch(/contentDocument|iframe/i);
    expect(SU_THAT_DA_DO.duyetShadowRoot).toBe(true);
    expect(SU_THAT_DA_DO.duyetIframe).toBe(true);
  });

  it('đường đã chọn là tool ngữ nghĩa, không phải whitelist', () => {
    expect(DUONG_DA_CHON).toBe('semantic_tools');
  });
});

describe('sự thật 3: eval chỉ nằm trong executeJavascript', () => {
  it('đúng MỘT lần gọi eval trong bundle, và nó ở trong executeJavascript', () => {
    const lanGoi = [...controller.matchAll(/\beval\(|new Function\(/g)];
    expect(lanGoi, 'số lần gọi eval đã đổi — đọc lại bundle trước khi tin CSP').toHaveLength(1);

    const viTri = lanGoi[0].index ?? 0;
    const truoc = controller.slice(Math.max(0, viTri - 400), viTri);
    expect(truoc, 'eval nằm ngoài executeJavascript — CSP sẽ phải nới').toMatch(
      /async executeJavascript\(/,
    );
    expect(SU_THAT_DA_DO.evalNgoaiExecuteJavascript).toBe(false);
  });

  it('KHÔNG có eval lúc nạp module — CSP production không cần unsafe-eval', () => {
    // Hệ quả trái với giả định cũ (spec F6): thư viện không cần `eval` để chạy,
    // nó chỉ cần `eval` để thực thi mã tuỳ ý — thứ ta đã tắt.
    const truocClass = controller.slice(0, controller.indexOf('async executeJavascript('));
    expect(truocClass).not.toMatch(/\beval\(|new Function\(/);
    expect(CSP_CAN_UNSAFE_EVAL).toBe(false);
  });
});

describe('tool mang chỉ số có thật trong bundle', () => {
  it('mọi tool ta định tắt đều TỒN TẠI — tắt một tên không có thật là tắt hư không', () => {
    for (const ten of TOOL_MANG_CHI_SO) {
      expect(ui, `bundle không khai tool "${ten}"`).toContain(ten);
    }
    expect(controller).toContain(TOOL_CHAY_MA.replace('execute_javascript', 'executeJavascript'));
  });

  it('danh sách tool mang chỉ số không bỏ sót tool nhận index nào', () => {
    // Quét tên tool trong bundle UI rồi đối chiếu: tool nào nhận `index` mà
    // không nằm trong danh sách của ta là một cửa còn mở.
    const tenTool = new Set(
      [...ui.matchAll(/['"]((?:click|input|select|scroll)[a-z_]*)['"]/g)].map((m) => m[1]),
    );
    const nhanIndex = [...tenTool].filter((t) => /_by_index$/.test(t));
    for (const t of nhanIndex) {
      expect(TOOL_MANG_CHI_SO as readonly string[], `tool "${t}" nhận index nhưng chưa bị tắt`).toContain(t);
    }
  });
});

describe('createAgent thật sự tắt các tool đó', () => {
  const nguonAgent = readFileSync('src/copilot/createAgent.ts', 'utf8');

  /** Bỏ dòng chú thích — chú thích nhắc tên tool là để giải thích, không phải mã. */
  const maAgent = nguonAgent
    .split(/\r?\n/)
    .filter((d) => !d.trim().startsWith('//') && !d.trim().startsWith('*'))
    .join('\n');

  it('mọi tool mang chỉ số đều bị đặt null trong customTools', () => {
    // Khai trong TOOL_MANG_CHI_SO mà quên tắt ở createAgent thì hằng số kia chỉ
    // là một lời bình luận. Đọc mã để chắc hai chỗ khớp nhau.
    for (const ten of TOOL_MANG_CHI_SO) {
      expect(maAgent, `createAgent chưa tắt "${ten}"`).toMatch(
        new RegExp(`${ten}:\\s*null`),
      );
    }
    expect(maAgent).toMatch(/execute_javascript:\s*null/);
  });

  it('KHÔNG dựa vào interactiveWhitelist làm hàng rào', () => {
    // Dùng whitelist làm hàng rào là hiểu sai semantics đã đo ở trên. Nếu nó
    // xuất hiện trong MÃ thì hoặc bundle đã đổi (test trên đỏ trước), hoặc ai đó
    // vừa dựng một hàng rào không chặn gì cả.
    expect(maAgent).not.toMatch(/interactiveWhitelist/);
  });

  it('vẫn GIỮ interactiveBlacklist làm phòng thủ chiều sâu', () => {
    // Tắt tool mang chỉ số là chốt chặn chính, nhưng bỏ luôn blacklist thì mất
    // lớp bắt nút nguy hiểm theo nhãn — hai lớp phục vụ hai kiểu hỏng khác nhau.
    expect(maAgent).toMatch(/interactiveBlacklist/);
  });
});

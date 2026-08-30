// Giải phần tử theo ID NGỮ NGHĨA, ngay trước khi thao tác.
//
// VÌ SAO TỒN TẠI
//   Ba tool mang chỉ số của `page-agent` đã bị tắt (xem `createAgent.ts` và
//   `pageAgentCompatibility.ts`). Nhưng UI-control vẫn cần chạm được vào một số
//   control — ô lọc, ô nhập của một form nháp. Vấn đề là chạm bằng CÁCH NÀO.
//
//   Chỉ số phần tử là sai vì nó trỏ vào một bảng chứa gần như toàn bộ giao diện.
//   Nhãn văn bản cũng sai: nhãn đổi theo ngôn ngữ, theo trạng thái, và hai nút
//   khác nhau hoàn toàn có thể cùng ghi "Lưu". CSS selector thì cho phép mô hình
//   tự viết đường đi tới bất cứ đâu.
//
//   Còn lại một cách: mã ứng dụng ĐÁNH DẤU TRƯỚC những control an toàn bằng một
//   ID ổn định, và mô hình chỉ được gọi tên các ID đó. Danh sách ID hợp lệ nằm
//   trong hợp đồng trang, không nằm trong tay mô hình.
//
// GIẢI NGAY TRƯỚC KHI THAO TÁC, KHÔNG DÙNG LẠI THAM CHIẾU CŨ
//   Giữa lúc mô hình "nhìn" trang và lúc nó bấm, React có thể đã render lại,
//   dialog có thể đã đóng, và một phần tử KHÁC có thể đã chiếm đúng vị trí đó.
//   Đây là TOCTOU, và nó không hiếm trong một SPA. Nên mỗi thao tác giải lại từ
//   đầu, và giải xong phải kiểm tra phần tử vẫn thuộc đúng trang, đúng loại.

/** Thuộc tính đánh dấu một control là an toàn cho Copilot chạm vào. */
export const THUOC_TINH_AN_TOAN = 'data-ai-safe';

export type LoaiThaoTac = 'click' | 'input' | 'select';

export interface SafeControlTool {
  description: string;
  inputSchema: import('zod/v4').ZodTypeAny;
  execute: (args: { control_id: string; text?: string }, ctx: { signal: AbortSignal }) => Promise<string>;
}

export interface SafeControlExecutionOptions {
  /**
   * Synchronous last-mile guard. Callers use this to re-check the current route,
   * page contract, rollout, and permission immediately before a DOM mutation.
   */
  beforeDispatch?: () => void;
}

export interface HopDongTrangToiThieu {
  /** Khoá trang trong hợp đồng — dùng để tiền tố ID control. */
  key: string;
  /** Danh sách ID control an toàn của ĐÚNG trang này. */
  safeControlIds: readonly string[];
}

/** Convert a page contract into the id namespace consumed by semantic tools. */
export function hopDongTuPageContract(page: { key: string; safeControlIds: readonly string[] }): HopDongTrangToiThieu {
  return { key: page.key, safeControlIds: page.safeControlIds };
}

export class LoiSafeControl extends Error {
  constructor(
    readonly ma:
      | 'khong_khai_bao'
      | 'khong_thay'
      | 'nhieu_hon_mot'
      | 'sai_loai'
      | 'khong_ket_noi',
    message: string,
  ) {
    super(message);
    this.name = 'LoiSafeControl';
  }
}

/**
 * Mọi gốc DOM cần quét: document, open shadow root, và same-origin iframe.
 *
 * Bộ duyệt của `page-agent` đi vào cả ba (đã đo — xem `pageAgentCompatibility`),
 * nên bộ giải của ta cũng phải đi vào cả ba. Quét thiếu một gốc nghĩa là control
 * ở đó không dùng được, và người viết trang sẽ tưởng mình đánh dấu sai.
 *
 * Iframe KHÁC nguồn bị bỏ qua trong im lặng — truy cập `contentDocument` của nó
 * ném `SecurityError`, và đó là đúng: Copilot không có việc gì bên trong một
 * trang của bên thứ ba.
 */
export function gocDom(root: Document | ShadowRoot = document): (Document | ShadowRoot)[] {
  const ra: (Document | ShadowRoot)[] = [root];
  const dsElement = root.querySelectorAll<HTMLElement>('*');
  for (const el of dsElement) {
    if (el.shadowRoot) ra.push(...gocDom(el.shadowRoot));

    // Nhận diện iframe bằng TÊN THẺ, không bằng `instanceof HTMLIFrameElement`.
    // Lớp toàn cục đó chỉ tồn tại trong trình duyệt; ở môi trường test (repo cố
    // ý không cài jsdom) nó ném `ReferenceError` và làm hỏng cả phép quét — tức
    // một hàng rào chết vì lý do không liên quan gì tới an toàn.
    // Tên thẻ cũng đúng hơn với iframe nằm trong tài liệu khác.
    if (el.tagName?.toLowerCase() === 'iframe') {
      let doc: Document | null = null;
      try {
        doc = (el as HTMLIFrameElement).contentDocument;
      } catch {
        doc = null; // khác nguồn — bỏ qua, đúng như mong muốn
      }
      if (doc) ra.push(...gocDom(doc));
    }
  }
  return ra;
}

/** Phần tử đó có đúng loại để nhận thao tác này không. */
export function hopLoai(el: Element, loai: LoaiThaoTac): boolean {
  const tag = el.tagName.toLowerCase();
  if (loai === 'input') {
    if (tag === 'input') {
      // Ô nhập kiểu nút bấm (submit/button/reset/checkbox/radio) KHÔNG phải chỗ
      // để gõ chữ — cho phép "input" vào chúng là cho phép bấm trá hình.
      const type = (el as HTMLInputElement).type;
      return !['submit', 'button', 'reset', 'checkbox', 'radio', 'image', 'file'].includes(type);
    }
    return tag === 'textarea' || (el as HTMLElement).isContentEditable === true;
  }
  if (loai === 'select') {
    return tag === 'select' || el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'listbox';
  }
  // click: cấm loại type=submit ngay tại đây, dù nó có được đánh dấu an toàn.
  // Đánh dấu nhầm một nút submit là chuyện xảy ra được; để nó lọt thì hàng rào
  // "không bao giờ tự bấm Lưu" mất hiệu lực vì một dòng thuộc tính.
  if (tag === 'button' && (el as HTMLButtonElement).type === 'submit') return false;
  if (tag === 'input' && (el as HTMLInputElement).type === 'submit') return false;
  return true;
}

/**
 * Thoát chuỗi cho selector thuộc tính.
 *
 * `CSS.escape` chỉ có trong trình duyệt; test chạy ở node không có nó (repo cố ý
 * không cài jsdom). Bản dự phòng thoát đúng hai ký tự có thể phá selector khi
 * nằm trong dấu nháy kép — dấu nháy kép và dấu chéo ngược.
 *
 * ID an toàn vốn do mã ứng dụng đặt và đã bị hợp đồng trang giới hạn, nên đây là
 * lớp phòng thủ cuối chứ không phải nơi lọc đầu vào của mô hình.
 */
export function thoatChuoiChon(s: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (typeof css?.escape === 'function') return css.escape(s);
  return s.replace(/["\\]/g, '\\$&');
}

/**
 * Tìm đúng MỘT phần tử mang ID an toàn `controlId` trên trang hiện tại.
 *
 * Ném `LoiSafeControl` cho mọi trường hợp không chắc chắn. Không có nhánh nào
 * "đoán lấy cái đầu": hai phần tử cùng ID nghĩa là trang đánh dấu sai, và bấm
 * bừa một trong hai là bấm vào thứ không ai chọn.
 */
export function giaiSafeControl(
  page: HopDongTrangToiThieu,
  controlId: string,
  loai: LoaiThaoTac,
  root: Document = document,
): HTMLElement {
  if (!page.safeControlIds.includes(controlId)) {
    throw new LoiSafeControl(
      'khong_khai_bao',
      `Control "${controlId}" không nằm trong hợp đồng của trang "${page.key}". ` +
        'Chỉ các control đã khai báo mới chạm được.',
    );
  }

  // Prefer the page-qualified attribute; the unqualified fallback preserves
  // compatibility with legacy controls while still requiring an explicit id.
  const ids = [`${page.key}.${controlId}`, controlId];
  const thay: HTMLElement[] = [];
  for (const id of ids) {
    const chon = `[${THUOC_TINH_AN_TOAN}="${thoatChuoiChon(id)}"]`;
    const found: HTMLElement[] = [];
    for (const goc of gocDom(root)) {
      for (const el of goc.querySelectorAll<HTMLElement>(chon)) {
        if (el.isConnected && !found.includes(el)) found.push(el);
      }
    }
    if (found.length > 0) {
      thay.push(...found);
      break;
    }
  }

  if (thay.length === 0) {
    throw new LoiSafeControl(
      'khong_thay',
      `Không thấy control "${controlId}" trên màn hình. Có thể hộp thoại đã đóng ` +
        'hoặc trang đã đổi — hãy mô tả lại việc cần làm.',
    );
  }
  if (thay.length > 1) {
    throw new LoiSafeControl(
      'nhieu_hon_mot',
      `Có ${thay.length} phần tử cùng mang ID "${controlId}". Trang đang đánh dấu sai; ` +
        'không thao tác để khỏi chạm nhầm.',
    );
  }

  const el = thay[0]!;
  if (!hopLoai(el, loai)) {
    throw new LoiSafeControl(
      'sai_loai',
      `Control "${controlId}" không nhận thao tác "${loai}".`,
    );
  }
  return el;
}

function assertLive(el: HTMLElement, page: HopDongTrangToiThieu, controlId: string, loai: LoaiThaoTac): void {
  if (!el.isConnected) {
    throw new LoiSafeControl('khong_thay', `Control "${controlId}" khÃ´ng cÃ²n trÃªn trang.`);
  }
  if (!hopLoai(el, loai)) {
    throw new LoiSafeControl('sai_loai', `Control "${controlId}" khÃ´ng nháº­n thao tÃ¡c "${loai}".`);
  }
  // Guard against a component being replaced between resolve and act.
  const actual = el.getAttribute(THUOC_TINH_AN_TOAN);
  if (actual !== `${page.key}.${controlId}` && actual !== controlId) {
    throw new LoiSafeControl('khong_ket_noi', `Control "${controlId}" Ä‘Ã£ thay Ä‘á»•i trong lÃºc thao tÃ¡c.`);
  }
}

function dispatch(el: HTMLElement, type: string): void {
  const fn = (el as unknown as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
  if (typeof fn === 'function' && typeof Event !== 'undefined') fn.call(el, new Event(type, { bubbles: true }));
}

import * as z from 'zod/v4';

/** Build default-deny semantic tools for one declared page contract. */
export function taoCongCuDieuKhienAnToan(
  page: HopDongTrangToiThieu,
  root: Document = document,
  options: SafeControlExecutionOptions = {},
): Record<'safe_click' | 'safe_input' | 'safe_select', SafeControlTool> {
  const resolve = (controlId: string, kind: LoaiThaoTac): HTMLElement => {
    const el = giaiSafeControl(page, controlId, kind, root);
    assertLive(el, page, controlId, kind);
    return el;
  };
  const inputSchema = z.object({ control_id: z.string().min(1), text: z.string() });
  const clickSchema = z.object({ control_id: z.string().min(1) });
  const make = (kind: LoaiThaoTac, description: string, input: z.ZodTypeAny): SafeControlTool => ({
    description,
    inputSchema: input,
    execute: async (args, ctx) => {
      ctx.signal.throwIfAborted();
      const el = resolve(args.control_id, kind);
      // The page may have changed while PageAgent was deciding which semantic
      // tool to call. Re-check synchronously after resolving and before mutation.
      options.beforeDispatch?.();
      ctx.signal.throwIfAborted();
      assertLive(el, page, args.control_id, kind);
      if (kind === 'input') {
        (el as HTMLInputElement | HTMLTextAreaElement).value = args.text ?? '';
        dispatch(el, 'input');
        dispatch(el, 'change');
      } else if (kind === 'select') {
        const option = args.text ?? '';
        if ('value' in el) (el as HTMLSelectElement).value = option;
        el.setAttribute('data-ai-selected', option);
        dispatch(el, 'change');
      } else {
        dispatch(el, 'click');
      }
      return `Đã thao tác an toàn ${kind} control ${args.control_id}.`;
    },
  });
  return {
    safe_click: make('click', 'Click only an explicitly declared safe control id.', clickSchema),
    safe_input: make('input', 'Type only into an explicitly declared safe control id.', inputSchema),
    safe_select: make('select', 'Select only an explicitly declared safe control id.', inputSchema),
  };
}

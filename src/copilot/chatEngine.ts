// Chat engine — nói thẳng OpenAI-compat với `llm-proxy` qua `llmClient`.
//
// Bản trước dùng `LLM` class của @page-agent/llms và một tool giả tên `respond`
// làm dấu "xong". Cái tool giả đó không phải lựa chọn thiết kế mà là hệ quả:
// `LLM.invoke` ép `tool_choice: 'required'`, nên mô hình BUỘC phải gọi một tool
// gì đó, kể cả khi nó chỉ muốn trả lời. Hệ quả kéo theo là câu trả lời cuối về
// dưới dạng tham số JSON của tool — thứ không stream ra chữ được (người dùng sẽ
// thấy `{"text":"Xin ch…`).
//
// Nay `tool_choice: 'auto'`: mô hình gọi tool khi cần dữ liệu, trả lời thẳng
// bằng `content` khi đã đủ. Không còn `respond`, và chữ chảy dần được.
import * as z from 'zod/v4';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { CHAT_SYSTEM_PROMPT, TU_DIEN_NGHIEP_VU, VI_DU_MAU } from './systemPromptVi';
import { goiModelMotLuot, type KhaiBaoTool, type TinNhan } from './llmClient';
import { dongNguCanhTrang } from './banDoHeThong';
import { dongGhiNho, type GhiNho } from './memoryClient';
import { buildRegistry, toLlmTools, type ToolCtx } from './tools/registry';
import {
  apDungKyTuongDoi,
  quetKyTrongCau,
  quetThamSoKy,
  soKyRiengBiet,
  taoRequestContext,
  type CopilotResolvedPeriod,
} from './temporalContext';

/** Kiểu tin nhắn dùng chung trong chat mode (tương thích OpenAI). */
export type Message = TinNhan;

export interface ChatToolEvent {
  tool: string;
  args: unknown;
  output: string;
}

export interface ChatTurnResult {
  text: string;
  toolEvents: ChatToolEvent[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Các message sinh ra trong lượt này (đã gồm user + assistant/tool + respond). */
  newMessages: Message[];
}

/**
 * Trần số vòng gọi tool cho MỘT câu hỏi.
 *
 * 6 → 10 (03/09/2026). Sáu vòng đủ cho câu hỏi một ý, nhưng một câu ba ý mà mô
 * hình hỏi tuần tự (tra hợp đồng → tra hoá đơn của hợp đồng đó → tra sổ quỹ) đã
 * chạm trần và rơi vào nhánh "đổ dữ liệu thô" — người dùng nhận một đống kết
 * quả tool thay vì câu trả lời.
 *
 * Nới vòng KHÔNG được nới chi phí vô hạn: `CAP_TONG_KET_QUA_TOOL` mới là trần
 * thật. Vòng đếm số lượt suy nghĩ, ngân sách ký tự đếm lượng dữ liệu — hai thứ
 * khác nhau, và trước đây chỉ có cái thứ nhất.
 */
const MAX_TOOL_ROUNDS = 10;

/**
 * Độ dài "tính theo ký tự" của một `content`.
 *
 * `content` có thể là chuỗi, hoặc mảng multimodal (chuẩn bị cho ảnh). Với mảng
 * thì `.length` là SỐ PHẦN TỬ — dùng nó làm ngân sách ký tự sẽ coi một ảnh
 * base64 nửa megabyte là "1 ký tự" và ngân sách ngữ cảnh mất tác dụng đúng lúc
 * cần nhất.
 */
export function doDaiNoiDung(content: Message['content']): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return JSON.stringify(content).length;
  return 0;
}

/** Trần ký tự cho MỘT dòng trong bản tóm tắt. */
export const CAP_DONG_TOM_TAT = 180;
/** Trần ký tự cho CẢ bản tóm tắt — nó là phần thêm vào ngân sách, không thay thế nó. */
export const CAP_TOM_TAT = 2_000;

const dongMot = (s: string): string => s.split('\n').find((d) => d.trim().length > 0) ?? '';

const catDong = (s: string): string =>
  s.length <= CAP_DONG_TOM_TAT ? s : `${s.slice(0, CAP_DONG_TOM_TAT)}…`;

/**
 * Rút các lượt cũ thành MỘT khối "Tóm tắt trước đó".
 *
 * VÌ SAO TÓM TẮT THAY VÌ CẮT BỎ
 *   Bản trước, block nào vượt ngân sách thì biến mất hẳn. Hội thoại dài vì thế
 *   mất trí nhớ đúng lúc nó cần nhất: người dùng hỏi "vậy còn toà kia thì sao"
 *   sau tám lượt, và mô hình không còn thấy "toà kia" là toà nào. Giữ một dòng
 *   cho mỗi lượt tốn vài trăm ký tự và giữ được mạch.
 *
 * HÀM THUẦN, KHÔNG GỌI MODEL. Tóm tắt bằng một lượt gọi model nữa thì mỗi câu
 * hỏi dài phải trả thêm một round-trip, kết quả không lặp lại được giữa hai lần
 * chạy, và một lỗi mạng ở đó làm hỏng lượt chat chính. Ở đây luật rút gọn là
 * luật cố định: giữ câu hỏi của người dùng, giữ tên công cụ đã chạy, giữ ĐÚNG
 * MỘT dòng đầu của mỗi kết quả.
 *
 * Vai `user` chứ không phải `system`: nhiều nhà cung cấp chỉ chấp nhận `system`
 * ở vị trí đầu tiên, và một message `system` chen giữa hội thoại là lỗi 400 ở
 * đúng những lượt dài nhất. Nhãn `[Tóm tắt…]` ở đầu nói rõ đây không phải lời
 * người dùng vừa nói.
 */
export function tomTatLichSu(cu: Message[]): Message | null {
  const dong: string[] = [];
  for (const m of cu) {
    if (m.role === 'user') {
      const t = dongMot(noiDungDeLuu(m.content) ?? '');
      if (t) dong.push(`- Người dùng hỏi: ${catDong(t)}`);
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      dong.push(`- Đã tra: ${m.tool_calls.map((tc) => tc.function.name).join(', ')}`);
    } else if (m.role === 'assistant') {
      const t = dongMot(noiDungDeLuu(m.content) ?? '');
      if (t) dong.push(`- Đã trả lời: ${catDong(t)}`);
    } else if (m.role === 'tool') {
      const t = dongMot(typeof m.content === 'string' ? m.content : '');
      if (t) dong.push(`  · ${catDong(t)}`);
    }
  }
  if (!dong.length) return null;

  // Vượt trần thì bỏ từ ĐẦU: lượt gần nhất là lượt còn liên quan tới câu đang hỏi.
  let than = dong.join('\n');
  while (than.length > CAP_TOM_TAT && dong.length > 1) {
    dong.shift();
    than = dong.join('\n');
  }
  return {
    role: 'user',
    content: `[Tóm tắt trước đó — các lượt cũ đã rút gọn, không phải lời người dùng vừa nói]\n${than}`,
  };
}

/**
 * Cắt history cho context: giữ NGUYÊN VẸN từng "block" (user-message hoặc
 * assistant-tool_calls + các tool-reply của nó) — không bao giờ tách cặp
 * tool_calls ↔ tool (v2.1 F7). System KHÔNG nằm trong history (truyền riêng).
 *
 * Phần bị đẩy khỏi ngân sách KHÔNG bị vứt: nó rút thành một khối tóm tắt đứng
 * trước (`tomTatLichSu`).
 */
export function buildChatContext(
  history: Message[],
  opts: { maxTurns?: number; maxChars?: number } = {},
): Message[] {
  const maxTurns = opts.maxTurns ?? 12;
  const maxChars = opts.maxChars ?? 16_000;

  // Gom block: 'user'/'assistant'(text) đứng riêng; 'assistant' có tool_calls
  // kéo theo các message 'tool' ngay sau nó.
  const blocks: Message[][] = [];
  for (const msg of history) {
    if (msg.role === 'tool' && blocks.length && blocks[blocks.length - 1].some((m) => m.tool_calls?.length)) {
      blocks[blocks.length - 1].push(msg);
    } else {
      blocks.push([msg]);
    }
  }

  const out: Message[][] = [];
  let chars = 0;
  let i = blocks.length - 1;
  for (; i >= 0 && out.length < maxTurns; i--) {
    const block = blocks[i];
    const blockChars = block.reduce((s, m) => s + doDaiNoiDung(m.content) + JSON.stringify(m.tool_calls ?? '').length, 0);
    if (chars + blockChars > maxChars && out.length > 0) break;
    out.unshift(block);
    chars += blockChars;
  }
  const giu = out.flat();
  if (i < 0) return giu; // không block nào rơi ra ⇒ không có gì để tóm tắt
  const tomTat = tomTatLichSu(blocks.slice(0, i + 1).flat());
  return tomTat ? [tomTat, ...giu] : giu;
}

/** Giới hạn ký tự cho MỘT kết quả tool nhét vào ngữ cảnh. */
const CAP_KET_QUA_TOOL = 12_000;

/**
 * Trần TỔNG ký tự kết quả tool trong MỘT lượt chat.
 *
 * Trần mỗi-kết-quả (12k) không chặn được tổng: mười vòng × ba tool × 12k là
 * 360k ký tự nhét dần vào ngữ cảnh — vượt cửa sổ của mô hình, và hoá đơn token
 * tăng theo bình phương vì mọi vòng sau đều gửi lại toàn bộ. Nới
 * `MAX_TOOL_ROUNDS` mà không có trần này là mở một đường tiêu tiền không đáy.
 *
 * Chạm trần thì KHÔNG cắt ngang: mô hình được một vòng cuối kèm lời nhắc trả
 * lời bằng dữ liệu đã có — im lặng dừng ở giữa là cách chắc chắn nhất để người
 * dùng nhận một câu trả lời cụt mà không biết vì sao.
 */
export const CAP_TONG_KET_QUA_TOOL = 40_000;

/** Dữ liệu thô đã gom, dùng khi mô hình không chốt được câu trả lời. */
function tomTatKetQua(evs: ChatToolEvent[]): string {
  return evs.map((ev) => `- ${ev.tool}: ${ev.output.slice(0, 4000)}`).join('\n');
}

/** Lời nhắc chốt lượt khi ngân sách dữ liệu đã cạn. */
export const NHAC_HET_NGAN_SACH =
  '[Hệ thống] Ngân sách dữ liệu công cụ của lượt này đã hết. Không gọi thêm công cụ nữa — trả lời NGAY bằng dữ liệu đã thu được, và nói rõ phần nào chưa tra được.';

/**
 * Nói cho mô hình biết HÔM NAY là ngày mấy.
 *
 * Không hiển nhiên như vẻ ngoài. Mô hình không có đồng hồ; nếu không được nói,
 * nó ĐOÁN — và đoán theo dữ liệu huấn luyện, tức lệch hàng tháng. Bắt gặp thật
 * ngày 12/08/2026 khi chạy thử: hỏi "tỉ lệ lấp đầy hiện tại", mô hình tự truyền
 * `ngay: 2026-03-27` vào tool rồi trình bày báo cáo dưới tiêu đề "tại
 * 27/03/2026". Mọi con số đều là số thật lấy từ DB — chỉ sai kỳ. Đó là kiểu sai
 * tệ nhất: không có gì đỏ, không có gì trông lạ, và người đọc không có cách nào
 * biết.
 *
 * Tool đã mặc định "bỏ trống = hôm nay", nhưng mặc định chỉ cứu được khi mô
 * hình BỎ TRỐNG. Nó chỉ bỏ trống khi không tưởng là mình biết.
 *
 * Ngày lấy theo GIỜ LOCAL, không qua `toISOString()` — repo đã dọn cả một lớp
 * lỗi lệch ngày do UTC (commit f819c2a8, 11547392).
 */
export function dongHomNay(now: Date = new Date()): string {
  const timezone = 'Asia/Ho_Chi_Minh';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const iso = `${year}-${month}-${day}`;
  const thu = new Intl.DateTimeFormat('vi-VN', { timeZone: timezone, weekday: 'long' }).format(now);
  return `CURRENT_DATETIME_CONTEXT: timezone=${timezone}; date=${iso}; current_month=${year}-${month}. HÔM NAY là ${thu}, ngày ${day}/${month}/${year} (${iso}); kỳ hiện tại là ${year}-${month}. TUYỆT ĐỐI không tự đoán ngày: cần "hôm nay" thì BỎ TRỐNG tham số ngày để hệ thống tự điền.`;
}

/**
 * Dòng liệt kê ĐÍCH DANH các công cụ phiên này đang có.
 *
 * Danh sách tool đã đi kèm request qua tham số `tools`, nhưng ca C25 (13/08/2026)
 * cho thấy như thế chưa đủ: mô hình TỪ CHỐI SAI, nói "không có công cụ" cho
 * `ty_le_lap_day` trong khi tool đó nằm ngay trong request. Nhắc lại tên tool
 * bằng lời, ngay trong system prompt, là chỗ nó chắc chắn đọc.
 *
 * Sinh từ `toolMap` ĐÃ LỌC QUYỀN, không phải danh sách viết tay: một danh sách
 * viết tay sẽ hoặc kể tên tool người dùng không có quyền dùng (mô hình gọi rồi
 * ăn lỗi), hoặc bỏ sót tool mới thêm — đúng kiểu lệch đã xảy ra với README.
 */
export function dongNangLuc(tenTool: string[]): string | null {
  if (!tenTool.length) return null;
  return (
    `CÔNG CỤ BẠN ĐANG CÓ (${tenTool.length}): ${[...tenTool].sort().join(', ')}. ` +
    'Chỉ nói "không có công cụ" khi tên cần dùng KHÔNG nằm trong danh sách này. ' +
    'Một công cụ chạy lỗi KHÔNG có nghĩa là các ý khác của câu hỏi bị huỷ: ' +
    'hãy chạy nốt những ý còn lại rồi báo rõ ý nào xong, ý nào lỗi.'
  );
}

/**
 * Đổi registry tool (schema zod) sang khai báo hàm kiểu OpenAI.
 *
 * `io: 'input'` là chi tiết quan trọng: nó khiến trường có `.default()` KHÔNG bị
 * xếp vào `required`. Lấy schema đầu ra sẽ bắt mô hình luôn phải truyền
 * `xac_nhan`, tức phá đúng cái mặc-định-an-toàn `xac_nhan = false` của write tool.
 */
export function toolSangKhaiBao(
  tools: Record<string, { description: string; inputSchema: z.ZodType<unknown> }>,
): KhaiBaoTool[] {
  return Object.entries(tools).map(([name, t]) => {
    const schema = z.toJSONSchema(t.inputSchema, { io: 'input' }) as Record<string, unknown>;
    delete schema.$schema; // khoá meta, không nhà cung cấp nào cần
    return { type: 'function' as const, function: { name, description: t.description, parameters: schema } };
  });
}

/**
 * Dòng "kỳ đã chốt" trong system prompt.
 *
 * Hai câu KHÁC HẲN nhau tuỳ số kỳ trong câu hỏi. Một kỳ ⇒ hệ thống đã chốt, mô
 * hình đừng hỏi lại. NHIỀU kỳ ⇒ hệ thống cố ý KHÔNG chốt, và phải NÓI RA điều
 * đó: câu "hệ thống đã chốt kỳ 2026-06" đặt trước một câu hỏi so sánh tháng 6
 * với tháng 7 chính là thứ dạy mô hình gọi hai lần với cùng một kỳ.
 */
export function dongKy(
  ds: readonly NonNullable<CopilotResolvedPeriod>[],
  nhieuKy: boolean,
): string | null {
  const dau = ds[0];
  if (!dau) return null;
  if (!nhieuKy) {
    return `Câu hỏi này nói tới kỳ ${dau.nhan} (${dau.startDate} → ${dau.endDate}). Hệ thống đã chốt kỳ đó; đừng hỏi lại người dùng là kỳ nào, và nhắc lại kỳ trong câu trả lời.`;
  }
  const ke = [...new Set(ds.map((k) => `${k.nhan} (${k.startDate} → ${k.endDate})`))].join('; ');
  return (
    `Câu hỏi này nhắc NHIỀU kỳ: ${ke}. Hệ thống KHÔNG chốt kỳ nào — bạn phải tự điền tham số kỳ ` +
    'cho TỪNG lần gọi công cụ, mỗi kỳ một lần gọi, rồi trả lời đủ mọi kỳ được hỏi.'
  );
}

/**
 * Chạy MỘT lượt chat: user hỏi → (tool*) → mô hình trả lời bằng văn bản.
 *
 * Tool trong cùng một vòng chạy SONG SONG. Mô hình thường xin nhiều thứ một lúc
 * ("doanh thu toà X" + "phòng trống toà X"); chạy tuần tự thì độ trễ cộng dồn vô
 * ích vì chúng không phụ thuộc nhau.
 */
export async function runChatTurn(params: {
  providerModel: string; // "provider:model-id"
  history: Message[];    // các lượt trước (không gồm system)
  userText: string;
  ctx: ToolCtx;
  signal: AbortSignal;
  onToolEvent?: (ev: ChatToolEvent) => void;
  /** Từng mảnh chữ mô hình trả — để UI hiện dần thay vì đợi xong. */
  onDeltaChu?: (chu: string) => void;
  /** Đường dẫn trang người dùng đang xem, để hiểu "cái này", "ở đây". */
  pathname?: string;
  /**
   * `location.search` của trang đó — bộ lọc ĐANG ÁP trên màn hình.
   *
   * Không có nó thì mô hình thấy `/invoices` và tra cả tổ chức, trả về một con
   * số to hơn con số người dùng đang nhìn. Chỉ các khoá trong allowlist của
   * `banDoHeThong` được kể lại.
   */
  search?: string;
  /**
   * Ảnh kèm theo lượt này, dạng data URL.
   *
   * Chỉ đi vào request; KHÔNG được lưu — `noiDungDeLuu` thay chúng bằng
   * placeholder khi ghi lịch sử.
   */
  anh?: string[];
  /**
   * Ghi nhớ dài hạn của người dùng trong công ty đang chọn.
   *
   * TRUYỀN VÀO chứ không tự đọc: `runChatTurn` là hàm tất định kiểm được bằng
   * test, và thêm một lời gọi mạng vào đây sẽ biến mọi test của nó thành test có
   * mạng. Chỗ đọc là `ChatPanel` (một lần mỗi công ty), qua `memoryClient`.
   */
  ghiNho?: readonly GhiNho[];
}): Promise<ChatTurnResult> {
  const registry = buildRegistry(params.ctx.availability);
  const toolMap = toLlmTools(registry, params.ctx);
  const khaiBao = toolSangKhaiBao(toolMap);

  // Ngữ cảnh trang đi vào system prompt chứ không thành tool: nó là MỘT DÒNG và
  // luôn đúng, bắt mô hình gọi tool để biết mình đang ở đâu là thêm một vòng
  // mạng cho một sự thật đã nằm sẵn trong tay.
  const nguCanh = params.pathname
    ? dongNguCanhTrang(params.pathname, params.ctx.perms, {
        search: params.search,
        // Chỉ tool phiên này THẬT SỰ gọi được: `registry` mới lọc rollout, còn
        // `toolMap` đã lọc cả quyền. Gợi ý một công cụ người dùng không có
        // quyền là mời mô hình gọi rồi ăn lỗi trước mặt họ.
        tools: registry.filter((t) => t.name in toolMap),
      })
    : null;

  // Kỳ tương đối chuẩn hoá BẰNG MÃ trước khi mô hình chạm vào tham số ngày.
  // Prompt đã mang ngày hôm nay từ lâu, vậy mà ca C28 (13/08/2026) mô hình vẫn
  // nói không biết ngày và hỏi lại kỳ — một câu văn là gợi ý, không phải hợp đồng.
  const ctxThoiGian = taoRequestContext();
  // Quét TOÀN câu chứ không lấy kỳ đầu tiên rồi thôi: câu so sánh ("doanh thu
  // tháng 6 và tháng 7") có HAI kỳ, và ép cả lượt về kỳ đầu cho ra một bảng so
  // sánh mà hai cột bằng nhau — sai, mà trông y hệt dữ liệu thật.
  const dsKy = quetKyTrongCau(params.userText, ctxThoiGian);
  const kyTuongDoi = dsKy[0] ?? null;
  const nhieuKy = soKyRiengBiet(dsKy) > 1;
  // Tool nào nhận kỳ được QUÉT từ khai báo thật, không phải chép tay: bảng chép
  // tay cũ dừng ở 2 tool trong khi registry đã có 37.
  const banDoThamSoKy = quetThamSoKy(
    khaiBao.map((k) => ({ name: k.function.name, parameters: k.function.parameters })),
  );

  const heThong = [
    CHAT_SYSTEM_PROMPT,
    TU_DIEN_NGHIEP_VU,
    VI_DU_MAU,
    dongNangLuc(Object.keys(toolMap)),
    dongHomNay(),
    dongKy(dsKy, nhieuKy),
    // Ghi nhớ là DỮ LIỆU, không phải mệnh lệnh — câu ranh giới nằm ngay trong
    // khối, xem `dongGhiNho`. Đặt SAU luật và trước ngữ cảnh trang: nó là thứ
    // mô tả người dùng, không phải thứ định nghĩa hành vi của trợ lý.
    dongGhiNho(params.ghiNho ?? []),
    nguCanh,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Có ảnh ⇒ `content` là mảng multimodal; không có ⇒ chuỗi như cũ. Giữ dạng
  // chuỗi khi không có ảnh là cố ý: mọi nhà cung cấp đều nhận, và lịch sử cũ
  // trong DB cũng là chuỗi.
  const noiDungUser: Message['content'] = params.anh?.length
    ? [
        { type: 'text' as const, text: params.userText },
        ...params.anh.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ]
    : params.userText;

  const messages: Message[] = [
    { role: 'system', content: heThong },
    ...buildChatContext(params.history),
    { role: 'user', content: noiDungUser },
  ];
  const newMessages: Message[] = [{ role: 'user', content: noiDungUser }];

  const toolEvents: ChatToolEvent[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let tongKyTuTool = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const kq = await goiModelMotLuot({
      providerModel: params.providerModel,
      messages,
      tools: khaiBao,
      signal: params.signal,
      onDeltaChu: params.onDeltaChu,
      // Công ty đang chọn đi cùng lượt gọi: hạn mức phải ghi vào ĐÚNG công ty
      // người dùng đang làm việc cho, không phải công ty trigger đoán ra.
      organizationId: params.ctx.organizationId,
    });
    usage.promptTokens += kq.usage.promptTokens;
    usage.completionTokens += kq.usage.completionTokens;
    usage.totalTokens += kq.usage.totalTokens;

    // Không xin tool nữa ⇒ đây là câu trả lời.
    if (kq.toolCalls.length === 0) {
      const text = kq.content.trim();
      const cuoi: Message = { role: 'assistant', content: text };
      newMessages.push(cuoi);
      return { text, toolEvents, usage, newMessages };
    }

    // Mô hình có thể vừa nói một câu dẫn ("để tôi tra…") vừa gọi tool. Giữ câu
    // đó trong message: nó đã hiện trên màn hình rồi, bỏ đi thì lịch sử tải lại
    // sẽ khác những gì người dùng đã đọc.
    const assistantMsg: Message = {
      role: 'assistant',
      content: kq.content || null,
      tool_calls: kq.toolCalls,
    };
    messages.push(assistantMsg);
    newMessages.push(assistantMsg);

    // SONG SONG. Mỗi tool tự nuốt lỗi của mình thành text: một tool hỏng không
    // được làm hỏng cả lượt, và mô hình cần ĐỌC được lỗi để đổi cách hỏi.
    const ketQua = await Promise.all(
      kq.toolCalls.map(async (tc): Promise<Message> => {
        const ten = tc.function.name;
        let args: unknown = {};
        let output: string;
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          output = `Lỗi: tham số không phải JSON hợp lệ (${tc.function.arguments.slice(0, 200)}).`;
          const evLoi = { tool: ten, args, output };
          toolEvents.push(evLoi);
          params.onToolEvent?.(evLoi);
          return { role: 'tool', tool_call_id: tc.id, content: output };
        }
        const tool = toolMap[ten];
        if (!tool) {
          output = `Lỗi: không có công cụ tên "${ten}" (hoặc bạn không có quyền dùng).`;
        } else {
          try {
            // Kỳ do MÃ chốt thắng kỳ do mô hình đoán. Báo lại khi ghi đè —
            // sửa im lặng là cách nhanh nhất để không ai biết chỗ này hỏng.
            const { args: argsKy, kyBiThayThe, ghiChu } = apDungKyTuongDoi(
              ten,
              args as Record<string, unknown>,
              kyTuongDoi,
              banDoThamSoKy,
              nhieuKy,
            );
            const parsedArgs = tool.inputSchema.parse(argsKy);
            output = String(await tool.execute(parsedArgs));
            if (kyBiThayThe) {
              output = `(Kỳ đã chuẩn hoá về ${kyTuongDoi!.nhan} theo câu hỏi, thay cho ${kyBiThayThe}.)\n${output}`;
            } else if (ghiChu) {
              output = `(${ghiChu})\n${output}`;
            }
          } catch (e) {
            output = `Lỗi khi chạy "${ten}": ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        const ev = { tool: ten, args, output };
        toolEvents.push(ev);
        params.onToolEvent?.(ev);
        return { role: 'tool', tool_call_id: tc.id, content: output.slice(0, CAP_KET_QUA_TOOL) };
      }),
    );

    // Mọi tool_call phải có ĐÚNG một message `tool` khớp `tool_call_id`, nếu
    // không nhà cung cấp từ chối cả lượt sau.
    messages.push(...ketQua);
    newMessages.push(...ketQua);

    tongKyTuTool += ketQua.reduce((s, m) => s + doDaiNoiDung(m.content), 0);
    if (tongKyTuTool >= CAP_TONG_KET_QUA_TOOL) {
      // Chỉ vào `messages` (thứ gửi cho mô hình), KHÔNG vào `newMessages`: đây
      // là lời nhắc kỹ thuật của lượt này, không phải một câu người dùng nói —
      // lưu nó vào lịch sử thì lần sau tải lại hội thoại sẽ thấy một tin nhắn
      // ma trong khung chat.
      messages.push({ role: 'user', content: NHAC_HET_NGAN_SACH });
      const chot = await goiModelMotLuot({
        providerModel: params.providerModel,
        messages,
        tools: khaiBao,
        signal: params.signal,
        onDeltaChu: params.onDeltaChu,
        organizationId: params.ctx.organizationId,
      });
      usage.promptTokens += chot.usage.promptTokens;
      usage.completionTokens += chot.usage.completionTokens;
      usage.totalTokens += chot.usage.totalTokens;
      const text = chot.content.trim() || `Kết quả tra cứu:\n${tomTatKetQua(toolEvents)}`;
      newMessages.push({ role: 'assistant', content: text });
      return { text, toolEvents, usage, newMessages };
    }
  }

  // Hết vòng mà mô hình vẫn chưa chốt → trả thẳng dữ liệu đã gom, đừng im lặng.
  const fallback =
    toolEvents.length > 0
      ? `Kết quả tra cứu:\n${tomTatKetQua(toolEvents)}`
      : 'Xin lỗi, tôi chưa trả lời được câu hỏi này (quá số vòng công cụ cho phép).';
  newMessages.push({ role: 'assistant', content: fallback });
  return { text: fallback, toolEvents, usage, newMessages };
}

// ── Persistence (ai_chat_threads/messages — RLS own; seq = identity DB) ──────

export interface ThreadRow { id: string; title: string | null; updated_at: string }

/** Guard state commits from async work started under a previous org selection. */
export function isCurrentChatScope(
  generation: number,
  currentGeneration: number,
  organizationId: string | null,
  currentOrganizationId: string | null,
): boolean {
  return generation === currentGeneration && organizationId === currentOrganizationId;
}

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');
  return userId;
}

export async function loadLatestThread(organizationId: string | null): Promise<ThreadRow | null> {
  if (!organizationId) return null;
  const userId = await currentUserId();
  let query = supabase
    .from('ai_chat_threads')
    .select('id, title, updated_at')
    .eq('user_id', userId);
  query = organizationId ? query.eq('organization_id', organizationId) : query.is('organization_id', null);
  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadOwnedThread(threadId: string, organizationId: string | null) {
  if (!organizationId) return null;
  const userId = await currentUserId();
  let query = supabase
    .from('ai_chat_threads')
    .select('id, user_id, organization_id')
    .eq('id', threadId)
    .eq('user_id', userId);
  query = organizationId ? query.eq('organization_id', organizationId) : query.is('organization_id', null);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * `organizationId` là TUỲ CHỌN vì database đã tự suy được cho người thuộc đúng
 * một tổ chức (trigger app_private.autofill_org_chat, 20260809040000). Nó chỉ
 * BẮT BUỘC với người thuộc NHIỀU tổ chức — lúc đó chỉ client mới biết đang chat
 * trong ngữ cảnh nào, và trigger sẽ từ chối ghi thay vì đoán bừa.
 *
 * Truyền lên đây KHÔNG phải hàng rào: trigger mới là hàng rào, và nó kiểm lại
 * rằng người dùng thật sự có membership ACTIVE ở tổ chức được khai.
 */
export async function createThread(title: string, organizationId: string | null): Promise<ThreadRow> {
  if (!organizationId) throw new Error('Phải chọn tổ chức trước khi lưu chat');
  const userId = await currentUserId();
  if (!userId) throw new Error('Chưa đăng nhập');
  const { data, error } = await supabase
    .from('ai_chat_threads')
    .insert({
      user_id: userId,
      title: title.slice(0, 120),
      ...(organizationId ? { organization_id: organizationId } : {}),
    })
    .select('id, title, updated_at')
    .single();
  if (error) throw error;
  return data;
}

/**
 * Ép `content` về chuỗi để lưu — cột `ai_chat_messages.content` là text.
 *
 * Với tin nhắn multimodal, phần ảnh KHÔNG được lưu: một data URL ảnh là hàng
 * trăm KB base64, và lưu nó biến bảng lịch sử chat thành kho ảnh có kèm bài
 * toán retention/PII mà chưa ai thiết kế. Giữ lại phần chữ, đánh dấu chỗ có ảnh
 * để đọc lại lịch sử vẫn hiểu được mạch hội thoại.
 */
export function noiDungDeLuu(content: Message['content']): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const phan = content.map((p) => (p.type === 'text' ? p.text : '[ảnh]'));
  return phan.join('\n') || null;
}

export async function saveMessages(
  threadId: string,
  msgs: Message[],
  model: string,
  organizationId?: string | null,
): Promise<void> {
  const parent = await loadOwnedThread(threadId, organizationId ?? null);
  if (!parent) throw new Error('Thread không thuộc người dùng hoặc tổ chức đang chọn');
  const userId = parent.user_id;
  if (!userId) throw new Error('Chưa đăng nhập');
  const rows = msgs.map((m) => ({
    thread_id: threadId,
    user_id: userId,
    role: m.role,
    content: noiDungDeLuu(m.content),
    tool_calls: m.tool_calls ? JSON.parse(JSON.stringify(m.tool_calls)) as Json : null,
    tool_call_id: m.tool_call_id ?? null,
    model,
    // Tin nhắn vốn kế thừa tổ chức của LUỒNG cha nên thường không cần; gửi kèm
    // để đường ghi không phụ thuộc vào việc luồng đã có nhãn hay chưa.
    ...(organizationId ? { organization_id: organizationId } : {}),
  }));
  const { error } = await supabase.from('ai_chat_messages').insert(rows);
  if (error) throw error;
}

/** Dựng lại Message[] từ rows DB (order theo seq — identity toàn cục). */
export function rowsToMessages(
  rows: { role: string; content: string | null; tool_calls: unknown; tool_call_id: string | null }[],
): Message[] {
  return rows.map((r) => ({
    role: r.role as Message['role'],
    content: r.content,
    ...(r.tool_calls ? { tool_calls: r.tool_calls as Message['tool_calls'] } : {}),
    ...(r.tool_call_id ? { tool_call_id: r.tool_call_id } : {}),
  }));
}

export async function loadThreadMessages(threadId: string, organizationId: string | null): Promise<Message[]> {
  const parent = await loadOwnedThread(threadId, organizationId);
  if (!parent) return [];
  let messagesQuery = supabase
    .from('ai_chat_messages')
    .select('role, content, tool_calls, tool_call_id')
    .eq('thread_id', threadId)
    .eq('user_id', parent.user_id);
  messagesQuery = organizationId
    ? messagesQuery.eq('organization_id', organizationId)
    : messagesQuery.is('organization_id', null);
  const { data, error } = await messagesQuery
    .order('seq', { ascending: true })
    .limit(200);
  if (error) throw error;
  return rowsToMessages((data ?? []) as { role: string; content: string | null; tool_calls: unknown; tool_call_id: string | null }[]);
}

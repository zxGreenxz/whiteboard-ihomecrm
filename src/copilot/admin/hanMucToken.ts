// Số học của thanh hạn mức token — TÁCH khỏi React để đo được mọi nhánh.
//
// VÌ SAO TÁCH
//   Phần dễ sai của một thanh tiến độ không phải chỗ vẽ, mà chỗ chia: cap = 0
//   (hạn mức TẮT, theo đúng quy ước của `reserve_ai_usage`) mà đem chia là ra
//   Infinity, và một thanh 100% màu đỏ sẽ nói với quản trị rằng hệ thống sắp
//   chết trong khi thật ra họ vừa TẮT hạn mức. Nhánh đó phải test được mà không
//   cần dựng DOM.
//
// NGUỒN SỰ THẬT LÀ DATABASE, KHÔNG PHẢI FILE NÀY
//   `reserve_ai_usage` mới là nơi chặn. Những hàm ở đây chỉ để HIỂN THỊ; lệch
//   nhau thì tin database. Quy ước duy nhất phải khớp tuyệt đối: `cap <= 0`
//   nghĩa là TẮT, không phải "cấm tuyệt đối".

/** Ngưỡng đổi màu / hiện badge cảnh báo (%). */
export const MUC_CANH_BAO_PHAN_TRAM = 80;

/**
 * Đơn giá QUY ƯỚC cho model self-hosted (USD trên MỖI token).
 *
 * CHỈ ĐỂ SO SÁNH, KHÔNG PHẢI HOÁ ĐƠN. 9Router chạy trên VPS của chính công ty
 * nên `input_price`/`output_price` trong `ai_providers` bị ép về 0
 * (`20260829080000`) — đúng về kế toán, nhưng nó làm mọi cột chi phí hiện $0 và
 * không ai so được model nào ngốn hơn model nào. Con số này gán một cái giá
 * tượng trưng để XẾP HẠNG mức tiêu thụ, không để xuất ra bất cứ chứng từ nào.
 */
export const GIA_QUY_UOC_SELF_HOSTED_USD_PER_TOKEN = 0.000002;

const laSoHuuHan = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Phần trăm hạn mức đã dùng, hoặc `null` khi KHÔNG có hạn mức để so.
 *
 * `null` (chứ không phải 0) khi `cap <= 0`: 0% nói "còn nguyên hạn mức", trong
 * khi sự thật là "không có hạn mức nào" — hai câu khác nhau, và người đọc màn
 * hình quản trị cần phân biệt được.
 *
 * KHÔNG chặn trên 100: chạm trần rồi vẫn còn dòng `pending` chạy nốt, nên 118%
 * là con số có thật và giấu nó đi là giấu đúng lúc cần nhìn. Chỗ vẽ tự kẹp bề
 * rộng thanh, đó là việc của CSS.
 */
export function tinhPhanTramHanMuc(daDung: unknown, cap: unknown): number | null {
  if (!laSoHuuHan(cap) || cap <= 0) return null;
  if (!laSoHuuHan(daDung)) return null;
  const dung = Math.max(daDung, 0);
  return Math.round((dung / cap) * 1000) / 10;
}

/** Đã tới ngưỡng cảnh báo chưa. `null` (hạn mức tắt) KHÔNG phải cảnh báo. */
export function daChamNguongCanhBao(phanTram: number | null): boolean {
  return phanTram !== null && phanTram >= MUC_CANH_BAO_PHAN_TRAM;
}

/**
 * Chi phí quy ước của một khối token self-hosted (USD). `null` khi số token
 * không đọc được — thà để trống còn hơn hiện $0.00000 như một sự thật.
 */
export function chiPhiQuyUocSelfHosted(tokens: unknown): number | null {
  if (!laSoHuuHan(tokens) || tokens < 0) return null;
  return tokens * GIA_QUY_UOC_SELF_HOSTED_USD_PER_TOKEN;
}

// ── Biên ngày và tổng hợp — cùng một "hôm nay" với reserve_ai_usage ──────────

/**
 * Việt Nam là UTC+7 CỐ ĐỊNH (không có giờ mùa hè, không đổi từ 1975), nên hằng
 * số ở đây an toàn ở chỗ mà hằng số offset thường không an toàn.
 */
const LECH_VN_MS = 7 * 60 * 60 * 1000;

/**
 * Mốc ISO của 00:00 giờ VN cho ngày chứa `bayGio`.
 *
 * PHẢI khớp `(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = v_day` trong
 * `reserve_ai_usage`. Dùng nửa đêm theo giờ MÁY người dùng thì một quản trị ngồi
 * ở múi khác đọc một "hôm nay" khác với cái database đang chặn — thanh hiện 40%
 * trong khi cửa đã đóng.
 */
export function mocDauNgayVN(bayGio: Date): string {
  const theoVN = new Date(bayGio.getTime() + LECH_VN_MS);
  const nuaDemVN = Date.UTC(theoVN.getUTCFullYear(), theoVN.getUTCMonth(), theoVN.getUTCDate());
  return new Date(nuaDemVN - LECH_VN_MS).toISOString();
}

export interface DongTokenHomNay {
  user_id: string;
  owner_id: string | null;
  total_tokens: number | null;
}

export interface TomTatToken {
  /** Token của chính người đang xem — luôn ĐÚNG (RLS luôn cho thấy dòng của mình). */
  cuaToi: number;
  /**
   * Token của cả tenant. CHỈ ĐÚNG khi người xem là chủ tenant đó hoặc super
   * admin: RLS cho `user_id = tôi OR owner_id = tôi`, nên một nhân viên không
   * nhìn thấy dòng của đồng nghiệp và con số này sẽ THẤP hơn sự thật.
   */
  cuaTenant: number;
  /** Chủ tenant đã suy được; `null` khi không có đường nào suy ra (xem hàm dưới). */
  ownerId: string | null;
  /** `true` khi `cuaTenant` chắc chắn đầy đủ (người xem chính là chủ tenant / super admin). */
  tenantDayDu: boolean;
  /**
   * `true` khi `cuaTenant` thật ra là tổng TOÀN HỆ THỐNG, không phải một tenant:
   * super admin mà không suy được chủ nào thì mọi dòng RLS trả về đều được cộng.
   * Chỗ vẽ PHẢI đổi nhãn theo cờ này — gọi tổng toàn hệ thống là "tenant của
   * bạn" là nói sai với đúng người có quyền tin nó nhất.
   */
  laToanHeThong: boolean;
}

/**
 * Cộng token hôm nay theo hai trục mà `reserve_ai_usage` đang chặn: `user_id` và
 * `owner_id`. Hàm THUẦN — nhận đúng những dòng RLS đã trả về, không tự đi hỏi.
 */
export function tomTatTokenHomNay(
  rows: readonly DongTokenHomNay[],
  uid: string | null,
  laSuperAdmin = false,
): TomTatToken {
  if (!uid) {
    return { cuaToi: 0, cuaTenant: 0, ownerId: null, tenantDayDu: false, laToanHeThong: false };
  }

  // Suy chủ tenant theo HAI đường, chắc chắn giảm dần:
  //   (1) `owner_id` trên chính dòng của mình — giá trị database đã ghi.
  //   (2) có dòng nào `owner_id = mình` ⇒ mình LÀ chủ tenant đó. `ai_usage_logs_select`
  //       chỉ trả dòng `owner_id = auth.uid()` cho đúng người đó, nên đây là suy
  //       luận từ chính quyền đọc, không phải phỏng đoán.
  //
  // Đường (2) là chỗ bản đầu sai: chủ tenant CHƯA chat hôm nay thì không có dòng
  // nào `user_id = mình`, ownerId rơi về null, tổng ra 0 — thanh xanh 0% và badge
  // không bao giờ đỏ, trong khi RLS vừa trả về đủ dòng của cả đội đang cháy hạn
  // mức. Đúng người cần cảnh báo nhất là người không nhận được nó.
  const ownerId =
    rows.find((r) => r.user_id === uid)?.owner_id ??
    (rows.some((r) => r.owner_id === uid) ? uid : null);

  // Super admin không suy được chủ nào (chưa dòng nào trong tầm nhìn gắn với họ)
  // thì cộng TẤT CẢ dòng RLS trả về — với super admin đó là toàn hệ thống. Một
  // số 0 giả trình bày như sự thật tệ hơn hẳn một con số rộng hơn cần thiết
  // NHƯNG có nhãn nói đúng phạm vi (`laToanHeThong`).
  const laToanHeThong = ownerId === null && laSuperAdmin;

  let cuaToi = 0;
  let cuaTenant = 0;
  for (const r of rows) {
    const t = laSoHuuHan(r.total_tokens) && r.total_tokens > 0 ? r.total_tokens : 0;
    if (r.user_id === uid) cuaToi += t;
    if (laToanHeThong || (ownerId !== null && r.owner_id === ownerId)) cuaTenant += t;
  }
  return {
    cuaToi,
    cuaTenant,
    ownerId,
    tenantDayDu: laSuperAdmin || ownerId === uid,
    laToanHeThong,
  };
}

/**
 * Tập khoá `provider:model_id` của các model khai `pricing_mode = 'self_hosted'`.
 * Đọc từ `ai_providers` chứ KHÔNG đoán theo tên provider: hôm nay chỉ 9Router là
 * self-hosted, nhưng đó là dữ liệu, không phải luật.
 */
export function tapModelSelfHosted(
  providers: readonly { provider: string; models: unknown }[],
): Set<string> {
  const tap = new Set<string>();
  for (const p of providers) {
    if (!Array.isArray(p.models)) continue;
    for (const m of p.models) {
      if (!m || typeof m !== 'object') continue;
      const model = m as { id?: unknown; pricing_mode?: unknown };
      if (model.pricing_mode === 'self_hosted' && typeof model.id === 'string') {
        tap.add(`${p.provider}:${model.id}`);
      }
    }
  }
  return tap;
}

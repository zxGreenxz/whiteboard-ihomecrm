// Bản đồ hệ thống cho Copilot: app có những trang nào, làm được gì ở đó, cần
// quyền gì, và người dùng đang đứng ở đâu.
//
// Vì sao cần: Copilot biết vài công cụ tra số, nhưng KHÔNG biết sản phẩm có gì.
// Hỏi "tôi tạo hợp đồng ở đâu", "ai được duyệt phiếu chi" thì trước đây không
// có đường trả lời — nó chỉ đoán, hoặc nói không biết.
//
// Nguồn: `VISIBLE_PAGE_GROUPS` trong `src/lib/permissionPages.ts` — 42 trang,
// 124 chức năng, đã sẵn nhãn và mô tả tiếng Việt, route, cặp `module.action`.
// KHÔNG sinh artifact, KHÔNG viết generator: catalog đó đã nằm trong bundle
// (`registry.ts` vốn đã import từ chính file này để lấy `canUse`). Đọc thẳng
// lúc chạy thì bản đồ không thể cũ hơn mã đang chạy.
//
// Dùng `VISIBLE_` chứ không phải `PAGE_GROUPS` thô: bản thô còn trang của sản
// phẩm CHƯA SHIP, giữ lại vì quyền tương ứng có thật trên máy chủ. Chú thích
// tại chỗ khai báo nói rõ mọi bề mặt HIỂN THỊ phải dùng bản đã lọc — và Copilot
// đúng là một bề mặt như vậy. Chỉ người dùng tới một trang không render là đúng
// cái hỏng mà cờ đó tồn tại để tránh.
import {
  VISIBLE_PAGE_GROUPS,
  canUse,
  type PageFeature,
  type PermissionPage,
} from '@/lib/permissionPages';
import type { PermissionsMap } from '@/lib/permissions';
import { boDau } from './docs/tokenize';

export interface TrangKhopBanDo {
  page: PermissionPage;
  nhomLabel: string;
  /** Chức năng trên trang mà PHIÊN NÀY dùng được. */
  chucNang: PageFeature[];
  diem: number;
}

/** Trang chỉ hiện ra khi phiên xem được ÍT NHẤT một chức năng của nó. */
function chucNangDungDuoc(page: PermissionPage, perms: PermissionsMap | undefined): PageFeature[] {
  if (!perms) return []; // fail closed, đồng bộ với assertPerm và listDocTopics
  return page.features.filter((f) => canUse(perms, f.module, f.action));
}

/**
 * Chấm điểm khớp giữa câu hỏi và một trang.
 *
 * Cố ý KHÔNG dùng BM25 như bên tài liệu: ở đây "corpus" là 42 mục ngắn, độ dài
 * gần như bằng nhau, nên phần chuẩn hoá độ dài của BM25 không mua được gì mà
 * lại kéo theo một index phải dựng. Dùng chung BỘ TÁCH TỪ (bỏ dấu, gấp thường)
 * để hành vi không dấu nhất quán giữa hai bề mặt, còn cách chấm thì khác nhau
 * một cách có chủ đích.
 */
function chamDiemTrang(page: PermissionPage, chucNang: PageFeature[], tuKhoa: string[]): number {
  if (!tuKhoa.length) return 0;
  const nhan = boDau(page.label);
  const mota = boDau([page.desc ?? '', page.route].join(' '));
  const cn = boDau(chucNang.map((f) => `${f.label} ${f.desc ?? ''}`).join(' '));
  let diem = 0;
  for (const t of tuKhoa) {
    if (nhan.includes(t)) diem += 5; // tên trang khớp là tín hiệu mạnh nhất
    else if (cn.includes(t)) diem += 2; // tên chức năng
    else if (mota.includes(t)) diem += 1; // mô tả/route
  }
  return diem;
}

/**
 * Tìm trang liên quan tới câu hỏi, ĐÃ lọc theo quyền phiên.
 *
 * Trang mà người dùng không có chức năng nào không bao giờ xuất hiện — không
 * bao giờ chỉ ai đó tới một cánh cửa họ không mở được.
 */
export function timTrang(cauHoi: string, perms: PermissionsMap | undefined): TrangKhopBanDo[] {
  const tuKhoa = boDau(cauHoi)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);

  const ra: TrangKhopBanDo[] = [];
  for (const nhom of VISIBLE_PAGE_GROUPS) {
    for (const page of nhom.pages) {
      const chucNang = chucNangDungDuoc(page, perms);
      if (!chucNang.length) continue;
      const diem = chamDiemTrang(page, chucNang, tuKhoa);
      if (diem > 0) ra.push({ page, nhomLabel: nhom.label, chucNang, diem });
    }
  }
  return ra.sort((a, b) => b.diem - a.diem);
}

/** Toàn bộ bản đồ đã lọc quyền, dạng gọn để mô hình nắm tổng thể. */
export function banDoGon(perms: PermissionsMap | undefined): string {
  const dong: string[] = [];
  for (const nhom of VISIBLE_PAGE_GROUPS) {
    const trang = nhom.pages
      .map((p) => ({ p, cn: chucNangDungDuoc(p, perms) }))
      .filter((x) => x.cn.length);
    if (!trang.length) continue;
    dong.push(`## ${nhom.label}`);
    for (const { p, cn } of trang) {
      dong.push(`- ${p.label} (${p.route}) — ${cn.length} chức năng`);
    }
  }
  if (!dong.length) {
    return perms === undefined
      ? 'Đang tải quyền truy cập, chưa dựng được bản đồ. Thử lại sau vài giây.'
      : 'Bạn chưa được cấp quyền dùng chức năng nào.';
  }
  return dong.join('\n');
}

const TEN_TIER: Record<PageFeature['tier'], string> = {
  view: 'xem',
  manage: 'thao tác',
  elevated: 'nhạy cảm',
};

/** Chi tiết vài trang khớp nhất, kèm chức năng và mức nhạy cảm. */
export function moTaTrangKhop(khop: TrangKhopBanDo[], soTrang = 4): string {
  return khop
    .slice(0, soTrang)
    .map(({ page, nhomLabel, chucNang }) => {
      const cn = chucNang
        .map((f) => `  - ${f.label} [${TEN_TIER[f.tier]}]${f.desc ? ` — ${f.desc}` : ''}`)
        .join('\n');
      return `### ${page.label} — ${page.route}\n(nhóm: ${nhomLabel})${page.desc ? `\n${page.desc}` : ''}\nBạn làm được:\n${cn}`;
    })
    .join('\n\n');
}

/**
 * Người dùng đang ở trang nào — suy từ pathname.
 *
 * Khớp theo route DÀI NHẤT có tiền tố trùng: `/invoices/abc-123` phải ra trang
 * Hoá đơn chứ không phải trang gốc `/`. Route `/` chỉ khớp khi pathname đúng
 * bằng `/`, nếu không nó nuốt mọi đường dẫn.
 */
export function trangHienTai(
  pathname: string,
  perms: PermissionsMap | undefined,
): TrangKhopBanDo | null {
  return trangHienTaiTrong(VISIBLE_PAGE_GROUPS, pathname, perms);
}

/**
 * Bản nhận catalog qua tham số — để test được luật "khớp dài nhất".
 *
 * Cần bản này vì trong catalog THẬT hôm nay, route dài luôn tình cờ đứng TRƯỚC
 * route ngắn bao nó (`/settings/categories/asset-types` ở vị trí 25, còn
 * `/settings/categories` ở vị trí 37). Nghĩa là "lấy cái khớp đầu tiên" và "lấy
 * cái dài nhất" cho cùng kết quả, và một test trên catalog thật không phân biệt
 * được hai cách — luật sẽ nằm đó không ai canh cho tới ngày có người sắp xếp
 * lại catalog và Copilot bắt đầu chỉ sai trang.
 */
export function trangHienTaiTrong(
  nhomList: typeof VISIBLE_PAGE_GROUPS,
  pathname: string,
  perms: PermissionsMap | undefined,
): TrangKhopBanDo | null {
  let tot: TrangKhopBanDo | null = null;
  for (const nhom of nhomList) {
    for (const page of nhom.pages) {
      const khop = page.route === '/' ? pathname === '/' : pathname.startsWith(page.route);
      if (!khop) continue;
      const chucNang = chucNangDungDuoc(page, perms);
      if (!chucNang.length) continue;
      if (!tot || page.route.length > tot.page.route.length) {
        tot = { page, nhomLabel: nhom.label, chucNang, diem: 0 };
      }
    }
  }
  return tot;
}

/** Một dòng ngữ cảnh nhét vào system prompt cho chat. */
export function dongNguCanhTrang(
  pathname: string,
  perms: PermissionsMap | undefined,
): string | null {
  const t = trangHienTai(pathname, perms);
  if (!t) return null;
  return `NGỮ CẢNH: người dùng đang ở trang "${t.page.label}" (${t.page.route}). Khi họ nói "cái này", "ở đây", "trang này" thì hiểu theo trang đó.`;
}

// Tìm tài liệu nghiệp vụ cho Copilot.
//
// ĐÂY LÀ NƠI DUY NHẤT trong module `docs/` chạm I/O và chạm quyền. `tokenize`,
// `chunker`, `bm25` là hàm thuần và không biết gì về Supabase — ranh giới đó cố
// ý, nó là thứ khiến phần xếp hạng kiểm được bằng test tất định.
//
// BẤT BIẾN SỐ MỘT, và là chỗ dễ hỏng nhất của mọi thiết kế "nạp hết rồi index":
//
//     CHỈ ĐƯỢC TẢI THÂN TÀI LIỆU MÀ PHIÊN NÀY CÓ QUYỀN ĐỌC.
//
// Bản `huong_dan` cũ khớp theo tên file rồi chỉ nạp đúng file trúng, nên byte
// của 7 tài liệu gác quyền (lương, cổ đông, SOP tiền) CHƯA BAO GIỜ xuống trình
// duyệt người không phận sự. Một bản "nạp cả 25 file rồi index" sẽ phá tính
// chất đó trong im lặng: văn bản lương nằm trong bộ nhớ trang và trong tab
// Network của một nhân viên phòng, dù màn hình không hiện gì.
//
// Cái giá phải trả, chấp nhận có ý thức: `df` tính trên tập đã lọc nên điểm số
// phụ thuộc người dùng. An ninh thắng ổn định điểm số. Test giữ tất định bằng
// cách luôn truyền fixture quyền tường minh.
// `listDocTopics` và `napTaiLieu` đều lấy từ registry — CỐ Ý không khai
// `import.meta.glob` lần thứ hai ở đây. Cửa chặn `check-copilot-docs-manifest`
// khẳng định một bất biến cấu trúc: đường nạp `.md` và phép lọc theo manifest
// phải nằm chung một chỗ, để không tồn tại lối nạp tài liệu nào đi vòng qua
// allowlist. Thêm một glob ở file khác là tự mở đúng lối vòng đó.
import type { PermissionsMap } from '@/lib/permissions';
import { listDocTopics, napTaiLieu, type DocTopic } from '../tools/registry';
import { tachChunk, type DocChunk } from './chunker';
import { chamDiem, dungIndex, type Bm25Index, type ChunkHit } from './bm25';

export interface KetQuaTim {
  hits: ChunkHit[];
  /** `perms` chưa tải xong lúc gọi — trạng thái TẠM, khác hẳn "thiếu quyền". */
  quyenChuaTai: boolean;
  /** Các chủ đề được phép nhưng không lọt top — gợi ý hỏi tiếp. */
  chuDeLienQuan: string[];
}

export const SO_CHUNK_TOI_DA = 6;
export const GIOI_HAN_KY_TU = 6000;
export const CAP_MOI_CHUNK = 1500;

/** Cache index theo TẬP TÀI LIỆU ĐƯỢC PHÉP, không theo user. */
const cache = new Map<string, Promise<Bm25Index>>();

/** Test-only: xoá cache giữa các ca để chúng không ảnh hưởng nhau. */
export function xoaCacheIndex(): void {
  cache.clear();
}

async function layIndex(choPhep: DocTopic[]): Promise<Bm25Index> {
  const khoa = choPhep.map((t) => t.key).sort().join('|');
  let p = cache.get(khoa);
  if (!p) {
    p = (async () => {
      const tatCa: DocChunk[] = [];
      // Chỉ `choPhep` — xem bất biến số một ở đầu file.
      await Promise.all(
        choPhep.map(async (t) => {
          const noiDung = await napTaiLieu(t.path);
          if (noiDung === null) return;
          tatCa.push(...tachChunk(noiDung, t.key));
        }),
      );
      // Thứ tự Promise.all không ổn định giữa các lần chạy; sắp lại để điểm số
      // và thứ tự kết quả tất định.
      tatCa.sort((a, b) => a.id.localeCompare(b.id));
      return dungIndex(tatCa);
    })();
    cache.set(khoa, p);
  }
  return p;
}

/**
 * Tìm trong tài liệu nghiệp vụ.
 *
 * `perms === undefined` ⇒ `listDocTopics` đã fail-closed sẵn (chỉ trả tài liệu
 * không gắn quyền), và ta đánh dấu `quyenChuaTai` để chỗ gọi nói ra lý do.
 */
export async function timTaiLieu(
  cauHoi: string,
  perms: PermissionsMap | undefined,
  opts: { soChunk?: number; now?: number; chiTrongTaiLieu?: string } = {},
): Promise<KetQuaTim> {
  const choPhep = listDocTopics(perms, opts.now);
  const idx = await layIndex(choPhep);
  let hits = chamDiem(idx, cauHoi);
  if (opts.chiTrongTaiLieu) {
    hits = hits.filter((h) => h.chunk.docKey === opts.chiTrongTaiLieu);
  }

  const lay = hits.slice(0, opts.soChunk ?? SO_CHUNK_TOI_DA);
  const daLay = new Set(lay.map((h) => h.chunk.docKey));
  const lienQuan = [...new Set(hits.map((h) => h.chunk.docKey))]
    .filter((k) => !daLay.has(k))
    .slice(0, 4);

  return { hits: lay, quyenChuaTai: perms === undefined, chuDeLienQuan: lienQuan };
}

/** Cắt tại ranh giới dòng gần nhất — không cắt giữa câu. */
function catMem(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const cat = s.slice(0, cap);
  const nl = cat.lastIndexOf('\n');
  return `${nl > cap * 0.5 ? cat.slice(0, nl) : cat}\n…(cắt bớt)`;
}

/**
 * Dựng chuỗi trả về cho mô hình.
 *
 * Trích dẫn là VĂN BẢN THUẦN, không phải link markdown. Đã kiểm: `docs/he-thong`
 * không được publish ở đâu cả (`docs-site` chỉ phục vụ `docs/huong-dan-su-dung`,
 * và không route nào trong app phục vụ nó), nên mọi link kiểu
 * `/huong-dan/07-hoa-don...` sẽ 404. Đưa cho người dùng một link chết còn tệ
 * hơn không đưa link — họ mất niềm tin vào cả câu trả lời đúng.
 */
export function dinhDangChoModel(kq: KetQuaTim, gioiHan = GIOI_HAN_KY_TU): string {
  if (kq.quyenChuaTai && !kq.hits.length) {
    return 'Đang tải quyền truy cập của bạn, chưa tra được tài liệu. Hãy thử lại sau vài giây.';
  }
  if (!kq.hits.length) {
    return 'Không tìm thấy mục tài liệu nào khớp. Hãy hỏi lại bằng từ khoá khác, hoặc dùng công cụ liet_ke_chu_de để xem có những chủ đề nào.';
  }

  const phan: string[] = [];
  let con = gioiHan;
  for (const h of kq.hits) {
    if (con <= 200) break; // còn quá ít thì thêm nữa chỉ tạo mẩu vụn vô nghĩa
    const nhan = `${h.chunk.docKey} § ${h.chunk.headingPath.slice(1).join(' › ') || h.chunk.docTitle}`;
    const than = catMem(h.chunk.text, Math.min(CAP_MOI_CHUNK, con - nhan.length - 20));
    phan.push(`(nguồn: ${nhan})\n${than}`);
    con -= than.length + nhan.length + 20;
  }
  if (kq.chuDeLienQuan.length) {
    phan.push(`Chủ đề liên quan chưa trích: ${kq.chuDeLienQuan.join(', ')}`);
  }
  return phan.join('\n\n---\n\n');
}

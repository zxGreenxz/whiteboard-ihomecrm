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
import { listDocTopics, napTaiLieu, TIEN_TO_HUONG_DAN, type DocTopic } from '../tools/registry';
import { boLienKetMarkdown, tachChunk, type DocChunk } from './chunker';
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

/**
 * Trần số chunk lấy từ MỘT tài liệu, trước khi phải nhường chỗ cho tài liệu khác.
 *
 * Đo 03/09/2026, ngay khi corpus hướng dẫn vào index: câu "hợp đồng cọc hoá đơn"
 * — ba đối tượng nghiệp vụ khác nhau — trả về SÁU chunk đều từ đúng một trang
 * (`huong-dan-su-dung/03-quan-ly-van-hanh/dat-coc`). Trang hướng dẫn dài và mọi
 * mục của nó đều nhắc "cọc", nên nó thắng cả sáu suất bằng cách lặp lại chính
 * mình. Câu trả lời sinh ra từ đó nói rất kỹ về cọc và không nói gì về hai ý còn
 * lại — mà người đọc không có cách nào biết là đã thiếu.
 *
 * Ba là con số nhỏ nhất còn đủ cho một câu hỏi MỘT ý (mở đầu + hai mục), và nó
 * để dành ít nhất hai suất cho tài liệu thứ hai. Chunk dư của tài liệu đã đủ trần
 * KHÔNG bị vứt: chúng được lấp vào cuối nếu không còn tài liệu nào khác — thà
 * sáu mẩu cùng nguồn còn hơn ba mẩu và một khoảng trống.
 */
export const CAP_CHUNK_MOI_TAI_LIEU = 3;

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
          // Trang hướng dẫn mang link nội bộ của docs-site — làm phẳng thành chữ
          // trước khi index (xem `boLienKetMarkdown`).
          const than = t.key.startsWith(TIEN_TO_HUONG_DAN)
            ? boLienKetMarkdown(noiDung)
            : noiDung;
          tatCa.push(...tachChunk(than, t.key));
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

  const lay = canBangTheoTaiLieu(hits, opts.soChunk ?? SO_CHUNK_TOI_DA);
  const daLay = new Set(lay.map((h) => h.chunk.docKey));
  const lienQuan = [...new Set(hits.map((h) => h.chunk.docKey))]
    .filter((k) => !daLay.has(k))
    .slice(0, 4);

  return { hits: lay, quyenChuaTai: perms === undefined, chuDeLienQuan: lienQuan };
}

/**
 * Chọn `soChunk` mẩu tốt nhất, nhưng không để MỘT tài liệu chiếm hết.
 *
 * Lượt một giữ nguyên thứ tự điểm và bỏ qua mẩu của tài liệu đã chạm
 * `CAP_CHUNK_MOI_TAI_LIEU`; lượt hai lấp phần còn thiếu bằng chính những mẩu vừa
 * bị bỏ qua, vẫn theo thứ tự điểm. Thứ tự cuối cùng vì thế vẫn tất định.
 */
export function canBangTheoTaiLieu(hits: ChunkHit[], soChunk: number): ChunkHit[] {
  const chon: ChunkHit[] = [];
  const dem = new Map<string, number>();
  const dele: ChunkHit[] = [];
  for (const h of hits) {
    if (chon.length >= soChunk) break;
    const n = dem.get(h.chunk.docKey) ?? 0;
    if (n >= CAP_CHUNK_MOI_TAI_LIEU) {
      dele.push(h);
      continue;
    }
    dem.set(h.chunk.docKey, n + 1);
    chon.push(h);
  }
  for (const h of dele) {
    if (chon.length >= soChunk) break;
    chon.push(h);
  }
  return chon;
}

/** Cắt tại ranh giới dòng gần nhất — không cắt giữa câu. */
function catMem(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const cat = s.slice(0, cap);
  const nl = cat.lastIndexOf('\n');
  return `${nl > cap * 0.5 ? cat.slice(0, nl) : cat}\n…(cắt bớt)`;
}

/**
 * Nhãn nguồn của MỘT chunk.
 *
 * Hai corpus nằm chung một index nhưng phải đọc khác nhau. `07-hoa-don-thanh-toan`
 * là mã tài liệu NỘI BỘ — người dùng cuối chưa từng thấy chuỗi đó và nó không
 * nói lên điều gì với họ; còn trang hướng dẫn thì có TIÊU ĐỀ do người viết đặt
 * cho đúng người đọc ("Hoá đơn — danh sách & tạo lẻ"). Nên hướng dẫn được dán
 * nhãn `Hướng dẫn › <tiêu đề>`, tài liệu hệ thống giữ nguyên mã như cũ.
 */
export function nhanNguon(chunk: DocChunk): string {
  const muc = chunk.headingPath.slice(1).join(' › ');
  if (chunk.docKey.startsWith(TIEN_TO_HUONG_DAN)) {
    return `Hướng dẫn › ${chunk.docTitle}${muc ? ` § ${muc}` : ''}`;
  }
  return `${chunk.docKey} § ${muc || chunk.docTitle}`;
}

/**
 * Dựng chuỗi trả về cho mô hình.
 *
 * Trích dẫn là VĂN BẢN THUẦN, không phải link markdown — cho CẢ HAI corpus.
 *
 * `docs/he-thong` không được publish ở đâu cả, nên mọi link tới nó sẽ 404. Với
 * `docs/huong-dan-su-dung` câu trả lời dài hơn một dòng, và nó vẫn ra "không
 * link" (đo 03/09/2026):
 *
 *   - Thư mục ĐƯỢC publish, nhưng bởi `docs-site` — một site VitePress RIÊNG,
 *     `cleanUrls`, `srcDir: '../docs/huong-dan-su-dung'`. Đường dẫn của nó
 *     (`/03-quan-ly-van-hanh/hoa-don`) là đường dẫn của MỘT ORIGIN KHÁC. Link
 *     tương đối trong khung chat sẽ giải theo origin của ứng dụng, nơi không có
 *     route nào như vậy — đúng lỗi 404 mà đoạn trên nói tới.
 *   - Repo KHÔNG khai tên miền của site đó ở đâu (`docs-site/vercel.json` không
 *     có domain, config không có `base`), nên không dựng được URL tuyệt đối mà
 *     không đoán.
 *   - Và site đó nằm sau basic auth (`docs-site/middleware.ts`, fail-closed khi
 *     thiếu `DOCS_PASSWORD`) kèm `noindex`. Kể cả đoán đúng tên miền thì phần
 *     lớn người dùng ứng dụng vẫn gặp một hộp thoại đăng nhập họ không có mật
 *     khẩu.
 *
 * Ba lý do độc lập, cùng một kết luận. Trong app, đường tới hướng dẫn là
 * `mo_trang` (link tới chính màn hình đó) chứ không phải link tới trang tài liệu.
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
    const nhan = nhanNguon(h.chunk);
    const than = catMem(h.chunk.text, Math.min(CAP_MOI_CHUNK, con - nhan.length - 20));
    phan.push(`(nguồn: ${nhan})\n${than}`);
    con -= than.length + nhan.length + 20;
  }
  if (kq.chuDeLienQuan.length) {
    phan.push(`Chủ đề liên quan chưa trích: ${kq.chuDeLienQuan.join(', ')}`);
  }
  return phan.join('\n\n---\n\n');
}

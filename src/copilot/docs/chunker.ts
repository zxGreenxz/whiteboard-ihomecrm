// Cắt tài liệu markdown thành chunk theo heading — hàm THUẦN.
//
// Vì sao cắt theo heading chứ không theo số ký tự cố định: đo trên 25 tài liệu
// Copilot đang đọc (12/08/2026) ra 584 mục với trung vị ~973 byte. Heading của
// bộ tài liệu này gần như CHÍNH LÀ câu hỏi của người dùng ("Thanh lý hợp đồng",
// "Cọc giữ chỗ", "Chốt chỉ số công tơ"), nên ranh giới heading vừa là ranh giới
// ngữ nghĩa vừa là tín hiệu xếp hạng mạnh nhất ta có.
import { boDau } from './tokenize';

export interface DocChunk {
  /** `${docKey}#${anchor}`, thêm `~2`, `~3` khi một mục bị chẻ vì quá dài. */
  id: string;
  docKey: string;
  /** H1 của tài liệu. */
  docTitle: string;
  /** Đường dẫn heading đầy đủ H1 › H2 › H3 — cách giữ ngữ cảnh cha. */
  headingPath: string[];
  /** Slug của heading CUỐI trong đường dẫn. */
  anchor: string;
  level: 1 | 2 | 3 | 4;
  /** Nguyên văn thân đoạn, KHÔNG gồm dòng heading. */
  text: string;
}

/** Trên ngưỡng này thì chẻ nhỏ. p99 đo được là ~7,5KB, max ~11,3KB. */
const NGUONG_CHE = 2500;

/**
 * Slug cho anchor. Một nguồn duy nhất — nếu sau này có trang xem tài liệu thì
 * trang đó phải gọi CHÍNH hàm này, không chép lại thuật toán "bằng mắt".
 */
export function slugHeading(tieuDe: string): string {
  return boDau(tieuDe)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Chẻ một đoạn quá dài tại ranh giới dòng trống, không cắt giữa câu. */
function cheDoan(text: string, nguong: number): string[] {
  if (text.length <= nguong) return [text];
  const phan: string[] = [];
  let hienTai = '';
  for (const doan of text.split(/\n\s*\n/)) {
    if (hienTai && hienTai.length + doan.length + 2 > nguong) {
      phan.push(hienTai);
      hienTai = doan;
    } else {
      hienTai = hienTai ? `${hienTai}\n\n${doan}` : doan;
    }
  }
  if (hienTai) phan.push(hienTai);
  // Một đoạn đơn lẻ vẫn quá dài (bảng lớn, khối mã) — cắt cứng, thà cắt còn hơn
  // để một chunk nuốt trọn ngân sách.
  return phan.flatMap((p) =>
    p.length <= nguong * 2 ? [p] : (p.match(new RegExp(`[\\s\\S]{1,${nguong}}`, 'g')) ?? [p]),
  );
}

/**
 * Bỏ khối YAML frontmatter ở ĐẦU file.
 *
 * VÌ SAO: 25 trang `docs/huong-dan-su-dung/**` đều mở đầu bằng frontmatter chứa
 * `title`, `routes`, `captured.commit` (một SHA git 40 ký tự), `status`. Không
 * bỏ thì khối đó thành chunk `level: 1` của mỗi trang — tức index BM25 chứa 25
 * mẩu siêu dữ liệu, và một SHA git là chuỗi token hiếm nhất trong cả corpus.
 * Chúng không trả lời được câu hỏi nào của người dùng, nhưng vẫn cạnh tranh vị
 * trí với đoạn văn thật.
 *
 * Chỉ nhận khi file MỞ ĐẦU bằng `---` và có `---` đóng trong 80 dòng đầu: một
 * đường kẻ ngang `---` giữa bài viết thì không thoả điều kiện thứ nhất.
 */
export function boFrontmatter(md: string): string {
  const dong = md.split(/\r?\n/);
  if (dong[0]?.trim() !== '---') return md;
  const dong2 = dong.slice(1, 80).findIndex((l) => l.trim() === '---');
  if (dong2 < 0) return md;
  return dong.slice(dong2 + 2).join('\n');
}

/**
 * Làm phẳng link/ảnh markdown thành CHỮ.
 *
 * Chỉ dùng cho corpus hướng dẫn, và lý do rất cụ thể. Đo 03/09/2026 trên 25
 * trang: MỌI đích link đều là đường dẫn của docs-site (`/03-quan-ly-van-hanh/…`)
 * hoặc ảnh tương đối (`./images/…`) — không có lấy một route của ứng dụng. Nội
 * dung chunk đi thẳng vào ngữ cảnh mô hình, và luật 9 của system prompt bảo nó
 * GIỮ NGUYÊN phần tài liệu trả về; nên để nguyên cú pháp link là dạy mô hình dán
 * vào khung chat một địa chỉ giải theo origin của ứng dụng, nơi nó 404. Đưa cho
 * người dùng một link chết còn tệ hơn không đưa link.
 *
 * Nhãn được GIỮ LẠI (kể cả alt của ảnh): "Sinh hoá đơn hàng loạt" là chữ có ích
 * cho cả việc xếp hạng lẫn câu trả lời; `./images/buoc-01-danh-sach.webp` thì
 * không.
 */
export function boLienKetMarkdown(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)]*\)/g, '$1');
}

/**
 * Cắt markdown thành chunk.
 *
 * - Bỏ YAML frontmatter trước khi cắt (xem `boFrontmatter`).
 * - Cắt tại `##`/`###`/`####`. `#` là tiêu đề tài liệu, KHÔNG cắt.
 * - Phần giữa H1 và H2 đầu tiên thành chunk `level: 1`: ở bộ tài liệu này đó
 *   là khối "Reviewed / nguồn hiện hành / phạm vi", thường định nghĩa thuật ngữ
 *   và ghi các cập nhật mới nhất — vứt đi là mất phần đắt nhất của tài liệu.
 * - Bỏ qua heading nằm trong code fence. Hôm nay corpus không có ca nào (đo:
 *   0/29 file), nên đây là chặn trước chứ không phải vá lỗi đang có.
 */
export function tachChunk(md: string, docKey: string): DocChunk[] {
  const dong = boFrontmatter(md).split(/\r?\n/);
  const chunks: DocChunk[] = [];

  let docTitle = docKey;
  let duongDan: { level: number; text: string }[] = [];
  let than: string[] = [];
  let trongFence = false;

  const chot = () => {
    const text = than.join('\n').trim();
    than = [];
    if (!text) return;
    const cha = duongDan[duongDan.length - 1];
    const level = (cha ? Math.min(cha.level, 4) : 1) as DocChunk['level'];
    const anchor = cha ? slugHeading(cha.text) : slugHeading(docTitle);
    const path = [docTitle, ...duongDan.map((d) => d.text)];
    const manh = cheDoan(text, NGUONG_CHE);
    manh.forEach((t, i) => {
      chunks.push({
        // Giữ NGUYÊN anchor cho mọi mảnh: trích dẫn vẫn phải chỉ về đúng mục,
        // người đọc không quan tâm nó là mảnh thứ mấy.
        id: `${docKey}#${anchor}${i ? `~${i + 1}` : ''}`,
        docKey,
        docTitle,
        headingPath: path,
        anchor,
        level,
        text: t,
      });
    });
  };

  for (const l of dong) {
    if (/^\s*```/.test(l)) {
      trongFence = !trongFence;
      than.push(l);
      continue;
    }
    if (trongFence) {
      than.push(l);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (!h) {
      than.push(l);
      continue;
    }
    const level = h[1].length;
    const tieuDe = h[2].trim();
    if (level === 1) {
      chot();
      docTitle = tieuDe;
      duongDan = [];
      continue;
    }
    chot();
    // Lùi về đúng bậc cha rồi đẩy heading hiện tại — giữ đường dẫn luôn đúng
    // kể cả khi tài liệu nhảy bậc (## rồi #### không qua ###).
    duongDan = duongDan.filter((d) => d.level < level);
    duongDan.push({ level, text: tieuDe });
  }
  chot();

  return chunks;
}

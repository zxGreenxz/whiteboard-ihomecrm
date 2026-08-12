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
 * Cắt markdown thành chunk.
 *
 * - Cắt tại `##`/`###`/`####`. `#` là tiêu đề tài liệu, KHÔNG cắt.
 * - Phần giữa H1 và H2 đầu tiên thành chunk `level: 1`: ở bộ tài liệu này đó
 *   là khối "Reviewed / nguồn hiện hành / phạm vi", thường định nghĩa thuật ngữ
 *   và ghi các cập nhật mới nhất — vứt đi là mất phần đắt nhất của tài liệu.
 * - Bỏ qua heading nằm trong code fence. Hôm nay corpus không có ca nào (đo:
 *   0/29 file), nên đây là chặn trước chứ không phải vá lỗi đang có.
 */
export function tachChunk(md: string, docKey: string): DocChunk[] {
  const dong = md.split(/\r?\n/);
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

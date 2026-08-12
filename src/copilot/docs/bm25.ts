// Chấm điểm BM25 — hàm THUẦN, không I/O, không biết Supabase, không biết quyền.
//
// Ranh giới đó là thứ khiến "kiểm bằng đột biến" ở Contract §8 làm được: mọi
// bất biến xếp hạng kiểm được bằng Vitest với corpus dựng tay, không cần mạng,
// không cần mock.
import type { DocChunk } from './chunker';
import { tokenTaiLieu, tokenTruyVan } from './tokenize';

export interface ChunkHit {
  chunk: DocChunk;
  score: number;
  tuKhop: string[];
}

export interface Bm25Index {
  chunks: DocChunk[];
  /** token → số chunk chứa nó. */
  df: Map<string, number>;
  /** token → (chỉ số chunk → số lần xuất hiện) cho phần THÂN. */
  tfThan: Map<string, Map<number, number>>;
  /** Như trên nhưng cho phần ĐƯỜNG DẪN HEADING. */
  tfTieuDe: Map<string, Map<number, number>>;
  doDaiThan: number[];
  doDaiTieuDe: number[];
  avgThan: number;
  avgTieuDe: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * Trọng số phần tiêu đề so với phần thân.
 *
 * Knob quan trọng nhất của cả module. Heading trong bộ tài liệu này gần như
 * chính là câu hỏi người dùng gõ, nên một chunk mà TIÊU ĐỀ khớp gần như chắc
 * chắn đúng hơn một chunk chỉ NHẮC TỚI cụm đó giữa thân bài. Cụ thể: hỏi
 * "thanh lý hợp đồng" phải ra `16-thanh-ly-hop-dong.md`, không phải một đoạn
 * trong `05-hop-dong.md` tình cờ nhắc tên. Có test §8 canh đúng ca đó.
 */
export const W_TIEU_DE = 2.5;

/** Bigram khớp là bằng chứng mạnh hơn hẳn âm tiết đơn — xem chú thích tokenize. */
const W_BIGRAM = 2.0;

/** Sàn vệ sinh, chặn nhiễu vụn. Không phải cơ chế lọc rác chính — xem dưới. */
export const DIEM_TOI_THIEU = 1;

/**
 * Token xuất hiện ở hơn ngần này tỉ lệ chunk thì coi là KHÔNG có sức phân biệt.
 *
 * Vì sao KHÔNG dùng ngưỡng ĐIỂM tuyệt đối thay cho luật này — đo trên corpus
 * thật ngày 12/08/2026:
 *
 *   câu tốt, dài  "thanh lý hợp đồng"        → 118,6
 *   câu tốt, ngắn "công tơ"                  →  72,8
 *   câu tốt, hiếm "zalo"                     →  14,2  ← đúng tài liệu
 *   câu rác       "cái này thì sao"          →  14,7
 *
 * Hai nhóm chồng lấn theo điểm, nên mọi ngưỡng điểm đều vừa giết câu đúng vừa
 * cho lọt câu rác.
 *
 * NGƯỠNG 0,4 LÀ SỐ ĐO, KHÔNG PHẢI SỐ ĐOÁN. Bản đầu tôi đặt 0,2 và nó loại nhầm
 * đúng những từ nghiệp vụ trung tâm nhất — đo trên 634 chunk:
 *
 *   chi      69,4%  ← thật sự vô nghĩa khi đứng một mình
 *   thu      51,6%  ← thật sự vô nghĩa khi đứng một mình
 *   lương    26,5%  ← BỊ LOẠI OAN ở ngưỡng 0,2
 *   cọc      25,9%  ← BỊ LOẠI OAN
 *   thu_chi  21,3%  ← BỊ LOẠI OAN
 *   mã       19,9%
 *   công_nợ   3,0%
 *
 * Trong một bộ tài liệu về quản lý cho thuê, "cọc" và "lương" có mặt ở một phần
 * tư số mục là chuyện bình thường — điều đó KHÔNG làm chúng mất nghĩa. Ở 0,2 thì
 * "cọc" và "lương" chỉ còn ra kết quả nhờ bảng đồng nghĩa cứu tình cờ, còn
 * "thu chi" trả rỗng hoàn toàn.
 *
 * Luật này giờ chỉ còn nhắm đúng phần việc của nó — chặn âm tiết đứng một mình
 * mà mọi chunk đều có. Việc lọc hư từ đã có bảng riêng trong `tokenize.ts`, và
 * bảng đó lọc trên dạng CÓ DẤU nên không đụng từ nghiệp vụ.
 */
export const NGUONG_PHO_BIEN = 0.4;

function dem(tokens: string[], idx: number, kho: Map<string, Map<number, number>>): void {
  for (const t of tokens) {
    let m = kho.get(t);
    if (!m) {
      m = new Map();
      kho.set(t, m);
    }
    m.set(idx, (m.get(idx) ?? 0) + 1);
  }
}

export function dungIndex(chunks: DocChunk[]): Bm25Index {
  const tfThan = new Map<string, Map<number, number>>();
  const tfTieuDe = new Map<string, Map<number, number>>();
  const doDaiThan: number[] = [];
  const doDaiTieuDe: number[] = [];

  chunks.forEach((c, i) => {
    const tThan = tokenTaiLieu(c.text);
    const tTieuDe = tokenTaiLieu(c.headingPath.join(' '));
    dem(tThan, i, tfThan);
    dem(tTieuDe, i, tfTieuDe);
    doDaiThan.push(tThan.length);
    doDaiTieuDe.push(tTieuDe.length);
  });

  // df tính trên HỢP của hai trường: một token chỉ xuất hiện ở tiêu đề vẫn phải
  // có idf, nếu không thì mọi tiêu đề đều vô hình với công thức.
  const df = new Map<string, number>();
  const moiToken = new Set([...tfThan.keys(), ...tfTieuDe.keys()]);
  for (const t of moiToken) {
    const co = new Set<number>();
    for (const i of tfThan.get(t)?.keys() ?? []) co.add(i);
    for (const i of tfTieuDe.get(t)?.keys() ?? []) co.add(i);
    df.set(t, co.size);
  }

  const tong = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  return {
    chunks,
    df,
    tfThan,
    tfTieuDe,
    doDaiThan,
    doDaiTieuDe,
    avgThan: tong(doDaiThan) || 1,
    avgTieuDe: tong(doDaiTieuDe) || 1,
  };
}

function bm25Truong(
  tf: number,
  doDai: number,
  avg: number,
  idf: number,
): number {
  if (!tf) return 0;
  return idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doDai / avg))));
}

/**
 * Chấm điểm truy vấn trên index. Trả về danh sách đã sắp giảm dần, đã lọc dưới
 * `DIEM_TOI_THIEU`.
 */
export function chamDiem(idx: Bm25Index, truyVan: string): ChunkHit[] {
  const tokens = tokenTruyVan(truyVan);
  if (!tokens.length) return [];
  const N = idx.chunks.length || 1;

  const diem = new Map<number, number>();
  const khop = new Map<number, Set<string>>();
  /** Chunk nào đã khớp ít nhất một token CÓ SỨC PHÂN BIỆT. */
  const coTuHiem = new Set<number>();

  for (const t of tokens) {
    const dfT = idx.df.get(t);
    if (!dfT) continue;
    const phanBiet = dfT / N <= NGUONG_PHO_BIEN;
    // idf BM25 dạng chuẩn, cộng 1 để không âm khi token có mặt ở hầu hết chunk.
    const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
    const wBi = t.includes('_') ? W_BIGRAM : 1;

    for (const [i, tf] of idx.tfThan.get(t) ?? []) {
      const d = bm25Truong(tf, idx.doDaiThan[i], idx.avgThan, idf) * wBi;
      diem.set(i, (diem.get(i) ?? 0) + d);
      (khop.get(i) ?? khop.set(i, new Set()).get(i)!).add(t);
      if (phanBiet) coTuHiem.add(i);
    }
    for (const [i, tf] of idx.tfTieuDe.get(t) ?? []) {
      const d = bm25Truong(tf, idx.doDaiTieuDe[i], idx.avgTieuDe, idf) * wBi * W_TIEU_DE;
      diem.set(i, (diem.get(i) ?? 0) + d);
      (khop.get(i) ?? khop.set(i, new Set()).get(i)!).add(t);
      if (phanBiet) coTuHiem.add(i);
    }
  }

  return [...diem.entries()]
    // Chỉ khớp hư từ ⇒ loại. Đây mới là bộ lọc rác chính; `DIEM_TOI_THIEU` chỉ
    // quét nốt nhiễu vụn. Xem chú thích `NGUONG_PHO_BIEN` để biết vì sao không
    // dùng ngưỡng điểm.
    .filter(([i, s]) => s >= DIEM_TOI_THIEU && coTuHiem.has(i))
    .sort((a, b) => b[1] - a[1])
    .map(([i, s]) => ({ chunk: idx.chunks[i], score: s, tuKhop: [...(khop.get(i) ?? [])] }));
}

// Ô "Hình ảnh/chứng từ" của hộp thoại Thu/Chi — phần toán, tách khỏi giao diện.
//
// TỪ 27/08/2026 ẢNH ĐÍNH KÈM VÀ CHỨNG TỪ LÀ MỘT TẤM. Trước đó chúng là hai kho
// tách rời: ảnh dán trong hộp thoại đi vào `finance_evidence_objects` (path
// `v2/<org>/<mid>/<uuid>`, không đuôi file), còn dòng thu chi ngoài màn hình chỉ
// đọc `income_expenses.attachments` — nên ảnh chứng từ vừa dán KHÔNG BAO GIỜ
// hiện ở dòng phiếu. Chủ báo đúng hiện tượng này ngày 27/08/2026.
//
// Cách chữa: dán ảnh = đính ảnh lên phiếu (annotate_income_expense_v1) rồi nhận
// chính file đó làm chứng từ (adopt_voucher_attachments_as_evidence_v2). Vì vậy
// danh sách hiển thị chỉ còn MỘT: các URL trong `attachments` của phiếu.
//
// Hàm ở đây thuần tuý để test được không cần dựng DOM (xem
// `src/lib/__tests__/postingEvidenceItems.test.ts`).

/** Lý do server trả về khi một ảnh KHÔNG dùng được làm chứng từ cho lần ghi sổ này. */
export interface PostingEvidenceSkip {
  url: string;
  reason: string;
}

export interface PostingEvidenceItem {
  url: string;
  /** Dùng được làm chứng từ cho lần ghi sổ đang mở không. */
  usable: boolean;
  /** Mã lý do thô từ `adopt_voucher_attachments_as_evidence_v2` (nếu không dùng được). */
  reason?: string;
  /** Câu tiếng Việt cho người dùng đọc. */
  reasonText?: string;
  /** Người dùng vừa dán trong phiên mở hộp thoại này. */
  addedNow: boolean;
}

export interface BuildPostingEvidenceItemsInput {
  /** `income_expenses.attachments` của phiếu. */
  attachments?: string[] | null;
  /** Mảng `skipped` của adopt RPC. */
  skipped?: PostingEvidenceSkip[] | null;
  /** URL vừa dán trong phiên này (có thể chưa kịp về trong `attachments`). */
  sessionUploaded?: string[] | null;
}

/**
 * Đổi mã lý do của server sang câu người dùng hiểu được.
 *
 * `ATTACHED` là mã hay gặp nhất và cũng dễ gây hiểu nhầm nhất: nó KHÔNG phải
 * lỗi, mà là luật one-shot — mỗi lần ghi sổ phải có chứng từ riêng, nên ảnh đã
 * dùng cho lần chi trước không tính lại cho lần chi sau (kể cả sau khi hoàn tác).
 */
export function describeEvidenceSkipReason(reason: string | undefined): string {
  switch (reason) {
    case 'ATTACHED':
      return 'Đã dùng cho lần ghi sổ trước — mỗi lần chi cần chứng từ riêng';
    case 'QUARANTINED':
      return 'Ảnh đang bị cách ly';
    case 'FILE_KHONG_CON_TRONG_STORAGE':
      return 'File không còn trong kho lưu trữ';
    case 'FILE_THUOC_TO_CHUC_KHAC':
      return 'File thuộc tổ chức khác';
    case 'KHONG_PHAI_FILE_STORAGE':
      return 'Không phải file trong kho lưu trữ';
    case 'BUCKET_KHONG_HOP_LE':
      return 'File nằm ngoài kho ảnh chứng từ';
    case undefined:
      return 'Không dùng được làm chứng từ';
    default:
      return `Không dùng được làm chứng từ (${reason})`;
  }
}

/** PDF thì vẽ icon thay vì thumbnail (đối xứng AttachmentUpload lúc tạo phiếu). */
export function isPdfAttachment(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url);
}

/**
 * Gộp ảnh của phiếu + ảnh vừa dán, đánh dấu cái nào dùng được làm chứng từ.
 * Giữ nguyên thứ tự: ảnh sẵn có trước, ảnh vừa dán sau; không trùng lặp.
 */
export function buildPostingEvidenceItems(
  input: BuildPostingEvidenceItemsInput,
): PostingEvidenceItem[] {
  const skipByUrl = new Map<string, string>();
  for (const s of input.skipped ?? []) {
    if (s && typeof s.url === 'string') skipByUrl.set(s.url, s.reason);
  }
  const session = new Set((input.sessionUploaded ?? []).filter(Boolean));

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const url of [...(input.attachments ?? []), ...(input.sessionUploaded ?? [])]) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    ordered.push(url);
  }

  return ordered.map((url) => {
    const skipped = skipByUrl.has(url);
    const reason = skipped ? skipByUrl.get(url) : undefined;
    return {
      url,
      usable: !skipped,
      reason,
      reasonText: skipped ? describeEvidenceSkipReason(reason) : undefined,
      addedNow: session.has(url),
    };
  });
}

/** Bao nhiêu ảnh thật sự tính là chứng từ cho lần ghi sổ này. */
export function countUsableEvidence(items: PostingEvidenceItem[]): number {
  return items.filter((i) => i.usable).length;
}

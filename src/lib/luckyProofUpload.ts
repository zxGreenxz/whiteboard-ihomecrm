import { PROOF_MAX_BYTES, PROOF_MAX_FILES, uploadLuckyProof, type LuckyProof } from './luckyDrawApi';
import { publicFailure, PublicRequestError } from './publicFeedback';

export type ProofFailure = { file: File; message: string };
/**
 * Câu báo cho một tệp tải hỏng. Kho từ chối rõ (4xx: quá cỡ, sai loại, sự kiện đã đóng) thì nói lý do. Còn lại (mất mạng,
 * hết giờ, 5xx) là chưa rõ, nhưng mỗi lần tải là một đường dẫn mới nên tải lại luôn an toàn (đợt 9, mẫu PR #478).
 */
function uploadFailure(error: unknown, file: File): string {
  if (error instanceof PublicRequestError && error.status >= 400 && error.status < 500) return publicFailure(error, `tải giấy cọc ${file.name}`);
  return `Chưa tải xong ${file.name}: mạng chập chờn hoặc bị ngắt giữa chừng. Bấm «Thử lại ${file.name}» hoặc chọn lại tệp; mỗi lần tải là một tệp mới nên không tạo trùng giấy cọc.`;
}
/** Retains uploaded identities even if another file fails. Attachment is a separate step. */
export async function uploadProofBatch(eventId: string, files: File[], existingCount: number,
  upload = uploadLuckyProof, progress?: (index: number, total: number) => void, onUploaded?: (proof: LuckyProof) => void) {
  const uploaded: Array<{ proof: LuckyProof; file: File }> = [];
  const failed: ProofFailure[] = [];
  const available = Math.max(0, PROOF_MAX_FILES - existingCount);
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (index >= available) { failed.push({ file, message: `Tối đa ${PROOF_MAX_FILES} giấy cọc cho mỗi đội. Gỡ bớt tệp đã nộp trước khi thêm.` }); continue; }
    if (file.size > PROOF_MAX_BYTES) { failed.push({ file, message: `Tệp ${file.name} vượt 10 MB. Chọn tệp nhỏ hơn.` }); continue; }
    progress?.(index + 1, files.length);
    let proof: LuckyProof;
    try { proof = await upload(eventId, file); }
    catch (error) { failed.push({ file, message: uploadFailure(error, file) }); continue; }
    uploaded.push({ proof, file });
    // Giữ biên nhận dương của từng tệp trước khi tải tệp kế tiếp hay gắn vào đội.
    onUploaded?.(proof);
  }
  return { uploaded, failed };
}

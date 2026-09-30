import { PROOF_MAX_BYTES, PROOF_MAX_FILES, uploadLuckyProof, type LuckyProof } from './luckyDrawApi';
import { publicFailure } from './publicFeedback';

export type ProofFailure = { file: File; message: string };
/** Retains uploaded identities even if another file fails. Attachment is a separate step. */
export async function uploadProofBatch(eventId: string, files: File[], existingCount: number,
  upload = uploadLuckyProof, progress?: (index: number, total: number) => void, onUploaded?: (proof: LuckyProof) => void, lifecycle?: { onPlanned?: (proof: LuckyProof) => void; onRejected?: (proof: LuckyProof) => void }) {
  const uploaded: Array<{ proof: LuckyProof; file: File }> = [];
  const failed: ProofFailure[] = [];
  const available = Math.max(0, PROOF_MAX_FILES - existingCount);
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (index >= available) { failed.push({ file, message: `Tối đa ${PROOF_MAX_FILES} giấy cọc cho mỗi đội. Gỡ bớt tệp đã nộp trước khi thêm.` }); continue; }
    if (file.size > PROOF_MAX_BYTES) { failed.push({ file, message: `Tệp ${file.name} vượt 10 MB. Chọn tệp nhỏ hơn.` }); continue; }
    progress?.(index + 1, files.length);
    try {
      const proof = await upload(eventId, file, lifecycle);
      uploaded.push({ proof, file });
      // Preserve each positive receipt before starting the next file or attachment request.
      onUploaded?.(proof);
    }
    catch (error) { failed.push({ file, message: publicFailure(error, `tải giấy cọc ${file.name}`) }); }
  }
  return { uploaded, failed };
}

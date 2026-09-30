import { supabase } from '@/integrations/supabase/client';
import { renderContractDocxBuffer } from '@/lib/contractTemplateEngine';
import { buildContractSigningArgs, contractSigningSchema, contractSigningSnapshotSchema,
  type ContractSigning, type ContractSigningInput, type ContractSigningSnapshot } from '@/lib/contractSigning';

export async function readContractDraftSigning(organizationId: string, draftId: string): Promise<ContractSigningSnapshot> {
  const { data, error } = await supabase.rpc('read_contract_draft_signing_v1', { p_organization_id: organizationId, p_draft_id: draftId });
  if (error) throw error;
  return contractSigningSnapshotSchema.parse(data);
}
/** This call commits signing independently of browser rendering/upload. */
export async function signAndCheckinDraft(organizationId: string, input: ContractSigningInput,onReceipt?:(data:unknown)=>void): Promise<ContractSigning> {
  const { data, error } = await supabase.rpc('sign_and_checkin_contract_draft_v1', buildContractSigningArgs(organizationId, input));
  if (error) throw error;
  onReceipt?.(data);
  return contractSigningSchema.parse(data);
}
async function sha256(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function getOrCreateSignedContractDocument(signing: ContractSigning): Promise<{ signing: ContractSigning; blob: Blob }> {
  const signedBucket = supabase.storage.from('contract-signed-documents');
  if (signing.official_document_sha256) {
    const { data, error } = await signedBucket.download(signing.official_document_path);
    if (error) throw error;
    if (!data || await sha256(data) !== signing.official_document_sha256) throw new Error('Tài liệu đã lưu không khớp hash. Hợp đồng vẫn đã ký; cần kiểm tra bản tải.');
    return { signing, blob: data };
  }
  const templateResult = await supabase.storage.from('contract-draft-documents').download(signing.template_path);
  if (templateResult.error) throw templateResult.error;
  if (!templateResult.data || await sha256(templateResult.data) !== signing.template_sha256) throw new Error('Mẫu không khớp snapshot đã ký. Hợp đồng vẫn đã được ghi nhận.');
  let blob = await renderContractDocxBuffer(await templateResult.data.arrayBuffer(), signing.document_data);
  const upload = await signedBucket.upload(signing.official_document_path, blob, {
    upsert: false, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  if (upload.error) {
    // A previous upload can have succeeded while its response/registration was lost.
    // Adopt those exact bytes; replacement is forbidden by the private bucket policy.
    const previous = await signedBucket.download(signing.official_document_path);
    if (previous.error || !previous.data) throw upload.error;
    blob = previous.data;
  }
  const documentHash = await sha256(blob);
  const { data, error } = await supabase.rpc('register_contract_signed_document_v1', {
    p_organization_id: signing.organization_id, p_signing_id: signing.id, p_document_sha256: documentHash,
  });
  if (error) throw error;
  const registered = contractSigningSchema.parse(data);
  if (registered.id !== signing.id || registered.official_document_sha256 !== documentHash) throw new Error('Bản tải không khớp nguồn hợp đồng đã ký.');
  return { signing: registered, blob };
}

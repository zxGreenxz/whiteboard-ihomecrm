import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked=vi.hoisted(()=>({rpc:vi.fn(),download:vi.fn(),upload:vi.fn(),render:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocked.rpc,storage:{from:()=>({download:mocked.download,upload:mocked.upload})}}}));
vi.mock('@/lib/contractTemplateEngine',()=>({renderContractDocxBuffer:mocked.render}));
import { getOrCreateSignedContractDocument, signAndCheckinDraft } from '../contractSigningApi';
import type { ContractSigning } from '../contractSigning';
const id='11111111-1111-4111-8111-111111111111';
async function hash(blob:Blob){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');}
const template=new Blob(['exact original template']),official=new Blob(['official document']);
let signing:ContractSigning;
beforeEach(async()=>{vi.resetAllMocks();signing={id,organization_id:id,building_id:id,room_id:id,draft_id:id,revision:1,document_id:id,document_sha256:'a'.repeat(64),template_sha256:await hash(template),template_path:'template.docx',template_snapshot:{id,name:'Mẫu',updated_at:'2026-09-28'},document_data:{CONTRACT_NUMBER:'HD-2026-00001'},terms:{},party_snapshot:[],creation_options:{},received_on:'2026-09-28',contract_id:id,contract_number:'HD-2026-00001',request_id:id,signed_by:id,signed_at:'2026-09-28',official_document_path:'signed/document.docx',official_document_sha256:null};});
describe('signed document after commit',()=>{
  it('signs through the single new RPC and returns persisted signing even before any rendering',async()=>{
    mocked.rpc.mockResolvedValue({data:signing,error:null});
    expect(await signAndCheckinDraft(id,{source:{draftId:id,revision:1,documentId:id,documentSha256:'a'.repeat(64)},requestId:id,receivedOn:'2026-09-28',roomReady:true,termsConfirmed:true,boundary:{state:'VERIFIED',readings:[]},creationOptions:{}})).toMatchObject(signing);
    expect(mocked.rpc).toHaveBeenCalledTimes(1);expect(mocked.render).not.toHaveBeenCalled();
  });
  it('renders only the hashed template snapshot with the assigned number and registers one immutable file',async()=>{
    mocked.download.mockResolvedValue({data:template,error:null});mocked.render.mockResolvedValue(official);mocked.upload.mockResolvedValue({error:null});
    mocked.rpc.mockResolvedValue({data:{...signing,official_document_sha256:await hash(official)},error:null});
    expect((await getOrCreateSignedContractDocument(signing)).blob).toBe(official);
    expect(mocked.render).toHaveBeenCalledWith(expect.any(ArrayBuffer),{CONTRACT_NUMBER:'HD-2026-00001'});
    expect(mocked.upload).toHaveBeenCalledWith(signing.official_document_path,official,expect.objectContaining({upsert:false}));
    expect(mocked.rpc.mock.calls[0][0]).toBe('register_contract_signed_document_v1');
  });
  it('keeps signing intact when rendering fails and retries only artifact creation',async()=>{
    mocked.download.mockResolvedValue({data:template,error:null});mocked.render.mockRejectedValue(new Error('Render failed'));
    await expect(getOrCreateSignedContractDocument(signing)).rejects.toThrow('Render failed');expect(mocked.rpc).not.toHaveBeenCalled();
    mocked.render.mockResolvedValue(official);mocked.upload.mockResolvedValue({error:null});mocked.rpc.mockResolvedValue({data:{...signing,official_document_sha256:await hash(official)},error:null});
    await getOrCreateSignedContractDocument(signing);expect(mocked.rpc).not.toHaveBeenCalledWith('sign_and_checkin_contract_draft_v1',expect.anything());
  });
  it('adopts the exact uploaded file on retry after an upload timeout, without replacement',async()=>{
    mocked.download.mockResolvedValueOnce({data:template,error:null}).mockResolvedValueOnce({data:official,error:null});
    mocked.render.mockResolvedValue(new Blob(['second renderer bytes']));mocked.upload.mockResolvedValue({error:{statusCode:'409',message:'Already exists'}});mocked.rpc.mockResolvedValue({data:{...signing,official_document_sha256:await hash(official)},error:null});
    expect((await getOrCreateSignedContractDocument(signing)).blob).toBe(official);
    expect(mocked.upload).toHaveBeenCalledTimes(1);expect(mocked.rpc.mock.calls[0][1].p_document_sha256).toBe(await hash(official));
  });
  it('rejects corrupted template/document bytes and downloads registered official bytes without re-render',async()=>{
    mocked.download.mockResolvedValue({data:new Blob(['wrong']),error:null});await expect(getOrCreateSignedContractDocument(signing)).rejects.toThrow(/snapshot/);
    const saved={...signing,official_document_sha256:await hash(official)};mocked.download.mockResolvedValue({data:official,error:null});expect((await getOrCreateSignedContractDocument(saved)).blob).toBe(official);expect(mocked.render).not.toHaveBeenCalled();
    mocked.download.mockResolvedValue({data:template,error:null});await expect(getOrCreateSignedContractDocument(saved)).rejects.toThrow(/hash/);
  });
});

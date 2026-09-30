import { describe, expect, it } from 'vitest';
import { assertImportedContractRelations } from '../contractImportOutcome';

describe('imported contract relation outcome', () => {
  it('keeps the created contract ID when customer link fails', () => {
    expect(() => assertImportedContractRelations('contract-17', new Error('offline'), null))
      .toThrow('Hợp đồng contract-17 đã tạo, nhưng chưa liên kết khách hàng. Kiểm tra bản ghi này trước khi nhập lại.');
  });
  it('keeps the created contract ID when room update fails', () => {
    expect(() => assertImportedContractRelations('contract-18', null, new Error('offline')))
      .toThrow('Hợp đồng contract-18 đã tạo, nhưng chưa cập nhật phòng. Kiểm tra bản ghi này trước khi nhập lại.');
  });
  it('accepts both linked relations', () => {
    expect(() => assertImportedContractRelations('contract-19', null, null)).not.toThrow();
  });
});

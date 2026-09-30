/** A contract insert may already have committed when a later relation write fails. */
export function assertImportedContractRelations(
  contractId: string,
  customerLinkError: unknown,
  roomUpdateError: unknown,
): void {
  if (customerLinkError) throw new Error(`Hợp đồng ${contractId} đã tạo, nhưng chưa liên kết khách hàng. Kiểm tra bản ghi này trước khi nhập lại.`);
  if (roomUpdateError) throw new Error(`Hợp đồng ${contractId} đã tạo, nhưng chưa cập nhật phòng. Kiểm tra bản ghi này trước khi nhập lại.`);
}

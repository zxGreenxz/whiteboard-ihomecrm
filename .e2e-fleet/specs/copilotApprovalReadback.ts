type GoiRpc = (
  jwt: string, ten: string, args: unknown,
) => Promise<{ status: number; body: unknown }>;

function laHoSo(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

/** RLS không cấp đọc bảng approval_requests; dùng danh sách chính thức của maker. */
export async function docHoSoChoDuyet(
  goiRpc: GoiRpc, jwt: string, voucherId: string,
): Promise<Record<string, unknown>[]> {
  const kq = await goiRpc(jwt, 'list_my_pending_approvals_compat_v2', {});
  if (kq.status !== 200 || !Array.isArray(kq.body) || !kq.body.every((row) =>
    laHoSo(row) && typeof row.id === 'string' && typeof row.subject_id === 'string'
      && typeof row.subject_type === 'string' && row.state === 'PENDING_APPROVAL'
  )) {
    throw new Error(`Không đọc được danh sách hồ sơ chờ duyệt (HTTP ${kq.status}).`);
  }
  return kq.body.filter((row) =>
    row.subject_type === 'FINANCIAL_VOUCHER' && row.subject_id === voucherId
  );
}

/** Đọc cả trạng thái cuối; danh sách pending không thể chứng minh chưa POSTED. */
export async function docChiTietHoSo(
  goiRpc: GoiRpc, jwt: string, requestId: string,
): Promise<Record<string, unknown>> {
  const kq = await goiRpc(jwt, 'get_approval_request_detail_compat_v2', {
    p_request_id: requestId,
  });
  if (kq.status !== 200 || !laHoSo(kq.body)) {
    throw new Error(`Không đọc được chi tiết hồ sơ duyệt (HTTP ${kq.status}).`);
  }
  return kq.body;
}

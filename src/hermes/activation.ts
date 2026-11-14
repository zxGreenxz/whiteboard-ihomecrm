import type { HermesConnectionMetadata, HermesConnectionStatus, HermesConnectorStatus } from './connectionClient';
import type { HermesZaloBinding } from './zaloBindingClient';

/** Bước 6 "Trợ lý được kích hoạt" dựa trên BẰNG CHỨNG, không dựa vào hàng chờ đồng bộ.
 *
 * Hàng chờ (`provisioningState`) chỉ đổi khi máy chủ có bật bộ đồng bộ hồ sơ trợ lý, và ngay cả khi bật nó cũng dừng ở
 * `restart_pending`: không có mã nào ghi `synchronized` (xem infra/hermes-runtime/HOST_SERVICE.md). Nơi quản trị cài kết
 * nối bằng tay (production) thì hàng chờ đứng mãi ở `pending`. Vì vậy "đã kích hoạt" ở đây nghĩa là: dịch vụ kết nối CRM
 * đã thấy trợ lý gọi được CRM bằng đúng kết nối đang ghép với nick Zalo, kể từ lần chạy gần nhất của dịch vụ.
 * Số liệu đó nằm trong bộ nhớ dịch vụ: vắng mặt chỉ là "chưa thấy", không phải bằng chứng trợ lý hỏng.
 * Hàm thuần: chỉ đọc dữ liệu trang đã có, không gọi máy chủ, không quyết định quyền. */
export interface HermesActivation {
  /** Bước 6 xong: trợ lý đã dùng kết nối đang ghép, hoặc máy chủ báo đã đồng bộ. */
  done: boolean;
  /** Đang chờ phía trợ lý (người dùng không có việc gì để làm trên trang): trang nên tự kiểm lại.
   * false khi đã xong hoặc khi bước tiếp theo là một thao tác của người dùng trên trang. */
  waiting: boolean;
  /** Câu ở thẻ bước 6. */
  summary: string;
  /** Câu ngắn dưới dòng nick Zalo đã liên kết; null khi chưa liên kết. */
  note: string | null;
}

interface Input {
  /** Kết nối đang ghép với nick Zalo; null khi chưa liên kết. */
  linkedConnectionId: string | null;
  provisioningState: HermesZaloBinding['provisioningState'] | null;
  connections: readonly HermesConnectionMetadata[];
  status: HermesConnectorStatus | null;
  name: (connectionId: string) => string;
  shortId: (connectionId: string) => string;
  time: (value: number) => string;
}

/** Lần gọi CRM thành công còn giá trị: sau đó không bị từ chối vì kết nối hết hạn hay bị thu hồi.
 * Cùng một mốc thời gian thì không biết cái nào sau: coi như đã bị từ chối, không nhận là đang chạy. */
function usedAt(activity: HermesConnectionStatus | undefined) {
  if (!activity || activity.lastSuccessAt === null) return null;
  return activity.lastErrorCode === 'unauthorized' && activity.lastErrorAt !== null && activity.lastErrorAt >= activity.lastSuccessAt
    ? null : activity.lastSuccessAt;
}

export function hermesActivation({ linkedConnectionId, provisioningState, connections, status, name, shortId, time }: Input): HermesActivation {
  const activity = (id: string) => status?.connections.find(item => item.id === id);
  const inUse = connections.filter(connection => connection.state === 'active' && connection.id !== linkedConnectionId)
    .map(connection => ({ id: connection.id, at: usedAt(activity(connection.id)) }))
    .filter((item): item is { id: string; at: number } => item.at !== null)
    .sort((left, right) => right.at - left.at)[0] ?? null;

  if (linkedConnectionId === null) {
    return { done: false, waiting: false, note: null, summary: inUse
      ? `Trợ lý đã gọi được CRM bằng ${name(inUse.id)} lúc ${time(inUse.at)}. Liên kết Zalo ở bước 3 để nhắn trợ lý qua bot của công ty.`
      : 'Tự chạy sau khi bạn liên kết Zalo.' };
  }
  // Số liệu dịch vụ kết nối về cùng lượt với danh sách kết nối. Chưa có (đang tải lại, hoặc vừa đổi chính sách công ty) thì
  // danh sách cũng trống: không được suy ra "kết nối đã ngắt" hay "chưa thấy" từ một danh sách chưa đọc.
  if (!status) return { done: false, waiting: true, note: 'Chưa đọc được trạng thái trợ lý.',
    summary: 'Chưa đọc được trạng thái dịch vụ kết nối CRM nên chưa biết trợ lý đã chạy chưa.' };
  // Kết nối đang ghép phải còn hiệu lực trong danh sách của chính người dùng. Kết nối đã ngắt thì trợ lý không dùng được nữa,
  // dù trước khi ngắt nó từng gọi được: dịch vụ kết nối từ chối token đã thu hồi trước khi biết đó là kết nối nào, nên
  // không ghi lỗi cho kết nối và số liệu "lần cuối thành công" cũ còn nguyên. Không được coi số liệu đó là bằng chứng.
  if (!connections.some(connection => connection.id === linkedConnectionId && connection.state === 'active')) {
    return { done: false, waiting: false, note: 'Kết nối đang ghép không còn dùng được. Xem bước 6.', summary: inUse
      ? `Kết nối đang ghép với nick Zalo đã ngắt hoặc chưa hoàn tất. Trợ lý đang chạy bằng ${name(inUse.id)} (mã …${shortId(inUse.id)}): ở bước 3, chọn kết nối đó rồi bấm “Dùng kết nối này cho trợ lý”.`
      : 'Kết nối đang ghép với nick Zalo đã ngắt hoặc chưa hoàn tất nên trợ lý không dùng được CRM. Tạo kết nối mới ở bước 2 nếu chưa có, rồi bấm “Dùng kết nối này cho trợ lý” ở bước 3.' };
  }
  const linked = activity(linkedConnectionId), at = usedAt(linked);
  const rejectedAt = linked && linked.lastErrorCode === 'unauthorized' ? linked.lastErrorAt : null;
  if (at !== null) return { done: true, waiting: false, note: 'Trợ lý đang dùng kết nối này.',
    summary: `Trợ lý đang dùng kết nối này. Lần gần nhất gọi CRM: ${time(at)}.` };
  // Máy chủ báo đã đồng bộ thì tin, trừ khi dịch vụ kết nối đã từ chối chính kết nối này.
  if (provisioningState === 'synchronized' && rejectedAt === null) return { done: true, waiting: false, note: 'Đã đồng bộ với trợ lý.', summary: 'Trợ lý đã sẵn sàng.' };
  // Chỉ sang kết nối khác khi đó là dấu vết MỚI NHẤT của trợ lý; nếu sau đó trợ lý đã trình kết nối đang ghép và bị từ chối thì nói việc bị từ chối.
  if (inUse && (rejectedAt === null || rejectedAt <= inUse.at)) return { done: false, waiting: false, note: 'Trợ lý đang chạy bằng kết nối khác. Xem bước 6.',
    summary: `Trợ lý đang chạy bằng ${name(inUse.id)} (mã …${shortId(inUse.id)}), không phải kết nối đang ghép với nick Zalo. Ở bước 3, chọn kết nối đó rồi bấm “Dùng kết nối này cho trợ lý”.` };
  if (rejectedAt !== null) return { done: false, waiting: true,
    note: 'Trợ lý bị từ chối khi dùng kết nối này. Xem bước 6.',
    summary: `Trợ lý bị từ chối khi dùng kết nối này lúc ${time(rejectedAt)}: kết nối hết hạn hoặc đã bị thu hồi. Nếu vài phút nữa vẫn vậy, tạo kết nối mới ở bước 2 rồi chọn nó cho trợ lý ở bước 3.` };
  if (provisioningState === 'pending_credential') return { done: false, waiting: true, note: 'Đang chờ kết nối CRM của trợ lý.',
    summary: 'Trợ lý chưa nhận được kết nối CRM. Kiểm tra bước 2, rồi bấm “Dùng kết nối này cho trợ lý” ở bước 3 nếu có.' };
  if (provisioningState === 'restart_pending') return { done: false, waiting: true, note: 'Đang chờ quản trị viên kích hoạt trợ lý.',
    summary: 'Đang chờ quản trị viên kích hoạt trợ lý.' };
  if (provisioningState === 'unavailable') return { done: false, waiting: true, note: 'Chưa đồng bộ được với trợ lý. Hệ thống sẽ thử lại.',
    summary: 'Chưa đồng bộ được với trợ lý. Hệ thống sẽ tự thử lại.' };
  return { done: false, waiting: true, note: 'Chưa thấy trợ lý dùng kết nối này. Xem bước 6.',
    summary: `Chưa thấy trợ lý dùng kết nối này kể từ khi dịch vụ kết nối CRM chạy lại lúc ${time(status.connector.startedAt)}. Nếu bạn vừa liên kết, nhờ quản trị viên kích hoạt trợ lý; nếu trợ lý đã chạy, nhắn thử bot trên Zalo.` };
}

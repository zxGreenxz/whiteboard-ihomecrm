const labels: Record<string, string> = {
  ABNORMAL_INCREASE: 'Mức dùng điện tăng bất thường; đối chiếu lại và ghi lý do',
  BASELINE_UNAVAILABLE: 'Chưa đủ lịch sử để kiểm tra mức tăng; cần đối chiếu và ghi lý do',
  DUPLICATE_MEDIA: 'Ảnh/clip này đã được dùng ở lượt khác; cần kiểm tra lại',
  WORKER_LEASE_EXHAUSTED: 'Bộ đọc bị gián đoạn nhiều lần; cần kiểm tra hoặc gửi lượt mới',
  insufficient_retained_evidence: 'Chưa giữ đủ khung hình chứng minh kết quả đọc',
  MEDIA_VALIDATION_FAILED: 'Ảnh/clip chưa qua kiểm tra định dạng hoặc thời lượng',
  IDENTITY_UNVERIFIED: 'Chưa xác minh chắc chắn đúng đồng hồ',
  ENGINE_INCOMPLETE: 'Chưa đủ kết quả từ hai bộ đọc',
  WRONG_REGISTER_OR_VALUE: 'Chưa xác định đúng thanh ghi hoặc chỉ số',
  DECIMAL_MISMATCH: 'Phần thập phân không khớp cấu hình đồng hồ',
  INSUFFICIENT_CLEAR_FRAMES: 'Chưa có đủ khung hình rõ để đối chiếu',
  ENGINE_DISAGREEMENT: 'Hai bộ đọc trả chỉ số khác nhau',
  LATE_READING_REQUIRES_REVIEW: 'Kết quả đọc bổ sung khác số đã chốt; cần đối chiếu lại',
  identity_requires_review: 'Cần đối chiếu QR, serial và đúng một đồng hồ',
  readers_disagree: 'Hai bộ đọc trả chỉ số khác nhau',
  server_reader_error: 'Bộ đọc server chưa xử lý được ảnh',
  ai_reader_error: 'Bộ đọc AI chưa xử lý được ảnh',
  server_time_budget_exhausted: 'OCR chưa đọc đủ khung hình trong thời gian xử lý; cần đối chiếu',
  ai_time_budget_exhausted: 'AI chưa trả kết quả trong thời gian xử lý; cần đối chiếu',
  recognition_time_budget_exhausted: 'Chưa đủ thời gian kiểm thêm khung hình; cần đối chiếu ảnh hoặc quay lại',
  recognition_timeout: 'Xử lý clip quá thời gian; thử clip ngắn hơn, rõ một đồng hồ',
  media_decoder_failed: 'Không giải mã được ảnh/clip; chụp hoặc quay lại',
  unsupported_media: 'Định dạng ảnh/clip chưa được hỗ trợ',
  video_duration_limit: 'Clip vượt giới hạn thời lượng',
  media_dimensions_limit: 'Kích thước ảnh/clip vượt giới hạn xử lý',
  media_size_limit: 'Dung lượng tệp vượt giới hạn',
  no_decodable_frames: 'Không tìm thấy khung hình đọc được',
  worker_processing_failed: 'Xử lý ảnh bị gián đoạn; cần kiểm tra lại',
};

export function captureIssueLabel(issue: string): string {
  if (labels[issue]) return labels[issue];
  const reader = issue.startsWith('server_') ? 'Server' : issue.startsWith('ai_') ? 'AI' : null;
  const suffix = issue.replace(/^(server|ai)_/, '');
  const detail: Record<string, string> = { unreadable: 'chưa đọc rõ mặt số', different_values_or_registers: 'có nhiều giá trị hoặc thanh ghi khác nhau', insufficient_stable_frames: 'chưa có hai khung hình ổn định' };
  if (reader && detail[suffix]) return `${reader}: ${detail[suffix]}`;
  return /^[a-z_]+$/i.test(issue) ? 'Cần kiểm tra lại ảnh/clip và cấu hình đồng hồ' : issue;
}

export function captureReaderStatus(status?: string): string {
  return status === 'ok' || status === 'read' ? 'Đã đọc' : status === 'error' || status === 'failed' ? 'Chưa đọc được' : status ? 'Cần xem lại' : 'Đang chờ';
}

// Helper map raw Supabase/Postgres errors → message tiếng Việt thân thiện người dùng.
// Dùng kèm sonner toast: toast.error(title, { description }).

export interface FriendlyError {
  title: string;
  description: string;
}

const POSTGRES_CODE_MAP: Record<string, FriendlyError> = {
  // Constraint violations
  '23503': {
    title: 'Dữ liệu liên kết không tồn tại',
    description: 'Một thông tin tham chiếu (phòng, khách, dịch vụ, sổ quỹ…) không còn trên hệ thống. Vui lòng kiểm tra lại.',
  },
  '23505': {
    title: 'Trùng dữ liệu',
    description: 'Bản ghi này đã tồn tại. Vui lòng kiểm tra danh sách hiện có.',
  },
  '23502': {
    title: 'Thiếu thông tin bắt buộc',
    description: 'Một số trường bắt buộc đang trống. Vui lòng nhập đầy đủ rồi thử lại.',
  },
  '23514': {
    title: 'Giá trị không thoả ràng buộc',
    description: 'Một trường có giá trị nằm ngoài khoảng cho phép (vd: số tiền âm, ngày trong tương lai…).',
  },
  // Type / format errors
  '22P02': {
    title: 'Giá trị không hợp lệ',
    description: 'Một trường có định dạng không đúng. Vui lòng nhập lại.',
  },
  '22001': {
    title: 'Dữ liệu quá dài',
    description: 'Một trường có giá trị vượt độ dài cho phép. Vui lòng rút gọn.',
  },
  '22003': {
    title: 'Số quá lớn',
    description: 'Giá trị số vượt quá phạm vi cho phép.',
  },
  // Schema / function errors (= cần reload trang)
  '42703': {
    title: 'Hệ thống đang được cập nhật',
    description: 'Vui lòng tải lại trang (F5) rồi thử lại. Nếu lỗi tiếp tục, liên hệ quản trị viên.',
  },
  '42P01': {
    title: 'Hệ thống đang được cập nhật',
    description: 'Vui lòng tải lại trang (F5) rồi thử lại.',
  },
  '42883': {
    title: 'Hệ thống đang được cập nhật',
    description: 'Vui lòng tải lại trang (F5) rồi thử lại.',
  },
  '42601': {
    title: 'Hệ thống đang được cập nhật',
    description: 'Vui lòng tải lại trang (F5).',
  },
  // Permission
  '42501': {
    title: 'Không đủ quyền',
    description: 'Tài khoản của bạn chưa được cấp quyền cho thao tác này. Vui lòng liên hệ quản trị viên.',
  },
  // Network / timeout
  'PGRST116': {
    title: 'Không tìm thấy dữ liệu',
    description: 'Bản ghi không tồn tại hoặc bạn không có quyền xem.',
  },
};

/**
 * Convert raw error → friendly { title, description }.
 *
 * @param error Supabase error / generic Error / unknown
 * @param fallbackTitle Title mặc định khi không nhận diện được code (vd: "Không lưu được hợp đồng")
 */
export function friendlyError(error: any, fallbackTitle = 'Có lỗi xảy ra'): FriendlyError {
  if (!error) {
    return { title: fallbackTitle, description: 'Vui lòng thử lại.' };
  }

  const code = String(error?.code ?? '').trim();
  const msg = String(error?.message ?? '').toLowerCase();

  if (code && POSTGRES_CODE_MAP[code]) {
    return POSTGRES_CODE_MAP[code];
  }

  // Heuristic match by message
  if (msg.includes('permission denied') || msg.includes('policy') || msg.includes('row-level security')) {
    return POSTGRES_CODE_MAP['42501'];
  }
  if (msg.includes('duplicate key') || msg.includes('already exists')) {
    return POSTGRES_CODE_MAP['23505'];
  }
  if (msg.includes('foreign key') || msg.includes('referenced')) {
    return POSTGRES_CODE_MAP['23503'];
  }
  if (msg.includes('not null') || msg.includes('null value')) {
    return POSTGRES_CODE_MAP['23502'];
  }
  if (msg.includes('does not exist') || msg.includes('schema cache')) {
    return POSTGRES_CODE_MAP['42P01'];
  }
  if (msg.includes('jwt') || msg.includes('unauthorized') || msg.includes('not authenticated')) {
    return {
      title: 'Phiên đăng nhập hết hạn',
      description: 'Vui lòng đăng nhập lại để tiếp tục.',
    };
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return {
      title: 'Không kết nối được máy chủ',
      description: 'Vui lòng kiểm tra kết nối mạng rồi thử lại.',
    };
  }

  return {
    title: fallbackTitle,
    description: 'Vui lòng thử lại. Nếu lỗi tiếp tục, liên hệ quản trị viên.',
  };
}

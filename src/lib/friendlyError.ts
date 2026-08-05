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
 * 42501 do CHÍNH Postgres sinh (RLS chặn / thiếu GRANT) — user không tự sửa
 * được, chỉ báo chung "liên hệ quản trị viên".
 *
 * KHÁC với 42501 do RPC nghiệp vụ của mình `RAISE EXCEPTION ... ERRCODE 42501`:
 * các message đó ("Sổ quỹ cọc không thuộc tổ chức", "Khách hàng không thuộc tổ
 * chức", "Không có quyền ghi tiền cọc vào sổ đã chọn"…) nói đúng chỗ sai và user
 * sửa được ngay. Nuốt chúng vào "Tài khoản của bạn chưa được cấp quyền" là đánh
 * lừa — án lệ 27/07/2026: joey chọn nhầm sổ ảo khi tạo HĐ, toast báo thiếu
 * quyền, mất nửa ngày dò phân quyền trong khi chỉ cần đổi sổ quỹ.
 */
const RAW_PG_PERMISSION_MESSAGE =
  /permission denied|row-level security|must be owner|insufficient privilege/;

/**
 * 55000 cũng có hai nguồn như 42501, và cùng một cách xử lý:
 *
 * - Nghiệp vụ: RPC của mình `RAISE … ERRCODE 55000` kèm câu tiếng Việt nói
 *   đúng chỗ sai ("Phiếu cọc được chọn không hợp lệ hoặc đã được dùng", "Số
 *   tiền cọc phải lớn hơn 0"…) → đưa thẳng ra cho user.
 * - Nội bộ: guard phiếu canonical (app_private.guard_income_expense_owned_payload
 *   và các cửa flex-writer của nó) ném tiếng Anh "is frozen (update rejected)"
 *   / "scope may only change…". User không làm gì được với câu đó.
 *
 * Án lệ 05/08/2026: cửa LINK_CONTRACT của guard bị một đợt vá sau xoá mất, mọi
 * hợp đồng ký trên phòng "Đã cọc" chết 55000 — nhưng toast chỉ hiện "Không lưu
 * được hợp đồng. Vui lòng thử lại", không một dấu vết nào để lần ra.
 */
const INTERNAL_GUARD_MESSAGE =
  /is frozen|scope may only|authorized transition may only|canonical income expense/i;

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
  const rawMsg = String(error?.message ?? '').trim();
  const msg = rawMsg.toLowerCase();

  if (code === '42501' && rawMsg && !RAW_PG_PERMISSION_MESSAGE.test(msg)) {
    return { title: fallbackTitle, description: rawMsg };
  }

  if (code === '55000' && rawMsg) {
    if (INTERNAL_GUARD_MESSAGE.test(rawMsg)) {
      return {
        title: 'Thao tác bị khoá bởi hệ thống kế toán',
        description:
          'Một phiếu liên quan đang bị khoá nên thao tác không hoàn tất. Vui lòng tải lại trang rồi thử lại; nếu vẫn lỗi, báo quản trị viên (mã 55000).',
      };
    }
    return { title: fallbackTitle, description: rawMsg };
  }

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

import type { OperationErrorRule } from './friendlyError';

// Reviewed RPC reasons: sua_phieu_cho_duyet (20260925080906), ie_annotate_v1
// (20260730120000), wp1_evidence_protection (20260801000000). This list must
// not accept arbitrary Vietnamese strings: messages can also contain SQL.
export const VOUCHER_ERROR_RULES: readonly OperationErrorRule[] = [
  ...([
    ['Tên phiếu không được trống','name','Nhập tên phiếu.'],
    ['Tên phiếu vượt quá 500 ký tự','name','Tên phiếu tối đa 500 ký tự.'],
    ['Tên người nộp/nhận vượt quá 255 ký tự','payer_name','Tên người nộp/nhận tối đa 255 ký tự.'],
    ['Số tài khoản nhận vượt quá 255 ký tự','receive_bank_account','Số tài khoản nhận tối đa 255 ký tự.'],
    ['Tên ngân hàng nhận vượt quá 255 ký tự','receive_bank_name','Tên ngân hàng nhận tối đa 255 ký tự.'],
    ['Toà nhà không thuộc tổ chức của phiếu','building_id','Chọn toà nhà thuộc công ty của phiếu.'],
    ['Phòng không thuộc toà/tổ chức của phiếu','room_id','Chọn phòng thuộc toà nhà đã chọn.'],
    ['Sổ quỹ không thuộc tổ chức của phiếu','account_id','Chọn sổ quỹ thuộc công ty của phiếu.'],
    ['Không có quyền sử dụng sổ quỹ này','account_id','Không có quyền sử dụng sổ quỹ này. Chọn sổ quỹ bạn có quyền sử dụng.'],
  ] as const).map(([message,field,description])=>({message,description,fieldErrors:{[field]:description}})),
  ...([
    'Lý do sửa tối đa 1000 ký tự', 'Phiếu đã ghi sổ — không sửa ở đây',
    'Phiếu thuộc luồng hệ thống — sửa ở luồng gốc',
    'Phiếu gắn hoá đơn/khoản thu — sửa ở màn hoá đơn',
    'Phiếu lương / chia lợi nhuận — sửa ở luồng gốc',
    'Phiếu nằm trong phiên bàn giao tiền mặt — không sửa được',
    'Phiếu đảo của phiếu khác — không sửa được',
    'Phiếu chứa hạng mục hạn chế — không có quyền sửa',
    'Tên phiếu không được trống', 'Tên phiếu vượt quá 500 ký tự',
    'Tên người nộp/nhận vượt quá 255 ký tự', 'Số tài khoản nhận vượt quá 255 ký tự',
    'Tên ngân hàng nhận vượt quá 255 ký tự', 'Ghi chú vượt quá 5000 ký tự',
    'Toà nhà không thuộc tổ chức của phiếu', 'Phòng không thuộc toà/tổ chức của phiếu',
    'Khách thuê không thuộc tổ chức của phiếu', 'Hợp đồng không thuộc toà/tổ chức của phiếu',
    'Hợp đồng không khớp phòng của phiếu', 'Hợp đồng không khớp khách thuê của phiếu',
    'Khách thuê không thuộc hợp đồng', 'Bạn không còn quyền lập phiếu thu chi ở toà này',
    'Chỉ người lập phiếu hoặc người có quyền sửa thu chi ở toà này mới sửa được',
    'Không có quyền sửa thu chi ở toà mới', 'Sổ quỹ không thuộc tổ chức của phiếu',
    'Không có quyền sử dụng sổ quỹ này', 'Phiếu phải có từ 1 đến 200 hạng mục',
    'Đổi Thu/Chi phải chọn lại hạng mục cho đúng chiều', 'Tổng tiền phiếu vượt giới hạn',
    'Đổi số tiền, hạng mục, loại, sổ quỹ hoặc toà phải ghi lý do (ít nhất 8 ký tự).',
    'Chỉ người có quyền sửa thu chi mới gỡ được ảnh chứng từ',
    'Phiếu đã huỷ — không thể duyệt',
  ] as const).map(message => ({message, description:message})),
  {code:'42501',message:'Chưa đăng nhập',description:'Đăng nhập lại để tiếp tục. Thông tin đang nhập vẫn được giữ.',recovery:'sign-in'},
  {code:'P0002',message:'Phiếu không tồn tại',description:'Không tìm thấy phiếu trong phạm vi bạn được xem. Tải lại danh sách để kiểm tra.'},
  {code:'22023',message:'Thiếu toà nhà',description:'Chọn toà nhà cho phiếu.',fieldErrors:{building_id:'Chọn toà nhà cho phiếu.'}},
  {code:'22023',message:'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31',description:'Ngày phiếu phải từ 01/01/2000 đến 31/12/2100.',fieldErrors:{voucher_date:'Ngày phiếu phải từ 01/01/2000 đến 31/12/2100.'}},
  {message:/^Chỉ sửa được phiếu Chờ duyệt — phiếu này đang ở trạng thái /,description:'Phiếu không còn ở trạng thái Chờ duyệt. Giữ thông tin đang nhập và tải lại phiếu để kiểm tra.'},
  {message:/^Phiếu do hệ thống sinh \(.+\) — sửa ở luồng gốc$/,description:'Phiếu được tạo từ một nghiệp vụ khác. Mở nghiệp vụ gốc để thay đổi.'},
  {message:/^Thiếu phiếu hoặc phiên bản phiếu đang xem$|^idempotency_key phải dài /,description:'Thông tin phiếu chưa đầy đủ. Đóng hộp thoại và tải lại phiếu trước khi tiếp tục.'},
];

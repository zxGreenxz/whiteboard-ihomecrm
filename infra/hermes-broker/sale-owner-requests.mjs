// Synthetic resolved inputs for deterministic tool/SQL boundary acceptance.
// These are NOT claims of natural-language model understanding or live writes.
const id = c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const roomId=id('b'),requestId=id('f'),reservationId=id('9');
const patch={requestId,roomId,expectedRevision:'a'.repeat(32)};
const receipt={amount:2000000,accountId:null,voucherDate:'2026-10-21',name:null,description:null};
const create={requestId,roomId,customerId:null,customerHint:'Khách An',intendedMoveInOn:null,topupDueOn:null,depositTarget:3000000,notes:null,receipt};
const cases=[
 ['H01','Chủ trọ','Tìm phòng 101 thuộc tòa tôi được sửa.','options',{action:'rooms.edit',buildingId:null,query:'P101',limit:20,cursor:null},'Một nhãn phòng đúng phạm vi'],
 ['H02','Sale','Cho tôi sửa phòng ở tòa ngoài phạm vi được giao.','options',{action:'rooms.edit',buildingId:id('8'),query:'',limit:20,cursor:null},'Từ chối phạm vi'],
 ['H03','Quản lý','Đổi giá phòng 101 thành 3.100.000 đồng theo bản vừa mở.','patch',{...patch,rent_price:3100000},'Ghi đúng canonical writer một lần'],
 ['H04','Quản lý','Lưu giá theo bản phòng đã cũ.','patch',{...patch,expectedRevision:'b'.repeat(32),rent_price:3100000},'Từ chối revision cũ, không ghi'],
 ['H05','Chủ công ty','Đăng chính sách mới: Wifi miễn phí.','patch',{...patch,sale_note:'Wifi miễn phí'},'Preview chữ công khai, chưa ghi'],
 ['H06','Chủ công ty','Tôi đồng ý nguyên văn bản chính sách vừa xem.','patch',{...patch,sale_note:'Wifi miễn phí'},'Token đúng được ghi, token một lần'],
 ['H07','Sale Admin','Dùng xác nhận cũ nhưng đổi chính sách thành miễn tiền điện.','patch',{...patch,sale_note:'Miễn tiền điện'},'Từ chối token không khớp nội dung'],
 ['H08','Sale Admin','Ghi thưởng sale 500.000 đồng vào ghi chú nội bộ.','patch',{...patch,sale_bonus_note:'Thưởng sale 500.000 đồng'},'Ghi trường nội bộ khi có rooms.edit'],
 ['H09','Sale','Tôi chỉ được quản lý ảnh; thay ảnh phòng đã tải lên.','patch',{...patch,images:['https://example.invalid/new.jpg']},'Images-only được ghi trong scope'],
 ['H10','Sale','Tôi chỉ được quản lý ảnh; đổi thêm giá phòng.','patch',{...patch,images:[],rent_price:1},'Từ chối thêm trường vượt quyền'],
 ['H11','Chủ trọ','Lock tạm phòng 101 trong 6 giờ để khách đi xem.','lock',{requestId,roomId,hours:6,note:'Khách hẹn xem'},'Lock không phát sinh phiếu thu'],
 ['H12','Sale','Lock phòng 101 trong 48 giờ.','lock',{requestId,roomId,hours:48,note:null},'Từ chối thời lượng ngoài 6/12/24'],
 ['H13','Quản lý','Mạng lỗi lúc lock; gửi lại đúng mã yêu cầu cũ sau ba ngày.','lock',{requestId,roomId,hours:12,note:null},'Biên nhận cũ, không tạo lock lần hai'],
 ['H14','Sale Admin','Giữ mã yêu cầu đã dùng nhưng đổi thời gian lock.','lock',{requestId,roomId,hours:24,note:null},'Từ chối đổi ý định trên cùng requestId'],
 ['H15','Chủ trọ','Kiểm tra mã yêu cầu này đã xử lý chưa.','status',{requestId},'not_found rõ ràng; không tự tạo mã mới'],
 ['H16','Chủ công ty','Đã thu hồi quyền sửa của sale; thử tra lại biên nhận sửa cũ.','status',{requestId},'Tái kiểm quyền và từ chối biên nhận ngoài quyền'],
 ['H17','Sale Admin','Báo cọc 2 triệu cho Khách An, mục tiêu cọc 3 triệu.','reservation_create',create,'APPROVED vẫn received=false nếu chưa nhận; không lộ SĐT'],
 ['H18','Chủ công ty','Cho sale tạo cọc nhưng chưa cấp quyền duyệt qua Hermes.','reservation_create',create,'Không dùng quyền duyệt CRM để vượt overlay Hermes'],
 ['H19','Quản lý','Đổi hạn thu thêm và ghi chú cọc theo phiên bản 1.','reservation_update',{requestId,reservationId,expectedRevision:1,changes:{topup_due_on:'2026-10-25',notes:'Hẹn thu thêm'}},'Chuyển đúng UPDATE và expectedRevision tới canonical'],
 ['H20','Sale Admin','Gắn khách danh bạ vào cọc tên gợi nhớ.','reservation_assign',{requestId,reservationId,expectedRevision:1,customerId:id('2')},'Chuyển đúng khách và revision tới canonical'],
 ['H21','Quản lý','Gỡ lock của phòng vừa giữ cho khách xem.','release',{requestId:id('8'),lockId:requestId},'Gỡ đúng lock ID, trả trạng thái RELEASED'],
 ['H22','Sale Admin','Thu thêm 2 triệu vào cọc hiện tại.','reservation_topup',{requestId,reservationId,expectedRevision:1,receipt},'Dùng TOPUP; không suy diễn đã nhận từ APPROVED'],
 ['H23','Sale','Tôi chỉ có quyền đọc phòng; hãy sửa giá giúp tôi.','patch',{...patch,rent_price:3100000},'Quyền đọc không biến thành quyền ghi'],
 ['H24','Sale','Tôi chỉ được quản lý ảnh; xem giá và thưởng nội bộ trước khi sửa ảnh.','observe',{roomId},'Projection thao tác chỉ có ảnh; thiếu CRM view phải bị inventory chặn'],
];
export const HERMES_OWNER_REQUESTS=Object.freeze(cases.map(([id,role,request,operation,input,expected])=>({
 id,role,request,operation,input,expected,
 fullName:`Hermes owner requests > ${id} | ${role} | ${request}`,
 layer:'Deterministic resolved tool contract + synthetic PostgreSQL fixture; not a natural-language model test',
})));

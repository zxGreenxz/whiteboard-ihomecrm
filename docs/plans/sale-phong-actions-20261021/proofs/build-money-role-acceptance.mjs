import {readFileSync,writeFileSync} from 'node:fs';
const folder='docs/plans/sale-phong-actions-20261021/';
const files=['deposit-lock-implementation-final.json','deposit-lock-sql-final.json'];
const tests=new Map();
for(const file of files){
  for(const suite of JSON.parse(readFileSync(folder+file,'utf8')).testResults){
    for(const test of suite.assertionResults)tests.set(test.fullName,{...test,file:suite.name,evidence:file});
  }
}
const scenarios=[
 ['Chủ trọ','Tôi nhận cọc, thêm cọc, sửa hạn rồi bấm lại yêu cầu cũ: các phiếu phải cùng kỳ hạn, không nhân cọc, bản sửa cũ phải bị chặn.','create, replay, topup, update and old terms writer keep every projection atomic and revisioned'],
 ['Quản lý','Tôi chỉ đổi hạn ký hợp đồng bằng màn hình cũ; hạn bổ sung và cọc cần đủ phải lấy từ hồ sơ đúng, không từ bản chiếu cũ.','old deadline-only RPC preserves canonical topup/target instead of stale legacy projection'],
 ['Quản lý','Khách bổ sung tiền sau ngày hẹn; tôi sửa hạn từ phiếu mới mà vẫn giữ được mốc bổ sung đã quá hạn của hồ sơ.','a linked late topup keeps overdue canonical terms; unlinked voucher date validation remains strict'],
 ['Sale','Tôi được tạo cọc nhưng không được sửa cọc; hệ thống phải chặn tôi sửa kỳ hạn cả phiếu mới lẫn phiếu cũ.','denies deadline edits without deposits.edit, including unlinked legacy vouchers and foreign actors'],
 ['Chủ trọ','Hồ sơ không nhận tiền phải giữ hạn; nếu bước lưu kỳ hạn lỗi thì không được để lại hồ sơ hoặc phiếu thu dang dở.','keeps a reservation with no money deadline; target zero projects as null; failed projection rolls back create'],
 ['Sale','Tôi báo cọc chưa duyệt, không có bút toán vào quỹ: không được coi là đã thu. Phiếu duyệt, quỹ ảo hoặc bút toán đã đảo cũng chưa phải tiền thực nhận.','only counts an actual matching unreversed real-account posting, never approval or draft alone'],
 ['Chủ công ty','Số tiền thực nhận phải theo đúng quyền xem phiếu/quỹ và công ty; người ngoài, khách ẩn danh hoặc danh sách vượt giới hạn phải bị chặn.','reader preserves nonbypass parent RLS, fund-member visibility, org/auth and max200 cap'],
 ['Sale Admin','Tôi chỉ quản lý tòa A: không được lấy mã tin pass tòa B để sửa qua tòa A, và sửa tin không được chuyển sang phòng khác.','pass update checks original listing scope; same-room updates and implicit upsert remain valid'],
 ['Chủ trọ','Khi tôi lock phòng, khách và kênh đăng tin phải ngừng thấy phòng đang bán; nội bộ vẫn xem được ai lock và thời hạn.','hides a locked room from every sale reader and shows lock facts only in-app'],
 ['Quản lý','Chỉ cho lock 6, 12 hoặc 24 giờ khi phòng còn bán và người thao tác có quyền.','accepts only 6/12/24 hours, a permitted user and a room still on sale'],
 ['Sale','Tôi bấm lock hai lần vì mạng chậm: cùng thao tác phải trả cùng lock; lock khác bị chặn, hết hạn thì phòng xuất hiện lại.','replays the same click, refuses a second lock and needs no job to expire'],
 ['Quản lý','Người lock được gỡ lock của mình; người khác chỉ gỡ khi có quyền tạo cọc đúng phạm vi; bấm lại không sinh thao tác khác.','lets the locker or a deposit creator release, idempotently'],
 ['Chủ công ty','Danh sách lock là đường đọc, không tự ghi; người ngoài công ty không đọc được.','lists open locks read-only for the deposits screen and refuses outsiders plainly'],
 ['Chủ trọ','Khi nhận cọc cho phòng đang lock, hồ sơ cọc và việc đóng lock phải xảy ra trong cùng giao dịch.','a reservation on the locked room releases the lock in the same transaction'],
 ['Quản lý','Nếu phòng đã có người thuê qua nghiệp vụ khác, không được vẫn hiển thị là phòng lock đang bán.','does not badge or list a lock on a room that became occupied for another reason'],
 ['Sale Admin','Quyền tạo cọc của tôi chỉ ở tòa A; nút và hộp tạo cọc phải mở đúng tòa A, không mặc định toàn công ty.','shows and opens quick deposit only within deposits.create building scope'],
 ['Sale','Tôi chỉ có quyền cọc cũ của Sale Phòng, chưa có deposits.create: không được mở luồng nhận cọc mới.','legacy sale_phong.create_deposit alone cannot mount a money dialog'],
 ['Chủ công ty','Người đã đăng xuất dù máy còn cache quyền cũng không được mở hộp tạo cọc.','anonymous never sees the quick deposit action even with a cached permission map'],
 ['Chủ công ty','Tôi thu hồi quyền tòa A trong lúc nhân viên mở hộp cọc; lần cập nhật quyền kế tiếp phải đóng quyền thao tác đó.','revoking building authority removes an already opened modal on rerender'],
 ['Chủ trọ','Khách mới báo thêm cọc nhưng phiếu chưa duyệt: cảnh báo thiếu cọc của phiếu đã thu phải còn nguyên.','không cộng cọc khác hoặc chưa thực nhận: {"approval_status":"UNAPPROVED"}'],
 ['Quản lý','Hai hồ sơ khác nhau cùng một phòng không được lấy tiền của hồ sơ này bù thiếu cho hồ sơ kia.','không cộng cọc khác hoặc chưa thực nhận: {"reservation_id":"other-reservation"}'],
 ['Chủ trọ','Phiếu cọc cũ chưa gắn khách/hồ sơ phải tính riêng, không đoán là cùng khách chỉ vì cùng phòng.','legacy trên cùng phòng vẫn tách từng phiếu, không đoán cùng khách'],
 ['Chủ công ty','Tôi có hơn 400 phiếu: phải đọc đủ qua nhiều lượt, bỏ trùng ổn định và không suy phiếu thiếu dữ kiện thành đã thu.','deduplicates, sorts and pages 401 voucher IDs within max200, preserving missing as unknown'],
 ['Quản lý','Nếu lượt đọc tiền thứ hai lỗi, phải báo lỗi thay vì hiện số tổng từ phần dữ liệu tải được.','propagates a failed later page instead of returning partially known money'],
 ['Sale Admin','Tạo giữ chỗ xong không được gọi thêm bước ghi kỳ hạn cũ làm mất thỏa thuận cọc; thưởng Sale vẫn tách riêng đúng phiếu.','kỳ hạn nằm trong một lần tạo giữ chỗ, không gọi writer legacy để ghi đè lần hai'],
 ['Sale','Máy chủ chưa xác nhận tiền vào quỹ thì thông báo phải nói rõ chưa xác nhận, không báo đã thu tiền.','thông báo nhận cọc dùng received=false từ máy chủ'],
];
const rows=scenarios.map(([role,request,title],index)=>{
  const matches=[...tests].filter(([fullName])=>fullName===title||fullName.endsWith(' '+title));
  if(matches.length!==1)throw new Error(`Expected exact single test: ${title}`);
  const [fullName,test]=matches[0];
  return{id:`M${String(index+1).padStart(2,'0')}`,role,request,testFullName:fullName,
    testFile:test.file,status:test.status,evidence:test.evidence};
});
if(rows.some(r=>r.status!=='passed'))throw new Error('Acceptance includes failing tests');
writeFileSync(folder+'MONEY-ROLE-ACCEPTANCE.json',JSON.stringify(rows,null,2)+'\n');
const lines=[
 '# Nghiệm thu vai trò — cọc, lock, kỳ hạn và phạm vi tin pass',
 '',
 '26 yêu cầu dưới đây ánh xạ tới 26 test hành vi khác nhau đã chạy PASS. Vai trò là góc nhìn nghiệp vụ; fixture PGlite giả lập các quyền nền, chưa chứng nhận JWT/role triển khai thật. UI dùng jsdom. Các ca retry/CAS không thay thế kiểm tranh chấp hai phiên PostgreSQL thực.',
 '',
 '| ID | Vai trò | Yêu cầu nghiệm thu | Kết quả | Test fullName / evidence |',
 '|---|---|---|---|---|',
 ...rows.map(r=>`| ${r.id} | ${r.role} | ${r.request} | PASS | ${r.testFullName} — ${r.evidence} |`),
 '',
 'Không có ghi production, kiểm PostgREST hay đối soát tiền thật trong chứng cứ này. Ca phân quyền dữ liệu kiểm RLS thực trên bảng fixture và owner không BYPASSRLS; primitive xác định user/phạm vi là dữ liệu giả lập. Kiểm PostgreSQL thật sẽ có chứng cứ riêng.',
];
writeFileSync(folder+'MONEY-ROLE-ACCEPTANCE.md',lines.join('\n')+'\n');
console.log(`26 role acceptance scenarios passed; ${new Set(rows.map(r=>r.testFullName)).size} distinct test names.`);

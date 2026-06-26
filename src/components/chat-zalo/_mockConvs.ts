// Dữ liệu mock cho Phần 1 (UI/tương tác) — bê nguyên `CONVS` từ design
// `Chat Zalo.dc.html`. Phần 2 sẽ thay bằng hook Supabase mà KHÔNG đổi JSX.
import type { ZaloConversation } from './types';

export const MOCK_CONVS: ZaloConversation[] = [
  {
    id: 'an', name: 'Nguyễn Văn An', initials: 'An', tone: 'emerald', time: '09:42',
    sub: 'Sunrise Home · P.305', subTone: 'emerald', preview: 'Anh chuyển khoản rồi nhé',
    unread: 0, listTag: null, online: false,
    headerTag: { l: 'Đang thuê', t: 'success' },
    headerSub: 'Khách trọ · Sunrise Home P.305 · 0901 234 567', phone: '0901 234 567', day: 'Hôm nay',
    profile: {
      kind: 'tenant', room: 'P.305', roomSub: 'Sunrise Home · Tầng 3 · 28m²', price: '4.500.000₫',
      contractCode: 'HD-2026-0182', contractTerm: '01/2026 – 12/2026 · Cọc 4.500.000₫', contractStatus: 'Hiệu lực',
      debt: { amount: '1.200.000₫', overdue: 'quá hạn 3 ngày', note: 'Hoá đơn T6 · điện nước phát sinh' },
      staff: { name: 'Nguyễn Thị Lan', role: 'Quản lý Sunrise Home', initials: 'Lan', tone: 'purple' },
      tags: [{ l: 'Đã thuê', t: 'success' }, { l: 'Khách thân thiết', t: 'info' }],
    },
    messages: [
      { type: 'sys', text: 'Tự động gửi mẫu "Nhắc đóng tiền" · 08:00' },
      { dir: 'out', text: 'Chào anh An, hoá đơn tiền phòng tháng 6 của P.305 là 4.500.000₫ (đã gồm điện nước). Anh thanh toán giúp em trước 25/06 nhé ạ 🙏', time: '08:00', tick: 'seen' },
      { dir: 'in', text: 'Ok em, để anh chuyển khoản luôn nhé', time: '09:30' },
      { dir: 'in', type: 'image', label: 'Ảnh chuyển khoản.jpg', imgTone: 'neutral', time: '09:41' },
      { dir: 'in', text: 'Anh chuyển 4.500.000₫ rồi nhé, em kiểm tra giúp anh', time: '09:42', react: '❤️' },
      { dir: 'out', text: 'Em nhận được rồi ạ, em xác nhận đã thanh toán đủ tháng 6 ✅ Em cảm ơn anh nhiều!', time: '09:43', tick: 'sent', reply: { name: 'Nguyễn Văn An', text: 'Anh chuyển 4.500.000₫ rồi nhé…' } },
    ],
  },
  {
    id: 'hong', name: 'Trần Thị Hồng', initials: 'Hồ', tone: 'blue', time: '09:15',
    sub: 'Khách hẹn · hỏi P.201', subTone: null, preview: 'Cọc bao nhiêu vậy em?',
    unread: 2, listTag: null, online: true,
    headerTag: { l: 'Lead · Quan tâm', t: 'info' },
    headerSub: 'Nguồn: Facebook Ads · 0977 882 011', phone: '0977 882 011', day: 'Hôm nay',
    profile: {
      kind: 'lead', room: 'P.201', roomSub: 'Sunrise Home · 20m² · có gác lửng', price: '3.800.000₫',
      stage: 'Quan tâm', source: 'Facebook Ads',
      staff: { name: 'Nguyễn Thị Lan', role: 'Tư vấn cho thuê', initials: 'Lan', tone: 'purple' },
      tags: [{ l: 'Lead nóng', t: 'debt' }, { l: 'Quan tâm', t: 'info' }],
    },
    messages: [
      { dir: 'in', text: 'Phòng còn trống không ạ? Em xem trên Facebook thấy phòng đẹp quá 😍', time: '09:12' },
      { dir: 'out', text: 'Dạ còn ạ! P.201 rộng 20m², có gác lửng, giá 3.800.000₫/tháng (chưa gồm điện nước). Chị xem ảnh phòng nhé ạ 👇', time: '09:13', tick: 'seen' },
      { dir: 'out', type: 'image', label: 'P.201 — gác lửng.jpg', imgTone: 'room', time: '09:13', tick: 'seen' },
      { dir: 'in', text: 'Cọc bao nhiêu vậy em? Khi nào mình xem phòng được ạ?', time: '09:15' },
    ],
  },
  {
    id: 'hai', name: 'Hải · Đất Xanh', initials: 'Hả', tone: 'purple', time: '08:58',
    sub: 'Môi giới · CTV', subTone: 'purple', preview: 'Gửi list phòng trống tầng 3 nhé',
    unread: 1, listTag: null, online: false,
    headerTag: { l: 'Môi giới', t: 'purple' },
    headerSub: 'Cộng tác viên môi giới · 0938 555 222', phone: '0938 555 222', day: 'Hôm nay',
    profile: {
      kind: 'broker', company: 'Đất Xanh', phone: '0938 555 222', rooms: 'P.401, P.402, P.405 (Sunrise Home)',
      stats: [{ label: 'Khách g.thiệu', value: '8' }, { label: 'Chốt tháng', value: '3' }, { label: 'Hoa hồng', value: '6,0tr' }],
      tags: [{ l: 'Môi giới', t: 'purple' }, { l: 'CTV', t: 'info' }],
    },
    messages: [
      { type: 'sys', text: 'Tự động · 08:00 — gửi 12 ảnh phòng trống → 8 môi giới' },
      { dir: 'out', type: 'image', label: 'Phòng trống Sunrise (12 ảnh)', imgTone: 'room', time: '08:00', tick: 'seen' },
      { dir: 'out', text: '🏠 Phòng trống Sunrise Home — cập nhật 08:00. Anh tư vấn khách giúp em nhé! P.401 · 3.8tr · P.402 · 4.0tr · P.405 · 4.2tr', time: '08:00', tick: 'seen' },
      { dir: 'in', text: 'Gửi mình list phòng trống tầng 3 nhé, có khách đang hỏi', time: '08:58' },
      { dir: 'out', text: 'Dạ tầng 3 còn P.308 trống, P.305 sắp trả phòng 30/06. Em gửi ảnh chi tiết ngay nhé!', time: '09:00', tick: 'sent' },
    ],
  },
  {
    id: 'quan', name: 'Lê Minh Quân', initials: 'Qu', tone: 'orange', time: 'Hôm qua',
    sub: 'Khách trọ · P.502', subTone: null, preview: 'Ok em',
    unread: 0, listTag: { l: 'Sự cố', t: 'warning' }, online: false,
    headerTag: { l: 'Sự cố', t: 'warning' },
    headerSub: 'Khách trọ · Sunrise Home P.502 · 0912 345 678', phone: '0912 345 678', day: 'Hôm qua',
    profile: {
      kind: 'tenant', room: 'P.502', roomSub: 'Sunrise Home · Tầng 5 · 25m²', price: '4.200.000₫',
      contractCode: 'HD-2026-0144', contractTerm: '03/2026 – 02/2027 · Cọc 4.200.000₫', contractStatus: 'Hiệu lực',
      issue: { text: 'Điều hoà hỏng — đã tạo công việc bảo trì, KTV xử lý sáng mai 9h.' },
      staff: { name: 'Trần Văn Hùng', role: 'KTV bảo trì', initials: 'Hùng', tone: 'slate' },
      tags: [{ l: 'Đang thuê', t: 'success' }, { l: 'Sự cố', t: 'warning' }],
    },
    messages: [
      { dir: 'in', text: 'Điều hoà phòng em (P.502) bị hỏng rồi ạ, bật không thấy mát', time: '20:14' },
      { dir: 'out', text: 'Dạ em ghi nhận sự cố P.502 và đã tạo công việc bảo trì. Em cho thợ qua kiểm tra 9h sáng mai nhé anh?', time: '20:20', tick: 'seen' },
      { dir: 'in', text: 'Ok em', time: '20:21' },
    ],
  },
  {
    id: 'ha', name: 'Phạm Thu Hà', initials: 'Hà', tone: 'rose', time: 'Hôm qua',
    sub: 'Khách trọ · P.A12', subTone: null, preview: 'Vâng em cảm ơn chị',
    unread: 0, listTag: { l: 'Quá hạn', t: 'debt' }, online: false,
    headerTag: { l: 'Quá hạn', t: 'debt' },
    headerSub: 'Khách trọ · Sunrise Home P.A12 · 0987 112 233', phone: '0987 112 233', day: 'Hôm qua',
    profile: {
      kind: 'tenant', room: 'P.A12', roomSub: 'Sunrise Home · Tầng 1 · 22m²', price: '3.500.000₫',
      contractCode: 'HD-2026-0098', contractTerm: '02/2026 – 01/2027 · Cọc 3.500.000₫', contractStatus: 'Hiệu lực',
      debt: { amount: '2.100.000₫', overdue: 'quá hạn 5 ngày', note: 'Hoá đơn T6' },
      staff: { name: 'Nguyễn Thị Lan', role: 'Quản lý Sunrise Home', initials: 'Lan', tone: 'purple' },
      tags: [{ l: 'Đã thuê', t: 'success' }, { l: 'Quá hạn', t: 'debt' }],
    },
    messages: [
      { dir: 'out', text: 'Chào chị Hà, hoá đơn T6 của P.A12 còn 2.100.000₫ chưa thanh toán ạ. Chị sắp xếp giúp em trước cuối tuần nhé.', time: '14:02', tick: 'seen' },
      { dir: 'in', text: 'Vâng em cảm ơn chị, mai chị chuyển nhé', time: '14:10' },
    ],
  },
];

/** Mẫu tin (Thư viện mẫu tin / "/" trong composer). */
export const MOCK_TEMPLATES: { title: string; color: string }[] = [
  { title: 'Nhắc đóng tiền phòng', color: 'hsl(25 95% 53%)' },
  { title: 'Bảng giá & tiện ích phòng', color: 'hsl(152 69% 38%)' },
  { title: 'Xác nhận đặt cọc', color: 'hsl(214 90% 56%)' },
  { title: 'Thông báo chỉ số điện nước', color: 'hsl(271 70% 60%)' },
];

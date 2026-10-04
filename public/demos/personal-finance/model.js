// Dữ liệu mô phỏng hoàn toàn độc lập với tài khoản và sổ sách iHomeCRM.
export const KEY = 'ihome:personal-finance-demo:v1';
export const TODAY = '2026-10-04';
export const fmt = value => new Intl.NumberFormat('vi-VN').format(value) + ' ₫';
export const short = value => Math.abs(value) >= 1e6 ? new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(value / 1e6) + 'tr' : new Intl.NumberFormat('vi-VN').format(value / 1000) + 'k';
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export const id = () => crypto.randomUUID();
const expense = [
  ['food', 'Ăn uống', '🍜', '#efbb72'], ['grocery', 'Thực phẩm', '🛒', '#b6cba1'],
  ['home', 'Nhà cửa', '🏠', '#779d8f'], ['transport', 'Đi lại', '🚕', '#8eafd0'],
  ['shopping', 'Mua sắm', '🛍️', '#c3a0bc'], ['bills', 'Điện, nước & mạng', '💡', '#e7cc73'],
  ['health', 'Sức khỏe', '💊', '#d39793'], ['education', 'Giáo dục', '🎓', '#9d9cc8'],
  ['fun', 'Giải trí', '🎮', '#aaa6d0'], ['travel', 'Du lịch', '✈️', '#8bbdc6'],
  ['beauty', 'Làm đẹp', '💄', '#d9b0c3'], ['sport', 'Thể thao', '⚽', '#a5bd8d'],
  ['pets', 'Thú cưng', '🐾', '#cbb096'], ['electronics', 'Điện tử', '📱', '#99b1b9'],
  ['family', 'Gia đình & quà tặng', '🎁', '#d5ae88'], ['other', 'Chi khác', '🧾', '#adafa7'],
];
const income = [
  ['salary', 'Lương', '💼', '#8bae9c'], ['bonus', 'Thưởng', '🌟', '#e7cc73'],
  ['business', 'Kinh doanh', '🏪', '#9db9c0'], ['invest', 'Lãi & đầu tư', '🌱', '#a5bd8d'],
  ['gift', 'Được tặng', '🎁', '#d9b0c3'], ['refund', 'Hoàn tiền', '↩️', '#9d9cc8'],
  ['other-income', 'Thu khác', '💰', '#adafa7'],
];
export function seed() {
  const row = (i, date, type, amount, category, note, wallet = 'bank') => ({ id:i, date, type, amount, category, note, wallet });
  return {
    version:1,
    categories: [...expense.map(([id,name,emoji,color]) => ({id,name,emoji,color,type:'expense'})), ...income.map(([id,name,emoji,color]) => ({id,name,emoji,color,type:'income'}))],
    wallets: [{id:'bank',name:'Tài khoản ngân hàng',emoji:'🏦',opening:12000000},{id:'cash',name:'Tiền mặt',emoji:'👛',opening:3000000},{id:'saving',name:'Ví tiết kiệm',emoji:'🌱',opening:5000000}],
    transactions: [
      row('t1','2026-10-04','expense',55000,'food','Cà phê cuối tuần','cash'),
      row('t2','2026-10-04','expense',420000,'grocery','Đi chợ cho tuần mới'),
      row('t3','2026-10-03','expense',185000,'food','Ăn tối cùng gia đình'),
      row('t4','2026-10-03','expense',68000,'transport','Grab về nhà','cash'),
      row('t5','2026-10-02','expense',890000,'shopping','Giày chạy bộ'),
      row('t6','2026-10-02','expense',250000,'health','Khám sức khỏe'),
      row('t7','2026-10-01','expense',6000000,'home','Tiền thuê nhà tháng 10'),
      row('t8','2026-10-01','income',25000000,'salary','Lương tháng 10'),
      row('t9','2026-10-01','expense',320000,'bills','Internet & điện thoại'),
      row('s1','2026-09-01','income',25000000,'salary','Lương tháng 9'),
      row('s2','2026-09-01','expense',6000000,'home','Tiền thuê nhà tháng 9'),
      row('s3','2026-09-15','expense',2200000,'food','Ăn uống tháng 9'),
      row('s4','2026-09-20','expense',3800000,'shopping','Mua sắm tháng 9'),
      row('s5','2026-09-28','expense',1800000,'grocery','Thực phẩm tháng 9'),
    ],
    budgets:[{id:'b1',category:'food',amount:3000000},{id:'b2',category:'shopping',amount:1000000},{id:'b3',category:'grocery',amount:2000000}],
    monthlyLimit:15000000,
    goals:[{id:'g1',name:'Quỹ dự phòng',emoji:'🛟',target:30000000,saved:5000000}],
  };
}
export function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY));
    if (parsed?.version === 1 && Array.isArray(parsed.transactions) && Array.isArray(parsed.categories) && Array.isArray(parsed.wallets) && Array.isArray(parsed.budgets) && Array.isArray(parsed.goals)) return parsed;
  } catch { /* Storage bị chặn hoặc dữ liệu demo cũ: mở mẫu trong bộ nhớ. */ }
  return seed();
}
export function persist(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch { return false; }
}
export function monthRows(state, month) { return state.transactions.filter(t => t.date.startsWith(month)); }
export function totals(rows) {
  const income = rows.filter(t => t.type === 'income').reduce((s,t) => s+t.amount,0);
  const expense = rows.filter(t => t.type === 'expense').reduce((s,t) => s+t.amount,0);
  return {income, expense, net:income-expense};
}
export function balance(state, walletId) {
  const opening = state.wallets.find(w => w.id === walletId)?.opening ?? 0;
  return state.transactions.reduce((sum,t) => sum + (t.type==='transfer' ? (t.toWallet===walletId?t.amount:0)-(t.wallet===walletId?t.amount:0) : t.wallet===walletId ? (t.type==='income'?t.amount:-t.amount) : 0), opening);
}
export function breakdown(state, month, type='expense') {
  const groups = new Map();
  for (const t of monthRows(state,month).filter(t=>t.type===type)) groups.set(t.category,(groups.get(t.category)??0)+t.amount);
  return [...groups].map(([category,amount])=>({category,amount})).sort((a,b)=>b.amount-a.amount);
}
export function money(text) {
  const clean=String(text).trim().toLowerCase().replace(/\s/g,'');
  const match=clean.match(/^([\d.,]+)(k|nghìn|ngàn|tr|triệu)?(?:đ|₫)?$/);
  if(!match) return NaN;
  const number=match[2] ? Number(match[1].replace(',','.')) : Number(match[1].replace(/[.,]/g,''));
  return Math.round(number*(/^(k|nghìn|ngàn)$/.test(match[2])?1000:match[2]?1000000:1));
}
export function validateTxn(t, state) {
  if(!Number.isSafeInteger(t.amount)||t.amount<=0||t.amount>1e12) return 'Nhập số tiền lớn hơn 0, tối đa 1.000 tỷ đồng.';
  const date = new Date(t.date+'T12:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(t.date)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==t.date) return 'Chọn ngày hợp lệ.';
  if(!state.wallets.some(w=>w.id===t.wallet)) return 'Chọn ví cho giao dịch.';
  if(t.type==='transfer') {
    if(t.toWallet===t.wallet) return 'Ví nhận cần khác ví chuyển.';
    if(!state.wallets.some(w=>w.id===t.toWallet)) return 'Chọn ví nhận.';
  } else if(!state.categories.some(c=>c.id===t.category&&c.type===t.type)) return 'Chọn danh mục phù hợp với Thu hoặc Chi.';
  return '';
}
// Bộ phân tích câu mẫu, không gọi AI. Dấu phẩy trước chữ tách khoản, còn 1,5tr là số thập phân.
export function parseQuick(text, state) {
  const parts=text.split(/[;\n]+|,\s*(?=\p{L})/u).map(s=>s.trim()).filter(Boolean);
  if(!parts.length) return {error:'Nhập nội dung, ví dụ: Cà phê 55k; đi chợ 420k.'};
  const rows=[];
  for(const p of parts) {
    const match=p.match(/(\d[\d.,]*)\s*(triệu|nghìn|ngàn|tr|k|đ|₫)?(?=\s|$)/i);
    if(!match) return {error:`Chưa thấy số tiền trong “${p}”. Thử “Cà phê 55k” hoặc nhập tay.`};
    const amount=money(match[0]);
    const norm=p.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d');
    const type=/luong|thu nhap|thuong|duoc tang|hoan tien/.test(norm)?'income':'expense';
    let category=type==='income'?'salary':'other';
    const rules=type==='income'?[['thuong','bonus'],['hoan tien','refund'],['duoc tang','gift']]:[['ca phe|an |com|bun|pho|tra sua','food'],['di cho|sieu thi|thuc pham','grocery'],['grab|xang|xe','transport'],['thue nha|tien nha','home'],['giay|quan ao|mua sam','shopping'],['thuoc|kham|suc khoe','health'],['dien |internet|nuoc','bills']];
    for(const [pattern,cat] of rules) if(new RegExp(pattern).test(norm)) {category=cat;break;}
    for(const c of state.categories.filter(c=>c.type===type&&c.custom)) if(norm.includes(c.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d'))) category=c.id;
    const date=norm.includes('hom qua')?'2026-10-03':TODAY;
    const t={id:id(),type,amount,category,note:p,date,wallet:'bank'};
    const error=validateTxn(t,state);if(error)return {error}; rows.push(t);
  }
  return {rows};
}

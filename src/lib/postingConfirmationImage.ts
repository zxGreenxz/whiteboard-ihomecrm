import { formatVND } from '@/lib/utils';

interface PostingConfirmation {
  actorId: string;
  actorName: string;
  voucherId: string;
  voucherCode?: string;
  amount: number;
}

/** Ảnh xác nhận nội bộ được tạo khi người đang đăng nhập chủ động chọn. */
export async function createPostingConfirmationImage(input: PostingConfirmation): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Trình duyệt không tạo được ảnh xác nhận.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#166247';
  ctx.fillRect(0, 0, canvas.width, 102);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('Xác nhận chi nội bộ', 44, 62);
  ctx.font = 'bold 24px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('iHomeCRM', 916, 61);

  const names = input.actorName.trim().split(/\s+/u);
  const initials = (names[0].slice(0, 1) + (names.length > 1 ? names[names.length - 1].slice(0, 1) : '')).toLocaleUpperCase('vi-VN');
  ctx.fillStyle = '#e2f1eb';
  ctx.beginPath();
  ctx.arc(88, 172, 44, 0, 2 * Math.PI);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#166247';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(initials, 88, 182, 62);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#425653';
  ctx.font = '20px sans-serif';
  ctx.fillText('Người xác nhận', 152, 157);
  ctx.fillStyle = '#132f28';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(input.actorName, 152, 195, 760);

  const time = new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date());
  const rows = [
    ['Mã phiếu', input.voucherCode || input.voucherId],
    ['Số tiền', formatVND(input.amount)],
    ['Thời điểm xác nhận', time + ' (GMT+7)'],
    ['Mã tài khoản', input.actorId],
  ];
  rows.forEach(([label, value], index) => {
    const top = 232 + index * 56;
    ctx.fillStyle = '#e4ebe8';
    ctx.fillRect(44, top, 872, 1);
    ctx.fillStyle = '#425653';
    ctx.font = '21px sans-serif';
    ctx.fillText(label, 44, top + 36);
    ctx.fillStyle = '#132f28';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(value, 290, top + 36, 626);
  });

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error('Không tạo được ảnh xác nhận.')), 'image/png');
  });
  return new File([blob], `xac-nhan-noi-bo-${input.voucherId}.png`, { type: 'image/png' });
}

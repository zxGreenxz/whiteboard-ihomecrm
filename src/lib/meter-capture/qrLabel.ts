export async function createMeterQrLabel(qrText: string, labels: string[]): Promise<string> {
  const { default: QRCode } = await import('qrcode');
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, qrText, { width: 480, margin: 3, errorCorrectionLevel: 'H' });
  const label = document.createElement('canvas');
  label.width = 480;
  label.height = 490 + labels.length * 38;
  const context = label.getContext('2d');
  if (!context) throw new Error('Trình duyệt không tạo được tem QR.');
  context.fillStyle = 'white'; context.fillRect(0, 0, label.width, label.height);
  context.drawImage(canvas, 0, 0);
  context.fillStyle = '#111827'; context.font = 'bold 24px sans-serif'; context.textAlign = 'center';
  labels.forEach((line, index) => context.fillText(line, 240, 500 + index * 38, 450));
  return label.toDataURL('image/png');
}

export function printMeterQrLabel(dataUrl: string): void {
  const popup = window.open('', '_blank', 'width=620,height=800');
  if (!popup) throw new Error('Cho phép cửa sổ in, hoặc tải tem PNG để in.');
  popup.opener = null;
  popup.document.title = 'Tem đồng hồ điện';
  const image = popup.document.createElement('img');
  image.alt = 'Tem QR đồng hồ điện';
  image.style.width = '60mm';
  image.onload = () => { popup.focus(); popup.print(); };
  image.src = dataUrl;
  popup.document.body.append(image);
}

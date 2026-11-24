/**
 * Nhãn ngắn cho chuỗi trình duyệt (user agent) để người đọc nhật ký nhận ra máy: «iPhone · Safari», «Windows ·
 * Chrome». Chỉ để HIỂN THỊ; chuỗi gốc vẫn được giữ và hiện khi cần đối chiếu. Không nhận ra thì trả «Máy khác».
 */
export function userAgentLabel(ua: string | null | undefined): string {
  if (!ua) return 'Không rõ thiết bị';
  const os = /iPad/.test(ua) ? 'iPad'
    : /iPhone|iPod/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
            : /CrOS/.test(ua) ? 'ChromeOS'
              : /Linux/.test(ua) ? 'Linux' : null;
  const browser = /Zalo/i.test(ua) ? 'Zalo'
    : /Edg(A|iOS)?\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /CriOS|Chrome\//.test(ua) ? 'Chrome'
          : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
            : /Safari\//.test(ua) ? 'Safari' : null;
  const parts = [os, browser].filter((part): part is string => !!part);
  return parts.length ? parts.join(' · ') : 'Máy khác';
}

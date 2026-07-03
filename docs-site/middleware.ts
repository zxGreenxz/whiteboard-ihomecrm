// Vercel Edge Middleware — password gate cho toàn bộ docs (mọi host, mọi request kể cả ảnh).
// FAIL-CLOSED: thiếu env DOCS_PASSWORD thì khóa, không mở.
export const config = { matcher: '/:path*' }

export default function middleware(req: Request) {
  const password = process.env.DOCS_PASSWORD ?? ''
  const expected = 'Basic ' + btoa(`docs:${password}`)
  if (password && req.headers.get('authorization') === expected) {
    return // cho qua → Vercel phục vụ file tĩnh
  }
  return new Response('Tài liệu nội bộ — cần đăng nhập.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="ptcrm docs", charset="UTF-8"',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

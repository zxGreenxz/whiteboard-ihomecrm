# Image chạy worker Zalo trên VPS. Cách dựng và chạy: worker/README.md, mục "Chạy bằng Docker".
#
# Ghim đúng image gốc mà worker Network Center đang dùng trên VPS Minh (có sẵn, khỏi tải lại).
# Font không nằm trong git (worker/.gitignore) nên tải lúc dựng, rồi so mã băm: tải nhầm trang
# lỗi hay font đổi upstream thì bản dựng dừng, không để ảnh phòng trống ra ô vuông âm thầm.
FROM node:20.20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY tai-font.mjs fonts.sha256 ./
RUN node tai-font.mjs && sha256sum -c fonts.sha256

FROM node:20.20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

ARG ZALO_WORKER_RELEASE_SHA=0000000000000000000000000000000000000000

# Heap 256 MB trong giới hạn 384 MB của container: phần còn lại cho bộ vẽ ảnh (@napi-rs/canvas)
# cấp phát ngoài heap.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=256

LABEL org.opencontainers.image.revision="${ZALO_WORKER_RELEASE_SHA}" \
      com.ihomecrm.component="zalo-worker"

RUN groupadd --gid 10002 zalo \
  && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin zalo

WORKDIR /app
# Chỗ gắn thư mục phiên khi chạy (`zalo-worker.sh run`); tạo sẵn để ctx.js không phải mkdir trên
# hệ file chỉ đọc nếu lỡ chạy thiếu mount.
RUN install -d -o 10002 -g 10002 -m 700 /app/sessions
COPY --from=deps --chown=10002:10002 /app/node_modules ./node_modules
COPY --from=deps --chown=10002:10002 /app/fonts ./fonts
COPY --chown=10002:10002 package.json index.js ./
COPY --chown=10002:10002 lib ./lib

USER 10002:10002

CMD ["node", "index.js"]

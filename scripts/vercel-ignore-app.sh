#!/bin/sh
# Ignored Build Step cho project APP (ptcrm) trên Vercel.
# Semantics của Vercel: exit 0 = SKIP build, exit 1 = BUILD.
# Commit chỉ đụng docs/ hoặc docs-site/ thì KHÔNG rebuild app.
#
# ⚠ NHÁNH `production` LUÔN BUILD — đừng bỏ luật này đi.
#
# Nhánh production là ĐƯỜNG PHÁT HÀNH: nó được cập nhật bằng
# `git push origin origin/main:production`, tức MỘT cú push mang theo NHIỀU
# commit. So `HEAD^ HEAD` khi đó chỉ nhìn commit ĐỈNH với cha nó, bỏ qua toàn bộ
# phần còn lại của dải — nếu commit đỉnh tình cờ chỉ đụng docs thì build bị skip
# dù dải đó có đầy thay đổi mã.
#
# ĐÃ XẢY RA THẬT 22/08/2026: promote d6470830..dd02eaff mang theo
# src/pages/deposits/DepositsPage.tsx và src/hooks/useDepositDashboard.ts, nhưng
# commit đỉnh chỉ sửa docs/generated/repository-inventory.* nên Vercel báo
# CANCELED. Production tiếp tục chạy bản cũ trong khi mọi gate đều xanh và
# `git log` nói đã phát hành — kiểu hỏng im lặng tệ nhất: không ai thấy lỗi,
# chỉ thấy tính năng "không lên".
#
# Không thay bằng cách so với bản đang deploy: Vercel không cấp biến nào đáng tin
# cho việc đó trong Ignored Build Step. Luôn build ở nhánh phát hành vừa đúng vừa
# rẻ — nhánh này mỗi ngày chỉ vài cú promote.
if [ "$VERCEL_GIT_COMMIT_REF" = "production" ]; then
  exit 1  # nhánh phát hành → luôn build
fi

if git diff --name-only HEAD^ HEAD | grep -qvE '^(docs/|docs-site/)'; then
  exit 1  # có file ngoài docs → build app
else
  exit 0  # chỉ docs → skip
fi

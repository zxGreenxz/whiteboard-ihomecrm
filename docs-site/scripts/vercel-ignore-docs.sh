#!/bin/sh
# Ignored Build Step cho project DOCS (ptcrm-docs) trên Vercel — cwd = docs-site.
# Semantics của Vercel: exit 0 = SKIP build, exit 1 = BUILD.
# Chỉ build khi có thay đổi trong docs-site/ hoặc docs/huong-dan-su-dung/.
if git diff --quiet HEAD^ HEAD -- . ../docs/huong-dan-su-dung; then
  exit 0  # không đổi gì liên quan docs → skip
else
  exit 1  # có thay đổi → build
fi

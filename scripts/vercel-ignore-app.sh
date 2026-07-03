#!/bin/sh
# Ignored Build Step cho project APP (ptcrm) trên Vercel.
# Semantics của Vercel: exit 0 = SKIP build, exit 1 = BUILD.
# Commit chỉ đụng docs/ hoặc docs-site/ thì KHÔNG rebuild app.
if git diff --name-only HEAD^ HEAD | grep -qvE '^(docs/|docs-site/)'; then
  exit 1  # có file ngoài docs → build app
else
  exit 0  # chỉ docs → skip
fi

# Third-party notices

This file records third-party notices for code or substantial implementation
portions incorporated into OpenClaw source, beyond normal package-manager
dependency metadata.

## Pi / pi-mono

Portions of OpenClaw were adapted from Pi / pi-mono, and OpenClaw also depends
on `@earendil-works/pi-tui` for terminal UI rendering.

- Upstream: https://github.com/earendil-works/pi-mono
- Package family: `@earendil-works/pi-*`
- License: MIT
- Copyright: Copyright (c) 2025 Mario Zechner

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# iHomeCRM reviewed dependency inventory

asynckit@0.4.0 | MIT
bignumber.js@9.3.1 | MIT
call-bind-apply-helpers@1.0.2 | MIT
combined-stream@1.0.8 | MIT
crypto-js@4.2.0 | MIT
delayed-stream@1.0.0 | MIT
dunder-proto@1.0.1 | MIT
es-define-property@1.0.1 | MIT
es-errors@1.3.0 | MIT
es-object-atoms@1.1.2 | MIT
es-set-tostringtag@2.1.0 | MIT
form-data@2.5.6 | MIT
function-bind@1.1.2 | MIT
get-intrinsic@1.3.0 | MIT
get-proto@1.0.1 | MIT
gopd@1.2.0 | MIT
has-symbols@1.1.0 | MIT
has-tostringtag@1.0.2 | MIT
hasown@2.0.4 | MIT
json-bigint@1.0.0 | MIT
math-intrinsics@1.1.0 | MIT
mime-db@1.52.0 | MIT
mime-types@2.1.35 | MIT
pako@2.2.0 | MIT AND Zlib
psl@1.15.0 | MIT
punycode@2.3.1 | MIT
querystringify@2.2.0 | MIT
requires-port@1.0.0 | MIT
safe-buffer@5.2.1 | MIT
semver@7.8.5 | ISC
spark-md5@3.0.2 | WTFPL
tough-cookie@4.1.3 | BSD-3-Clause
typebox@1.3.3 | MIT
universalify@0.2.0 | MIT
url-parse@1.5.10 | MIT
ws@8.21.0 | MIT
zca-js@2.1.2 | MIT
zod@4.4.3 | MIT

# Reviewed carrier paths

asynckit@0.4.0 | licenses/asynckit@0.4.0/LICENSE
bignumber.js@9.3.1 | licenses/bignumber.js@9.3.1/LICENCE.md
call-bind-apply-helpers@1.0.2 | licenses/call-bind-apply-helpers@1.0.2/LICENSE
combined-stream@1.0.8 | licenses/combined-stream@1.0.8/License
crypto-js@4.2.0 | licenses/crypto-js@4.2.0/LICENSE
delayed-stream@1.0.0 | licenses/delayed-stream@1.0.0/License
dunder-proto@1.0.1 | licenses/dunder-proto@1.0.1/LICENSE
es-define-property@1.0.1 | licenses/es-define-property@1.0.1/LICENSE
es-errors@1.3.0 | licenses/es-errors@1.3.0/LICENSE
es-object-atoms@1.1.2 | licenses/es-object-atoms@1.1.2/LICENSE
es-set-tostringtag@2.1.0 | licenses/es-set-tostringtag@2.1.0/LICENSE
form-data@2.5.6 | licenses/form-data@2.5.6/License
function-bind@1.1.2 | licenses/function-bind@1.1.2/LICENSE
get-intrinsic@1.3.0 | licenses/get-intrinsic@1.3.0/LICENSE
get-proto@1.0.1 | licenses/get-proto@1.0.1/LICENSE
gopd@1.2.0 | licenses/gopd@1.2.0/LICENSE
hasown@2.0.4 | licenses/hasown@2.0.4/LICENSE
has-symbols@1.1.0 | licenses/has-symbols@1.1.0/LICENSE
has-tostringtag@1.0.2 | licenses/has-tostringtag@1.0.2/LICENSE
json-bigint@1.0.0 | licenses/json-bigint@1.0.0/LICENSE
math-intrinsics@1.1.0 | licenses/math-intrinsics@1.1.0/LICENSE
mime-db@1.52.0 | licenses/mime-db@1.52.0/LICENSE
mime-types@2.1.35 | licenses/mime-types@2.1.35/LICENSE
pako@2.2.0 | licenses/pako@2.2.0/LICENSE
pako@2.2.0 | licenses/pako@2.2.0/lib/zlib/README
psl@1.15.0 | licenses/psl@1.15.0/LICENSE
punycode@2.3.1 | licenses/punycode@2.3.1/LICENSE-MIT.txt
querystringify@2.2.0 | licenses/querystringify@2.2.0/LICENSE
requires-port@1.0.0 | licenses/requires-port@1.0.0/LICENSE
safe-buffer@5.2.1 | licenses/safe-buffer@5.2.1/LICENSE
semver@7.8.5 | licenses/semver@7.8.5/LICENSE
spark-md5@3.0.2 | licenses/spark-md5@3.0.2/LICENSE
tough-cookie@4.1.3 | licenses/tough-cookie@4.1.3/LICENSE
typebox@1.3.3 | licenses/typebox@1.3.3/license
universalify@0.2.0 | licenses/universalify@0.2.0/LICENSE
url-parse@1.5.10 | licenses/url-parse@1.5.10/LICENSE
ws@8.21.0 | licenses/ws@8.21.0/LICENSE
zca-js@2.1.2 | licenses/zca-js@2.1.2/LICENSE
zod@4.4.3 | licenses/zod@4.4.3/LICENSE

pako@2.2.0 has two required carriers: its MIT LICENSE and bundled zlib README.
spark-md5@3.0.2 selects the bundled WTFPL carrier; LICENSE2 is absent and must never be fetched or synthesized.

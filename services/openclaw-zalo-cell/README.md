# OpenClaw Zalo cell image

This directory defines the immutable `linux/amd64` cell image for the reviewed
ZaloUser fork. The Docker context is deny-by-default, installs only the committed
internal tgz with npm offline mode, and copies the three reviewed session-crypto
runtime files instead of compiling them inside Docker.

The base image, BuildKit image, buildx binaries, source epoch, and context inputs
are pinned by `image-lock.json`. Run the dependency-free static contract locally:

```text
node --test services/openclaw-zalo-cell/test/image-contract.test.mjs
```

The qualifying build must run `scripts/build-reproducible-image.ps1` from an
exact reviewed Git-tree export with PowerShell 7.3+, Node 24.15.0 or later in the
stable 24.x line, and an absolute verified buildx 0.13.1 binary. It creates two
fresh pinned BuildKit builders and accepts the result only when both OCI archives
are byte-identical. `--pull` may acquire the pinned base image; all application
installation commands inside the Docker build run with `--network=none`.

`build-evidence.json` is intentionally absent from source checkpoint R. It is
created only by the qualifying build and committed later as the sole file in the
evidence-only child checkpoint E.

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

Do not invoke the image or evidence PowerShell helpers directly. After exact R
has an independent approval report, a root operator stages the closed manifest at
`/opt/openclaw-tools/reviewed-task2-approvals/<R>/approval-manifest-v1.json` and
places the exact raw-R `install-reviewed-task2-launcher.mjs` bytes at
`/opt/openclaw-tools/reviewed-task2-bootstrap/install-reviewed-task2-launcher.mjs`.
The root installer reauthenticates M-to-R ancestry, all six raw-R authority blobs,
the review reports and pinned runtime closure, then atomically installs only
`launch-reviewed-task2.mjs` and `approval-manifest-v1.json` under
`/opt/openclaw-tools/reviewed-task2/<R>/` as root-owned read-only files.

Run the installed `launch-reviewed-task2.mjs` as UID/GID `openclaw-runner` with
an empty environment. Its only operator inputs are `--phase`, the canonical
`--repository-root`, and the exact installed `--approval-manifest`; M, R, review
reports, Node 24.15.0, Git 2.53.0, PowerShell 7.6.2, npm 11.12.1, buildx 0.13.1,
Docker 29.1.3 and the rootless Docker socket all come from that closed manifest.
The launcher verifies those authorities before and after the run, authenticates
the inner `run-reviewed-task2.ps1` from raw R, and executes it in memory through
the PowerShell parser. It never uses `/dev/stdin`, ambient profiles, PATH lookup,
or caller-selected helper/runtime paths.

Qualification exports exact R twice: one mutable verification export for install,
tests and packaging, followed by a fresh untouched qualification export for the
build. The exact PowerShell 7.6.2 helper creates two fresh pinned BuildKit builders
and accepts the result only when both OCI archives are byte-identical. `--pull`
may acquire the pinned base image; all application installation commands inside
the Docker build run with `--network=none`. Qualification retains fork OCI A,
byte-identical fork OCI B, the authentic upstream control OCI, and the
authenticated upstream tgz. Evidence embeds the complete closed approval manifest,
all six raw-R authority bindings, its pinned runtime closure, both canonical
review reports, and `verification.execution_authority=true`.

`build-evidence.json` is intentionally absent from source checkpoint R. It is
created only by the qualifying build and committed later as the sole file in the
evidence-only child checkpoint E. The child verifier revalidates the closed
schema, embedded execution authority, both review reports, exact R, image lock,
retained A/B/stock/tgz bytes, OCI descriptors, installed fork manifest, and
session-crypto closure before the evidence file may be committed. Run the same
installed `launch-reviewed-task2.mjs` with `--phase evidence`; it dispatches the
raw-R `create-evidence-child.ps1` authority and supplies all retained paths from
the closed orchestration contract. The helper rejects detached HEAD, creates E
with raw Git object/index plumbing, authenticates the complete E tree and sole
`100644` evidence blob, retains E through a temporary ref, then advances the exact
source branch from R to E with an old-object compare-and-swap and conditional
rollback.

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
The helper also requires absolute pinned Node 24.15.0, Git 2.53.0, and Docker
29.1.3 binaries (`-NodePath`, `-GitPath`, and `-DockerPath`), plus an explicit
root-owned Docker socket URI in `-DockerHost`. The binary size, SHA-256, version,
and non-link path are revalidated around security-critical execution. It also
requires the Git repository root, the exact-R export root, its canonical manifest and SHA-256,
exact `-ExpectedM`, `-ReviewedTree`, `-GitRepositoryRoot`,
`-MReviewReportPath`, and `-RReviewReportPath` inputs. Both report paths must be
absolute regular files; their canonical bytes, hashes, reviewer identity,
approval decision, and empty findings are validated before either builder starts
and embedded in the evidence. The Git-backed caller remains the working directory
so the helper can re-enumerate R and re-hash the complete exported tree before
the first Docker action. Qualification retains three distinct outputs: fork OCI
A (`-ReleaseArtifactPath`), byte-identical fork OCI B
(`-ReproductionArtifactPath`), and the authentic upstream control OCI
(`-StockOciPath`), plus the authenticated upstream tgz at
`-RetainedUpstreamTarballPath`.

`build-evidence.json` is intentionally absent from source checkpoint R. It is
created only by the qualifying build and committed later as the sole file in the
evidence-only child checkpoint E. The child verifier revalidates the closed
schema, both embedded review reports, exact R, image lock, retained OCI archive,
OCI descriptors, installed fork manifest, and session-crypto closure before the
evidence file may be staged. Run `scripts/create-evidence-child.ps1` with the
same absolute `-NodePath`, `-GitPath`, `-DockerPath`, and `-DockerHost`, plus the
retained A/B/stock/tgz paths. The helper rejects detached HEAD, binds the exact
source branch ref, and advances it from R to E with an old-object compare-and-swap.

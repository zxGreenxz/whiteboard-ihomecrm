# P0d fix1 — empty REST classification

Review finding in `task-P0d-review.md` resolved at commit `5b9f3b26` (`fix(contract-lifecycle): classify empty TEST REST as mismatch`, with required Co-Authored-By trailer). Base was `c016e9c5886a8417e67873582ef7caa4f5f6d7ce`.

`runV1` now passes `allowEmpty: true` to the existing `selectAll` transport. This admits only the exact valid `Content-Range: */0` plus `[]` response to `compareV1`, where a nonempty SQL A and empty REST C yields status 1 `source_mismatch`. The transport still rejects malformed range/count responses; no transport implementation, schema, financial policy or other gate behavior was changed.

TDD: the new adapter-boundary regression, using the real `selectAll` with fake HTTP `*/0`, failed RED with status 2 `v1_rest_error`; after the one-line change it passed GREEN with status 1 `source_mismatch`. Same regression checks malformed range remains status 2 and a valid nonempty page continues to the threshold guard (status 3 for one row). Node 24.18.0 command `npm exec --yes --package=node@24.18.0 -- node --test scripts/tests/contract-lifecycle/reconcile.test.mjs scripts/tests/contract-lifecycle/transport.test.mjs` passed 33/33. `git diff --cached --check` passed. Named-file staging included only `reconcile.mjs` and `reconcile.test.mjs`.

Live TEST was not rerun because successful nonempty source behavior did not change. The previous receipt at code SHA `2d5d3ae9` remains evidence for that path; the exact empty-response branch is verified locally with the real paginator and a controlled HTTP boundary. Parent owns independent review, combined gates and release.

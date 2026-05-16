# Versioning

Use the repository's documented release policy first. Use this reference when the repo has no stronger rule.

## Semantic Version Choice

- **Patch (`x.y.Z`)**: backwards-compatible fix, docs correction, CI/release fix, security update, dependency update, or small internal cleanup that users receive as a correction.
- **Minor (`x.Y.0`)**: backwards-compatible feature, new supported workflow/platform, notable performance improvement, or accumulated patch-sized work that deserves a normal release marker.
- **Major (`X.0.0`)**: breaking API/CLI/config behavior, migration-required data/schema changes, removed support, or incompatible packaging/distribution changes.

For `0.x` projects, avoid treating every feature as a major. Prefer minor bumps for normal feature work and patch bumps for fixes unless the project says otherwise.

## Practical Heuristics

- Default to patch for one focused fix shortly after the previous release.
- Default to minor for multiple changes, user-visible additions, or anything users may scan release notes for.
- Do not jump to `1.0.0` just because `0.9.0` exists; ask whether the project is declaring stability.
- If the release only changes release automation or CI, use patch unless the published artifact behavior changes materially.
- If the user proposes a version, check it against the latest release and explain any mismatch before overriding.

## Pre-Release Checks

- Confirm the proposed tag does not already exist locally or remotely.
- Confirm the release target SHA is the intended default-branch tip or explicitly requested commit.
- Confirm no newer release was published after planning.
- If using floating major tags such as `v1`, verify whether automation moves them or whether a manual move is part of repo policy.

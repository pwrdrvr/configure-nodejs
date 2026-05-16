---
name: release
description: "Plan and execute software releases for GitHub repositories. Use when the user asks to cut, prepare, publish, tag, or verify a release; choose the next semantic version; draft release notes or changelog entries from commits and PRs; create GitHub Releases; watch release/publish workflows; or harden release workflows by replacing third-party release actions with first-party GitHub CLI/API steps."
---

# Release

Use this skill to make releases deliberate: inspect the repo's release shape, choose a defensible version, write human release notes, publish from an exact commit, and verify the automation.

## Guardrails

- Start from a clean understanding of the repo state: `git status --short --branch`, `gh repo view`, `git fetch origin --tags`.
- Prefer the repo's default branch from `gh repo view --json defaultBranchRef`; do not guess.
- Do not release from a dirty worktree unless the user explicitly asks and the dirty files are the release artifacts being prepared.
- Pin every release/tag to an exact commit SHA. Re-check that `origin/<default-branch>` has not moved before tagging or publishing.
- Do not force-push the default branch. Do not move existing semver tags unless the repo's release policy explicitly does that, as with floating major tags like `v1`.
- Treat generated GitHub release notes as raw input at most. Write concise, user-facing notes.
- Prefer first-party release mechanics: `gh release create/edit`, `gh api`, or `actions/github-script`. Flag third-party release actions as a supply-chain dependency and prefer removing them when practical.
- If branch protection, required reviews, or GitHub UI-only settings block a step, stop and report the exact manual action needed.

## Quick Workflow

1. Inspect repo-specific release docs and workflow files:

```bash
find .. -name AGENTS.md -print
rg -n "release|publish|version|changelog|tag|softprops|gh release|github-script" AGENTS.md CONTRIBUTING.md README.md CHANGELOG.md .github scripts package.json pyproject.toml Cargo.toml 2>/dev/null
```

2. Prepare release facts:

```bash
git fetch origin --tags
default_branch=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git status --short --branch
python3 .agents/skills/release/scripts/release_plan.py --output-dir .local/release
```

3. Read `.local/release/release-plan.md`, then summarize for user approval:

- last release tag and date
- planned branch tip SHA
- raw and meaningful commit counts
- suggested next tag and rationale
- warnings, especially dirty worktree, non-default branch, low change count, or moved remote

4. After approval, write release notes. If the repo has `CHANGELOG.md`, update it using the same substance as the GitHub Release notes.

5. Re-check the target SHA immediately before publishing:

```bash
git fetch origin --tags
git rev-parse "origin/$default_branch"
```

6. Publish using the repo's established mechanism:

- If the repo releases from a GitHub Release event, use `gh release create <tag> --target <sha> --title <title> --notes-file <file>`.
- If the repo releases from tag push, create/push an annotated tag and watch the tag workflow.
- If the repo maintains floating major tags, verify the workflow moves them, or move them only when repo policy says to.

7. Verify:

```bash
gh release view <tag>
gh run list --limit 10
gh run watch <run-id> --exit-status
git ls-remote --tags origin '<tag>' 'v<major>'
```

## Configure-Nodejs Defaults

For this repository:

- Release workflow: `.github/workflows/release.yml`
- Trigger: pushing a semver tag matching `v*.*.*`
- Stable major tag: the workflow updates floating `v<major>` when the new stable tag is the newest for that major
- Current concern: the workflow uses a third-party GitHub Release action. Prefer replacing it with a first-party `gh release create/edit` or `actions/github-script` step before the next release workflow refactor.
- Normal release command shape after merging the release commit:

```bash
git tag -a v1.2.3 <target-sha> -m "v1.2.3"
git push origin v1.2.3
gh run watch <release-run-id> --exit-status
```

## Version Selection

Load [references/versioning.md](references/versioning.md) when selecting or explaining the next version.

Default policy:

- Patch: focused bug fix, docs correction, CI/release fix, dependency/security update, or other backwards-compatible correction.
- Minor: new user-visible capability, meaningful performance improvement, new supported platform, or several accumulated fixes worth a normal release.
- Major: breaking public API/CLI/config behavior, migration-required data changes, or intentionally dropping supported environments.

Respect repo-specific policy over this default. For `0.x` projects, do not jump to `1.0.0` unless the user asks or the project explicitly defines that threshold.

## Release Notes

Load [references/release-notes.md](references/release-notes.md) before drafting notes or changelog entries.

Rules:

- Rewrite PR titles and commit subjects into outcome-oriented bullets.
- Include direct commits on the default branch; GitHub's PR-only generated notes can miss them.
- Mention contributors for PR-backed changes when the project convention does.
- Keep GitHub Release notes and `CHANGELOG.md` semantically aligned.
- Prefer short sections such as `Highlights`, `Fixes`, `Performance`, `Docs`, and `Internal` when useful.

## Safer Release Automation

Load [references/github-release-workflows.md](references/github-release-workflows.md) when a release workflow uses third-party release actions, deprecated Node runtimes, generated notes, tag-moving logic, or publishing credentials.

Preferred direction:

- Replace third-party GitHub Release creation actions with `gh release create/edit` or `actions/github-script`.
- Keep workflow permissions minimal. Use `contents: write` only where releases/tags need it.
- Avoid long-lived publishing tokens when OIDC or trusted publishing is available.
- Add explicit verification of tag, release URL, and publish workflow result.

## Planner Script

The bundled planner is a fact-gathering helper, not an autopublisher:

```bash
python3 .agents/skills/release/scripts/release_plan.py --output-dir .local/release
```

It writes:

- `.local/release/release-plan.json`
- `.local/release/release-plan.md`

It finds the latest published semver GitHub Release, inspects first-parent commits on the default branch, filters release housekeeping commits, associates commits with PRs when possible, proposes a next tag, and surfaces warnings. Use its output as raw material; still apply engineering judgment and repo-specific docs.

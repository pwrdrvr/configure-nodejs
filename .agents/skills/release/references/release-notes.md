# Release Notes

Write release notes for humans deciding whether to upgrade.

## Inputs To Inspect

- `release-plan.md` from the planner.
- PR titles, bodies, and linked issues when a bullet is ambiguous.
- Direct commits on the default branch since the last release.
- Existing `CHANGELOG.md` style, if present.
- Breaking-change or migration notes from code/docs.

## Writing Rules

- Rewrite raw PR titles and commit subjects. Do not paste them unchanged unless they are already excellent.
- Lead with user-visible behavior: "Fix pnpm cache restores in CI" beats "Change cache path helper".
- Group only when grouping helps scanning. Useful sections: `Highlights`, `Fixes`, `Performance`, `Docs`, `Internal`.
- Keep internal-only changes brief and lower in the notes.
- Include contributors for PR-backed changes if the project convention does.
- Mention direct-to-default-branch commits so they are not lost.
- Put migration steps, breaking changes, or required operator actions above ordinary bullets.

## Changelog Shape

If `CHANGELOG.md` exists, match its style. If creating one:

```md
# Changelog

## v1.2.3 - 2026-05-16

### Fixes

- Fixed ...
```

Keep the changelog and GitHub Release notes semantically aligned, but the GitHub Release can omit repository-maintenance details that only matter to contributors.

## Bad Patterns

- Generated category spam with every PR title.
- Overstating impact beyond what the diff proves.
- Hiding required action in a low-priority bullet.
- Publishing notes before rereading them for awkward wording.

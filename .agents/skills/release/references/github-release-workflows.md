# GitHub Release Workflows

Use this reference when inspecting or changing `.github/workflows/*release*`, publish workflows, or release-tag automation.

## Prefer First-Party Release Steps

Avoid third-party release actions when the task can be done with:

- `gh release create`, `gh release edit`, `gh release view`
- `gh api repos/{owner}/{repo}/...`
- `actions/github-script`

Third-party actions increase supply-chain surface and can lag GitHub runner runtime changes. If a third-party action emits a Node runtime deprecation warning, treat it as a reason to replace it rather than pinning around the warning.

## Minimal Permissions

- `contents: write` is needed to create/edit releases or move tags.
- `contents: read` is enough for most build/test/publish jobs that do not write releases.
- `id-token: write` is useful for trusted publishing/OIDC; prefer it over long-lived package tokens when the package registry supports it.
- Avoid repository-wide write permissions in jobs that only build or test.

## Tag-Driven Release Pattern

For workflows triggered by tag push:

1. Checkout with enough history if the workflow compares tags or moves floating major tags.
2. Validate the pushed tag format.
3. Create or update the GitHub Release using first-party tooling.
4. If maintaining `v1`/`v2` floating tags, update only when the new stable semver tag is the newest for that major.
5. Verify the release URL and final tag refs.

Example replacement for a third-party release action:

```yaml
- name: Publish GitHub release
  env:
    GH_TOKEN: ${{ github.token }}
    TAG_NAME: ${{ github.ref_name }}
  run: |
    gh release create "$TAG_NAME" \
      --repo "$GITHUB_REPOSITORY" \
      --title "$TAG_NAME" \
      --generate-notes
```

Prefer `--notes-file` with human-authored notes when the release process includes note writing.

## GitHub Release Event Pattern

For workflows triggered by `release: published`, the human or agent creates the GitHub Release first. Publish jobs then use `github.event.release.tag_name`.

Use this when a release should be reviewed in GitHub before artifacts publish. Use tag-push workflows when tags are the release source of truth.

## Verification Checklist

- `gh release view <tag>` returns the expected release.
- `git ls-remote --tags origin <tag>` points at the intended object.
- Floating major tag, if any, points at the intended commit.
- Publish workflow completed successfully.
- No release job relies on deprecated runtime warnings or unnecessary third-party actions.

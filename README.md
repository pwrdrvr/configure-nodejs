# configure-nodejs

`configure-nodejs` is a composite GitHub Action for repositories that want one step to:

- install Node.js
- detect npm, pnpm, or Yarn from `package.json` and lockfiles
- enable Corepack when the package manager needs it
- restore a `node_modules`-oriented dependency cache
- install dependencies on cache miss

The action is designed to be shared as `pwrdrvr/configure-nodejs@v1` and to work for both repository-root projects and subdirectory projects in monorepos.

## Usage

### Root project

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: pwrdrvr/configure-nodejs@v1
    with:
      node-version: 22.x
```

### Subdirectory project

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: pwrdrvr/configure-nodejs@v1
    with:
      node-version: 22.x
      working-directory: apps/web
```

### Cache lookup without restore

```yaml
steps:
  - uses: actions/checkout@v6
  - id: configure-nodejs
    uses: pwrdrvr/configure-nodejs@v1
    with:
      lookup-only: "true"

  - if: steps.configure-nodejs.outputs.cache-hit == 'true'
    run: echo "Dependency cache is available"
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `node-version` | `22.x` | Node.js version to install with `actions/setup-node` |
| `package-manager` | `""` | Optional override for `npm`, `pnpm`, or `yarn`; by default the action follows the package manager inferred from `package.json` and the lockfile present |
| `working-directory` | `"."` | Repository-relative directory containing `package.json` and the lockfile |
| `cache-key-suffix` | `""` | Optional suffix appended to the dependency cache key when you want to namespace cache entries |
| `lookup-only` | `"false"` | When `true`, only checks whether the cache exists and skips downloading it |

## Outputs

| Output | Description |
| --- | --- |
| `package-manager` | Resolved package manager |
| `package-manager-version` | Version from `package.json#packageManager` when available |
| `manager-cache-key` | Manager-specific cache-key segment |
| `lockfile-name` | Detected lockfile name |
| `lockfile-path` | Lockfile path relative to the working directory |
| `lockfile-sha` | SHA256 hash of the lockfile |
| `install-command` | Install command used on cache miss |
| `working-directory` | Normalized working directory |
| `working-directory-key` | Cache-key-safe working-directory identifier |
| `cache-hit` | `true` when the dependency cache entry exists for the computed key |

## Package-manager detection

Resolution order:

1. explicit `package-manager` input
2. `package.json#packageManager`
3. supported lockfiles in the working directory

The action fails fast when it finds multiple supported lockfiles in the same working directory.

## Caching behavior

The cache key includes:

- `node-version`
- runner OS and architecture
- normalized working directory
- resolved package manager and version
- lockfile SHA

The cache paths are scoped to the configured `working-directory`, which keeps fixture directories and subdirectory apps isolated from each other.

## Yarn support boundary

The first release targets Yarn repositories that install into `node_modules`.

- Yarn 2+ uses `yarn install --immutable`
- Yarn 1 uses `yarn install --frozen-lockfile`
- the fixture coverage in this repository uses Yarn 4 with `nodeLinker: node-modules`

Plug'n'Play-specific caching is intentionally out of scope for `v1`.

## Development

This repository includes three end-to-end fixtures under `fixtures/`:

- `fixtures/npm-basic`
- `fixtures/pnpm-basic`
- `fixtures/yarn-basic`

The CI workflow runs local unit tests plus end-to-end matrix coverage for those fixtures, followed by cache-lookup verification in a second matrix job.

## Releases

Tag a semantic version such as `v1.0.0` to trigger the release workflow. The workflow creates or updates the floating major tag like `v1` and publishes a GitHub release with generated notes.

## License

[MIT](LICENSE)

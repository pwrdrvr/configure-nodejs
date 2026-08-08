# configure-nodejs

`configure-nodejs` is a composite GitHub Action for repositories that want one step to:

- install Node.js
- detect npm, pnpm, or Yarn from `package.json` and lockfiles
- enable Corepack when the package manager needs it
- restore a dependency cache
- install dependencies when the selected package manager needs a materialized install

The action is designed to be shared as `pwrdrvr/configure-nodejs@v1`, runs natively on Linux, macOS, and Windows runners, and works for both repository-root projects and subdirectory projects in monorepos.

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

### Windows with a pinned pnpm version

The same action contract works on GitHub-hosted Windows runners. Keep pnpm pinned in `package.json#packageManager`; the action activates that exact version with Corepack and verifies the workspace-local store before installing.

```yaml
jobs:
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pwrdrvr/configure-nodejs@<immutable-commit-sha>
        with:
          node-version: 24.14.1
          working-directory: .
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
| `node-version` | `22.x` | Node.js version to install with `actions/setup-node`. A spec that can cross a major release (`lts/*`, `latest`, `>=20`) has to be resolved by `actions/setup-node` before the cache key can be computed, so those specs install Node.js even when `lookup-only` hits |
| `package-manager` | `""` | Optional override for `npm`, `pnpm`, or `yarn`; by default the action follows the package manager inferred from `package.json` and the lockfile present |
| `working-directory` | `"."` | Repository-relative directory containing `package.json` and the lockfile |
| `cache-key-suffix` | `""` | Optional suffix appended to the dependency cache key when you want to namespace cache entries |
| `lookup-only` | `"false"` | When `true`, only checks whether the cache exists and skips downloading it; on a cache hit the action also skips `setup-node` and install-time package-manager setup |

## Outputs

| Output | Description |
| --- | --- |
| `package-manager` | Resolved package manager |
| `package-manager-version` | Version from `package.json#packageManager` when available |
| `manager-cache-key` | Manager-specific cache-key segment |
| `lockfile-name` | Detected lockfile name |
| `lockfile-path` | Lockfile path relative to the working directory |
| `lockfile-sha` | SHA256 hash of the lockfile |
| `install-command` | Install command used when dependency installation runs |
| `working-directory` | Normalized working directory |
| `working-directory-key` | Cache-key-safe working-directory identifier |
| `cache-hit` | `true` when the dependency cache entry exists for the computed key |
| `node-major` | Node.js major version the dependency cache key was built from |
| `pnpm-store-path` | Absolute workspace-local pnpm store path when pnpm setup runs |
| `cache-restore-duration-ms` | Measured cache restore phase duration in milliseconds |
| `setup-node-duration-ms` | Measured `actions/setup-node` phase duration in milliseconds |
| `package-manager-activation-duration-ms` | Measured Corepack/package-manager activation duration in milliseconds |
| `store-discovery-duration-ms` | Measured pnpm store discovery duration in milliseconds |
| `install-duration-ms` | Measured dependency installation duration in milliseconds |
| `cache-save-duration-ms` | Measured cache save phase duration in milliseconds |
| `total-duration-ms` | Measured total action duration in milliseconds |

## Package-manager detection

Resolution order:

1. explicit `package-manager` input
2. `package.json#packageManager`
3. supported lockfiles in the working directory

The action fails fast when it finds multiple supported lockfiles in the same working directory.

## Caching behavior

The cache key includes:

- Node.js **major** version, because `NODE_MODULE_VERSION` — the ABI every compiled native addon in `node_modules` is built against — changes with each major and is stable within one. A pinned `node-version` supplies the major directly; a spec that can cross a major (`lts/*`, `latest`, `>=20`) is resolved by `actions/setup-node` first, which costs that spec the restore-before-setup fast path
- runner OS and architecture
- normalized working directory
- resolved package manager and version
- lockfile SHA

The cache paths are scoped to the configured `working-directory`, which keeps fixture directories and subdirectory apps isolated from each other.

For npm and Yarn, the action caches `node_modules` paths and skips installation on a cache hit.

For pnpm, the action caches a workspace-local `.pnpm-store` path and runs `pnpm install --frozen-lockfile --store-dir .pnpm-store` in normal restore mode, even on a cache hit. The action also exports `npm_config_store_dir` for later workflow steps so follow-up pnpm commands use the same store. pnpm's `node_modules` layout is symlink-heavy and can fail when restored from a recursive `node_modules` archive; caching the store avoids that extraction problem while keeping installs fast.

The package-manager and install commands are executed as structured argument arrays through the GitHub Actions runtime. This avoids POSIX shell assumptions on Windows and avoids interpolating repository metadata into a shell command. For pinned pnpm and Yarn projects, Corepack prepares the declared version and the action verifies the activated version before installation. Third-party package integrity remains enforced by the committed lockfile and the package manager's frozen/immutable install mode.

For pnpm, `cache-hit` means the store cache was found. It does not mean `node_modules` was restored. In `lookup-only` mode, a pnpm cache hit still skips Node.js setup and dependency installation.

When `lookup-only` is `true`, the action resolves the cache key before installing Node. On a cache hit it stops there; on a cache miss it still installs Node, enables Corepack when needed, and primes the cache.

## Yarn support boundary

The first release targets Yarn repositories that install into `node_modules`.

- Yarn 2+ uses `yarn install --immutable`
- Yarn 1 uses `yarn install --frozen-lockfile`
- the dogfood coverage in `pwrdrvr/configure-nodejs-test` uses Yarn 4 with `nodeLinker: node-modules`

Plug'n'Play-specific caching is intentionally out of scope for `v1`.

## Development

The repository CI runs helper unit tests and npm, pnpm, and Yarn fixture installs on GitHub-hosted Linux, macOS, and Windows runners. Each fixture primes a new cache, removes materialized dependencies, restores that cache, and validates the installed package. The action also reports phase timings in its outputs and the workflow job summary.

Additional dogfood coverage lives in [`pwrdrvr/configure-nodejs-test`](https://github.com/pwrdrvr/configure-nodejs-test), which can validate a configurable published ref.

## Releases

Tag a semantic version such as `v1.0.0` to trigger the release workflow. The workflow creates or updates the floating major tag like `v1` and publishes a GitHub release with generated notes.

## License

[MIT](LICENSE)

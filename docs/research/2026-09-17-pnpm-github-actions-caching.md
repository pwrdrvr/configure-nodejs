# What actually works for pnpm restoration on GitHub Actions

**Date:** 2026-09-17  
**Subject:** `pwrdrvr/configure-nodejs` PR [#12](https://github.com/pwrdrvr/configure-nodejs/pull/12) at `f5895f6b363a7510618f66e667a7c3964671a880`  
**Kind:** research only. No product-code change, merge, or release.  
**Question:** before merging the Corepack executable cache, what actually works for pnpm restoration/caching in GitHub Actions — from official source, workflow logs, and reproducible tests, not popularity.

## Verdict

PR #12 caches the right missing layer. A warm pnpm **content store** does not hydrate Corepack’s **package-manager install**. That is not a theory: PwrGit Windows E2E restored `.pnpm-store` and then died on `GET https://registry.npmjs.org/pnpm/-/pnpm-10.33.0.tgz`.

Do **not** replace this with `actions/setup-node` `cache: pnpm` or `pnpm/action-setup` `cache: true`. Both cache the store (or npm’s global cache). Neither caches `COREPACK_HOME`. `setup-node` additionally requires `pnpm` to already be on `PATH` before it can even ask `pnpm store path --silent`.

Keep caching the pnpm **store** and re-running `pnpm install --frozen-lockfile`. That is what official pnpm CI docs, `setup-node`, and `pnpm/action-setup` all do. It is also what PwrGit’s warm consumers actually used: 552/553 packages reused, **downloaded 0**.

Do **not** treat “pnpm `node_modules` cannot be archived” as a fact. On macOS with pnpm 10.33.0 (`package-import-method` auto → clone), a `node_modules`-only tarball restored and `require('ms')` worked. The reason not to skip pnpm install is **lifecycle and native side effects**, not an untested claim that tar cannot round-trip the tree.

**Merge recommendation:** merge PR #12. Follow-ups below are not merge blockers.

**Confidence:** high on the Corepack-vs-store split and on not switching to `setup-node` caching; high on offline Corepack activation in dogfood; medium on Windows/Linux `node_modules`-only restore (tested locally on macOS only).

---

## Method

| Source class | Used | Not used as proof |
| --- | --- | --- |
| Official source at pinned SHAs | `actions/setup-node`, `actions/cache`, `@actions/toolkit` tar, `nodejs/corepack`, `pnpm/action-setup`, pnpm.io settings/CI | Blog posts, Stack Overflow, “everyone caches X” |
| Context7 current docs | setup-node, pnpm.io, pnpm/action-setup, Corepack, actions/cache | Training-data memory of those APIs |
| Workflow logs | configure-nodejs-test cold/warm; PwrGit original failure; PwrGit draft #283 attempts 1–2 | Job *conclusion* alone |
| Local experiment | pnpm 10.33.0 / Corepack 0.35.0 / Node 24.18.0 on macOS ARM64 | Treating that as Windows/Linux proof |
| This action | `action.yml`, `scripts/resolve-corepack-cache.mjs`, CI fixture workflow | README prose when it outruns tests |

External content is treated as untrusted. Claims are marked **tested** (this investigation ran or read a log/source line) or **inferred**.

---

## Four layers that people collapse into “the cache”

| Layer | What it is | Warm store includes it? | PR #12 caches it? |
| --- | --- | --- | --- |
| **1. Executable** | Corepack install of `pnpm`/`yarn` under `COREPACK_HOME/v1/<name>/<semver>/` plus `.corepack` | No | Yes, pinned versions only |
| **2. Content store** | CAS blobs + `index.db` (workspace `.pnpm-store` here) | Yes — this *is* the store | Existing pnpm path, unchanged |
| **3. Materialized tree** | `node_modules` + virtual store `node_modules/.pnpm` (symlinks + cloned/hardlinked files) | No. Action deletes/never saves it for pnpm | No. `pnpm install` rebuilds it |
| **4. Native / Electron side effects** | `postinstall`, `node-gyp`, `@electron/get`, `prebuild-install`, Electron-ABI copies | No, unless `cache-electron: true` | Opt-in path only |

PwrGit attempt 2 Windows/Linux/macOS consumers are the real-world split: store restore ~250–262 MB, Corepack restore ~4–5 MB, then `pnpm install` reused 552/553 packages with **downloaded 0**, then `apps/desktop` **postinstall still ran** (better-sqlite3 Electron native staging). Layers 1–2 can be warm while layer 4 still executes.

---

## Comparison table

| Behavior | `pwrdrvr/configure-nodejs` @ `f5895f6` | `actions/setup-node@v6` (`2499707`, 2026-07-14) / v7 (`8207627`, 2026-07-14) | `pnpm/action-setup@v6.1.0` (2026-09-05) | Combined `actions/cache` |
| --- | --- | --- | --- | --- |
| Caches pnpm **executable** | **Yes**, pinned Corepack home | **No**. Open issue [#531](https://github.com/actions/setup-node/issues/531) since 2022-06-28 | **No**. Re-runs `npm ci` into `dest` every job | Only if you point `path` at it |
| Caches pnpm **store** | Workspace `.pnpm-store` | `pnpm store path --silent` (global store) | Same CLI path, if `cache: true` (default **false**) | Whatever `path` says |
| Caches **node_modules** | npm/Yarn yes; **pnpm no** | **No** (README: “does not cache `node_modules`”) | No | Possible; not what pnpm CI docs recommend |
| Requires pnpm on PATH before cache restore | **No**. Store path is computed without invoking pnpm | **Yes**. `cache: pnpm` runs `pnpm store path --silent` first ([#1357](https://github.com/actions/setup-node/issues/1357)) | Installs pnpm first, then can cache | No |
| Cache key includes OS/arch | Yes | Yes (`RUNNER_OS` + `os.arch()`) | Yes | Only if you put them in `key` |
| Key includes Node major | Yes (`node24-…`) | **No** (open [#641](https://github.com/actions/setup-node/issues/641)) | No | Only if you put it in `key` |
| Key includes lockfile hash | Yes (SHA-256 of lockfile bytes) | Yes (`hashFiles`) | Yes | Typical pattern |
| Key includes PM **version** | Yes (`pnpm-10.33.0`) | **No** (input name `pnpm` only) | No | Only if you put it in `key` |
| Restore-keys / stale prefix | **None** (exact key) | npm/pnpm: none; Yarn Berry only | **Yes**: `pnpm-cache-${OS}-${arch}-` | Optional `restore-keys` |
| lookup-only | Dependency cache, via `actions/cache/restore` | **Absent** | Absent | First-class input |
| Save timing | **Inline** `actions/cache/save@v5` immediately after prepare (Corepack) and after install (store) | **Post** `post-if: success()` | **Post**; prune only if `run_install` was used | Combined action: post `success()`; save action: inline |
| Save on later-step failure | Corepack/store already saved | **Lost** if job fails | Lost if job fails | Combined: lost; save action: kept |
| Immutable keys | Yes. GitHub: you cannot change an existing cache | Same backend | Same | Same |
| Offline Corepack after restore | **Tested** in dogfood with `COREPACK_ENABLE_NETWORK=0` | Not a feature | Does not use Corepack | N/A |
| Official pnpm 12 CI docs | Not the documented installer | Still listed as a generic setup-\* cache | Superseded in pnpm.io 12.x by `pnpm/setup` standalone | Store path examples |

---

## Current implementation (PR #12)

Pinned at `f5895f6b363a7510618f66e667a7c3964671a880` (`feat/cache-corepack`).

### Dependency cache (pre-existing)

```
pnpm-store-node${major}-${os}-${arch}-${workingDirectoryKey}-${manager}-${version}-${lockfileSha}[-electron-true-v1][-suffix]
```

- Path: `<working-directory>/.pnpm-store` (plus Electron dirs if opted in).
- Restore: `actions/cache/restore@v5` **before** `setup-node` for pinned Node specs.
- Hit still runs `pnpm install --frozen-lockfile --store-dir .pnpm-store` unless `lookup-only: true`.
- Save: inline, only on miss, only if a cacheable path exists.
- No restore-keys.

### Corepack cache (this PR)

`scripts/resolve-corepack-cache.mjs`:

- Only `pnpm`/`yarn` with an exact `X.Y.Z` (optional prerelease, optional `+sha224|256|384|512.<hex>`).
- Ranges, `latest`, URLs, npm: `null` (uncached).
- Home: `$RUNNER_TEMP/configure-nodejs-corepack/<sha256(manager@version)>`.
- Key: `corepack-v1-${os}-${arch}-${manager}-${digest}`.
- Independent of lockfile, working directory, Electron flag, and `cache-key-suffix`.
- Restore before `corepack enable` / `prepare --activate`.
- Save immediately after successful prepare, **before** dependency install.
- Save skipped on Corepack hit.
- `lookup-only` **dependency** hit skips Corepack restore/save/activation entirely.

`corepack-v1` matches Corepack `INSTALL_FOLDER_VERSION = 1` in `sources/folderUtils.ts` (corepack v0.36.0). If Corepack ever bumps that, this action’s key prefix is the right place to bump.

Wiring test in-repo: restore before activation, save before install, save not `always()`.

---

## Original failure (tested)

[PwrGit run 34929265373 / job 104253918403](https://github.com/pwrdrvr/PwrGit/actions/runs/34929265373/job/104253918403) — Windows Desktop E2E (1/4), 2026-09-15.

| Fact | Log |
| --- | --- |
| Action | `pwrdrvr/configure-nodejs@v1` SHA `e1bd1cc1494a20f0ee91dae622b0d2523b6fb53c` (no Corepack cache) |
| Store key | `pnpm-store-node24-Windows-X64-root-pnpm-10.33.0-cb2662bae89b667ef62edaa8301030896800c32dcb65a09ebcb2e59cbea0373a` |
| Store | **Cache hit** / **Cache restored successfully** |
| Then | `corepack prepare pnpm@10.33.0 --activate` |
| Failure | `Error when performing the request to https://registry.npmjs.org/pnpm/-/pnpm-10.33.0.tgz` |

That is layer 1 failing after layer 2 hit. `setup-node` `cache: pnpm` would have had the same hole, and would have been unable to *start* caching until pnpm existed.

---

## What the cited runs actually prove

### configure-nodejs-test cold — [run 34931240971](https://github.com/pwrdrvr/configure-nodejs-test/actions/runs/34931240971)

- 18/18 jobs success. Action SHA under test: `f5895f6`.
- Dogfood fixture is **pnpm 10.12.1** (not this repo’s `fixtures/pnpm-basic` `pnpm@10.33.0`).
- Ubuntu Corepack job (104259794158):

  1. Corepack key miss, store miss.
  2. `Preparing pnpm@10.12.1` / `Activated pnpm 10.12.1`.
  3. **Cache saved** `corepack-v1-Linux-X64-pnpm-ad8a0525…` (~4.4 MB) *before* install.
  4. Install: `downloaded 1`.
  5. Store saved (~14–15 KB for the tiny fixture).
  6. Delete `COREPACK_HOME`, set `COREPACK_ENABLE_NETWORK=0`.
  7. Restore store **and** Corepack.
  8. `Preparing` / `Activated pnpm 10.12.1` with network disabled.
  9. Install: `reused 1, downloaded 0`.

- Windows Corepack job: same sequence; Corepack archive ~4.3 MB; offline activate succeeded.

**What this proves (tested):** Corepack home round-trips on Linux and Windows; activation works with `COREPACK_ENABLE_NETWORK=0` after deleting the on-disk home; a warm store then installs with downloaded 0.

**What this does not prove:** zero network from `pnpm` itself beyond Corepack (lifecycle scripts, registry metadata if the lockfile were stale, Electron). The fixture `postinstall` only writes local markers.

### configure-nodejs-test “warm” — [run 34931459338](https://github.com/pwrdrvr/configure-nodejs-test/actions/runs/34931459338)

- 18/18 success.
- Store keys include `corepack-${{ github.run_id }}-${{ github.run_attempt }}`, so the **store was cold again**.
- Corepack keys do **not** include the suffix: Ubuntu/macOS/Windows **Corepack hit** from the previous run (~4 MB restore), then activated, then store miss downloaded 1.

**What this proves:** Corepack identity is independent of lockfile suffix/run id, which is the design.

**What this does not prove:** a warm *store* across runs. The follow-up is a warm-Corepack / cold-store run by construction.

### PwrGit draft [#283](https://github.com/pwrdrvr/PwrGit/pull/283) — pin `f5895f6`, head `13c4b00426eccd56ebc0e764940c8bfcd7946555`

[Run 35095384925](https://github.com/pwrdrvr/PwrGit/actions/runs/35095384925): attempt 1 and attempt 2 both **success**, 19 jobs.

Attempt 2 consumers (tested from logs):

| Job | Store | Corepack | pnpm install |
| --- | --- | --- | --- |
| [Windows E2E 1](https://github.com/pwrdrvr/PwrGit/actions/runs/35095384925/job/104800102497) | hit ~262 MB | hit ~4.1 MB `corepack-v1-Windows-X64-pnpm-b8bf0415…` | 553 pkgs, reused 552, **downloaded 0**, 8.3s, postinstall ran |
| [Linux E2E 1](https://github.com/pwrdrvr/PwrGit/actions/runs/35095384925/job/104800065798) | hit ~250 MB | hit ~4.2 MB | same, 4.1s, postinstall ran |
| [macOS E2E 1](https://github.com/pwrdrvr/PwrGit/actions/runs/35095384925/job/104800098779) | hit ~249 MB | hit ~4.8 MB | 554 pkgs, reused 553, downloaded 0, 9.6s, postinstall ran |
| Linux gate | lookup-only **store hit**; **no Corepack restore** | skipped by design | no install |

Attempt 1 Windows E2E 1 (tested): store **hit**, Corepack **miss**, `Activated pnpm 10.33.0` (network up), then:

```
Failed to save: Unable to reserve cache with key corepack-v1-Windows-X64-pnpm-b8bf0415…, another job may be creating this cache.
```

So the first Corepack generation still **fans out**. The gate cannot prime Corepack on a store hit. One consumer wins the save; others waste a ~4 MB download. That is smaller than a 250 MB store race, but it is the same class of bug the action already documents for dependencies.

PwrGit did **not** set `COREPACK_ENABLE_NETWORK=0`. Warm PwrGit proves restore + activate + store reuse, not offline Corepack. Draft #283 states that explicitly.

`cache-electron` was **false**. Postinstall still staged better-sqlite3 for Electron 41.10.7 from the tree. Layer 4 is not covered by PR #12.

---

## Alternatives, from source

### `actions/setup-node` v6/v7

Fetched: v6 moving tag `249970729cb0ef3589644e2896645e5dc5ba9c38` (2026-07-14); v7.0.0 `820762786026740c76f36085b0efc47a31fe5020` (2026-07-14). Context7 + GitHub source agree.

- Caches **global packages data**, not `node_modules`.
- pnpm path: `pnpm store path --silent` — pnpm must already exist.
- Key: `node-cache-${RUNNER_OS}-${arch}-${packageManager}-${hashFiles(lockfile)}`. No Node major, no pnpm version.
- npm/pnpm: exact key only (no restore-keys). Yarn Berry is the exception.
- Save in **post** `success()`. A failing test job never writes the store.
- `package-manager-cache` auto-enables **npm only** as of v6 (v5 auto-cache broke pnpm/Corepack: [#1357](https://github.com/actions/setup-node/issues/1357)).
- No `lookup-only`.
- Open [#531](https://github.com/actions/setup-node/issues/531) (2022-06-28, still open 2026-08-24): cache Corepack root and `prepare` before PM cache. 207 👍. **Not implemented.**

configure-nodejs already disables this via `package-manager-cache: false` and does its own restore/save. That remains correct.

### `pnpm/action-setup` v6.1.0

- Installs pnpm with `npm ci` of a **committed bootstrap lockfile**, then `self-update`. **Not Corepack.**
- Binary is **not** cached; `dest` is wiped every run.
- Optional store cache: `pnpm-cache-${OS}-${arch}-${lockHash}` **with prefix restore-keys** (stale store is a feature there).
- Post: `pnpm store prune` only if `run_install` was used. Default workflows that `cache: true` and install later **do not prune**.
- `version` vs `package.json#packageManager` mismatch throws.

Using it would reintroduce a second installer next to Corepack’s `packageManager` pin. It would not have prevented the PwrGit tarball failure unless the job also stopped using Corepack.

### Official pnpm 12.x CI docs (pnpm.io, Context7 `/websites/pnpm_io`)

- GitHub Actions example is now [`pnpm/setup`](https://github.com/pnpm/setup) standalone, `cache: true`, runtime via pnpm — **not Corepack**.
- Explicit note: earlier docs used Corepack; Corepack shims pay a Node startup on every `pnpm` invocation.
- Explicit note: caching the store is **not guaranteed** to make install faster.
- All other CI examples cache a **store directory**, not `node_modules`.
- `enableGlobalVirtualStore` is **auto-disabled in CI**.
- `packageImportMethod` `auto`: Linux hardlink→clone→copy; macOS/Windows clone→hardlink→copy.

PwrGit and this action still pin pnpm 10.x via `packageManager` + Corepack. Migrating installers is a separate product decision. It is not a reason to drop the Corepack cache while Corepack remains the activation path.

### Corepack v0.36.0 (`7a4c30b`, 2026-08-28) / main `d4dcb1f` (2026-09-11)

- Default home: `%LOCALAPPDATA%\node\corepack` / `~/.cache/node/corepack`.
- Install dir: `$COREPACK_HOME/v1/<name>/<semver>/`. Hash is **not** in the path.
- `installVersion` reuses a present `.corepack` JSON **without** re-checking the integrity hash and **without** network (**tested source**).
- `COREPACK_ENABLE_NETWORK=0` throws on `fetch` / `fetchAsJson`. Exact-version reuse of `.corepack` does not fetch.
- Tags/ranges/`corepack use <name>` hit the registry (`useCache: false` on `use`). Issue [#704](https://github.com/nodejs/corepack/issues/704).
- Missing `lastKnownGood.json` + `COREPACK_DEFAULT_TO_LATEST` not `0` → `fetchLatestStableVersion`. Issues [#448](https://github.com/nodejs/corepack/issues/448), [#561](https://github.com/nodejs/corepack/issues/561). Warm **pnpm store** does not help.
- pnpm 12 under Corepack: bin `./bin/pnpm.mjs`; Corepack does not install optional native deps. [#873](https://github.com/nodejs/corepack/issues/873). **Inferred risk** if a consumer jumps to pnpm 12 while still using Corepack.

PR #12’s exact-version regex is aligned with the reuse path. It does not set `COREPACK_DEFAULT_TO_LATEST=0`. For pinned `packageManager: pnpm@10.33.0` that usually does not matter; it matters if something later invokes an unpinned `pnpm`/`yarn`.

### `actions/cache` / toolkit tar

- `actions/cache@v5` moving tag `caa296126883cff596d87d8935842f9db880ef25` (2026-06-26).
- Combined action: `post-if: success()`. restore/save split is what configure-nodejs uses.
- lookup-only: exists, does not download, does not change save behavior of the *combined* action; restore-only has no save.
- GitHub docs (fetched 2026-09-17): **you cannot change the contents of an existing cache**.
- `@actions/toolkit` `packages/cache/src/internal/tar.ts`: GNU tar `--posix -cf … -P --files-from`; **no** `--hard-dereference`. Symlinks stored as symlinks. Hardlinks inside the archived paths are preserved; a hardlink whose other inode is **outside** the archive is stored as a regular file with content (**inferred** from GNU tar semantics + this tar argv; **tested** locally on macOS clone where nlink was already 1).
- Windows: GNU tar preferred; `MSYS: winsymlinks:nativestrict` during exec.

---

## Can `node_modules` be archived? (validated, not assumed)

README today: “pnpm's `node_modules` is a farm of symlinks into a content-addressable store, and archiving and re-extracting it produces a tree that is subtly, intermittently broken.”

### Local experiment (tested, macOS ARM64, 2026-09-17)

Two runs: clone (`auto`) and forced hardlink. Node 24.18.0, Corepack 0.35.0, pnpm **10.33.0**, bsdtar 3.5.3. `@actions/cache` tar argv is `--posix -P -C --files-from` **without** `--hard-dereference` ([toolkit `tar.ts`](https://github.com/actions/toolkit/blob/main/packages/cache/src/internal/tar.ts)).

**Clone / `auto` (this action’s default on macOS):**

- `npm_config_store_dir` + `--store-dir .pnpm-store` → `…/.pnpm-store/v10`.
- **0** shared inodes with the store; **0** with `nlink>1`. APFS clone.
- `node_modules/ms` → symlink `.pnpm/ms@2.1.3/node_modules/ms`.
- Restore `node_modules` only in a new directory: `require('ms')` → `1s`.
- Restore store only + `pnpm install --frozen-lockfile --offline`: `reused 1, downloaded 0`.

**Hardlink (`--package-import-method=hardlink`, tiny `is-odd` graph):**

- Package files: same inode as `store/v10/files/…`, `nlink=2`.
- POSIX directory symlinks are **relative**.
- `.modules.yaml` `storeDir` and `.bin` shim `NODE_PATH` are **absolute**.
- GHA-like tar of `node_modules` **only**: **zero** type-1 hardlink members. GNU/BSD tar stores the first (only) occurrence of each inode as a regular file when the other name is outside the archive. Restore: Node `require` worked at the original path **and** a different path; files became `nlink=1` copies.
- Store only + empty `node_modules` + `pnpm install --offline --frozen-lockfile`: success, `downloaded 0`, hardlinks recreated.
- Restored `node_modules` + **empty** store + `pnpm install --offline`: `ERR_PNPM_NO_OFFLINE_TARBALL`. Offline install is a **store** operation.
- Restored `node_modules` + mismatched absolute `storeDir`: pnpm wiped and recreated the tree.
- Store **and** `node_modules` in one tar, **store listed first**: 60 type-1 members; extract restored `nlink=2`.

So the folklore “you cannot cache pnpm `node_modules` because of hardlinks” is **false** for POSIX tar. Absolute `storeDir` / `NODE_PATH` and skipped lifecycle are the real hazards.

Linux GHA (ext4) 10.x `auto` is clone-then-hardlink; 12.x docs are hardlink-first. Windows 10.33.0 `auto` **skips clone** and hardlinks (pnpm: Dev Drive reflinks are slower). Those OS were **not** tar-tested here. Windows junctions are **absolute** ([pnpm/symlink-dir#55](https://github.com/pnpm/symlink-dir/issues/55)); BSD `System32\tar.exe` has followed junctions into cycles ([actions/cache#315](https://github.com/actions/cache/issues/315)); toolkit prefers GNU tar on Windows for that reason.

### Why the action should still cache the store and reinstall

| Reason | Evidence | Status |
| --- | --- | --- |
| Official CI guidance caches the store | pnpm.io CI, setup-node, action-setup | tested docs/source |
| `pnpm install --offline` needs the store, not a restored `node_modules` | local: nm restore + empty store → `ERR_PNPM_NO_OFFLINE_TARBALL` | tested |
| Linux/Windows `auto` hardlinks into the store | pnpm.io + 10.33.0 importer source; local hardlink run on macOS | docs + macOS hardlink tested; Linux/Windows tar **inferred** |
| Skipping install skips postinstall | PwrGit: better-sqlite3 Electron native staging every consumer | tested logs |
| Electron runtime / prebuild downloads are not in the store | README + `cache-electron`; PwrGit ran `cache-electron: false` | tested product + logs |
| Virtual store is per-project; global virtual store is disabled in CI | pnpm.io | tested docs |
| Absolute `storeDir` in `.modules.yaml` | local hardlink tree | tested |
| ABI / native addons | action keys Node **major** | tested source |
| Windows junctions vs relative POSIX symlinks | pnpm FAQ, cache#315 | **inferred** for GHA Windows nm restore |

**Conclusion:** “cannot archive `node_modules`” is **too strong**. “Should not skip `pnpm install` after restore” is **right** for this action’s consumers. Caching store + `node_modules` in one archive (store path first) **does** preserve hardlinks on macOS bsdtar; it is still not a substitute for PR #12, and it is untested on hosted Windows.

---

## Hidden network, lifecycle, stale keys, lookup-only

### Hidden network

| Request | When | PR #12 status |
| --- | --- | --- |
| `GET …/pnpm/-/pnpm-{ver}.tgz` | No `.corepack` in `COREPACK_HOME` | **The bug.** Cached after first successful prepare |
| npm metadata / signatures | Cold Corepack install, missing hash | Still happens on first Corepack miss; skipped on `.corepack` reuse |
| `GET …/pnpm/latest` | No LKG and `COREPACK_DEFAULT_TO_LATEST` ≠ `0` | **Not** set to `0`. Pinned `prepare pnpm@X.Y.Z` usually avoids this |
| `pnpm install` registry | Store miss or lockfile mismatch | Frozen lockfile + warm store: PwrGit **downloaded 0** |
| postinstall / Electron / prebuild | Every pnpm install unless skipped | Still runs; `cache-electron` opt-in |
| pnpm 12 Corepack wrapper fetching `@pnpm/exe.*` | First Corepack-installed pnpm 12 | **Inferred** from [#873](https://github.com/nodejs/corepack/issues/873); PwrGit is 10.33.0 |

Offline dogfood proves Corepack + store install with `COREPACK_ENABLE_NETWORK=0`. It does not prove the job has no network; it proves Corepack did not need any.

### Cache save timing

| Cache | When saved | If a later step fails |
| --- | --- | --- |
| Corepack | After prepare, before install | **Kept** (inline) |
| Store | After install, inline | **Kept** even if tests fail later |
| setup-node / combined cache | Post `success()` | **Lost** |

Attempt 1 PwrGit still lost *some* Corepack saves to **reservation races**, not to post-if.

### Immutable keys / lookup-only

- Exact keys, no restore-keys: a lockfile change is a miss, not a stale prefix restore. That is intentional and matches GitHub immutability.
- `lookup-only: true` on the **store** is the gate. On hit it skips setup-node, Corepack, and install. On miss it does the full prime including Corepack save.
- Corepack is **not** probed on a store hit. First generation of `corepack-v1-…` can still stampede.

### Integrity

- Digest includes the full `packageManager` version string, so `10.33.0` and `10.33.0+sha224.…` are different keys (**tested** unit test).
- Corepack on-disk folder is **semver without hash**. A restored home for `10.33.0` will satisfy `prepare pnpm@10.33.0+sha224.…` reuse **if** `.corepack` exists (**inferred** from `installVersion`; the action avoids that aliasing by putting the hash in the cache key).
- Mutable selectors remain uncached — correct.

### Cross-platform

- Keys include `runner.os` and `runner.arch`. Linux X64, Windows X64, macOS ARM64 are separate Corepack and store entries. **Tested** in both dogfood and PwrGit.
- `enableCrossOsArchive` is not used. Correct: pnpm stores and Corepack extracts are not portable across OS.

---

## Remaining limitations (evidence-backed)

1. **Gate does not prime Corepack on a store hit.** First consumers race `corepack-v1-…`. PwrGit attempt 1 Windows E2E 1: miss + “Unable to reserve cache”. Attempt 2: all hits. Follow-up, not a blocker.
2. **PwrGit networking stayed on.** Offline Corepack is proven only in configure-nodejs-test.
3. **`pnpm install` still runs on every consumer.** That is required for layer 3/4. Warm install is seconds (4–10s in PwrGit E2E), not a registry fetch.
4. **Electron/native downloads are not in the default cache.** `cache-electron: false` on PwrGit; postinstall still did Electron-ABI staging.
5. **Dogfood “warm” run is warm-Corepack, cold-store** because the suffix includes `run_id`.
6. **pnpm 12 + Corepack** is a known upstream footgun. This action will cache whatever pinned version you give it; it will not make pnpm 12’s missing `pnpm.mjs` native bits appear.
7. **`COREPACK_DEFAULT_TO_LATEST` unset.** Fine for exact `prepare`, not a full offline story for unpinned shims.
8. README overstates `node_modules` archive failure. Worth a docs follow-up, not a functional defect.

---

## Recommendations

1. **Merge PR #12** at `f5895f6`. It is the minimal correct fix for the logged PwrGit failure. Do not wait for `setup-node` [#531](https://github.com/actions/setup-node/issues/531).
2. **Do not** switch pnpm to `setup-node` `cache: pnpm` or `pnpm/action-setup` `cache: true` as a substitute. They do not cache the executable, they save in post, and `setup-node` cannot compute the store path until pnpm exists.
3. **Keep** store cache + frozen install for pnpm. Do not skip install on pnpm hit.
4. **Do not** change the default to `node_modules` caching for pnpm. Optional experiment (separate change): archive store **and** `node_modules` in one key and measure Windows/Linux, including native addons. Treat as unproven.
5. **Follow-up (optional):** if `lookup-only` store **hits** but Corepack key **misses**, still setup-node + prepare + save Corepack. That closes the first-generation fan-out. Alternatively, a Corepack-only lookup on the gate.
6. **Follow-up (optional):** export `COREPACK_DEFAULT_TO_LATEST=0` after restore; document that offline proofs require `COREPACK_ENABLE_NETWORK=0`.
7. **Docs follow-up:** replace “does not survive a tarball round trip” with: we cache the store because install must rematerialize the link farm and rerun lifecycle; `node_modules`-only restore can work for clone/copy import on macOS but is not the supported contract.
8. **Do not release** until you are willing to accept that the first post-merge PwrGit-like run may still download pnpm once per OS/arch (store already warm, Corepack key new). After that, Corepack is ~4 MB and shared across lockfiles.

---

## Confidence

| Claim | Confidence | Basis |
| --- | --- | --- |
| Warm store ≠ warm pnpm executable | **High** | PwrGit job 104253918403 |
| PR #12 restores Corepack independently of the store | **High** | Dogfood + PwrGit attempt 2 logs |
| Offline Corepack activate after restore | **High** | Dogfood `COREPACK_ENABLE_NETWORK=0` on Linux/Windows/macOS |
| `setup-node` does not cache Corepack / `node_modules` | **High** | source + README at v6/v7 SHAs |
| pnpm install still needed after store restore | **High** | PwrGit postinstall; action `shouldInstallDependencies` |
| `node_modules` *can* round-trip on macOS clone | **High** (that platform) | local tar + `require` |
| `node_modules` round-trip on Windows/Linux hardlink | **Medium** (Linux GNU tar) / **Low–medium** (Windows junctions) | macOS hardlink tar: 0 type-1 members, require() worked; GNU tar same inode rule **inferred**; Windows junctions untested |
| Caching `node_modules` *and* skipping install is safe for Electron/native | **Low** | contradicted by PwrGit postinstall |
| pnpm 12 via Corepack is safe | **Low** | upstream #873 |

---

## Source catalog

### This change

- PR: https://github.com/pwrdrvr/configure-nodejs/pull/12
- Head: `f5895f6b363a7510618f66e667a7c3964671a880` (signed)
- Released v1 (pre-fix): `e1bd1cc1494a20f0ee91dae622b0d2523b6fb53c`

### Workflows

- configure-nodejs CI on PR: https://github.com/pwrdrvr/configure-nodejs/actions/runs/34930385112
- Dogfood cold: https://github.com/pwrdrvr/configure-nodejs-test/actions/runs/34931240971 (head `2b53cf0cfc4d1526da4d98fcb976a7e2c519ebb6`)
- Dogfood follow-up: https://github.com/pwrdrvr/configure-nodejs-test/actions/runs/34931459338
- PwrGit original fail: https://github.com/pwrdrvr/PwrGit/actions/runs/34929265373/job/104253918403
- PwrGit draft: https://github.com/pwrdrvr/PwrGit/pull/283
- PwrGit validation: https://github.com/pwrdrvr/PwrGit/actions/runs/35095384925/attempts/1 and `/attempts/2`

### Upstream pins used in those logs

- `actions/setup-node@v6` `249970729cb0ef3589644e2896645e5dc5ba9c38` (2026-07-14)
- `actions/cache@v5` `caa296126883cff596d87d8935842f9db880ef25` (2026-06-26)
- `actions/github-script@v8` `ed597411d8f924073f98dfc5c65a23a2325f34cd`

### Upstream docs/source (fetched 2026-09-17)

- setup-node v7.0.0 `8207627` (2026-07-14); README “does not cache node_modules”
- Corepack v0.36.0 published 2026-08-28; `folderUtils.ts` `INSTALL_FOLDER_VERSION = 1`; `corepackUtils.ts` `.corepack` reuse
- pnpm/action-setup v6.1.0 published 2026-09-05
- pnpm 10.33.0 published 2026-03-24; pnpm 12.4.2 published 2026-09-15
- pnpm.io 12.x: CI, `storeDir`, `packageImportMethod`, `virtualStoreType`
- GitHub Docs: caching reference (“You cannot change the contents of an existing cache”)
- Context7 IDs: `/actions/setup-node`, `/pnpm/action-setup`, `/nodejs/corepack`, `/websites/pnpm_io`, `/actions/cache`

### Issues (not popularity)

- setup-node [#531](https://github.com/actions/setup-node/issues/531) Corepack support (open)
- setup-node [#1357](https://github.com/actions/setup-node/issues/1357) `cache: pnpm` before pnpm exists (open)
- setup-node [#328](https://github.com/actions/setup-node/issues/328) restore-keys for all PMs (open)
- corepack [#448](https://github.com/nodejs/corepack/issues/448) offline + warm store still hits npm (open)
- corepack [#873](https://github.com/nodejs/corepack/issues/873) pnpm 12 `pnpm.mjs` (2026-07-15)

### Local experiment

- Path: `/tmp/pnpm-cache-research/local-archive2` (clone/`auto`) and `/tmp/pnpm-archive-exp` (hardlink)
- pnpm 10.33.0, Node 24.18.0, macOS ARM64, bsdtar 3.5.3, 2026-09-17

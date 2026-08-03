# Versioning

## Single source of truth

The version string lives in one place:

```
packages/shared/src/version.ts → MIDAS_VERSION = '0.3.1-alpha'
```

The API exposes it at `GET /api/v1/meta` (no auth required). The web sidebar fetches from there at runtime, falling back to the same constant bundled at build time.

**Keep these in sync on every bump:** `MIDAS_VERSION`, `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`, and a matching `docs/CHANGELOG.md` section.

---

## Version format

`MAJOR.MINOR.PATCH[-tag]`

| Segment | Bump when |
|---------|-----------|
| PATCH | Bug fixes, copy changes, minor UI tweaks |
| MINOR | New user-visible features, new API endpoints |
| MAJOR | Breaking API changes, major product pivots |

Pre-release tags: `alpha` → `beta` → `rc` → (no tag = release)

---

## Agent / PR rule (do not skip)

When landing work on `main` that is more than docs-only:

1. Choose PATCH / MINOR / MAJOR per the table above (feature work → MINOR; bugfix only → PATCH).
2. Bump `MIDAS_VERSION` + the three `package.json` versions in the **same PR/commit** as the feature (or immediately after merge).
3. Add a `docs/CHANGELOG.md` entry for that version.
4. Tag `vX.Y.Z[-tag]` after merge to `main`.
5. After deploy, verify `GET /api/v1/meta` shows the new version.

Do not leave `version.ts` and `package.json` disagreeing (e.g. `0.2.0-alpha` vs `0.2.0`).

---

## How to cut a release

1. Update `MIDAS_VERSION` in `packages/shared/src/version.ts`
2. Update `"version"` in `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json` to match
3. Update `docs/CHANGELOG.md`
4. Commit: `chore: bump version to X.Y.Z`
5. Tag: `git tag vX.Y.Z`
6. Deploy and verify `/api/v1/meta` returns the new version

---

## Verifying the deployed version

```bash
curl http://localhost:4000/api/v1/meta
# → { "appName": "Midas", "version": "0.1.0-alpha", "environment": "production", ... }
```

The sidebar also displays the version at the bottom of every page.

---

## BUILD_DATE and GIT_COMMIT

`/api/v1/meta` optionally includes `buildDate` and `gitCommit` if set as environment variables at build time. In the Docker build, add to `docker-compose.yml`:

```yaml
build:
  args:
    - BUILD_DATE=${BUILD_DATE}
    - GIT_COMMIT=${GIT_COMMIT}
```

And in the Dockerfile:
```dockerfile
ARG BUILD_DATE
ARG GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE
ENV GIT_COMMIT=$GIT_COMMIT
```

These are optional — the meta endpoint returns `null` for both if not set.

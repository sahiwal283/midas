# Versioning

## Single source of truth

The version string lives in one place:

```
packages/shared/src/version.ts → MIDAS_VERSION = '0.1.0-alpha'
```

The API exposes it at `GET /api/v1/meta` (no auth required). The web sidebar fetches from there at runtime, falling back to the same constant bundled at build time.

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

## How to cut a release

1. Update `MIDAS_VERSION` in `packages/shared/src/version.ts`
2. Update `"version"` in `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json` to match
3. Commit: `chore: bump version to X.Y.Z`
4. Tag: `git tag vX.Y.Z`
5. Deploy and verify `/api/v1/meta` returns the new version

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

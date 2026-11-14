# cf-push-relay Development Guidelines

## Releasing a New Version Tag

When asked to create a new release tag (e.g. `v0.1.13`), follow these steps in order:

1. **Bump the version** in `package.json`:
   ```
   "version": "0.1.13"
   ```

2. **Sync the lock file** — `package-lock.json` must always match `package.json`:
   ```bash
   npm install
   ```

3. **Commit and push the version bump:**
   ```bash
   git add package.json package-lock.json
   git commit -m "chore: bump version to v0.1.13"
   git push
   ```

4. **Create and push the tag:**
   ```bash
   git tag v0.1.13
   git push origin v0.1.13
   ```

5. The GitHub Actions workflow triggers automatically on the new tag and deploys to Cloudflare Workers.

## Files to Update on Every Version Bump

| File | Field | Why |
|------|-------|-----|
| `package.json` | `"version"` | Source of truth |
| `package-lock.json` | `"version"` (top-level) | Kept in sync via `npm install` — do not edit manually |

`bruno/bruno.json` has its own `"version"` field that tracks the Bruno collection schema version — it is **not** the package version and should not be changed during releases.

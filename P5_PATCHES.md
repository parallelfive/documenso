# Parallel Five — Custom Documenso Image

This fork exists to maintain a patched Documenso image for the Parallel Five biz-buddy ↔ Documenso integration. Pattern matches our `parallelfive/coolify` fork — same workflow, same maintenance discipline.

## Why

Documenso v1.12.10's public REST API only covers `/documents` and `/templates`. Org / User / branding / signing-URL-prefix surfaces are internal-only (tRPC, no OpenAPI). Biz-buddy needs them for:

- **Workspace → Documenso Organisation auto-provisioning** — when biz-buddy creates a Workspace, biz-buddy provisions a Documenso Organisation via REST
- **Lazy User → Documenso User mirror** — JIT user creation when a member or recipient first interacts with an envelope
- **Signing-URL prefix override** — recipient email links go to `bizbuddy.parallel5.com/sign/...` not `sign.parallel5.com/sign/...`, so biz-buddy can run the JIT-register flow before redirecting the user to the Documenso signing page

Rather than reach into Documenso's DB or call internal tRPC routes (both of which break on every Documenso upgrade), we maintain thin patches that expose the surfaces we need as proper REST + env-var-driven config.

## Image

```
ghcr.io/parallelfive/documenso:latest
```

Built automatically by GitHub Actions on push to `p5/patched` and weekly (to pick up upstream + base image updates).

## Branch Layout

| Branch | Purpose |
|---|---|
| `main` | Upstream mirror (don't commit here — used for fork-sync only) |
| `p5/patched` | **Our branch** — patches on top of `main`, builds the custom image. Default branch for this fork. |
| `p5/sync-upstream-*` | Per-rebase branches when bringing in upstream changes (mirrors Coolify fork pattern) |
| `feat/*` | Per-feature branches when developing a new patch |

## ⚠️ Do NOT click "Sync fork"

GitHub's "Sync fork" button does a fast-forward of `main` against upstream. That's fine for `main` itself (which we treat as a read-only mirror) — but if it trips, our `p5/patched` will look "N commits behind." That cosmetic banner is fine: `Dockerfile.p5` pulls `documenso/documenso:latest` at build time, so runtime is always upstream-latest + our patches overlaid.

The actual upstream sync happens via targeted rebase per file. See `~/parallel5/coolify/P5_PATCHES.md` § "Bringing in upstream changes" for the workflow we use; the same pattern applies here.

## Active Patches

(none yet — the bare image is identical to upstream until we ship the integration patches below)

## Planned Patches (in flight as of 2026-05-01)

### 1. Admin REST API for Organisations + Users
- **Files:** new `apps/remix/app/routes/api.v1.admin.organisations.*.tsx` + `apps/remix/app/routes/api.v1.admin.users.*.tsx` (or wherever Documenso's REST surface lives — confirm during patch dev)
- **Problem:** v1.12.10's public REST API only covers documents + templates. Org / user management is internal tRPC only.
- **Fix:** thin REST wrappers around the existing internal tRPC procedures, gated by Documenso's existing API token system. New endpoints:
  - `POST/GET/PATCH/DELETE /api/v1/admin/organisations`
  - `POST /api/v1/admin/organisations/:id/members`
  - `DELETE /api/v1/admin/organisations/:id/members/:userId`
  - `POST/GET/PATCH /api/v1/admin/users`
- Adds OpenAPI definitions so biz-buddy's typed client picks them up automatically.
- **Remove when:** upstream adds these to the public REST API.

### 2. BIZBUDDY_SIGNING_URL_PREFIX env var
- **File:** the signing-email template (`apps/remix/app/components/templates/document-invite-email.tsx` — verify exact path during patch dev)
- **Problem:** Documenso's email template hardcodes `NEXT_PUBLIC_WEBAPP_URL` as the signing link prefix. We need the link to go to `bizbuddy.parallel5.com/sign/...` so biz-buddy can run the JIT-register flow before redirecting to Documenso for actual signing.
- **Fix:** if `BIZBUDDY_SIGNING_URL_PREFIX` env var is set, use it for the signing link in the email template. Falls back to `NEXT_PUBLIC_WEBAPP_URL` if unset (preserves upstream behavior).
- **Estimated:** ~5 LOC + tests.
- **Remove when:** upstream adds a configurable signing-URL-prefix or a webhook-style "sign initiated" event we can intercept to do the redirect ourselves.

## Maintenance discipline

- Every Documenso upstream release → rebase `p5/patched` against `main`. See Coolify fork's docs for the targeted-rebase-per-file workflow we use to avoid clobbering both upstream changes AND our patches.
- New patches go in their own commit on `p5/patched` with a clear rationale in this doc.
- The `Dockerfile.p5` is the single source of truth for which patches are baked into the image — adding a COPY here without a P5_PATCHES.md entry is a code-smell.
- License: AGPLv3. Same as upstream Documenso. Self-hosted modified version → must offer source to network users → this repo IS the public source.

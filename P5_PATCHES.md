# Parallel Five — Custom Documenso Image

This fork exists to maintain a patched Documenso image for the Parallel Five biz-buddy ↔ Documenso integration. Pattern matches our `parallelfive/coolify` fork — same workflow, same maintenance discipline.

## Why

Documenso v1.12.10's public REST API only covers `/documents` and `/templates`. Org / User / branding / signing-URL-prefix surfaces are internal-only (tRPC, no OpenAPI). Biz-buddy needs them for:

- **Workspace → Documenso Organisation auto-provisioning** — when biz-buddy creates a Workspace, biz-buddy provisions a Documenso Organisation via REST
- **Lazy User → Documenso User mirror** — JIT user creation when a member or recipient first interacts with an envelope
- **Scoped signing callback** — Biz Buddy-owned recipient email links go to `bizbuddy.parallel5.com/sign/...` so Biz Buddy can enforce terminal state and fresh active-workspace membership for member recipients before redirecting to Documenso

Rather than reach into Documenso's DB or call internal tRPC routes (both of which break on every Documenso upgrade), we maintain thin patches that expose the surfaces we need as proper REST + env-var-driven config.

## Image

```
ghcr.io/parallelfive/documenso:latest
```

Built automatically by GitHub Actions on push to `p5/patched` and weekly (to
refresh mutable base-image layers). Upstream Documenso source changes are
included only after the intentional `p5/patched` rebase described below.

**Architectures:** `linux/amd64` (prod's Coolify host) + `linux/arm64` (Apple Silicon dev boxes). Built in parallel on native amd64 + arm64 GitHub runners; merged into a multi-platform manifest. ~6 min wall clock instead of ~50 min for QEMU emulation. See `.github/workflows/build-p5-image.yml`. The `linux/arm64` slice exists so biz-buddy's local-dev `docker compose` can pull our fork directly instead of falling back to upstream `documenso/documenso`.

## Branch Layout

| Branch               | Purpose                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `main`               | Upstream mirror (don't commit here — used for fork-sync only)                                     |
| `p5/patched`         | **Our branch** — patches on top of `main`, builds the custom image. Default branch for this fork. |
| `p5/sync-upstream-*` | Per-rebase branches when bringing in upstream changes (mirrors Coolify fork pattern)              |
| `feat/*`             | Per-feature branches when developing a new patch                                                  |

## Build mechanism — source build (not overlay)

Unlike our `parallelfive/coolify` fork (PHP — overlays individual files onto the upstream image), Documenso is Node + TypeScript bundled by Turbo + Remix at build time. Patched `.ts` files have to be re-compiled into the bundle, so we publish a **full source-built image** rather than an overlay.

`Dockerfile.p5` is a thin marker file. The actual build runs upstream's `docker/Dockerfile` against our patched checkout (referenced from `.github/workflows/build-p5-image.yml` via `file: docker/Dockerfile`). Patches live in the source tree at `apps/` + `packages/`, not as overlay COPY lines. Future upstream improvements to `docker/Dockerfile` flow through automatically on rebase.

## ⚠️ Do NOT click "Sync fork"

GitHub's "Sync fork" button does a fast-forward of `main` against upstream. That's fine for `main` itself (which we treat as a read-only mirror) — but if it trips, our `p5/patched` will look "N commits behind." Ignore that banner: the source-build picks up upstream changes the next time we rebase `p5/patched` onto `main` (intentional, file-by-file), so we never want a button-click to silently merge upstream into our patched branch.

The actual upstream sync happens via targeted rebase per file. See `~/parallel5/coolify/P5_PATCHES.md` § "Bringing in upstream changes" for the workflow we use; the same pattern applies here.

## Active Patches

### 1. Admin REST API for Organisations + Users — landed 2026-05-01

- **Image surface:** `/api/v1/admin/organisations` + `/api/v1/admin/users` (full CRUD + member add/remove)
- **OpenAPI:** auto-published in `/api/v1/openapi.json` via the existing ts-rest → OpenAPI pipeline
- **Auth:** new `adminAuthenticatedMiddleware` — wraps `authenticatedMiddleware`, additionally requires `Role.ADMIN` on the API token's owner
- **Files (additive — patch is self-contained except for ~50 lines wiring it into the main contract + implementation):**
  - `packages/api/v1/admin/contract.ts` — ts-rest contract for the admin endpoints
  - `packages/api/v1/admin/schema.ts` — zod request/response schemas
  - `packages/api/v1/admin/implementation.ts` — pure async handler helpers (no middleware wrapping — see "Wiring quirk" below); wraps `createOrganisation`, `createUser`, `getUserByEmail` lib helpers + direct prisma for org/user reads + member add/remove
  - `packages/api/v1/middleware/admin-authenticated.ts` — admin guard middleware (re-fetches `roles` since upstream `getApiTokenByToken` doesn't include them in its select)
  - `packages/api/v1/contract.ts` — spreads `AdminContract` into `ApiContractV1` (3 line addition)
  - `packages/api/v1/implementation.ts` — wires each admin handler inline (~40 lines) at the `tsr.router(...)` call site
- **Wiring quirk — handlers must be inlined, not spread:** Admin handlers can't be pre-built into a separate `adminImplementation` const + spread into `tsr.router({...})`. ts-rest's contract-driven type inference only fires at the immediate `tsr.router(contract, impls)` call site — when handlers are pre-built outside that scope, the `adminAuthenticatedMiddleware` generic `T` solves to its bare constraint (`{headers: {authorization}}`) and `args.body/query/params` become `never`. So `admin/implementation.ts` exports pure async helpers and `implementation.ts` does the inline middleware wrapping. Same trap will hit anyone who tries to extract the spread later.
- **Endpoints:**
  - `POST   /api/v1/admin/organisations` — create org owned by `ownerEmail` (user must exist)
  - `GET    /api/v1/admin/organisations` — paginated list, optional `?ownerEmail=` filter
  - `GET    /api/v1/admin/organisations/:organisationId`
  - `PATCH  /api/v1/admin/organisations/:organisationId` — name/url
  - `DELETE /api/v1/admin/organisations/:organisationId`
  - `POST   /api/v1/admin/organisations/:organisationId/members` — add member by email + role
  - `DELETE /api/v1/admin/organisations/:organisationId/members/:userId`
  - `POST   /api/v1/admin/users` — create user; password optional (random if omitted, user must reset via forgot-password)
  - `GET    /api/v1/admin/users` — paginated list, optional `?email=` filter
  - `GET    /api/v1/admin/users/:userId`
  - `PATCH  /api/v1/admin/users/:userId` — name/email/disabled
- **Remove when:** upstream adds these (or equivalent) to the public REST API.

### 2. Scoped Biz Buddy signing callback — landed 2026-05-01, hardened 2026-07-17

- **Ownership contract:** Biz Buddy sends `externalId=bizbuddy:<local envelope UUID>`.
  Only that exact, validated namespace activates the callback. Native/manual
  Documenso documents, arbitrary external IDs, and malformed Biz Buddy IDs keep
  the native Documenso `/sign/<recipient token>` URL.
- **Email link:** when `BIZBUDDY_SIGNING_URL_PREFIX` is set, a Biz Buddy-owned
  recipient invite, reminder, or resend uses
  `<prefix>/sign/<local envelope UUID>?p=<Documenso recipient token>`.
  Biz Buddy uses the provider token as the recipient capability, resolves it
  only within the named envelope, applies terminal gates plus a fresh active
  workspace-membership check for member recipients, and redirects to
  Documenso.
- **Normalization:** the prefix may be either a host/base path or end in
  `/sign` (with or without a trailing slash). The helper strips the trailing
  segment before assembling the callback, so `/sign/sign/...` is never emitted.
- **Fallback:** an unset/blank prefix always uses `NEXT_PUBLIC_WEBAPP_URL`.
- **Files:**
  - `.env.example` — documents the fork-only callback env var.
  - `packages/lib/constants/app.ts` — `buildRecipientSigningLink()` validates
    ownership, normalizes the prefix, and constructs the capability URL.
  - `packages/lib/jobs/definitions/emails/send-signing-email.handler.ts` —
    passes `envelope.externalId` and the recipient token to the helper.
  - `packages/lib/jobs/definitions/internal/process-signing-reminder.handler.ts`
    — same contract for scheduled reminders.
  - `packages/lib/server-only/document/resend-document.ts` — same contract for
    explicit resends.
  - `packages/lib/constants/app.test.ts` — covers every supported prefix shape,
    token encoding, native fallback, arbitrary IDs, and malformed namespaces.
- **Other URL constructions** such as email image `assetBaseUrl` still use
  `NEXT_PUBLIC_WEBAPP_URL`.
- **Security:** the `p` query value is Documenso's per-recipient bearer token.
  Do not log it, expose it through operator APIs, analytics, or monitoring
  query capture.
- **Remove when:** upstream supports a scoped external signing callback with
  equivalent ownership discrimination and native fallback.

### 3. API v1 per-envelope expiration metadata — landed 2026-07-17

- **Behavior:** `POST /api/v1/documents` accepts
  `meta.envelopeExpirationPeriod` using Documenso's existing
  `ZEnvelopeExpirationPeriod` shape. Biz Buddy sends
  `{ unit: "day", amount: expiresInDays }`.
- **Why:** `DocumentMeta` and `sendDocument` already support expiration and set
  each recipient's concrete `expiresAt`; the public create schema previously
  gave API clients no way to populate that field.
- **Files:**
  - `packages/api/v1/schema.ts` — additive optional field.
  - `packages/api/v1/create-document-meta.ts` — tested create-input-to-envelope
    metadata mapper used by the implementation.
  - `packages/api/v1/implementation.ts` — persists the parsed value through
    `createEnvelope`.
  - `packages/api/v1/schema.test.ts` and
    `packages/api/v1/create-document-meta.test.ts` — validation and persistence
    mapping coverage.
- **Remove when:** upstream exposes the same API v1 create field.

### 4. Storage-agnostic signed-PDF API — landed 2026-07-17

- **Behavior:** authenticated
  `GET /api/v1/documents/:id/download-data` returns the completed,
  single-item document as raw `application/pdf`. It resolves Documenso's
  `BYTES`, `BYTES_64`, and `S3_PATH` storage forms through the existing
  `getFileServerSide()` abstraction and enforces a bounded response size.
- **Why:** production uses Documenso's default database upload transport.
  Upstream's `/download` route only returns a presigned URL for S3, so Biz
  Buddy otherwise cannot durably capture the signed PDF after a completion
  webhook.
- **Authorization:** the normal API v1 bearer middleware authenticates the
  token user/team and the endpoint additionally requires the returned
  document's `teamId` to equal that token team exactly. Non-completed,
  multi-item, oversized, invalid, and cross-scope documents fail closed.
- **Files:**
  - `packages/api/v1/contract.ts` and `packages/api/v1/implementation.ts` —
    additive binary endpoint.
  - `packages/api/v1/download-document-data.ts` — storage-agnostic bounded
    loader.
  - `packages/api/v1/download-document-data.test.ts` — completed, auth-scope,
    lifecycle, item-count, size, and content validation.
- **Remove when:** upstream exposes an equivalent storage-agnostic signed
  document download API.

## Planned Patches

(none — all patches are active and documented above)

## Maintenance discipline

- Every Documenso upstream release → rebase `p5/patched` against `main`. See Coolify fork's docs for the targeted-rebase-per-file workflow we use to avoid clobbering both upstream changes AND our patches.
- New patches go in their own commit on `p5/patched` with a clear rationale in this doc.
- The `p5/patched` source tree plus this manifest are the source of truth for
  which patches are baked into the image. `Dockerfile.p5` is only a marker; the
  workflow builds the patched checkout with upstream's `docker/Dockerfile`.
- License: AGPLv3. Same as upstream Documenso. Self-hosted modified version → must offer source to network users → this repo IS the public source.

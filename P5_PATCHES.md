# Parallel Five — Custom Documenso Image

This fork exists to maintain a patched Documenso image for the Parallel Five biz-buddy ↔ Documenso integration. Pattern matches our `parallelfive/coolify` fork — same workflow, same maintenance discipline.

## Why

Documenso v1.12.10's public REST API only covers `/documents` and
`/templates`. Org / User / branding / signing-URL-prefix surfaces are
internal-only (tRPC, no OpenAPI). The fork retains the admin REST patch for
operator compatibility, but production Biz Buddy now deliberately uses one
locked Documenso service team: Biz Buddy workspace authorization is the tenant
boundary and the provider API token's exact team is the service boundary.

- **Legacy admin provisioning compatibility** — retained until the obsolete
  per-workspace provider-organisation flow is fully removed
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
- **Why:** upstream's `/download` route only returns a presigned URL for S3,
  while existing/fallback rows may use database storage. Biz Buddy needs one
  bounded authenticated endpoint that can durably capture the signed PDF
  regardless of transport. Production is pinned to S3 for new uploads.
- **Authorization:** the normal API v1 bearer middleware authenticates the
  token user/team and the endpoint adds that exact team to the database
  predicate. Non-completed, zero/multi-item, oversized, invalid, and
  cross-scope documents fail closed.
- **Existing terminal-status GET:** the public
  `GET /api/v1/documents/:id` route also adds the authenticated token team to
  its database predicate and repeats the exact-team check before returning
  recipients. It is the sole integration response that exposes the nullable,
  signer-authored rejection reason, validated through the shared 2 KiB UTF-8
  bound; webhook/job evidence remains reason-free. Expected denial/not-found
  maps to 404; parse/database failures remain 500 instead of being disguised as
  absence.
- **Systemic API v1 team-token boundary:** every document-ID read/mutation
  (download URL, delete, send/resend, recipient CRUD, and field CRUD) and every
  template-ID read/mutation/use first resolves a capability-minimal exact-team
  reference containing only internal envelope ID, team ID, and secondary ID.
  Endpoint data is fetched only after that guard, downstream services receive
  the guarded immutable envelope ID, and recipient/field children must belong
  to the guarded path envelope. Document list queries add exact team before
  count/pagination and use an uncapped full count for external recovery walks,
  neutralizing both the product UI's intentional cross-team team-email branches
  and its 100-page look-ahead optimization. Template list count/pagination
  already applies exact team. The document-list response always includes the
  authenticated token's positive `teamId`, including for an empty list, and
  rejects any row whose team differs. Create-document returns that same
  authenticated `teamId` plus the persisted `externalId`; single-document,
  send, and delete responses also source `teamId` from the authenticated team
  instead of treating returned row data as the trust anchor. List ordering
  preserves the requested `createdAt` direction and adds `Envelope.id` in that
  same direction as a deterministic tie-breaker for recovery pagination.
- **Bounded loading:** the endpoint first selects only envelope lifecycle/item
  metadata and document-data ID/type. A raw SQL preflight reads DB octet length
  plus at most a two-character base64 suffix (or a bounded S3 key prefix)
  before any PDF string is selected. The second DB query repeats expected
  type/decoded-size predicates to close size races. S3 validates declared
  length when present, streams and cancels at the cap when absent or lying,
  and aborts stalled header/body reads after 15 seconds.
- **Release invariant:** with
  `NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT=50`, signed-document download is
  capped at 60 MiB (upload cap plus 10 MiB sealing headroom, globally clamped
  to 10–100 MiB).
- **Files:**
  - `packages/api/v1/contract.ts` and `packages/api/v1/implementation.ts` —
    additive binary endpoint.
  - `packages/api/v1/download-document-data.ts` — storage-agnostic bounded
    loader.
  - `packages/api/v1/get-document.ts` — exact-team lookup for the existing
    status/recipient endpoint used during terminal reconciliation.
  - `packages/api/v1/exact-team-envelope.ts` and
    `packages/api/v1/exact-envelope-child.ts` — capability-minimal API token
    team and nested-resource boundaries.
  - `packages/api/v1/download-document-data.test.ts` — completed, auth-scope,
    lifecycle, item-count, pre-materialization/race size, S3-key, and content
    validation.
  - `packages/api/v1/get-document.test.ts` — cross-team owner/token denial and
    precise 404/500 mapping.
  - `packages/api/v1/schema.test.ts` — empty-list and wrong-team identity,
    create correlation/team identity, standard send `id`/`teamId`, and
    create-field wrapper-shape plus exact-GET-only bounded rejection-reason
    regression coverage.
  - `packages/api/v1/exact-envelope-child.test.ts` — cross-envelope recipient
    and field binding plus all-recipient resend binding.
  - `packages/lib/universal/upload/get-file.server.ts` and its focused tests —
    optional decoded-byte and timeout limits with exact/+1, missing/lying
    Content-Length, cancellation, and stalled-read coverage. Existing callers
    retain the historical default when limits are omitted.
- **Remove when:** upstream exposes an equivalent storage-agnostic signed
  document download API.

### 5. Capability-safe webhook history — landed 2026-07-17

- **Behavior:** the fork projects native document state into one strict,
  explicit lifecycle allowlist _before enqueue_. BackgroundJob, local/BullMQ
  queues, generic worker logs, first outbound callbacks, WebhookCall history,
  automatic retries, and manual resends all carry only: document
  ID/externalId/status/timestamps plus recipient provider
  IDs/roles/statuses/timestamps. Signer-authored rejection text is excluded;
  terminal consumers obtain it through the authenticated exact-team GET.
- **Why:** the native internal snapshot includes live recipient signing tokens,
  email/name, recipient/document auth options, form values, and email settings.
  Enqueueing it wrote those capabilities to PostgreSQL, Redis/BullMQ, stdout,
  team-visible webhook logs, and copy actions before any later redaction could
  help.
- **Excluded by construction:** duplicate legacy `Recipient` arrays, webhook
  shared secret, signing tokens and URLs, email/name, auth settings, form
  values, document metadata, rejection reason, and every future field not
  deliberately added to the strict projection.
- **Bounded fail-closed contract:** IDs are positive safe integers; lifecycle
  roles/statuses are native enums; external IDs and ISO timestamps are length
  bounded; recipient IDs are unique. Exact
  `bizbuddy:<validated envelope UUID>` snapshots allow at most 25 recipients,
  matching the integration boundary. Native snapshots have a finite
  1,000-recipient operational ceiling. Malformed reserved `bizbuddy:` IDs,
  unknown enums, invalid recipients, and 26/1,001-recipient snapshots are
  rejected before enqueue rather than silently weakened or partially
  delivered.
- **Fan-out and receiver evidence:** envelope mapping plus projection/strict
  parsing happens once inside the central boundary before fan-out. Discovery,
  mapping, projection, and enqueue failures return structured
  `{ matched, enqueued, failed }` evidence and are aggregated/logged without
  payloads or capabilities. They never turn an already-committed document
  transition into a false API/job failure or destructive retry. The
  trigger-only test action targets only the selected webhook and surfaces its
  projection/enqueue failure to the caller.
  Receiver response persistence reads at most 64 KiB under the same 10-second
  request deadline, cancels missing/lying-length overflow, stores only a small
  response-header allowlist, and redacts reflected shared secrets and
  authentication/cookie fields.
- **Outbound SSRF and confidentiality boundary:** production webhook URLs are
  parsed once, restricted to HTTPS, resolved fail-closed with a two-second
  deadline, and rejected if any DNS answer is private or IANA special-purpose.
  This includes mixed-answer, IPv4-mapped IPv6, benchmarking, documentation,
  translation, ORCHID, ULA, link-local, multicast, and metadata ranges. Plain
  HTTP is legal only for the narrowly scoped development bypass, which requires
  an exact normalized hostname (never a suffix), still requires DNS success,
  and returns the vetted address. The transport pins that address through a
  custom Node lookup while preserving the original Host header and TLS
  SNI/certificate verification, disables connection reuse, and never follows
  redirects. A rebinding between validation and connect therefore cannot change
  the destination, and lifecycle evidence plus the shared secret are not sent
  over cleartext public transport. Webhook create/edit services run this same
  asynchronous DNS-aware assertion before persistence. Their tRPC schema now
  performs syntax-only URL validation so it cannot preempt the exact configured
  local-development bypass with the legacy synchronous private-host check;
  unset/production behavior remains HTTPS/global-only. The Zapier subscription
  path authenticates its bearer before parsing or resolving the callback, so an
  invalid caller cannot use the resolver as a DNS/work oracle.
- **Transport resource bounds:** body streaming preserves Node backpressure and
  propagates cancellation when the 64 KiB persistence limit is crossed.
  Bodyless 204/205/304 responses are drained and persisted as `null`; malformed,
  oversized, and stalled responses close their sockets without retaining
  attacker-controlled error detail.
- **Adjacent capability hardening:** provider request logs normalize every
  `/sign/<bearer>` path to `/sign/[REDACTED]`. Rejection input is capped at
  2 KiB of UTF-8 at both the recipient schema and service boundary, while the
  safe webhook remains reason-free.
- **Retry contract:** automatic retries replay the same safe lifecycle body.
  New manual resends replay the stored safe evidence. Legacy full-body history
  is projected before it can be re-enqueued, so old capabilities are never
  reintroduced.
- **Files:**
  - `packages/lib/types/webhook-payload.ts` — strict lifecycle/evidence schemas,
    explicit projection, and safe legacy-resend adapter.
  - `packages/lib/server-only/webhooks/trigger/enqueue-webhook-delivery.ts` —
    sole `internal.execute-webhook` producer and the pre-enqueue boundary.
  - `packages/lib/server-only/webhooks/trigger/{trigger-webhook,handler}.ts` and
    focused tests — both current and legacy trigger paths use the boundary.
  - `packages/lib/jobs/definitions/internal/execute-webhook.handler.ts` —
    sends the safe lifecycle body and persists versioned safe evidence.
  - `packages/lib/jobs/definitions/internal/execute-webhook.handler.test.ts` —
    recursively proves safe first outbound and persistence.
  - `packages/lib/server-only/webhooks/execute-webhook-call.ts` — bounded,
    sanitized receiver response evidence and DNS-pinned Node HTTP(S) transport.
  - `packages/lib/server-only/webhooks/assert-webhook-url.ts` plus focused
    resolver/transport tests — fail-closed DNS, IANA special-purpose range
    policy, exact bypass behavior, TLS Host/SNI verification, and large chunked
    response cancellation. `ipaddr.js` is a direct runtime dependency so the
    address policy is not coupled to a transitive package.
  - `packages/lib/server-only/webhooks/{create-webhook,edit-webhook}.ts` and the
    tRPC webhook URL schema — asynchronous registration-time policy enforcement
    with exact local-bypass compatibility; Zapier subscription applies the same
    policy only after bearer validation.
  - `packages/lib/utils/redact-sensitive-path.ts` and the Remix/request logger
    call sites — signing-capability path redaction.
  - `packages/lib/types/rejection-reason.ts` — shared UTF-8 rejection-reason
    boundary.
  - `packages/trpc/server/webhook-router/resend-webhook-call.ts` — routes new
    and legacy rows through the same safe producer.
- **Remove when:** upstream stores capability-safe webhook history with
  equivalent pre-enqueue, delivery, retry, log, and persistence semantics.

### 6. Atomic Biz Buddy execution lease and lifecycle invariants — landed 2026-07-17

- **Dispatch lease:** a Biz Buddy-correlated send must include the exact
  normalized provider execution graph it just persisted:
  `externalId`, document `signingOrder`, recipients
  (`id/name/email/role/signingOrder`), and fields
  (`id/recipientId/type/page/positionX/positionY/width/height`), plus
  `expectedPdf.sha256` as exact lower-case SHA-256 hex and
  `expectedPdf.byteLength` as a positive safe integer. IDs are bounded, unique
  positive integers; recipient identity is trim/NFC/lowercase normalized;
  correlated recipient graphs contain 1–25 entries, and execution field graphs
  contain at most 1,000 entries. Arrays are canonicalized before comparison.
  Provider-only capabilities such as signing tokens can never enter the
  snapshot.
- **Exact PDF byte binding:** before claiming a correlated draft, the provider
  bounded-reads the single V1 source item under the configured upload cap and a
  30-second end-to-end deadline, then compares the exact raw byte length and
  SHA-256. A mismatch returns 409 before any snapshot or database mutation.
  Matching bytes are copied with server credentials to a fresh random,
  internal-only object/`DocumentData` row whose key is never disclosed through
  the client upload API. The locked lease reread binds both envelope-item ID and
  original document-data ID; in the same `DRAFT → PENDING` transaction it swaps
  that exact item to the fresh snapshot. Both ordinary signer dispatch and the
  immediate no-action seal branch commit the swap before email/webhook/job
  enqueue. Replaying the original one-hour presigned PUT can therefore alter
  only the orphaned upload key, never the bytes later sealed or signed.
- **Snapshot failure cleanup:** the snapshot-specific upload path reserves a
  durable cleanup intent before `PutObject`, binds it atomically to the fresh
  `DocumentData`, and releases exactly one bound intent in the successful item
  swap transaction. A losing/replayed send converts its unreferenced snapshot
  to the same durable cleanup path described in patch 8. Process death at any
  point from key allocation through attachment therefore leaves either no
  object or a recoverable intent. Generic/native upload behavior is unchanged.
- **Atomic claim:** send changes `DRAFT` to `PENDING` with an exact-team,
  document-type, exact-external-ID, draft-only predicate. In the same database
  transaction it rereads the current external ID, team, signing order,
  recipients, fields, item ID, and document-data pointer, then compares the
  lease before audit logs, email settings, field insertion, recipient state, or
  snapshot attachment can change. A mismatch rolls the transaction back with 409. Generic API v1 sends use the same atomic draft claim; a native path
  cannot dispatch a `bizbuddy:` document without the lease.
- **Reserved correlation namespace:** `bizbuddy:` is case-insensitively reserved
  to the dedicated API v1 direct-document create path, which may mint only the
  canonical `bizbuddy:<UUID>` form. Native document/template creation,
  template generation/use, direct templates, updates, and alternate casing
  cannot adopt the namespace. The correlated external ID cannot later be
  changed or removed. Creation, lifecycle classification, callbacks, and strict
  webhook projection share the same lowercase UUID-v1-through-v8 validator, so
  no provider-valid correlation can later become an undeliverable webhook.
- **Creation-time execution freeze:** correlated envelope/document metadata,
  source items/PDFs, item title/order, and attachments are immutable from
  creation, not merely after dispatch. Native item routes, embedding updates,
  attachment routes, and admin recipient edits reject before uploads or
  mutations. Because Biz Buddy V1 does not use attachments, document-level
  authentication, or form values and the execution lease intentionally omits
  those signer-visible graphs, correlated API v1 create rejects every nonempty
  attachment, document-authentication setting, or defined form-value map before
  issuing an upload URL or creating provider state. It also rejects
  `allowDictateNextSigner: true` and forces the persisted value off as a
  defensive create-path invariant. The recipient-completion mutation sink
  independently ignores that flag for every correlated external ID, so a
  historical or corrupt row cannot let a signer replace the next recipient's
  frozen name/email after dispatch.
- **One-time recipients and create-only fields:** direct create performs exactly
  one correlated recipient population while the graph is empty. The draft lock
  repeats both the exact external ID and a no-recipient predicate, then recounts
  recipients after acquiring the row lock so concurrent initial writers cannot
  both win. Recipient append/update/delete and replacement are rejected from
  then on. The shared execution profile requires 1–25 initial recipients,
  normalized nonempty names of at most 500 characters, and normalized valid
  emails of at most 320 characters. They must all be `SIGNER`s, cannot carry
  access/action authentication, and may use only null or positive integer
  signing-order cohorts. Coordinate-based field creation remains legal only
  for `SIGNATURE` fields with positive integral pages, finite coordinates,
  finite positive dimensions, and no caller-provided metadata, custom text,
  inserted state, or placeholder while `DRAFT` under the same exact-ID lock.
  After acquiring that lock, each writer recounts fields and rejects a batch
  that would push the immutable execution graph above 1,000 before creating any
  row. Field update/delete/editor replacement and placeholder/auto-placement
  writes are rejected from creation. Native document behavior is unchanged.
  This preserves the exact Biz Buddy create flow while eliminating stale-draft
  and omitted-subgraph races.
- **Cancellation:** API v1 cancellation is legal only from `DRAFT` or
  `PENDING`. The delete predicate repeats that status condition atomically; a
  completion/rejection race returns 409 and sends no cancellation webhook or
  email. The shared delete service enables this strict predicate automatically
  for every correlated external ID, including native document/envelope and
  bulk-delete callers that do not pass the API option. Native UI deletion
  retains its prior behavior for non-integration documents.
- **Reminder eligibility and linearization:** API v1 resend accepts only current
  unsigned non-CC recipients while the document is `PENDING`. Parallel
  documents permit any such recipient; sequential documents permit only the
  lowest active signing-order cohort. Eligibility is reread immediately before
  mail delivery so a cancellation that wins first produces no message. The
  shared resend service enables both checks automatically for every correlated
  external ID, including native redistribute callers. Once mail succeeds, a
  later audit-write failure is logged without payloads and is not returned as
  a false failure that could duplicate delivery.
- **Recovery responses:** exact-team document GET includes the validated native
  signing order used by the lease. Single-document, send, delete, and nested
  mutation responses retain `folderId` where the public contract promises it.
  All stale-state and concurrent-transition failures use the shared 409
  `CONFLICT` mapping.
- **Files:**
  - `packages/lib/types/document-execution-profile.ts` — shared correlated
    recipient, identity, and field representability limits used at creation,
    lease, and webhook boundaries.
  - `packages/lib/types/document-execution.ts` — bounded, capability-minimal
    canonical graph/PDF lease schema and comparator.
  - `packages/lib/server-only/document/send-document.ts` and
    `with-document-draft-mutation-guard.ts` — bounded raw-byte verification,
    fresh internal snapshot, transactional item swap/draft claim, locked
    reread, cleanup, and reusable graph-mutation guard.
  - `packages/lib/server-only/envelope/assert-bizbuddy-external-id-authorized.ts`
    and `packages/lib/constants/app.ts` — canonical namespace ownership and
    case-insensitive lifecycle classification.
  - `packages/lib/server-only/{recipient,field,envelope,document-meta,envelope-attachment}/`
    mutation services and correlated creation-profile guards plus native
    envelope/embedding routes — creation-time execution/content freeze and
    one-time population boundary.
  - `packages/lib/universal/upload/{server-actions,put-file.server}.ts` — fresh
    server-credential snapshot upload using an undisclosed random key plus the
    pre-Put durable reservation and atomic metadata binding from patch 8.
  - `packages/lib/server-only/document/{delete-document,resend-document,complete-document-with-token}.ts`
    — automatic correlated cancellation/reminder strictness and the historical
    next-signer identity-mutation sink boundary.
  - Focused execution, immutability, send, cancel, resend, API-schema, and
    response tests cover byte/digest mismatch, original-presign replay,
    item-pointer races, both send branches, cleanup reference guards,
    mismatch rollback, double-send, terminal races, namespace minting, and
    native/admin/embedding/attachment bypass attempts, native lifecycle-route
    bypasses, and historical correlated next-signer metadata.
- **Remove when:** upstream offers an equivalent exact-graph idempotency lease,
  atomic lifecycle transitions, and post-dispatch execution immutability across
  both REST and native mutation paths.

### 7. Garage-compatible presigned PUT checksums — landed 2026-07-17

- **Why:** the AWS SDK's default `WHEN_SUPPORTED` request-checksum policy adds
  an optional CRC32 to `PutObject`. When the command is presigned without a
  body, the URL binds `x-amz-checksum-crc32=AAAAAA==` for an empty object.
  Garage correctly rejects a later nonempty PDF sent through that URL with
  `InvalidDigest`.
- **Behavior:** the shared S3 client now calculates request checksums only when
  an operation requires one. `PutObject` presigns no longer contain checksum
  query parameters, while SigV4 still uses `UNSIGNED-PAYLOAD` and direct
  server-side uploads still send the exact nonempty body. Response checksum
  validation retains the SDK default `WHEN_SUPPORTED` policy.
- **Files:**
  - `packages/lib/universal/upload/server-actions.ts` — explicit
    `requestChecksumCalculation: 'WHEN_REQUIRED'`.
  - `packages/lib/universal/upload/server-actions.test.ts` — real SDK presign
    and loopback HTTP upload coverage for both PUT-presign entry points and
    direct body uploads.
- **Remove when:** upstream exposes an equivalent body-less `PutObject`
  presigning policy, or the AWS SDK no longer derives optional payload
  checksums from an absent body.

### 8. Durable document-data and object retirement — landed 2026-07-18

- **Why:** deleting a draft or pending envelope cascaded `EnvelopeItem` rows
  but left their `DocumentData` rows and S3 objects. Correlated atomic send also
  replaced the client-upload source with an immutable snapshot without
  retiring the now-unreferenced source. A successful API cancellation could
  therefore return 404 for the envelope while retaining both source and
  snapshot PDFs.
- **Transactional retirement:** hard delete locks the envelope and its current
  items, repeats the legal-state delete predicate, then in the same transaction
  stages every unique S3 key, deletes every now-unreferenced `DocumentData`
  row, and commits the cancellation. Atomic send stages the detached source in
  the snapshot-attach transaction. Database-backed `BYTES`/`BYTES_64` content
  is deleted with its row and is never copied into the key-only outbox.
- **Crash-safe internal snapshots:** the internal-only upload allocates its
  random key, durably reserves a non-early cleanup intent, and only then starts
  `PutObject`. Snapshot metadata creation atomically binds that intent.
  Successful attachment must release exactly one bound intent in the item-swap
  transaction or the swap rolls back. A process death before upload, after
  upload, after metadata creation, or before attach is therefore recoverable;
  the sweeper retires only a still-unattached provisional row. The internal
  upload has a five-minute end-to-end post-reservation deadline, safely inside
  the 15-minute attach grace; a hung upload aborts while its intent remains.
  Generic/native server uploads retain their existing request behavior.
- **Replay-safe deletion:** client upload presigns remain valid for one hour.
  Source/cancellation tasks perform an immediate idempotent `DeleteObject` but
  retain their intent for 65 minutes, then perform a mandatory final delete.
  A replay after the early delete cannot resurrect retained bytes. Concurrent
  extensions use guarded predicates and can never shorten or lose the later
  final-delete obligation.
- **Reference and race safety:** every physical delete rechecks both
  `DocumentData.data` and `initialData`. Shared keys are deferred, attached
  provisional snapshots cancel stale intents, item/status transitions are
  row-locked, and outbox acknowledgement repeats the selected `notBefore`
  predicate. DeleteObject is idempotent, so worker/acknowledgement races safely
  repeat. No key or PDF content is emitted to logs.
- **Durable retry:** cleanup runs synchronously after commit for prompt
  retirement but never turns a committed send/cancellation into a false
  rollback. Failed tasks retain attempt metadata and a bounded,
  four-concurrent, 100-task cron sweep retries every 15 minutes. Each cleanup
  `DeleteObject` has a 15-second deadline; a timeout retains the task instead of
  hanging a committed API response or worker slot. The release migration, run
  while the provider is quiesced, backfills unique existing orphan S3 keys with
  the same replay window, skips keys still referenced by either column, and
  removes orphan database content.
- **Files:**
  - `packages/prisma/schema.prisma` and
    `20260718010000_add_document_data_storage_cleanup` — durable key-only
    outbox plus conservative orphan backfill.
  - `packages/lib/server-only/document-data/{stage,process}-document-data-storage-cleanup.ts`
    — transactional staging/locking, provisional reservation/binding/release,
    reference-safe DeleteObject, and guarded acknowledgement.
  - `packages/lib/server-only/document/{send-document,delete-document}.ts` —
    source retirement and native/API hard-delete integration.
  - `packages/lib/universal/upload/{server-actions,put-file.server}.ts` —
    pre-Put key reservation hook and internal snapshot binding.
  - `packages/lib/jobs/definitions/internal/cleanup-document-data-storage*` —
    bounded durable retry sweep.
  - Focused unit tests plus the opt-in PostgreSQL/real AWS SDK loopback test
    cover migration backfill, no payload copying, source/snapshot success,
    pre-Put and post-bind process death, replay after early delete, final
    delete, shared `data`/`initialData`, missing intent rollback, storage
    failure, and concurrent cutoff/acknowledgement races.
- **Remove when:** upstream transactionally retires unreferenced document data
  and every backing object across native/API lifecycle paths with equivalent
  crash recovery, presign-replay protection, reference guards, bounded durable
  retry, and secret-safe observability.

## Planned Patches

(none — all patches are active and documented above)

## Release-enabling baseline repairs

- The repository's existing
  `patches/@ai-sdk+google-vertex+3.0.81.patch` adds the Express-mode `apiKey`
  type and `x-goog-api-key` runtime behavior consumed by
  `packages/lib/server-only/ai/google.ts`. Docker/clean `npm ci` applies it
  through `postinstall: patch-package`. A reused checkout can have stale,
  unpatched `node_modules` and produce a false `apiKey` type error; run the
  repository postinstall before any release typecheck. Never “fix” that drift by
  removing `apiKey`, which silently disables the documented production auth
  path.

## Maintenance discipline

- Every Documenso upstream release → rebase `p5/patched` against `main`. See Coolify fork's docs for the targeted-rebase-per-file workflow we use to avoid clobbering both upstream changes AND our patches.
- New patches go in their own commit on `p5/patched` with a clear rationale in this doc.
- The `p5/patched` source tree plus this manifest are the source of truth for
  which patches are baked into the image. `Dockerfile.p5` is only a marker; the
  workflow builds the patched checkout with upstream's `docker/Dockerfile`.
- License: AGPLv3. Same as upstream Documenso. Self-hosted modified version → must offer source to network users → this repo IS the public source.

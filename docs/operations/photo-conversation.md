# Contextual photo conversation

Status: implemented behind `MESSENGER_PHOTO_CONVERSATION_ENABLED=true`; not yet
verified with the real model or deployed. The normal rollback value is `false`.
This adds a photo assistant to the direct Messenger runtime. It does not restore
OpenClaw or change Mollie, wallet, image quality, or owner test mode.

## Behavior and boundaries

- Ordinary text and descriptive photo captions use recent conversation and a
  catalog of up to four private uploaded/generated images. A new upload retains
  the preceding generated result. Twelve text turns of at most 4,000 characters
  each are retained in the existing exact Page/user/binding/privacy state.
- The assistant can discuss ideas, react to comments, acknowledge criticism and
  ask a specific clarification. The model returns only `reply`, `generate` or
  `edit`; edit sources must be existing server-owned image IDs. The server freezes
  exactly those sources into the normal generation job.
- Chat does not reserve image credits. All generation uses existing quota, paid
  admission, provider, delivery and retry boundaries. The assistant cannot set
  price, credits, quality, provider parameters, or account settings.
- Privacy commands, owner commands and explicit new-image resets stay in server
  control. Existing consent and video capability gates remain in place.
- Every model call validates consent, full scope, live Page binding and privacy
  epoch. Only owned storage objects can be downloaded for vision. Unavailable
  images are marked unavailable; the model cannot select them. Raw messages,
  prompts and image bytes never enter operational logs.
- Text turns serialize through a Redis lease scoped to the entire conversation
  subject. Concurrent resets/uploads invalidate stale decisions. The UI asks for
  another attempt rather than executing against changed images.
- A durable provider attempt fence permits one model transport per webhook event.
  Up to six pending/completed decisions are kept in the scoped state. A dispatch
  failure can replay its saved decision through the existing idempotent queue or
  sender; completion is recorded only after acceptance. A bookkeeping failure
  after acceptance never tells the user to start another generation. New-image reset and
  erasure discard this cache. Ambiguous model responses are not retried automatically. Malformed or incomplete
  decisions never fall through to legacy generation heuristics. A crash between
  receiving a model response and caching its decision is outcome-unknown: the
  provider fence stays closed and a new user request is required. Duplicate and
  erased turns explicitly suppress the generic webhook failure fallback.
- Context uses the existing state lifetime (normally 48 hours after activity;
  optional consented face memory can extend that state TTL). New-image clears it;
  delete-my-data erases text and retained image references, preserving only failed
  object-deletion references for cleanup retries. Existing object retention still
  applies, so an older image can require re-upload.

## Provider and economics

The pinned model is `gpt-4.1-mini-2025-04-14`. The Responses request uses
`store: false`, strict JSON schema output, no tools and an 800-token output cap.
Images are supplied as data URLs after scoped storage validation, with an 8 MiB
per-image bound and at most four images. There is one 12-second model transport;
there are no automatic model retries.

Pricing is fixed alongside the model: $0.40 per million input tokens and $1.60
per million output tokens. Admission conservatively reserves UTF-8 text bytes
plus framing and 2,500 tokens per image, with output reserved separately. Actual
usage is recorded when returned. Existing global daily/monthly and per-user
spend caps apply, including to the owner. Rollback does not remove ledger entries.

References: [model and pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini),
[structured output](https://developers.openai.com/api/docs/guides/structured-outputs),
[vision token accounting](https://developers.openai.com/api/docs/guides/images-vision).

## Verification and rollout

Run from `apps/image-gen`:

```sh
pnpm check
pnpm test
pnpm build
```

`server/photoConversation.test.ts` drives the real text router and feature
registry with a stubbed model transport. It covers generated animal + uploaded
person, ordinary combine synonyms, criticism, courtesy, missing images, overlapping
turns, stale context, duplicate provider claims, spend rejection, scope/consent
failures and erasure. Adjacent router/job/deletion tests cover captions, exact
queued source selection, intentional fallback suppression and cleanup retry.
These tests prove wiring and fences, not the real model's language quality.

Before enabling, run a consented synthetic-image conversation through the actual
model, including a vague complaint (no generation), a creative question (no
generation), and an explicit two-image composition (both correct sources).
Use the protected immutable build/manifest/deployment workflow. Verify the flag,
health, readiness and exact release identity independently. Leave Mollie Test
Mode and the existing commercial authorization epoch unchanged. Roll back through
the reviewed deployment path with the flag disabled; do not change financial rows.

# Contextual photo conversation

Status: implemented behind `MESSENGER_PHOTO_CONVERSATION_ENABLED=true`. The
pinned model passed the bounded real-model evaluation and independent semantic
review on 2026-09-16. Protected activation/readback and a consented Messenger smoke
remain open; this feature has not been deployed. The normal rollback value is
`false`. See [evaluation evidence](photo-conversation-evaluation-2026-09-16.md).
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

The pinned model is `gpt-5.4-mini-2026-03-17`. The Responses request explicitly
sets `reasoning: { effort: "low" }`, `store: false`, strict JSON schema output,
no tools and a 2,048-token output cap, including reasoning tokens. Images are
supplied as data URLs after scoped storage validation, with an 8 MiB per-image
bound and at most four images. There is one 20-second model transport; there are
no automatic model retries.

Pricing is fixed alongside the model: $0.75 per million input tokens and $4.50
per million output tokens. Admission conservatively reserves the complete request
and schema's UTF-8 bytes (excluding image data URLs), plus framing and 3,100 tokens
per image, with output reserved separately. GPT-5.4 mini's `auto`/`high` vision
budget is at most 2,500 patches multiplied by 1.2, or 3,000 tokens; the reservation
includes additional margin. Actual usage is recorded when returned. Existing
global daily/monthly and per-user spend caps apply, including to the owner.
Rollback does not remove ledger entries.

The earlier `gpt-4.1-mini-2025-04-14` and `gpt-4.1-2025-04-14` variants failed
semantic review. Failures included guessing unspecified source pairs, reverting
to an older goal after criticism, and executing an ambiguous reference instead of
asking which subjects were intended. Correct action/source fields alone did not
prove a useful conversation. The current pinned model subsequently passed both
suites (20/20 automatic checks) and separate semantic review;
[the evidence record](photo-conversation-evaluation-2026-09-16.md) retains the
earlier failures and the limits of that result. Provider caps apply before every
conversation call; exceeding them fails closed rather than selecting a fallback
model.

References: [model](https://developers.openai.com/api/docs/models/gpt-5.4-mini),
[pricing](https://developers.openai.com/api/docs/pricing),
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

### Real-model synthetic evaluation

The runtime and evaluator use the same pure request builder, instructions and
strict decision parser in `photoConversationContract.ts`. Reference image blocks
keep their preceding ID labels in a separate context message. Validated recent
turns become real chronological `user`/`assistant` messages, followed by the current
user message; history is not duplicated inside the reference metadata. Prior image
context is explicitly separate from the user's current request.
Instructions resolve the latest clarification before selecting
sources, preserve unspecified subject details, and ask for missing original
sources instead of inventing replacements. Ordinary reactions can end naturally.

From `apps/image-gen`, a default dry run builds and checks the isolated bundle and
prints the complete cost admission plan. It makes no network request and needs no
key:

```sh
pnpm evaluate:photo-conversation
pnpm evaluate:photo-conversation --suite holdout
```

For an owner-authorized paid evaluation, review the runner and select one existing,
started Machine and its exact current reviewed runtime digest. Then run:

```sh
pnpm evaluate:photo-conversation --fly-machine MACHINE_ID --expected-image IMMUTABLE_IMAGE
pnpm evaluate:photo-conversation --suite holdout --fly-machine MACHINE_ID --expected-image IMMUTABLE_IMAGE
```

`MACHINE_ID` and `IMMUTABLE_IMAGE` are placeholders, not shell variables. The CLI
validates the app, ID, started state and full digest before SSH. It streams the
reviewed synthetic bundle to a one-shot Node process on that existing Machine.
It reads `OPENAI_API_KEY` inside Fly, never copies it locally, writes no remote
files, and does not create Machines, replace the app, deploy, or enable the feature.
Fly CLI authentication is required locally, but an OpenAI key is not.

The bundle has an explicit dependency allowlist and no database, storage, Redis,
Messenger or application entrypoint imports. It only sends the fixed synthetic
text and authored PNG illustrations to the fixed OpenAI Responses endpoint.
It never dispatches an image generation or writes provider, payment or wallet
rows. It is a separately budgeted operator text/vision evaluation, not a user
generation path or a bypass of that path's quota and spend fences.

Each suite pre-admits all ten calls within a $0.50 ceiling using conservative
text/schema/image/output token bounds; these requests enable no tools or image
generation. Each call has the runtime's 20-second timeout, explicit low reasoning,
and 2,048-token output limit including reasoning, a 64 KiB response bound,
`store: false`, and no redirects or retries.
Missing/invalid usage, a truncated response, or a transport failure stops the run.
SSH has a 240-second outer timeout. An uncertain run is **not automatically rerun**;
first inspect its available attempt/summary evidence. A failed semantic case is
recorded as a failure, not hidden by repeated sampling.

The regression suite covers the reported combination, complaint, subsequent
repair with a distractor, creative discussion, thanks, ambiguous references,
clarification answers, unavailable sources, new images and jokes. The holdout
suite varies wording, image order, and target subjects; it also checks a correction
like “Nee, de hond”, an edit that does not need the unavailable image, and an
explicit request to invent a new subject. That last pair guards against over-refusal.
It also includes the result context from the reported failure: a generated result
showing only the person remains in the catalog beside the original dog and person.
For this synthetic case, the failed-result fixture is pixel-identical to the person
fixture. Either person source may be selected together with the dog, but the
accepted edit contains exactly one dog source and one person source; selecting
both person copies or the entire catalog fails. This tests retained result context
without invoking the image provider.

Evidence contains bundle/suite hashes, the existing runtime identity, parsed
synthetic decisions, usage and outcomes. Never run this collector on customer
content. Automatic passes check action and exact source set. Separately review
the Dutch reply, subject preservation, source-role ordering and prompt consistency.
Authored illustrations test visual reference selection, not realistic-photo
fidelity or the rendered image. Model sampling and a finite suite do not prove
universal conversational correctness.

### Production activation

Both bounded synthetic suites and their independent semantic review passed on
2026-09-16; see [the evidence record](photo-conversation-evaluation-2026-09-16.md).
Protected activation and a consented Messenger smoke are still required. Use the
protected immutable build/manifest/deployment workflow. Verify the flag,
health, readiness and exact release identity independently. Leave Mollie Test
Mode and the existing commercial authorization epoch unchanged. Roll back through
the reviewed deployment path with the flag disabled; do not change financial rows.

# Conversation evaluation

Status: candidate implementation; runtime findings require a protected image-gen
release. The standalone collector can read existing technical signals before that
release. This is an operator diagnostic, not a customer feature.

## What it checks

- Technical findings: failed handling, unexpected lack of an accepted response,
  fallback replies, generation failures and delivery failures.
- Limited content rules: after existing consent, recognize short thanks, emoji
  and sticker acknowledgements; flag them when they lead to upload guidance or
  generation. Flag explicit image requests that receive only generic instructions.
- It does not use another model, retain transcripts, inspect photos, score output
  quality, or establish whether an entire conversation was correctly understood.
  A queued/accepted response is not proof of final Messenger delivery.
- Known intentional silence, consent gating, deletion controls and response-window
  limits remain part of the existing flow. No extra messages or provider work are
  started by the evaluator.

## Run the collector

With Node and authenticated Fly CLI available:

```sh
node apps/image-gen/scripts/evaluate-conversations.mjs \
  --state /private/operator-directory/monitor-state.json \
  --report /private/operator-directory/report.json
```

Set `FLY_BIN` if Fly is not at `/opt/homebrew/bin/fly`. The app is deliberately
fixed to `leaderbot-fb-image-gen`. The collector uses a private temporary Fly
configuration, removes it after the command and never prints CLI diagnostics.
Credentials and raw logs are not copied into reports or the repository.

Only allowlisted finding codes, timestamps, opaque request UUIDs and counts are
retained. Local evidence expires on each run after 24 hours and is capped at
20,000 records. Files are written with owner-only permissions. Run a single
collector at a time. Report/state files belong outside the repository.

`fly logs --no-tail` returns the current limited buffer, not all logs since the
previous check. Busy health traffic can crowd out conversation events. Hourly
snapshots are therefore a first warning aid, not continuous or complete coverage.
The report always marks this limitation; zero findings must never be presented as
proof that all conversations were reviewed. `contentCheck: not_observed` means
no consent-eligible rule results were observed, including before deployment.

The collector accepts NDJSON and concatenated pretty JSON. It fails on malformed,
truncated or oversized snapshots and preserves the previous evidence. An access
failure also preserves the previous files and exits unsuccessfully.

## Automatic checks and notification

A Codex heartbeat can invoke this command hourly and read its sanitized report.
It depends on the local Codex environment and Fly access being available.
Notify only for `newAlerts`, a new collection failure, or a meaningful recovery
from a previously reported collection failure. Unchanged/non-actionable runs
remain quiet. Do not infer recovery merely because old evidence expired.

A definitive dead-lettered generation or a social message starting a generation
is actionable immediately. Other findings require at least three observations
in 24 hours. Overlapping snapshots are deduplicated. A previously alerted pattern
alerts again when it doubles with newer evidence or persists into a later day.
These are diagnostic thresholds, not claims of root cause. Unsupported media and
response-window blocks can be expected behavior.

The monitor must not send customer messages, change prompts, modify billing,
merge changes or deploy fixes. A notification describes the observed count,
limited coverage and a concrete next diagnostic step.

## Release and rollback

Validate the image-gen test suite, TypeScript, changed-server formatting/lint,
application build and production deployment contract. Deploy only through the
existing protected production workflow and immutable artifact review.
After release, use a consented test conversation to demonstrate a successful
request and a courtesy; verify metadata-only evaluation events, unchanged
response behavior, no extra provider work or credit use, and runtime readiness.
The separate emoji/courtesy fix is independent; this evaluator reports behavior.

Rollback the runtime through the existing reviewed rollback-image procedure.
Pause the heartbeat to stop local collection. No database migration or customer
state change is introduced; the local report and state can be removed to erase
collected diagnostic metadata.

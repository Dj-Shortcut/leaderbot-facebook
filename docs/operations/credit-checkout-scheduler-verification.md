# Credit checkout scheduler verification — 2026-09-15

## Production readback

Checked at `2026-09-15T19:16:30.906Z` using the existing
`buildTestPaymentActivationAuditQuery(1)` and
`inspectCommittedTestPaymentActivation()` from
`scripts/image-gen-test-payment-activation-audit.mjs`.
The validator checked the committed audit, exact original operator provenance
against GitHub, then repeated the database readback.

- Workspace **1**, mode **test**: commercial control enabled, authorization epoch **2**.
- Outbox, reconciliation, profile expiry and AI finalization: enabled, execution epoch **2**.
- Original request: `8a62f93d-e092-4dd8-82ca-9e77bdd89d54`;
  [operator run 34581138362, attempt 2](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34581138362/attempts/2).
- All four running Machines retained `MOLLIE_MODE=test`,
  `MOLLIE_BILLING_ENABLED=false`, `MOLLIE_LIVE_BILLING_ENABLED=false`, and empty
  `MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID`, `MOLLIE_CREDIT_TEST_BINDING_EPOCH`,
  `MOLLIE_CREDIT_TEST_PRIVACY_EPOCH`, `MOLLIE_CREDIT_TEST_USER_KEY_HASH`.
- Runtime image: `sha256:4b211aa3d68a7599bd3f18f4d166b9223f442332ff02528a99daa180b7d9afbd`.
- Readback used app Machine `7845613ae14518` and its existing restricted runtime
  database connection. The temporary query bundle was checked locally/remotely
  against SHA-256 `40129bb04190e4420bca1e0d6a58607599792b9294a04c2fed48ba7d9eef8f6c`,
  removed, and its absence verified.
- Public `/healthz` returned `ok`; `/readyz` returned `ok: true`, phase
  `operational`, with every reported check passing.

No recovery mutation was necessary. No payment, intent, wallet or
provider-operation row was edited, and no provider request was made.
This snapshot does not establish that a scheduler mismatch caused an earlier
checkout failure. The reservation guard below prevents that state from issuing
new checkout links whenever it is observed.

## Code and local regression evidence

`readCreditCheckoutAuthorization()` now joins the workspace/mode's outbox row
and requires both enable flags and exact positive authorization/execution epoch
agreement. `creditCheckoutProviderStore.isActiveBoundary()` is unchanged, so a
change after reservation still encounters the final provider/retry fence.

- The store/service regression rejects missing, disabled, stale/future,
  ambiguous and invalid-epoch states before wallet access or CTA reservation.
- The MySQL HTTP journey uses a second canonical `u2.k1` Messenger user on the
  same owner/Page with all retired tester pins empty. It exercises reservation,
  capability claim, session read and `/confirm` with the real stores and a
  stubbed Mollie client. Browser contract tampering and immediate confirmation
  replay are rejected. Only one payment is created for EUR 4.99, one-off, with
  no customer/subscription/mandate. Three provider-confirmed paid webhooks reach
  the real persistence and wallet grant routine, leaving one eight-credit grant
  and the first user's wallet at zero.
- Missing, disabled and stale-epoch MySQL cases issue no CTA, create no wallet,
  intent or provider operation, and never call Mollie. Enabled rows in another
  workspace/mode or scheduler kind do not authorize them.
- Those three cases fail against the original reservation store because it
  returns a checkout link; they pass with the guard applied.

Validation: application TypeScript check; 2,803 non-MySQL tests passed
(172 database/environment-gated tests skipped); 18 payment MySQL tests passed
on a disposable, case-sensitive MySQL 8.4.11 database bootstrapped through all
19 migrations (0000–0018); production deployment contract validated; bundled
`build:docker` build passed. This is a local bundle build, not a Docker image
attestation or deployment. A supplemental type-check that explicitly included
test sources reported five pre-existing errors in the older MySQL helper/tests;
running it against the unchanged baseline reproduced the same diagnostics.
The repository's required application TypeScript check passed.

The code change still needs deployment. These tests and the production
scheduler readback do not prove a real Messenger checkout/payment or paid image
delivery; the P3/P4 journey gates remain open in `todo.md`. Rollback of this
change is a code revert with no schema/config or financial-data rollback.

## Guard runtime release preparation (2026-09-16)

Trusted build [35061070978](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/35061070978)
produced runtime `sha256:e0b82c21ceca12130a892afd01b90cf83fcb3b7a42a2721a9c424a76f1d6f1cf`
from reviewed main `f139c0c688369b605528975481eb2f0fa4626417`, including the
reservation guard and second-user route-to-provider regression from PR #555.
The runtime remains on schema `0018_credit_checkout_reservation`.

Fresh read-only inspection verified settled predecessor
`deploy-34969598237-1` / `sha256:4b211aa3d68a7599bd3f18f4d166b9223f442332ff02528a99daa180b7d9afbd`.
The manifest retains both its exact exposed restore configuration and a dark
emergency rollback configuration. No runtime environment settings change.

The existing audited activation readback again verified commercial control and
all four scheduler lanes enabled at epoch 2, including outbox. It verified the
original activation provenance, then removed and checked removal of the
temporary audit bundle. All four running Machines retained Test Mode, closed
legacy/live billing and empty retired tester pins. No scheduler repair was
necessary; no payment, intent, wallet or provider-operation row was edited.

This records release preparation, not deployment or a paid user journey.
After protected rollout, a real Messenger Test payment and metadata-only
webhook/grant readback are still required. The operator will arrange an eligible
Messenger user; no tester registration or personal checkout link is needed.

## Repository rename release gate (2026-09-16)

Release PR #560 merged at `c81c21bfbd7c501b97aa6b3a23b749519cff5d05` after
all required checks passed. Deployment
[35062693238](https://github.com/Dj-Shortcut/leaderbot-facebook/actions/runs/35062693238)
was canceled during validation when the intentional repository rename was
detected. No product deployment or payment mutation occurred. All four Machines
remained on `deploy-34969598237-1` / `sha256:4b211aa3d68a7599bd3f18f4d166b9223f442332ff02528a99daa180b7d9afbd`.

The rename-aware audit was checked against production using the existing
metadata-only readback: original activation provenance verified, commercial
control and all four lanes enabled at epoch 2, and temporary bundle removal
verified. Immutable request/fingerprint and Test-only flags were unchanged.
The release gate now binds current API metadata to repository ID `1238456123`
and retains each existing artifact's original signed repository name.

Protected deployment and the actual Messenger Test payment-to-grant journey
remain open until their separate evidence is recorded.

# Photo conversation evaluation — 2026-09-16

## Result and boundary

The pinned `gpt-5.4-mini-2026-03-17` candidate passed **20/20 automatic action and
source-set checks**, across the ten-case regression suite and ten-case variant
suite. An independent reviewer agent separately read all twenty actual responses
and passed the bounded semantic review: intended task, conversational context,
source roles, ambiguity, unavailable sources and requested transformations.
This closes the real-model synthetic evaluation gate for this candidate.

The final two runs used **$0.045537** of tokens at the pinned Standard rates:
$0.02238825 for regression and $0.02314875 for variants. These amounts are computed
from returned usage, not an invoice or the cost of the whole investigation.

**This was an ephemeral operator test, not a deployment.** Protected activation,
release readback and a consented Messenger smoke remain open. The deployed
application image and feature flag were not changed by these evaluations.

Final evidence:

- [Regression JSONL](evidence/photo-conversation/2026-09-16-gpt54mini-regression.jsonl)
- [Variant/holdout JSONL](evidence/photo-conversation/2026-09-16-gpt54mini-holdout.jsonl)
- [Runtime contract and procedure](photo-conversation.md)

## Executed contract

Both suites used the same request builder, instructions, strict decision parser
and complete-request cost bound as the application. The evaluated contract pins:

| Setting | Value |
| --- | --- |
| Model | `gpt-5.4-mini-2026-03-17` |
| Reasoning | Explicit `low` |
| Maximum output | 2,048 tokens, including reasoning |
| Request timeout | 20 seconds; one attempt, no automatic retry |
| Standard token rates | $0.75/M input; $4.50/M output |
| Vision reservation | 3,100 tokens per available image |
| Provider storage/tools | `store: false`; no tools |
| Suite admission | Ten fixed calls; maximum $0.50 per suite |
| Reserved amount | $0.2120325 regression; $0.214767 variants |

The final model comparison retained the conversation instructions, chronological
message roles, response schema and strict parser. It changed the pinned model,
reasoning setting and documented token/time/economic limits. The same regression
and variant scenarios were used, including the ambiguous references that earlier
models failed. The suites were not repeatedly sampled until individual cases
passed; complete runs and earlier failures are reported below.

References: [model](https://developers.openai.com/api/docs/models/gpt-5.4-mini),
[pricing](https://developers.openai.com/api/docs/pricing),
[vision accounting](https://developers.openai.com/api/docs/guides/images-vision).

## Runtime identity and artifact hashes

Both final runs used the existing `leaderbot-fb-image-gen` Machine
`d895355a1e6178`, whose verified image was:

```text
registry.fly.io/leaderbot-fb-image-gen@sha256:532e974166413faf86917800bbd83831d031ee23c71542bb24d411c5f9e9ea93
```

| Suite | Executed bundle SHA-256 | Planned suite SHA-256 |
| --- | --- | --- |
| Regression | `fbc3c44f31837e4fb296fa243e35f77fa2afe389849fb3fbe95340cf11c880ca` | `04319d9deb3eadf25d773949fbc2e362c5f016f58a88ef42a8afe4a1d7ed2d3c` |
| Variants | `341640855717fa91563866d4ea4141fffe40f90d8446a8a376704323e010cb85` | `426fd71474d9bce10c0c4d9becac75c2747bef463b0968b4975b1afacc48a0bb` |

The isolated bundle was streamed through SSH to a one-shot Node process. The
existing `OPENAI_API_KEY` was used inside Fly; its value was not exported locally.
No remote files, new Machines, app-image replacement or feature activation were
needed. The allowlisted bundle imports no database, storage, Redis, Messenger or
application entrypoint. It does not write application provider-operation,
payment, intent or wallet rows and never dispatches image generation.

## Earlier pilots, including failures

Run labels below correspond to the original local `photo-conversation-*.jsonl`
artifacts. “Automatic” checks only the parsed action and permitted source set;
a green automatic result alone does not close the semantic gate.

| Run label | Model | Completion | Automatic result | Material finding |
| --- | --- | --- | --- | --- |
| `real-model-evaluation` | GPT-4.1 mini | All 10 cases returned | 7/10 | Guessed an ambiguous pair, lost a confirmed pair, and invented a replacement for an unavailable source. |
| `real-model-revised` | GPT-4.1 mini | Aborted on attempt 3; 2 parsed cases | 2/2 observed | Pose drift remained. Third-attempt response/usage outcome was not captured by the original error sanitizer. |
| `real-model-holdout` | GPT-4.1 mini | Aborted on attempt 1 | No parsed cases | Strict decision validation rejected the response; returned usage was recorded. |
| `real-model-final-regression` | GPT-4.1 mini | Aborted on attempt 3; 2 parsed cases | 2/2 observed | Opaque source ID leaked into the edit prompt; parser rejected it. Earlier output also confused original photo positions and selected-source order. |
| `model-contract-regression` | GPT-4.1 mini | All 10 cases returned | 9/10 | Still guessed a pair when three sources were plausible. |
| `gpt41-regression` | GPT-4.1 | All 10 cases returned | 10/10 | Semantic review failed: criticism caused a return to the older dog-only goal. |
| `roles-regression` | GPT-4.1 | All 10 cases returned | 10/10 | Real chronological message roles did not fix that complaint-context failure. |
| `roles-holdout` | GPT-4.1 | All 10 cases returned | 9/10 | Ambiguous “allebei” dispatched all three sources; complaint still invented a dog-only intention. |
| `gpt54mini-regression` | GPT-5.4 mini, low reasoning | All 10 cases returned | 10/10 | Separate semantic review passed. |
| `gpt54mini-holdout` | GPT-5.4 mini, low reasoning | All 10 cases returned | 10/10 | Separate semantic review passed, including retained failed-result context. |

The first collector marked its execution `completed: false` when the quality gate
failed, despite recording all ten cases; the table reports the actual number of
returned cases. Later collectors distinguish completion from passing. Aborted
attempts were not automatically retried. Because the third attempt in
`real-model-revised` has unknown usage, **no exact total investigation cost is
claimed**.

## Local implementation checks

The final local application suite passed **2,909 tests in 217 files**, with
172 tests in 19 files skipped. `pnpm check`, `pnpm lint:server` and `pnpm build`
also passed. Environment-gated Redis/MySQL checks were skipped locally; this
record does not claim fresh remote CI for the new commit.

After memory deduplication and formatting, both dry runs reproduced the exact
final executed bundle and suite hashes above. These checks verify implementation
and reproducibility; they do not substitute for protected release validation.

## Semantic coverage and remaining limits

The final regression complaint keeps the known goal: the dog and person together
in one image. It asks what was wrong with that composition instead of inventing a
return to the original dog-only request. The alternate complaint also retains the
composition goal, while both ambiguous-pair cases ask which subjects are intended
and schedule no edit. The reviewer also checked brief thanks, playful comments,
creative discussion, confirmations, corrections and selection of different pairs.

Missing required sources prompt a request for re-upload. A missing unrelated image
does not block an edit to an available source. Explicit permission to invent a new
subject remains executable. These opposing cases check both unwanted execution
and unnecessary refusal.

The variant suite includes a generated failed result that shows only the person,
alongside the original dog and uploaded person. Its authored failed-result image
is pixel-identical to the person fixture. The accepted repair requires the dog and
exactly one person source; either equivalent person image is permitted. Selecting
both copies or the entire catalog is not a pass. The observed final repair selected
the original dog and original person.

The variants were inspected during development and are now known test cases,
not a large untouched blind benchmark. A single successful sample of each case is
bounded evidence, not proof of universal conversational correctness. Some Dutch
copy remains awkward, such as an unusual phrase in the playful reply; this did
not change the selected action or source scope.

All fixtures are authored illustrations and synthetic text. This evaluation does
not establish realistic-photo fidelity, successful image rendering, Messenger
delivery, payment behavior or wallet grants. Existing service tests cover wiring
and safety fences separately. The remaining production and user-journey gates are
tracked in [the active backlog](todo.md#contextual-photo-assistant).

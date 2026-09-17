# Fallow maintainability review — 2026-09-17

Baseline: `d0c23ab` (before cleanup). This is a measured review record, not a second backlog; open work remains in `todo.md`. No deployment or live data inspection was performed.

## Reproduction and limits

- Fallow 2.27.0 and existing `.fallowrc.json` files, without new suppressions or entrypoint changes.
- Run `npm run fallow:report` and `npm run fallow:report:production` at the repository root; run `pnpm run fallow:report` and `pnpm run fallow:report:production` in `apps/image-gen`.
- pnpm 10.28.1; local Node 26.3.0 (CI uses Node 24). App dependencies installed from the frozen lockfile. Root checks reused the installed dependency tree from a sibling worktree; this is not a fresh root frozen-install check.
- Initial and post-install/build baselines had identical finding, health, and clone metrics.
- Full and production scans are different populations, not competing scores. Production excludes test references; full includes test and fixture code.
- Fallow coverage is `static_estimated`, not measured test coverage. Git history is shallow; root churn/hotspot analysis is partial and the app scan reports no churn-scored files.
- The existing report normalizer can shorten nested paths (for example `client/src/...` becomes `src/...`). Resolve findings against actual imports and file contents before acting.

## Baseline

| Scope | Issues | Unused files | Unused exports | Unused types | Clones | Duplicated lines | Above complexity threshold | Mean maintainability |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| root-full | 805 | 282 | 215 | 241 | 928 | 22913 | 260 | 81.7 |
| root-production | 800 | 45 | 435 | 255 | 248 | 7031 | 238 | 85 |
| image-gen-full | 334 | 15 | 133 | 166 | 712 | 17977 | 180 | 89.7 |
| image-gen-production | 566 | 38 | 306 | 196 | 209 | 5865 | 166 | 85.2 |

Complexity thresholds: cyclomatic 20, cognitive 15. Full app: 552 analyzed files / 11,876 functions; production app: 309 files / 4,533 functions. Baseline duplicated-line percentage: root full 8.566%, root production 5.217%, app full 8.950%, app production 5.706%.

### Finding triage

- **Dead/unused code:** five exported but internal helpers in `billing/amounts.ts` and `billing/ids.ts` had no references outside their declarations. Repository-wide symbol/import checks found no namespace, dynamic, framework, or configuration consumers; app code is not part of the root package exports. Active parser and snapshot-hash consumers remain.
- **Unused exports/types:** `formatImageQuotaBalance` and `getHttpRateLimitMaxRequests` are used within their own modules. These are export-scope candidates, not dead function bodies. Pictograms are used locally and by tests. Public plugin entrypoints/re-exports are compatibility boundaries.
- **Unreachable/obsolete paths:** `portalAuth.ts`, portal management, recurring billing, and retained gateway paths need lifecycle/recovery verification. An unused-file report is not evidence that removal is safe; no such paths were deleted.
- **Clones:** the two identical image generator input shapes and repeated response action composition offered narrow seams. Schema table builders, migration guards, and test setup account for many remaining clones and were preserved.
- **Oversized functions/files:** `createMessengerGenerationJobRunner` spans 912 lines; `executeImageGenerationJobInPageContext` spans 713; `deleteUserDataInternal` spans 553. Large test `describe` callbacks are not production functions needing extraction.
- **Complexity:** `deleteUserDataInternal` cyclomatic/cognitive 91/90; completion callback 88/146; `runProductionMigrations` 76/109; generation-job callback 58/75. These enforce ordering, privacy, provider admission, or migration contracts.
- **Risk/maintainability:** four app import cycles cross consent, erasure, ingress, and webhook routing. `webhookHandlers.ts` itself is only 251 scored lines with cognitive total 28; prioritize actual responsibilities rather than its historic hotspot name.
- **Suspicious production-only findings:** app exports increase from 133 to 306 when tests are excluded; this does not prove 173 additional functions should be removed. Mollie methods used through interfaces/worker dependencies, V2 rollout code, test helpers, and recovery routines require individual review.
- **Intentional/false-positive findings:** the app Vite entrypoint is referenced by `client/index.html` and built successfully; app scripts are invoked by GitHub Actions/Docker rather than imports. Storage-proxy has a separate dependency root. Root analysis does not fully model app test entrypoints or all isolated package dependencies. Quota and plugin compatibility re-exports are intentional. No configuration suppression was added.

## Prioritized plan recorded before edits

1. Remove only the five unreferenced amount/ID helpers: very small diff, no live callsites, preserve active parsing/hashing.
2. Reuse `GeneratorInput` for the generator interface: structurally identical type, no executable change, one fewer clone.
3. Share action composition only after regression tests capture response ordering, inferred/explicit actions, empty text, fallback differences, and failed sends.
4. Stop before privacy, billing transaction, queue, migration, or provider-attempt orchestration refactors. They need a separate contract review.

## Batches and evidence

### 1. Unreferenced billing helpers (`e62aea4`)

Removed `parseEurValueMinor`, `sumAmountsMinor`, `createOpaqueBillingId`, `deterministicIdempotencyKey`, and `createExternalBillingReference`, plus the unused `randomUUID` import. `parseAmountMinor`, `hashCanonicalSnapshot`, and their behavior are unchanged.

- Five fewer unused-export findings in every scope; app issues 334 → 329, production 566 → 561.
- File dead-code ratios: amounts 0.67 → 0; IDs 0.75 → 0. Maintainability: 75.1 → 88.5 and 76.0 → 86.5.
- Targeted accounting/client/snapshot/hash tests: 45 passed. Full app: 2,987 passed, 175 skipped. Typecheck, app build, and diff whitespace checks passed.

### 2. One generator input contract (`435d443`)

Replaced the inline `ImageGenerator.generate` input object with the existing `GeneratorInput` type after comparing both definitions. No new type or public export was introduced.

- One clone group removed in every scope; 42 fewer duplicated lines counted by Fallow (23 actual source lines removed).
- Targeted image-service tests: 34 passed. Typecheck and app build passed.
- Server bundle SHA-256 before/after this batch is identical: `ede808e76c70af9603cc9865907c049e17bb339d068b683257d6ea346b02ee86`.
- Reviewed metric tradeoff: imageService full maintainability 85.8 → 85.5 (production 79.2 → 78.9), because fewer type-only lines increase complexity density 0.13 → 0.14. Cyclomatic/cognitive totals remain 62/56. Kept the change because it removes a verified duplicate contract without changing executable output.

### 3. Action prompt composition (`fb2f15c`)

Extracted one private pure `resolveActionPrompt` helper. Legacy state-text fallback, neutral label fallback, empty-text behavior, image-before-action ordering, inferred-before-explicit action ordering, and send-error propagation remain covered.

- Nine new behavior cases first passed on the old implementation: 25 adapter tests total. After refactoring: 44 targeted adapter/conversation tests passed.
- Full app after change: 2,996 passed, 175 skipped. Typecheck, build, and changed production-file lint passed. ESLint intentionally ignores the test file.
- One further clone group removed in each scope; 38 fewer duplicated lines counted. Adapter cyclomatic total 40 → 38, cognitive 25 → 22, scored lines 167 → 156, maintainability unchanged at 87.3.
- The added tests alone did not increase clone counts or threshold findings. App-full estimated maximum CRAP 49.5 → 21.8; production maximum 182 → 72, but production functions above CRAP threshold 3 → 4 after extraction. This is an estimated-coverage metric tradeoff, not a new measured coverage deficit; the helper is exercised through the public response senders. No abstraction or suppression was added to manipulate that score.

### 4. Webhook ingress privacy cycle (`68b3fc2`)

Moved the Redis privacy-erasure operation and subject-key helpers into the neutral `meta/webhookIngressPrivacy.ts` module. `dataDeletionService.ts` now imports that neutral module directly; `webhookIngressQueue.ts` retains a compatibility re-export for existing callers. This removes the queue edge from the consent → deletion → queue cycle without changing Redis keys, Lua scripts, tombstone ordering, or retry semantics.

- App full Fallow: 331 → 327 issues; circular dependencies 4 → 0; clone groups and maintainability remained 710 and 89.8.
- App production Fallow: 563 → 560 issues; circular dependencies 4 → 0; clone groups 207 and maintainability 85.3.
- Privacy/deletion regression tests: 29 passed, 12 skipped; full app suite: 2,996 passed, 175 skipped; direct TypeScript check passed. The regular `pnpm` typecheck command also attempted a workspace prepare install and was blocked by the repository's ignored-build policy, so verification used the installed `tsc` binary directly.

## Final Fallow delta

| Scope | Issues | Unused exports | Clone groups | Duplicated lines | Mean maintainability |
| --- | ---: | ---: | ---: | ---: | ---: |
| root-full | 805 → 800 | 215 → 210 | 928 → 926 | 22913 → 22833 | 81.7 → 81.7 |
| root-production | 800 → 795 | 435 → 430 | 248 → 246 | 7031 → 6951 | 85 → 85.1 |
| image-gen-full | 334 → 329 | 133 → 128 | 712 → 710 | 17977 → 17897 | 89.7 → 89.8 |
| image-gen-production | 566 → 561 | 306 → 301 | 209 → 207 | 5865 → 5785 | 85.2 → 85.3 |

Unused-file/type counts, circular dependencies, and numbers of functions exceeding the cyclomatic/cognitive thresholds are unchanged. These batches remove specific verified findings; they do not resolve the major orchestration hotspots.

## Verification boundaries and remaining opportunities

- Baseline root production contracts: 1,919 passed; root build passed; retained gateway: 182 passed after building the required plugin artifacts. An initial gateway run failed solely because `dist/setup-entry.js` and `dist/index.js` had not yet been built.
- Baseline and final app builds/typechecks passed. Full app suite ran at baseline, after billing cleanup, and after response refactoring. No dependency versions, Fallow configuration, feature flags, billing policy, or deployment configuration changed.
- The 175 skipped tests include opt-in integration coverage. Separate live-service Redis/MySQL integration runs and Docker image builds were not run locally. Local checks are not deployment or end-user journey evidence.
- Raw full/production reports and per-stage logs are retained in the task evidence archive. The original baseline, post-install baseline, each batch, and test-only checkpoint are separate snapshots.
- Next small candidates: review unnecessary internal exports individually, with compatibility and test-consumer checks. Do not remove their locally used bodies.
- Larger candidates are intentionally deferred: erasure stages, completion/accounting state transitions, migration grant validation, and consent/ingress cycles. Before any such change, map retries, partial failures, privacy epochs, lock/transaction order, and provider-attempt boundaries. No broad refactor was attempted.

The remaining webhook cycle finding is cleared in the app scan. The next pasted target, `portalWorkspace.ts`, belongs to an uncommitted client checkout outside this clean branch; five zero-reference functions were removed there locally while the five functions used by `PortalHandoff.tsx` were preserved. The broader portal checkout still has unrelated missing-dependency/type errors and was not committed or pushed.

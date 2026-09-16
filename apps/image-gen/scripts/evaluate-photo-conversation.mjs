import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const app = "leaderbot-fb-image-gen";
const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    "fly-machine": { type: "string" },
    "expected-image": { type: "string" },
    suite: { type: "string", default: "regression" },
  },
});
const machineId = values["fly-machine"];
const expectedImage = values["expected-image"];
const suite = values.suite;
const execute = Boolean(machineId);
if (
  !["regression", "holdout"].includes(suite) ||
  (execute
    ? !/^[a-f0-9]{14}$/.test(machineId) ||
      !/^registry\.fly\.io\/leaderbot-fb-image-gen@sha256:[a-f0-9]{64}$/.test(
        expectedImage ?? ""
      )
    : Boolean(expectedImage))
) {
  throw new Error(
    "Usage: node scripts/evaluate-photo-conversation.mjs [--suite regression|holdout] [--fly-machine ID --expected-image DIGEST]"
  );
}

const fixtures = {};
for (const name of ["dog", "person", "cat"]) {
  const bytes = await readFile(
    new URL(`./fixtures/photo-conversation/${name}.png`, import.meta.url)
  );
  fixtures[name] = `data:image/png;base64,${bytes.toString("base64")}`;
}
const entry = `
import { runPhotoConversationEvaluation, evaluationFailureReason } from "./scripts/lib/photo-conversation-evaluation.mjs";
const execute = process.argv[2] === "--execute-synthetic-photo-evaluation";
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
async function main() {
  if (execute && (process.env.FLY_APP_NAME !== ${JSON.stringify(app)} || !/^[a-f0-9]{14}$/.test(process.env.FLY_MACHINE_ID ?? "")))
    throw new Error("invalid_fly_runtime");
  const result = await runPhotoConversationEvaluation({
    fixtures: ${JSON.stringify(fixtures)}, suite: ${JSON.stringify(suite)}, execute,
    apiKey: execute ? process.env.OPENAI_API_KEY : undefined, emit,
  });
  if (!result.passed) process.exitCode = 1;
}
main().catch(error => {
  emit({kind: "aborted", reason: evaluationFailureReason(error), automaticRetry: false});
  process.exitCode = 1;
});
`;
const bundle = await build({
  stdin: {
    contents: entry,
    resolveDir: root,
    sourcefile: "photo-evaluation-entry.mjs",
  },
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  metafile: true,
  logLevel: "silent",
});
const allowedInputs = new Set([
  "photo-evaluation-entry.mjs",
  "scripts/lib/photo-conversation-evaluation.mjs",
  "server/_core/photoConversationContract.ts",
  "server/_core/photoConversationMemory.ts",
  "server/_core/image-generation/generationTypes.ts",
  "server/_core/openai/responseText.ts",
]);
if (
  Object.keys(bundle.metafile.inputs).some(
    input => !allowedInputs.has(input)
  ) ||
  Object.values(bundle.metafile.outputs)
    .flatMap(output => output.imports)
    .some(item => item.path !== "node:crypto")
)
  throw new Error("Evaluation bundle imported a runtime dependency");
const code = bundle.outputFiles[0].text;
const bundleSha256 = createHash("sha256").update(code).digest("hex");
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
emit({
  kind: "bundle",
  bundleSha256,
  suite,
  inputs: Object.keys(bundle.metafile.inputs),
});
if (!execute) {
  const local = spawnSync(process.execPath, ["-"], {
    input: code,
    encoding: "utf8",
    timeout: 5000,
  });
  if (local.stdout) process.stdout.write(local.stdout);
  process.exitCode = local.status === 0 ? 0 : 1;
} else {
  // CLI diagnostics are deliberately never echoed: failure cannot disclose credentials.
  const inventory = spawnSync(
    "flyctl",
    ["machines", "list", "--app", app, "--json"],
    { encoding: "utf8", timeout: 30_000 }
  );
  let machine;
  try {
    machine = JSON.parse(inventory.stdout).find(item => item.id === machineId);
  } catch {}
  if (
    inventory.status !== 0 ||
    machine?.state !== "started" ||
    machine.config?.image !== expectedImage
  )
    throw new Error("Existing machine or reviewed runtime image did not match");
  emit({ kind: "runtime", app, machineId, image: expectedImage });
  const result = spawnSync(
    "flyctl",
    [
      "ssh",
      "console",
      "--app",
      app,
      "--machine",
      machineId,
      "--quiet",
      "--command",
      "node - --execute-synthetic-photo-evaluation",
    ],
    { input: code, encoding: "utf8", timeout: 240_000, maxBuffer: 1024 * 1024 }
  );
  // Only JSON evidence from this runner is released; no shell/SSH diagnostics.
  let summary;
  for (const line of (result.stdout ?? "").split("\n")) {
    try {
      const event = JSON.parse(line);
      if (
        [
          "plan",
          "attempt",
          "case",
          "summary",
          "aborted",
          "provider_rejected",
          "response",
          "usage",
          "invalid_decision",
        ].includes(event.kind)
      ) {
        emit(event);
        if (event.kind === "summary") summary = event;
      }
    } catch {}
  }
  emit({
    kind: "execution",
    completed: Boolean(
      summary && summary.calls === 10 && [0, 1].includes(result.status)
    ),
    passed: result.status === 0 && summary?.passed === true,
    bundleSha256,
    automaticRetry: false,
  });
  process.exitCode = result.status === 0 && summary?.passed === true ? 0 : 1;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(message);
  }
}

function getTomlTableBodies(text, tableName, arrayTable = false) {
  const bodies = [];
  let currentBody = null;

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(
      /^\s*(\[\[|\[)\s*([^\]]+?)\s*(\]\]|\])\s*(?:#.*)?$/,
    );
    if (heading) {
      if (currentBody) {
        bodies.push(currentBody.join("\n"));
      }
      const isArrayTable = heading[1] === "[[" && heading[3] === "]]";
      const isStandardTable = heading[1] === "[" && heading[3] === "]";
      currentBody =
        heading[2] === tableName &&
        (arrayTable ? isArrayTable : isStandardTable)
          ? []
          : null;
      continue;
    }

    currentBody?.push(line);
  }

  if (currentBody) {
    bodies.push(currentBody.join("\n"));
  }

  return bodies;
}

function requireTomlTableMatch(
  text,
  tableName,
  pattern,
  message,
  arrayTable = false,
) {
  const tableBodies = getTomlTableBodies(text, tableName, arrayTable);
  const matchesReviewedValue = arrayTable
    ? tableBodies.length > 0 && tableBodies.every((body) => pattern.test(body))
    : tableBodies.some((body) => pattern.test(body));
  if (!matchesReviewedValue) {
    throw new Error(message);
  }
}

export function validateFlyGatewayConfig(text) {
  if (/(?:'''|""")/.test(text)) {
    throw new Error(
      "fly.toml deployment safety validation does not allow multiline strings",
    );
  }
  requireTomlTableMatch(
    text,
    "build",
    /^dockerfile\s*=\s*"deploy\/fly-gateway\/Dockerfile"$/m,
    "fly.toml must select the pinned full gateway Dockerfile",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_AGENT_MODEL\s*=\s*"openai\/gpt-5\.4-mini"$/m,
    "fly.toml must keep the reviewed provider-qualified gpt-5.4-mini model",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^NODE_OPTIONS\s*=\s*"--max-old-space-size=1536"$/m,
    "fly.toml must keep the reviewed 1536 MiB V8 heap limit",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_PUBLIC_GATEWAY_GUARD\s*=\s*"1"$/m,
    "fly.toml must keep the public route guard enabled",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE\s*=\s*"pairing"$/m,
    "fly.toml must keep unknown Facebook senders in pairing mode",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED\s*=\s*"0"$/m,
    "fly.toml must keep the Leaderbot bridge disabled",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_PUBLIC_GATEWAY_PATHS\s*=\s*"\/healthz"$/m,
    "fly.toml must expose only the public health route",
  );
  for (const setting of [
    "LEADERBOT_IMAGE_GEN_URL",
    "LEADERBOT_PORTAL_ORIGIN",
    "OPENCLAW_PUBLIC_PORTAL_ORIGIN",
    "LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED",
  ]) {
    if (new RegExp(`^\\s*${setting}\\s*=`, "m").test(text)) {
      throw new Error(
        `fly.toml personal gateway must not configure customer setting ${setting}`,
      );
    }
  }
  requireTomlTableMatch(
    text,
    "vm",
    /^memory\s*=\s*"4096"$/m,
    "fly.toml must keep the reviewed 4096 MiB VM allocation",
    true,
  );

  return {
    agentModel: "openai/gpt-5.4-mini",
    heapLimitMiB: 1536,
    vmMemoryMiB: 4096,
  };
}

export function validatePluginWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const triggerIndex = lines.findIndex((line) =>
    /^  pull_request:\s*(?:\{\})?\s*$/.test(line),
  );
  if (triggerIndex >= 0) {
    let isPathFiltered = false;
    for (const line of lines.slice(triggerIndex + 1)) {
      if (/^\S/.test(line) || /^  \S/.test(line)) break;
      if (/^    paths(?:-ignore)?:\s*$/.test(line)) {
        isPathFiltered = true;
        break;
      }
    }
    if (!isPathFiltered) return;
  }
  requireMatch(
    text,
    /^\s*-\s*["']?fly\.toml["']?\s*$/m,
    "The plugin validation workflow must run for fly.toml pull-request changes",
  );
}

function hasDirectFlyDeployOrRollback(text) {
  const logicalLines = text.replace(/\\\r?\n/g, " ");
  return [...logicalLines.matchAll(/\bfly\b[^\r\n;|&]*/g)].some((match) => {
    const command = match[0];
    return (
      /\bdeploy\b/.test(command) || /\breleases\b.*\brollback\b/.test(command)
    );
  });
}

export function validateManagedRedeployHandoff(text) {
  if (hasDirectFlyDeployOrRollback(text)) {
    throw new Error(
      "The managed gateway handoff must not contain direct Fly deploy or rollback commands",
    );
  }
  requireMatch(
    text,
    /\bgh\s+workflow\s+run\s+deploy-production\.yml\b/,
    "The managed gateway handoff must dispatch the protected production workflow",
  );
  requireMatch(
    text,
    /-f\s+target=gateway\b/,
    "The managed gateway handoff must target the gateway through the protected workflow",
  );
  requireMatch(
    text,
    /-f\s+rollback_image=/,
    "The managed gateway handoff must provide the exact reviewed image",
  );
  requireMatch(
    text,
    /\brecover-gateway\b/,
    "The managed gateway handoff must retain protected rollback recovery",
  );
}

export function validateGatewayDeploymentSafety(rootDir = process.cwd()) {
  const flyConfig = fs.readFileSync(path.join(rootDir, "fly.toml"), "utf8");
  const pluginWorkflow = fs.readFileSync(
    path.join(rootDir, ".github/workflows/main.yml"),
    "utf8",
  );
  const managedRedeployHandoff = fs.readFileSync(
    path.join(rootDir, "deploy/fly-gateway/managed-redeploy-handoff.md"),
    "utf8",
  );
  const result = validateFlyGatewayConfig(flyConfig);
  validatePluginWorkflow(pluginWorkflow);
  validateManagedRedeployHandoff(managedRedeployHandoff);
  return result;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const result = validateGatewayDeploymentSafety();
  process.stdout.write(
    `Gateway deployment safety validated (${result.agentModel}, ${result.heapLimitMiB}/${result.vmMemoryMiB} MiB heap/VM).\n`,
  );
}

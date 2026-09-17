import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateFlyGatewayConfig,
  validateGatewayDeploymentSafety,
  validateManagedRedeployHandoff,
  validatePluginWorkflow,
} from "./validate-gateway-deployment-safety.mjs";

const validFlyConfig = [
  "[build]",
  'dockerfile = "deploy/fly-gateway/Dockerfile"',
  "",
  "[env]",
  'OPENCLAW_AGENT_MODEL = "openai/gpt-5.4-mini"',
  'NODE_OPTIONS = "--max-old-space-size=1536"',
  'OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE = "pairing"',
  'OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED = "0"',
  'OPENCLAW_PUBLIC_GATEWAY_GUARD = "1"',
  'OPENCLAW_PUBLIC_GATEWAY_PATHS = "/healthz"',
  "",
  "[[vm]]",
  'memory = "4096"',
].join("\n");

const validManagedRedeployHandoff = [
  "gh workflow run deploy-production.yml --ref main \\",
  "  -f target=gateway \\",
  '  -f rollback_image="$APPROVED_REVIEWED_IMAGE"',
  "recover-gateway",
].join("\n");

function moveTomlAssignmentToOtherTable(text, setting) {
  const lines = text.split("\n");
  const assignmentIndex = lines.findIndex((line) =>
    line.startsWith(`${setting} =`),
  );
  const [assignment] = lines.splice(assignmentIndex, 1);
  return [...lines, "", "[other]", assignment].join("\n");
}

describe("gateway deployment safety validation", () => {
  it("keeps retained recovery tests on the production CI path", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const workflow = readFileSync(
      new URL("../.github/workflows/main.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("run: npm run test:retained-gateway");
    const testPaths = pkg.scripts["test:retained-gateway"].split(/\s+/);
    for (const testPath of [
      "deploy/fly-gateway",
      "scripts/gateway-state-rebaseline-workflow.test.mjs",
      "scripts/select-fresh-fly-snapshot.test.mjs",
      "scripts/validate-gateway-deployment-safety.test.mjs",
      "scripts/verify-gateway-state-rebaseline.test.mjs",
    ])
      expect(testPaths).toContain(testPath);
  });

  it("accepts the retained gateway config, CI workflow, and recovery handoff", () => {
    expect(validateGatewayDeploymentSafety()).toEqual({
      agentModel: "openai/gpt-5.4-mini",
      heapLimitMiB: 1536,
      vmMemoryMiB: 4096,
    });
  });

  it("rejects unreviewed model or memory drift", () => {
    expect(() =>
      validateFlyGatewayConfig(
        validFlyConfig.replace("gpt-5.4-mini", "placeholder"),
      ),
    ).toThrow("provider-qualified");
    expect(() =>
      validateFlyGatewayConfig(validFlyConfig.replace("1536", "3072")),
    ).toThrow("heap limit");
    expect(() =>
      validateFlyGatewayConfig(
        validFlyConfig.replace('GUARD = "1"', 'GUARD = "0"'),
      ),
    ).toThrow("route guard enabled");
    expect(() =>
      validateFlyGatewayConfig(
        validFlyConfig.replace(
          'UNKNOWN_SENDER_MODE = "pairing"',
          'UNKNOWN_SENDER_MODE = "leaderbot_free_tier"',
        ),
      ),
    ).toThrow("pairing mode");
    expect(() =>
      validateFlyGatewayConfig(
        validFlyConfig.replace(
          'LEADERBOT_BRIDGE_ENABLED = "0"',
          'LEADERBOT_BRIDGE_ENABLED = "1"',
        ),
      ),
    ).toThrow("bridge disabled");
    expect(() =>
      validateFlyGatewayConfig(validFlyConfig.replace("4096", "2048")),
    ).toThrow("VM allocation");
  });

  it.each([
    ["OPENCLAW_AGENT_MODEL", "provider-qualified"],
    ["NODE_OPTIONS", "heap limit"],
    ["OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE", "pairing mode"],
    ["OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED", "bridge disabled"],
    ["OPENCLAW_PUBLIC_GATEWAY_GUARD", "route guard enabled"],
    ["OPENCLAW_PUBLIC_GATEWAY_PATHS", "public health route"],
    ["dockerfile", "full gateway Dockerfile"],
    ["memory", "VM allocation"],
  ])("rejects %s outside its reviewed Fly table", (setting, message) => {
    expect(() =>
      validateFlyGatewayConfig(
        moveTomlAssignmentToOtherTable(validFlyConfig, setting),
      ),
    ).toThrow(message);
  });

  it.each([
    "LEADERBOT_IMAGE_GEN_URL",
    "LEADERBOT_PORTAL_ORIGIN",
    "OPENCLAW_PUBLIC_PORTAL_ORIGIN",
    "LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED",
  ])("rejects customer-only setting %s on the personal gateway", (setting) => {
    expect(() =>
      validateFlyGatewayConfig(`${validFlyConfig}\n${setting} = "configured"`),
    ).toThrow(`must not configure customer setting ${setting}`);
  });

  it("rejects table-like settings hidden inside TOML multiline strings", () => {
    const spoofed = [
      'description = """',
      validFlyConfig,
      '"""',
      "[other]",
    ].join("\n");

    expect(() => validateFlyGatewayConfig(spoofed)).toThrow(
      "does not allow multiline strings",
    );
  });

  it("requires the reviewed memory in every Fly VM table", () => {
    expect(() =>
      validateFlyGatewayConfig(`${validFlyConfig}\n\n[[vm]]\nmemory = "512"`),
    ).toThrow("VM allocation");
  });

  it("requires pull-request validation for fly.toml-only changes", () => {
    expect(() => validatePluginWorkflow('paths:\n  - "docs/**"')).toThrow(
      "fly.toml pull-request changes",
    );
    expect(() =>
      validatePluginWorkflow('paths:\n  - "fly.toml"'),
    ).not.toThrow();
    expect(() =>
      validatePluginWorkflow(
        "on:\n  pull_request:\n  push:\n    branches: [main]",
      ),
    ).not.toThrow();
  });

  it("requires protected gateway deployment and recovery instructions", () => {
    expect(() =>
      validateManagedRedeployHandoff(validManagedRedeployHandoff),
    ).not.toThrow();
    expect(() =>
      validateManagedRedeployHandoff(
        `${validManagedRedeployHandoff}\nfly deploy -a leaderbot-openclaw-gateway`,
      ),
    ).toThrow("direct Fly deploy or rollback commands");
    expect(() =>
      validateManagedRedeployHandoff(
        `${validManagedRedeployHandoff}\nfly deploy --image previous -a leaderbot-openclaw-gateway`,
      ),
    ).toThrow("direct Fly deploy or rollback commands");
    expect(() =>
      validateManagedRedeployHandoff(
        `${validManagedRedeployHandoff}\nfly releases rollback -a leaderbot-openclaw-gateway`,
      ),
    ).toThrow("direct Fly deploy or rollback commands");
    expect(() =>
      validateManagedRedeployHandoff(
        `${validManagedRedeployHandoff}\nfly -a leaderbot-openclaw-gateway deploy`,
      ),
    ).toThrow("direct Fly deploy or rollback commands");
    expect(() =>
      validateManagedRedeployHandoff(
        `${validManagedRedeployHandoff}\nfly -a leaderbot-openclaw-gateway releases rollback`,
      ),
    ).toThrow("direct Fly deploy or rollback commands");
    expect(() =>
      validateManagedRedeployHandoff(
        [
          validManagedRedeployHandoff,
          "fly --app=leaderbot-openclaw-gateway \\",
          "deploy",
        ].join("\n"),
      ),
    ).toThrow("direct Fly deploy or rollback commands");
    expect(() =>
      validateManagedRedeployHandoff(
        `${validManagedRedeployHandoff}\nfly releases --image -a leaderbot-openclaw-gateway`,
      ),
    ).not.toThrow();
    expect(() =>
      validateManagedRedeployHandoff(
        validManagedRedeployHandoff.replace(
          "gh workflow run deploy-production.yml",
          "gh workflow view deploy-production.yml",
        ),
      ),
    ).toThrow("protected production workflow");
    expect(() =>
      validateManagedRedeployHandoff(
        validManagedRedeployHandoff.replace("recover-gateway", "recovery"),
      ),
    ).toThrow("protected rollback recovery");
  });
});

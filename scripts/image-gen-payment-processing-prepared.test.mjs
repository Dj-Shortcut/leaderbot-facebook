import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  getReviewedSettledPredecessorConfig,
  loadProductionManifest,
} from "./validate-production-deployment.mjs";

/**
 * Desired Test exposure and the exact settled predecessor are separate.
 * Preserve their bounded Test exposure and checkout-off/processing-on emergency
 * recovery; neither this test nor a merged config proves a rollout.
 */

const rootDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const app = loadProductionManifest(rootDir).apps["image-gen"];
const predecessor = app.reviewedSettledPredecessor;
const predecessorConfig = getReviewedSettledPredecessorConfig(
  "image-gen",
  predecessor.identity,
  predecessor.image,
  rootDir,
);

/** Reads the `[env]` table of a Fly config as plain string assignments. */
function readEnvAssignments(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const assignments = {};
  let inEnv = false;
  for (const line of lines) {
    const table = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (table) {
      inEnv = table[1] === "env";
      continue;
    }
    if (!inEnv) continue;
    const entry = /^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/u.exec(line);
    if (entry) assignments[entry[1]] = entry[2];
  }
  return assignments;
}

describe.each([
  { stage: "desired bounded Test", config: app.config, exposure: "true" },
  {
    stage: "settled photo-enabled predecessor",
    config: predecessorConfig,
    exposure: "true",
  },
  {
    stage: "emergency dark rollback",
    config: app.reviewedRollbackConfigs[predecessor.image].path,
    exposure: "false",
  },
])("image-gen $stage payment processing", ({ config, exposure }) => {
  const env = readEnvAssignments(path.join(rootDir, config));
  it("keeps the drain, notification plane and reconciliation prepared", () => {
    expect(env.MOLLIE_BILLING_DRAIN_ENABLED).toBe("true");
    expect(env.BILLING_NOTIFICATION_PLANE_ENABLED).toBe("true");
    expect(env.MOLLIE_RECONCILIATION_ENABLED).toBe("true");
  });

  it("pins exact stage exposure while keeping live and legacy billing closed", () => {
    expect(env.MOLLIE_CREDIT_CHECKOUT_ENABLED).toBe(exposure);
    expect(env.MESSENGER_PAID_CREDITS_ENABLED).toBe(exposure);
    expect(env.MOLLIE_BILLING_ENABLED).toBe("false");
    expect(env.MOLLIE_LIVE_BILLING_ENABLED).toBe("false");
    expect(env.MOLLIE_MODE).toBe("test");
  });

  it("requires no manually registered tester", () => {
    for (const key of [
      "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID",
      "MOLLIE_CREDIT_TEST_BINDING_EPOCH",
      "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH",
      "MOLLIE_CREDIT_TEST_USER_KEY_HASH",
    ]) {
      expect((env[key] ?? "").trim()).toBe("");
    }
  });

  it("keeps the reviewed offer and spend caps unchanged", () => {
    expect(env.MOLLIE_CREDIT_WORKSPACE_ID).toBe("1");
    expect(env.MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD).toBe("1.00");
    expect(env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD).toBe("5.00");
    expect(env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD).toBe("25.00");
    expect(env.MESSENGER_USER_DAILY_SPEND_CAP_USD).toBe("2.00");
  });

  /**
   * The notification plane refuses to boot without these values, and the
   * sender and receiver halves must agree. The four signing secrets are Fly
   * secrets and are deliberately absent from this config.
   */
  it("carries the non-secret notification identity the plane needs", () => {
    expect(env.BILLING_NOTIFICATION_RECEIVER_PREFLIGHT_ACK).toBe("true");
    expect(env.BILLING_NOTIFICATION_SOURCE_ID).toBe(
      env.BILLING_NOTIFICATION_RECEIVER_SOURCE_ID,
    );
    expect(env.BILLING_CUSTOMER_NOTIFICATION_KEY_ID).toBe(
      env.BILLING_NOTIFICATION_RECEIVER_CUSTOMER_KEY_ID,
    );
    expect(env.BILLING_OPERATOR_NOTIFICATION_KEY_ID).toBe(
      env.BILLING_NOTIFICATION_RECEIVER_OPERATOR_KEY_ID,
    );
    expect(env.BILLING_CUSTOMER_NOTIFICATION_KEY_ID).not.toBe(
      env.BILLING_OPERATOR_NOTIFICATION_KEY_ID,
    );
    const origin = env.BILLING_NOTIFICATION_RECEIVER_PUBLIC_ORIGIN;
    expect(env.BILLING_CUSTOMER_NOTIFICATION_WEBHOOK_URL).toBe(
      `${origin}/api/internal/billing/notifications/customer`,
    );
    expect(env.BILLING_OPERATOR_NOTIFICATION_WEBHOOK_URL).toBe(
      `${origin}/api/internal/billing/notifications/operator`,
    );
    for (const secret of [
      "BILLING_CUSTOMER_NOTIFICATION_SIGNING_SECRET",
      "BILLING_OPERATOR_NOTIFICATION_SIGNING_SECRET",
      "BILLING_NOTIFICATION_RECEIVER_CUSTOMER_SIGNING_SECRET",
      "BILLING_NOTIFICATION_RECEIVER_OPERATOR_SIGNING_SECRET",
      "MOLLIE_API_KEY",
    ]) {
      expect(env[secret]).toBeUndefined();
    }
  });
});

it("binds the original Test request and retains the exact photo-enabled predecessor", () => {
  expect(app.creditTestActivation).toEqual({
    state: "bounded_test",
    obsoletePrincipalSha256:
      "db3013fb364b7486dabd6520c68beb4a7f5df05530ce90febb30049418a509b5",
    operator: {
      requestId: "8a62f93d-e092-4dd8-82ca-9e77bdd89d54",
      previousEpoch: 1,
      epoch: 2,
      operatorImage:
        "registry.fly.io/leaderbot-fb-image-gen@sha256:c54c1fd026e281ada8f88ecb1acc0a26d48e736b3874d3e7aeb70dc2c64efe5f",
      artifactSourceSha: "479e43d17aab852ea6b4bbfd6b03c4eac15eb797",
      runtimeImage:
        "registry.fly.io/leaderbot-fb-image-gen@sha256:f2fa9d60e1fca02c09cb2764981a7134e908f2e33f127eb0e54e77030b4a7a4b",
      deploymentIdentity: "deploy-34496956631-1",
    },
  });
  expect(predecessor).toEqual({
    image:
      "registry.fly.io/leaderbot-fb-image-gen@sha256:7165f3bac38c168f3b5d85e3153f7371388eeef7b5477c06f8eff63d9602cb8d",
    identity: "deploy-35108204745-1",
    path: "deploy/production/rollback-configs/image-gen-7165f3bac38c-deploy-35108204745-1.toml",
    sha256: "0e1d34112abbd08362361820ba585e89807ebbcce4a5a6700f1eaaa23f09714a",
  });
  expect(app.reviewedRollbackConfigs[predecessor.image]).toEqual({
    path: "deploy/production/rollback-configs/image-gen-7165f3bac38c-emergency-dark.toml",
    sha256: "f0253b74e85b1cefc4e99d537eafa6dfd687167010834066353c2595c94a02db",
  });
});

it("keeps photo conversations enabled for the release and exact settled recovery", () => {
  const desired = readEnvAssignments(path.join(rootDir, app.config));
  const settled = readEnvAssignments(path.join(rootDir, predecessorConfig));
  const dark = readEnvAssignments(
    path.join(rootDir, app.reviewedRollbackConfigs[predecessor.image].path),
  );
  expect(desired.MESSENGER_PHOTO_CONVERSATION_ENABLED).toBe("true");
  expect(settled.MESSENGER_PHOTO_CONVERSATION_ENABLED).toBe("true");
  expect(desired).toEqual(settled);
  const darkExpected = {
    ...settled,
    MESSENGER_PAID_CREDITS_ENABLED: "false",
    MOLLIE_CREDIT_CHECKOUT_ENABLED: "false",
  };
  delete darkExpected.MESSENGER_PHOTO_CONVERSATION_ENABLED;
  expect(dark).toEqual(darkExpected);
});

it("preserves the exact historical photo-only activation independently of the current runtime", () => {
  // Immutable activation records are explicit fixtures: a later runtime release
  // must not turn this historical OFF -> ON regression into ON -> ON.
  const fixture = {
    desired: {
      path: "deploy/production/rollback-configs/image-gen-7165f3bac38c-deploy-35108204745-1.toml",
      sha256: "0e1d34112abbd08362361820ba585e89807ebbcce4a5a6700f1eaaa23f09714a",
    },
    settled: {
      path: "deploy/production/rollback-configs/image-gen-7165f3bac38c-deploy-35103111862-1.toml",
      sha256: "4311fd1f4a6075a16ee16f08d83aadf63447bbc439044eb256f2206a37c44d99",
    },
    dark: {
      path: "deploy/production/rollback-configs/image-gen-7165f3bac38c-emergency-dark.toml",
      sha256: "f0253b74e85b1cefc4e99d537eafa6dfd687167010834066353c2595c94a02db",
    },
  };
  for (const config of Object.values(fixture)) {
    expect(
      createHash("sha256")
        .update(fs.readFileSync(path.join(rootDir, config.path)))
        .digest("hex"),
    ).toBe(config.sha256);
  }
  const desiredPath = path.join(rootDir, fixture.desired.path);
  const settledPath = path.join(rootDir, fixture.settled.path);
  const desired = readEnvAssignments(desiredPath);
  const settled = readEnvAssignments(settledPath);
  const dark = readEnvAssignments(path.join(rootDir, fixture.dark.path));

  expect(settled.MESSENGER_PHOTO_CONVERSATION_ENABLED).toBeUndefined();
  expect(dark.MESSENGER_PHOTO_CONVERSATION_ENABLED).toBeUndefined();
  expect(desired).toEqual({
    ...settled,
    MESSENGER_PHOTO_CONVERSATION_ENABLED: "true",
  });
  expect(dark).toEqual({
    ...settled,
    MESSENGER_PAID_CREDITS_ENABLED: "false",
    MOLLIE_CREDIT_CHECKOUT_ENABLED: "false",
  });

  const unchangedConfigLines = (file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line &&
          !line.startsWith("#") &&
          !/^MESSENGER_PHOTO_CONVERSATION_ENABLED\s*=/.test(line),
      );
  expect(unchangedConfigLines(desiredPath)).toEqual(
    unchangedConfigLines(settledPath),
  );
});

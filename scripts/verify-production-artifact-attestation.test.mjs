import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reviewedAttestationPolicy,
  verifyProductionArtifactAttestation,
} from "./verify-production-artifact-attestation.mjs";

const CURRENT = "Dj-Shortcut/leaderbot-facebook";
const HISTORICAL = "Dj-Shortcut/openclaw-facebook";
const IMAGE = `registry.fly.io/leaderbot-fb-image-gen@sha256:${"a".repeat(64)}`;
const ROLLBACK = `registry.fly.io/leaderbot-fb-image-gen@sha256:${"b".repeat(64)}`;
const SOURCE = "c".repeat(40);
const BRIDGE_PREDICATE = "https://leaderbot.live/attestations/migration-bridge/v1";
const folders = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function fixture(options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "attestation-test-"));
  folders.push(rootDir);
  fs.mkdirSync(path.join(rootDir, "deploy/production"), { recursive: true });
  const app = {
    app: "leaderbot-fb-image-gen",
    reviewedImage: IMAGE,
    reviewedSourceCommit: SOURCE,
    reviewedArtifactKind: options.kind ?? "runtime",
    reviewedRollbackImages: [ROLLBACK],
    reviewedRollbackSourceCommits: { [ROLLBACK]: "d".repeat(40) },
    reviewedRollbackArtifactKinds: { [ROLLBACK]: "runtime" },
    reviewedArtifactRepositories: {
      [IMAGE]: options.repository ?? HISTORICAL,
      [ROLLBACK]: HISTORICAL,
    },
    databaseSchemaTransition: { bridgePredicateType: BRIDGE_PREDICATE },
  };
  options.mutateApp?.(app);
  fs.writeFileSync(path.join(rootDir, "deploy/production/apps.json"), JSON.stringify({
    schemaVersion: 1,
    apps: { "image-gen": app },
  }));
  let commandDirectory;
  const run = vi.fn((command, args, commandOptions) => {
    expect(command).toBe("gh");
    commandDirectory = commandOptions.cwd;
    expect(commandDirectory.startsWith(`${rootDir}${path.sep}artifact-attestation-`)).toBe(true);
    if (args[0] === "api") {
      expect(args).toEqual(["api", `repos/${CURRENT}`]);
      const metadata = { id: 1238456123, full_name: CURRENT, owner: { id: 78924184 } };
      options.mutateMetadata?.(metadata);
      return JSON.stringify(metadata);
    }
    const image = args[2].replace("oci://", "");
    const bundle = path.join(commandDirectory, `${image.split("@")[1]}.jsonl`);
    if (args[1] === "download") {
      expect(args[args.indexOf("--repo") + 1]).toBe(CURRENT);
      if (options.downloadFailure) throw Error("secret diagnostic");
      if (!options.missingBundle) {
        if (options.symlinkBundle) fs.symlinkSync(path.join(rootDir, "deploy/production/apps.json"), bundle);
        else fs.writeFileSync(bundle, "{\"fixture\":true}\n");
      }
      return "";
    }
    expect(args[1]).toBe("verify");
    expect(args[args.indexOf("--bundle") + 1]).toBe(bundle);
    if (options.verifyFailure) throw Error("secret registry diagnostic");
    const policy = reviewedAttestationPolicy("image-gen", image, {
      rootDir,
      predicateType: args[args.indexOf("--predicate-type") + 1],
    });
    const result = {
      attestation: { bundle: { retained: true } },
      verificationResult: {
        signature: {
          certificate: {
            sourceRepositoryIdentifier: "1238456123",
            sourceRepositoryOwnerIdentifier: "78924184",
            sourceRepositoryURI: `https://github.com/${policy.repository}`,
            sourceRepositoryDigest: policy.sourceCommit,
            sourceRepositoryRef: "refs/heads/main",
            runnerEnvironment: "github-hosted",
            issuer: "https://token.actions.githubusercontent.com",
            subjectAlternativeName: policy.workflow,
            buildSignerURI: policy.workflow,
            buildSignerDigest: policy.sourceCommit,
          },
        },
        statement: {
          predicateType: policy.predicateType,
          subject: [{ digest: { sha256: image.split("@sha256:")[1] } }],
          predicate: { untouched: true },
        },
      },
    };
    options.mutateResult?.(result);
    return JSON.stringify(options.emptyResults ? [] : [result]);
  });
  return {
    app,
    rootDir,
    run,
    verify: (image = IMAGE, predicateType) => verifyProductionArtifactAttestation("image-gen", image, {
      rootDir,
      tempRoot: rootDir,
      run,
      env: { GITHUB_REPOSITORY: CURRENT, GITHUB_REPOSITORY_ID: "1238456123", ...options.env },
      predicateType,
    }),
    assertClean: () => {
      if (commandDirectory) expect(fs.existsSync(commandDirectory)).toBe(false);
      expect(fs.readdirSync(rootDir)).toEqual(["deploy"]);
    },
  };
}

describe("production artifact attestations after the repository rename", () => {
  it.each([HISTORICAL, CURRENT])("fetches from the current repository and verifies the exact %s manifest identity", (repository) => {
    const state = fixture({ repository });
    const result = state.verify();
    expect(result[0].attestation.bundle.retained).toBe(true);
    expect(result[0].verificationResult.statement.predicate.untouched).toBe(true);
    expect(state.run.mock.calls[2][1]).toEqual([
      "attestation", "verify", `oci://${IMAGE}`,
      "--bundle", expect.stringContaining(`/sha256:${"a".repeat(64)}.jsonl`),
      "--repo", repository,
      "--signer-workflow", `${repository}/.github/workflows/build-production-artifacts.yml`,
      "--source-digest", SOURCE,
      "--source-ref", "refs/heads/main",
      "--deny-self-hosted-runners",
      "--predicate-type", "https://slsa.dev/provenance/v1",
      "--format", "json",
    ]);
    state.assertClean();
  });

  it("preserves the independently reviewed rollback source and repository", () => {
    const state = fixture({ repository: CURRENT });
    state.verify(ROLLBACK);
    expect(state.run.mock.calls[2][1]).toEqual(expect.arrayContaining(["--source-digest", "d".repeat(40), "--repo", HISTORICAL]));
    state.assertClean();
  });

  it("uses the storage-proxy image's own reviewed source and identity", () => {
    const state = fixture({ repository: CURRENT });
    const image = IMAGE.replace("leaderbot-fb-image-gen", "leaderbot-storage-proxy");
    const manifest = {
      schemaVersion: 1,
      apps: {
        "storage-proxy": {
          app: "leaderbot-storage-proxy",
          reviewedImage: image,
          reviewedSourceCommit: SOURCE,
          reviewedArtifactKind: "runtime",
          reviewedArtifactRepositories: { [image]: CURRENT },
        },
      },
    };
    fs.writeFileSync(path.join(state.rootDir, "deploy/production/apps.json"), JSON.stringify(manifest));
    expect(reviewedAttestationPolicy("storage-proxy", image, { rootDir: state.rootDir })).toMatchObject({
      image,
      sourceCommit: SOURCE,
      repository: CURRENT,
    });
    expect(() => reviewedAttestationPolicy("storage-proxy", IMAGE, { rootDir: state.rootDir })).toThrow();
  });

  it.each([
    ["missing manifest identity", (app) => delete app.reviewedArtifactRepositories[IMAGE]],
    ["arbitrary alias", (app) => app.reviewedArtifactRepositories[IMAGE] = "attacker/leaderbot-facebook"],
    ["legacy bootstrap", (app) => app.reviewedArtifactKind = "legacy-bootstrap"],
  ])("rejects %s before making network calls", (_label, mutateApp) => {
    const state = fixture({ mutateApp });
    expect(() => state.verify()).toThrow();
    expect(state.run).not.toHaveBeenCalled();
    state.assertClean();
  });

  it("rejects an unreviewed image before making network calls", () => {
    const state = fixture();
    expect(() => state.verify(IMAGE.replace("a".repeat(64), "e".repeat(64)))).toThrow();
    expect(state.run).not.toHaveBeenCalled();
  });

  it.each([
    ["repository ID", (metadata) => metadata.id = 1],
    ["repository name", (metadata) => metadata.full_name = HISTORICAL],
    ["owner ID", (metadata) => metadata.owner.id = 1],
  ])("rejects changed current %s before downloading", (_label, mutateMetadata) => {
    const state = fixture({ mutateMetadata });
    expect(() => state.verify()).toThrow("production_artifact_attestation_rejected");
    expect(state.run).toHaveBeenCalledTimes(1);
    state.assertClean();
  });

  it.each([
    ["sourceRepositoryIdentifier", "987654321"],
    ["sourceRepositoryIdentifier", undefined],
    ["sourceRepositoryOwnerIdentifier", "987654321"],
    ["sourceRepositoryURI", `https://github.com/${CURRENT}`],
    ["sourceRepositoryDigest", "0".repeat(40)],
    ["sourceRepositoryRef", "refs/heads/feature"],
    ["runnerEnvironment", "self-hosted"],
    ["issuer", "https://attacker.example"],
    ["subjectAlternativeName", `https://github.com/${HISTORICAL}/.github/workflows/untrusted.yml@refs/heads/main`],
    ["buildSignerURI", `https://github.com/${HISTORICAL}/.github/workflows/build-production-artifacts.yml.evil@refs/heads/main`],
    ["buildSignerDigest", "0".repeat(40)],
  ])("rejects a mismatched or missing signed certificate %s", (field, value) => {
    const state = fixture({ mutateResult: (result) => {
      result.verificationResult.signature.certificate[field] = value;
      // An attacker-controlled predicate cannot supply the missing identity.
      result.verificationResult.statement.predicate.repository_id = "1238456123";
    } });
    expect(() => state.verify()).toThrow("production_artifact_attestation_rejected");
    state.assertClean();
  });

  it.each([
    ["different artifact digest", (result) => result.verificationResult.statement.subject[0].digest.sha256 = "0".repeat(64)],
    ["different predicate", (result) => result.verificationResult.statement.predicateType = "https://attacker.example"],
    ["missing certificate", (result) => delete result.verificationResult.signature.certificate],
  ])("rejects %s from verification output", (_label, mutateResult) => {
    const state = fixture({ mutateResult });
    expect(() => state.verify()).toThrow("production_artifact_attestation_rejected");
    state.assertClean();
  });

  it.each(["downloadFailure", "verifyFailure", "missingBundle", "symlinkBundle", "emptyResults"])("fails closed and cleans temporary bundles on %s", (option) => {
    const state = fixture({ [option]: true });
    expect(() => state.verify()).toThrow("production_artifact_attestation_rejected");
    state.assertClean();
  });

  it("does not retry an old-name failure with a different signer", () => {
    const state = fixture({ verifyFailure: true });
    expect(() => state.verify()).toThrow();
    expect(state.run).toHaveBeenCalledTimes(3);
    state.assertClean();
  });

  it.each([
    { GITHUB_REPOSITORY: "attacker/leaderbot-facebook" },
    { GITHUB_REPOSITORY_ID: "987654321" },
  ])("rejects a different workflow repository identity", (env) => {
    const state = fixture({ env });
    expect(() => state.verify()).toThrow();
    expect(state.run).not.toHaveBeenCalled();
  });

  it("retains the exact reviewed bridge predicate for material verification", () => {
    const state = fixture({ kind: "migration-bridge" });
    expect(state.verify(IMAGE, BRIDGE_PREDICATE)[0].verificationResult.statement.predicateType).toBe(BRIDGE_PREDICATE);
    state.assertClean();
  });

  it.each([
    ["runtime", BRIDGE_PREDICATE],
    ["migration-bridge", "https://attacker.example/weaker-predicate"],
  ])("rejects unreviewed %s custom predicate %s", (kind, predicateType) => {
    const state = fixture({ kind });
    expect(() => state.verify(IMAGE, predicateType)).toThrow();
    expect(state.run).not.toHaveBeenCalled();
  });
});

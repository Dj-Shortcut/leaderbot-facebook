import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getReviewedArtifactKind,
  getReviewedArtifactSourceCommit,
  loadProductionManifest,
} from "./validate-production-deployment.mjs";

const REPOSITORY = "Dj-Shortcut/leaderbot-facebook";
const HISTORICAL_REPOSITORY = "Dj-Shortcut/openclaw-facebook";
const REPOSITORY_ID = "1238456123";
const OWNER_ID = "78924184";
const WORKFLOW = ".github/workflows/build-production-artifacts.yml";
const SOURCE_REF = "refs/heads/main";
const SLSA_PREDICATE = "https://slsa.dev/provenance/v1";
const BRIDGE_PREDICATE = "https://leaderbot.live/attestations/migration-bridge/v1";
const reject = () => {
  throw new Error("production_artifact_attestation_rejected");
};

function execute(command, args, options) {
  return execFileSync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function reviewedAttestationPolicy(target, image, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  if (!["image-gen", "storage-proxy"].includes(target)) reject();
  const app = loadProductionManifest(rootDir).apps[target];
  const imagePrefix = `registry.fly.io/${app?.app}@sha256:`;
  if (
    !app ||
    typeof image !== "string" ||
    !image.startsWith(imagePrefix) ||
    !/^[a-f0-9]{64}$/.test(image.slice(imagePrefix.length))
  ) reject();
  const sourceCommit = getReviewedArtifactSourceCommit(target, image, rootDir);
  const kind = getReviewedArtifactKind(target, image, rootDir);
  const repositories = app.reviewedArtifactRepositories;
  if (!repositories || !Object.hasOwn(repositories, image)) reject();
  const repository = repositories[image];
  if (![REPOSITORY, HISTORICAL_REPOSITORY].includes(repository)) reject();
  const predicateType = options.predicateType ?? SLSA_PREDICATE;
  if (
    predicateType !== SLSA_PREDICATE &&
    (predicateType !== BRIDGE_PREDICATE ||
      kind !== "migration-bridge" ||
      app.databaseSchemaTransition?.bridgePredicateType !== predicateType)
  ) reject();
  return {
    image,
    sourceCommit,
    repository,
    predicateType,
    workflow: `https://github.com/${repository}/${WORKFLOW}@${SOURCE_REF}`,
  };
}

// Only inspect gh's cryptographically verified certificate output. Predicate
// metadata can be supplied by the producing workflow and is not identity proof.
export function validateVerifiedAttestations(results, policy) {
  if (!Array.isArray(results) || results.length === 0) reject();
  for (const result of results) {
    const verified = result?.verificationResult;
    const certificate = verified?.signature?.certificate;
    if (
      certificate?.sourceRepositoryIdentifier !== REPOSITORY_ID ||
      certificate.sourceRepositoryOwnerIdentifier !== OWNER_ID ||
      certificate.sourceRepositoryURI !== `https://github.com/${policy.repository}` ||
      certificate.sourceRepositoryDigest !== policy.sourceCommit ||
      certificate.sourceRepositoryRef !== SOURCE_REF ||
      certificate.runnerEnvironment !== "github-hosted" ||
      certificate.issuer !== "https://token.actions.githubusercontent.com" ||
      certificate.subjectAlternativeName !== policy.workflow ||
      certificate.buildSignerURI !== policy.workflow ||
      certificate.buildSignerDigest !== policy.sourceCommit ||
      verified.statement?.predicateType !== policy.predicateType ||
      !Array.isArray(verified.statement?.subject) ||
      !verified.statement.subject.some(
        (subject) => subject?.digest?.sha256 === policy.image.split("@sha256:")[1],
      )
    ) reject();
  }
  return results;
}

export function verifyProductionArtifactAttestation(target, image, options = {}) {
  const policy = reviewedAttestationPolicy(target, image, options);
  const run = options.run ?? execute;
  const env = options.env ?? process.env;
  if (
    (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== REPOSITORY) ||
    (env.GITHUB_REPOSITORY_ID && env.GITHUB_REPOSITORY_ID !== REPOSITORY_ID)
  ) reject();
  const tempDir = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "artifact-attestation-"));
  try {
    const commandOptions = { cwd: tempDir, env };
    const repository = JSON.parse(run("gh", ["api", `repos/${REPOSITORY}`], commandOptions));
    if (
      repository.id !== Number(REPOSITORY_ID) ||
      repository.full_name !== REPOSITORY ||
      repository.owner?.id !== Number(OWNER_ID)
    ) reject();

    // Fetch only from the current repository. Historical names are certificate
    // policies for explicit manifest entries, never API redirect destinations.
    run("gh", [
      "attestation", "download", `oci://${image}`,
      "--repo", REPOSITORY,
      "--predicate-type", policy.predicateType,
    ], commandOptions);
    const bundle = path.join(tempDir, `${image.split("@")[1]}.jsonl`);
    const bundleStat = fs.lstatSync(bundle);
    if (!bundleStat.isFile() || bundleStat.size === 0 || bundleStat.size > 8 * 1024 * 1024) reject();
    const output = run("gh", [
      "attestation", "verify", `oci://${image}`,
      "--bundle", bundle,
      "--repo", policy.repository,
      "--signer-workflow", `${policy.repository}/${WORKFLOW}`,
      "--source-digest", policy.sourceCommit,
      "--source-ref", SOURCE_REF,
      "--deny-self-hosted-runners",
      "--predicate-type", policy.predicateType,
      "--format", "json",
    ], commandOptions);
    return validateVerifiedAttestations(JSON.parse(output), policy);
  } catch {
    // Child-process errors can contain environment or registry diagnostics.
    reject();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [target, image, flag, predicateType, ...rest] = process.argv.slice(2);
    if (!target || !image || rest.length || (flag !== undefined && (flag !== "--predicate-type" || !predicateType))) reject();
    const results = verifyProductionArtifactAttestation(target, image, { predicateType });
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } catch {
    process.stderr.write("production_artifact_attestation_rejected\n");
    process.exitCode = 1;
  }
}

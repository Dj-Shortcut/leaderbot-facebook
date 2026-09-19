import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const FINDINGS = new Set([
  "missing_reply",
  "handler_error",
  "fallback_reply",
  "social_as_upload",
  "social_started_generation",
  "image_request_unhandled",
  "in_flight_block",
  "window_closed",
]);
const TECHNICAL_EVENTS = {
  messenger_generation_image_delivery_failed: "image_delivery_failed",
  messenger_generation_job_dead_lettered: "generation_dead_lettered",
  messenger_generation_recovery_dead_lettered: "generation_dead_lettered",
  messenger_generation_job_failed: "generation_attempt_failed",
  messenger_generation_queue_drain_failed: "queue_drain_failed",
  messenger_attachment_unsupported: "unsupported_attachment",
  openai_call_error: "provider_error",
};
const LABELS = {
  missing_reply: [
    "Geen antwoord geaccepteerd",
    "Controleer de verzendpoging en de fallback voor de bijbehorende verzoeken.",
  ],
  handler_error: [
    "Gespreksverwerking liep vast",
    "Controleer de foutklasse en de gekozen verwerkingsstap.",
  ],
  fallback_reply: [
    "Algemene foutmelding verstuurd",
    "Zoek welke eerdere stap de fallback veroorzaakte.",
  ],
  social_as_upload: [
    "Bedankje of like als upload behandeld",
    "Controleer de emoji- en stickerherkenning vóór de uploadverwerking.",
  ],
  social_started_generation: [
    "Bedankje startte een generatie",
    "Controleer de opdrachtkeuze vóór de generatie- en creditstap.",
  ],
  image_request_unhandled: [
    "Afbeeldingsopdracht kreeg alleen uitleg",
    "Controleer de opdrachtherkenning en gespreksstatus.",
  ],
  in_flight_block: [
    "Nieuwe invoer tijdens een lopende generatie",
    "Controleer of de gebruiker duidelijke wacht- of vervolginstructies krijgt.",
  ],
  window_closed: [
    "Antwoord buiten het antwoordvenster",
    "Controleer de timing; dit kan een verwachte platformbeperking zijn.",
  ],
  image_delivery_failed: [
    "Afbeelding niet verzonden",
    "Controleer de Messenger-verzending en de herstelroute.",
  ],
  generation_dead_lettered: [
    "Generatie definitief vastgelopen",
    "Controleer de uitgeputte wachtrijtaak en de foutmelding aan de gebruiker.",
  ],
  generation_attempt_failed: [
    "Generatiepoging mislukt",
    "Controleer of een latere poging de taak alsnog afrondde.",
  ],
  queue_drain_failed: [
    "Wachtrijverwerking mislukt",
    "Controleer de worker en gedeelde wachtrij.",
  ],
  unsupported_attachment: [
    "Bijlage niet ondersteund",
    "Controleer bij terugkerende gevallen of likes of stickers verkeerd worden ingedeeld; dit signaal bewijst dat niet.",
  ],
  provider_error: [
    "Afbeeldingsprovider gaf een fout",
    "Controleer de providerfoutcode, time-out en beschikbare capaciteit.",
  ],
};
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DAY_MS = 86_400_000;

/** Project an untrusted log onto a fixed schema. Nothing else may be persisted. */
export function normalizeEvaluationLog(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let payload = raw;
  const embedded = raw.message ?? raw.data?.message;
  if (typeof embedded === "string") {
    try {
      payload = JSON.parse(embedded);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  let findings;
  let type;
  if (
    payload.event === "messenger_conversation_evaluation" &&
    payload.version === 1
  ) {
    findings = Array.isArray(payload.findings)
      ? [
          ...new Set(payload.findings.filter(value => FINDINGS.has(value))),
        ].sort()
      : [];
    type = "evaluation";
  } else if (Object.hasOwn(TECHNICAL_EVENTS, payload.event)) {
    findings = [TECHNICAL_EVENTS[payload.event]];
    type = "technical";
  } else if (
    payload.event === "messenger_response_window_trace" &&
    payload.stage === "webhook_received"
  ) {
    findings = [];
    type = "inbound";
  } else return null;
  const timestamp = Date.parse(
    payload.evaluatedAt ?? raw.timestamp ?? raw.time ?? payload.timestamp
  );
  if (!Number.isFinite(timestamp)) return null;
  const request =
    typeof payload.reqId === "string" && UUID.test(payload.reqId)
      ? payload.reqId
      : null;
  const evidenceId = createHash("sha256")
    .update(JSON.stringify([payload.event, timestamp, request, findings]))
    .digest("hex");
  return {
    evidenceId,
    timestamp,
    type,
    findings,
    request,
    contentChecked: type === "evaluation" && payload.contentCheck === "rules",
  };
}

export function buildEvaluationReport(signals, now = Date.now()) {
  const current = signals.filter(
    signal =>
      signal.timestamp >= now - DAY_MS && signal.timestamp <= now + 60_000
  );
  const counts = new Map();
  for (const signal of current)
    for (const finding of signal.findings) {
      const group = counts.get(finding) ?? { count: 0, examples: [] };
      group.count++;
      if (
        signal.request &&
        group.examples.length < 3 &&
        !group.examples.includes(signal.request)
      )
        group.examples.push(signal.request);
      counts.set(finding, group);
    }
  const evaluations = current.filter(signal => signal.type === "evaluation");
  const inbound = current.filter(signal => signal.type === "inbound");
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    coverage: {
      mode: "recent_log_snapshots",
      firstObservedAt: current.length
        ? new Date(
            Math.min(...current.map(signal => signal.timestamp))
          ).toISOString()
        : null,
      lastObservedAt: current.length
        ? new Date(
            Math.max(...current.map(signal => signal.timestamp))
          ).toISOString()
        : null,
      inboundObserved: inbound.length,
      evaluationsObserved: evaluations.length,
      contentCheck: evaluations.some(signal => signal.contentChecked)
        ? "limited_rules"
        : "not_observed",
      completeConversationCoverage: false,
    },
    findings: [...counts.entries()]
      .map(([code, group]) => ({
        code,
        title: LABELS[code][0],
        nextStep: LABELS[code][1],
        ...group,
        actionable:
          code === "generation_dead_lettered" ||
          code === "social_started_generation" ||
          group.count >= 3,
      }))
      .sort(
        (a, b) =>
          Number(b.actionable) - Number(a.actionable) ||
          b.count - a.count ||
          a.code.localeCompare(b.code)
      ),
    limitations: [
      "Dit zijn waargenomen technische signalen, geen beoordeling van alle gesprekken.",
      "De inhoudelijke controle gebruikt enkele vaste regels; ze beoordeelt geen fotokwaliteit of volledig tekstbegrip.",
      "Een ontbrekend logsignaal bewijst niet dat een gebeurtenis niet plaatsvond.",
    ],
  };
}

/** Decode NDJSON or consecutive pretty-printed JSON records without retaining logs. */
export function createLogDecoder(onRecord) {
  let buffer = "",
    depth = 0,
    quoted = false,
    escaped = false;
  return {
    push(chunk) {
      for (const character of chunk) {
        if (!buffer && /\s/.test(character)) continue;
        if (!buffer && character !== "{" && character !== "[")
          throw new Error("Unexpected log format");
        buffer += character;
        if (buffer.length > 1_048_576)
          throw new Error("Log record exceeds size limit");
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '\"') quoted = false;
        } else if (character === '\"') quoted = true;
        else if (character === "{" || character === "[") depth++;
        else if (character === "}" || character === "]") depth--;
        if (depth === 0) {
          let record;
          try {
            record = JSON.parse(buffer);
          } catch {
            throw new Error("Invalid log record");
          }
          buffer = "";
          for (const item of Array.isArray(record) ? record : [record])
            onRecord(item);
        }
      }
    },
    finish() {
      if (buffer) throw new Error("Incomplete log snapshot");
    },
  };
}

async function readLiveLogs() {
  // flyctl updates its configuration directory even for read-only commands.
  // Use a private temporary copy and remove it (including CLI diagnostics).
  const flyDirectory = await mkdtemp(join(tmpdir(), "conversation-eval-fly-"));
  await chmod(flyDirectory, 0o700);
  try {
    if (!process.env.FLY_ACCESS_TOKEN) {
      await copyFile(
        join(
          process.env.FLY_CONFIG_DIR || join(homedir(), ".fly"),
          "config.yml"
        ),
        join(flyDirectory, "config.yml")
      );
      await chmod(join(flyDirectory, "config.yml"), 0o600);
    }
    return await new Promise((resolveResult, reject) => {
      const child = spawn(
        process.env.FLY_BIN || "/opt/homebrew/bin/fly",
        ["logs", "--app", "leaderbot-fb-image-gen", "--no-tail", "--json"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, FLY_CONFIG_DIR: flyDirectory },
        }
      );
      const lines = [];
      const collectionStats = {
        logRecords: 0,
        structuredRecords: 0,
        knownRecords: 0,
      };
      const ingest = raw => {
        collectionStats.logRecords++;
        try {
          collectionStats.structuredRecords++;
          const embedded =
            typeof raw.message === "string" ? JSON.parse(raw.message) : raw;
          if (
            embedded.event === "messenger_conversation_evaluation" ||
            embedded.event === "messenger_response_window_trace" ||
            Object.hasOwn(TECHNICAL_EVENTS, embedded.event)
          )
            collectionStats.knownRecords++;
          const signal = normalizeEvaluationLog(raw);
          if (signal) lines.push(signal);
        } catch {
          /* Only allowlisted structured metadata is retained. */
        }
      };
      const decoder = createLogDecoder(ingest);
      let bytes = 0;
      let failure = null;
      const timeout = setTimeout(() => {
        failure = new Error("Log snapshot timed out");
        child.kill();
      }, 30_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        if (failure) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16 * 1_024 * 1_024) {
          failure = new Error("Log snapshot exceeded size limit");
          child.kill();
          return;
        }
        try {
          decoder.push(chunk);
        } catch {
          failure = new Error("Log snapshot could not be decoded");
          child.kill();
        }
      });
      // Provider diagnostics may contain private details. Never persist or echo them.
      child.stderr.resume();
      child.on("error", () => {
        clearTimeout(timeout);
        reject(new Error("Log access unavailable"));
      });
      child.on("close", code => {
        clearTimeout(timeout);
        if (failure || code !== 0) {
          reject(failure ?? new Error("Log access failed"));
          return;
        }
        try {
          decoder.finish();
        } catch {
          reject(new Error("Incomplete log snapshot"));
          return;
        }
        lines.collectionStats = collectionStats;
        resolveResult(lines);
      });
    });
  } finally {
    await rm(flyDirectory, { recursive: true, force: true });
  }
}

async function atomicJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function runEvaluationMonitor({
  statePath,
  reportPath,
  collect = readLiveLogs,
  now = Date.now(),
}) {
  let previous = { signals: [], alerted: [] };
  try {
    previous = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Monitor state could not be read");
  }
  const incoming = await collect();
  // Re-validate saved records: a local file is data, never an instruction.
  const valid = signal =>
    signal &&
    /^[a-f0-9]{64}$/.test(signal.evidenceId) &&
    Number.isFinite(signal.timestamp) &&
    ["evaluation", "technical", "inbound"].includes(signal.type) &&
    Array.isArray(signal.findings) &&
    signal.findings.every(finding => Object.hasOwn(LABELS, finding)) &&
    (signal.request === null || UUID.test(signal.request));
  const byId = new Map();
  for (const signal of [
    ...(Array.isArray(previous.signals) ? previous.signals : []),
    ...incoming,
  ]) {
    if (
      !valid(signal) ||
      signal.timestamp < now - DAY_MS ||
      signal.timestamp > now + 60_000
    )
      continue;
    byId.set(signal.evidenceId, {
      evidenceId: signal.evidenceId,
      timestamp: signal.timestamp,
      type: signal.type,
      findings: signal.findings,
      request: signal.request,
      contentChecked: signal.contentChecked === true,
    });
  }
  const signals = [...byId.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-20_000);
  const report = buildEvaluationReport(signals, now);
  const previousAlerts = Array.isArray(previous.alerted)
    ? previous.alerted
    : [];
  const alerts = [];
  report.newAlerts = [];
  for (const finding of report.findings.filter(item => item.actionable)) {
    const latest = Math.max(
      ...signals
        .filter(signal => signal.findings.includes(finding.code))
        .map(signal => signal.timestamp)
    );
    const prior = previousAlerts.find(
      item =>
        item &&
        item.code === finding.code &&
        Number.isFinite(item.count) &&
        Number.isFinite(item.latest)
    );
    const isNew =
      !prior ||
      (latest > prior.latest &&
        (finding.count >= prior.count * 2 || latest - prior.latest >= DAY_MS));
    if (isNew) report.newAlerts.push(finding.code);
    alerts.push(
      isNew
        ? { code: finding.code, count: finding.count, latest }
        : { code: prior.code, count: prior.count, latest: prior.latest }
    );
  }
  report.snapshot = {
    collectedAt: new Date(now).toISOString(),
    matchingSignals: incoming.length,
    ...(incoming.collectionStats ?? {}),
  };
  await atomicJson(reportPath, report);
  await atomicJson(statePath, { version: 1, signals, alerted: alerts });
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const value = flag => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const statePath = value("--state");
  const reportPath = value("--report");
  if (!statePath || !reportPath) {
    process.stderr.write(
      "Usage: node evaluate-conversations.mjs --state <private-state.json> --report <report.json>\n"
    );
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(
        JSON.stringify(
          await runEvaluationMonitor({ statePath, reportPath }),
          null,
          2
        ) + "\n"
      );
    } catch {
      process.stderr.write(
        "Conversation evaluation could not collect a fresh snapshot; previous evidence was preserved.\n"
      );
      process.exitCode = 1;
    }
  }
}

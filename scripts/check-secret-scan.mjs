import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// TruffleHog normalizes Postgres Raw values to scheme://user:password@host:port.
// Only these reviewed demo values in their known fixture/example paths may be
// ignored. Never suppress verified findings, whole files, or entire detectors.
const localPostgresPaths = new Set([
  ".env.distributed",
  ".env.distributed.example",
  "docker-compose.distributed.yml",
  "k8s/base/dispatch-controller.yaml",
  "k8s/base/event-api.yaml",
  "k8s/base/monitor.yaml",
]);

export function isDemoPostgresFinding(finding) {
  if (finding.Verified !== false || finding.DetectorName !== "Postgres") return false;
  const file = finding.SourceMetadata?.Data?.Git?.file;
  return (
    (localPostgresPaths.has(file) && finding.Raw === "postgres://sf:sf@postgres:5432") ||
    (file === ".env.example" && finding.Raw === "postgres://user:pass@host:5432")
  );
}

export async function checkSecretScan(file) {
  let accepted = 0;
  let blocked = 0;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let finding;
      try {
        finding = JSON.parse(line);
      } catch {
        // JSON parse errors can contain raw credentials. Never echo their text.
        throw new Error("Invalid JSON in secret scanner output");
      }
      if (
        !finding ||
        typeof finding.DetectorName !== "string" ||
        typeof finding.Verified !== "boolean" ||
        typeof finding.Raw !== "string" ||
        typeof finding.SourceMetadata?.Data?.Git?.file !== "string"
      ) {
        throw new Error("Unexpected secret scanner result format");
      }
      if (isDemoPostgresFinding(finding)) {
        accepted++;
      } else {
        blocked++;
      }
    }
  } finally {
    lines.close();
  }
  // Raw results, verification errors and source metadata can contain secrets.
  // Keep the CI output to counts; inspect unexpected findings privately.
  console.log(`Secret scan: ${accepted} reviewed demo findings, ${blocked} blocking findings`);
  return blocked === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error("A secret scan JSONL file is required");
    if (!(await checkSecretScan(process.argv[2]))) process.exitCode = 1;
  } catch {
    console.error("Secret scan validation failed; scanner output was not logged");
    process.exitCode = 1;
  }
}

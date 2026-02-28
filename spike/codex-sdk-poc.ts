type CheckStatus = "pass" | "fail" | "skipped";

interface CheckRow {
  name: string;
  status: CheckStatus;
  details: string;
}

const requiredChecks: CheckRow[] = [
  { name: "OPENAI_API_KEY auth", status: "skipped", details: "Preflight mode: no API call executed." },
  { name: "workspace path control", status: "skipped", details: "Preflight mode: no runtime workspace created." },
  { name: "AGENTS.md instruction pickup", status: "skipped", details: "Preflight mode: instruction loading not executed." },
  { name: "thread persistence via run()", status: "skipped", details: "Preflight mode: run() not invoked." },
  { name: "thread persistence via resumeThread(threadId)", status: "skipped", details: "Preflight mode: resumeThread(threadId) not invoked." },
  { name: "CODEX_HOME skills behavior", status: "skipped", details: "Preflight mode: CODEX_HOME staging not executed." },
  { name: "structured output capture", status: "skipped", details: "Preflight mode: no structured runtime output." },
];

const report = {
  mode: "preflight",
  checks: requiredChecks,
  tokens: {
    total: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
    },
  },
  cost: {
    value_usd: null as number | null,
    source: "preflight-no-runtime",
  },
  mappingNotes: [
    "Preflight only: runtime integration disabled.",
    "Thread mapping reference includes run() and resumeThread(threadId).",
  ],
};

console.log(JSON.stringify(report, null, 2));

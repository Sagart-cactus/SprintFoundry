import { createServer } from "node:http";
import { once } from "node:events";
import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { expect, it } from "vitest";
import { MetricsService } from "../src/service/metrics-service.js";

it("exports real orchestration metrics through the HTTP exporter", async () => {
  const requests: { path: string | undefined; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url, body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const exporter = new OTLPMetricExporter({
    url: `http://127.0.0.1:${address.port}/v1/metrics`,
    timeoutMillis: 2_000,
  });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 15_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  try {
    const service = new MetricsService(true);
    service.recordRunStarted({ project_id: "test", source: "prompt", run_id: "test-run" });
    service.recordRunCompleted({
      project_id: "test",
      source: "prompt",
      run_id: "test-run",
      status: "completed",
      durationMs: 2_000,
      planSteps: 3,
    });
    await provider.forceFlush();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/v1/metrics");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: expect.arrayContaining([
                expect.objectContaining({
                  name: "sprintfoundry_runs_total",
                  sum: expect.objectContaining({
                    dataPoints: [expect.objectContaining({ asDouble: 1 })],
                  }),
                }),
                expect.objectContaining({
                  name: "sprintfoundry_run_duration_seconds",
                  histogram: expect.objectContaining({
                    dataPoints: [expect.objectContaining({ count: 1, sum: 2 })],
                  }),
                }),
              ]),
            },
          ],
        },
      ],
    });
  } finally {
    metrics.disable();
    await provider.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

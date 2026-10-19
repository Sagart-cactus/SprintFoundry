module.exports = {
  forbidden: [
    {
      name: "no-circular-dependencies",
      severity: "error",
      from: { path: ".+" },
      to: { circular: true },
    },
    {
      name: "shared-layer-does-not-import-services",
      severity: "error",
      from: { path: "^src/shared" },
      to: { path: "^src/service" },
    },
    {
      name: "services-do-not-import-agent-prompts",
      severity: "error",
      from: { path: "^src/service" },
      to: { path: "^src/agents(-codex)?/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
    },
  },
};

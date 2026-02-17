/**
 * Migrate deprecated AGENTSDLC_* environment variables to SPRINTFOUNDRY_*.
 * Call at startup before any config loading.
 */
export function migrateEnvVars(): void {
  const oldPrefix = "AGENTSDLC_";
  const newPrefix = "SPRINTFOUNDRY_";
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(oldPrefix) && value) {
      const newKey = key.replace(oldPrefix, newPrefix);
      if (!process.env[newKey]) {
        process.env[newKey] = value;
        console.warn(
          `[sprintfoundry] Deprecated env var ${key} — use ${newKey} instead`
        );
      }
    }
  }
}

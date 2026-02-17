# SprintFoundry Plugins

This directory contains plugins that extend agent capabilities. Plugins are passed to Claude Code via the `--plugin-dir` flag.

## Structure

Each plugin is a subdirectory following the Claude Code plugin format:

```
plugins/
  frontend-design/     # UI/UX design skills and tools
    plugin.json        # Plugin manifest
    skills/            # Skill definitions
    commands/          # Slash commands
    ...
```

## How Plugins Are Used

1. Agent definitions in `config/platform.yaml` declare which plugins they use:
   ```yaml
   - type: ui-ux
     plugins:
       - frontend-design
   ```

2. When the agent runner spawns an agent, it resolves plugin paths and passes them:
   - **Local mode**: `--plugin-dir plugins/frontend-design`
   - **Container mode**: Mounts as volumes and sets `AGENT_PLUGIN_DIRS` env var

## Creating a Plugin

See the [Claude Code plugin documentation](https://docs.anthropic.com/en/docs/claude-code/plugins) for the full plugin specification.

A minimal plugin needs:
- `plugin.json` — manifest with name, description, and component declarations
- At least one skill, command, hook, or MCP server definition

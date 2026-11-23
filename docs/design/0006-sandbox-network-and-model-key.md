# 0006: The sandbox has no key and one network peer

Status: decided on 22 November 2026 after a spike, and built on 23 November 2026 (`internal/proxy`, `cmd/sprintfoundry-proxy`, `internal/sandbox/containerbox`, `internal/agent/sandboxed`).

## Decision

A builder sandbox is attached to one internal network. The only other container on that network is the controller's proxy. The proxy removes any credential header the agent sent, adds the real model key, and forwards to one allowed upstream. The key exists only in the proxy's environment.

## What the spike showed

Run on Podman 5.7 (macOS). A fake model API stood in for the real one, so no real key was used.

| Question | Result |
|---|---|
| Does the upstream receive the injected key and not the client's? | Yes. The sandbox sent its own `Authorization` and `x-api-key`; the upstream logged only the injected `Authorization` |
| Can the sandbox reach the internet? | No. By address: `Network unreachable`. By name: `NXDOMAIN` |
| Can it reach the host or the upstream directly? | No. The host aliases and the upstream's address are unreachable. The network's own gateway answers only DNS |
| Is any key visible inside? | No. `env` held `HOME`, `PATH`, `PWD`, `SHLVL` and `container` only |
| Does Codex CLI run this way? | Yes. `codex exec --json` completed a turn with an empty environment, using a custom provider whose base URL is the proxy |
| Does Claude Code run this way? | Yes, with one condition below. `claude -p --output-format json` completed a turn |

## Consequences for the design

1. **Placeholder credential for Claude Code.** It refuses to start without a credential variable. A fixed placeholder works because the proxy replaces the header. A sandbox spec therefore gets a separate list of *placeholder names*. The controller fills each with the same public constant. Callers still cannot put a credential-looking name in the environment themselves.
2. **Header per provider.** The proxy injects `Authorization` for OpenAI-style upstreams and `x-api-key` for Anthropic.
3. **Path and body allowlist.** The proxy forwards only the paths an agent needs, for example `POST /v1/responses`. A path list alone is not enough: model APIs accept tools that run on the provider's side (web search, URL fetch, remote tool servers, code execution), and those would give the sandbox a way out and a way in. The proxy therefore parses the JSON body and refuses provider-side tool types and top-level fields it does not know.
4. **Codex uses a custom provider entry.** With the built-in provider it tries a WebSocket first and loses about six seconds before falling back.
5. **Start order on Podman.** The proxy starts on the upstream network and is then connected to the internal one.
6. **No network for the agent's tools.** `git fetch` and `npm install` fail inside the sandbox by design. A repository that needs packages gets them from the image or from registries the proxy allows.
7. **Spend cap.** The proxy counts requests and tokens per run and stops forwarding at the cap.

## Remaining risk

Whatever the agent sends to the model reaches the model provider. That includes the repository contents the agent reads. This is inherent in using a hosted model and is stated in the docs.

## How it is built

- The sandbox's root file system is read-only. The builder works in in-memory directories (`/workspace`, `/home/agent`, `/sf`), and nothing from the host is mounted; files go in and out as tar streams.
- Each round gets a fresh sandbox with a clone of the parent commit, the previous round's change applied, and `/sf/task.md` holding the criteria and the feedback.
- The proxy runs as its own FROM scratch container with built-in root certificates. It receives the key in an env file, never on a command line, and logs method, path and outcome only.
- The proxy forwards the body it checked, re-encoded, not the bytes it was sent, so a repeated JSON key cannot hide a tool from the check.

## Not verified

- Docker Engine. Only Podman was run; CI covers Docker on Linux in milestone 1.
- A real upstream over TLS with a real key. That needs the owner's key and a spend cap.
- A turn in which the agent calls tools, including Codex's own shell sandbox inside a container.

## Rejected

- **Key in the sandbox environment.** Any prompt injection could print it.
- **Host networking with a firewall rule.** Not portable across Docker and Podman, and easy to get wrong silently.

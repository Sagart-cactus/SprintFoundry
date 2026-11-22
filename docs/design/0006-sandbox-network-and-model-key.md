# 0006: The sandbox has no key and one network peer

Status: decided on 22 November 2026 after a spike.

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
3. **Path allowlist.** The proxy forwards only the paths an agent needs, for example `POST /v1/responses`. Everything else is refused.
4. **Codex uses a custom provider entry.** With the built-in provider it tries a WebSocket first and loses about six seconds before falling back.
5. **Start order on Podman.** The proxy starts on the upstream network and is then connected to the internal one.
6. **No network for the agent's tools.** `git fetch` and `npm install` fail inside the sandbox by design. A repository that needs packages gets them from the image or from registries the proxy allows.
7. **Spend cap.** The proxy counts requests and tokens per run and stops forwarding at the cap.

## Not verified

- Docker Engine. Only Podman was run; CI covers Docker on Linux in milestone 1.
- A real upstream over TLS with a real key. That needs the owner's key and a spend cap.
- A turn in which the agent calls tools, including Codex's own shell sandbox inside a container.

## Rejected

- **Key in the sandbox environment.** Any prompt injection could print it.
- **Host networking with a firewall rule.** Not portable across Docker and Podman, and easy to get wrong silently.

# 0007: In local mode the candidate is identified by its image ID

Status: decided on 22 November 2026 after a probe. Changes step 6 of milestone 1 in the build plan.

## Decision

On a laptop, the controller identifies a candidate by its **image ID**, as the container runtime reports it. On Podman and on Docker's classic image store that is the SHA-256 of the image configuration, which covers every layer. On Docker's containerd image store it is a manifest digest. Either way it is a content hash the runtime will run exactly. The preview is started from that ID, the controller reads the ID back from the running container before and after evaluation, and the evidence names it as the subject with `digestKind: image-config`.

When a real registry is involved (milestone 2 onward), the subject is the **manifest digest**, because that is what a registry and a deployment refer to.

`sprintfoundry verify` accepts either form and never a tag.

## Rejected

**A local registry container to obtain a manifest digest.** The build plan asked for this. A probe on Podman 5.7 showed why it is the wrong default for a first run:

| What we saw | Consequence |
|---|---|
| `docker push` to `localhost` failed with "server gave HTTP response to HTTPS client" until `--tls-verify=false` was added | That flag exists on Podman and not on Docker, so the controller would need runtime-specific code |
| The digest Podman reported locally differed from the digest the registry stored after the push | Two digests for one image invites comparing the wrong one |
| Starting a container from `name@digest` tried to pull over HTTPS and failed | The preview could not start from the digest without the same flag again |
| One more image to pull and one more container to run | Slower first run for no gain in what is proven |

## What the probe confirmed

- A build from a tar stream on standard input with `--network=none` works, so the controller can build from `git archive` output without checking out a working tree.
- A container started from an image ID on an internal network reports that ID in `inspect`, and a second container on the same network can reach it by name.
- Building the same source twice gave two different image IDs. Builds are not reproducible, which is why design 0002 never rebuilds and trusts.

## Consequences

- No registry container in the demo.
- The evidence statement says which kind of digest its subject is. A verify policy for `production` requires a manifest digest.

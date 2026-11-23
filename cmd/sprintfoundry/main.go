// Command sprintfoundry is the single binary of SprintFoundry v1.
package main

import (
	"fmt"
	"io"
	"os"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const usage = `sprintfoundry builds a change with a coding agent, checks the exact
built image with an independent runner, and signs the verdict.

Usage:
  sprintfoundry <command>

Commands:
  demo      Run the built-in demo: one feature, two builders, signed evidence
  run       Run Codex CLI on a repository in a keyless sandbox, check and sign
  verify    Ask whether an image may be released under a policy
  down      Stop the local database (add --purge to delete its data)
  version   Print the version
  help      Show this help
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "version", "--version":
		fmt.Fprintln(stdout, version)
		return 0
	case "demo":
		return demoCommand(args[1:], stdout, stderr)
	case "run":
		return runCommand(args[1:], stdout, stderr)
	case "verify":
		return verifyCommand(args[1:], stdout, stderr)
	case "down":
		return downCommand(args[1:], stdout, stderr)
	case "help", "--help", "-h":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "sprintfoundry: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}

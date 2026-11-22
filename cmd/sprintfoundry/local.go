package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/gitimport"
	"github.com/sagart-cactus/sprintfoundry/internal/local"
	"github.com/sagart-cactus/sprintfoundry/internal/runspec"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
	"github.com/sagart-cactus/sprintfoundry/internal/verify"
)

// environment is what every local command needs.
type environment struct {
	home   local.Home
	cli    container.CLI
	store  *postgres.Store
	signer *signer.Demo
}

func homeFlag(fs *flag.FlagSet) *string {
	return fs.String("home", "", "directory for SprintFoundry's own files (default $SPRINTFOUNDRY_HOME or ~/.sprintfoundry)")
}

func open(ctx context.Context, homeDir string, logf func(string, ...any)) (*environment, error) {
	home := local.Home{Dir: homeDir}
	if homeDir == "" {
		var err error
		if home, err = local.DefaultHome(); err != nil {
			return nil, err
		}
	}
	cli := container.CLI{}
	if err := cli.Available(ctx); err != nil {
		return nil, fmt.Errorf("%w\nSprintFoundry needs Docker or Podman running on this machine", err)
	}
	sgn, err := home.DemoSigner()
	if err != nil {
		return nil, err
	}
	logf("Starting the local database (first run pulls a small Postgres image)")
	url, err := home.Postgres(ctx, cli)
	if err != nil {
		return nil, err
	}
	store, err := postgres.Open(ctx, url)
	if err != nil {
		return nil, err
	}
	return &environment{home: home, cli: cli, store: store, signer: sgn}, nil
}

// build turns a commit in the controller's store into an image. The build
// context is the commit's own tree, streamed from the bare repository, and
// the build has no network.
func (e *environment) build(ctx context.Context, storeDir, commit string, spec runspec.Spec) (string, error) {
	var tarball bytes.Buffer
	if err := gitimport.Archive(ctx, storeDir, commit, &tarball); err != nil {
		return "", err
	}
	return e.cli.Build(ctx, &tarball, container.BuildOptions{
		Dockerfile: spec.Build.Dockerfile, Network: spec.Build.Network,
		Labels: map[string]string{"sprintfoundry.component": "candidate"},
	})
}

// decide asks the controller for a release decision and checks it against
// the policy, as a delivery pipeline would. In this local mode the controller
// and the verifier run in one process; they exchange only the signed decision.
func (e *environment) decide(ctx context.Context, policy verify.Policy, policyPath string, image verify.Image, now time.Time) (bool, string, error) {
	envelope, reasons, err := verify.Decide(ctx, e.store, e.signer, policy, "file:"+policyPath, image, now)
	if errors.Is(err, verify.ErrNoEvidence) {
		return false, "the controller has no evidence for this image", nil
	}
	if err != nil {
		return false, "", err
	}
	if err := verify.Check(envelope, policy, image, now); err != nil {
		reason := err.Error()
		if len(reasons) > 0 {
			reason = reasons[0]
			for _, r := range reasons[1:] {
				reason += "; " + r
			}
		}
		return false, reason, nil
	}
	return true, "a trusted signer authorised this image under this policy, minutes ago", nil
}

func demoPolicy(sgn *signer.Demo, repository, criteria, suite, runSpec string) []byte {
	return []byte(fmt.Sprintf(`# Verify policy written by "sprintfoundry demo".
# It trusts only this machine's demo signer and only for the demo purpose.
version: 1
purpose: demo
repository: %s
environment: demo
trusted_signers:
  - identity: %s
    public_key: %s
expect:
  criteria: %s
  check_suite: %s
  run_spec: %s
max_evidence_age: 24h
max_decision_age: 15m
`, repository, sgn.Identity(), base64.StdEncoding.EncodeToString(sgn.PublicKey()), criteria, suite, runSpec))
}

func verifyCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := homeFlag(fs)
	policyPath := fs.String("policy", "", "path of the verify policy file (required)")
	fs.Usage = func() {
		fmt.Fprint(stderr, "Usage: sprintfoundry verify --policy FILE <image ID | name@sha256:digest>\n\nExit status 0 means the release is authorised. A tag is never accepted.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 || *policyPath == "" {
		fs.Usage()
		return 2
	}
	image, err := verify.ParseImage(fs.Arg(0))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	raw, err := os.ReadFile(*policyPath)
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: read policy: %v\n", err)
		return 2
	}
	policy, err := verify.ParsePolicy(raw)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	env, err := open(ctx, *home, func(string, ...any) {})
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 2
	}
	defer env.store.Close()

	ok, reason, err := env.decide(ctx, policy, *policyPath, image, time.Now())
	if err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 2
	}
	if !ok {
		fmt.Fprintf(stdout, "REJECTED  %s\n          %s\n", image.Digest[:12], reason)
		return 1
	}
	fmt.Fprintf(stdout, "ACCEPTED  %s\n          %s\n", image.Digest[:12], reason)
	return 0
}

func downCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("down", flag.ContinueOnError)
	fs.SetOutput(stderr)
	homeDir := homeFlag(fs)
	purge := fs.Bool("purge", false, "also delete the database's data and its stored password")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	home := local.Home{Dir: *homeDir}
	if *homeDir == "" {
		var err error
		if home, err = local.DefaultHome(); err != nil {
			fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
			return 2
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := home.Down(ctx, container.CLI{}, *purge); err != nil {
		fmt.Fprintf(stderr, "sprintfoundry: %v\n", err)
		return 1
	}
	fmt.Fprintln(stdout, "The local database is stopped.")
	return 0
}

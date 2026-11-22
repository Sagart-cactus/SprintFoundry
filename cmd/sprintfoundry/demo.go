package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/controller"
	"github.com/sagart-cactus/sprintfoundry/internal/demo"
	"github.com/sagart-cactus/sprintfoundry/internal/evaluate"
	"github.com/sagart-cactus/sprintfoundry/internal/evidence"
	"github.com/sagart-cactus/sprintfoundry/internal/report"
	"github.com/sagart-cactus/sprintfoundry/internal/runnerimage"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
	"github.com/sagart-cactus/sprintfoundry/internal/verify"
)

func demoCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("demo", flag.ContinueOnError)
	fs.SetOutput(stderr)
	homeDir := homeFlag(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := runDemo(*homeDir, stdout); err != nil {
		fmt.Fprintf(stderr, "\nsprintfoundry: the demo could not finish: %v\n", err)
		return 1
	}
	return 0
}

func runDemo(homeDir string, out io.Writer) error {
	started := time.Now()
	// Stop cleanly on Ctrl-C or a termination signal: the run is cancelled
	// and every evaluation removes the containers and the network it started.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	say := func(format string, args ...any) { fmt.Fprintf(out, format+"\n", args...) }
	step := func(format string, args ...any) { fmt.Fprintf(out, "  "+format+"\n", args...) }

	say("SprintFoundry demo")
	say("One feature request, two builders, three candidate images, and a release")
	say("gate that accepts only an image whose independent checks passed.")
	say("No model and no API key are used: the builders are recordings.")
	say("")

	env, err := open(ctx, homeDir, step)
	if err != nil {
		return err
	}
	defer env.store.Close()

	step("Building the check runner image (one static binary, no model)")
	runnerImage, err := runnerimage.Build(ctx, env.cli, env.home.Labels())
	if err != nil {
		return err
	}
	work := env.home.Path("demo")
	if err := os.RemoveAll(work); err != nil {
		return err
	}
	if err := os.MkdirAll(work, 0o700); err != nil {
		return err
	}
	storeDir := filepath.Join(work, "store.git")
	parent, err := demo.SeedStore(ctx, storeDir)
	if err != nil {
		return err
	}

	say("")
	say("The request, approved before any code exists:")
	fmt.Fprintf(out, "\n%s\n", indent(string(demo.Criteria())))
	say("A check suite was approved with it and frozen. No builder ever sees it.")

	// Each demo is its own repository. The evaluation allowance and the rule
	// that a newer run supersedes an older one are both per repository and
	// criteria, and they never reset, so a second demo must not inherit the
	// first one's history.
	nonce := make([]byte, 4)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	stamp := strconv.FormatInt(started.Unix(), 36) + "-" + hex.EncodeToString(nonce)
	repository := demo.Repository + "-" + stamp

	scenario := func(title, id string, variants ...string) (controller.Result, error) {
		say("")
		say("%s", title)
		result, err := controller.Run(ctx, controller.Deps{
			Store: env.store, Signer: env.signer,
			Agent: demo.Builder(work, storeDir, parent, variants...),
			Build: env.build,
			Evaluate: func(ctx context.Context, req evaluate.Request) (evaluate.Result, error) {
				return evaluate.Run(ctx, env.cli, req)
			},
			Now: time.Now, Log: step,
		}, controller.Request{
			RunID: id, Repository: repository, StoreDir: storeDir, Parent: parent,
			Criteria: demo.Criteria(), Suite: demo.Checks(), RunSpec: demo.RunSpec(),
			Purpose: signer.PurposeDemo, ImageName: repository, DigestKind: evidence.ImageConfig,
			RunnerImage: runnerImage, NameKey: env.nameKey, Labels: env.home.Labels(),
		})
		if err != nil {
			return controller.Result{}, err
		}
		if result.Reason != "" {
			step("Result: %s. %s", result.State, result.Reason)
		} else {
			step("Result: %s", result.State)
		}
		return result, nil
	}

	policyPath := filepath.Join(work, "verify-policy.yaml")
	var policy verify.Policy
	var verifications []report.Verification
	// ask puts one question to the release gate and checks the answer is the
	// one the demo is built to show.
	ask := func(label, image string, wantAccepted bool) error {
		ok, reason, err := env.decide(ctx, policy, policyPath, verify.Image{Digest: image}, time.Now())
		if err != nil {
			return err
		}
		answer := "REJECTED"
		if ok {
			answer = "ACCEPTED"
		}
		step("%s  %s  %s", answer, image[:12], label)
		step("          %s", reason)
		verifications = append(verifications, report.Verification{Label: label, Image: image, Accepted: ok, Reason: reason})
		if ok != wantAccepted {
			return fmt.Errorf("the release gate gave an unexpected answer for %s", label)
		}
		return nil
	}

	tamper, err := scenario("Builder 1 implements the feature and also rewrites a test and the Dockerfile",
		"demo-"+stamp+"-a", "tamper")
	if err != nil {
		return err
	}
	if len(tamper.Rounds) != 1 || tamper.State != controller.NeedsOwner {
		return fmt.Errorf("the demo did not play out as designed: builder 1 ended %s after %d round(s): %s", tamper.State, len(tamper.Rounds), tamper.Reason)
	}
	policyBytes := demoPolicy(env.signer, repository, tamper.CriteriaDigest, tamper.SuiteDigest, tamper.RunSpecDigest)
	if err := os.WriteFile(policyPath, policyBytes, 0o600); err != nil {
		return err
	}
	if policy, err = verify.ParsePolicy(policyBytes); err != nil {
		return err
	}
	say("")
	say("The release gate: may builder 1's image be released? Its checks passed.")
	if err := ask("builder 1's image, which rewrote a test and the Dockerfile", tamper.Rounds[0].Image, false); err != nil {
		return err
	}

	main, err := scenario("Builder 2 ships a defect, gets it back, and repairs it",
		"demo-"+stamp+"-b", "defect", "fixed")
	if err != nil {
		return err
	}
	if len(main.Rounds) != 2 || main.State != controller.Passed {
		return fmt.Errorf("the demo did not play out as designed: builder 2 ended %s after %d round(s): %s", main.State, len(main.Rounds), main.Reason)
	}
	say("")
	say("The release gate: may these exact images be released?")
	if err := ask("builder 2's repaired image", main.Rounds[1].Image, true); err != nil {
		return err
	}
	if err := ask("builder 2's image with the defect", main.Rounds[0].Image, false); err != nil {
		return err
	}

	reportPath := filepath.Join(work, "report.html")
	f, err := os.Create(reportPath)
	if err != nil {
		return err
	}
	err = report.Write(f, report.Page{
		Generated: time.Now(), Criteria: string(demo.Criteria()), SignerID: env.signer.Identity(),
		Runs: []report.Run{
			{Title: "Builder 1: rewrote a test and the Dockerfile", Result: tamper},
			{Title: "Builder 2: a defect, then a repair", Result: main},
		},
		Verifications: verifications,
	})
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}

	say("")
	say("Done in %s.", time.Since(started).Round(time.Second))
	say("  Evidence report: %s", reportPath)
	say("  Verify policy:   %s", policyPath)
	say("")
	say("Ask the gate yourself (exit status 0 means accepted):")
	say("  sprintfoundry verify --policy %s %s", policyPath, main.Rounds[1].Image)
	say("  sprintfoundry verify --policy %s %s", policyPath, main.Rounds[0].Image)
	say("")
	say("The candidates ran in ordinary containers. That is not a security boundary")
	say("against a hostile agent.")
	say("Remove the local database and the demo's images with: sprintfoundry down --purge")
	return nil
}

func indent(text string) string {
	out := ""
	for _, line := range splitLines(text) {
		out += "    " + line + "\n"
	}
	return out
}

func splitLines(text string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			lines = append(lines, text[start:i])
			start = i + 1
		}
	}
	if start < len(text) {
		lines = append(lines, text[start:])
	}
	return lines
}

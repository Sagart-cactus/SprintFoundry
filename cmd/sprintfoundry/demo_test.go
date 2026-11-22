package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/local"
	"github.com/sagart-cactus/sprintfoundry/internal/runnerimage"
)

// TestDemoEndToEnd is the milestone 1 exit test as a program: on a machine
// with only a container runtime it runs the whole demo, then asks the release
// gate from a separate command, as a delivery pipeline would.
func TestDemoEndToEnd(t *testing.T) {
	cli := container.CLI{}
	probe, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	skip := func(reason string) {
		if os.Getenv("CI") != "" && os.Getenv("SPRINTFOUNDRY_NO_CONTAINERS") == "" {
			t.Fatalf("%s; in CI this test must not be skipped silently", reason)
		}
		t.Skip(reason)
	}
	if err := cli.Available(probe); err != nil {
		skip("no container runtime: " + err.Error())
	}
	if _, err := runnerimage.Binary(cli.Arch(probe)); errors.Is(err, runnerimage.ErrNotEmbedded) {
		skip(err.Error())
	}

	home := local.Home{Dir: filepath.Join(t.TempDir(), "home")}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_ = home.Down(ctx, cli, true)
	})

	var out bytes.Buffer
	if err := runDemo(home.Dir, &out); err != nil {
		t.Fatalf("demo failed: %v\n%s", err, out.String())
	}
	transcript := out.String()
	for _, want := range []string{
		"Round 1: the change touches protected paths: [Dockerfile test_app.py]",
		"Round 1: evaluation failed",
		"feedback to the builder: export-owner-only: a request that should be refused was allowed",
		"Round 2: evaluation passed",
		"Result: passed",
	} {
		if !strings.Contains(transcript, want) {
			t.Errorf("the demo transcript lacks %q", want)
		}
	}
	for _, secret := range []string{"export-denied", "export-signed-out", "member-session", "/invoices/export.csv"} {
		if strings.Contains(transcript, secret) {
			t.Errorf("the demo transcript shows %q, which a builder must never see", secret)
		}
	}

	// The gate, asked from a separate command with only the policy file and an image ID.
	commands := regexp.MustCompile(`sprintfoundry verify --policy (\S+) ([0-9a-f]{64})`).FindAllStringSubmatch(transcript, -1)
	if len(commands) != 2 {
		t.Fatalf("expected two verify commands in the transcript, found %d\n%s", len(commands), transcript)
	}
	policy, repaired, defective := commands[0][1], commands[0][2], commands[1][2]

	ask := func(image string, extra ...string) (int, string) {
		var stdout, stderr bytes.Buffer
		args := append([]string{"verify", "--home", home.Dir, "--policy", policy}, extra...)
		code := run(append(args, image), &stdout, &stderr)
		return code, stdout.String() + stderr.String()
	}
	if code, text := ask(repaired); code != 0 || !strings.Contains(text, "ACCEPTED") {
		t.Errorf("the repaired image: exit %d, %s", code, text)
	}
	if code, text := ask(defective); code != 1 || !strings.Contains(text, "did not pass") {
		t.Errorf("the defective image: exit %d, %s", code, text)
	}
	if code, text := ask(strings.Repeat("a", 64)); code != 1 || !strings.Contains(text, "no evidence") {
		t.Errorf("an image nobody evaluated: exit %d, %s", code, text)
	}
	if code, _ := ask("local/invoices:latest"); code != 2 {
		t.Errorf("a tag: exit %d, want 2", code)
	}

	// A policy that expects other criteria rejects the same image.
	raw, err := os.ReadFile(policy)
	if err != nil {
		t.Fatal(err)
	}
	other := regexp.MustCompile(`criteria: sha256:[0-9a-f]{64}`).ReplaceAll(raw, []byte("criteria: sha256:"+strings.Repeat("0", 64)))
	otherPath := filepath.Join(t.TempDir(), "other-policy.yaml")
	if err := os.WriteFile(otherPath, other, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if code := run([]string{"verify", "--home", home.Dir, "--policy", otherPath, repaired}, &stdout, &stderr); code != 1 || !strings.Contains(stdout.String(), "criteria digest differs") {
		t.Errorf("policy for other criteria: exit %d, %s%s", code, stdout.String(), stderr.String())
	}

	report, err := os.ReadFile(filepath.Join(home.Dir, "demo", "report.html"))
	if err != nil || !strings.Contains(string(report), "Release gate") || !strings.Contains(string(report), "holdout") {
		t.Errorf("the evidence report is missing or incomplete: %v", err)
	}
	for _, name := range []string{"demo-signer.seed", "postgres.json"} {
		info, err := os.Stat(filepath.Join(home.Dir, name))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("%s: %v, mode %v; want a file only the user can read", name, err, info)
		}
	}
}

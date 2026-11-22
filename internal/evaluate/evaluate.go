// Package evaluate runs one evaluation: it starts the candidate as a preview
// on an internal network, lets the check runner observe it, and grades what
// the runner saw. It checks that the image being served is the candidate
// both before and after, and discards the result if it is not.
package evaluate

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/runner"
	"github.com/sagart-cactus/sprintfoundry/internal/runspec"
)

// Errors returned by Run. Callers match them with errors.Is.
var (
	// ErrNotServingCandidate means the preview was not running the candidate
	// image when the evaluation was about to start.
	ErrNotServingCandidate = errors.New("evaluate: the preview is not serving the candidate")
	// ErrPreviewChanged means the preview stopped, or served another image,
	// by the time the evaluation ended. The result is discarded.
	ErrPreviewChanged = errors.New("evaluate: the preview changed during evaluation; result discarded")
	// ErrRunnerOutput means the runner did not return usable observations.
	ErrRunnerOutput = errors.New("evaluate: the runner returned no usable observations")
)

// maxRunnerOutput bounds what the controller reads from a runner.
const maxRunnerOutput = 8 << 20

var runIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)

// Request is one evaluation.
type Request struct {
	// RunID names the containers and the network. Lower-case letters, digits
	// and dashes.
	RunID string
	// Candidate is the image ID to evaluate.
	Candidate string
	// RunnerImage is the image ID of the check runner.
	RunnerImage string
	Spec        runspec.Spec
	Suite       checks.Suite
	// Labels are added to the containers and the network, so that leftovers
	// of an interrupted run can be found and removed.
	Labels map[string]string
}

// Result is a graded evaluation.
type Result struct {
	Report       checks.Report
	Observations []checks.Observation
	// Served is the image ID the runtime reported for the preview, before
	// and after the checks ran.
	ServedBefore string
	ServedAfter  string
}

// hooks let tests interfere at the two moments the served-image check guards.
type hooks struct {
	afterPreviewStart func(ctx context.Context, previewName, network string)
	beforeFinalCheck  func(ctx context.Context, previewName, network string)
}

// Run performs the evaluation and removes everything it started.
func Run(ctx context.Context, cli container.CLI, req Request) (Result, error) {
	return run(ctx, cli, req, hooks{})
}

func run(ctx context.Context, cli container.CLI, req Request, h hooks) (res Result, err error) {
	if !runIDPattern.MatchString(req.RunID) {
		return Result{}, fmt.Errorf("evaluate: run ID %q is not allowed", req.RunID)
	}
	// Random bytes keep two evaluations apart even if they share a run ID.
	nonce := make([]byte, 4)
	if _, err := rand.Read(nonce); err != nil {
		return Result{}, fmt.Errorf("evaluate: random name: %w", err)
	}
	base := "sf-" + req.RunID + "-" + hex.EncodeToString(nonce)
	network, preview, runnerName := base+"-eval", base+"-preview", base+"-runner"
	labels := map[string]string{"sprintfoundry.run": req.RunID}
	for name, value := range req.Labels {
		labels[name] = value
	}

	// Clean up only what this call created, with a fresh context so that a
	// cancelled run still tidies up.
	var networkCreated, previewCreated bool
	defer func() {
		bg := context.WithoutCancel(ctx)
		if previewCreated {
			_ = cli.Remove(bg, preview, runnerName)
		}
		if networkCreated {
			_ = cli.NetworkRemove(bg, network)
		}
	}()

	if err := cli.NetworkCreate(ctx, network, true, labels); err != nil {
		return Result{}, fmt.Errorf("evaluate: create network: %w", err)
	}
	networkCreated = true
	previewCreated = true // set before the call: a failed start can still leave a container
	if _, err := cli.Run(ctx, container.RunOptions{
		Name: preview, Image: req.Candidate, Network: network, Env: req.Spec.Preview.Env,
		Labels: labels, MemoryMB: 512, CPUs: 1, PIDs: 256,
	}); err != nil {
		return Result{}, fmt.Errorf("evaluate: start preview: %w", err)
	}
	if h.afterPreviewStart != nil {
		h.afterPreviewStart(ctx, preview, network)
	}

	res.ServedBefore, err = cli.ImageOf(ctx, preview)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrNotServingCandidate, err)
	}
	if res.ServedBefore != req.Candidate {
		return Result{}, fmt.Errorf("%w: serving %s, candidate is %s", ErrNotServingCandidate, res.ServedBefore, req.Candidate)
	}

	job := runner.Job{
		BaseURL:        "http://" + preview + ":" + strconv.Itoa(req.Spec.Preview.Port),
		Actors:         map[string]runner.Actor{},
		Checks:         req.Suite.Checks,
		TimeoutSeconds: 20,
		Ready:          runner.Ready{Path: req.Spec.Preview.Health.Path, Status: req.Spec.Preview.Health.Status, WaitSeconds: 60},
	}
	for name, actor := range req.Spec.Actors {
		job.Actors[name] = runner.Actor{Headers: actor.Headers}
	}
	jobJSON, err := json.Marshal(job)
	if err != nil {
		return Result{}, fmt.Errorf("evaluate: encode job: %w", err)
	}
	out, err := cli.RunOnce(ctx, container.RunOptions{
		Name: runnerName, Image: req.RunnerImage, Network: network,
		Labels: labels, MemoryMB: 512, CPUs: 1, PIDs: 256,
	}, bytes.NewReader(jobJSON))
	if err != nil {
		return Result{}, fmt.Errorf("evaluate: run the check runner: %w", err)
	}
	if out.ExitCode != 0 {
		return Result{}, fmt.Errorf("%w: exit %d: %s", ErrRunnerOutput, out.ExitCode, tail(out.Stderr))
	}
	if len(out.Stdout) > maxRunnerOutput {
		return Result{}, fmt.Errorf("%w: output larger than %d bytes", ErrRunnerOutput, maxRunnerOutput)
	}
	dec := json.NewDecoder(bytes.NewReader(out.Stdout))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&res.Observations); err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrRunnerOutput, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Result{}, fmt.Errorf("%w: trailing data after the observations", ErrRunnerOutput)
	}

	if h.beforeFinalCheck != nil {
		h.beforeFinalCheck(ctx, preview, network)
	}
	running, err := cli.Running(ctx, preview)
	if err != nil || !running {
		return Result{}, fmt.Errorf("%w: the preview is no longer running", ErrPreviewChanged)
	}
	res.ServedAfter, err = cli.ImageOf(ctx, preview)
	if err != nil || res.ServedAfter != req.Candidate {
		return Result{}, fmt.Errorf("%w: now serving %q", ErrPreviewChanged, res.ServedAfter)
	}

	res.Report, err = checks.Grade(req.Suite, res.Observations)
	if err != nil {
		return Result{}, err
	}
	return res, nil
}

func tail(b []byte) string {
	if len(b) > 400 {
		b = b[len(b)-400:]
	}
	return string(bytes.TrimSpace(b))
}

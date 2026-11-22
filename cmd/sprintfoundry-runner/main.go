// Command sprintfoundry-runner is the check runner. It reads one job as JSON
// on standard input, observes the preview, and writes its observations as
// JSON on standard output. It holds no model and no credentials beyond the
// fixture headers in the job, and it never decides pass or fail.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
	"github.com/sagart-cactus/sprintfoundry/internal/runner"
)

// maxJobBytes bounds the job the runner will read.
const maxJobBytes = 4 << 20

func main() {
	os.Exit(run(os.Stdin, os.Stdout, os.Stderr))
}

func run(stdin io.Reader, stdout, stderr io.Writer) int {
	var job runner.Job
	dec := json.NewDecoder(io.LimitReader(stdin, maxJobBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&job); err != nil {
		fmt.Fprintf(stderr, "sprintfoundry-runner: cannot read the job: %v\n", err)
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	var observations []checks.Observation
	if err := runner.WaitReady(ctx, job); err != nil {
		for _, c := range job.Checks {
			observations = append(observations, checks.Observation{Check: c.ID, Error: err.Error()})
		}
	} else {
		observations = runner.Run(ctx, job, nil)
	}
	if err := json.NewEncoder(stdout).Encode(observations); err != nil {
		fmt.Fprintf(stderr, "sprintfoundry-runner: cannot write observations: %v\n", err)
		return 1
	}
	return 0
}

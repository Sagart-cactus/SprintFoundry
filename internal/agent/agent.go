// Package agent defines the builder: a coding agent that turns criteria into
// a change. SprintFoundry does not ship its own agent. An adapter runs an
// existing command-line agent as a process inside a sandbox.
package agent

import (
	"context"
	"errors"

	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
)

// Feedback is what a builder learns from a failed evaluation. It never
// carries a check's request, expected value or ID.
type Feedback struct {
	Criterion string // ID of the criterion that was not met
	Symptom   string // what a user would observe
}

// Task is one piece of work for the builder.
type Task struct {
	// Criteria is the approved criteria text, in plain words.
	Criteria string
	// Feedback lists failures from earlier rounds. Empty on the first round.
	Feedback []Feedback
	// Workdir is the repository checkout inside the sandbox.
	Workdir string
}

// Change is what a builder hands back: data only.
type Change struct {
	// Patch is the output of `git diff --binary` against the parent commit.
	Patch []byte
	// TestedTree is the Git tree hash of the builder's result.
	TestedTree string
	// Summary is the builder's own description. It is shown to people and
	// never reaches the check runner or the grade.
	Summary string
}

// Agent builds a change inside a sandbox.
type Agent interface {
	Name() string
	Run(ctx context.Context, sb sandbox.Sandbox, sandboxID string, task Task) (Change, error)
}

// Replay is an Agent that returns recorded changes in order, one per round.
// The demo uses it so a first run needs no model key, and tests use it to
// play a builder that misbehaves in a known way.
type Replay struct {
	Label   string
	Changes []Change
	round   int
}

var _ Agent = (*Replay)(nil)

// ErrNoMoreChanges is returned when a Replay is asked for more rounds than it
// has recordings.
var ErrNoMoreChanges = errors.New("agent: replay has no recorded change for this round")

func (r *Replay) Name() string {
	if r.Label == "" {
		return "replay"
	}
	return r.Label
}

func (r *Replay) Run(context.Context, sandbox.Sandbox, string, Task) (Change, error) {
	if r.round >= len(r.Changes) {
		return Change{}, ErrNoMoreChanges
	}
	c := r.Changes[r.round]
	r.round++
	return c, nil
}

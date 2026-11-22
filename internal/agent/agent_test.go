package agent_test

import (
	"context"
	"errors"
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/agent"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox/sandboxtest"
)

func TestReplayReturnsOneChangePerRound(t *testing.T) {
	ctx := context.Background()
	var a agent.Agent = &agent.Replay{Changes: []agent.Change{
		{Patch: []byte("first"), TestedTree: "tree-1"},
		{Patch: []byte("second"), TestedTree: "tree-2"},
	}}
	sb := &sandboxtest.Fake{}

	for _, want := range []string{"tree-1", "tree-2"} {
		got, err := a.Run(ctx, sb, "fake-1", agent.Task{Criteria: "export invoices as CSV"})
		if err != nil {
			t.Fatal(err)
		}
		if got.TestedTree != want {
			t.Errorf("tree = %s, want %s", got.TestedTree, want)
		}
	}
	if _, err := a.Run(ctx, sb, "fake-1", agent.Task{}); !errors.Is(err, agent.ErrNoMoreChanges) {
		t.Fatalf("third round: err = %v, want ErrNoMoreChanges", err)
	}
	if a.Name() != "replay" {
		t.Errorf("name = %q", a.Name())
	}
}

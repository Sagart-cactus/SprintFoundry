package effect_test

import (
	"testing"

	"github.com/sagart-cactus/sprintfoundry/internal/effect"
	"github.com/sagart-cactus/sprintfoundry/internal/effect/effecttest"
)

func TestMemoryJournal(t *testing.T) {
	effecttest.Run(t, func(*testing.T) (effect.Journal, func() effect.Journal) {
		j := effect.NewMemory()
		return j, func() effect.Journal { return j }
	})
}

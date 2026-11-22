// Package runnerimage builds the check runner's container image from a
// runner binary embedded in this program, so a first run pulls nothing for
// it. The image is FROM scratch: one static binary and nothing else.
package runnerimage

import (
	"archive/tar"
	"bytes"
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"runtime"
	"strings"

	"github.com/sagart-cactus/sprintfoundry/internal/container"
)

// bin holds runner binaries named runner-linux-<arch>. They are produced by
// `make runner` and are not committed.
//
//go:embed all:bin
var bin embed.FS

// ErrNotEmbedded is returned when this build carries no runner binary for the
// container runtime's architecture.
var ErrNotEmbedded = errors.New("runnerimage: no runner binary embedded for this architecture; build with `make`")

const dockerfile = `FROM scratch
COPY runner /runner
USER 65532:65532
ENTRYPOINT ["/runner"]
`

// Binary returns the embedded runner binary for a Linux architecture.
func Binary(arch string) ([]byte, error) {
	data, err := fs.ReadFile(bin, "bin/runner-linux-"+arch)
	if err != nil {
		return nil, fmt.Errorf("%w (%s)", ErrNotEmbedded, arch)
	}
	return data, nil
}

// Build builds the runner image for the runtime's architecture and returns
// its image ID. The labels are added to the image.
func Build(ctx context.Context, cli container.CLI, labels map[string]string) (string, error) {
	arch := cli.Arch(ctx)
	if arch == "" {
		arch = runtime.GOARCH
	}
	binary, err := Binary(arch)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, f := range []struct {
		name string
		mode int64
		data []byte
	}{{"Dockerfile", 0o644, []byte(dockerfile)}, {"runner", 0o755, binary}} {
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Mode: f.mode, Size: int64(len(f.data))}); err != nil {
			return "", err
		}
		if _, err := tw.Write(f.data); err != nil {
			return "", err
		}
	}
	if err := tw.Close(); err != nil {
		return "", err
	}
	all := map[string]string{"sprintfoundry.component": "runner"}
	for name, value := range labels {
		all[name] = value
	}
	id, err := cli.Build(ctx, &buf, container.BuildOptions{Dockerfile: "Dockerfile", Network: "none", Labels: all})
	if err != nil {
		return "", fmt.Errorf("runnerimage: build: %w", err)
	}
	return strings.TrimSpace(id), nil
}

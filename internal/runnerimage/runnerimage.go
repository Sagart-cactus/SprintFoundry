// Package runnerimage builds the container images of SprintFoundry's own
// helper programs, the check runner and the sandbox proxy, from binaries
// embedded in this program, so a first run pulls nothing for them. Each image
// is FROM scratch: one static binary and nothing else.
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

// bin holds binaries named <program>-linux-<arch>. They are produced by
// `make runner` and are not committed.
//
//go:embed all:bin
var bin embed.FS

// ErrNotEmbedded is returned when this build carries no runner binary for the
// container runtime's architecture.
var ErrNotEmbedded = errors.New("runnerimage: no binary embedded for this architecture; build with `make`")

// Programs that can be built into an image.
const (
	Runner = "runner"
	Proxy  = "proxy"
)

func dockerfile(program string) string {
	return "FROM scratch\nCOPY " + program + " /" + program + "\nUSER 65532:65532\nENTRYPOINT [\"/" + program + "\"]\n"
}

// Binary returns the embedded runner binary for a Linux architecture.
func Binary(arch string) ([]byte, error) { return ProgramBinary(Runner, arch) }

// ProgramBinary returns an embedded binary for a Linux architecture.
func ProgramBinary(program, arch string) ([]byte, error) {
	data, err := fs.ReadFile(bin, "bin/"+program+"-linux-"+arch)
	if err != nil {
		return nil, fmt.Errorf("%w (%s, %s)", ErrNotEmbedded, program, arch)
	}
	return data, nil
}

// Build builds the runner image for the runtime's architecture and returns
// its image ID. The labels are added to the image.
func Build(ctx context.Context, cli container.CLI, labels map[string]string) (string, error) {
	return BuildProgram(ctx, cli, Runner, labels)
}

// BuildProgram builds the image of one embedded program and returns its
// image ID.
func BuildProgram(ctx context.Context, cli container.CLI, program string, labels map[string]string) (string, error) {
	if program != Runner && program != Proxy {
		return "", fmt.Errorf("runnerimage: unknown program %q", program)
	}
	arch := cli.Arch(ctx)
	if arch == "" {
		arch = runtime.GOARCH
	}
	binary, err := ProgramBinary(program, arch)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, f := range []struct {
		name string
		mode int64
		data []byte
	}{{"Dockerfile", 0o644, []byte(dockerfile(program))}, {program, 0o755, binary}} {
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
	all := map[string]string{"sprintfoundry.component": program}
	for name, value := range labels {
		all[name] = value
	}
	id, err := cli.Build(ctx, &buf, container.BuildOptions{Dockerfile: "Dockerfile", Network: "none", Labels: all})
	if err != nil {
		return "", fmt.Errorf("runnerimage: build: %w", err)
	}
	return strings.TrimSpace(id), nil
}

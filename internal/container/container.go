// Package container drives a local container runtime through the docker
// command line. Docker and Podman (behind its docker-compatible command) both
// work. Only the controller calls this package; nothing a builder wrote is
// ever passed to it as a flag.
package container

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// CLI is a container runtime reached through a docker-compatible binary.
type CLI struct {
	// Bin is the binary to run. Empty means "docker".
	Bin string
}

// ErrUnavailable is returned when no container runtime answers.
var ErrUnavailable = errors.New("container: no container runtime available")

var (
	nameOK  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
	imageID = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// bin returns the binary to run. With Bin empty it prefers docker and falls
// back to podman, because on many machines "docker" is only a shell alias for
// podman, which a program cannot call.
func (c CLI) bin() string {
	if c.Bin != "" {
		return c.Bin
	}
	for _, candidate := range []string{"docker", "podman"} {
		if _, err := exec.LookPath(candidate); err == nil {
			return candidate
		}
	}
	return "docker"
}

// Result is the outcome of a command run inside a container.
type Result struct {
	ExitCode int
	Stdout   []byte
	Stderr   []byte
}

func (c CLI) run(ctx context.Context, stdin io.Reader, args ...string) (Result, error) {
	cmd := exec.CommandContext(ctx, c.bin(), args...)
	cmd.Stdin = stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	res := Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		res.ExitCode = exit.ExitCode()
		return res, nil
	}
	if err != nil {
		return res, fmt.Errorf("container: run %s %s: %w", c.bin(), args[0], err)
	}
	return res, nil
}

// must runs a runtime command that is expected to succeed.
func (c CLI) must(ctx context.Context, stdin io.Reader, args ...string) (string, error) {
	res, err := c.run(ctx, stdin, args...)
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("container: %s %s: exit %d: %s", c.bin(), args[0], res.ExitCode, lastLines(res.Stderr, 6))
	}
	return strings.TrimSpace(string(res.Stdout)), nil
}

func lastLines(b []byte, n int) string {
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

// Available reports whether the runtime answers.
func (c CLI) Available(ctx context.Context) error {
	if _, err := exec.LookPath(c.bin()); err != nil {
		return fmt.Errorf("%w: %s is not installed", ErrUnavailable, c.bin())
	}
	if _, err := c.must(ctx, nil, "version", "--format", "{{.Server.Version}}"); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return nil
}

// Arch returns the CPU architecture containers run on, in Go's naming
// ("amd64", "arm64"), or "" if the runtime does not say.
func (c CLI) Arch(ctx context.Context) string {
	for _, format := range []string{"{{.Server.Arch}}", "{{.Server.OsArch}}"} {
		res, err := c.run(ctx, nil, "version", "--format", format)
		if err != nil || res.ExitCode != 0 {
			continue
		}
		out := strings.TrimSpace(string(res.Stdout))
		out = out[strings.LastIndex(out, "/")+1:]
		switch out {
		case "amd64", "x86_64":
			return "amd64"
		case "arm64", "aarch64":
			return "arm64"
		}
	}
	return ""
}

// BuildOptions says how an image is built. Every field comes from the run
// spec, never from the repository being built.
type BuildOptions struct {
	// Dockerfile is the path of the Dockerfile inside the build context.
	Dockerfile string
	// Network is "none" for a build with no network.
	Network string
	// Labels are attached to the image.
	Labels map[string]string
}

// Build builds an image from a tar stream and returns its image ID: the
// SHA-256 of the image configuration, in hex without a prefix.
func (c CLI) Build(ctx context.Context, buildContext io.Reader, opts BuildOptions) (string, error) {
	if opts.Dockerfile == "" || strings.HasPrefix(opts.Dockerfile, "-") || strings.Contains(opts.Dockerfile, "..") {
		return "", fmt.Errorf("container: dockerfile path %q is not allowed", opts.Dockerfile)
	}
	if opts.Network != "none" {
		return "", fmt.Errorf("container: build network %q is not supported yet", opts.Network)
	}
	args := []string{"build", "--quiet", "--network=none", "--file", opts.Dockerfile}
	args = append(args, labelArgs(opts.Labels)...)
	args = append(args, "-")
	out, err := c.must(ctx, buildContext, args...)
	if err != nil {
		return "", err
	}
	lines := strings.Split(out, "\n")
	id := strings.TrimPrefix(strings.TrimSpace(lines[len(lines)-1]), "sha256:")
	if !imageID.MatchString(id) {
		return "", fmt.Errorf("container: build did not print an image ID, got %q", id)
	}
	return id, nil
}

// RunOptions says how a container is started.
type RunOptions struct {
	Name    string
	Image   string // image ID or name@sha256:digest
	Network string // name of an existing network, or "none"
	Env     map[string]string
	Labels  map[string]string
	// Args replace the image's command when set.
	Args []string
	// Writable leaves the root file system writable. The default is
	// read-only with a small writable /tmp.
	Writable bool
	MemoryMB int
	CPUs     float64
	PIDs     int
}

// runArgs builds the arguments shared by detached and one-shot runs.
func runArgs(mode []string, opts RunOptions) ([]string, error) {
	if !nameOK.MatchString(opts.Name) {
		return nil, fmt.Errorf("container: name %q is not allowed", opts.Name)
	}
	if opts.Network != "none" && !nameOK.MatchString(opts.Network) {
		return nil, fmt.Errorf("container: network %q is not allowed", opts.Network)
	}
	if opts.Image == "" || strings.HasPrefix(opts.Image, "-") {
		return nil, fmt.Errorf("container: image %q is not allowed", opts.Image)
	}
	args := append([]string{"run"}, mode...)
	args = append(args, "--name", opts.Name, "--network", opts.Network,
		"--cap-drop=ALL", "--security-opt", "no-new-privileges")
	if !opts.Writable {
		args = append(args, "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m")
	}
	if opts.MemoryMB > 0 {
		args = append(args, "--memory", strconv.Itoa(opts.MemoryMB)+"m")
	}
	if opts.CPUs > 0 {
		args = append(args, "--cpus", strconv.FormatFloat(opts.CPUs, 'f', 2, 64))
	}
	if opts.PIDs > 0 {
		args = append(args, "--pids-limit", strconv.Itoa(opts.PIDs))
	}
	names := make([]string, 0, len(opts.Env))
	for name := range opts.Env {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		args = append(args, "--env", name+"="+opts.Env[name])
	}
	args = append(args, labelArgs(opts.Labels)...)
	args = append(args, opts.Image)
	return append(args, opts.Args...), nil
}

// Run starts a detached container with no added capabilities and returns its
// ID.
func (c CLI) Run(ctx context.Context, opts RunOptions) (string, error) {
	args, err := runArgs([]string{"--detach"}, opts)
	if err != nil {
		return "", err
	}
	return c.must(ctx, nil, args...)
}

// RunOnce runs a container to completion with stdin attached, removes it, and
// returns what it wrote. It is how the controller runs the check runner.
func (c CLI) RunOnce(ctx context.Context, opts RunOptions, stdin io.Reader) (Result, error) {
	args, err := runArgs([]string{"--rm", "--interactive"}, opts)
	if err != nil {
		return Result{}, err
	}
	return c.run(ctx, stdin, args...)
}

// Exec runs a command inside a running container.
func (c CLI) Exec(ctx context.Context, name string, stdin io.Reader, args ...string) (Result, error) {
	if !nameOK.MatchString(name) {
		return Result{}, fmt.Errorf("container: name %q is not allowed", name)
	}
	full := []string{"exec"}
	if stdin != nil {
		full = append(full, "--interactive")
	}
	full = append(full, name)
	return c.run(ctx, stdin, append(full, args...)...)
}

// ImageOf returns the image ID a container was started from, as the runtime
// reports it. This is the controller's own observation of what is served.
func (c CLI) ImageOf(ctx context.Context, name string) (string, error) {
	if !nameOK.MatchString(name) {
		return "", fmt.Errorf("container: name %q is not allowed", name)
	}
	out, err := c.must(ctx, nil, "inspect", "--type", "container", "--format", "{{.Image}}", name)
	if err != nil {
		return "", err
	}
	id := strings.TrimPrefix(out, "sha256:")
	if !imageID.MatchString(id) {
		return "", fmt.Errorf("container: runtime reported image %q for %s", out, name)
	}
	return id, nil
}

// Running reports whether a container exists and is running.
func (c CLI) Running(ctx context.Context, name string) (bool, error) {
	if !nameOK.MatchString(name) {
		return false, fmt.Errorf("container: name %q is not allowed", name)
	}
	res, err := c.run(ctx, nil, "inspect", "--type", "container", "--format", "{{.State.Running}}", name)
	if err != nil {
		return false, err
	}
	return res.ExitCode == 0 && strings.TrimSpace(string(res.Stdout)) == "true", nil
}

// Logs returns the last lines a container wrote.
func (c CLI) Logs(ctx context.Context, name string, tail int) (string, error) {
	if !nameOK.MatchString(name) {
		return "", fmt.Errorf("container: name %q is not allowed", name)
	}
	res, err := c.run(ctx, nil, "logs", "--tail", strconv.Itoa(tail), name)
	if err != nil {
		return "", err
	}
	return string(res.Stdout) + string(res.Stderr), nil
}

// Remove stops and deletes containers. Missing containers are not an error.
func (c CLI) Remove(ctx context.Context, names ...string) error {
	for _, name := range names {
		if !nameOK.MatchString(name) {
			return fmt.Errorf("container: name %q is not allowed", name)
		}
	}
	if len(names) == 0 {
		return nil
	}
	_, err := c.run(ctx, nil, append([]string{"rm", "--force", "--volumes"}, names...)...)
	return err
}

// NetworkCreate creates a network. An internal network has no route to the
// outside and no route to the host.
func (c CLI) NetworkCreate(ctx context.Context, name string, internal bool, labels map[string]string) error {
	if !nameOK.MatchString(name) {
		return fmt.Errorf("container: network %q is not allowed", name)
	}
	args := []string{"network", "create"}
	if internal {
		args = append(args, "--internal")
	}
	args = append(args, labelArgs(labels)...)
	_, err := c.must(ctx, nil, append(args, name)...)
	return err
}

// NetworkRemove deletes networks. Missing networks are not an error.
func (c CLI) NetworkRemove(ctx context.Context, names ...string) error {
	for _, name := range names {
		if !nameOK.MatchString(name) {
			return fmt.Errorf("container: network %q is not allowed", name)
		}
		if _, err := c.run(ctx, nil, "network", "rm", name); err != nil {
			return err
		}
	}
	return nil
}

// ImageRemove deletes images by ID. Missing images are not an error.
func (c CLI) ImageRemove(ctx context.Context, ids ...string) error {
	for _, id := range ids {
		if !imageID.MatchString(id) {
			return fmt.Errorf("container: image ID %q is not allowed", id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	_, err := c.run(ctx, nil, append([]string{"rmi", "--force"}, ids...)...)
	return err
}

func labelArgs(labels map[string]string) []string {
	names := make([]string, 0, len(labels))
	for name := range labels {
		names = append(names, name)
	}
	sort.Strings(names)
	var args []string
	for _, name := range names {
		args = append(args, "--label", name+"="+labels[name])
	}
	return args
}

// ServiceOptions describes a trusted service container the controller runs
// for itself, such as its database. It is never used for anything a builder
// wrote.
type ServiceOptions struct {
	Name  string
	Image string // name@sha256:digest
	Env   map[string]string
	// EnvFile is a file of NAME=value lines. Secrets go here and not in Env,
	// so they never appear on a command line.
	EnvFile string
	// Publish maps a port on 127.0.0.1 of the host to a port in the
	// container.
	HostPort, ContainerPort int
	// Volume is a named volume mounted at MountPath.
	Volume, MountPath string
	Labels            map[string]string
}

// RunService starts a trusted service container, reachable only from this
// machine.
func (c CLI) RunService(ctx context.Context, opts ServiceOptions) error {
	if !nameOK.MatchString(opts.Name) || !nameOK.MatchString(opts.Volume) {
		return fmt.Errorf("container: service name %q or volume %q is not allowed", opts.Name, opts.Volume)
	}
	if !strings.Contains(opts.Image, "@sha256:") || strings.HasPrefix(opts.Image, "-") {
		return fmt.Errorf("container: service image %q must be pinned by digest", opts.Image)
	}
	if opts.HostPort < 1 || opts.HostPort > 65535 || opts.ContainerPort < 1 || opts.ContainerPort > 65535 || !strings.HasPrefix(opts.MountPath, "/") {
		return errors.New("container: service ports and mount path are required")
	}
	args := []string{"run", "--detach", "--name", opts.Name,
		"--publish", fmt.Sprintf("127.0.0.1:%d:%d", opts.HostPort, opts.ContainerPort),
		"--volume", opts.Volume + ":" + opts.MountPath,
		"--security-opt", "no-new-privileges"}
	if opts.EnvFile != "" {
		if strings.HasPrefix(opts.EnvFile, "-") || !filepath.IsAbs(opts.EnvFile) {
			return fmt.Errorf("container: env file %q must be an absolute path", opts.EnvFile)
		}
		args = append(args, "--env-file", opts.EnvFile)
	}
	names := make([]string, 0, len(opts.Env))
	for name := range opts.Env {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		args = append(args, "--env", name+"="+opts.Env[name])
	}
	args = append(args, labelArgs(opts.Labels)...)
	args = append(args, opts.Image)
	_, err := c.must(ctx, nil, args...)
	return err
}

// Start starts a stopped container.
func (c CLI) Start(ctx context.Context, name string) error {
	if !nameOK.MatchString(name) {
		return fmt.Errorf("container: name %q is not allowed", name)
	}
	_, err := c.must(ctx, nil, "start", name)
	return err
}

// Exists reports whether a container exists, running or not.
func (c CLI) Exists(ctx context.Context, name string) (bool, error) {
	if !nameOK.MatchString(name) {
		return false, fmt.Errorf("container: name %q is not allowed", name)
	}
	res, err := c.run(ctx, nil, "inspect", "--type", "container", "--format", "{{.Name}}", name)
	if err != nil {
		return false, err
	}
	return res.ExitCode == 0, nil
}

// VolumeRemove deletes named volumes. Missing volumes are not an error.
func (c CLI) VolumeRemove(ctx context.Context, names ...string) error {
	for _, name := range names {
		if !nameOK.MatchString(name) {
			return fmt.Errorf("container: volume %q is not allowed", name)
		}
		if _, err := c.run(ctx, nil, "volume", "rm", "--force", name); err != nil {
			return err
		}
	}
	return nil
}

var labelOK = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,62}=[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`)

// PruneImages deletes images that carry the label (name=value) and that no
// container uses. Images are shared between runs when their content is
// identical, so SprintFoundry never deletes an image by ID while runs may be
// in progress; it only prunes on request.
func (c CLI) PruneImages(ctx context.Context, label string) error {
	if !labelOK.MatchString(label) {
		return fmt.Errorf("container: label %q is not allowed", label)
	}
	_, err := c.must(ctx, nil, "image", "prune", "--all", "--force", "--filter", "label="+label)
	return err
}

// RemoveByLabel stops and deletes every container that carries the label
// (name=value), then every network that carries it. It is how leftovers of an
// interrupted run are cleaned up.
func (c CLI) RemoveByLabel(ctx context.Context, label string) error {
	if !labelOK.MatchString(label) {
		return fmt.Errorf("container: label %q is not allowed", label)
	}
	ids, err := c.must(ctx, nil, "ps", "--all", "--quiet", "--filter", "label="+label)
	if err != nil {
		return err
	}
	if fields := strings.Fields(ids); len(fields) > 0 {
		if _, err := c.run(ctx, nil, append([]string{"rm", "--force", "--volumes"}, fields...)...); err != nil {
			return err
		}
	}
	nets, err := c.must(ctx, nil, "network", "ls", "--quiet", "--filter", "label="+label)
	if err != nil {
		return err
	}
	for _, id := range strings.Fields(nets) {
		if _, err := c.run(ctx, nil, "network", "rm", id); err != nil {
			return err
		}
	}
	return nil
}

// Pull fetches an image the controller itself chose, pinned by digest. It is
// never called with a reference a builder wrote.
func (c CLI) Pull(ctx context.Context, image string) error {
	if !pinnedRef.MatchString(image) {
		return fmt.Errorf("container: image %q must be pinned as name@sha256:<64 hex>", image)
	}
	_, err := c.must(ctx, nil, "pull", "--quiet", image)
	return err
}

var pinnedRef = regexp.MustCompile(`^[a-zA-Z0-9][^@\s]*@sha256:[0-9a-f]{64}$`)

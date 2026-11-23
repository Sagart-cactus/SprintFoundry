// Package containerbox is the local sandbox backend: each sandbox is a
// container on an internal network whose only other member is the
// controller's proxy. The container's root file system is read-only; the
// builder works in in-memory directories that vanish with it. Nothing from
// the host is mounted.
//
// This keeps honest mistakes and casual misbehaviour contained. It is not a
// boundary against a determined attacker: the container shares the host's
// kernel. Agent Substrate (gVisor or microVMs) is the production backend.
package containerbox

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
)

// Backend creates sandboxes as containers.
type Backend struct {
	CLI container.CLI
	// Network is the internal network a proxy-only sandbox joins. Its only
	// other member must be the proxy. See StartNetwork.
	Network string
	Labels  map[string]string
}

var _ sandbox.Sandbox = (*Backend)(nil)

// ErrMountsUnsupported is returned for a spec that mounts host directories.
// This backend copies files in and out instead, so nothing on the host is
// ever exposed to the sandbox.
var ErrMountsUnsupported = errors.New("containerbox: host mounts are not supported; copy files in instead")

func randomSuffix() (string, error) {
	b := make([]byte, 5)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Create starts a sandbox container that idles until commands are run in it.
func (b *Backend) Create(ctx context.Context, v sandbox.Validated) (string, error) {
	spec := v.Spec()
	if len(spec.Mounts) > 0 {
		return "", ErrMountsUnsupported
	}
	network := "none"
	if spec.Network == sandbox.NetworkProxyOnly {
		if b.Network == "" {
			return "", errors.New("containerbox: a proxy-only sandbox needs the backend's network")
		}
		network = b.Network
	}
	suffix, err := randomSuffix()
	if err != nil {
		return "", err
	}
	name := "sf-sbx-" + suffix
	workdir := spec.Workdir
	if workdir == "" {
		workdir = "/workspace"
	}
	opts := container.RunOptions{
		Name: name, Image: spec.Image, Network: network, Env: spec.EffectiveEnv(), Labels: b.Labels,
		Tmpfs: []string{
			workdir + ":rw,exec,nosuid,size=2g,mode=1777",
			"/home/agent:rw,exec,nosuid,size=512m,mode=1777",
			"/sf:rw,noexec,nosuid,size=256m,mode=1777",
		},
		Entrypoint: "sleep", Args: []string{"infinity"}, Workdir: workdir,
		MemoryMB: spec.Limits.MemoryMB, CPUs: spec.Limits.CPUs, PIDs: spec.Limits.PIDs,
	}
	if opts.MemoryMB == 0 {
		opts.MemoryMB = 4096
	}
	if opts.PIDs == 0 {
		opts.PIDs = 1024
	}
	if _, err := b.CLI.Run(ctx, opts); err != nil {
		_ = b.CLI.Remove(context.WithoutCancel(ctx), name)
		return "", fmt.Errorf("containerbox: start sandbox: %w", err)
	}
	return name, nil
}

// Exec runs a command to completion inside the sandbox.
func (b *Backend) Exec(ctx context.Context, id string, cmd sandbox.Command) (sandbox.Result, error) {
	if !strings.HasPrefix(id, "sf-sbx-") {
		return sandbox.Result{}, fmt.Errorf("containerbox: %q is not a sandbox of this backend", id)
	}
	res, err := b.CLI.Exec(ctx, id, cmd.Stdin, cmd.Args...)
	if err != nil {
		return sandbox.Result{}, err
	}
	return sandbox.Result{ExitCode: res.ExitCode, Stdout: res.Stdout, Stderr: res.Stderr}, nil
}

// CopyIn unpacks a tar stream at dst inside the sandbox. It runs tar inside
// the container, so it works on read-only images with in-memory directories.
func (b *Backend) CopyIn(ctx context.Context, id, dst string, tar io.Reader) error {
	if !filepath.IsAbs(dst) {
		return fmt.Errorf("containerbox: destination %q must be absolute", dst)
	}
	res, err := b.Exec(ctx, id, sandbox.Command{Args: []string{"tar", "-x", "-f", "-", "-C", dst}, Stdin: tar})
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("containerbox: unpack into %s: exit %d: %s", dst, res.ExitCode, bytes.TrimSpace(res.Stderr))
	}
	return nil
}

// CopyOut returns a tar stream of src from inside the sandbox.
func (b *Backend) CopyOut(ctx context.Context, id, src string) (io.ReadCloser, error) {
	if !filepath.IsAbs(src) {
		return nil, fmt.Errorf("containerbox: source %q must be absolute", src)
	}
	res, err := b.Exec(ctx, id, sandbox.Command{Args: []string{"tar", "-c", "-f", "-", "-C", src, "."}})
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("containerbox: pack %s: exit %d: %s", src, res.ExitCode, bytes.TrimSpace(res.Stderr))
	}
	return io.NopCloser(bytes.NewReader(res.Stdout)), nil
}

// Destroy removes the sandbox and everything in it.
func (b *Backend) Destroy(ctx context.Context, id string) error {
	if !strings.HasPrefix(id, "sf-sbx-") {
		return fmt.Errorf("containerbox: %q is not a sandbox of this backend", id)
	}
	return b.CLI.Remove(context.WithoutCancel(ctx), id)
}

// Network is a sandbox network with its proxy.
type Network struct {
	cli      container.CLI
	Internal string // the network sandboxes join
	// Upstream is the ordinary network the proxy uses to reach the model
	// API. Sandboxes are never attached to it.
	Upstream string
	proxy    string
	// ProxyHost is the proxy's name on the internal network.
	ProxyHost string
}

// ProxyConfig is what the proxy container needs. Key is written to a private
// file for the runtime and never put on a command line.
type ProxyConfig struct {
	Image       string // the proxy image ID
	Preset      string // openai-responses or anthropic-messages
	Upstream    string // https://api.openai.com
	Key         string
	MaxRequests int64
	// TempDir is where the env file is written for a moment. It must be a
	// directory only this user can read.
	TempDir string
}

// StartNetwork creates an internal network for sandboxes and an ordinary one
// for the proxy's way out, starts the proxy on the ordinary network, attaches
// it to the internal one, and waits until it listens. The order matters on
// Podman: a container that joins an internal network first gets no route
// out.
func StartNetwork(ctx context.Context, cli container.CLI, runID string, cfg ProxyConfig, labels map[string]string) (*Network, error) {
	suffix, err := randomSuffix()
	if err != nil {
		return nil, err
	}
	base := "sf-" + runID + "-" + suffix
	n := &Network{cli: cli, Internal: base + "-sbx", Upstream: base + "-up", proxy: base + "-proxy"}
	n.ProxyHost = n.proxy
	ok := false
	defer func() {
		if !ok {
			n.Close(context.WithoutCancel(ctx))
		}
	}()

	if err := cli.NetworkCreate(ctx, n.Internal, true, labels); err != nil {
		return nil, err
	}
	if err := cli.NetworkCreate(ctx, n.Upstream, false, labels); err != nil {
		return nil, err
	}
	if strings.ContainsAny(cfg.Key+cfg.Upstream+cfg.Preset, "\n\r") {
		return nil, errors.New("containerbox: proxy settings must not contain line breaks")
	}
	envFile, err := os.CreateTemp(cfg.TempDir, ".proxy-env-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(envFile.Name())
	_, werr := fmt.Fprintf(envFile, "SF_PROXY_PRESET=%s\nSF_PROXY_UPSTREAM=%s\nSF_PROXY_KEY=%s\nSF_PROXY_MAX_REQUESTS=%d\n",
		cfg.Preset, cfg.Upstream, cfg.Key, cfg.MaxRequests)
	if cerr := envFile.Close(); werr != nil || cerr != nil {
		return nil, errors.Join(werr, cerr)
	}
	if _, err := cli.Run(ctx, container.RunOptions{
		Name: n.proxy, Image: cfg.Image, Network: n.Upstream, EnvFile: envFile.Name(), Labels: labels,
		MemoryMB: 256, CPUs: 1, PIDs: 128,
	}); err != nil {
		return nil, fmt.Errorf("containerbox: start proxy: %w", err)
	}
	if err := cli.NetworkConnect(ctx, n.Internal, n.proxy); err != nil {
		return nil, fmt.Errorf("containerbox: attach proxy: %w", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		logs, _ := cli.Logs(ctx, n.proxy, 20)
		if strings.Contains(logs, "listening on") {
			break
		}
		if running, _ := cli.Running(ctx, n.proxy); !running || time.Now().After(deadline) {
			return nil, fmt.Errorf("containerbox: the proxy did not start: %s", strings.TrimSpace(logs))
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	ok = true
	return n, nil
}

// ProxyLog returns the proxy's last log lines: one line per call, with the
// method, the path and whether it was forwarded. Bodies are never logged.
func (n *Network) ProxyLog(ctx context.Context, lines int) string {
	logs, _ := n.cli.Logs(ctx, n.proxy, lines)
	return logs
}

// Close removes the proxy and both networks.
func (n *Network) Close(ctx context.Context) {
	_ = n.cli.Remove(ctx, n.proxy)
	_ = n.cli.NetworkRemove(ctx, n.Internal, n.Upstream)
}

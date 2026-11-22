package container

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOptionsThatCouldBecomeFlagsAreRefused(t *testing.T) {
	ctx, c := context.Background(), CLI{Bin: "definitely-not-a-runtime"}

	if _, err := c.Build(ctx, strings.NewReader(""), BuildOptions{Dockerfile: "--output=/etc", Network: "none"}); err == nil {
		t.Error("a Dockerfile path that looks like a flag was accepted")
	}
	if _, err := c.Build(ctx, strings.NewReader(""), BuildOptions{Dockerfile: "../../Dockerfile", Network: "none"}); err == nil {
		t.Error("a Dockerfile path outside the context was accepted")
	}
	if _, err := c.Build(ctx, strings.NewReader(""), BuildOptions{Dockerfile: "Dockerfile", Network: "host"}); err == nil {
		t.Error("a build with host networking was accepted")
	}
	for _, name := range []string{"", "--privileged", "a b", "x;rm -rf", "../x"} {
		if _, err := c.Run(ctx, RunOptions{Name: name, Image: strings.Repeat("a", 64), Network: "none"}); err == nil {
			t.Errorf("container name %q was accepted", name)
		}
		if err := c.NetworkCreate(ctx, name, true, nil); err == nil {
			t.Errorf("network name %q was accepted", name)
		}
	}
	if _, err := c.Run(ctx, RunOptions{Name: "ok", Image: "--volume=/:/host", Network: "none"}); err == nil {
		t.Error("an image that looks like a flag was accepted")
	}
	if _, err := c.Run(ctx, RunOptions{Name: "ok", Image: strings.Repeat("a", 64), Network: "host;x"}); err == nil {
		t.Error("a network that is not a plain name was accepted")
	}
	if err := c.ImageRemove(ctx, "--all"); err == nil {
		t.Error("an image ID that looks like a flag was accepted")
	}
}

func TestAvailableReportsMissingRuntime(t *testing.T) {
	if err := (CLI{Bin: "definitely-not-a-runtime"}).Available(context.Background()); err == nil {
		t.Fatal("a missing runtime was reported as available")
	}
}

// tarDir packs a directory into a tar stream, as `git archive` would.
func tarDir(t *testing.T, dir string) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		if err := tw.WriteHeader(&tar.Header{Name: filepath.ToSlash(rel), Mode: 0o644, Size: int64(len(data))}); err != nil {
			return err
		}
		_, err = tw.Write(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf
}

func runtimeOrSkip(t *testing.T) CLI {
	t.Helper()
	c := CLI{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := c.Available(ctx); err != nil {
		t.Skipf("no container runtime: %v", err)
	}
	return c
}

func waitRunning(t *testing.T, c CLI, name string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if ok, _ := c.Running(context.Background(), name); ok {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	logs, _ := c.Logs(context.Background(), name, 20)
	t.Fatalf("container %s did not start: %s", name, logs)
}

func TestBuildRunAndObserveServedImage(t *testing.T) {
	c := runtimeOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
	network, preview, other := "sf-test-net-"+suffix, "sf-test-preview-"+suffix, "sf-test-other-"+suffix
	labels := map[string]string{"sprintfoundry.test": suffix}
	var images []string
	t.Cleanup(func() {
		bg := context.Background()
		_ = c.Remove(bg, preview, other)
		_ = c.NetworkRemove(bg, network)
		_ = c.ImageRemove(bg, images...)
	})

	appDir := filepath.Join("..", "demo", "app")
	first, err := c.Build(ctx, tarDir(t, appDir), BuildOptions{Dockerfile: "Dockerfile", Network: "none", Labels: labels})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	images = append(images, first)

	// A different source gives a different image ID.
	changed := tarDir(t, filepath.Join("..", "demo", "variants", "fixed"))
	second, err := c.Build(ctx, withDockerfile(t, changed, appDir), BuildOptions{Dockerfile: "Dockerfile", Network: "none", Labels: labels})
	if err != nil {
		t.Fatalf("Build of the changed source: %v", err)
	}
	images = append(images, second)
	if first == second {
		t.Fatal("two different sources produced the same image ID")
	}

	if err := c.NetworkCreate(ctx, network, true, labels); err != nil {
		t.Fatalf("NetworkCreate: %v", err)
	}
	if _, err := c.Run(ctx, RunOptions{Name: preview, Image: first, Network: network, Labels: labels, MemoryMB: 256, PIDs: 128}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	waitRunning(t, c, preview)

	served, err := c.ImageOf(ctx, preview)
	if err != nil {
		t.Fatal(err)
	}
	if served != first {
		t.Errorf("served image = %s, want the candidate %s", served, first)
	}

	if _, err := c.Run(ctx, RunOptions{Name: other, Image: second, Network: network, Labels: labels}); err != nil {
		t.Fatal(err)
	}
	if got, _ := c.ImageOf(ctx, other); got != second || got == first {
		t.Errorf("the other container reports image %s, want %s", got, second)
	}

	// The preview answers on its internal network.
	probe := "import urllib.request,sys; sys.stdout.write(urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=5).read().decode())"
	var res Result
	for i := 0; i < 25; i++ {
		if res, err = c.Exec(ctx, preview, nil, "python", "-c", probe); err == nil && res.ExitCode == 0 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err != nil || strings.TrimSpace(string(res.Stdout)) != "ok" {
		t.Fatalf("health probe = %q, exit %d, %v: %s", res.Stdout, res.ExitCode, err, res.Stderr)
	}

	// The root file system is read-only and the process is not root.
	res, _ = c.Exec(ctx, preview, nil, "sh", "-c", "id -u; touch /srv/x 2>&1; echo touched=$?")
	if out := string(res.Stdout); !strings.HasPrefix(out, "65532\n") || !strings.Contains(out, "touched=1") {
		t.Errorf("preview is not locked down: %q", out)
	}

	// An internal network has no way out.
	res, _ = c.Exec(ctx, preview, nil, "python", "-c",
		"import urllib.request\ntry:\n    urllib.request.urlopen('http://1.1.1.1', timeout=3)\n    print('reached')\nexcept Exception as e:\n    print('blocked')")
	if strings.TrimSpace(string(res.Stdout)) != "blocked" {
		t.Errorf("the preview could reach the internet: %q %q", res.Stdout, res.Stderr)
	}
}

// withDockerfile returns a tar stream holding the files in overlay plus the
// Dockerfile from base, for variants that do not carry their own.
func withDockerfile(t *testing.T, overlay *bytes.Buffer, base string) *bytes.Buffer {
	t.Helper()
	var out bytes.Buffer
	tw := tar.NewWriter(&out)
	tr := tar.NewReader(overlay)
	seen := false
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		data := make([]byte, h.Size)
		if _, err := tr.Read(data); err != nil && h.Size > 0 && err.Error() != "EOF" {
			t.Fatal(err)
		}
		if h.Name == "Dockerfile" {
			seen = true
		}
		_ = tw.WriteHeader(h)
		_, _ = tw.Write(data)
	}
	if !seen {
		data, err := os.ReadFile(filepath.Join(base, "Dockerfile"))
		if err != nil {
			t.Fatal(err)
		}
		_ = tw.WriteHeader(&tar.Header{Name: "Dockerfile", Mode: 0o644, Size: int64(len(data))})
		_, _ = tw.Write(data)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return &out
}

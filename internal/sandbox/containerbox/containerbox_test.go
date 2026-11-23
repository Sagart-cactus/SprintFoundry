package containerbox

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/runnerimage"
	"github.com/sagart-cactus/sprintfoundry/internal/sandbox"
)

const (
	// A small image with git and busybox tools, standing in for an agent image.
	gitImage    = "docker.io/alpine/git@sha256:29cff25811f790b9f72fc266bf8009a5a911714c0e03c31c47339c50909d9aef"
	pythonImage = "docker.io/library/python:3.13-alpine@sha256:9ef1a599f863231c3d91e941389bfdc4a2d6070557243d54df1a4e57015b960e"
	fakeKey     = "sk-fake-for-tests-only"
)

// fakeUpstream answers like a model API and says whether it saw the injected
// key, without ever echoing the key back.
const fakeUpstream = `
import http.server, json, os
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0")); self.rfile.read(n)
        ok = self.headers.get("Authorization") == "Bearer " + os.environ["WANT_KEY"]
        body = json.dumps({"auth_ok": ok, "client_key_seen": "sandbox-sent" in str(self.headers)}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("0.0.0.0", 9000), H).serve_forever()
`

func runtimeOrSkip(t *testing.T) container.CLI {
	t.Helper()
	cli := container.CLI{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := cli.Available(ctx); err != nil {
		if os.Getenv("CI") != "" && os.Getenv("SPRINTFOUNDRY_NO_CONTAINERS") == "" {
			t.Fatalf("no container runtime in CI, and this test must not be skipped silently: %v", err)
		}
		t.Skipf("no container runtime: %v", err)
	}
	if _, err := runnerimage.ProgramBinary(runnerimage.Proxy, cli.Arch(ctx)); errors.Is(err, runnerimage.ErrNotEmbedded) {
		t.Skip(err.Error())
	}
	return cli
}

func TestSandboxReachesOnlyTheProxyAndHoldsNoKey(t *testing.T) {
	cli := runtimeOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	for _, image := range []string{gitImage, pythonImage} {
		if err := cli.Pull(ctx, image); err != nil {
			t.Fatalf("pull %s: %v", image, err)
		}
	}
	proxyImage, err := runnerimage.BuildProgram(ctx, cli, runnerimage.Proxy, nil)
	if err != nil {
		t.Fatal(err)
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
	upstreamName := "sf-test-upstream-" + suffix
	labels := map[string]string{"sprintfoundry.test": suffix}
	net, err := StartNetwork(ctx, cli, "t"+suffix, ProxyConfig{
		Image: proxyImage, Preset: "openai-responses", Upstream: "http://" + upstreamName + ":9000",
		Key: fakeKey, MaxRequests: 3, TempDir: t.TempDir(),
	}, labels)
	if err != nil {
		t.Fatalf("StartNetwork: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_ = cli.Remove(bg, upstreamName)
		net.Close(bg)
	})
	if _, err := cli.Run(ctx, container.RunOptions{
		Name: upstreamName, Image: pythonImage, Network: net.Upstream, Labels: labels,
		Env: map[string]string{"WANT_KEY": fakeKey}, Entrypoint: "python", Args: []string{"-c", fakeUpstream},
	}); err != nil {
		t.Fatalf("start fake upstream: %v", err)
	}

	backend := &Backend{CLI: cli, Network: net.Internal, Labels: labels}
	guard := sandbox.Guard{WorkspaceRoot: t.TempDir(), AllowedEnv: []string{"HOME"},
		AllowedPlaceholders: []string{"OPENAI_API_KEY"}, Secrets: []string{fakeKey}}
	validated, err := sandbox.Spec{Image: gitImage, Workdir: "/workspace", Network: sandbox.NetworkProxyOnly,
		Env: map[string]string{"HOME": "/home/agent"}, Placeholders: []string{"OPENAI_API_KEY"}}.Validate(guard)
	if err != nil {
		t.Fatal(err)
	}
	id, err := backend.Create(ctx, validated)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = backend.Destroy(context.Background(), id) })

	sh := func(script string) sandbox.Result {
		t.Helper()
		res, err := backend.Exec(ctx, id, sandbox.Command{Args: []string{"sh", "-c", script}})
		if err != nil {
			t.Fatalf("exec %q: %v", script, err)
		}
		return res
	}

	// The proxy forwards with the injected key and drops the one the sandbox sent.
	call := "wget -q -O - --header 'Content-Type: application/json' --header 'Authorization: Bearer sandbox-sent' " +
		"--post-data '{\"model\":\"m\",\"input\":[]}' http://" + net.ProxyHost + ":8080/v1/responses"
	var res sandbox.Result
	for i := 0; i < 20; i++ { // the fake upstream may still be starting
		if res = sh(call); res.ExitCode == 0 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if out := string(res.Stdout); res.ExitCode != 0 || !strings.Contains(out, `"auth_ok": true`) || !strings.Contains(out, `"client_key_seen": false`) {
		t.Fatalf("call through the proxy: exit %d, %q, %q", res.ExitCode, res.Stdout, res.Stderr)
	}

	// A provider-side tool is refused at the proxy.
	refused := sh("wget -q -O - --header 'Content-Type: application/json' --post-data '{\"model\":\"m\",\"input\":[],\"tools\":[{\"type\":\"web_search\"}]}' http://" + net.ProxyHost + ":8080/v1/responses")
	if refused.ExitCode == 0 {
		t.Errorf("a request with a provider-side tool got through: %q", refused.Stdout)
	}

	// Nothing else is reachable: not the internet, not the upstream directly,
	// by name or by address. The address check matters: a name that does
	// not resolve proves nothing about routing.
	upstreamIP, err := cli.IPAddress(ctx, upstreamName, net.Upstream)
	if err != nil {
		t.Fatalf("upstream address: %v", err)
	}
	for _, target := range []string{"http://1.1.1.1/", "http://example.com/", "http://" + upstreamName + ":9000/", "http://" + upstreamIP + ":9000/"} {
		if r := sh("wget -q -T 3 -O - " + target); r.ExitCode == 0 {
			t.Errorf("the sandbox reached %s", target)
		}
	}
	// Control: the upstream does answer on that address, from its own network.
	if r, _ := cli.Exec(ctx, upstreamName, nil, "python", "-c",
		"import urllib.request;urllib.request.urlopen(urllib.request.Request('http://"+upstreamIP+":9000/',data=b'{}'),timeout=3)"); r.ExitCode != 0 {
		t.Fatalf("control failed: the upstream does not answer at %s: %s", upstreamIP, r.Stderr)
	}

	// No key inside; the placeholder is the public constant.
	env := string(sh("env").Stdout)
	if strings.Contains(env, fakeKey) {
		t.Error("the key is visible inside the sandbox")
	}
	if !strings.Contains(env, "OPENAI_API_KEY="+sandbox.PlaceholderValue) {
		t.Errorf("placeholder missing from the environment: %s", env)
	}

	// The root file system is read-only; the work areas are writable.
	if r := sh("touch /etc/sf-test"); r.ExitCode == 0 {
		t.Error("the root file system is writable")
	}
	if r := sh("echo hi > /workspace/a && echo hi > /home/agent/b && cat /workspace/a"); r.ExitCode != 0 {
		t.Errorf("work areas are not writable: %q", r.Stderr)
	}

	// Files go in and out as tar streams.
	var in bytes.Buffer
	tw := tar.NewWriter(&in)
	_ = tw.WriteHeader(&tar.Header{Name: "hello.txt", Mode: 0o644, Size: 5})
	_, _ = tw.Write([]byte("hello"))
	_ = tw.Close()
	if err := backend.CopyIn(ctx, id, "/workspace", &in); err != nil {
		t.Fatalf("CopyIn: %v", err)
	}
	out, err := backend.CopyOut(ctx, id, "/workspace")
	if err != nil {
		t.Fatalf("CopyOut: %v", err)
	}
	found := false
	tr := tar.NewReader(out)
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		if strings.TrimPrefix(h.Name, "./") == "hello.txt" {
			data, _ := io.ReadAll(tr)
			found = string(data) == "hello"
		}
	}
	if !found {
		t.Error("the file copied in did not come back out")
	}

	// The proxy logged method and path only.
	if logs := net.ProxyLog(ctx, 20); !strings.Contains(logs, `"POST" "/v1/responses" forwarded`) || strings.Contains(logs, fakeKey) {
		t.Errorf("proxy log: %s", logs)
	}
	// A path cannot forge a log line, and the counter counts real forwards.
	sh("wget -q -O - --post-data '{}' 'http://" + net.ProxyHost + ":8080/x%0A\"POST\" \"/v1/responses\" forwarded forwarded_total=99'")
	if logs := net.ProxyLog(ctx, 20); strings.Contains(logs, "\n\"POST\" \"/v1/responses\" forwarded forwarded_total=99") {
		t.Errorf("a request path forged a log line:\n%s", logs)
	}
	if got := net.Forwarded(ctx); got != 1 {
		t.Errorf("forwarded = %d, want 1", got)
	}

	// The request budget holds inside the real setup too: 3 allowed, one used.
	for i := 0; i < 2; i++ {
		sh(call)
	}
	if r := sh(call); r.ExitCode == 0 {
		t.Error("a request over the budget got through")
	}
}

func TestBackendRefusesHostMounts(t *testing.T) {
	root := t.TempDir()
	validated, err := sandbox.Spec{Image: gitImage, Network: sandbox.NetworkNone,
		Mounts: []sandbox.Mount{{Source: root, Target: "/data"}}}.Validate(sandbox.Guard{WorkspaceRoot: root, NoSecrets: true})
	if err != nil {
		t.Fatal(err)
	}
	b := &Backend{CLI: container.CLI{Bin: "definitely-not-a-runtime"}}
	if _, err := b.Create(context.Background(), validated); !errors.Is(err, ErrMountsUnsupported) {
		t.Fatalf("err = %v, want ErrMountsUnsupported", err)
	}
}

func TestOutputIsBounded(t *testing.T) {
	cli := runtimeOrSkip(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := cli.Pull(ctx, gitImage); err != nil {
		t.Fatal(err)
	}
	b := &Backend{CLI: cli}
	v, err := sandbox.Spec{Image: gitImage, Network: sandbox.NetworkNone}.Validate(sandbox.Guard{WorkspaceRoot: t.TempDir(), NoSecrets: true})
	if err != nil {
		t.Fatal(err)
	}
	id, err := b.Create(ctx, v)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Destroy(context.Background(), id)

	res, err := b.Exec(ctx, id, sandbox.Command{Args: []string{"sh", "-c", "head -c 50000000 /dev/zero"}, MaxOutput: 1000})
	if err != nil || len(res.Stdout) != 1000 || !res.Truncated || res.ExitCode != 0 {
		t.Fatalf("head: %d bytes kept, truncated %v, exit %d, %v", len(res.Stdout), res.Truncated, res.ExitCode, err)
	}
	res, _ = b.Exec(ctx, id, sandbox.Command{Args: []string{"sh", "-c", "head -c 50000 /dev/zero; echo END"}, MaxOutput: 100, KeepTail: true})
	if !strings.HasSuffix(string(res.Stdout), "END\n") || len(res.Stdout) != 100 {
		t.Errorf("tail kept %d bytes ending %q", len(res.Stdout), res.Stdout[len(res.Stdout)-10:])
	}
}

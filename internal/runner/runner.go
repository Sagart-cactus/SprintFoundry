// Package runner executes a frozen check suite against a preview and reports
// what it saw. It contains no model and makes no judgement: every result is
// an observation, and the controller computes the grade.
//
// The runner works inside a sandbox on an internal network with the preview.
// Everything it reads from the preview is written by the builder, so it
// treats responses as bytes to measure and never as instructions.
package runner

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/checks"
)

// MaxBodyBytes caps how much of a response body is kept.
const MaxBodyBytes = 256 << 10

// Actor is how the runner makes requests as one named user.
type Actor struct {
	// Headers are added to every request made as this actor, for example a
	// session cookie from the project's test fixtures.
	Headers map[string]string `json:"headers"`
}

// Job is everything a runner needs. The controller builds it from the frozen
// suite and the run spec.
type Job struct {
	BaseURL        string           `json:"base_url"`
	Actors         map[string]Actor `json:"actors"`
	Checks         []checks.Check   `json:"checks"`
	TimeoutSeconds int              `json:"timeout_seconds"`
	Browser        BrowserConfig    `json:"browser"`
	// Ready says how to tell that the preview is up before checks start.
	Ready Ready `json:"ready"`
}

// Ready is a readiness probe: a path that must answer with a status.
type Ready struct {
	Path        string `json:"path"`
	Status      int    `json:"status"`
	WaitSeconds int    `json:"wait_seconds"`
}

// WaitReady polls the preview until the readiness probe answers as expected.
// It returns an error if the wait runs out.
func WaitReady(ctx context.Context, job Job) error {
	if job.Ready.Path == "" {
		return nil
	}
	target, err := resolve(job.BaseURL, job.Ready.Path)
	if err != nil {
		return err
	}
	wait := time.Duration(job.Ready.WaitSeconds) * time.Second
	if wait <= 0 {
		wait = 60 * time.Second
	}
	deadline := time.Now().Add(wait)
	client := &http.Client{Timeout: 3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	last := "no answer"
	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return fmt.Errorf("readiness probe could not be built")
		}
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == job.Ready.Status {
				return nil
			}
			last = fmt.Sprintf("status %d", resp.StatusCode)
		} else {
			last = trimError(err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return fmt.Errorf("preview was not ready after %s: %s", wait, last)
}

// BrowserConfig says how browser checks run. An empty value means this
// runner has no browser, and browser checks are reported as not completed.
type BrowserConfig struct {
	// Exec is the path of a headless Chromium binary inside the sandbox.
	Exec string `json:"exec,omitempty"`
}

// BrowserFunc observes one browser check. The browser implementation lives
// in its own file so the HTTP path has no browser dependency.
type BrowserFunc func(ctx context.Context, job Job, check checks.Check) checks.Observation

// Run executes every check and returns one observation per check, in suite
// order.
func Run(ctx context.Context, job Job, browser BrowserFunc) []checks.Observation {
	timeout := time.Duration(job.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	client := &http.Client{
		Timeout: timeout,
		// Report the response the app gave, not the one a redirect leads to.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	out := make([]checks.Observation, 0, len(job.Checks))
	for _, check := range job.Checks {
		switch {
		case check.HTTP != nil:
			out = append(out, observeHTTP(ctx, client, job, check))
		case check.Browser != nil && browser != nil:
			checkCtx, cancel := context.WithTimeout(ctx, timeout)
			out = append(out, browser(checkCtx, job, check))
			cancel()
		case check.Browser != nil:
			out = append(out, checks.Observation{Check: check.ID, Error: "this runner has no browser"})
		default:
			out = append(out, checks.Observation{Check: check.ID, Error: "check has no kind"})
		}
	}
	return out
}

func observeHTTP(ctx context.Context, client *http.Client, job Job, check checks.Check) checks.Observation {
	obs := checks.Observation{Check: check.ID}
	method, path, ok := strings.Cut(check.HTTP.Request, " ")
	if !ok {
		obs.Error = "request is not in the form METHOD /path"
		return obs
	}
	target, err := resolve(job.BaseURL, path)
	if err != nil {
		obs.Error = err.Error()
		return obs
	}
	req, err := http.NewRequestWithContext(ctx, method, target, nil)
	if err != nil {
		obs.Error = "could not build the request"
		return obs
	}
	actor, known := job.Actors[check.HTTP.As]
	if !known {
		obs.Error = fmt.Sprintf("no credentials for actor %q", check.HTTP.As)
		return obs
	}
	for name, value := range actor.Headers {
		req.Header.Set(name, value)
	}
	// Ask for the body as it is. A response that is encoded anyway is
	// reported as such, and the controller does not grade its body.
	req.Header.Set("Accept-Encoding", "identity")

	resp, err := client.Do(req)
	if err != nil {
		obs.Error = "request failed: " + trimError(err)
		return obs
	}
	defer resp.Body.Close()
	// Read one byte past the cap to learn whether the body was longer.
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxBodyBytes+1))
	if err != nil {
		obs.Error = "reading the response failed: " + trimError(err)
		return obs
	}
	truncated := len(body) > MaxBodyBytes
	if truncated {
		body = body[:MaxBodyBytes]
	}
	header := make(map[string]string, len(resp.Header))
	var repeated []string
	for name, values := range resp.Header {
		if len(values) > 0 {
			header[strings.ToLower(name)] = values[0]
		}
		if len(values) > 1 {
			repeated = append(repeated, strings.ToLower(name))
		}
	}
	sort.Strings(repeated)
	obs.HTTP = &checks.HTTPObservation{Status: resp.StatusCode, Header: header, Body: string(body), Truncated: truncated,
		ContentEncoding: resp.Header.Get("Content-Encoding"), RepeatedHeaders: repeated}
	return obs
}

// resolve joins a check's path to the preview's base URL and refuses anything
// that would leave the preview's origin.
func resolve(base, path string) (string, error) {
	b, err := url.Parse(base)
	if err != nil || b.Host == "" || (b.Scheme != "http" && b.Scheme != "https") {
		return "", fmt.Errorf("base URL is not valid")
	}
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return "", fmt.Errorf("check path must start with one slash")
	}
	ref, err := url.Parse(path)
	if err != nil || ref.Host != "" || ref.Scheme != "" {
		return "", fmt.Errorf("check path must not name a host")
	}
	return b.ResolveReference(ref).String(), nil
}

func trimError(err error) string {
	msg := err.Error()
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

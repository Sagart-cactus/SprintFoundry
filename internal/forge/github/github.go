// Package github is the controller's GitHub adapter. It reads pull requests
// and posts commit statuses, and fetches commits into the controller's own
// store. The token comes from the operator's `gh` login and stays with the
// controller: it is never given to a sandbox, and never put on a command line.
package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Client talks to the GitHub REST API.
type Client struct {
	// Base is the API root. Empty means https://api.github.com.
	Base  string
	Token string
	HTTP  *http.Client
}

// TokenFromGH returns the token of the operator's `gh` login.
func TokenFromGH(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "gh", "auth", "token").Output()
	if err != nil {
		return "", fmt.Errorf("github: no gh login (run `gh auth login`): %w", err)
	}
	token := strings.TrimSpace(string(out))
	if token == "" {
		return "", errors.New("github: gh returned an empty token")
	}
	return token, nil
}

var (
	repoName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$`)
	sha      = regexp.MustCompile(`^[0-9a-f]{40}$`)
	// refName is a branch name or a commit ID, as the compare API takes.
	refName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`)
)

// ValidRepo reports whether s looks like owner/name.
func ValidRepo(s string) bool { return repoName.MatchString(s) }

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	base := c.Base
	if base == "" {
		base = "https://api.github.com"
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("github: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 300 {
		var apiErr struct{ Message string }
		_ = json.Unmarshal(data, &apiErr)
		return &APIError{Status: resp.StatusCode, Message: fmt.Sprintf("github: %s %s: %d %s", method, path, resp.StatusCode, apiErr.Message)}
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("github: %s %s: %w", method, path, err)
		}
	}
	return nil
}

// APIError is an error response from the API.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return e.Message }

func isNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

// PullRequest is what the controller needs from a pull request.
type PullRequest struct {
	Number   int
	State    string
	HeadSHA  string
	BaseSHA  string
	BaseRef  string
	Merged   bool
	MergeSHA string // the merge or squash commit, once merged
	HTMLURL  string
}

// GetPullRequest reads one pull request.
func (c *Client) GetPullRequest(ctx context.Context, repo string, number int) (PullRequest, error) {
	if !ValidRepo(repo) || number < 1 {
		return PullRequest{}, fmt.Errorf("github: %q #%d is not a pull request reference", repo, number)
	}
	var raw struct {
		Number         int    `json:"number"`
		State          string `json:"state"`
		Merged         bool   `json:"merged"`
		MergeCommitSHA string `json:"merge_commit_sha"`
		HTMLURL        string `json:"html_url"`
		Head           struct {
			SHA string `json:"sha"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"base"`
	}
	if err := c.do(ctx, http.MethodGet, "/repos/"+repo+"/pulls/"+strconv.Itoa(number), nil, &raw); err != nil {
		return PullRequest{}, err
	}
	if !sha.MatchString(raw.Head.SHA) {
		return PullRequest{}, fmt.Errorf("github: pull request head %q is not a commit ID", raw.Head.SHA)
	}
	if !sha.MatchString(raw.Base.SHA) {
		return PullRequest{}, fmt.Errorf("github: pull request base %q is not a commit ID", raw.Base.SHA)
	}
	pr := PullRequest{Number: raw.Number, State: raw.State, HeadSHA: raw.Head.SHA, BaseSHA: raw.Base.SHA, BaseRef: raw.Base.Ref,
		Merged: raw.Merged, HTMLURL: raw.HTMLURL}
	if raw.Merged && sha.MatchString(raw.MergeCommitSHA) {
		pr.MergeSHA = raw.MergeCommitSHA
	}
	return pr, nil
}

// FirstParent returns the first parent of a commit.
func (c *Client) FirstParent(ctx context.Context, repo, commit string) (string, error) {
	if !ValidRepo(repo) || !sha.MatchString(commit) {
		return "", fmt.Errorf("github: %q %q is not a commit reference", repo, commit)
	}
	var raw struct {
		Parents []struct {
			SHA string `json:"sha"`
		} `json:"parents"`
	}
	if err := c.do(ctx, http.MethodGet, "/repos/"+repo+"/commits/"+commit, nil, &raw); err != nil {
		return "", err
	}
	if len(raw.Parents) == 0 || !sha.MatchString(raw.Parents[0].SHA) {
		return "", fmt.Errorf("github: %s has no parent", commit[:12])
	}
	return raw.Parents[0].SHA, nil
}

// DefaultBranch returns the repository's default branch.
func (c *Client) DefaultBranch(ctx context.Context, repo string) (string, error) {
	if !ValidRepo(repo) {
		return "", fmt.Errorf("github: %q is not a repository", repo)
	}
	var raw struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := c.do(ctx, http.MethodGet, "/repos/"+repo, nil, &raw); err != nil {
		return "", err
	}
	if raw.DefaultBranch == "" {
		return "", fmt.Errorf("github: %s has no default branch", repo)
	}
	return raw.DefaultBranch, nil
}

// Comparison is how head relates to base.
type Comparison struct {
	// Status is ahead, behind, identical or diverged: head relative to base.
	Status    string
	MergeBase string
}

// Compare compares two commits or branches of a repository.
func (c *Client) Compare(ctx context.Context, repo, base, head string) (Comparison, error) {
	if !ValidRepo(repo) || !refName.MatchString(base) || !refName.MatchString(head) {
		return Comparison{}, fmt.Errorf("github: %q %q...%q is not a comparison", repo, base, head)
	}
	var raw struct {
		Status    string `json:"status"`
		MergeBase struct {
			SHA string `json:"sha"`
		} `json:"merge_base_commit"`
	}
	if err := c.do(ctx, http.MethodGet, "/repos/"+repo+"/compare/"+url.PathEscape(base)+"..."+url.PathEscape(head)+"?per_page=1", nil, &raw); err != nil {
		return Comparison{}, err
	}
	if !sha.MatchString(raw.MergeBase.SHA) {
		return Comparison{}, fmt.Errorf("github: comparison has no merge base")
	}
	return Comparison{Status: raw.Status, MergeBase: raw.MergeBase.SHA}, nil
}

// MergedPullRequest returns the pull request that was merged as commit: the
// one whose merge commit it is.
func (c *Client) MergedPullRequest(ctx context.Context, repo, commit string) (PullRequest, bool, error) {
	if !ValidRepo(repo) || !sha.MatchString(commit) {
		return PullRequest{}, false, fmt.Errorf("github: %q %q is not a commit reference", repo, commit)
	}
	var raw []struct {
		Number int `json:"number"`
	}
	if err := c.do(ctx, http.MethodGet, "/repos/"+repo+"/commits/"+commit+"/pulls", nil, &raw); err != nil {
		return PullRequest{}, false, err
	}
	for _, r := range raw {
		pr, err := c.GetPullRequest(ctx, repo, r.Number)
		if err != nil {
			return PullRequest{}, false, err
		}
		if pr.Merged && pr.MergeSHA == commit {
			return pr, true, nil
		}
	}
	return PullRequest{}, false, nil
}

// CreatePullRequest opens a pull request and returns its number. The
// controller does not need it; the end-to-end test does.
func (c *Client) CreatePullRequest(ctx context.Context, repo, head, base, title string) (int, error) {
	if !ValidRepo(repo) {
		return 0, fmt.Errorf("github: %q is not a repository", repo)
	}
	var raw struct {
		Number int `json:"number"`
	}
	err := c.do(ctx, http.MethodPost, "/repos/"+repo+"/pulls", map[string]string{"head": head, "base": base, "title": title}, &raw)
	return raw.Number, err
}

// SquashMerge squash-merges a pull request and returns the new commit.
func (c *Client) SquashMerge(ctx context.Context, repo string, number int) (string, error) {
	var raw struct {
		SHA string `json:"sha"`
	}
	err := c.do(ctx, http.MethodPut, "/repos/"+repo+"/pulls/"+strconv.Itoa(number)+"/merge", map[string]string{"merge_method": "squash"}, &raw)
	if err == nil && !sha.MatchString(raw.SHA) {
		err = fmt.Errorf("github: merge returned %q", raw.SHA)
	}
	return raw.SHA, err
}

// Status is a commit status.
type Status struct {
	State       string `json:"state"` // success, failure, error or pending
	Context     string `json:"context"`
	Description string `json:"description"`
}

// SetStatus posts a commit status. The description is cut to GitHub's limit.
func (c *Client) SetStatus(ctx context.Context, repo, commit string, s Status) error {
	if !ValidRepo(repo) || !sha.MatchString(commit) {
		return fmt.Errorf("github: %q %q is not a commit reference", repo, commit)
	}
	switch s.State {
	case "success", "failure", "error", "pending":
	default:
		return fmt.Errorf("github: status state %q is not valid", s.State)
	}
	if len(s.Description) > 140 {
		s.Description = s.Description[:137] + "..."
	}
	return c.do(ctx, http.MethodPost, "/repos/"+repo+"/statuses/"+commit, s, nil)
}

// GetStatuses returns the statuses posted on a commit, newest first.
func (c *Client) GetStatuses(ctx context.Context, repo, commit string) ([]Status, error) {
	if !ValidRepo(repo) || !sha.MatchString(commit) {
		return nil, fmt.Errorf("github: %q %q is not a commit reference", repo, commit)
	}
	var out []Status
	err := c.do(ctx, http.MethodGet, "/repos/"+repo+"/commits/"+commit+"/statuses", nil, &out)
	return out, err
}

// gitAuth returns the environment that hands the token to git without
// putting it on a command line.
func gitAuth(token string) []string {
	basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	return []string{"GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader",
		"GIT_CONFIG_VALUE_0=Authorization: Basic " + basic}
}

// GitWithToken runs git in dir with the token available for github.com. The
// end-to-end test uses it to push to a test repository.
func GitWithToken(ctx context.Context, dir, token string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "core.hooksPath=" + os.DevNull, "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(scrubbedEnv(), gitAuth(token)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
		return nil, fmt.Errorf("git %s: %v: %s", args[0], err, strings.ReplaceAll(string(out), basic, "[token]"))
	}
	return out, nil
}

// Fetch copies one commit of a GitHub repository into the controller's bare
// store. The token travels in git's configuration environment, not on a
// command line, and hooks and user configuration are ignored.
//
// Fetches into one store take turns, across processes, through a lock file
// next to the store, and run with git's automatic gc and maintenance off, so
// no git keeps working in the store after a fetch returns. A fetch that was
// killed outright leaves git's shallow.lock behind. Under the lock no fetch
// of ours can be running, so a shallow.lock older than a minute is stale and
// removed; a newer one (some other git at work in the store) is an error.
func Fetch(ctx context.Context, store, repo, commit, token string) error {
	if !ValidRepo(repo) || !sha.MatchString(commit) {
		return fmt.Errorf("github: %q %q is not a commit reference", repo, commit)
	}
	unlock, err := lockStore(ctx, store)
	if err != nil {
		return err
	}
	defer unlock()
	if info, err := os.Stat(filepath.Join(store, "shallow.lock")); err == nil {
		if time.Since(info.ModTime()) < time.Minute {
			return fmt.Errorf("github: %s is in use by another git (shallow.lock is %s old); try again later", store, time.Since(info.ModTime()).Round(time.Second))
		}
		if err := os.Remove(filepath.Join(store, "shallow.lock")); err != nil {
			return fmt.Errorf("github: remove a stale shallow.lock: %w", err)
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	if _, err := os.Stat(store); err != nil {
		init := exec.CommandContext(ctx, "git", "init", "--bare", "--quiet", store)
		init.Env = scrubbedEnv()
		if out, err := init.CombinedOutput(); err != nil {
			return fmt.Errorf("github: create store: %v: %s", err, out)
		}
	}
	basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	cmd := exec.CommandContext(ctx, "git", "--git-dir", store,
		"-c", "core.hooksPath="+os.DevNull, "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
		"-c", "gc.auto=0", "-c", "maintenance.auto=false",
		"fetch", "--quiet", "--no-tags", "--depth=1", "https://github.com/"+repo+".git", commit)
	cmd.Env = append(scrubbedEnv(), gitAuth(token)...)
	gentle(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.ReplaceAll(stderr.String(), basic, "[token]")
		return fmt.Errorf("github: fetch %s %s: %v: %s", repo, commit[:12], err, strings.TrimSpace(msg))
	}
	return nil
}

// gentle makes a cancelled git stop with SIGTERM, so it removes its lock
// files, and kills it only if it has not stopped ten seconds later.
func gentle(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 10 * time.Second
}

// lockStore takes an exclusive lock on a store, shared by every process
// that uses it, and waits for it as long as ctx allows.
func lockStore(ctx context.Context, store string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(store), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(store+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("github: lock %s: %w", store, err)
	}
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			_ = f.Close()
			return nil, fmt.Errorf("github: lock %s: %w", store, err)
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func scrubbedEnv() []string {
	return []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.DevNull, "GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=" + os.DevNull, "GIT_TERMINAL_PROMPT=0", "GIT_NO_REPLACE_OBJECTS=1"}
}

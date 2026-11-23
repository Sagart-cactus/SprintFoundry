package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// branchName is a branch the controller creates or looks up.
var branchName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`)

// Repo is one repository, as a controller job uses it: it pushes a branch,
// opens a pull request and posts a status, and can look each of them up
// first, so a job resumed after a crash does not do them twice.
type Repo struct {
	Client *Client
	// Name is owner/name.
	Name  string
	Token string
	// GitURL is where git pushes, without the trailing owner/name.git.
	// Empty means https://github.com/. Tests point it at a local directory.
	GitURL string
}

// FindBranch returns the commit a branch points at.
func (r *Repo) FindBranch(ctx context.Context, branch string) (string, bool, error) {
	if !ValidRepo(r.Name) || !branchName.MatchString(branch) || strings.Contains(branch, "..") {
		return "", false, fmt.Errorf("github: %q %q is not a branch reference", r.Name, branch)
	}
	var body json.RawMessage
	err := r.Client.do(ctx, http.MethodGet, "/repos/"+r.Name+"/git/ref/heads/"+branch, nil, &body)
	if isNotFound(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	// The API answers a name that only prefixes other branches with a list
	// of them; the branch itself is an object.
	if t := bytes.TrimSpace(body); len(t) > 0 && t[0] == '[' {
		return "", false, nil
	}
	var raw struct {
		Ref    string `json:"ref"`
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return "", false, fmt.Errorf("github: branch %s: %w", branch, err)
	}
	if raw.Ref != "refs/heads/"+branch || !sha.MatchString(raw.Object.SHA) {
		return "", false, nil
	}
	return raw.Object.SHA, true, nil
}

// PushBranch creates branch at commit, copying the commit from the
// controller's bare store. It only ever creates the branch: the push carries
// an empty expected value, so git refuses it when the branch exists at all,
// even at an ancestor it could fast-forward.
func (r *Repo) PushBranch(ctx context.Context, storeDir, commit, branch string) error {
	if !ValidRepo(r.Name) || !sha.MatchString(commit) || !branchName.MatchString(branch) || strings.Contains(branch, "..") {
		return fmt.Errorf("github: %q %q %q is not a push", r.Name, commit, branch)
	}
	base, protocol := r.GitURL, "https"
	if base == "" {
		base = "https://github.com/"
	} else if !strings.HasPrefix(base, "https://") {
		protocol = "file"
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "--git-dir", storeDir,
		"-c", "core.hooksPath="+os.DevNull, "-c", "protocol.allow=never", "-c", "protocol."+protocol+".allow=always",
		"push", "--quiet", "--no-verify", "--force-with-lease=refs/heads/"+branch+":", base+r.Name+".git", commit+":refs/heads/"+branch)
	cmd.Env = append(scrubbedEnv(), gitAuth(r.Token)...)
	gentle(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + r.Token))
		return fmt.Errorf("github: push %s to %s: %v: %s", commit[:12], branch, err, strings.TrimSpace(strings.ReplaceAll(stderr.String(), basic, "[token]")))
	}
	return nil
}

// FindPullRequest returns the pull request, open or closed, whose head is
// branch in this repository.
func (r *Repo) FindPullRequest(ctx context.Context, branch string) (int, bool, error) {
	if !ValidRepo(r.Name) || !branchName.MatchString(branch) {
		return 0, false, fmt.Errorf("github: %q %q is not a branch reference", r.Name, branch)
	}
	owner := strings.SplitN(r.Name, "/", 2)[0]
	var raw []struct {
		Number int `json:"number"`
		Head   struct {
			Ref string `json:"ref"`
		} `json:"head"`
	}
	q := url.Values{"head": {owner + ":" + branch}, "state": {"all"}, "per_page": {"10"}}
	if err := r.Client.do(ctx, http.MethodGet, "/repos/"+r.Name+"/pulls?"+q.Encode(), nil, &raw); err != nil {
		return 0, false, err
	}
	for _, pr := range raw {
		if pr.Head.Ref == branch && pr.Number > 0 {
			return pr.Number, true, nil
		}
	}
	return 0, false, nil
}

// OpenPullRequest opens a pull request from branch into base.
func (r *Repo) OpenPullRequest(ctx context.Context, branch, base, title, body string) (int, error) {
	if !ValidRepo(r.Name) || !branchName.MatchString(branch) || !branchName.MatchString(base) {
		return 0, fmt.Errorf("github: %q %q into %q is not a pull request", r.Name, branch, base)
	}
	var raw struct {
		Number int `json:"number"`
	}
	err := r.Client.do(ctx, http.MethodPost, "/repos/"+r.Name+"/pulls",
		map[string]string{"head": branch, "base": base, "title": title, "body": body}, &raw)
	if err == nil && raw.Number < 1 {
		err = fmt.Errorf("github: pull request number %s", strconv.Itoa(raw.Number))
	}
	return raw.Number, err
}

// SetStatus posts a commit status on a commit of this repository.
func (r *Repo) SetStatus(ctx context.Context, commit, state, description string) error {
	return r.Client.SetStatus(ctx, r.Name, commit, Status{State: state, Context: "sprintfoundry/candidate", Description: description})
}

// Issue is what the controller reads from an issue.
type Issue struct {
	Number int
	Title  string
	Body   string
	State  string
	Labels []string
	// PullRequest is set when the number is a pull request, which the
	// issues API also returns.
	PullRequest bool
}

type rawIssue struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	State  string `json:"state"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
	PullRequest *struct{} `json:"pull_request"`
}

func (r rawIssue) issue() Issue {
	i := Issue{Number: r.Number, Title: r.Title, Body: r.Body, State: r.State, PullRequest: r.PullRequest != nil}
	for _, l := range r.Labels {
		i.Labels = append(i.Labels, l.Name)
	}
	return i
}

// GetIssue reads one issue.
func (c *Client) GetIssue(ctx context.Context, repo string, number int) (Issue, error) {
	if !ValidRepo(repo) || number < 1 {
		return Issue{}, fmt.Errorf("github: %q #%d is not an issue reference", repo, number)
	}
	var raw rawIssue
	if err := c.do(ctx, http.MethodGet, "/repos/"+repo+"/issues/"+strconv.Itoa(number), nil, &raw); err != nil {
		return Issue{}, err
	}
	return raw.issue(), nil
}

// LabeledIssues lists open issues with a label, leaving pull requests out.
func (c *Client) LabeledIssues(ctx context.Context, repo, label string) ([]Issue, error) {
	if !ValidRepo(repo) || !branchName.MatchString(label) {
		return nil, fmt.Errorf("github: %q %q is not an issue query", repo, label)
	}
	var raw []rawIssue
	q := url.Values{"labels": {label}, "state": {"open"}, "per_page": {"100"}}
	if err := c.do(ctx, http.MethodGet, "/repos/"+repo+"/issues?"+q.Encode(), nil, &raw); err != nil {
		return nil, err
	}
	var out []Issue
	for _, r := range raw {
		if r.PullRequest == nil {
			out = append(out, r.issue())
		}
	}
	return out, nil
}

// Package linear reads issues from Linear (design 0010). It only reads: the
// controller freezes an issue's text as a job's criteria, and lists issues
// labelled for SprintFoundry. Linear's own GitHub integration links the pull
// request back to the issue. The API key stays with the controller and is
// sent only to the Linear API.
package linear

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// KeyEnv names the environment variable that holds the operator's Linear
// API key.
const KeyEnv = "LINEAR_API_KEY"

// Client talks to the Linear GraphQL API.
type Client struct {
	// Base is the API endpoint. Empty means https://api.linear.app/graphql.
	Base string
	Key  string
	HTTP *http.Client
}

// KeyFromEnv returns the operator's Linear API key.
func KeyFromEnv() (string, error) {
	key := strings.TrimSpace(os.Getenv(KeyEnv))
	if key == "" {
		return "", fmt.Errorf("linear: set %s to a Linear API key (Settings, Security & access, Personal API keys); read access is enough", KeyEnv)
	}
	if strings.ContainsAny(key, " \t\r\n") {
		return "", fmt.Errorf("linear: %s holds white space; it is not an API key", KeyEnv)
	}
	return key, nil
}

// Issue is what the controller needs from a Linear issue.
type Issue struct {
	Identifier  string
	Title       string
	Description string
	URL         string
	// StateType is the type of the issue's workflow state: triage, backlog,
	// unstarted, started, completed or canceled.
	StateType string
}

// Open reports whether work on the issue can still start.
func (i Issue) Open() bool { return i.StateType != "completed" && i.StateType != "canceled" }

var identifier = regexp.MustCompile(`^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$`)

// NormalIdentifier returns an issue identifier such as ENG-123 in its usual
// upper case, and whether it is one.
func NormalIdentifier(s string) (string, bool) {
	s = strings.ToUpper(s)
	return s, identifier.MatchString(s)
}

// ErrNotFound is returned for an issue that does not exist or that the key
// cannot see.
var ErrNotFound = errors.New("linear: issue not found")

type issueNode struct {
	Identifier  string  `json:"identifier"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
	URL         string  `json:"url"`
	State       *struct {
		Type string `json:"type"`
	} `json:"state"`
}

func (n issueNode) issue() Issue {
	i := Issue{Identifier: n.Identifier, Title: n.Title, URL: n.URL}
	if n.Description != nil {
		i.Description = *n.Description
	}
	if n.State != nil {
		i.StateType = n.State.Type
	}
	return i
}

// GetIssue reads one issue by its identifier.
func (c *Client) GetIssue(ctx context.Context, id string) (Issue, error) {
	id, ok := NormalIdentifier(id)
	if !ok {
		return Issue{}, fmt.Errorf("linear: %q is not an issue identifier such as ENG-123", id)
	}
	var out struct {
		Issue *issueNode `json:"issue"`
	}
	err := c.query(ctx, `query Issue($id: String!) {
  issue(id: $id) { identifier title description url state { type } }
}`, map[string]any{"id": id}, &out)
	if errors.Is(err, errEntityNotFound) || (err == nil && out.Issue == nil) {
		return Issue{}, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if err != nil {
		return Issue{}, err
	}
	issue := out.Issue.issue()
	if issue.Identifier != id {
		return Issue{}, fmt.Errorf("linear: asked for %s, got %q", id, issue.Identifier)
	}
	return issue, nil
}

// LabeledIssues returns open issues that carry label, at most 100.
func (c *Client) LabeledIssues(ctx context.Context, label string) ([]Issue, error) {
	var out struct {
		Issues struct {
			Nodes []issueNode `json:"nodes"`
		} `json:"issues"`
	}
	err := c.query(ctx, `query Labeled($label: String!) {
  issues(first: 100, filter: {
    labels: { some: { name: { eqIgnoreCase: $label } } }
    state: { type: { nin: ["completed", "canceled"] } }
  }) { nodes { identifier title url state { type } } }
}`, map[string]any{"label": label}, &out)
	if err != nil {
		return nil, err
	}
	var issues []Issue
	for _, n := range out.Issues.Nodes {
		if _, ok := NormalIdentifier(n.Identifier); ok {
			issues = append(issues, n.issue())
		}
	}
	return issues, nil
}

var errEntityNotFound = errors.New("linear: entity not found")

// maxResponse bounds what the controller reads from one answer.
const maxResponse = 8 << 20

func (c *Client) query(ctx context.Context, query string, variables map[string]any, out any) error {
	if c.Key == "" {
		return errors.New("linear: no API key")
	}
	base := c.Base
	if base == "" {
		base = "https://api.linear.app/graphql"
	}
	raw, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// A personal API key goes in the header as it is, without "Bearer".
	req.Header.Set("Authorization", c.Key)
	httpc := c.HTTP
	if httpc == nil {
		httpc = &http.Client{Timeout: 30 * time.Second}
	}
	// Never follow a redirect: it could carry the key to another host.
	noRedirect := *httpc
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := noRedirect.Do(req)
	if err != nil {
		return fmt.Errorf("linear: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil {
		return fmt.Errorf("linear: read the answer: %w", err)
	}
	if len(body) > maxResponse {
		return errors.New("linear: the answer is too large")
	}
	var envelope struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message    string `json:"message"`
			Extensions struct {
				Code string `json:"code"`
			} `json:"extensions"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return fmt.Errorf("linear: HTTP %d, not a GraphQL answer", resp.StatusCode)
	}
	if len(envelope.Errors) > 0 {
		e := envelope.Errors[0]
		if strings.EqualFold(e.Extensions.Code, "ENTITY_NOT_FOUND") || strings.Contains(strings.ToLower(e.Message), "entity not found") {
			return errEntityNotFound
		}
		if resp.StatusCode == http.StatusUnauthorized || strings.EqualFold(e.Extensions.Code, "AUTHENTICATION_ERROR") {
			return fmt.Errorf("linear: the API key was refused (%s)", KeyEnv)
		}
		return fmt.Errorf("linear: HTTP %d: %s", resp.StatusCode, clip(e.Message, 300))
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("linear: HTTP %d", resp.StatusCode)
	}
	if len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return errors.New("linear: the answer has no data")
	}
	return json.Unmarshal(envelope.Data, out)
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + "…"
}

package linear

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeLinear answers GraphQL requests with the function's result, and
// records what it was asked.
func fakeLinear(t *testing.T, answer func(query string, vars map[string]any) (int, string)) (*Client, *[]http.Header) {
	t.Helper()
	var headers []http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = append(headers, r.Header.Clone())
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		if r.Method != http.MethodPost || json.Unmarshal(raw, &req) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		status, body := answer(req.Query, req.Variables)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return &Client{Base: srv.URL, Key: "lin_api_test"}, &headers
}

func TestGetIssue(t *testing.T) {
	c, headers := fakeLinear(t, func(q string, vars map[string]any) (int, string) {
		if !strings.Contains(q, "issue(id: $id)") || vars["id"] != "ENG-12" {
			return 400, `{"errors":[{"message":"unexpected"}]}`
		}
		return 200, `{"data":{"issue":{"id":"uuid-12","identifier":"ENG-12","title":"Add a health check","description":"GET /health returns 200.","url":"https://linear.app/x/issue/ENG-12","state":{"type":"started"}}}}`
	})
	issue, err := c.GetIssue(context.Background(), "eng-12")
	if err != nil {
		t.Fatal(err)
	}
	if issue.ID != "uuid-12" || issue.Identifier != "ENG-12" || issue.Title != "Add a health check" || issue.Description != "GET /health returns 200." || !issue.Open() {
		t.Errorf("issue: %+v", issue)
	}
	if got := (*headers)[0].Get("Authorization"); got != "lin_api_test" {
		t.Errorf("Authorization header %q, want the key as it is", got)
	}
}

func TestGetIssueEdges(t *testing.T) {
	cases := map[string]struct {
		status int
		body   string
		want   func(Issue, error) bool
	}{
		"not found": {200, `{"data":null,"errors":[{"message":"Entity not found: Issue","extensions":{"code":"ENTITY_NOT_FOUND"}}]}`,
			func(_ Issue, err error) bool { return errors.Is(err, ErrNotFound) }},
		"null issue": {200, `{"data":{"issue":null}}`,
			func(_ Issue, err error) bool { return errors.Is(err, ErrNotFound) }},
		"no description": {200, `{"data":{"issue":{"id":"u1","identifier":"ENG-12","title":"T","description":null,"url":"u","state":{"type":"completed"}}}}`,
			func(i Issue, err error) bool { return err == nil && i.Description == "" && !i.Open() }},
		"cancelled": {200, `{"data":{"issue":{"id":"u1","identifier":"ENG-12","title":"T","url":"u","state":{"type":"canceled"}}}}`,
			func(i Issue, err error) bool { return err == nil && !i.Open() }},
		"duplicate": {200, `{"data":{"issue":{"id":"u1","identifier":"ENG-12","title":"T","url":"u","state":{"type":"duplicate"}}}}`,
			func(i Issue, err error) bool { return err == nil && !i.Open() }},
		"a state type added later": {200, `{"data":{"issue":{"id":"u1","identifier":"ENG-12","title":"T","url":"u","state":{"type":"parked"}}}}`,
			func(i Issue, err error) bool { return err == nil && !i.Open() }},
		"trashed": {200, `{"data":{"issue":{"id":"u1","identifier":"ENG-12","title":"T","url":"u","state":{"type":"started"},"trashed":true}}}`,
			func(i Issue, err error) bool { return err == nil && !i.Open() }},
		"archived": {200, `{"data":{"issue":{"id":"u1","identifier":"ENG-12","title":"T","url":"u","state":{"type":"started"},"archivedAt":"2026-11-01T00:00:00Z"}}}`,
			func(i Issue, err error) bool { return err == nil && !i.Open() }},
		"moved to another team": {200, `{"data":{"issue":{"id":"u1","identifier":"OPS-3","title":"T","url":"u","state":{"type":"started"},"trashed":false,"archivedAt":null}}}`,
			func(i Issue, err error) bool {
				return err == nil && i.Identifier == "OPS-3" && i.ID == "u1" && i.Open()
			}},
		"no ID": {200, `{"data":{"issue":{"identifier":"ENG-12","title":"T","url":"u","state":{"type":"started"}}}}`,
			func(_ Issue, err error) bool { return err != nil && !errors.Is(err, ErrNotFound) }},
		"a malformed identifier": {200, `{"data":{"issue":{"id":"u1","identifier":"eng 12; x","title":"T","url":"u","state":{"type":"started"}}}}`,
			func(_ Issue, err error) bool { return err != nil }},
		"key refused": {401, `{"errors":[{"message":"Authentication required","extensions":{"code":"AUTHENTICATION_ERROR"}}]}`,
			func(_ Issue, err error) bool { return err != nil && strings.Contains(err.Error(), KeyEnv) }},
		"server error": {502, `<html>bad gateway</html>`,
			func(_ Issue, err error) bool { return err != nil && strings.Contains(err.Error(), "502") }},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c, _ := fakeLinear(t, func(string, map[string]any) (int, string) { return tc.status, tc.body })
			issue, err := c.GetIssue(context.Background(), "ENG-12")
			if !tc.want(issue, err) {
				t.Errorf("issue %+v, err %v", issue, err)
			}
			if err != nil && strings.Contains(err.Error(), "lin_api_test") {
				t.Errorf("the error shows the key: %v", err)
			}
		})
	}
}

func TestIdentifiersAreCheckedBeforeAsking(t *testing.T) {
	asked := false
	c, _ := fakeLinear(t, func(string, map[string]any) (int, string) { asked = true; return 200, `{}` })
	for _, id := range []string{"", "ENG", "ENG-0", "ENG-01", "123", "ENG-12 OR 1", "ENG-12\n", "eng_x-1", "TOOLONGTEAMKEY-1"} {
		if _, err := c.GetIssue(context.Background(), id); err == nil {
			t.Errorf("%q was accepted", id)
		}
	}
	if asked {
		t.Error("Linear was asked about an identifier that is not one")
	}
}

func TestARedirectIsNotFollowedWithTheKey(t *testing.T) {
	var leaked bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked = r.Header.Get("Authorization") != ""
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	c := &Client{Base: srv.URL, Key: "lin_api_test"}
	if _, err := c.GetIssue(context.Background(), "ENG-1"); err == nil {
		t.Error("a redirect was taken as an answer")
	}
	if leaked {
		t.Error("the key followed a redirect to another host")
	}
}

func TestLabeledIssues(t *testing.T) {
	c, _ := fakeLinear(t, func(q string, vars map[string]any) (int, string) {
		if vars["label"] != "sprintfoundry" || !strings.Contains(q, "eqIgnoreCase") || !strings.Contains(q, `in: ["triage", "backlog", "unstarted", "started"]`) {
			return 400, `{"errors":[{"message":"unexpected"}]}`
		}
		return 200, `{"data":{"issues":{"nodes":[
			{"id":"a","identifier":"ENG-1","title":"One","url":"u1","state":{"type":"backlog"}},
			{"id":"b","identifier":"not an id","title":"Bad","url":"u2","state":{"type":"backlog"}},
			{"identifier":"ENG-2","title":"No ID","url":"u4","state":{"type":"backlog"}},
			{"id":"c","identifier":"OPS-7","title":"Seven","url":"u3","state":{"type":"started"}}]}}}`
	})
	issues, err := c.LabeledIssues(context.Background(), "sprintfoundry")
	if err != nil {
		t.Fatal(err)
	}
	if len(issues) != 2 || issues[0].Identifier != "ENG-1" || issues[1].Identifier != "OPS-7" || issues[1].ID != "c" {
		t.Errorf("issues: %+v", issues)
	}
}

func TestKeyFromEnv(t *testing.T) {
	t.Setenv(KeyEnv, "")
	if _, err := KeyFromEnv(); err == nil {
		t.Error("an empty key was accepted")
	}
	t.Setenv(KeyEnv, "lin_api_a b")
	if _, err := KeyFromEnv(); err == nil {
		t.Error("a key with a space was accepted")
	}
	t.Setenv(KeyEnv, " lin_api_ok\n")
	if k, err := KeyFromEnv(); err != nil || k != "lin_api_ok" {
		t.Errorf("key %q, %v", k, err)
	}
}

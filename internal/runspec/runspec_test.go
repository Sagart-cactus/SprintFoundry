package runspec

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

const demoSpec = `
version: 1
build:
  dockerfile: Dockerfile
  network: none
preview:
  port: 8080
  health: { path: /healthz, status: 200 }
actors:
  owner:  { headers: { Cookie: session=owner-session } }
  member: { headers: { Cookie: session=member-session } }
sensitive_paths:
  - Dockerfile
  - "test_*.py"
  - "*_test.go"
  - ".github/workflows/*"
  - requirements*.txt
`

func TestParseAndDigest(t *testing.T) {
	s, err := Parse([]byte(demoSpec))
	if err != nil {
		t.Fatal(err)
	}
	if s.Preview.Port != 8080 || s.Actors["owner"].Headers["Cookie"] != "session=owner-session" {
		t.Errorf("parsed wrongly: %+v", s)
	}
	base := s.Digest()

	reordered, err := Parse([]byte("# reviewed\n" + strings.Replace(demoSpec, "  port: 8080\n  health: { path: /healthz, status: 200 }", "  health:\n    status: 200\n    path: /healthz\n  port: 8080", 1)))
	if err != nil {
		t.Fatal(err)
	}
	if reordered.Digest() != base {
		t.Error("digest changed with layout only")
	}
	weaker, _ := Parse([]byte(strings.Replace(demoSpec, "  - \"test_*.py\"\n", "", 1)))
	if weaker.Digest() == base {
		t.Error("digest did not change when a sensitive path was removed")
	}
}

func TestSensitivePaths(t *testing.T) {
	s, err := Parse([]byte(demoSpec))
	if err != nil {
		t.Fatal(err)
	}
	changed := []string{"app.py", "test_app.py", "Dockerfile", "docs/notes.md", "pkg/thing_test.go",
		".github/workflows/ci.yml", "deploy/Dockerfile", "requirements-dev.txt", "tests/helpers.py"}
	want := []string{".github/workflows/ci.yml", "Dockerfile", "deploy/Dockerfile", "pkg/thing_test.go", "requirements-dev.txt", "test_app.py"}
	if got := s.Sensitive(changed); !reflect.DeepEqual(got, want) {
		t.Errorf("Sensitive = %v\nwant        %v", got, want)
	}
	if got := s.Sensitive([]string{"app.py"}); len(got) != 0 {
		t.Errorf("an ordinary change was flagged: %v", got)
	}
}

func TestParseRejects(t *testing.T) {
	tests := map[string]func(string) string{
		"build with network": func(s string) string { return strings.Replace(s, "network: none", "network: host", 1) },
		"dockerfile outside context": func(s string) string {
			return strings.Replace(s, "dockerfile: Dockerfile", "dockerfile: ../Dockerfile", 1)
		},
		"dockerfile that is a flag": func(s string) string {
			return strings.Replace(s, "dockerfile: Dockerfile", "dockerfile: --output=x", 1)
		},
		"absolute dockerfile": func(s string) string {
			return strings.Replace(s, "dockerfile: Dockerfile", "dockerfile: /etc/Dockerfile", 1)
		},
		"no sensitive paths":       func(s string) string { return s[:strings.Index(s, "sensitive_paths:")] + "sensitive_paths: []\n" },
		"dockerfile not sensitive": func(s string) string { return strings.Replace(s, "  - Dockerfile\n", "", 1) },
		"unknown field":            func(s string) string { return strings.Replace(s, "preview:", "preview:\n  command: sh -c evil", 1) },
		"no actors": func(s string) string {
			return strings.Replace(s[:strings.Index(s, "actors:")]+"actors: {}\n"+s[strings.Index(s, "sensitive_paths:"):], "", "", 0)
		},
		"bad port":                     func(s string) string { return strings.Replace(s, "port: 8080", "port: 0", 1) },
		"health without leading slash": func(s string) string { return strings.Replace(s, "path: /healthz", "path: healthz", 1) },
		"base image by tag": func(s string) string {
			return strings.Replace(s, "network: none", "network: none\n  base_images: [\"docker.io/library/python:3.13-alpine\"]", 1)
		},
		"version 2": func(s string) string { return strings.Replace(s, "version: 1", "version: 2", 1) },
	}
	for name, edit := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(edit(demoSpec))); !errors.Is(err, ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
		})
	}
}

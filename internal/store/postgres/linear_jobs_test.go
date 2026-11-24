package postgres_test

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

func linearJob(t *testing.T, s *postgres.Store, id, key, criteria string) postgres.Job {
	return linearJobUID(t, s, id, key, "uid-"+key, criteria)
}

func linearJobUID(t *testing.T, s *postgres.Store, id, key, uid, criteria string) postgres.Job {
	t.Helper()
	r := newRun(t, s, "unused-"+id, "github.com/o/r", criteria)
	return postgres.Job{ID: id, Repository: "github.com/o/r", Source: postgres.SourceLinear, IssueKey: key, IssueUID: uid, IssueTitle: "Add a thing",
		Base: "0123456789abcdef0123456789abcdef01234567", BaseBranch: "main",
		Inputs: postgres.Run{CriteriaDigest: r.CriteriaDigest, SuiteDigest: r.SuiteDigest, RunSpecDigest: r.RunSpecDigest}}
}

func TestALinearJobIsCreatedOncePerIssueAndCriteria(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	j := linearJob(t, s, "job-eng-1-a", "ENG-1", "criteria A")
	if err := s.CreateJob(ctx, j); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetJob(ctx, j.ID)
	if err != nil || got.Source != postgres.SourceLinear || got.IssueKey != "ENG-1" || got.IssueUID != "uid-ENG-1" || got.Issue != 0 || got.IssueTitle != "Add a thing" || got.IssueRef() != "ENG-1" {
		t.Fatalf("GetJob: %+v %v", got, err)
	}

	again := j
	again.ID = "job-eng-1-b"
	if err := s.CreateJob(ctx, again); !errors.Is(err, postgres.ErrJobExists) {
		t.Fatalf("a second job for the same Linear issue and criteria: err = %v, want ErrJobExists", err)
	}
	// Another Linear issue with the same text, and a GitHub issue with it,
	// are different jobs.
	// The same issue after a move to another team is the same issue.
	moved := j
	moved.ID, moved.IssueKey = "job-ops-9-a", "OPS-9"
	if err := s.CreateJob(ctx, moved); !errors.Is(err, postgres.ErrJobExists) {
		t.Fatalf("a job for the same Linear issue under its new identifier: err = %v, want ErrJobExists", err)
	}
	other := j
	other.ID, other.IssueKey, other.IssueUID = "job-eng-2-a", "ENG-2", "uid-ENG-2"
	if err := s.CreateJob(ctx, other); err != nil {
		t.Fatalf("another Linear issue with the same criteria: %v", err)
	}
	gh := j
	gh.ID, gh.Source, gh.IssueKey, gh.IssueUID, gh.Issue = "job-1-a", postgres.SourceGitHub, "", "", 1
	if err := s.CreateJob(ctx, gh); err != nil {
		t.Fatalf("a GitHub issue with the same criteria: %v", err)
	}
	if got, _ := s.GetJob(ctx, gh.ID); got.IssueRef() != "#1" {
		t.Errorf("GitHub job reference %q", got.IssueRef())
	}
}

func TestAJobMustNameItsIssueOneWay(t *testing.T) {
	s := open(t, freshURL(t))
	ctx := context.Background()
	base := linearJob(t, s, "job-x", "ENG-1", "criteria")
	for name, change := range map[string]func(*postgres.Job){
		"Linear without a key":    func(j *postgres.Job) { j.IssueKey = "" },
		"Linear without an ID":    func(j *postgres.Job) { j.IssueUID = "" },
		"GitHub with a Linear ID": func(j *postgres.Job) { j.Source, j.Issue, j.IssueKey = postgres.SourceGitHub, 3, "" },
		"Linear with a number":    func(j *postgres.Job) { j.Issue = 3 },
		"GitHub without number":   func(j *postgres.Job) { j.Source = postgres.SourceGitHub },
		"GitHub with a key":       func(j *postgres.Job) { j.Source, j.Issue = postgres.SourceGitHub, 3 },
		"an unknown source":       func(j *postgres.Job) { j.Source = "jira" },
		"empty source with a key": func(j *postgres.Job) { j.Source, j.Issue = "", 3 },
	} {
		j := base
		change(&j)
		if err := s.CreateJob(ctx, j); err == nil {
			t.Errorf("%s: created", name)
		}
	}
}

// A database made by milestone 3 keeps its jobs, and loses the old
// uniqueness that would make two Linear issues with the same text collide.
func TestAnOlderJobTableIsUpgraded(t *testing.T) {
	url := freshURL(t)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	older, err := os.ReadFile("testdata/schema-m3.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, string(older)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO sf_inputs (digest, kind, content) VALUES ('sha256:c', 'criteria', 'c');
		INSERT INTO sf_jobs (id, repository, issue, base, base_branch, criteria_digest, suite_digest, runspec_digest)
		VALUES ('job-old', 'github.com/o/r', 5, 'b', 'main', 'sha256:c', 'sha256:c', 'sha256:c');`); err != nil {
		t.Fatal(err)
	}
	s := open(t, url)
	old, err := s.GetJob(ctx, "job-old")
	if err != nil || old.Source != postgres.SourceGitHub || old.IssueRef() != "#5" {
		t.Fatalf("the older job: %+v %v", old, err)
	}
	var left int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE conrelid = 'sf_jobs'::regclass AND contype = 'u'`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Errorf("%d unique constraints are left on sf_jobs", left)
	}
	a := linearJob(t, s, "job-eng-1", "ENG-1", "same text")
	b := linearJob(t, s, "job-eng-2", "ENG-2", "same text")
	if err := s.CreateJob(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateJob(ctx, b); err != nil {
		t.Fatalf("two Linear issues with the same text after the upgrade: %v", err)
	}
}

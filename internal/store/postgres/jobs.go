package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Job states. A job is open while queued or running.
const (
	JobQueued     = "queued"
	JobRunning    = "running"
	JobPassed     = "passed"
	JobNeedsOwner = "needs_owner"
	// JobAwaitingPublish: the change passed and waits for a person to
	// approve pushing it. No controller claims the job until then.
	JobAwaitingPublish = "awaiting_publish"
)

// Errors returned by the job functions.
var (
	ErrJobExists      = errors.New("postgres: a job for this issue and criteria already exists")
	ErrLeaseLost      = errors.New("postgres: the lease on the job is not held")
	ErrAllowanceUsed  = errors.New("postgres: the evaluation allowance for these criteria is used up")
	ErrRequestCapUsed = errors.New("postgres: the model request cap for these criteria is used up")
	ErrAttemptsUsed   = errors.New("postgres: the builder attempts for this round are used up")
)

// Job is one approved piece of work: an issue's criteria, frozen with a check
// suite and a run spec, to be built on Base.
type Job struct {
	ID         string
	Repository string
	// Source is where the issue lives: SourceGitHub with the issue number in
	// Issue, or SourceLinear with the identifier in IssueKey. Empty means
	// SourceGitHub.
	Source   string
	Issue    int
	IssueKey string
	// IssueUID is Linear's own ID for the issue; it identifies a Linear
	// job's issue when its identifier changes.
	IssueUID string
	// IssueTitle is the issue's title when it was approved.
	IssueTitle string
	// Base is the commit the builder starts from, on BaseBranch.
	Base        string
	BaseBranch  string
	Inputs      Run
	State       string
	Reason      string
	PullRequest int
	// Claims counts how often a controller took the job up, this claim
	// included; Failures how often a run of it ended in an error.
	Claims, Failures int
	LastError        string
	// PublishApproved is set once a person approved pushing the change.
	PublishApproved bool
}

// Issue sources.
const (
	SourceGitHub = "github"
	SourceLinear = "linear"
)

// IssueRef names the job's issue as people write it: #42 or ENG-123.
func (j Job) IssueRef() string {
	if j.Source == SourceLinear {
		return j.IssueKey
	}
	return fmt.Sprintf("#%d", j.Issue)
}

// CreateJob records an approved job and its run. The job's ID is also its
// run's ID, so evidence from the job is tied to the frozen inputs.
func (s *Store) CreateJob(ctx context.Context, j Job) error {
	if j.Source == "" {
		j.Source = SourceGitHub
	}
	switch {
	case j.Source == SourceGitHub && (j.Issue < 1 || j.IssueKey != ""),
		j.Source == SourceGitHub && j.IssueUID != "",
		j.Source == SourceLinear && (j.Issue != 0 || j.IssueKey == "" || j.IssueUID == ""),
		j.Source != SourceGitHub && j.Source != SourceLinear:
		return fmt.Errorf("postgres: job %s: source %q with issue %d and key %q", j.ID, j.Source, j.Issue, j.IssueKey)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: create job: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`INSERT INTO sf_jobs (id, repository, issue, base, base_branch, criteria_digest, suite_digest, runspec_digest, source, issue_key, issue_title, issue_uid)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
		j.ID, j.Repository, j.Issue, j.Base, j.BaseBranch, j.Inputs.CriteriaDigest, j.Inputs.SuiteDigest, j.Inputs.RunSpecDigest,
		j.Source, j.IssueKey, storableText(j.IssueTitle), j.IssueUID)
	if err != nil {
		return fmt.Errorf("postgres: create job: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: %s issue %s", ErrJobExists, j.Repository, j.IssueRef())
	}
	tag, err = tx.Exec(ctx,
		`INSERT INTO sf_runs (id, repository, criteria_digest, suite_digest, runspec_digest)
		 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
		j.ID, j.Repository, j.Inputs.CriteriaDigest, j.Inputs.SuiteDigest, j.Inputs.RunSpecDigest)
	if err != nil {
		return fmt.Errorf("postgres: record run: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: %s", ErrRunExists, j.ID)
	}
	return tx.Commit(ctx)
}

const jobColumns = `id, repository, issue, base, base_branch, criteria_digest, suite_digest, runspec_digest, state, reason, pull_request, claims, failures, last_error, publish_approved, source, issue_key, issue_title, issue_uid`

func scanJob(row pgx.Row) (Job, error) {
	var j Job
	err := row.Scan(&j.ID, &j.Repository, &j.Issue, &j.Base, &j.BaseBranch, &j.Inputs.CriteriaDigest, &j.Inputs.SuiteDigest,
		&j.Inputs.RunSpecDigest, &j.State, &j.Reason, &j.PullRequest, &j.Claims, &j.Failures, &j.LastError, &j.PublishApproved,
		&j.Source, &j.IssueKey, &j.IssueTitle, &j.IssueUID)
	j.Inputs.ID, j.Inputs.Repository = j.ID, j.Repository
	return j, err
}

// ClaimJob leases the oldest open job that no controller holds. It returns
// false when there is none.
func (s *Store) ClaimJob(ctx context.Context, owner string, lease time.Duration) (Job, bool, error) {
	if owner == "" || lease <= 0 {
		return Job{}, false, errors.New("postgres: an owner and a lease are required")
	}
	j, err := scanJob(s.pool.QueryRow(ctx,
		`UPDATE sf_jobs SET lease_owner = $1, lease_until = now() + $2 * interval '1 millisecond',
		        state = 'running', claims = claims + 1, updated_at = now()
		 WHERE id = (SELECT id FROM sf_jobs
		             WHERE state IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < now())
		             ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED)
		 RETURNING `+jobColumns, owner, lease.Milliseconds()))
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, fmt.Errorf("postgres: claim job: %w", err)
	}
	return j, true, nil
}

// RenewLease extends a held lease. It fails with ErrLeaseLost once the lease
// ran out or another controller took the job.
func (s *Store) RenewLease(ctx context.Context, jobID, owner string, lease time.Duration) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sf_jobs SET lease_until = now() + $3 * interval '1 millisecond'
		 WHERE id = $1 AND lease_owner = $2 AND lease_until > now() AND state = 'running'`,
		jobID, owner, lease.Milliseconds())
	if err != nil {
		return fmt.Errorf("postgres: renew lease: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// ReleaseLease gives a lease up so another controller can claim the job at
// once. It does nothing when the lease is not held.
func (s *Store) ReleaseLease(ctx context.Context, jobID, owner string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sf_jobs SET lease_owner = '', lease_until = NULL WHERE id = $1 AND lease_owner = $2`, jobID, owner)
	return err
}

// CheckLease reports ErrLeaseLost unless owner holds the job's lease now.
func (s *Store) CheckLease(ctx context.Context, jobID, owner string) error {
	var held bool
	if err := s.pool.QueryRow(ctx, `SELECT `+heldClause, jobID, owner).Scan(&held); err != nil {
		return fmt.Errorf("postgres: check lease: %w", err)
	}
	if !held {
		return ErrLeaseLost
	}
	return nil
}

// RecordFailure counts a run of the job that ended in an error. Below
// maxFailures the lease is given up and the job can be claimed again after
// backoff; at maxFailures, or when permanent is set, the job goes to a person
// with the error as the reason. It returns whether the job was finished.
func (s *Store) RecordFailure(ctx context.Context, jobID, owner, reason string, permanent bool, maxFailures int, backoff time.Duration) (bool, error) {
	reason = storableText(reason)
	var state string
	err := s.pool.QueryRow(ctx,
		`UPDATE sf_jobs SET failures = failures + 1, last_error = $3, updated_at = now(),
		        state = CASE WHEN $4 OR failures + 1 >= $5 THEN 'needs_owner' ELSE state END,
		        reason = CASE WHEN $4 OR failures + 1 >= $5 THEN $3 ELSE reason END,
		        lease_owner = '',
		        lease_until = CASE WHEN $4 OR failures + 1 >= $5 THEN NULL ELSE now() + $6 * interval '1 millisecond' END
		 WHERE id = $1 AND lease_owner = $2 AND state = 'running'
		 RETURNING state`, jobID, owner, reason, permanent, maxFailures, backoff.Milliseconds()).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrLeaseLost
	}
	if err != nil {
		return false, fmt.Errorf("postgres: record failure: %w", err)
	}
	return state == JobNeedsOwner, nil
}

// storableText makes text safe for a text column: valid UTF-8, no NUL, cut
// to 2000 bytes on a character boundary.
func storableText(s string) string {
	s = strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), "\uFFFD")
	if len(s) <= 2000 {
		return s
	}
	cut := 2000
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// heldClause guards every write a leaseholder makes.
const heldClause = `EXISTS (SELECT 1 FROM sf_jobs WHERE id = $1 AND lease_owner = $2 AND lease_until > now() AND state = 'running')`

// SetPullRequest records the pull request a job opened.
func (s *Store) SetPullRequest(ctx context.Context, jobID, owner string, number int) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sf_jobs SET pull_request = $3, updated_at = now() WHERE id = $1 AND `+heldClause, jobID, owner, number)
	if err != nil {
		return fmt.Errorf("postgres: record pull request: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// FinishJob moves a job to a final state, or to awaiting_publish, and gives
// up the lease.
func (s *Store) FinishJob(ctx context.Context, jobID, owner, state, reason string) error {
	if state != JobPassed && state != JobNeedsOwner && state != JobAwaitingPublish {
		return fmt.Errorf("postgres: %q is not a final state", state)
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE sf_jobs SET state = $3, reason = $4, lease_owner = '', lease_until = NULL, updated_at = now()
		 WHERE id = $1 AND `+heldClause, jobID, owner, state, storableText(reason))
	if err != nil {
		return fmt.Errorf("postgres: finish job: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// ErrWrongState is returned when a job is not in the state an operator
// action needs.
var ErrWrongState = errors.New("postgres: the job is not in a state that allows this")

// ApprovePublish records that a person approved pushing a job's passing
// change, and queues the job so a controller publishes it. Publishing gets
// its own claim and failure budget.
func (s *Store) ApprovePublish(ctx context.Context, jobID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sf_jobs SET publish_approved = true, state = 'queued', reason = '', claims = 0, failures = 0, last_error = '', updated_at = now()
		 WHERE id = $1 AND state = 'awaiting_publish'`, jobID)
	if err != nil {
		return fmt.Errorf("postgres: approve publishing: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: %s is not awaiting publishing", ErrWrongState, jobID)
	}
	return nil
}

// Requeue puts a job that went to a person because of errors back in the
// queue, with its failure and claim counts reset. Only a job that stopped
// because of errors qualifies (its reason is its last error); a job that
// reached a result, such as a failing holdout, stays with the person.
// Rounds, allowance and request cap are kept: nothing evaluated is
// evaluated again for free.
func (s *Store) Requeue(ctx context.Context, jobID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sf_jobs SET state = 'queued', reason = '', failures = 0, claims = 0, last_error = '', lease_owner = '', lease_until = NULL, updated_at = now()
		 WHERE id = $1 AND state = 'needs_owner' AND last_error <> '' AND reason = last_error`, jobID)
	if err != nil {
		return fmt.Errorf("postgres: requeue: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: %s did not stop because of an error", ErrWrongState, jobID)
	}
	return nil
}

// EvidenceCount counts the evidence rows of a run.
func (s *Store) EvidenceCount(ctx context.Context, runID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM sf_evidence WHERE run_id = $1`, runID).Scan(&n)
	return n, err
}

// GetJob returns one job.
func (s *Store) GetJob(ctx context.Context, jobID string) (Job, error) {
	j, err := scanJob(s.pool.QueryRow(ctx, `SELECT `+jobColumns+` FROM sf_jobs WHERE id = $1`, jobID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	return j, err
}

// Jobs lists every job, oldest first.
func (s *Store) Jobs(ctx context.Context) ([]Job, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+jobColumns+` FROM sf_jobs ORDER BY seq`)
	if err != nil {
		return nil, fmt.Errorf("postgres: list jobs: %w", err)
	}
	defer rows.Close()
	var out []Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// Feedback is one line of what went back to the builder.
type Feedback struct {
	Criterion string `json:"criterion"`
	Symptom   string `json:"symptom"`
}

// RoundRecord is what the store knows about one round of a job.
type RoundRecord struct {
	Number int
	// Attempts counts builder attempts; Requests the model requests they
	// reserved.
	Attempts int
	Requests int
	// The builder's change, once it was handed over.
	HasChange  bool
	Patch      []byte
	TestedTree string
	Summary    string
	ChangedAt  time.Time
	// PRTitle and PRBody describe the change for its pull request, as the
	// controller cleaned them. PRTitle is empty only for rounds stored
	// before builders wrote a description.
	PRTitle, PRBody string
	// The evaluation, once it was signed and stored.
	Commit         string
	EvidenceDigest string
	Outcome        string
	StopReason     string
	Feedback       []Feedback
}

// Finished reports whether the round reached a result.
func (r RoundRecord) Finished() bool { return r.Outcome != "" || r.StopReason != "" }

// StartRound returns round number of a job, creating it if needed. Creating
// it takes one evaluation from the allowance for the job's repository and
// criteria (at most evalLimit, ever) in the same transaction, so either the
// evaluation is taken and the round exists, or neither. A round that already
// exists is returned as it is, without taking anything again.
func (s *Store) StartRound(ctx context.Context, jobID, owner string, number, evalLimit int) (RoundRecord, error) {
	if evalLimit < 1 || number < 1 {
		return RoundRecord{}, errors.New("postgres: the round number and the evaluation limit must be positive")
	}
	tx, repository, criteria, err := s.lockHeldJob(ctx, jobID, owner)
	if err != nil {
		return RoundRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if r, err := readRound(ctx, tx, jobID, number); err == nil {
		return r, nil
	} else if !errors.Is(err, ErrNotFound) {
		return RoundRecord{}, err
	}
	var used int
	err = tx.QueryRow(ctx,
		`INSERT INTO sf_evaluations (repository, criteria_digest, used) VALUES ($1, $2, 1)
		 ON CONFLICT (repository, criteria_digest) DO UPDATE SET used = sf_evaluations.used + 1
		 WHERE sf_evaluations.used < $3
		 RETURNING used`, repository, criteria, evalLimit).Scan(&used)
	if errors.Is(err, pgx.ErrNoRows) {
		return RoundRecord{}, ErrAllowanceUsed
	}
	if err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: take evaluation: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sf_rounds (job_id, number) VALUES ($1, $2)`, jobID, number); err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: record round: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: start round: %w", err)
	}
	return RoundRecord{Number: number}, nil
}

// BeginAttempt reserves requests model requests for one builder attempt in
// a round, against requestCap for the job's repository and criteria across
// all jobs. It is called before the builder starts, so an attempt cut short
// by a crash is still counted. It refuses once maxAttempts attempts were made
// in the round, so a controller that keeps crashing cannot keep spending.
func (s *Store) BeginAttempt(ctx context.Context, jobID, owner string, number, requests, requestCap, maxAttempts int) (RoundRecord, error) {
	if requests < 1 || requestCap < requests || maxAttempts < 1 {
		return RoundRecord{}, errors.New("postgres: requests, cap and attempts must be positive, and the cap at least the requests")
	}
	tx, repository, criteria, err := s.lockHeldJob(ctx, jobID, owner)
	if err != nil {
		return RoundRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	r, err := readRound(ctx, tx, jobID, number)
	if err != nil {
		return RoundRecord{}, err
	}
	if r.HasChange || r.Finished() {
		return RoundRecord{}, errors.New("postgres: the round already has a change")
	}
	if r.Attempts >= maxAttempts {
		return RoundRecord{}, fmt.Errorf("%w: %d builder attempts in round %d", ErrAttemptsUsed, r.Attempts, number)
	}
	var reserved int
	err = tx.QueryRow(ctx,
		`INSERT INTO sf_spend (repository, criteria_digest, reserved) VALUES ($1, $2, $3)
		 ON CONFLICT (repository, criteria_digest) DO UPDATE SET reserved = sf_spend.reserved + $3
		 WHERE sf_spend.reserved + $3 <= $4
		 RETURNING reserved`, repository, criteria, requests, requestCap).Scan(&reserved)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && reserved > requestCap) {
		return RoundRecord{}, ErrRequestCapUsed
	}
	if err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: reserve requests: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE sf_rounds SET attempts = attempts + 1, requests = requests + $3
		WHERE job_id = $1 AND number = $2`, jobID, number, requests); err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: record attempt: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: begin attempt: %w", err)
	}
	r.Attempts++
	r.Requests += requests
	return r, nil
}

// lockHeldJob starts a transaction holding the job row, only for the
// controller that holds its lease.
func (s *Store) lockHeldJob(ctx context.Context, jobID, owner string) (pgx.Tx, string, string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, "", "", fmt.Errorf("postgres: begin: %w", err)
	}
	var repository, criteria string
	err = tx.QueryRow(ctx,
		`SELECT repository, criteria_digest FROM sf_jobs
		 WHERE id = $1 AND lease_owner = $2 AND lease_until > now() AND state = 'running' FOR UPDATE`,
		jobID, owner).Scan(&repository, &criteria)
	if err != nil {
		_ = tx.Rollback(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", "", ErrLeaseLost
		}
		return nil, "", "", fmt.Errorf("postgres: lock job: %w", err)
	}
	return tx, repository, criteria, nil
}

// Change is a builder's change as a round stores it.
type Change struct {
	Patch      []byte
	TestedTree string
	Summary    string
	// Title and Body describe the change for its pull request. The caller
	// cleans them; they are stored as given.
	Title, Body string
	At          time.Time
}

// SaveChange stores the builder's change for a round. A change already
// stored is kept, and the stored round is returned either way, so every
// controller that gets here goes on with the same change.
func (s *Store) SaveChange(ctx context.Context, jobID, owner string, number int, c Change) (RoundRecord, error) {
	patch := c.Patch
	if patch == nil {
		patch = []byte{}
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE sf_rounds SET patch = $4, tested_tree = $5, summary = $6, changed_at = $7, pr_title = $8, pr_body = $9
		 WHERE job_id = $1 AND number = $3 AND patch IS NULL AND `+heldClause,
		jobID, owner, number, patch, c.TestedTree, c.Summary, c.At.UTC().Truncate(time.Second), c.Title, c.Body); err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: store change: %w", err)
	}
	// A controller that lost its lease must not go on, even when the new
	// holder already stored the same round.
	if err := s.CheckLease(ctx, jobID, owner); err != nil {
		return RoundRecord{}, err
	}
	r, err := readRound(ctx, s.pool, jobID, number)
	if err != nil {
		return RoundRecord{}, err
	}
	if !r.HasChange {
		return RoundRecord{}, ErrLeaseLost
	}
	return r, nil
}

// RoundResult is how a round ended.
type RoundResult struct {
	Commit, EvidenceDigest, Outcome string
	// StopReason is set when a person must take over and nothing more is done.
	StopReason string
	Feedback   []Feedback
}

// SaveRoundResult stores how a round ended. A result already stored is kept.
func (s *Store) SaveRoundResult(ctx context.Context, jobID, owner string, number int, res RoundResult) (RoundRecord, error) {
	if res.Outcome == "" && res.StopReason == "" {
		return RoundRecord{}, errors.New("postgres: a round result needs an outcome or a stop reason")
	}
	feedback, err := json.Marshal(res.Feedback)
	if err != nil {
		return RoundRecord{}, err
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE sf_rounds SET commit_id = $4, evidence_digest = $5, outcome = $6, stop_reason = $7, feedback = $8
		 WHERE job_id = $1 AND number = $3 AND outcome = '' AND stop_reason = '' AND `+heldClause,
		jobID, owner, number, res.Commit, res.EvidenceDigest, res.Outcome, storableText(res.StopReason), feedback); err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: store round result: %w", err)
	}
	if err := s.CheckLease(ctx, jobID, owner); err != nil {
		return RoundRecord{}, err
	}
	r, err := readRound(ctx, s.pool, jobID, number)
	if err != nil {
		return RoundRecord{}, err
	}
	if !r.Finished() {
		return RoundRecord{}, ErrLeaseLost
	}
	return r, nil
}

// SaveRoundEvaluation stores a round's signed evidence and its result in one
// transaction, so a crash can never leave evidence whose round looks
// unevaluated (and so evaluated again, for free). A result already stored is
// kept.
func (s *Store) SaveRoundEvaluation(ctx context.Context, jobID, owner string, number int, e Evidence, res RoundResult) (RoundRecord, error) {
	if res.Outcome == "" {
		return RoundRecord{}, errors.New("postgres: an evaluated round needs an outcome")
	}
	feedback, err := json.Marshal(res.Feedback)
	if err != nil {
		return RoundRecord{}, err
	}
	tx, _, _, err := s.lockHeldJob(ctx, jobID, owner)
	if err != nil {
		return RoundRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	check := e.Check
	if check == "" {
		check = RunBuilder
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO sf_evidence (digest, run_id, round, repository, image_digest, digest_kind,
			criteria_digest, suite_digest, runspec_digest, purpose, outcome, review_required, envelope, check_kind)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (digest) DO NOTHING`,
		e.Digest, e.RunID, e.Round, e.Repository, e.ImageDigest, e.DigestKind,
		e.CriteriaDigest, e.SuiteDigest, e.RunSpecDigest, e.Purpose, e.Outcome, e.ReviewRequired, e.Envelope, check); err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: store evidence: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE sf_rounds SET commit_id = $3, evidence_digest = $4, outcome = $5, feedback = $6
		 WHERE job_id = $1 AND number = $2 AND outcome = '' AND stop_reason = ''`,
		jobID, number, res.Commit, res.EvidenceDigest, res.Outcome, feedback); err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: store round result: %w", err)
	}
	r, err := readRound(ctx, tx, jobID, number)
	if err != nil {
		return RoundRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RoundRecord{}, fmt.Errorf("postgres: store round evaluation: %w", err)
	}
	return r, nil
}

// Rounds returns a job's rounds in order.
func (s *Store) Rounds(ctx context.Context, jobID string) ([]RoundRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+roundColumns+` FROM sf_rounds WHERE job_id = $1 ORDER BY number`, jobID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list rounds: %w", err)
	}
	defer rows.Close()
	var out []RoundRecord
	for rows.Next() {
		r, err := scanRound(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Spend returns the model requests reserved for a repository and criteria.
func (s *Store) Spend(ctx context.Context, repository, criteriaDigest string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT reserved FROM sf_spend WHERE repository = $1 AND criteria_digest = $2`,
		repository, criteriaDigest).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

// EvaluationsUsed returns how much of the evaluation allowance is used.
func (s *Store) EvaluationsUsed(ctx context.Context, repository, criteriaDigest string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT used FROM sf_evaluations WHERE repository = $1 AND criteria_digest = $2`,
		repository, criteriaDigest).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

const roundColumns = `number, attempts, requests, patch, tested_tree, summary, changed_at, commit_id, evidence_digest, outcome, stop_reason, feedback, pr_title, pr_body`

type queryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func readRound(ctx context.Context, q queryRower, jobID string, number int) (RoundRecord, error) {
	r, err := scanRound(q.QueryRow(ctx, `SELECT `+roundColumns+` FROM sf_rounds WHERE job_id = $1 AND number = $2`, jobID, number))
	if errors.Is(err, pgx.ErrNoRows) {
		return RoundRecord{}, ErrNotFound
	}
	return r, err
}

func scanRound(row pgx.Row) (RoundRecord, error) {
	var r RoundRecord
	var changedAt *time.Time
	var feedback []byte
	if err := row.Scan(&r.Number, &r.Attempts, &r.Requests, &r.Patch, &r.TestedTree, &r.Summary, &changedAt, &r.Commit,
		&r.EvidenceDigest, &r.Outcome, &r.StopReason, &feedback, &r.PRTitle, &r.PRBody); err != nil {
		return RoundRecord{}, err
	}
	r.HasChange = r.Patch != nil
	if changedAt != nil {
		r.ChangedAt = changedAt.UTC()
	}
	if len(feedback) > 0 {
		if err := json.Unmarshal(feedback, &r.Feedback); err != nil {
			return RoundRecord{}, fmt.Errorf("postgres: round feedback: %w", err)
		}
	}
	return r, nil
}

// OpenJobs counts jobs that are queued or running, held or not.
func (s *Store) OpenJobs(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM sf_jobs WHERE state IN ('queued', 'running')`).Scan(&n)
	return n, err
}

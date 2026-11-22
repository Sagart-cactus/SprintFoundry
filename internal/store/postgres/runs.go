package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrNotFound is returned when a record does not exist.
var ErrNotFound = errors.New("postgres: not found")

// PutInput stores a frozen input and returns its digest. Storing the same
// content again is a no-op: inputs are addressed by what they contain and can
// never be changed in place.
func (s *Store) PutInput(ctx context.Context, kind string, content []byte) (string, error) {
	sum := sha256.Sum256(content)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sf_inputs (digest, kind, content) VALUES ($1, $2, $3) ON CONFLICT (digest) DO NOTHING`,
		digest, kind, content)
	if err != nil {
		return "", fmt.Errorf("postgres: store input: %w", err)
	}
	return digest, nil
}

// PutInputAs stores a frozen input under a digest computed by the caller,
// for inputs whose digest is taken over a canonical form.
func (s *Store) PutInputAs(ctx context.Context, kind, digest string, content []byte) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sf_inputs (digest, kind, content) VALUES ($1, $2, $3) ON CONFLICT (digest) DO NOTHING`,
		digest, kind, content)
	if err != nil {
		return fmt.Errorf("postgres: store input: %w", err)
	}
	return nil
}

// GetInput returns a frozen input.
func (s *Store) GetInput(ctx context.Context, digest string) ([]byte, error) {
	var content []byte
	err := s.pool.QueryRow(ctx, `SELECT content FROM sf_inputs WHERE digest = $1`, digest).Scan(&content)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return content, err
}

// Run identifies one run and the frozen inputs it is bound to.
type Run struct {
	ID             string
	Repository     string
	CriteriaDigest string
	SuiteDigest    string
	RunSpecDigest  string
}

// ErrRunExists is returned when a run ID is used a second time.
var ErrRunExists = errors.New("postgres: a run with this ID already exists")

// BeginRun records a run. A run ID can be used once: a second run with the
// same ID is an error, never a silent no-op.
//
// Beginning a run is what supersedes older evidence: from now on, evidence
// from any earlier run for the same repository and criteria can no longer
// back a release. See LatestEvidence.
func (s *Store) BeginRun(ctx context.Context, r Run) error {
	tag, err := s.pool.Exec(ctx,
		`INSERT INTO sf_runs (id, repository, criteria_digest, suite_digest, runspec_digest)
		 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
		r.ID, r.Repository, r.CriteriaDigest, r.SuiteDigest, r.RunSpecDigest)
	if err != nil {
		return fmt.Errorf("postgres: record run: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: %s", ErrRunExists, r.ID)
	}
	return nil
}

// Evidence is one stored evaluation.
type Evidence struct {
	Digest           string
	RunID            string
	Round            int
	Repository       string
	ImageDigest      string
	DigestKind       string
	CriteriaDigest   string
	SuiteDigest      string
	RunSpecDigest    string
	Purpose          string
	Outcome          string
	ReviewRequired   string
	ReviewApprovedBy string
	Envelope         []byte
	CreatedAt        time.Time
	Superseded       bool
}

// PutEvidence stores a signed evidence statement.
func (s *Store) PutEvidence(ctx context.Context, e Evidence) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sf_evidence (digest, run_id, round, repository, image_digest, digest_kind,
			criteria_digest, suite_digest, runspec_digest, purpose, outcome, review_required, envelope)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (digest) DO NOTHING`,
		e.Digest, e.RunID, e.Round, e.Repository, e.ImageDigest, e.DigestKind,
		e.CriteriaDigest, e.SuiteDigest, e.RunSpecDigest, e.Purpose, e.Outcome, e.ReviewRequired, e.Envelope)
	if err != nil {
		return fmt.Errorf("postgres: store evidence: %w", err)
	}
	return nil
}

// LatestEvidence returns the newest evidence for an image in a repository.
//
// Superseded is worked out here, not stored: evidence is superseded when a
// run that began after its own run exists for the same repository and
// criteria. That holds whenever the evidence was written, so a slow older
// run cannot slip a result in after a newer run has started.
func (s *Store) LatestEvidence(ctx context.Context, repository, imageDigest string) (Evidence, error) {
	var e Evidence
	err := s.pool.QueryRow(ctx,
		`SELECT e.digest, e.run_id, e.round, e.repository, e.image_digest, e.digest_kind, e.criteria_digest,
			e.suite_digest, e.runspec_digest, e.purpose, e.outcome, e.review_required, e.review_approved_by,
			e.envelope, e.created_at,
			EXISTS (SELECT 1 FROM sf_runs newer
			        WHERE newer.repository = mine.repository
			          AND newer.criteria_digest = mine.criteria_digest
			          AND newer.seq > mine.seq)
		 FROM sf_evidence e JOIN sf_runs mine ON mine.id = e.run_id
		 WHERE e.repository = $1 AND e.image_digest = $2
		 ORDER BY e.seq DESC LIMIT 1`, repository, imageDigest).
		Scan(&e.Digest, &e.RunID, &e.Round, &e.Repository, &e.ImageDigest, &e.DigestKind, &e.CriteriaDigest,
			&e.SuiteDigest, &e.RunSpecDigest, &e.Purpose, &e.Outcome, &e.ReviewRequired, &e.ReviewApprovedBy,
			&e.Envelope, &e.CreatedAt, &e.Superseded)
	if errors.Is(err, pgx.ErrNoRows) {
		return Evidence{}, ErrNotFound
	}
	if err != nil {
		return Evidence{}, fmt.Errorf("postgres: read evidence: %w", err)
	}
	return e, nil
}

// ApproveReview records that a person looked at evidence that was flagged for
// review. It does not change the evidence itself.
func (s *Store) ApproveReview(ctx context.Context, evidenceDigest, approver string) error {
	if approver == "" {
		return errors.New("postgres: an approver is required")
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE sf_evidence SET review_approved_by = $2 WHERE digest = $1 AND review_required <> ''`,
		evidenceDigest, approver)
	if err != nil {
		return fmt.Errorf("postgres: approve review: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// PutDecision stores a signed release decision.
func (s *Store) PutDecision(ctx context.Context, digest, evidenceDigest string, envelope []byte) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sf_decisions (digest, evidence_digest, envelope) VALUES ($1, $2, $3) ON CONFLICT (digest) DO NOTHING`,
		digest, evidenceDigest, envelope)
	if err != nil {
		return fmt.Errorf("postgres: store decision: %w", err)
	}
	return nil
}

// TakeEvaluation uses one evaluation from the allowance of a repository and
// criteria digest. It returns false, and uses nothing, when limit evaluations
// have already been taken. The count never resets: a new run for the same
// criteria draws on the same allowance.
func (s *Store) TakeEvaluation(ctx context.Context, repository, criteriaDigest string, limit int) (bool, error) {
	if limit < 1 {
		return false, errors.New("postgres: evaluation limit must be at least 1")
	}
	var used int
	err := s.pool.QueryRow(ctx,
		`INSERT INTO sf_evaluations (repository, criteria_digest, used) VALUES ($1, $2, 1)
		 ON CONFLICT (repository, criteria_digest) DO UPDATE SET used = sf_evaluations.used + 1
		 WHERE sf_evaluations.used < $3
		 RETURNING used`, repository, criteriaDigest, limit).Scan(&used)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("postgres: take evaluation: %w", err)
	}
	return true, nil
}

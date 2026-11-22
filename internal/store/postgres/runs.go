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

// BeginRun records a run and supersedes the evidence of earlier runs for the
// same repository and criteria: once a new attempt starts, an older result
// can no longer back a release.
func (s *Store) BeginRun(ctx context.Context, r Run) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`INSERT INTO sf_runs (id, repository, criteria_digest, suite_digest, runspec_digest)
			 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
			r.ID, r.Repository, r.CriteriaDigest, r.SuiteDigest, r.RunSpecDigest)
		if err != nil {
			return fmt.Errorf("postgres: record run: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return nil // the run was already begun; do not supersede again
		}
		_, err = tx.Exec(ctx,
			`UPDATE sf_evidence SET superseded_at = now()
			 WHERE repository = $1 AND criteria_digest = $2 AND run_id <> $3 AND superseded_at IS NULL`,
			r.Repository, r.CriteriaDigest, r.ID)
		if err != nil {
			return fmt.Errorf("postgres: supersede older evidence: %w", err)
		}
		return nil
	})
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
func (s *Store) LatestEvidence(ctx context.Context, repository, imageDigest string) (Evidence, error) {
	var e Evidence
	var superseded *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT digest, run_id, round, repository, image_digest, digest_kind, criteria_digest, suite_digest,
			runspec_digest, purpose, outcome, review_required, review_approved_by, envelope, created_at, superseded_at
		 FROM sf_evidence WHERE repository = $1 AND image_digest = $2
		 ORDER BY created_at DESC, digest LIMIT 1`, repository, imageDigest).
		Scan(&e.Digest, &e.RunID, &e.Round, &e.Repository, &e.ImageDigest, &e.DigestKind, &e.CriteriaDigest,
			&e.SuiteDigest, &e.RunSpecDigest, &e.Purpose, &e.Outcome, &e.ReviewRequired, &e.ReviewApprovedBy,
			&e.Envelope, &e.CreatedAt, &superseded)
	if errors.Is(err, pgx.ErrNoRows) {
		return Evidence{}, ErrNotFound
	}
	if err != nil {
		return Evidence{}, fmt.Errorf("postgres: read evidence: %w", err)
	}
	e.Superseded = superseded != nil
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

// AddRepairRound counts one repair round for a criteria digest and returns
// the new total.
func (s *Store) AddRepairRound(ctx context.Context, repository, criteriaDigest string) (int, error) {
	var rounds int
	err := s.pool.QueryRow(ctx,
		`INSERT INTO sf_repair_rounds (repository, criteria_digest, rounds) VALUES ($1, $2, 1)
		 ON CONFLICT (repository, criteria_digest) DO UPDATE SET rounds = sf_repair_rounds.rounds + 1
		 RETURNING rounds`, repository, criteriaDigest).Scan(&rounds)
	if err != nil {
		return 0, fmt.Errorf("postgres: count repair round: %w", err)
	}
	return rounds, nil
}

// RepairRounds returns how many repair rounds a criteria digest has used.
func (s *Store) RepairRounds(ctx context.Context, repository, criteriaDigest string) (int, error) {
	var rounds int
	err := s.pool.QueryRow(ctx,
		`SELECT rounds FROM sf_repair_rounds WHERE repository = $1 AND criteria_digest = $2`,
		repository, criteriaDigest).Scan(&rounds)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return rounds, err
}

package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Registration is the set of inputs an operator registered for a repository.
type Registration struct {
	Repository                                 string
	CriteriaDigest, SuiteDigest, RunSpecDigest string
	// Branch is the branch pull requests must target and release checks
	// must be on. Empty means the repository's default branch.
	Branch string
}

// Register stores or replaces a repository's inputs. The inputs must already
// be stored with PutInput or PutInputAs.
func (s *Store) Register(ctx context.Context, r Registration) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sf_registrations (repository, criteria_digest, suite_digest, runspec_digest, branch)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (repository) DO UPDATE SET criteria_digest = $2, suite_digest = $3, runspec_digest = $4, branch = $5, registered_at = now()`,
		r.Repository, r.CriteriaDigest, r.SuiteDigest, r.RunSpecDigest, r.Branch)
	if err != nil {
		return fmt.Errorf("postgres: register %s: %w", r.Repository, err)
	}
	return nil
}

// Registered returns a repository's registered inputs.
func (s *Store) Registered(ctx context.Context, repository string) (Registration, error) {
	r := Registration{Repository: repository}
	err := s.pool.QueryRow(ctx,
		`SELECT criteria_digest, suite_digest, runspec_digest, branch FROM sf_registrations WHERE repository = $1`, repository).
		Scan(&r.CriteriaDigest, &r.SuiteDigest, &r.RunSpecDigest, &r.Branch)
	if errors.Is(err, pgx.ErrNoRows) {
		return Registration{}, ErrNotFound
	}
	return r, err
}

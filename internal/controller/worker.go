package controller

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/sagart-cactus/sprintfoundry/internal/store/postgres"
)

// WorkerStore is what a worker needs from the store.
type WorkerStore interface {
	ClaimJob(ctx context.Context, owner string, lease time.Duration) (postgres.Job, bool, error)
	RenewLease(ctx context.Context, jobID, owner string, lease time.Duration) error
	OpenJobs(ctx context.Context) (int, error)
	RecordFailure(ctx context.Context, jobID, owner, reason string, permanent bool, maxFailures int, backoff time.Duration) (bool, error)
	FinishJob(ctx context.Context, jobID, owner, state, reason string) error
	ReleaseLease(ctx context.Context, jobID, owner string) error
}

// Default limits for a job that cannot finish.
const (
	DefaultMaxFailures = 3
	DefaultMaxClaims   = 10
)

// Worker runs approved jobs, at most Concurrency at a time. Several workers,
// in one process or many, can share a database: each job is leased by one
// of them, and a job whose lease runs out (its controller died) is taken up
// by another, from where the store says it was.
//
// A job that cannot finish does not come back forever: a run that ends in an
// error is counted, and after MaxFailures of them (at once for an error
// marked ErrPermanent) the job goes to a person. A job taken up MaxClaims
// times without finishing, because the controller keeps dying on it, does too.
type Worker struct {
	Store WorkerStore
	// Owner names this worker's leases. It must differ between workers.
	Owner string
	// Lease is how long a job stays with this worker without a renewal; the
	// worker renews it every Lease/3 while the job runs.
	Lease       time.Duration
	Concurrency int
	// Poll is how long the worker waits before looking for work again.
	Poll time.Duration
	// MaxFailures and MaxClaims default to DefaultMaxFailures and
	// DefaultMaxClaims. Backoff is how long a failed job waits before it can
	// be claimed again; it defaults to Lease.
	MaxFailures, MaxClaims int
	Backoff                time.Duration
	// Prepare returns everything one job needs: its store directory, its
	// forge, its builder and its limits.
	Prepare func(ctx context.Context, job postgres.Job, owner string) (JobDeps, JobSettings, error)
	Log     func(format string, args ...any)
}

// RunUntilIdle runs jobs until no job is open any more, including jobs
// leased by a controller that died, which it takes up once their lease runs
// out. A job that ends with a person is a result, not an error; the error is
// only for the worker itself failing, for example the database.
func (w *Worker) RunUntilIdle(ctx context.Context) error {
	return w.loop(ctx, true)
}

// Serve runs jobs until ctx ends.
func (w *Worker) Serve(ctx context.Context) error {
	err := w.loop(ctx, false)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (w *Worker) loop(ctx context.Context, untilIdle bool) error {
	if w.Owner == "" || w.Lease <= 0 || w.Prepare == nil {
		return errors.New("controller: a worker needs an owner, a lease and a Prepare function")
	}
	logf := w.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	concurrency := max(w.Concurrency, 1)
	poll := w.Poll
	if poll <= 0 {
		poll = w.Lease / 3
	}
	maxFailures, maxClaims, backoff := w.MaxFailures, w.MaxClaims, w.Backoff
	if maxFailures <= 0 {
		maxFailures = DefaultMaxFailures
	}
	if maxClaims <= 0 {
		maxClaims = DefaultMaxClaims
	}
	if backoff <= 0 {
		backoff = w.Lease
	}

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		claims  int
		running int
		// done wakes the loop when a job ends. A send never blocks: when the
		// loop is not listening it polls anyway.
		done = make(chan struct{}, 1)
	)
	defer wg.Wait()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		mu.Lock()
		free := running < concurrency
		mu.Unlock()
		claimed := false
		if free {
			// Every claim has its own owner, so a job this worker let lapse
			// and claimed again is never held by two of its goroutines.
			claims++
			owner := fmt.Sprintf("%s#%d", w.Owner, claims)
			job, ok, err := w.Store.ClaimJob(ctx, owner, w.Lease)
			switch {
			case err != nil && untilIdle:
				return err
			case err != nil:
				logf("Could not look for jobs: %v", err)
			case ok && job.Claims > maxClaims:
				reason := fmt.Sprintf("the job was taken up %d times without finishing; the controller may be crashing on it (last error: %s)", job.Claims-1, job.LastError)
				if err := w.Store.FinishJob(ctx, job.ID, owner, postgres.JobNeedsOwner, reason); err != nil {
					logf("Job %s: %v", job.ID, err)
				}
				claimed = true
			case ok:
				claimed = true
				mu.Lock()
				running++
				mu.Unlock()
				wg.Add(1)
				go func() {
					defer wg.Done()
					err := w.runOne(ctx, job, owner)
					if err != nil && !errors.Is(err, postgres.ErrLeaseLost) && ctx.Err() == nil {
						finished, ferr := w.Store.RecordFailure(context.WithoutCancel(ctx), job.ID, owner, err.Error(),
							errors.Is(err, ErrPermanent), maxFailures, backoff)
						switch {
						case ferr != nil:
							logf("Job %s stopped: %v (and the failure could not be recorded: %v)", job.ID, err, ferr)
						case finished:
							logf("Job %s needs a person: %v", job.ID, err)
						default:
							logf("Job %s stopped: %v (it is tried again in %s)", job.ID, err, backoff)
						}
					} else if err != nil {
						logf("Job %s stopped: %v", job.ID, err)
					}
					mu.Lock()
					running--
					mu.Unlock()
					select {
					case done <- struct{}{}:
					default:
					}
				}()
			}
		}
		if claimed {
			continue
		}
		mu.Lock()
		idle := running == 0
		mu.Unlock()
		if untilIdle && idle {
			open, err := w.Store.OpenJobs(ctx)
			if err != nil {
				return err
			}
			if open == 0 {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
		case <-time.After(poll):
		}
	}
}

// runOne runs one leased job, renewing the lease while it runs. Losing the
// lease cancels the job's work.
func (w *Worker) runOne(parent context.Context, job postgres.Job, owner string) (err error) {
	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)
	// Stopped on purpose (Ctrl-C): give the job back at once instead of
	// leaving it until the lease runs out.
	defer func() {
		if parent.Err() != nil {
			_ = w.Store.ReleaseLease(context.WithoutCancel(parent), job.ID, owner)
		}
	}()
	lost := func(err error) error {
		if cause := context.Cause(ctx); cause != nil && errors.Is(cause, postgres.ErrLeaseLost) {
			return cause
		}
		return err
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		t := time.NewTicker(w.Lease / 3)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				// Only a lease that is really gone stops the job. A failed
				// renewal (the database was briefly unreachable) is tried
				// again on the next tick; the lease lasts three of them.
				if err := w.Store.RenewLease(ctx, job.ID, owner, w.Lease); errors.Is(err, postgres.ErrLeaseLost) {
					cancel(err)
					return
				}
			}
		}
	}()
	deps, settings, err := w.Prepare(ctx, job, owner)
	if err != nil {
		return lost(err)
	}
	deps.Owner = owner
	_, err = RunJob(ctx, deps, job, settings)
	return lost(err)
}

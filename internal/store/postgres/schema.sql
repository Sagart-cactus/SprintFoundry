-- SprintFoundry controller schema. Every statement must be safe to run again.

CREATE TABLE IF NOT EXISTS sf_effects (
    key          text        PRIMARY KEY,
    kind         text        NOT NULL,
    done         boolean     NOT NULL DEFAULT false,
    result       bytea,
    created_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS sf_effects_open ON sf_effects (key) WHERE NOT done;

-- Frozen inputs (criteria, check suite, run spec), addressed by their digest.
CREATE TABLE IF NOT EXISTS sf_inputs (
    digest     text        PRIMARY KEY,
    kind       text        NOT NULL,
    content    bytea       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sf_runs (
    id              text        PRIMARY KEY,
    seq             bigserial   NOT NULL,
    repository      text        NOT NULL,
    criteria_digest text        NOT NULL REFERENCES sf_inputs (digest),
    suite_digest    text        NOT NULL REFERENCES sf_inputs (digest),
    runspec_digest  text        NOT NULL REFERENCES sf_inputs (digest),
    created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sf_runs ADD COLUMN IF NOT EXISTS seq bigserial NOT NULL;
-- builder, pull-request or release. Pull request checks supersede nothing.
ALTER TABLE sf_runs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'builder';

CREATE INDEX IF NOT EXISTS sf_runs_by_criteria ON sf_runs (repository, criteria_digest, seq);

-- One row per evaluation. Evidence is superseded once a newer run exists for
-- the same repository and criteria. That is worked out when evidence is read,
-- so it also covers evidence an older run stores after a newer run began.
CREATE TABLE IF NOT EXISTS sf_evidence (
    digest          text        PRIMARY KEY,
    seq             bigserial   NOT NULL,
    run_id          text        NOT NULL REFERENCES sf_runs (id),
    round           integer     NOT NULL,
    repository      text        NOT NULL,
    image_digest    text        NOT NULL,
    digest_kind     text        NOT NULL,
    criteria_digest text        NOT NULL,
    suite_digest    text        NOT NULL,
    runspec_digest  text        NOT NULL,
    purpose         text        NOT NULL,
    outcome         text        NOT NULL,
    review_required text        NOT NULL DEFAULT '',
    review_approved_by text     NOT NULL DEFAULT '',
    envelope        bytea       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sf_evidence ADD COLUMN IF NOT EXISTS seq bigserial NOT NULL;
ALTER TABLE sf_evidence ADD COLUMN IF NOT EXISTS check_kind text NOT NULL DEFAULT 'builder';

CREATE INDEX IF NOT EXISTS sf_evidence_by_image ON sf_evidence (repository, image_digest, seq DESC);

CREATE TABLE IF NOT EXISTS sf_decisions (
    digest          text        PRIMARY KEY,
    evidence_digest text        NOT NULL REFERENCES sf_evidence (digest),
    envelope        bytea       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Evaluations are counted per repository and criteria digest, not per run, so
-- a builder cannot learn the suite, or retry until it passes by luck, by
-- starting new runs.
CREATE TABLE IF NOT EXISTS sf_evaluations (
    repository      text    NOT NULL,
    criteria_digest text    NOT NULL,
    used            integer NOT NULL DEFAULT 0,
    PRIMARY KEY (repository, criteria_digest)
);

-- Inputs registered for a repository by its operator. Pull request checks
-- use these; nothing in the repository itself can change them.
CREATE TABLE IF NOT EXISTS sf_registrations (
    repository      text        PRIMARY KEY,
    criteria_digest text        NOT NULL REFERENCES sf_inputs (digest),
    suite_digest    text        NOT NULL REFERENCES sf_inputs (digest),
    runspec_digest  text        NOT NULL REFERENCES sf_inputs (digest),
    registered_at   timestamptz NOT NULL DEFAULT now()
);
-- The branch pull requests must target and release checks must be on.
-- Empty means the repository's default branch.
ALTER TABLE sf_registrations ADD COLUMN IF NOT EXISTS branch text NOT NULL DEFAULT '';

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
    repository      text        NOT NULL,
    criteria_digest text        NOT NULL REFERENCES sf_inputs (digest),
    suite_digest    text        NOT NULL REFERENCES sf_inputs (digest),
    runspec_digest  text        NOT NULL REFERENCES sf_inputs (digest),
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per evaluation. A row is superseded when a newer run starts for the
-- same repository and criteria.
CREATE TABLE IF NOT EXISTS sf_evidence (
    digest          text        PRIMARY KEY,
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
    created_at      timestamptz NOT NULL DEFAULT now(),
    superseded_at   timestamptz
);

CREATE INDEX IF NOT EXISTS sf_evidence_by_image ON sf_evidence (repository, image_digest, created_at DESC);

CREATE TABLE IF NOT EXISTS sf_decisions (
    digest          text        PRIMARY KEY,
    evidence_digest text        NOT NULL REFERENCES sf_evidence (digest),
    envelope        bytea       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Repair rounds are counted per criteria digest, not per run, so a builder
-- cannot learn the suite by starting new runs.
CREATE TABLE IF NOT EXISTS sf_repair_rounds (
    repository      text    NOT NULL,
    criteria_digest text    NOT NULL,
    rounds          integer NOT NULL DEFAULT 0,
    PRIMARY KEY (repository, criteria_digest)
);

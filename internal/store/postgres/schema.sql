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

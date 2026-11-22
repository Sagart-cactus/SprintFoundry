// Package local sets SprintFoundry up on one machine: a home directory with
// the controller's own files, the demo signing key, and a Postgres container
// that only this machine can reach.
package local

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
)

const (
	// PostgresImage is the database image, pinned by digest. To update it,
	// read the digest of docker.io/library/postgres:17-alpine and replace it.
	PostgresImage = "docker.io/library/postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73"

	database = "sprintfoundry"

	// ImageLabel marks every image SprintFoundry builds, so that they can be
	// pruned together.
	ImageLabel = "sprintfoundry.component"
)

// names returns the database container and volume names for this home. They
// include a short hash of the home's path, so two homes on one machine never
// share a database that only one of them has the password for.
func (h Home) names() (containerName, volumeName string) {
	abs, err := filepath.Abs(h.Dir)
	if err != nil {
		abs = h.Dir
	}
	sum := sha256.Sum256([]byte(abs))
	suffix := hex.EncodeToString(sum[:])[:8]
	return "sprintfoundry-postgres-" + suffix, "sprintfoundry-pgdata-" + suffix
}

// Home is the controller's directory on this machine.
type Home struct {
	Dir string
}

// DefaultHome returns $SPRINTFOUNDRY_HOME, or .sprintfoundry in the user's
// home directory.
func DefaultHome() (Home, error) {
	if dir := os.Getenv("SPRINTFOUNDRY_HOME"); dir != "" {
		return Home{Dir: dir}, nil
	}
	base, err := os.UserHomeDir()
	if err != nil {
		return Home{}, fmt.Errorf("local: cannot find a home directory: %w", err)
	}
	return Home{Dir: filepath.Join(base, ".sprintfoundry")}, nil
}

// Path joins names under the home directory.
func (h Home) Path(names ...string) string {
	return filepath.Join(append([]string{h.Dir}, names...)...)
}

func (h Home) ensure() error {
	return os.MkdirAll(h.Dir, 0o700)
}

// DemoSigner loads the demo signing key, creating it on first use. The key
// file is readable by the current user only and never leaves this directory.
func (h Home) DemoSigner() (*signer.Demo, error) {
	if err := h.ensure(); err != nil {
		return nil, err
	}
	path := h.Path("demo-signer.seed")
	if seedHex, err := os.ReadFile(path); err == nil {
		seed, err := hex.DecodeString(string(seedHex))
		if err != nil {
			return nil, fmt.Errorf("local: %s is not a signer seed", path)
		}
		return signer.DemoFromSeed(seed)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	sgn, err := signer.NewDemo()
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(sgn.Seed())), 0o600); err != nil {
		return nil, fmt.Errorf("local: store signer seed: %w", err)
	}
	return sgn, nil
}

type postgresConfig struct {
	Port     int    `json:"port"`
	Password string `json:"password"`
}

// Postgres makes sure the local database is running and returns its
// connection URL. The database listens on 127.0.0.1 only, with a password
// generated on first use and stored in the home directory.
func (h Home) Postgres(ctx context.Context, cli container.CLI) (string, error) {
	if err := h.ensure(); err != nil {
		return "", err
	}
	path := h.Path("postgres.json")
	var cfg postgresConfig
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &cfg); err != nil || cfg.Port == 0 || cfg.Password == "" {
			return "", fmt.Errorf("local: %s is not a database configuration", path)
		}
	case errors.Is(err, os.ErrNotExist):
		if cfg.Port, err = freePort(); err != nil {
			return "", err
		}
		secret := make([]byte, 24)
		if _, err := rand.Read(secret); err != nil {
			return "", err
		}
		cfg.Password = hex.EncodeToString(secret)
		raw, _ = json.Marshal(cfg)
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			return "", fmt.Errorf("local: store database configuration: %w", err)
		}
	default:
		return "", err
	}

	postgresContainer, postgresVolume := h.names()
	exists, err := cli.Exists(ctx, postgresContainer)
	if err != nil {
		return "", err
	}
	running, _ := cli.Running(ctx, postgresContainer)
	switch {
	case !exists:
		err = cli.RunService(ctx, container.ServiceOptions{
			Name: postgresContainer, Image: PostgresImage,
			Env:      map[string]string{"POSTGRES_PASSWORD": cfg.Password, "POSTGRES_DB": database},
			HostPort: cfg.Port, ContainerPort: 5432,
			Volume: postgresVolume, MountPath: "/var/lib/postgresql/data",
			Labels: map[string]string{"sprintfoundry.component": "postgres"},
		})
	case !running:
		err = cli.Start(ctx, postgresContainer)
	}
	if err != nil {
		return "", fmt.Errorf("local: start database: %w", err)
	}

	url := fmt.Sprintf("postgres://postgres:%s@127.0.0.1:%d/%s", cfg.Password, cfg.Port, database)
	deadline := time.Now().Add(90 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		attempt, cancel := context.WithTimeout(ctx, 3*time.Second)
		conn, err := pgx.Connect(attempt, url)
		if err == nil {
			err = conn.Ping(attempt)
			_ = conn.Close(attempt)
		}
		cancel()
		if err == nil {
			return url, nil
		}
		last = err
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return "", fmt.Errorf("local: database did not become ready: %v", last)
}

// Down stops and removes the local database container. With purge it also
// deletes the data volume, the stored password and the images SprintFoundry
// built that are no longer in use, so the next start is fresh.
func (h Home) Down(ctx context.Context, cli container.CLI, purge bool) error {
	postgresContainer, postgresVolume := h.names()
	if err := cli.Remove(ctx, postgresContainer); err != nil {
		return err
	}
	if !purge {
		return nil
	}
	if err := cli.VolumeRemove(ctx, postgresVolume); err != nil {
		return err
	}
	// Candidate and runner images that no container uses any more.
	if err := cli.PruneImages(ctx, ImageLabel); err != nil {
		return err
	}
	if err := os.Remove(h.Path("postgres.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("local: find a free port: %w", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

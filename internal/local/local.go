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
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/sagart-cactus/sprintfoundry/internal/container"
	"github.com/sagart-cactus/sprintfoundry/internal/signer"
)

const (
	// PostgresImage is the database image, pinned by digest. To update it,
	// read the digest of docker.io/library/postgres:17-alpine and replace it.
	PostgresImage = "docker.io/library/postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73"

	database = "sprintfoundry"

	// homeLabel marks everything this home starts or builds in the container
	// runtime, so that it can be found and removed together and so that one
	// home never cleans up after another.
	homeLabel = "sprintfoundry.home"
)

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

// id is a short hash of the home's path.
func (h Home) id() string {
	abs, err := filepath.Abs(h.Dir)
	if err != nil {
		abs = h.Dir
	}
	sum := sha256.Sum256([]byte(abs))
	return hex.EncodeToString(sum[:])[:8]
}

// Labels returns the labels for everything this home starts or builds.
func (h Home) Labels() map[string]string {
	return map[string]string{homeLabel: h.id()}
}

func (h Home) labelFilter() string { return homeLabel + "=" + h.id() }

// names returns the database container and volume names for this home. They
// include the home's ID, so two homes on one machine never share a database
// that only one of them has the password for.
func (h Home) names() (containerName, volumeName string) {
	return "sprintfoundry-postgres-" + h.id(), "sprintfoundry-pgdata-" + h.id()
}

// secretFile returns the content of a file that only this user can read,
// creating it with generate on first use. Creation is exclusive, so two
// commands started at the same moment end up with the same content.
func (h Home) secretFile(name string, generate func() ([]byte, error)) ([]byte, error) {
	if err := h.ensure(); err != nil {
		return nil, err
	}
	path := h.Path(name)
	for attempt := 0; attempt < 2; attempt++ {
		if content, err := os.ReadFile(path); err == nil {
			if len(content) == 0 {
				return nil, fmt.Errorf("local: %s is empty; remove it and run again", path)
			}
			return content, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		content, err := generate()
		if err != nil {
			return nil, err
		}
		// Write to a private temporary file and link it into place, so a
		// reader never sees a half-written secret.
		tmp, err := os.CreateTemp(h.Dir, "."+name+"-*")
		if err != nil {
			return nil, err
		}
		_, werr := tmp.Write(content)
		cerr := tmp.Close()
		if werr == nil && cerr == nil {
			werr = os.Chmod(tmp.Name(), 0o600)
		}
		if werr == nil && cerr == nil {
			err = os.Link(tmp.Name(), path) // fails if another command created it first
		} else {
			err = errors.Join(werr, cerr)
		}
		os.Remove(tmp.Name())
		if err == nil {
			return content, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("local: store %s: %w", name, err)
		}
	}
	return nil, fmt.Errorf("local: could not create or read %s", path)
}

func randomHex(n int) func() ([]byte, error) {
	return func() ([]byte, error) {
		raw := make([]byte, n)
		if _, err := rand.Read(raw); err != nil {
			return nil, err
		}
		return []byte(hex.EncodeToString(raw)), nil
	}
}

// DemoSigner loads the demo signing key, creating it on first use. The key
// file is readable by the current user only and never leaves this directory.
func (h Home) DemoSigner() (*signer.Demo, error) {
	seedHex, err := h.secretFile("demo-signer.seed", randomHex(32))
	if err != nil {
		return nil, err
	}
	seed, err := hex.DecodeString(strings.TrimSpace(string(seedHex)))
	if err != nil {
		return nil, fmt.Errorf("local: %s is not a signer seed", h.Path("demo-signer.seed"))
	}
	return signer.DemoFromSeed(seed)
}

// NameKey loads the controller's secret for naming checks in signed
// statements, creating it on first use. It never leaves this directory.
func (h Home) NameKey() ([]byte, error) {
	keyHex, err := h.secretFile("name-key", randomHex(32))
	if err != nil {
		return nil, err
	}
	key, err := hex.DecodeString(strings.TrimSpace(string(keyHex)))
	if err != nil || len(key) < 16 {
		return nil, fmt.Errorf("local: %s is not a key", h.Path("name-key"))
	}
	return key, nil
}

type postgresConfig struct {
	Port     int    `json:"port"`
	Password string `json:"password"`
}

// Postgres makes sure the local database is running and returns its
// connection URL. The database listens on 127.0.0.1 only, with a password
// generated on first use and stored in the home directory.
func (h Home) Postgres(ctx context.Context, cli container.CLI) (string, error) {
	raw, err := h.secretFile("postgres.json", func() ([]byte, error) {
		port, err := freePort()
		if err != nil {
			return nil, err
		}
		secret := make([]byte, 24)
		if _, err := rand.Read(secret); err != nil {
			return nil, err
		}
		return json.Marshal(postgresConfig{Port: port, Password: hex.EncodeToString(secret)})
	})
	if err != nil {
		return "", err
	}
	var cfg postgresConfig
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.Port == 0 || cfg.Password == "" {
		return "", fmt.Errorf("local: %s is not a database configuration", h.Path("postgres.json"))
	}

	postgresContainer, postgresVolume := h.names()
	exists, err := cli.Exists(ctx, postgresContainer)
	if err != nil {
		return "", err
	}
	running, _ := cli.Running(ctx, postgresContainer)
	switch {
	case !exists:
		// The password goes to the runtime in a file, not on a command line.
		envFile, ferr := os.CreateTemp(h.Dir, ".postgres-env-*")
		if ferr != nil {
			return "", ferr
		}
		defer os.Remove(envFile.Name())
		_, werr := fmt.Fprintf(envFile, "POSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n", cfg.Password, database)
		if cerr := envFile.Close(); werr != nil || cerr != nil {
			return "", errors.Join(werr, cerr)
		}
		err = cli.RunService(ctx, container.ServiceOptions{
			Name: postgresContainer, Image: PostgresImage, EnvFile: envFile.Name(),
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
		// A wrong password will not fix itself. It means the data volume was
		// created with another password, usually because this directory was
		// deleted while the volume was kept.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "28P01" {
			return "", fmt.Errorf("local: the database volume %s was created with a different password than the one in %s; "+
				"run `sprintfoundry down --purge` to remove the volume and start fresh", postgresVolume, h.Path("postgres.json"))
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

// Down removes what this home left in the container runtime: any preview or
// runner of an interrupted run with its network, and the database container.
// With purge it also deletes the database's data volume, its stored password,
// and the images this home built that no container uses any more.
func (h Home) Down(ctx context.Context, cli container.CLI, purge bool) error {
	if err := cli.RemoveByLabel(ctx, h.labelFilter()); err != nil {
		return err
	}
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
	if err := cli.PruneImages(ctx, h.labelFilter()); err != nil {
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

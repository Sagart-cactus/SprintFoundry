// Command sprintfoundry-proxy is the builder sandbox's only network peer. It
// runs in its own container on two networks: the sandbox's internal network,
// where it listens, and an ordinary network, where it reaches the model API.
// It reads its settings, the model key included, from the environment, which
// the controller fills from a file and never from a command line.
package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	// Root certificates for a FROM scratch image.
	_ "golang.org/x/crypto/x509roots/fallback"

	"github.com/sagart-cactus/sprintfoundry/internal/proxy"
)

func main() {
	if err := run(os.Getenv, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "sprintfoundry-proxy: %v\n", err)
		os.Exit(1)
	}
}

func config(getenv func(string) string) (proxy.Config, string, error) {
	upstream, err := url.Parse(getenv("SF_PROXY_UPSTREAM"))
	if err != nil || upstream.Host == "" {
		return proxy.Config{}, "", errors.New("SF_PROXY_UPSTREAM must be a URL such as https://api.openai.com")
	}
	key := getenv("SF_PROXY_KEY")
	if key == "" {
		return proxy.Config{}, "", errors.New("SF_PROXY_KEY is empty")
	}
	budget, err := strconv.ParseInt(getenv("SF_PROXY_MAX_REQUESTS"), 10, 64)
	if err != nil || budget < 1 {
		return proxy.Config{}, "", errors.New("SF_PROXY_MAX_REQUESTS must be a positive number")
	}
	var cfg proxy.Config
	switch getenv("SF_PROXY_PRESET") {
	case "openai-responses":
		cfg = proxy.OpenAIResponses(upstream, key, budget)
	case "anthropic-messages":
		cfg = proxy.AnthropicMessages(upstream, key, budget)
	default:
		return proxy.Config{}, "", errors.New("SF_PROXY_PRESET must be openai-responses or anthropic-messages")
	}
	listen := getenv("SF_PROXY_LISTEN")
	if listen == "" {
		listen = ":8080"
	}
	return cfg, listen, nil
}

func run(getenv func(string) string, logOut io.Writer) error {
	cfg, listen, err := config(getenv)
	if err != nil {
		return err
	}
	p, err := proxy.New(cfg)
	if err != nil {
		return err
	}
	logger := log.New(logOut, "", log.LstdFlags|log.LUTC)
	mux := http.NewServeMux()
	// The controller waits for this before it starts the builder.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "ok forwarded=%d refused=%d\n", p.Forwarded(), p.Refused())
	})
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		before := p.Refused()
		p.ServeHTTP(w, r)
		outcome := "forwarded"
		if p.Refused() > before {
			outcome = "refused"
		}
		// Method, path and outcome only: bodies hold the repository's code.
		logger.Printf("%s %s %s", r.Method, r.URL.Path, outcome)
	}))
	server := &http.Server{Addr: listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	logger.Printf("listening on %s, forwarding to %s, budget %d requests", listen, cfg.Upstream.Host, cfg.MaxRequests)
	return server.ListenAndServe()
}

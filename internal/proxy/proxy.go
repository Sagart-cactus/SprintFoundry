// Package proxy is the builder sandbox's only way out: a small HTTP proxy
// that forwards a fixed set of model API calls to one upstream and adds the
// model key, so the key never exists inside the sandbox.
//
// It is not a general proxy. It refuses any path that is not listed, strips
// whatever credential the client sent, and reads each JSON request body: a
// top-level field it does not know, or a tool that runs on the provider's
// side (web search, URL fetch, code execution, remote tool servers), is
// refused, because those would give the sandbox a way to the internet through
// the provider. It also stops forwarding when the run's request budget is
// used up. See docs/design/0006-sandbox-network-and-model-key.md.
package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// Route is one call the proxy forwards.
type Route struct {
	Method string
	Path   string // exact match, no query string
}

// Config says what the proxy forwards and how.
type Config struct {
	// Upstream is the model API's base URL, for example
	// https://api.openai.com. Its path, if any, is prefixed to every route.
	Upstream *url.URL
	// KeyHeader and KeyValue are the credential added to every forwarded
	// request, for example "Authorization" and "Bearer sk-...".
	KeyHeader string
	KeyValue  string
	// Routes are the only calls forwarded.
	Routes []Route
	// ForwardHeaders are the request headers passed on, in lower case.
	// Everything else, credentials included, is dropped.
	ForwardHeaders []string
	// TopLevelFields are the JSON body fields allowed at the top level.
	TopLevelFields []string
	// ToolTypes are the allowed values of a tool's "type". Client-side tools
	// only. An empty string in the list allows a tool with no type field.
	ToolTypes []string
	// MaxRequests is the run's budget of forwarded requests.
	MaxRequests int64
	// MaxBodyBytes bounds a request body.
	MaxBodyBytes int64
	// Timeout bounds one upstream call. Zero means ten minutes.
	Timeout time.Duration
}

// Validate reports a configuration that would be unsafe or useless.
func (c Config) Validate() error {
	switch {
	case c.Upstream == nil || c.Upstream.Host == "" || (c.Upstream.Scheme != "https" && c.Upstream.Scheme != "http"):
		return errors.New("proxy: an http or https upstream is required")
	case c.KeyHeader == "" || c.KeyValue == "":
		return errors.New("proxy: the key header and value are required")
	case len(c.Routes) == 0:
		return errors.New("proxy: at least one route is required")
	case len(c.TopLevelFields) == 0 || len(c.ToolTypes) == 0:
		return errors.New("proxy: the allowed body fields and tool types are required")
	case c.MaxRequests < 1 || c.MaxBodyBytes < 1:
		return errors.New("proxy: a request budget and a body limit are required")
	}
	for _, r := range c.Routes {
		if r.Method == "" || !strings.HasPrefix(r.Path, "/") || strings.ContainsAny(r.Path, "?#") {
			return fmt.Errorf("proxy: route %q %q is not valid", r.Method, r.Path)
		}
	}
	return nil
}

// Proxy is an http.Handler.
type Proxy struct {
	cfg       Config
	client    *http.Client
	forwarded atomic.Int64
	refused   atomic.Int64
}

// New returns a proxy for the configuration.
func New(cfg Config) (*Proxy, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	return &Proxy{cfg: cfg, client: &http.Client{
		Timeout: timeout,
		// The upstream is fixed. A redirect is passed back, never followed.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

// Forwarded returns how many requests were passed to the upstream.
func (p *Proxy) Forwarded() int64 { return p.forwarded.Load() }

// Refused returns how many requests were refused.
func (p *Proxy) Refused() int64 { return p.refused.Load() }

func (p *Proxy) refuse(w http.ResponseWriter, status int, reason string) {
	p.refused.Add(1)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"type": "sprintfoundry_proxy", "message": reason}})
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	allowed := false
	for _, route := range p.cfg.Routes {
		if r.Method == route.Method && r.URL.Path == route.Path {
			allowed = true
			break
		}
	}
	if !allowed || r.URL.RawQuery != "" {
		p.refuse(w, http.StatusForbidden, "this call is not on the proxy's list")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, p.cfg.MaxBodyBytes+1))
	if err != nil {
		p.refuse(w, http.StatusBadRequest, "the request body could not be read")
		return
	}
	if int64(len(body)) > p.cfg.MaxBodyBytes {
		p.refuse(w, http.StatusRequestEntityTooLarge, "the request body is larger than the proxy allows")
		return
	}
	// Forward the body as it was understood here, not as it was sent. Two
	// parsers can read the same bytes differently (a repeated key, for
	// example), and the upstream must see exactly what was checked.
	body, reason := p.checkBody(body)
	if reason != "" {
		p.refuse(w, http.StatusForbidden, reason)
		return
	}

	// Take one request from the budget. A request over budget is not sent.
	if p.forwarded.Add(1) > p.cfg.MaxRequests {
		p.forwarded.Add(-1)
		p.refuse(w, http.StatusTooManyRequests, "the run's request budget is used up")
		return
	}

	target := *p.cfg.Upstream
	target.Path = strings.TrimSuffix(target.Path, "/") + r.URL.Path
	target.RawQuery = ""
	out, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		p.refuse(w, http.StatusBadGateway, "the upstream request could not be built")
		return
	}
	for _, name := range p.cfg.ForwardHeaders {
		if strings.EqualFold(name, p.cfg.KeyHeader) {
			continue
		}
		if value := r.Header.Get(name); value != "" {
			out.Header.Set(name, value)
		}
	}
	out.Header.Set(p.cfg.KeyHeader, p.cfg.KeyValue)

	resp, err := p.client.Do(out)
	if err != nil {
		p.refuse(w, http.StatusBadGateway, "the upstream did not answer")
		return
	}
	defer resp.Body.Close()
	for _, name := range []string{"Content-Type", "Retry-After", "X-Request-Id", "Request-Id"} {
		if value := resp.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	// Stream the answer through, so server-sent events arrive as they are sent.
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			return
		}
	}
}

// checkBody parses a body and returns it re-encoded from what was parsed,
// or the reason it is refused.
func (p *Proxy) checkBody(body []byte) (checked []byte, reason string) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber() // numbers pass through exactly as written
	var top map[string]any
	if err := dec.Decode(&top); err != nil || top == nil {
		return nil, "the request body is not a JSON object"
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, "the request body holds more than one JSON value"
	}
	for field := range top {
		if !contains(p.cfg.TopLevelFields, field) {
			return nil, fmt.Sprintf("the request field %q is not on the proxy's list", field)
		}
	}
	if reason := p.checkTools(top["tools"], 0); reason != "" {
		return nil, reason
	}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(top); err != nil {
		return nil, "the request body could not be re-encoded"
	}
	return bytes.TrimRight(out.Bytes(), "\n"), ""
}

// checkTools walks a tools array, and the tools nested inside a tool, and
// refuses any tool type that is not allowed.
func (p *Proxy) checkTools(value any, depth int) string {
	if value == nil {
		return ""
	}
	if depth > 4 {
		return "tools are nested too deeply"
	}
	list, ok := value.([]any)
	if !ok {
		return "the tools field is not a list"
	}
	for _, item := range list {
		tool, ok := item.(map[string]any)
		if !ok {
			return "a tool is not a JSON object"
		}
		kind := ""
		if raw, present := tool["type"]; present {
			if kind, ok = raw.(string); !ok {
				return "a tool's type is not a string"
			}
		}
		if !contains(p.cfg.ToolTypes, kind) {
			return fmt.Sprintf("the tool type %q runs outside the sandbox and is not allowed", kind)
		}
		if reason := p.checkTools(tool["tools"], depth+1); reason != "" {
			return reason
		}
	}
	return ""
}

func contains(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}

// OpenAIResponses returns the configuration for agents that speak the OpenAI
// Responses API, such as Codex CLI. The field list is the request Codex CLI
// builds (its ResponsesApiRequest), read on 22 November 2026.
func OpenAIResponses(upstream *url.URL, key string, maxRequests int64) Config {
	return Config{
		Upstream:  upstream,
		KeyHeader: "Authorization", KeyValue: "Bearer " + key,
		Routes:         []Route{{Method: http.MethodPost, Path: "/v1/responses"}},
		ForwardHeaders: []string{"content-type", "accept", "openai-beta", "user-agent"},
		TopLevelFields: []string{"model", "stream", "service_tier", "input", "instructions", "tools", "tool_choice",
			"parallel_tool_calls", "reasoning", "store", "stream_options", "include", "prompt_cache_key",
			"prompt_cache_options", "text", "client_metadata", "max_output_tokens", "metadata", "temperature", "top_p", "truncation"},
		// Client-side tools only. "web_search" and other provider-side tools
		// are left out on purpose.
		ToolTypes:    []string{"function", "custom", "namespace"},
		MaxRequests:  maxRequests,
		MaxBodyBytes: 32 << 20,
	}
}

// AnthropicMessages returns the configuration for agents that speak the
// Anthropic Messages API, such as Claude Code.
func AnthropicMessages(upstream *url.URL, key string, maxRequests int64) Config {
	return Config{
		Upstream:  upstream,
		KeyHeader: "x-api-key", KeyValue: key,
		Routes: []Route{
			{Method: http.MethodPost, Path: "/v1/messages"},
			{Method: http.MethodPost, Path: "/v1/messages/count_tokens"},
		},
		ForwardHeaders: []string{"content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent"},
		TopLevelFields: []string{"model", "messages", "system", "max_tokens", "metadata", "stop_sequences", "stream",
			"temperature", "top_p", "top_k", "tools", "tool_choice", "thinking", "output_config", "service_tier", "context_management"},
		// A client tool has no type or the type "custom". Server tools such
		// as web search, web fetch and code execution carry versioned types
		// and are refused, as is the top-level mcp_servers field.
		ToolTypes:    []string{"", "custom"},
		MaxRequests:  maxRequests,
		MaxBodyBytes: 32 << 20,
	}
}

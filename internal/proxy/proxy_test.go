package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
)

const key = "sk-test-not-a-real-key"

// upstream records what reaches the model API.
type upstream struct {
	mu       sync.Mutex
	requests []*http.Request
	bodies   []string
	answer   func(w http.ResponseWriter, r *http.Request)
}

func (u *upstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	u.mu.Lock()
	u.requests = append(u.requests, r)
	u.bodies = append(u.bodies, string(body))
	answer := u.answer
	u.mu.Unlock()
	if answer != nil {
		answer(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	io.WriteString(w, `{"id":"resp_1","output":[]}`)
}

func (u *upstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.requests)
}

type world struct {
	t        *testing.T
	upstream *upstream
	proxy    *Proxy
	url      string
}

func newWorld(t *testing.T, preset func(*url.URL, string, int64) Config, budget int64) *world {
	t.Helper()
	up := &upstream{}
	upSrv := httptest.NewServer(up)
	t.Cleanup(upSrv.Close)
	target, _ := url.Parse(upSrv.URL)
	p, err := New(preset(target, key, budget))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(p)
	t.Cleanup(srv.Close)
	return &world{t: t, upstream: up, proxy: p, url: srv.URL}
}

func (w *world) do(method, path, body string, headers map[string]string) (int, string) {
	w.t.Helper()
	req, err := http.NewRequest(method, w.url+path, strings.NewReader(body))
	if err != nil {
		w.t.Fatal(err)
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		w.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	// A refusal is JSON; return its message so tests can match plain text.
	var refusal struct {
		Error struct{ Type, Message string }
	}
	if json.Unmarshal(out, &refusal) == nil && refusal.Error.Type == "sprintfoundry_proxy" {
		return resp.StatusCode, refusal.Error.Message
	}
	return resp.StatusCode, string(out)
}

// sameJSON reports whether two JSON texts mean the same.
func sameJSON(t *testing.T, a, b string) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal([]byte(a), &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(b), &y); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(x, y)
}

const codexBody = `{"model":"gpt-5","stream":false,"input":[{"role":"user","content":"hi"}],
 "tools":[{"type":"function","name":"shell","parameters":{}},{"type":"custom","name":"apply_patch"}],
 "tool_choice":"auto","parallel_tool_calls":false,"store":false,"include":[]}`

func TestProxyAddsTheKeyAndDropsTheClientsCredentials(t *testing.T) {
	w := newWorld(t, OpenAIResponses, 10)
	status, body := w.do("POST", "/v1/responses", codexBody, map[string]string{
		"Content-Type":        "application/json",
		"Authorization":       "Bearer sk-sent-by-the-sandbox",
		"X-Api-Key":           "also-sent-by-the-sandbox",
		"Cookie":              "session=abc",
		"Proxy-Authorization": "Basic eA==",
		"X-Forwarded-For":     "10.0.0.1",
		"OpenAI-Beta":         "responses=v1",
	})
	if status != 200 || !strings.Contains(body, "resp_1") {
		t.Fatalf("status %d, body %s", status, body)
	}
	if w.upstream.count() != 1 {
		t.Fatalf("upstream calls = %d, want 1", w.upstream.count())
	}
	got := w.upstream.requests[0]
	if got.Header.Get("Authorization") != "Bearer "+key {
		t.Errorf("upstream Authorization = %q, want the injected key", got.Header.Get("Authorization"))
	}
	for _, dropped := range []string{"X-Api-Key", "Cookie", "Proxy-Authorization", "X-Forwarded-For"} {
		if v := got.Header.Get(dropped); v != "" {
			t.Errorf("upstream received %s: %q", dropped, v)
		}
	}
	if got.Header.Get("Openai-Beta") != "responses=v1" || got.Header.Get("Content-Type") != "application/json" {
		t.Errorf("allowed headers were not forwarded: %v", got.Header)
	}
	if got.URL.Path != "/v1/responses" || !sameJSON(t, w.upstream.bodies[0], codexBody) {
		t.Errorf("upstream got path %q and a body that means something else: %s", got.URL.Path, w.upstream.bodies[0])
	}
	if w.proxy.Forwarded() != 1 || w.proxy.Refused() != 0 {
		t.Errorf("counters: forwarded %d, refused %d", w.proxy.Forwarded(), w.proxy.Refused())
	}
}

func TestProxyRefusesEverythingOffItsList(t *testing.T) {
	withTool := func(tool string) string {
		return `{"model":"gpt-5","input":[],"tools":[` + tool + `]}`
	}
	tests := []struct {
		name, method, path, body, want string
	}{
		{"another path", "POST", "/v1/chat/completions", codexBody, "not on the proxy's list"},
		{"a path that only starts like an allowed one", "POST", "/v1/responses/../files", codexBody, "not on the proxy's list"},
		{"another method", "GET", "/v1/responses", "", "not on the proxy's list"},
		{"a query string", "POST", "/v1/responses?x=1", codexBody, "not on the proxy's list"},
		{"an unknown top-level field", "POST", "/v1/responses", `{"model":"gpt-5","input":[],"webhook_url":"https://evil.example"}`, `"webhook_url" is not on the proxy's list`},
		{"provider-side web search", "POST", "/v1/responses", withTool(`{"type":"web_search"}`), `"web_search" runs outside the sandbox`},
		{"provider-side code execution", "POST", "/v1/responses", withTool(`{"type":"code_interpreter","container":{"type":"auto"}}`), `"code_interpreter" runs outside the sandbox`},
		{"a remote tool server", "POST", "/v1/responses", withTool(`{"type":"mcp","server_url":"https://evil.example/mcp"}`), `"mcp" runs outside the sandbox`},
		{"a provider-side tool nested in a namespace", "POST", "/v1/responses", withTool(`{"type":"namespace","name":"x","tools":[{"type":"function","name":"ok"},{"type":"web_search"}]}`), `"web_search" runs outside the sandbox`},
		{"a tool with no type", "POST", "/v1/responses", withTool(`{"name":"x"}`), `"" runs outside the sandbox`},
		{"a tool type that is not a string", "POST", "/v1/responses", withTool(`{"type":["function"]}`), "type is not a string"},
		{"tools that are not a list", "POST", "/v1/responses", `{"model":"gpt-5","input":[],"tools":{"type":"web_search"}}`, "not a list"},
		{"a body that is not JSON", "POST", "/v1/responses", "model=gpt-5", "not a JSON object"},
		{"a JSON array", "POST", "/v1/responses", `[{"model":"gpt-5"}]`, "not a JSON object"},
		{"two JSON values", "POST", "/v1/responses", `{"model":"gpt-5","input":[]}{"tools":[{"type":"web_search"}]}`, "more than one JSON value"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newWorld(t, OpenAIResponses, 10)
			status, body := w.do(tt.method, tt.path, tt.body, map[string]string{"Content-Type": "application/json"})
			if status < 400 || !strings.Contains(body, tt.want) {
				t.Fatalf("status %d, body %s; want a refusal mentioning %q", status, body, tt.want)
			}
			if w.upstream.count() != 0 {
				t.Errorf("a refused request reached the upstream")
			}
			if w.proxy.Forwarded() != 0 {
				t.Errorf("a refused request used the budget")
			}
		})
	}
}

func TestUpstreamSeesOnlyWhatWasChecked(t *testing.T) {
	// Two parsers can disagree about a repeated key: this proxy reads the
	// last value, another reader may take the first. Whatever is forwarded
	// must not carry the tool that was never checked.
	for name, body := range map[string]string{
		"repeated tools key, bad one first": `{"model":"gpt-5","input":[],"tools":[{"type":"web_search"}],"tools":[]}`,
		"repeated key inside a tool":        `{"model":"gpt-5","input":[],"tools":[{"type":"web_search","type":"function","name":"x"}]}`,
		"repeated nested tools key":         `{"model":"gpt-5","input":[],"tools":[{"type":"namespace","tools":[{"type":"mcp","server_url":"https://evil.example"}],"tools":[]}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t, OpenAIResponses, 10)
			status, text := w.do("POST", "/v1/responses", body, map[string]string{"Content-Type": "application/json"})
			if w.upstream.count() == 0 {
				if status < 400 {
					t.Fatalf("nothing was forwarded but the status is %d: %s", status, text)
				}
				return // refused outright, which is also fine
			}
			forwarded := w.upstream.bodies[0]
			for _, hidden := range []string{"web_search", "evil.example", `"mcp"`} {
				if strings.Contains(forwarded, hidden) {
					t.Fatalf("the upstream received %q, which the proxy never checked: %s", hidden, forwarded)
				}
			}
		})
	}

	// Numbers and text pass through unchanged in meaning.
	w := newWorld(t, OpenAIResponses, 10)
	exact := `{"model":"gpt-5","input":[{"role":"user","content":"a <b> & \u00e9 \"q\""}],"temperature":0.1,"max_output_tokens":9007199254740993}`
	if status, text := w.do("POST", "/v1/responses", exact, nil); status != 200 {
		t.Fatalf("status %d: %s", status, text)
	}
	if got := w.upstream.bodies[0]; !strings.Contains(got, "9007199254740993") || !strings.Contains(got, "0.1") || !strings.Contains(got, "a <b> & ") {
		t.Errorf("the forwarded body changed a value: %s", got)
	}
}

func TestProxyRefusesAnOversizedBody(t *testing.T) {
	up := &upstream{}
	upSrv := httptest.NewServer(up)
	defer upSrv.Close()
	target, _ := url.Parse(upSrv.URL)
	cfg := OpenAIResponses(target, key, 10)
	cfg.MaxBodyBytes = 64
	p, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(p)
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/responses", "application/json", bytes.NewReader([]byte(codexBody)))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge || up.count() != 0 {
		t.Fatalf("status %d, upstream calls %d", resp.StatusCode, up.count())
	}
}

func TestProxyStopsAtTheRequestBudget(t *testing.T) {
	w := newWorld(t, OpenAIResponses, 2)
	headers := map[string]string{"Content-Type": "application/json"}

	// Refused requests do not use the budget.
	for i := 0; i < 5; i++ {
		w.do("POST", "/v1/files", codexBody, headers)
	}
	for i := 1; i <= 2; i++ {
		if status, body := w.do("POST", "/v1/responses", codexBody, headers); status != 200 {
			t.Fatalf("request %d of 2: status %d, %s", i, status, body)
		}
	}
	for i := 0; i < 3; i++ {
		status, body := w.do("POST", "/v1/responses", codexBody, headers)
		if status != http.StatusTooManyRequests || !strings.Contains(body, "budget is used up") {
			t.Fatalf("over budget: status %d, %s", status, body)
		}
	}
	if w.upstream.count() != 2 || w.proxy.Forwarded() != 2 {
		t.Errorf("upstream calls %d, forwarded %d; want 2 and 2", w.upstream.count(), w.proxy.Forwarded())
	}

	// Many requests at once still share one budget.
	w2 := newWorld(t, OpenAIResponses, 5)
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); w2.do("POST", "/v1/responses", codexBody, headers) }()
	}
	wg.Wait()
	if w2.upstream.count() != 5 {
		t.Errorf("under contention the upstream was called %d times, want 5", w2.upstream.count())
	}
}

func TestProxyPassesARedirectBackWithoutFollowingIt(t *testing.T) {
	elsewhere := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("the proxy followed a redirect to another host, with the key")
	}))
	defer elsewhere.Close()
	w := newWorld(t, OpenAIResponses, 10)
	w.upstream.answer = func(rw http.ResponseWriter, r *http.Request) {
		http.Redirect(rw, r, elsewhere.URL+"/steal", http.StatusTemporaryRedirect)
	}
	status, _ := w.do("POST", "/v1/responses", codexBody, map[string]string{"Content-Type": "application/json"})
	if status != http.StatusTemporaryRedirect {
		t.Fatalf("status %d, want the redirect passed back", status)
	}
}

func TestProxyStreamsTheAnswer(t *testing.T) {
	w := newWorld(t, OpenAIResponses, 10)
	release := make(chan struct{})
	w.upstream.answer = func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: first\n\n")
		rw.(http.Flusher).Flush()
		<-release
		io.WriteString(rw, "data: second\n\n")
	}
	resp, err := http.Post(w.url+"/v1/responses", "application/json", strings.NewReader(codexBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	// The first event must arrive while the upstream is still holding the second.
	buf := make([]byte, len("data: first\n\n"))
	if _, err := io.ReadFull(resp.Body, buf); err != nil || string(buf) != "data: first\n\n" {
		t.Fatalf("first event = %q, %v", buf, err)
	}
	close(release)
	rest, _ := io.ReadAll(resp.Body)
	if string(rest) != "data: second\n\n" || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Errorf("rest = %q, content type %q", rest, resp.Header.Get("Content-Type"))
	}
}

func TestAnthropicPreset(t *testing.T) {
	w := newWorld(t, AnthropicMessages, 10)
	ok := `{"model":"claude","max_tokens":10,"messages":[{"role":"user","content":"hi"}],
	 "tools":[{"name":"bash","description":"run","input_schema":{"type":"object"}},{"type":"custom","name":"edit","input_schema":{"type":"object"}}]}`
	status, _ := w.do("POST", "/v1/messages", ok, map[string]string{
		"Content-Type": "application/json", "Authorization": "Bearer placeholder-not-a-key",
		"X-Api-Key": "placeholder-not-a-key", "Anthropic-Version": "2023-06-01"})
	if status != 200 || w.upstream.count() != 1 {
		t.Fatalf("status %d, upstream calls %d", status, w.upstream.count())
	}
	got := w.upstream.requests[0]
	if got.Header.Get("X-Api-Key") != key || got.Header.Get("Authorization") != "" || got.Header.Get("Anthropic-Version") != "2023-06-01" {
		t.Errorf("upstream headers: x-api-key %q, authorization %q, version %q",
			got.Header.Get("X-Api-Key"), got.Header.Get("Authorization"), got.Header.Get("Anthropic-Version"))
	}

	refused := map[string]string{
		"server-side web search":    `{"model":"claude","max_tokens":10,"messages":[],"tools":[{"type":"web_search_20250305","name":"web_search"}]}`,
		"server-side web fetch":     `{"model":"claude","max_tokens":10,"messages":[],"tools":[{"type":"web_fetch_20250910","name":"web_fetch"}]}`,
		"server-side code run":      `{"model":"claude","max_tokens":10,"messages":[],"tools":[{"type":"code_execution_20250825","name":"code_execution"}]}`,
		"remote tool servers":       `{"model":"claude","max_tokens":10,"messages":[],"mcp_servers":[{"type":"url","url":"https://evil.example/mcp","name":"x"}]}`,
		"a provider-side container": `{"model":"claude","max_tokens":10,"messages":[],"container":"c_123"}`,
	}
	for name, body := range refused {
		status, text := w.do("POST", "/v1/messages", body, map[string]string{"Content-Type": "application/json"})
		if status != http.StatusForbidden {
			t.Errorf("%s: status %d, %s", name, status, text)
		}
	}
	if w.upstream.count() != 1 {
		t.Errorf("a refused request reached the upstream")
	}
}

func TestConfigValidation(t *testing.T) {
	target, _ := url.Parse("https://api.example")
	good := OpenAIResponses(target, key, 10)
	if _, err := New(good); err != nil {
		t.Fatalf("a valid configuration was refused: %v", err)
	}
	bad := map[string]func(*Config){
		"no upstream":          func(c *Config) { c.Upstream = nil },
		"a file upstream":      func(c *Config) { c.Upstream, _ = url.Parse("file:///etc/passwd") },
		"no key":               func(c *Config) { c.KeyValue = "" },
		"no routes":            func(c *Config) { c.Routes = nil },
		"a route with a query": func(c *Config) { c.Routes = []Route{{Method: "POST", Path: "/v1/responses?x=1"}} },
		"no budget":            func(c *Config) { c.MaxRequests = 0 },
		"no body limit":        func(c *Config) { c.MaxBodyBytes = 0 },
		"no field list":        func(c *Config) { c.TopLevelFields = nil },
		"no tool type list":    func(c *Config) { c.ToolTypes = nil },
	}
	for name, breakIt := range bad {
		cfg := OpenAIResponses(target, key, 10)
		breakIt(&cfg)
		if _, err := New(cfg); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRefusalIsValidJSON(t *testing.T) {
	w := newWorld(t, OpenAIResponses, 10)
	resp, err := http.Post(w.url+"/v1/files", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var parsed struct {
		Error struct{ Type, Message string }
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil || parsed.Error.Type != "sprintfoundry_proxy" || parsed.Error.Message == "" {
		t.Errorf("refusal %+v: %v", parsed, err)
	}
	if resp.Header.Get("Content-Type") != "application/json" || resp.StatusCode != http.StatusForbidden {
		t.Errorf("status %d, content type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
}

func TestProxyRefusesReferencesTheProviderWouldFollow(t *testing.T) {
	msg := func(content string) string {
		return `{"model":"gpt-5","input":[{"role":"user","content":[` + content + `]}]}`
	}
	openai := map[string]string{
		"an image URL":                  msg(`{"type":"input_image","image_url":"https://attacker.example/x?d=SECRET"}`),
		"an image URL as an object":     msg(`{"type":"input_image","image_url":{"url":"https://attacker.example/x"}}`),
		"a file URL":                    msg(`{"type":"input_file","file_url":"https://attacker.example/doc.pdf"}`),
		"a stored file":                 msg(`{"type":"input_file","file_id":"file-abc"}`),
		"an image in a tool's output":   `{"model":"gpt-5","input":[{"type":"function_call_output","call_id":"c1","output":[{"type":"input_image","image_url":"https://attacker.example/i.png"}]}]}`,
		"a reference to a stored item":  `{"model":"gpt-5","input":[{"type":"item_reference","id":"msg_123"}]}`,
		"a reference hidden in a field": `{"model":"gpt-5","input":[{"role":"user","content":"hi","item_reference":"msg_1"}]}`,
	}
	for name, body := range openai {
		t.Run("openai: "+name, func(t *testing.T) {
			w := newWorld(t, OpenAIResponses, 10)
			status, text := w.do("POST", "/v1/responses", body, map[string]string{"Content-Type": "application/json"})
			if status != http.StatusForbidden || w.upstream.count() != 0 {
				t.Fatalf("status %d (%s), upstream calls %d", status, text, w.upstream.count())
			}
		})
	}
	anthropic := map[string]string{
		"an image from a URL":    `{"model":"m","max_tokens":5,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://attacker.example/i.png"}}]}]}`,
		"a document from a URL":  `{"model":"m","max_tokens":5,"messages":[{"role":"user","content":[{"type":"document","source":{"type":"url","url":"https://attacker.example/d.pdf"}}]}]}`,
		"a stored file":          `{"model":"m","max_tokens":5,"messages":[{"role":"user","content":[{"type":"document","source":{"type":"file","file_id":"file_1"}}]}]}`,
		"a URL in a tool result": `{"model":"m","max_tokens":5,"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":"image","source":{"type":"url","url":"https://attacker.example/i"}}]}]}]}`,
	}
	for name, body := range anthropic {
		t.Run("anthropic: "+name, func(t *testing.T) {
			w := newWorld(t, AnthropicMessages, 10)
			status, text := w.do("POST", "/v1/messages", body, map[string]string{"Content-Type": "application/json"})
			if status != http.StatusForbidden || w.upstream.count() != 0 {
				t.Fatalf("status %d (%s), upstream calls %d", status, text, w.upstream.count())
			}
		})
	}

	// Inline data is fine, and so is a tool schema with a property named url.
	w := newWorld(t, OpenAIResponses, 10)
	inline := `{"model":"gpt-5","input":[{"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgo="}]}],
	 "tools":[{"type":"function","name":"fetch_docs","parameters":{"type":"object","properties":{"url":{"type":"string","format":"uri"}}}}]}`
	if status, text := w.do("POST", "/v1/responses", inline, map[string]string{"Content-Type": "application/json"}); status != 200 {
		t.Fatalf("inline image and a url property in a schema: status %d, %s", status, text)
	}
	a := newWorld(t, AnthropicMessages, 10)
	b64 := `{"model":"m","max_tokens":5,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}]}`
	if status, text := a.do("POST", "/v1/messages", b64, map[string]string{"Content-Type": "application/json"}); status != 200 {
		t.Fatalf("inline base64 image: status %d, %s", status, text)
	}
}

func TestProxyPinsTheModelAndCapsSpend(t *testing.T) {
	pinned := func(u *url.URL, k string, n int64) Config { return OpenAIResponses(u, k, n).Pin("gpt-5", 4000) }
	w := newWorld(t, pinned, 10)
	headers := map[string]string{"Content-Type": "application/json"}

	if status, text := w.do("POST", "/v1/responses", `{"model":"gpt-5-pro","input":[]}`, headers); status != http.StatusForbidden || !strings.Contains(text, `only the model "gpt-5"`) {
		t.Fatalf("another model: status %d, %s", status, text)
	}
	if status, _ := w.do("POST", "/v1/responses", `{"input":[]}`, headers); status != http.StatusForbidden {
		t.Fatalf("no model at all: status %d", status)
	}
	if status, text := w.do("POST", "/v1/responses",
		`{"model":"gpt-5","input":[],"max_output_tokens":1000000,"service_tier":"priority","store":true}`, headers); status != 200 {
		t.Fatalf("status %d, %s", status, text)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(w.upstream.bodies[0]), &sent); err != nil {
		t.Fatal(err)
	}
	if sent["max_output_tokens"] != float64(4000) || sent["store"] != false {
		t.Errorf("upstream got max_output_tokens %v, store %v; want 4000 and false", sent["max_output_tokens"], sent["store"])
	}
	if _, present := sent["service_tier"]; present {
		t.Error("service_tier was forwarded")
	}
	w.do("POST", "/v1/responses", `{"model":"gpt-5","input":[]}`, headers)
	json.Unmarshal([]byte(w.upstream.bodies[1]), &sent)
	if sent["max_output_tokens"] != float64(4000) {
		t.Errorf("a request without a token limit was sent with %v, want the cap", sent["max_output_tokens"])
	}
	if status, _ := w.do("POST", "/v1/responses", `{"model":"gpt-5","input":[],"max_output_tokens":"lots"}`, headers); status != http.StatusForbidden {
		t.Errorf("a token limit that is not a number: status %d", status)
	}
}

func TestServeReportsWhatItDid(t *testing.T) {
	w := newWorld(t, OpenAIResponses, 10)
	rec := httptest.NewRecorder()
	if w.proxy.Serve(rec, httptest.NewRequest("POST", "/v1/files", strings.NewReader("{}"))) {
		t.Error("a refused request was reported as forwarded")
	}
	rec = httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(codexBody))
	if !w.proxy.Serve(rec, req) || rec.Code != 200 {
		t.Errorf("a forwarded request was not reported (status %d)", rec.Code)
	}
}

func TestPlainHTTPOnlyNearby(t *testing.T) {
	for _, upstream := range []string{"http://127.0.0.1:9000", "http://localhost:9000", "http://sf-run-proxy-up:9000",
		"http://host.containers.internal:11434", "http://host.docker.internal:11434"} {
		u, _ := url.Parse(upstream)
		if _, err := New(OpenAIResponses(u, key, 1)); err != nil {
			t.Errorf("%s was refused: %v", upstream, err)
		}
	}
	for _, upstream := range []string{"http://api.openai.com", "http://203.0.113.5:80", "http://host.containers.internal.evil.example"} {
		u, _ := url.Parse(upstream)
		if _, err := New(OpenAIResponses(u, key, 1)); err == nil {
			t.Errorf("%s was accepted: the key would travel unencrypted", upstream)
		}
	}
}

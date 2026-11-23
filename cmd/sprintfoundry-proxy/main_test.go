package main

import (
	"strings"
	"testing"
)

func TestConfigFromTheEnvironment(t *testing.T) {
	env := map[string]string{
		"SF_PROXY_UPSTREAM": "https://api.example", "SF_PROXY_KEY": "sk-test",
		"SF_PROXY_MAX_REQUESTS": "40", "SF_PROXY_PRESET": "openai-responses",
	}
	getenv := func(k string) string { return env[k] }
	cfg, listen, err := config(getenv)
	if err != nil || listen != ":8080" || cfg.MaxRequests != 40 || cfg.KeyValue != "Bearer sk-test" {
		t.Fatalf("config = %+v, %q, %v", cfg, listen, err)
	}
	env["SF_PROXY_MODEL"], env["SF_PROXY_MAX_TOKENS"] = "gpt-5", "8000"
	if cfg, _, err := config(getenv); err != nil || cfg.Model != "gpt-5" || cfg.MaxTokens != 8000 {
		t.Errorf("pinned config = %+v, %v", cfg, err)
	}
	env["SF_PROXY_MAX_TOKENS"] = ""
	if _, _, err := config(getenv); err == nil {
		t.Error("a pinned model without a token cap was accepted")
	}
	delete(env, "SF_PROXY_MODEL")
	delete(env, "SF_PROXY_MAX_TOKENS")
	env["SF_PROXY_PRESET"] = "anthropic-messages"
	if cfg, _, _ := config(getenv); cfg.KeyHeader != "x-api-key" {
		t.Errorf("anthropic preset key header = %q", cfg.KeyHeader)
	}
	for name, edit := range map[string]func(){
		"no key":         func() { env["SF_PROXY_KEY"] = "" },
		"no budget":      func() { env["SF_PROXY_MAX_REQUESTS"] = "0" },
		"unknown preset": func() { env["SF_PROXY_PRESET"] = "anything" },
		"no upstream":    func() { env["SF_PROXY_UPSTREAM"] = "" },
	} {
		saved := map[string]string{}
		for k, v := range env {
			saved[k] = v
		}
		edit()
		if _, _, err := config(getenv); err == nil {
			t.Errorf("%s: accepted", name)
		}
		env = saved
		getenv = func(k string) string { return env[k] }
	}
	// The key never appears in an error message.
	env["SF_PROXY_PRESET"] = "bad"
	if _, _, err := config(getenv); err != nil && strings.Contains(err.Error(), "sk-test") {
		t.Error("an error message contains the key")
	}
}

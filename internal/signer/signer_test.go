package signer

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"testing"
)

func statement(purpose string) []byte {
	annotations := ""
	if purpose != "" {
		annotations = `,"annotations":{"purpose":"` + purpose + `"}`
	}
	return []byte(`{"_type":"https://in-toto.io/Statement/v1","subject":[{"name":"local/app","digest":{"sha256":"00"}` +
		annotations + `}],"predicateType":"https://slsa.dev/verification_summary/v1","predicate":{"verificationResult":"PASSED"}}`)
}

func TestDemoSignerCannotSignProduction(t *testing.T) {
	d, err := NewDemo()
	if err != nil {
		t.Fatal(err)
	}
	var s Signer = d
	ctx := context.Background()

	// The purpose is read from the bytes that get signed. There is no
	// argument a caller could set to "demo" while the statement says
	// "production".
	refused := map[string][]byte{
		"a statement for production":     statement("production"),
		"a statement with no purpose":    statement(""),
		"a statement with a new purpose": statement("staging"),
		"bytes that are not a statement": []byte(`{"verificationResult":"PASSED"}`),
		"bytes that are not JSON":        []byte("PASSED"),
		"subjects that disagree": []byte(`{"_type":"https://in-toto.io/Statement/v1","subject":[` +
			`{"name":"a","annotations":{"purpose":"demo"}},{"name":"b","annotations":{"purpose":"production"}}]}`),
		"a statement with no subject": []byte(`{"_type":"https://in-toto.io/Statement/v1","subject":[]}`),
	}
	for name, payload := range refused {
		if _, err := s.Sign(ctx, payload); !errors.Is(err, ErrPurposeNotAllowed) {
			t.Errorf("%s: err = %v, want ErrPurposeNotAllowed", name, err)
		}
	}
	if _, err := s.Sign(ctx, statement("demo")); err != nil {
		t.Errorf("a demo statement was refused: %v", err)
	}
	if !IsDemoIdentity(s.Identity()) {
		t.Errorf("identity %q is not marked as a demo identity", s.Identity())
	}
}

func TestDemoSignatureVerifies(t *testing.T) {
	d, _ := NewDemo()
	payload := statement("demo")

	env, err := d.Sign(context.Background(), payload)
	if err != nil {
		t.Fatal(err)
	}
	if env.PayloadType != PayloadTypeInToto {
		t.Errorf("payload type = %q", env.PayloadType)
	}
	got, err := VerifyEd25519(env, d.PublicKey())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("payload = %s", got)
	}

	t.Run("a changed purpose is rejected", func(t *testing.T) {
		tampered := env
		tampered.Payload = base64.StdEncoding.EncodeToString(statement("production"))
		if _, err := VerifyEd25519(tampered, d.PublicKey()); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err = %v, want ErrBadSignature", err)
		}
	})
	t.Run("a changed payload type is rejected", func(t *testing.T) {
		tampered := env
		tampered.PayloadType = "text/plain"
		if _, err := VerifyEd25519(tampered, d.PublicKey()); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err = %v, want ErrBadSignature", err)
		}
	})
	t.Run("another key is rejected", func(t *testing.T) {
		other, _ := NewDemo()
		if _, err := VerifyEd25519(env, other.PublicKey()); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err = %v, want ErrBadSignature", err)
		}
	})
}

func TestDemoFromSeedKeepsIdentity(t *testing.T) {
	d, _ := NewDemo()
	again, err := DemoFromSeed(d.Seed())
	if err != nil {
		t.Fatal(err)
	}
	if again.Identity() != d.Identity() {
		t.Error("identity changed after restoring from the seed")
	}
	if _, err := DemoFromSeed([]byte("short")); err == nil {
		t.Error("a short seed was accepted")
	}
}

func TestPAE(t *testing.T) {
	// Vector from the DSSE specification.
	got := PAE("http://example.com/HelloWorld", []byte("hello world"))
	want := "DSSEv1 29 http://example.com/HelloWorld 11 hello world"
	if string(got) != want {
		t.Errorf("PAE = %q, want %q", got, want)
	}
}

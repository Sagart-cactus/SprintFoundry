package signer

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"testing"
)

func TestDemoSignerCannotSignProduction(t *testing.T) {
	d, err := NewDemo()
	if err != nil {
		t.Fatal(err)
	}
	var s Signer = d

	if _, err := s.Sign(context.Background(), PurposeProduction, PayloadTypeInToto, []byte(`{}`)); !errors.Is(err, ErrPurposeNotAllowed) {
		t.Fatalf("production: err = %v, want ErrPurposeNotAllowed", err)
	}
	if _, err := s.Sign(context.Background(), "", PayloadTypeInToto, []byte(`{}`)); !errors.Is(err, ErrPurposeNotAllowed) {
		t.Fatalf("empty purpose: err = %v, want ErrPurposeNotAllowed", err)
	}
	if !IsDemoIdentity(s.Identity()) {
		t.Errorf("identity %q is not marked as a demo identity", s.Identity())
	}
}

func TestDemoSignatureVerifies(t *testing.T) {
	d, _ := NewDemo()
	payload := []byte(`{"_type":"https://in-toto.io/Statement/v1"}`)

	env, err := d.Sign(context.Background(), PurposeDemo, PayloadTypeInToto, payload)
	if err != nil {
		t.Fatal(err)
	}
	got, err := VerifyEd25519(env, d.PublicKey())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("payload = %s", got)
	}

	t.Run("a changed payload is rejected", func(t *testing.T) {
		tampered := env
		tampered.Payload = base64.StdEncoding.EncodeToString([]byte(`{"_type":"other"}`))
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

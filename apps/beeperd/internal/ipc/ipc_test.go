package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func serve(t *testing.T, handler Handler) string {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "d.sock")
	server, err := Serve(socket, handler, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	return socket
}

func code(err error) string {
	var coded *Error
	if errors.As(err, &coded) {
		return coded.Code
	}
	return ""
}

func TestCallsAnswersAndErrors(t *testing.T) {
	socket := serve(t, func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		switch method {
		case "echo":
			var input map[string]any
			_ = json.Unmarshal(params, &input)
			return input, nil
		case "refused":
			return nil, &Error{Code: "refused", Message: "no", Data: map[string]any{"why": "policy"}}
		}
		return nil, errors.New("boom")
	})
	ctx := context.Background()
	var echoed map[string]any
	if err := Call(ctx, socket, "echo", map[string]any{"text": "a < b & c"}, time.Second, &echoed); err != nil {
		t.Fatal(err)
	}
	if echoed["text"] != "a < b & c" {
		t.Fatalf("got %v", echoed)
	}
	err := Call(ctx, socket, "refused", nil, time.Second, nil)
	var coded *Error
	if !errors.As(err, &coded) || coded.Code != "refused" || coded.Message != "no" {
		t.Fatalf("a coded error passes through as is, got %v", err)
	}
	if data, _ := coded.Data.(map[string]any); data["why"] != "policy" {
		t.Fatalf("the error's data is kept, got %v", coded.Data)
	}
	if got := code(Call(ctx, socket, "anything", nil, time.Second, nil)); got != "internal_error" {
		t.Fatalf("an uncoded error is internal_error, got %q", got)
	}
}

func TestNothingListeningIsUnreachable(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "none.sock")
	if got := code(Call(context.Background(), socket, "ping", nil, time.Second, nil)); got != CodeUnreachable {
		t.Fatalf("got %q", got)
	}
}

func TestASlowCallDoesNotDelayAPing(t *testing.T) {
	release := make(chan struct{})
	socket := serve(t, func(ctx context.Context, method string, _ json.RawMessage) (any, error) {
		if method == "slow" {
			<-release
		}
		return map[string]any{"ok": true}, nil
	})
	done := make(chan error, 1)
	go func() { done <- Call(context.Background(), socket, "slow", nil, 5*time.Second, nil) }()
	time.Sleep(50 * time.Millisecond)
	started := time.Now()
	if err := Call(context.Background(), socket, "ping", nil, time.Second, nil); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > 500*time.Millisecond {
		t.Fatal("the ping waited for the slow call")
	}
	if got := code(Call(context.Background(), socket, "slow", nil, 100*time.Millisecond, nil)); got != CodeTimeout {
		t.Fatalf("a call that isn't answered in time is a timeout, got %q", got)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

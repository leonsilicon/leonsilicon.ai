package feeds

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

type openAICall struct {
	path          string
	body          string
	authorization string
	contentType   string
	accept        string
}

type openAIAnswer struct {
	status int
	header map[string]string
	body   string
}

const safeDecision = `{"model":"gpt-6-luna","answers":[{"type":"choice","name":"safety","choice":"ok","confidence":0.99,"probabilities":[{"value":"ok","probability":0.99},{"value":"promotion","probability":0.01}]}],"usage":{"input_tokens":812,"output_tokens":0,"total_tokens":812}}`

// fakeOpenAI is a local OpenAI API that gives the scripted answers in turn, then safeDecision.
type fakeOpenAI struct {
	server  *httptest.Server
	mu      sync.Mutex
	calls   []openAICall
	answers []openAIAnswer
}

func newFakeOpenAI(t *testing.T, answers ...openAIAnswer) *fakeOpenAI {
	openai := &fakeOpenAI{answers: answers}
	openai.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		if request.Method != http.MethodPost {
			t.Errorf("OpenAI was called with %s", request.Method)
		}
		openai.mu.Lock()
		openai.calls = append(openai.calls, openAICall{
			path:          request.URL.Path,
			body:          string(body),
			authorization: request.Header.Get("Authorization"),
			contentType:   request.Header.Get("Content-Type"),
			accept:        request.Header.Get("Accept"),
		})
		answer := openAIAnswer{body: safeDecision}
		if len(openai.answers) > 0 {
			answer, openai.answers = openai.answers[0], openai.answers[1:]
		}
		openai.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		for key, value := range answer.header {
			writer.Header().Set(key, value)
		}
		if answer.status != 0 {
			writer.WriteHeader(answer.status)
		}
		io.WriteString(writer, answer.body)
	}))
	t.Cleanup(openai.server.Close)
	return openai
}

func (o *fakeOpenAI) made() []openAICall {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]openAICall{}, o.calls...)
}

// client talks to the fake and records its waits instead of sleeping.
func (o *fakeOpenAI) client(slept *[]time.Duration) *openAI {
	return &openAI{
		apiKey:  "sk-test",
		baseURL: o.server.URL + "/v1",
		http:    o.server.Client(),
		timeout: screenTimeout,
		sleep:   func(wait time.Duration) { *slept = append(*slept, wait) },
	}
}

var someRequest = screenRequest(
	screenInput{chat: screenChat{title: "Family", network: "whatsapp", kind: "direct"}, messages: []screenMessage{{from: "Alice", text: "1 < 2 & 3 > 2", kind: "m.text"}}},
	screenModel,
	screenPrompt{context: screenContext, maxText: maxText},
)

func TestAsksOpenAIForADecision(t *testing.T) {
	openai := newFakeOpenAI(t)
	var slept []time.Duration
	decision, err := openai.client(&slept).createDecision(context.Background(), someRequest)
	if err != nil {
		t.Fatal(err)
	}
	calls := openai.made()
	equal(t, len(calls), 1)
	equal(t, calls[0].path, "/v1/decisions")
	equal(t, calls[0].authorization, "Bearer sk-test")
	equal(t, calls[0].contentType, "application/json")
	equal(t, calls[0].accept, "application/json")
	// JSON as JavaScript writes it: <, > and & are not escaped, and nothing follows the last brace.
	if !strings.Contains(calls[0].body, `"text":"1 < 2 & 3 > 2"}]}}]}],"questions":[{"type":"choice","name":"safety","instructions":"Which best`) || !strings.HasSuffix(calls[0].body, `}]}]}`) {
		t.Errorf("the request was %s", calls[0].body)
	}
	decided, err := verdictFrom(decision, screenThresholds)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, decided, verdict{Route: "safe", Reason: "ok", By: "model", PUnsafe: number(0)})
	equal(t, len(slept), 0)
}

func TestTriesOpenAIAgainAfterFailuresThatMayPass(t *testing.T) {
	busy := openAIAnswer{status: 503, body: `{"error":{"message":"overloaded"}}`}
	for _, c := range []struct {
		about   string
		answers []openAIAnswer
		calls   int
		// waits is the shortest and longest wait allowed before each retry.
		waits [][2]time.Duration
		fails string
	}{
		{"a server error", []openAIAnswer{busy}, 2, [][2]time.Duration{{375 * time.Millisecond, 500 * time.Millisecond}}, ""},
		{"two server errors, with a longer second wait", []openAIAnswer{busy, busy}, 3, [][2]time.Duration{{375 * time.Millisecond, 500 * time.Millisecond}, {750 * time.Millisecond, time.Second}}, ""},
		{"a third failure is the answer", []openAIAnswer{busy, busy, busy}, 3, [][2]time.Duration{{375 * time.Millisecond, 500 * time.Millisecond}, {750 * time.Millisecond, time.Second}}, "HTTP 503"},
		{"a rate limit, after the wait it asks for", []openAIAnswer{{status: 429, header: map[string]string{"Retry-After": "2"}}}, 2, [][2]time.Duration{{2 * time.Second, 2 * time.Second}}, ""},
		{"a wait given in milliseconds", []openAIAnswer{{status: 429, header: map[string]string{"Retry-After-Ms": "150", "Retry-After": "9"}}}, 2, [][2]time.Duration{{150 * time.Millisecond, 150 * time.Millisecond}}, ""},
		{"a wait of over a minute is not taken", []openAIAnswer{{status: 429, header: map[string]string{"Retry-After": "61"}}}, 2, [][2]time.Duration{{375 * time.Millisecond, 500 * time.Millisecond}}, ""},
		{"a request timeout", []openAIAnswer{{status: 408}}, 2, [][2]time.Duration{{375 * time.Millisecond, 500 * time.Millisecond}}, ""},
		{"a conflict", []openAIAnswer{{status: 409}}, 2, [][2]time.Duration{{375 * time.Millisecond, 500 * time.Millisecond}}, ""},
		{"a refusal the server says to retry", []openAIAnswer{{status: 400, header: map[string]string{"X-Should-Retry": "true"}}}, 2, [][2]time.Duration{{375 * time.Millisecond, 500 * time.Millisecond}}, ""},
		{"not a bad request", []openAIAnswer{{status: 400, body: `{"error":{"message":"bad"}}`}}, 1, nil, "HTTP 400"},
		{"not a bad key", []openAIAnswer{{status: 401}}, 1, nil, "HTTP 401"},
		{"not an error the server says not to retry", []openAIAnswer{{status: 503, header: map[string]string{"X-Should-Retry": "false"}}}, 1, nil, "HTTP 503"},
		{"not an answer that isn't JSON", []openAIAnswer{{body: "<html>"}}, 1, nil, "invalid character"},
	} {
		openai := newFakeOpenAI(t, c.answers...)
		var slept []time.Duration
		_, err := openai.client(&slept).createDecision(context.Background(), someRequest)
		if c.fails == "" && err != nil || c.fails != "" && (err == nil || !strings.Contains(err.Error(), c.fails)) {
			t.Errorf("%s: ended with %v, want %q", c.about, err, c.fails)
		}
		equal(t, len(openai.made()), c.calls, c.about)
		equal(t, len(slept), len(c.waits), c.about)
		for i, wait := range slept {
			if wait < c.waits[i][0] || wait > c.waits[i][1] {
				t.Errorf("%s: wait %d was %v, want %v to %v", c.about, i+1, wait, c.waits[i][0], c.waits[i][1])
			}
		}
	}
}

func TestAnOpenAIAttemptIsGivenUpAfterTenSecondsAndTriedThreeTimes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		attempts := 0
		silent := roundTrip(func(request *http.Request) (*http.Response, error) {
			attempts++
			<-request.Context().Done()
			return nil, request.Context().Err()
		})
		client := &openAI{apiKey: "sk-test", baseURL: openAIURL, http: &http.Client{Transport: silent}, timeout: screenTimeout, sleep: time.Sleep}
		started := time.Now()
		_, err := client.createDecision(t.Context(), someRequest)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("the call ended with %v", err)
		}
		equal(t, attempts, 3)
		// Three attempts of ten seconds, and the two waits between them.
		waited := time.Since(started) - 30*time.Second
		if waited < 1125*time.Millisecond || waited > 1500*time.Millisecond {
			t.Errorf("the waits between attempts took %v", waited)
		}
	})
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

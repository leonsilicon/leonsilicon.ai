package feeds

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	openAIURL = "https://api.openai.com/v1"
	// The TypeScript screener asked the OpenAI SDK for this many more attempts after a failure.
	openAIRetries = 2
)

// openAI calls OpenAI's Decisions API with the timeout and retries the OpenAI SDK gave the
// TypeScript screener: every attempt has its own time limit, and a failure that may pass (no
// answer, a timeout, 408, 409, 429, 5xx) is tried again after a short wait.
type openAI struct {
	apiKey  string
	baseURL string
	http    *http.Client
	// timeout is for one attempt, from the request to the end of the answer.
	timeout time.Duration
	sleep   func(time.Duration)
}

// attemptError is a failed attempt and what the server said about trying again.
type attemptError struct {
	err   error
	retry bool
	// header is the failed answer's headers, when there was an answer.
	header http.Header
}

// jsJSON encodes a value as JavaScript's JSON.stringify does: <, > and & stay as they are, and
// nothing follows the value.
func jsJSON(value any) ([]byte, error) {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(encoded.Bytes(), []byte("\n")), nil
}

func (c *openAI) createDecision(ctx context.Context, request decisionRequest) (map[string]any, error) {
	payload, err := jsJSON(request)
	if err != nil {
		return nil, err
	}
	for retries := 0; ; retries++ {
		decision, failure := c.attempt(ctx, payload)
		if failure == nil {
			return decision, nil
		}
		if !failure.retry || retries == openAIRetries {
			return nil, failure.err
		}
		c.sleep(retryDelay(failure.header, retries))
	}
}

func (c *openAI) attempt(ctx context.Context, payload []byte) (map[string]any, *attemptError) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/decisions", bytes.NewReader(payload))
	if err != nil {
		return nil, &attemptError{err: err}
	}
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, &attemptError{err: fmt.Errorf("OpenAI decisions: %w", err), retry: true}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, &attemptError{
			err:    fmt.Errorf("OpenAI decisions: HTTP %d", response.StatusCode),
			retry:  shouldRetry(response),
			header: response.Header,
		}
	}
	answer, err := io.ReadAll(response.Body)
	if err != nil {
		// Only an answer that ran out of time is worth another attempt.
		timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
		return nil, &attemptError{err: fmt.Errorf("OpenAI decisions: %w", err), retry: timedOut}
	}
	var decision map[string]any
	if err := json.Unmarshal(answer, &decision); err != nil {
		return nil, &attemptError{err: fmt.Errorf("OpenAI decisions: %w", err)}
	}
	return decision, nil
}

func shouldRetry(response *http.Response) bool {
	// If the server explicitly says whether or not to retry, obey.
	switch response.Header.Get("X-Should-Retry") {
	case "true":
		return true
	case "false":
		return false
	}
	switch response.StatusCode {
	case http.StatusRequestTimeout, http.StatusConflict, http.StatusTooManyRequests:
		return true
	}
	return response.StatusCode >= 500
}

// retryDelay is how long to wait before the next attempt: what the server asked for when that is
// at most a minute, and otherwise half a second doubling with each retry (8 seconds at most), less
// up to a quarter so that clients don't retry in step.
func retryDelay(header http.Header, retries int) time.Duration {
	if asked, ok := askedSeconds(header); ok && asked >= 0 && asked <= 60 {
		return time.Duration(asked * float64(time.Second))
	}
	seconds := min(0.5*math.Pow(2, float64(retries)), 8)
	return time.Duration(seconds * (1 - rand.Float64()*0.25) * float64(time.Second))
}

// askedSeconds reads the wait a failed answer asked for, from Retry-After-Ms or Retry-After.
func askedSeconds(header http.Header) (float64, bool) {
	if value := header.Get("Retry-After-Ms"); value != "" {
		if milliseconds, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
			return milliseconds / 1000, true
		}
	}
	value := header.Get("Retry-After")
	if value == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
		return seconds, true
	}
	if at, err := http.ParseTime(value); err == nil {
		return time.Until(at).Seconds(), true
	}
	return 0, false
}

package inbox

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"
)

var httpClient = &http.Client{}

type matrixResponse struct {
	Status int
	// Body is the decoded JSON, or nil when the answer wasn't JSON.
	Body any
	Raw  []byte
}

func (r matrixResponse) object() map[string]any {
	object, _ := r.Body.(map[string]any)
	return object
}

// matrix makes a Matrix request directly: metadata only, never anything encrypted. Unlike the
// library's calls it returns the HTTP status instead of an error, because the tools decide what a
// 404 means.
func (ib *Inbox) matrix(ctx context.Context, method, path string, query map[string]string, data any, timeout time.Duration) (matrixResponse, error) {
	ib.mu.Lock()
	session := ib.session
	ib.mu.Unlock()
	if session == nil {
		return matrixResponse{}, toolError("unavailable", "not signed in")
	}
	target, err := url.Parse(session.Homeserver + path)
	if err != nil {
		return matrixResponse{}, err
	}
	if len(query) > 0 {
		values := target.Query()
		for key, value := range query {
			values.Set(key, value)
		}
		target.RawQuery = values.Encode()
	}
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var body io.Reader
	if data != nil {
		encoded, err := json.Marshal(data)
		if err != nil {
			return matrixResponse{}, err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return matrixResponse{}, err
	}
	req.Header.Set("authorization", "Bearer "+session.AccessToken)
	if data != nil {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return matrixResponse{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return matrixResponse{}, err
	}
	out := matrixResponse{Status: resp.StatusCode, Raw: raw}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out.Body)
	}
	return out, nil
}

func roomPath(roomID string) string {
	return "/_matrix/client/v3/rooms/" + url.PathEscape(roomID)
}

func pathEscape(segment string) string { return url.PathEscape(segment) }

// normalizeJSON returns a value as JSON decoding would give it, so two values can be compared.
func normalizeJSON(value any) any {
	data, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var out any
	if json.Unmarshal(data, &out) != nil {
		return value
	}
	return out
}

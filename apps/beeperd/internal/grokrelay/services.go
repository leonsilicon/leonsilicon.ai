package grokrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
)

// httpDoer is the part of *http.Client the relay uses, so tests can stand in for the network.
type httpDoer interface {
	Do(request *http.Request) (*http.Response, error)
}

// bridgeTimeout bounds one call to slack-puppet or the Grok Bot admin service.
const bridgeTimeout = 45 * time.Second

// httpServices reaches slack-puppet (the task threads) and the Grok Bot admin service (the roster)
// over HTTPS, each with its own bearer token.
type httpServices struct {
	client      httpDoer
	slack       string
	slackToken  string
	roster      string
	rosterToken string
}

// newBridgeServices reads the four settings the bridge can't run without from slack22grokbot.env.
func newBridgeServices(env map[string]string, client httpDoer) (bridgeServices, error) {
	services := &httpServices{client: client}
	for _, setting := range []struct {
		key  string
		into *string
	}{
		{"SLACK_AS_LEON_PUBLIC_ORIGIN", &services.slack},
		{"SLACK_AS_LEON_MCP_TOKEN", &services.slackToken},
		{"GROK_BOT_ROSTER_PUBLIC_ORIGIN", &services.roster},
		{"GROK_BOT_ROSTER_MCP_TOKEN", &services.rosterToken},
	} {
		if *setting.into = handoff.TrimSpace(env[setting.key]); *setting.into == "" {
			return bridgeServices{}, errors.New("slack22grokbot needs " + setting.key)
		}
	}
	return bridgeServices{slack: services, roster: services}, nil
}

// request posts JSON and reads the JSON answer into result. A refusal carries the service's own
// "error" text when it gives one.
func (s *httpServices) request(ctx context.Context, url, token string, body, result any) error {
	var payload bytes.Buffer
	encoder := json.NewEncoder(&payload)
	// The text goes to Slack as it is, so it isn't escaped for HTML on the way.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, bridgeTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bytes.TrimSuffix(payload.Bytes(), []byte("\n"))))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	var refusal struct {
		Error any `json:"error"`
	}
	if err := json.Unmarshal(data, &refusal); err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		if message, ok := refusal.Error.(string); ok && message != "" {
			return errors.New(message)
		}
		return fmt.Errorf("Bridge HTTP %d", response.StatusCode)
	}
	return json.Unmarshal(data, result)
}

func (s *httpServices) thread(ctx context.Context, thread handoff.SlackThread, after string) (slackThreadPage, error) {
	var page slackThreadPage
	err := s.request(ctx, s.slack+"/slack22grokbot/thread", s.slackToken, struct {
		handoff.SlackThread
		After string `json:"after,omitempty"`
	}{thread, after}, &page)
	return page, err
}

func (s *httpServices) mirror(ctx context.Context, thread handoff.SlackThread, post mirrorPost) (string, error) {
	var posted struct {
		TS string `json:"ts"`
	}
	err := s.request(ctx, s.slack+"/slack22grokbot/message", s.slackToken, struct {
		handoff.SlackThread
		Bot        string `json:"bot"`
		EventID    string `json:"eventId"`
		Text       string `json:"text"`
		RetrySince string `json:"retrySince,omitempty"`
		SlackTS    string `json:"slackTs,omitempty"`
	}{thread, post.Bot, post.EventID, post.Text, post.RetrySince, post.SlackTS}, &posted)
	return posted.TS, err
}

// rosterAnswer is what a tool of the Grok Bot admin service says, inside its MCP envelope.
type rosterAnswer struct {
	OK      any             `json:"ok"`
	Error   any             `json:"error"`
	Refused any             `json:"refused"`
	Bots    json.RawMessage `json:"bots"`
}

// rosterCall runs one tool of the Grok Bot admin service, a stateless MCP server.
func (s *httpServices) rosterCall(ctx context.Context, name string, args map[string]any) (rosterAnswer, error) {
	type params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	var envelope struct {
		Result struct {
			Content []struct {
				Text *string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	err := s.request(ctx, s.roster+"/mcp", s.rosterToken, struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int    `json:"id"`
		Method  string `json:"method"`
		Params  params `json:"params"`
	}{"2.0", 1, "tools/call", params{name, args}}, &envelope)
	if err != nil {
		return rosterAnswer{}, err
	}
	text := "{}"
	if content := envelope.Result.Content; len(content) > 0 && content[0].Text != nil {
		text = *content[0].Text
	}
	var answer rosterAnswer
	if err := json.Unmarshal([]byte(text), &answer); err != nil {
		return rosterAnswer{}, err
	}
	if answer.OK != true {
		for _, reason := range []any{answer.Error, answer.Refused} {
			if reason != nil {
				return rosterAnswer{}, errors.New(fmt.Sprint(reason))
			}
		}
		return rosterAnswer{}, errors.New("Grok Bot admin refused " + name)
	}
	return answer, nil
}

func (s *httpServices) list(ctx context.Context) ([]rosterBot, error) {
	answer, err := s.rosterCall(ctx, "grok_bots_list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var bots []rosterBot
	if !bytes.HasPrefix(bytes.TrimSpace(answer.Bots), []byte("[")) || json.Unmarshal(answer.Bots, &bots) != nil {
		return nil, errors.New("Grok Bot admin returned no roster")
	}
	return bots, nil
}

func (s *httpServices) remove(ctx context.Context, id string) error {
	_, err := s.rosterCall(ctx, "grok_bot_delete", map[string]any{"bot": id})
	return err
}

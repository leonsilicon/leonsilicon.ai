package feeds

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	slackURL = "https://slack.com/api"
	// slackTimeout is for one call, from the request to the end of the answer.
	slackTimeout = 20 * time.Second
)

// slackError is Slack refusing a call, with Slack's own error code.
type slackError struct {
	method string
	code   string
}

func (e *slackError) Error() string {
	return "Slack " + e.method + ": " + e.code
}

// slackPoster is the slice of Slack the feed uses, so tests can pass a fake.
type slackPoster interface {
	// post sends text with link and media previews off, so Slack never fetches a link from a feed
	// message.
	post(ctx context.Context, channel, text string) error
	// ensureChannel returns the ID of a channel given its ID or name. With create, a missing public
	// channel is created (or unarchived) with the purpose, and the invited users are added to it.
	ensureChannel(ctx context.Context, nameOrID string, options channelOptions) (string, error)
}

type channelOptions struct {
	create  bool
	purpose string
	invite  []string
}

// slackBot is Slack as the feed bot. Its scopes: chat:write, chat:write.public, channels:read,
// groups:read and channels:manage.
type slackBot struct {
	token   string
	baseURL string
	http    *http.Client
	sleep   func(time.Duration)
}

// param is one form field of a Slack call. They are sent in the order given.
type param struct{ key, value string }

// formEscaper turns Go's form encoding into the one JavaScript's URLSearchParams writes, which
// leaves * alone and escapes ~, so a call's body is the same bytes the TypeScript bot sent.
var formEscaper = strings.NewReplacer("%2A", "*", "~", "%7E")

// call makes one Slack Web API call and returns Slack's answer. A rate limit of ten seconds or less
// is waited out once.
func (s *slackBot) call(ctx context.Context, method string, params ...param) (map[string]any, error) {
	fields := make([]string, len(params))
	for i, field := range params {
		fields[i] = formEscaper.Replace(url.QueryEscape(field.key) + "=" + url.QueryEscape(field.value))
	}
	form := strings.Join(fields, "&")
	data, wait, err := s.attempt(ctx, method, form)
	if wait != nil {
		if !(*wait <= 10) {
			return nil, &slackError{method, "ratelimited"}
		}
		s.sleep(time.Duration(max(*wait, 0) * float64(time.Second)))
		if data, wait, err = s.attempt(ctx, method, form); wait != nil {
			return nil, &slackError{method, "ratelimited"}
		}
	}
	return data, err
}

// attempt sends the call once. wait is set when Slack answered 429: the seconds it asked for.
func (s *slackBot) attempt(ctx context.Context, method, form string) (data map[string]any, wait *float64, err error) {
	ctx, cancel := context.WithTimeout(ctx, slackTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+"/"+method, strings.NewReader(form))
	if err != nil {
		return nil, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+s.token)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8")
	response, err := s.http.Do(request)
	if err != nil {
		return nil, nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		seconds := retryAfter(response.Header)
		return nil, &seconds, nil
	}
	status := "http_" + strconv.Itoa(response.StatusCode)
	body, err := io.ReadAll(response.Body)
	if err != nil || json.Unmarshal(body, &data) != nil || data == nil {
		return nil, nil, &slackError{method, status}
	}
	if data["ok"] != true {
		if code, isString := data["error"].(string); isString {
			return nil, nil, &slackError{method, code}
		}
		return nil, nil, &slackError{method, status}
	}
	return data, nil, nil
}

// retryAfter is the seconds a 429 asked for: one when it doesn't say, and not a number when it
// can't be read, which no wait is short enough for.
func retryAfter(header http.Header) float64 {
	values := header.Values("Retry-After")
	if len(values) == 0 {
		return 1
	}
	value := strings.TrimSpace(strings.Join(values, ", "))
	if value == "" {
		return 0
	}
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return math.NaN()
	}
	return seconds
}

type conversation struct {
	id       string
	archived bool
}

// find looks a channel up by name among the channels the bot can see, archived ones included.
func (s *slackBot) find(ctx context.Context, name string) (*conversation, error) {
	// Names are compared in lowercase, as the TypeScript bot compared them. strings.EqualFold would
	// also match letters that merely fold together.
	wanted := strings.ToLower(name)
	cursor := ""
	for {
		params := []param{{"types", "public_channel,private_channel"}, {"exclude_archived", "false"}, {"limit", "1000"}}
		if cursor != "" {
			params = append(params, param{"cursor", cursor})
		}
		page, err := s.call(ctx, "conversations.list", params...)
		if err != nil {
			return nil, err
		}
		channels, _ := page["channels"].([]any)
		for _, channel := range channels {
			channel, _ := channel.(map[string]any)
			if listed, named := channel["name"].(string); named && strings.ToLower(listed) == wanted {
				id, _ := channel["id"].(string)
				return &conversation{id: id, archived: channel["is_archived"] == true}, nil
			}
		}
		metadata, _ := page["response_metadata"].(map[string]any)
		cursor, _ = metadata["next_cursor"].(string)
		if cursor == "" {
			return nil, nil
		}
	}
}

func (s *slackBot) post(ctx context.Context, channel, text string) error {
	data, err := s.call(ctx, "chat.postMessage",
		param{"channel", channel},
		param{"text", text},
		param{"unfurl_links", "false"},
		param{"unfurl_media", "false"},
	)
	if err != nil {
		return err
	}
	if _, sent := data["ts"].(string); !sent {
		return &slackError{"chat.postMessage", "no_ts"}
	}
	return nil
}

var channelID = regexp.MustCompile(`^[CG][A-Z0-9]{6,}$`)

func (s *slackBot) ensureChannel(ctx context.Context, nameOrID string, options channelOptions) (string, error) {
	wanted := strings.TrimPrefix(trim(nameOrID), "#")
	if channelID.MatchString(wanted) {
		return wanted, nil
	}
	existing, err := s.find(ctx, wanted)
	if err != nil {
		return "", err
	}
	if existing != nil && existing.id != "" && !existing.archived {
		return existing.id, nil
	}
	if !options.create {
		return "", &slackError{"conversations.list", "no channel #" + wanted}
	}
	var id string
	if existing != nil && existing.id != "" {
		if _, err := s.call(ctx, "conversations.unarchive", param{"channel", existing.id}); err != nil {
			return "", err
		}
		id = existing.id
	} else {
		created, err := s.call(ctx, "conversations.create", param{"name", strings.ToLower(wanted)})
		if err != nil {
			return "", err
		}
		channel, _ := created["channel"].(map[string]any)
		if id, _ = channel["id"].(string); id == "" {
			return "", &slackError{"conversations.create", "no_id"}
		}
	}
	// A channel without its purpose or its members still takes posts, so neither failure stops the
	// delivery. The invitation can also fail because Hermes's slack-auto-join plugin joined first.
	_, _ = s.call(ctx, "conversations.setPurpose", param{"channel", id}, param{"purpose", options.purpose})
	var users []string
	for _, user := range options.invite {
		if user != "" && !slices.Contains(users, user) {
			users = append(users, user)
		}
	}
	if len(users) > 0 {
		_, _ = s.call(ctx, "conversations.invite", param{"channel", id}, param{"users", strings.Join(users, ",")}, param{"force", "true"})
	}
	return id, nil
}

package feeds

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

type slackCall struct {
	method        string
	body          string
	authorization string
	contentType   string
}

type slackAnswer struct {
	status int
	header map[string]string
	body   string
}

// fakeSlack is a local Slack Web API. It answers {"ok":true} unless answer says otherwise.
type fakeSlack struct {
	server *httptest.Server
	mu     sync.Mutex
	calls  []slackCall
	answer func(call slackCall, form url.Values) *slackAnswer
	// seen gets every call, for tests that wait for one.
	seen chan slackCall
}

func newFakeSlack(t *testing.T) *fakeSlack {
	slack := &fakeSlack{seen: make(chan slackCall, 100)}
	slack.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		call := slackCall{
			method:        strings.TrimPrefix(request.URL.Path, "/"),
			body:          string(body),
			authorization: request.Header.Get("Authorization"),
			contentType:   request.Header.Get("Content-Type"),
		}
		if request.Method != http.MethodPost {
			t.Errorf("Slack was called with %s", request.Method)
		}
		form, _ := url.ParseQuery(call.body)
		slack.mu.Lock()
		slack.calls = append(slack.calls, call)
		answer := slack.answer
		slack.mu.Unlock()
		reply := &slackAnswer{body: `{"ok":true}`}
		if answer != nil {
			if scripted := answer(call, form); scripted != nil {
				reply = scripted
			}
		}
		for key, value := range reply.header {
			writer.Header().Set(key, value)
		}
		if reply.status != 0 {
			writer.WriteHeader(reply.status)
		}
		io.WriteString(writer, reply.body)
		slack.seen <- call
	}))
	t.Cleanup(slack.server.Close)
	return slack
}

// made returns the calls so far as "method body" lines.
func (s *fakeSlack) made() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var lines []string
	for _, call := range s.calls {
		lines = append(lines, call.method+" "+call.body)
	}
	return lines
}

// bot is a Slack bot that talks to the fake and records its waits instead of sleeping.
func (s *fakeSlack) bot(slept *[]time.Duration) *slackBot {
	return &slackBot{
		token:   "xoxb-test",
		baseURL: s.server.URL,
		http:    s.server.Client(),
		sleep:   func(wait time.Duration) { *slept = append(*slept, wait) },
	}
}

func slackCode(err error) string {
	var refused *slackError
	if errors.As(err, &refused) {
		return refused.code
	}
	return ""
}

func TestPostsToSlackWithPreviewsOff(t *testing.T) {
	slack := newFakeSlack(t)
	slack.answer = func(slackCall, url.Values) *slackAnswer {
		return &slackAnswer{body: `{"ok":true,"ts":"1700000000.000100"}`}
	}
	var slept []time.Duration
	if err := slack.bot(&slept).post(context.Background(), "C0123456", "hi &lt;!channel&gt; ~*x*~\nline two · 你好"); err != nil {
		t.Fatal(err)
	}
	equal(t, slack.calls, []slackCall{{
		method: "chat.postMessage",
		// The same bytes as JavaScript's URLSearchParams wrote, fields in the same order.
		body:          "channel=C0123456&text=hi+%26lt%3B%21channel%26gt%3B+%7E*x*%7E%0Aline+two+%C2%B7+%E4%BD%A0%E5%A5%BD&unfurl_links=false&unfurl_media=false",
		authorization: "Bearer xoxb-test",
		contentType:   "application/x-www-form-urlencoded;charset=UTF-8",
	}})
	equal(t, len(slept), 0)
}

func TestSlackRefusalsCarrySlacksErrorCode(t *testing.T) {
	for _, c := range []struct {
		answer slackAnswer
		code   string
	}{
		{slackAnswer{body: `{"ok":false,"error":"channel_not_found"}`}, "channel_not_found"},
		{slackAnswer{body: `{"ok":false}`}, "http_200"},
		{slackAnswer{status: 502, body: "<html>Bad Gateway</html>"}, "http_502"},
		{slackAnswer{status: 500, body: `{"ok":false,"error":"internal_error"}`}, "internal_error"},
		{slackAnswer{body: `null`}, "http_200"},
		{slackAnswer{body: `[]`}, "http_200"},
		{slackAnswer{body: ``}, "http_200"},
		{slackAnswer{body: `{"ok":true}`}, "no_ts"},
		{slackAnswer{body: `{"ok":true,"ts":17}`}, "no_ts"},
	} {
		slack := newFakeSlack(t)
		slack.answer = func(slackCall, url.Values) *slackAnswer { return &c.answer }
		var slept []time.Duration
		err := slack.bot(&slept).post(context.Background(), "C0123456", "hi")
		equal(t, slackCode(err), c.code, c.answer.body)
		if err.Error() != "Slack chat.postMessage: "+c.code {
			t.Errorf("the error reads %q", err)
		}
	}
}

func TestWaitsOutAShortSlackRateLimitOnce(t *testing.T) {
	for _, c := range []struct {
		about string
		// retryAfter is the header of each 429 in a row; "-" stands for no header.
		retryAfter []string
		calls      int
		slept      []time.Duration
		code       string
	}{
		{"waits as long as Slack asks", []string{"2"}, 2, []time.Duration{2 * time.Second}, ""},
		{"waits a second when Slack doesn't say", []string{"-"}, 2, []time.Duration{time.Second}, ""},
		{"waits up to ten seconds", []string{"10"}, 2, []time.Duration{10 * time.Second}, ""},
		{"takes fractions", []string{"0.5"}, 2, []time.Duration{500 * time.Millisecond}, ""},
		{"doesn't wait for an empty header", []string{""}, 2, []time.Duration{0}, ""},
		{"gives up on a longer wait", []string{"11"}, 1, nil, "ratelimited"},
		{"gives up on a wait it can't read", []string{"soon"}, 1, nil, "ratelimited"},
		{"tries again only once", []string{"1", "1"}, 2, []time.Duration{time.Second}, "ratelimited"},
	} {
		slack := newFakeSlack(t)
		limited := c.retryAfter
		slack.answer = func(slackCall, url.Values) *slackAnswer {
			if len(limited) == 0 {
				return &slackAnswer{body: `{"ok":true,"ts":"1"}`}
			}
			answer := &slackAnswer{status: 429, header: map[string]string{}, body: `{"ok":false,"error":"ratelimited"}`}
			if limited[0] != "-" {
				answer.header["Retry-After"] = limited[0]
			}
			limited = limited[1:]
			return answer
		}
		var slept []time.Duration
		err := slack.bot(&slept).post(context.Background(), "C0123456", "hi")
		equal(t, slackCode(err), c.code, c.about)
		equal(t, len(slack.calls), c.calls, c.about)
		equal(t, slept, c.slept, c.about)
	}
}

func TestASlackCallIsGivenUpAfterTwentySeconds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		bot := &slackBot{token: "xoxb-test", baseURL: slackURL, sleep: time.Sleep, http: &http.Client{Transport: neverAnswers{}}}
		started := time.Now()
		err := bot.post(t.Context(), "C0123456", "hi")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("the call ended with %v", err)
		}
		equal(t, time.Since(started), 20*time.Second)
	})
}

// neverAnswers is a server that takes a request and stays silent until the caller gives up.
type neverAnswers struct{}

func (neverAnswers) RoundTrip(request *http.Request) (*http.Response, error) {
	<-request.Context().Done()
	return nil, request.Context().Err()
}

// channelPages answers conversations.list with the pages given, one per call.
func channelPages(pages ...string) func(slackCall, url.Values) *slackAnswer {
	return func(call slackCall, _ url.Values) *slackAnswer {
		if call.method != "conversations.list" || len(pages) == 0 {
			return nil
		}
		page := pages[0]
		pages = pages[1:]
		return &slackAnswer{body: page}
	}
}

const listChannels = "conversations.list types=public_channel%2Cprivate_channel&exclude_archived=false&limit=1000"

func TestAChannelIDNeedsNoLookup(t *testing.T) {
	slack := newFakeSlack(t)
	var slept []time.Duration
	for _, id := range []string{"C0FLAGGED01", " #G0123ABC ", "C123456"} {
		got, err := slack.bot(&slept).ensureChannel(context.Background(), id, channelOptions{})
		if err != nil {
			t.Fatal(err)
		}
		equal(t, got, strings.TrimPrefix(strings.TrimSpace(id), "#"))
	}
	equal(t, len(slack.calls), 0)
}

func TestFindsAChannelByNameAcrossPages(t *testing.T) {
	slack := newFakeSlack(t)
	slack.answer = channelPages(
		`{"ok":true,"channels":[{"id":"C0000000001","name":"general"}],"response_metadata":{"next_cursor":"page two="}}`,
		`{"ok":true,"channels":[{"id":"C0000000002","name":"Feed-Spam","is_archived":false}],"response_metadata":{"next_cursor":""}}`,
	)
	var slept []time.Duration
	id, err := slack.bot(&slept).ensureChannel(context.Background(), "#feed-spam", channelOptions{})
	if err != nil {
		t.Fatal(err)
	}
	equal(t, id, "C0000000002")
	equal(t, slack.made(), []string{listChannels, listChannels + "&cursor=page+two%3D"})
}

func TestAMissingChannelIsAnErrorUnlessTheFeedMayCreateIt(t *testing.T) {
	slack := newFakeSlack(t)
	slack.answer = channelPages(`{"ok":true,"channels":[{"id":"C0000000001","name":"general"}]}`)
	var slept []time.Duration
	_, err := slack.bot(&slept).ensureChannel(context.Background(), "feed-flagged", channelOptions{})
	equal(t, slackCode(err), "no channel #feed-flagged")
	equal(t, slack.made(), []string{listChannels})

	// An archived channel doesn't count either.
	slack = newFakeSlack(t)
	slack.answer = channelPages(`{"ok":true,"channels":[{"id":"C0000000003","name":"feed-flagged","is_archived":true}]}`)
	_, err = slack.bot(&slept).ensureChannel(context.Background(), "feed-flagged", channelOptions{})
	equal(t, slackCode(err), "no channel #feed-flagged")
}

func TestCreatesAMissingChannelWithItsPurposeAndMembers(t *testing.T) {
	slack := newFakeSlack(t)
	slack.answer = func(call slackCall, _ url.Values) *slackAnswer {
		switch call.method {
		case "conversations.list":
			return &slackAnswer{body: `{"ok":true,"channels":[]}`}
		case "conversations.create":
			return &slackAnswer{body: `{"ok":true,"channel":{"id":"C0NEWFEED1","name":"feed-whatsapp"}}`}
		}
		return nil
	}
	var slept []time.Duration
	id, err := slack.bot(&slept).ensureChannel(context.Background(), "Feed-WhatsApp", channelOptions{
		create:  true,
		purpose: "Screened messages from Beeper · whatsapp",
		invite:  []string{"U1", "", "U2", "U1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	equal(t, id, "C0NEWFEED1")
	equal(t, slack.made(), []string{
		listChannels,
		"conversations.create name=feed-whatsapp",
		"conversations.setPurpose channel=C0NEWFEED1&purpose=Screened+messages+from+Beeper+%C2%B7+whatsapp",
		"conversations.invite channel=C0NEWFEED1&users=U1%2CU2&force=true",
	})
}

func TestUnarchivesAnArchivedChannelInsteadOfCreatingIt(t *testing.T) {
	slack := newFakeSlack(t)
	slack.answer = channelPages(`{"ok":true,"channels":[{"id":"C0000000003","name":"feed-whatsapp","is_archived":true}]}`)
	var slept []time.Duration
	id, err := slack.bot(&slept).ensureChannel(context.Background(), "feed-whatsapp", channelOptions{create: true, purpose: "p"})
	if err != nil {
		t.Fatal(err)
	}
	equal(t, id, "C0000000003")
	equal(t, slack.made(), []string{
		listChannels,
		"conversations.unarchive channel=C0000000003",
		"conversations.setPurpose channel=C0000000003&purpose=p",
	})
}

func TestAChannelWithoutItsPurposeOrMembersStillCounts(t *testing.T) {
	slack := newFakeSlack(t)
	slack.answer = func(call slackCall, _ url.Values) *slackAnswer {
		switch call.method {
		case "conversations.list":
			return &slackAnswer{body: `{"ok":true,"channels":[]}`}
		case "conversations.create":
			return &slackAnswer{body: `{"ok":true,"channel":{"id":"C0NEWFEED1"}}`}
		case "conversations.setPurpose":
			return &slackAnswer{body: `{"ok":false,"error":"missing_scope"}`}
		case "conversations.invite":
			return &slackAnswer{body: `{"ok":false,"error":"already_in_channel"}`}
		}
		return nil
	}
	var slept []time.Duration
	id, err := slack.bot(&slept).ensureChannel(context.Background(), "feed-x", channelOptions{create: true, invite: []string{"U1"}})
	if err != nil {
		t.Fatal(err)
	}
	equal(t, id, "C0NEWFEED1")
	equal(t, len(slack.calls), 4)
}

func TestAChannelSlackWontCreateIsAnError(t *testing.T) {
	for _, c := range []struct{ created, code string }{
		{`{"ok":false,"error":"name_taken"}`, "name_taken"},
		{`{"ok":true,"channel":{}}`, "no_id"},
		{`{"ok":true}`, "no_id"},
	} {
		slack := newFakeSlack(t)
		slack.answer = func(call slackCall, _ url.Values) *slackAnswer {
			switch call.method {
			case "conversations.list":
				return &slackAnswer{body: `{"ok":true,"channels":[]}`}
			case "conversations.create":
				return &slackAnswer{body: c.created}
			}
			return nil
		}
		var slept []time.Duration
		_, err := slack.bot(&slept).ensureChannel(context.Background(), "feed-x", channelOptions{create: true})
		equal(t, slackCode(err), c.code)
		equal(t, len(slack.calls), 2, "nothing follows a channel that wasn't created")
	}
}

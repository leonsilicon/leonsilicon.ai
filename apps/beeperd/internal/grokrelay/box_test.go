package grokrelay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The first six tests are the cases of slack22grokbot/__tests__/grok-box.test.ts. The rest pin down
// what the keeper's author asked to be kept: where its settings and files live, what the setup pins,
// when a join key is made, and how the health check talks to `tailscale nc`.

const boxCommit = "7508f60af76104d31450f3b599138d0581ea8179"

func sha(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// fakeTailscaleEnv makes this test binary stand in for the tailscale command (see TestMain).
const fakeTailscaleEnv = "GROKRELAY_FAKE_TAILSCALE_NC"

// TestMain lets the test binary run as `tailscale nc`: the health check starts a real child process,
// and this is the child. Like the real `tailscale nc`, it drops the connection as soon as its stdin
// ends.
func TestMain(m *testing.M) {
	if os.Getenv(fakeTailscaleEnv) != "" {
		connection, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", os.Args[len(os.Args)-1]))
		if err != nil {
			os.Exit(1)
		}
		go func() {
			_, _ = io.Copy(connection, os.Stdin)
			connection.Close()
			os.Exit(0)
		}()
		_, _ = io.Copy(os.Stdout, connection)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type tailscaleRequest struct {
	path, authorization, contentType, body string
}

// boxWorld is a Grok box that is up or down, on the tailnet or off it, with a fake clock.
type boxWorld struct {
	settings *boxSettings
	keeper   *boxKeeper
	logs     logBook

	mu          sync.Mutex
	healthy     bool
	online      bool
	statusFails bool
	head        string
	keys        int
	now         int64
	commands    [][]string
	api         []tailscaleRequest
}

func newBoxWorld(t *testing.T) *boxWorld {
	home := t.TempDir()
	w := &boxWorld{
		online: true,
		head:   boxCommit + "\n",
		now:    1_800_000_000_000,
		settings: &boxSettings{
			token:       "tok",
			host:        "grok-box",
			port:        "9400",
			tailscale:   "/ts",
			socket:      "/ts.sock",
			oauthID:     "cid",
			oauthSecret: "csecret",
			pluginDir:   "/opt/data/plugins/leon/grok_box_browser",
			shared:      filepath.Join(home, "shared"),
		},
	}
	files := map[string]string{
		"/opt/data/plugins/leon/grok_box_browser/box/up.sh":      "up",
		"/opt/data/plugins/leon/grok_box_browser/box/broker.mjs": "broker",
	}
	// The Tailscale API, on this machine.
	api := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		w.mu.Lock()
		defer w.mu.Unlock()
		w.api = append(w.api, tailscaleRequest{request.URL.Path, request.Header.Get("Authorization"), request.Header.Get("Content-Type"), string(body)})
		if strings.HasSuffix(request.URL.Path, "/oauth/token") {
			_, _ = io.WriteString(response, `{"access_token":"at"}`)
			return
		}
		w.keys++
		_, _ = io.WriteString(response, `{"key":"tskey-auth-`+strconv.Itoa(w.keys)+`"}`)
	}))
	t.Cleanup(api.Close)
	deps := boxDeps{
		exec: func(_ context.Context, file string, args []string) (string, error) {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.commands = append(w.commands, append([]string{file}, args...))
			if file == "git" {
				return w.head, nil
			}
			if file != "/ts" || !reflect.DeepEqual(args, []string{"--socket=/ts.sock", "status", "--json"}) {
				t.Errorf("ran %s %v", file, args)
			}
			if w.statusFails {
				return "", errors.New("tailscaled is not running")
			}
			if w.online {
				return `{"Peer":{"k":{"HostName":"grok-box","Online":true}}}`, nil
			}
			return `{"Peer":{}}`, nil
		},
		nc: func(context.Context, *boxSettings, string, time.Duration) string {
			w.mu.Lock()
			defer w.mu.Unlock()
			if w.healthy {
				return "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}"
			}
			return ""
		},
		client:       api.Client(),
		tailscaleAPI: api.URL,
		readFile: func(path string) ([]byte, error) {
			if content, held := files[path]; held {
				return []byte(content), nil
			}
			return os.ReadFile(path)
		},
		now: func() int64 {
			w.mu.Lock()
			defer w.mu.Unlock()
			return w.now
		},
	}
	w.keeper = newBoxKeeper(filepath.Join(home, "state", "grok-box.json"), w.logs.log, func() *boxSettings { return w.settings }, deps)
	return w
}

func (w *boxWorld) set(change func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	change()
}

func (w *boxWorld) advance(elapsed time.Duration) {
	w.set(func() { w.now += elapsed.Milliseconds() })
}

// request leaves a repair request, as the plugin does when Hermes's browser can't reach the box.
func (w *boxWorld) request(t *testing.T) {
	t.Helper()
	// the plugin makes the folder with its first request
	if err := os.MkdirAll(w.settings.shared, 0o755); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	data, _ := json.Marshal(map[string]any{"at": w.now})
	w.mu.Unlock()
	if err := os.WriteFile(filepath.Join(w.settings.shared, "repair-request.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// status reads repair-status.json, which the plugin turns into what Hermes is told.
func (w *boxWorld) status(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(w.settings.shared, "repair-status.json"))
	if err != nil {
		t.Fatal(err)
	}
	var status map[string]any
	if err := json.Unmarshal(data, &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func mustContain(t *testing.T, text, part string) {
	t.Helper()
	if !strings.Contains(text, part) {
		t.Errorf("%q does not contain %q", text, part)
	}
}

func TestTheSetupPinsTheMirrorCommitAndChecksumsWithAJoinKeyOnlyWhenNeeded(t *testing.T) {
	pinned := release{commit: boxCommit, up: sha("up"), broker: sha("broker")}
	plainSetup := setupCommand(pinned, "tok", "")
	mustMatch(t, plainSetup, `^bash -euo pipefail <<'SETUP'\n`)
	mustContain(t, plainSetup, "/leonsiliconAI/hermes-plugin-leon/"+boxCommit+"/grok_box_browser/box")
	mustContain(t, plainSetup, sha("up")+" "+sha("broker")+" | sha256sum -c -")
	mustContain(t, plainSetup, "printf %s 'tok' > ../token\n")
	if strings.Contains(plainSetup, "tailscale-authkey") {
		t.Error("a setup with no join key writes one")
	}
	mustContain(t, setupCommand(pinned, "tok", "tskey-1"), "printf %s 'tskey-1' > ../tailscale-authkey")
}

func TestSettingsComeFromHermessEnvAndNothingHappensWithoutTheToken(t *testing.T) {
	home := t.TempDir()
	env := func(hermesHome string) func(string) string {
		return func(key string) string {
			if key == "HERMES_HOME" {
				return hermesHome
			}
			return ""
		}
	}
	write := func(content string) {
		if err := os.WriteFile(filepath.Join(home, ".env"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("GROK_BOX_BROWSER_HOST=grok-box-2\n")
	if loadBoxSettings(env(home)) != nil {
		t.Error("the box is configured without its token")
	}
	write("GROK_BOX_BROWSER_TOKEN=tok\nGROK_BOX_TS_OAUTH_CLIENT_ID=cid\n")
	settings := loadBoxSettings(env(home))
	if settings == nil {
		t.Fatal("the token did not configure the box")
	}
	mustEqual(t, settings.host, "grok-box")
	mustEqual(t, settings.oauthID, "cid")
	mustEqual(t, settings.tailscale, filepath.Join(home, "orca-device/tailscale/bin/tailscale"))
	if loadBoxSettings(env(filepath.Join(home, "missing"))) != nil {
		t.Error("the box is configured without a .env")
	}
}

func TestWhileTheBoxIsDownOneMessageEvery30MinutesCarriesTheSetup(t *testing.T) {
	w := newBoxWorld(t)
	ctx := context.Background()
	w.set(func() { w.healthy = true })
	mustEqual(t, w.keeper.upkeep(ctx), "")
	w.set(func() { w.healthy = false })
	w.advance(2 * time.Minute) // past the health cache
	block := w.keeper.upkeep(ctx)
	mustMatch(t, block, `^\[Before anything else, yourself\]`)
	mustContain(t, block, boxCommit)
	if strings.Contains(block, "tailscale-authkey") {
		t.Error("the box is still on the tailnet, and the setup carries a join key")
	}
	mustEqual(t, w.keeper.upkeep(ctx), "")
	// Off the tailnet: the setup carries a fresh one-time key.
	w.advance(31 * time.Minute)
	w.set(func() { w.online = false })
	mustContain(t, w.keeper.upkeep(ctx), "printf %s 'tskey-auth-1' > ../tailscale-authkey")
}

func TestARepairRequestFromThePluginSendsTheSetupToTheParentBotOnceAnHourAndIsVerified(t *testing.T) {
	w := newBoxWorld(t)
	ctx := context.Background()
	type sentMessage struct{ bot, text string }
	var sent []sentMessage
	send := func(_ context.Context, bot, text string) error {
		sent = append(sent, sentMessage{bot, text})
		return nil
	}
	tick := func() {
		t.Helper()
		if err := w.keeper.tick(ctx, send); err != nil {
			t.Fatal(err)
		}
	}
	tick()
	mustEqual(t, len(sent), 0, "no request, no repair")

	w.request(t)
	w.advance(time.Second)
	tick()
	mustEqual(t, len(sent), 1)
	mustEqual(t, sent[0].bot, repairBot)
	mustMatch(t, sent[0].text, `^Run this in your own cloud computer's terminal`)
	mustEqual(t, w.status(t)["result"], any("sent"))
	// The status has exactly the fields the plugin reads.
	wantStatus := map[string]any{"repairAt": 1_800_000_001_000.0, "failures": 0.0, "result": "sent", "detail": nil}
	if status := w.status(t); !reflect.DeepEqual(status, wantStatus) {
		t.Errorf("repair-status.json = %v, want %v", status, wantStatus)
	}

	// Still down five minutes later: a failure. Another request within the hour waits.
	w.advance(5 * time.Minute)
	w.request(t)
	tick()
	mustEqual(t, w.status(t)["failures"], any(1.0))
	mustEqual(t, w.status(t)["result"], any("failed"))
	mustEqual(t, len(sent), 1)

	// An hour on, the next request repairs again, and this time it works.
	w.advance(60 * time.Minute)
	w.request(t)
	tick()
	mustEqual(t, len(sent), 2)
	w.set(func() { w.healthy = true })
	w.advance(5 * time.Minute)
	tick()
	mustEqual(t, w.status(t)["failures"], any(0.0))
	mustEqual(t, w.status(t)["result"], any("ok"))
}

func TestARepairTheBotCantTakeNowIsRetriedInAFewMinutesAndAHealthyBoxNeedsNone(t *testing.T) {
	w := newBoxWorld(t)
	ctx := context.Background()
	w.keeper.upkeep(ctx) // creates the shared folder
	w.request(t)
	busy := true
	var sent []string
	send := func(_ context.Context, _, text string) error {
		if busy {
			return errors.New("Grok Bot is busy: waiting for a reply")
		}
		sent = append(sent, text)
		return nil
	}
	tick := func() {
		t.Helper()
		if err := w.keeper.tick(ctx, send); err != nil {
			t.Fatal(err)
		}
	}
	w.advance(time.Second)
	tick()
	mustEqual(t, w.keeper.status()["result"], any("skipped"))
	mustEqual(t, w.status(t)["detail"], any("Grok Bot is busy: waiting for a reply"))
	busy = false
	w.advance(time.Minute)
	tick()
	mustEqual(t, len(sent), 0, "waits out the retry delay")
	w.advance(5 * time.Minute)
	tick()
	mustEqual(t, len(sent), 1)

	// The box came back by itself: the request is dropped.
	w.advance(2 * time.Hour)
	w.request(t)
	w.set(func() { w.healthy = true })
	w.advance(time.Second)
	tick()
	mustEqual(t, len(sent), 1)
	if _, err := os.Stat(filepath.Join(w.settings.shared, "repair-request.json")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the request is still there: %v", err)
	}
}

// ncSettings points the health check at a port on this machine, through the fake `tailscale nc`.
func ncSettings(t *testing.T, port string) *boxSettings {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(fakeTailscaleEnv, "1")
	return &boxSettings{token: "tok", host: "grok-box", port: port, tailscale: self, socket: "/ts.sock"}
}

func TestTheHealthCheckKeepsTailscaleNCsStdinOpenUntilTheAnswerIsIn(t *testing.T) {
	// The broker takes a moment to answer. A check that closed stdin after writing the request would
	// lose the connection before then.
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		_, _ = io.WriteString(response, `{"ok":true}`)
	}))
	defer server.Close()
	address, _ := url.Parse(server.URL)
	settings := ncSettings(t, address.Port())
	started := time.Now()
	if !boxHealthy(context.Background(), settings, boxDeps{nc: runNC}) {
		t.Error("the broker answered, and the check says the box is down")
	}
	if waited := time.Since(started); waited > 5*time.Second {
		t.Errorf("answered after %v: it waited for the timeout", waited)
	}
	mustEqual(t, responseComplete("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}"), true)
	mustEqual(t, responseComplete("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok"), false)
}

func TestTheHealthCheckStopsOnceTheWholeAnswerIsInEvenIfTheConnectionStaysOpen(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	asked := make(chan string, 1)
	release := make(chan struct{})
	defer close(release)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		request := make([]byte, 1024)
		length, _ := connection.Read(request)
		asked <- string(request[:length])
		_, _ = io.WriteString(connection, "HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}")
		// The broker never hangs up.
		<-release
	}()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	settings := ncSettings(t, port)
	started := time.Now()
	if !boxHealthy(context.Background(), settings, boxDeps{nc: runNC}) {
		t.Error("the broker answered, and the check says the box is down")
	}
	if waited := time.Since(started); waited > 4*time.Second {
		t.Errorf("answered after %v: it waited for the 8 s timeout", waited)
	}
	mustEqual(t, <-asked, "GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
}

func TestABoxThatDoesNotAnswerIsDown(t *testing.T) {
	// Nothing listens on the port, so the fake tailscale nc exits at once.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	listener.Close()
	if boxHealthy(context.Background(), ncSettings(t, port), boxDeps{nc: runNC}) {
		t.Error("a box nobody answers for is healthy")
	}
	// A tailscale that isn't installed is the same.
	missing := &boxSettings{tailscale: filepath.Join(t.TempDir(), "tailscale"), socket: "/ts.sock", host: "grok-box", port: "9400"}
	if boxHealthy(context.Background(), missing, boxDeps{nc: runNC}) {
		t.Error("a box with no tailscale is healthy")
	}
	// Only a 200 that says ok counts.
	for _, answer := range []string{
		"HTTP/1.1 503 Service Unavailable\r\n\r\n{\"ok\":true}",
		"HTTP/1.1 200 OK\r\n\r\n{\"ok\":false}",
		"",
	} {
		deps := boxDeps{nc: func(context.Context, *boxSettings, string, time.Duration) string { return answer }}
		if boxHealthy(context.Background(), &boxSettings{}, deps) {
			t.Errorf("%q counts as healthy", answer)
		}
	}
}

func TestTheBoxSettingsAreHermessOwnWithItsDefaults(t *testing.T) {
	// Nothing in the environment: Hermes lives in /opt/data, and its .env is read from there.
	envFile := filepath.Join(t.TempDir(), "hermes.env")
	content := strings.Join([]string{
		"GROK_BOX_BROWSER_TOKEN= tok ",
		"GROK_BOX_BROWSER_HOST=box-2",
		"GROK_BOX_BROWSER_PORT=9500",
		"GROK_BOX_TAILSCALE=/usr/bin/tailscale",
		"GROK_BOX_TAILSCALE_SOCKET=/run/tailscaled.sock",
		"GROK_BOX_TS_OAUTH_CLIENT_ID=cid",
		"GROK_BOX_TS_OAUTH_CLIENT_SECRET='csecret'",
		"",
	}, "\n")
	if err := os.WriteFile(envFile, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	onlyEnvFile := func(key string) string {
		if key == "GROK_BOX_ENV_FILE" {
			return envFile
		}
		return ""
	}
	want := &boxSettings{
		token:       "tok",
		host:        "box-2",
		port:        "9500",
		tailscale:   "/usr/bin/tailscale",
		socket:      "/run/tailscaled.sock",
		oauthID:     "cid",
		oauthSecret: "csecret",
		pluginDir:   "/opt/data/plugins/leon/grok_box_browser",
		shared:      "/opt/data/grok-box-browser",
	}
	if got := loadBoxSettings(onlyEnvFile); !reflect.DeepEqual(got, want) {
		t.Errorf("settings = %+v, want %+v", got, want)
	}
	if err := os.WriteFile(envFile, []byte("GROK_BOX_BROWSER_TOKEN=tok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	want = &boxSettings{
		token:     "tok",
		host:      "grok-box",
		port:      "9400",
		tailscale: "/opt/data/orca-device/tailscale/bin/tailscale",
		socket:    "/opt/data/orca-device/tailscale/tailscaled.sock",
		pluginDir: "/opt/data/plugins/leon/grok_box_browser",
		shared:    "/opt/data/grok-box-browser",
	}
	if got := loadBoxSettings(onlyEnvFile); !reflect.DeepEqual(got, want) {
		t.Errorf("default settings = %+v, want %+v", got, want)
	}
}

func TestTheSetupPinsTheInstalledPluginsCommitAndTheSha256OfItsBoxFiles(t *testing.T) {
	w := newBoxWorld(t)
	ctx := context.Background()
	block := w.keeper.upkeep(ctx)
	mustContain(t, block, "base=https://raw.githubusercontent.com/leonsiliconAI/hermes-plugin-leon/"+boxCommit+"/grok_box_browser/box\n")
	mustContain(t, block, `printf '%s  up.sh\n%s  broker.mjs\n' `+sha("up")+" "+sha("broker")+" | sha256sum -c -\n")
	// The commit is the one Hermes has installed: its plugin's git HEAD.
	if want := []string{"git", "-C", "/opt/data/plugins/leon/grok_box_browser", "rev-parse", "HEAD"}; !slices.ContainsFunc(w.commands, func(command []string) bool { return reflect.DeepEqual(command, want) }) {
		t.Errorf("ran %v, want %v among them", w.commands, want)
	}
	mustEqual(t, w.logs.has("grok_box_upkeep"), true)

	// A plugin that isn't a checkout of its mirror has no commit to pin: no setup goes out.
	other := newBoxWorld(t)
	other.set(func() { other.head = "v1.2.3\n" })
	mustEqual(t, other.keeper.upkeep(ctx), "")
	mustEqual(t, other.logs.has("grok_box_upkeep_error"), true)
	other.logs.mu.Lock()
	mustEqual(t, other.logs.entries[0].fields["message"], any("the leon plugin isn't installed from its mirror"))
	other.logs.mu.Unlock()
}

func TestAJoinKeyComesFromTheOAuthClientAndOnlyWhenTheBoxIsOffTheTailnet(t *testing.T) {
	ctx := context.Background()
	// On the tailnet: the Tailscale API is never asked.
	online := newBoxWorld(t)
	if block := online.keeper.upkeep(ctx); block == "" || strings.Contains(block, "tailscale-authkey") {
		t.Errorf("setup for a box on the tailnet: %q", block)
	}
	mustEqual(t, len(online.api), 0)

	// Off the tailnet: one key, made with the GROK_BOX_TS_OAUTH_CLIENT_* client, for tag:grok-box.
	offline := newBoxWorld(t)
	offline.set(func() { offline.online = false })
	mustContain(t, offline.keeper.upkeep(ctx), "umask 077; printf %s 'tok' > ../token; printf %s 'tskey-auth-1' > ../tailscale-authkey\n")
	want := []tailscaleRequest{
		{"/api/v2/oauth/token", "", "application/x-www-form-urlencoded", "client_id=cid&client_secret=csecret&grant_type=client_credentials"},
		{"/api/v2/tailnet/-/keys", "Bearer at", "application/json", `{"description":"grok-box repair","expirySeconds":3600,"capabilities":{"devices":{"create":{"reusable":false,"ephemeral":false,"preauthorized":true,"tags":["tag:grok-box"]}}}}`},
	}
	if !reflect.DeepEqual(offline.api, want) {
		t.Errorf("asked the Tailscale API %+v, want %+v", offline.api, want)
	}

	// Tailscale can't say whether the box is there: no key is spent on a guess.
	unknown := newBoxWorld(t)
	unknown.set(func() { unknown.online, unknown.statusFails = false, true })
	if block := unknown.keeper.upkeep(ctx); block == "" || strings.Contains(block, "tailscale-authkey") {
		t.Errorf("setup when tailscale can't say: %q", block)
	}
	mustEqual(t, len(unknown.api), 0)

	// No OAuth client: the setup still goes out, without a key, and the log says why.
	noClient := newBoxWorld(t)
	noClient.set(func() { noClient.online = false })
	noClient.settings.oauthID, noClient.settings.oauthSecret = "", ""
	if block := noClient.keeper.upkeep(ctx); block == "" || strings.Contains(block, "tailscale-authkey") {
		t.Errorf("setup with no OAuth client: %q", block)
	}
	mustEqual(t, len(noClient.api), 0)
	mustEqual(t, noClient.logs.has("grok_box_key_error"), true)
}

func TestTheFirstPeerWithTheBoxsNameDecidesWhetherItIsOnline(t *testing.T) {
	status := func(output string) (bool, bool) {
		deps := boxDeps{exec: func(context.Context, string, []string) (string, error) { return output, nil }}
		return boxOnline(context.Background(), &boxSettings{host: "grok-box"}, deps)
	}
	for _, c := range []struct {
		output        string
		online, known bool
	}{
		{`{"Peer":{"a":{"HostName":"other","Online":true},"b":{"HostName":"grok-box","Online":true}}}`, true, true},
		{`{"Peer":{"a":{"HostName":"grok-box","Online":false},"b":{"HostName":"grok-box","Online":true}}}`, false, true},
		{`{"Peer":{"a":{"HostName":"localhost","DNSName":"grok-box.tail1234.ts.net.","Online":true}}}`, true, true},
		{`{"Peer":{"a":{"HostName":"grok-box"}}}`, false, true},
		{`{"Peer":null}`, false, true},
		{`{}`, false, true},
		{`not json`, false, false},
	} {
		online, known := status(c.output)
		if online != c.online || known != c.known {
			t.Errorf("%s: online %v, known %v", c.output, online, known)
		}
	}
}

func TestTheKeepersStateSurvivesARestartAndItsStatusFileIsForThePlugin(t *testing.T) {
	w := newBoxWorld(t)
	ctx := context.Background()
	w.request(t)
	w.advance(time.Second)
	if err := w.keeper.tick(ctx, func(context.Context, string, string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	// The keeper's own state is private; the status is for the plugin, in Hermes's shared folder.
	stateFile := w.keeper.stateFile
	info, err := os.Stat(stateFile)
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, info.Mode().Perm(), os.FileMode(0o600))
	var saved map[string]any
	data, _ := os.ReadFile(stateFile)
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	wantSaved := map[string]any{"repairAt": 1_800_000_001_000.0, "verifyAt": 1_800_000_301_000.0, "result": "sent"}
	if !reflect.DeepEqual(saved, wantSaved) {
		t.Errorf("grok-box.json = %v, want %v", saved, wantSaved)
	}
	if _, err := os.Stat(filepath.Join(w.settings.shared, "repair-status.json")); err != nil {
		t.Error(err)
	}
	reopened := newBoxKeeper(stateFile, w.logs.log, func() *boxSettings { return nil }, boxDeps{})
	wantStatus := map[string]any{"configured": false, "repairAt": 1_800_000_001_000.0, "verifyAt": 1_800_000_301_000.0, "result": "sent"}
	if status := reopened.status(); !reflect.DeepEqual(status, wantStatus) {
		t.Errorf("status = %v, want %v", status, wantStatus)
	}
	// Without settings the keeper does nothing at all.
	mustEqual(t, reopened.upkeep(ctx), "")
	if err := reopened.tick(ctx, nil); err != nil {
		t.Error(err)
	}
}

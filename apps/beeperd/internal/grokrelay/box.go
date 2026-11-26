package grokrelay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/envfile"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/handoff"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// The box keeper keeps grok-box-browser (apps/hermes-plugin-leon/grok_box_browser) set up in the Grok Bot
// cloud computer. Every Grok bot runs in that machine, so while its broker is down the relay adds
// the verified setup command to the next message it sends a bot. When Hermes's browser finds the
// box down and no message is going out, the plugin leaves a repair request and the keeper sends the
// setup to the parent bot on its own, at most once an hour.

const (
	healthCacheMS = 60_000
	// upkeepEveryMS: after asking for the setup, give it this long before asking again.
	upkeepEveryMS = 30 * 60_000
	repairEveryMS = 60 * 60_000
	// verifyAfterMS: a repair counts as failed if the broker isn't healthy this long after it was
	// sent.
	verifyAfterMS = 5 * 60_000
	retryAfterMS  = 5 * 60_000
	healthTimeout = 8 * time.Second
	// commandTimeout bounds one git or tailscale command, and one call to the Tailscale API.
	commandTimeout = 20 * time.Second
	commandOutput  = 4 << 20
	boxMirror      = "https://raw.githubusercontent.com/leonsiliconAI/hermes-plugin-leon"
	repairBot      = "Grok Bot"
	tailscaleAPI   = "https://api.tailscale.com"
	healthRequest  = "GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
	// joinKeyRequest asks for a one-time key that joins the tailnet as tag:grok-box, good for an hour.
	joinKeyRequest = `{"description":"grok-box repair","expirySeconds":3600,"capabilities":{"devices":{"create":{"reusable":false,"ephemeral":false,"preauthorized":true,"tags":["tag:grok-box"]}}}}`
)

var (
	contentLength = regexp.MustCompile(`(?i)\r\ncontent-length:\s*(\d+)`)
	healthyStatus = regexp.MustCompile(`^HTTP/1\.[01] 200`)
	fullCommit    = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

type boxSettings struct {
	token string
	host  string
	// port is kept as text: it is only ever an argument of tailscale nc.
	port        string
	tailscale   string
	socket      string
	oauthID     string
	oauthSecret string
	// pluginDir is Hermes's install of the plugin, whose box files the setup pins.
	pluginDir string
	// shared is where the plugin and the keeper leave each other the repair request and status.
	shared string
}

// loadBoxSettings reads the settings from Hermes's own .env (the plugin reads the same keys), or
// returns nil when they are unset. getenv is the daemon's environment.
func loadBoxSettings(getenv func(string) string) *boxSettings {
	hermesHome := getenv("HERMES_HOME")
	if hermesHome == "" {
		hermesHome = "/opt/data"
	}
	envFile := getenv("GROK_BOX_ENV_FILE")
	if envFile == "" {
		envFile = filepath.Join(hermesHome, ".env")
	}
	data, err := os.ReadFile(envFile)
	if err != nil {
		return nil
	}
	env := envfile.Parse(string(data))
	setting := func(key, fallback string) string {
		if value := handoff.TrimSpace(env[key]); value != "" {
			return value
		}
		return fallback
	}
	token := setting("GROK_BOX_BROWSER_TOKEN", "")
	if token == "" {
		return nil
	}
	port := env["GROK_BOX_BROWSER_PORT"]
	if port == "" {
		port = "9400"
	}
	return &boxSettings{
		token:       token,
		host:        setting("GROK_BOX_BROWSER_HOST", "grok-box"),
		port:        formatNumber(jsNumber(port)),
		tailscale:   setting("GROK_BOX_TAILSCALE", filepath.Join(hermesHome, "orca-device/tailscale/bin/tailscale")),
		socket:      setting("GROK_BOX_TAILSCALE_SOCKET", filepath.Join(hermesHome, "orca-device/tailscale/tailscaled.sock")),
		oauthID:     setting("GROK_BOX_TS_OAUTH_CLIENT_ID", ""),
		oauthSecret: setting("GROK_BOX_TS_OAUTH_CLIENT_SECRET", ""),
		pluginDir:   filepath.Join(hermesHome, "plugins/leon/grok_box_browser"),
		shared:      filepath.Join(hermesHome, "grok-box-browser"),
	}
}

// release is the installed plugin's commit and the sha256 of its box files.
type release struct {
	commit string
	up     string
	broker string
}

// setupCommand is the setup a bot runs in its terminal: download the pinned box files, check them,
// run up.sh. joinKey is empty unless the box has to join the tailnet again.
func setupCommand(pinned release, token, joinKey string) string {
	key := ""
	if joinKey != "" {
		key = "; printf %s '" + joinKey + "' > ../tailscale-authkey"
	}
	return strings.Join([]string{
		"bash -euo pipefail <<'SETUP'",
		"mkdir -p /workspace/hermes-browsers/box && cd /workspace/hermes-browsers/box",
		"base=" + boxMirror + "/" + pinned.commit + "/grok_box_browser/box",
		`curl -fsSLO "$base/up.sh"; curl -fsSLO "$base/broker.mjs"`,
		`printf '%s  up.sh\n%s  broker.mjs\n' ` + pinned.up + " " + pinned.broker + " | sha256sum -c -",
		"umask 077; printf %s '" + token + "' > ../token" + key,
		"bash up.sh",
		"SETUP",
	}, "\n")
}

// upkeepBlock is put before a message's own text while the box is down.
func upkeepBlock(command string) string {
	return strings.Join([]string{
		"[Before anything else, yourself] Hermes's browser service in this cloud computer is down. Run this in your own terminal first and include its last line in your reply. Don't print the token or key files.",
		"```bash",
		command,
		"```",
	}, "\n")
}

// repairMessage is the parent bot's message when only the repair is needed.
func repairMessage(command string) string {
	return strings.Join([]string{
		"Run this in your own cloud computer's terminal and reply with only its last five lines. It restarts my browser service in /workspace/hermes-browsers. Don't print the token or key files.",
		"```bash",
		command,
		"```",
	}, "\n")
}

// boxDeps is what the keeper needs from outside: tests replace all of it.
type boxDeps struct {
	// exec runs a command and returns its stdout.
	exec func(ctx context.Context, file string, args []string) (string, error)
	// nc sends request over a `tailscale nc` connection and returns what came back.
	nc func(ctx context.Context, settings *boxSettings, request string, timeout time.Duration) string
	// client reaches the Tailscale API at tailscaleAPI.
	client       httpDoer
	tailscaleAPI string
	readFile     func(path string) ([]byte, error)
	now          func() int64
}

// responseComplete reports whether text holds a whole HTTP response with a Content-Length body.
func responseComplete(text string) bool {
	end := strings.Index(text, "\r\n\r\n")
	if end < 0 {
		return false
	}
	length := contentLength.FindStringSubmatch(text[:end])
	if length == nil {
		return false
	}
	// A length too large to read is one no answer reaches.
	wanted, err := strconv.Atoi(length[1])
	return err == nil && len(text)-(end+4) >= wanted
}

// runCommand runs a command and returns its stdout. One that takes too long or says too much has
// failed.
func runCommand(ctx context.Context, file string, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, file, args...).Output()
	if err != nil {
		return "", err
	}
	if len(output) > commandOutput {
		return "", errors.New("the command's output is too long")
	}
	return string(output), nil
}

// answerWriter collects what tailscale nc prints and says when the answer is whole.
type answerWriter struct {
	mu       sync.Mutex
	text     strings.Builder
	complete chan struct{}
	done     bool
}

func (w *answerWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.text.Write(data)
	if !w.done && responseComplete(w.text.String()) {
		w.done = true
		close(w.complete)
	}
	return len(data), nil
}

func (w *answerWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.text.String()
}

// runNC runs `tailscale nc` as a child process, writes the request to it, and returns what the box
// answered. It stops when the whole answer is in, when the connection closes, or at the timeout.
func runNC(ctx context.Context, settings *boxSettings, request string, timeout time.Duration) string {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	child := exec.CommandContext(ctx, settings.tailscale, "--socket="+settings.socket, "nc", settings.host, settings.port)
	// A child that holds its pipes open after being stopped is not waited for.
	child.WaitDelay = time.Second
	answer := &answerWriter{complete: make(chan struct{})}
	child.Stdout = answer
	stdin, err := child.StdinPipe()
	if err != nil {
		return ""
	}
	if err := child.Start(); err != nil {
		return ""
	}
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		_ = child.Wait()
	}()
	// `tailscale nc` drops the connection when its stdin ends, before the answer arrives: stdin stays
	// open until the broker closes the connection (HTTP/1.0) or the timeout.
	_, _ = io.WriteString(stdin, request)
	select {
	case <-answer.complete:
	case <-exited:
	case <-ctx.Done():
	}
	cancel()
	<-exited
	return answer.String()
}

func boxHealthy(ctx context.Context, settings *boxSettings, deps boxDeps) bool {
	answer := deps.nc(ctx, settings, healthRequest, healthTimeout)
	return healthyStatus.MatchString(answer) && strings.Contains(answer, `"ok":true`)
}

// boxOnline says whether the box is on the tailnet: known and not online means a fresh join key is
// needed. known is false when tailscale can't say.
func boxOnline(ctx context.Context, settings *boxSettings, deps boxDeps) (online, known bool) {
	output, err := deps.exec(ctx, settings.tailscale, []string{"--socket=" + settings.socket, "status", "--json"})
	if err != nil {
		return false, false
	}
	var status struct {
		Peer json.RawMessage
	}
	if err := json.Unmarshal([]byte(output), &status); err != nil {
		return false, false
	}
	if len(status.Peer) == 0 || string(status.Peer) == "null" {
		return false, true
	}
	// The first peer with the box's name counts, in the order tailscale lists them: an old node of
	// the same name can still be on the list.
	peers := json.NewDecoder(bytes.NewReader(status.Peer))
	if opening, err := peers.Token(); err != nil || opening != json.Delim('{') {
		return false, false
	}
	for peers.More() {
		if _, err := peers.Token(); err != nil {
			return false, false
		}
		var peer struct {
			HostName string
			DNSName  string
			Online   bool
		}
		if err := peers.Decode(&peer); err != nil {
			return false, false
		}
		if name, _, _ := strings.Cut(peer.DNSName, "."); peer.HostName == settings.host || name == settings.host {
			return peer.Online, true
		}
	}
	return false, true
}

// installedRelease is the installed plugin's commit and the sha256 of its box files, which the
// mirror serves at that commit.
func installedRelease(ctx context.Context, settings *boxSettings, deps boxDeps) (release, error) {
	head, err := deps.exec(ctx, "git", []string{"-C", settings.pluginDir, "rev-parse", "HEAD"})
	if err != nil {
		return release{}, err
	}
	pinned := release{commit: handoff.TrimSpace(head)}
	if !fullCommit.MatchString(pinned.commit) {
		return release{}, errors.New("the leon plugin isn't installed from its mirror")
	}
	for _, file := range []struct {
		name string
		sum  *string
	}{{"up.sh", &pinned.up}, {"broker.mjs", &pinned.broker}} {
		data, err := deps.readFile(filepath.Join(settings.pluginDir, "box", file.name))
		if err != nil {
			return release{}, err
		}
		sum := sha256.Sum256(data)
		*file.sum = hex.EncodeToString(sum[:])
	}
	return pinned, nil
}

// tailscaleCall posts to the Tailscale API and reads its JSON answer.
func tailscaleCall(ctx context.Context, deps boxDeps, path string, header map[string]string, body string, result any) (status int, err error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, deps.tailscaleAPI+path, strings.NewReader(body))
	if err != nil {
		return 0, err
	}
	for name, value := range header {
		request.Header.Set(name, value)
	}
	response, err := deps.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	return response.StatusCode, json.NewDecoder(response.Body).Decode(result)
}

// mintJoinKey gets a one-time, pre-approved join key for tag:grok-box from the Tailscale OAuth
// client.
func mintJoinKey(ctx context.Context, settings *boxSettings, deps boxDeps) (string, error) {
	if settings.oauthID == "" || settings.oauthSecret == "" {
		return "", errors.New("no Tailscale OAuth client")
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	status, err := tailscaleCall(ctx, deps, "/api/v2/oauth/token",
		map[string]string{"content-type": "application/x-www-form-urlencoded"},
		url.Values{
			"client_id":     {settings.oauthID},
			"client_secret": {settings.oauthSecret},
			"grant_type":    {"client_credentials"},
		}.Encode(), &token)
	if err != nil {
		return "", err
	}
	if status < 200 || status > 299 || token.AccessToken == "" {
		return "", fmt.Errorf("Tailscale OAuth answered %d", status)
	}
	var created struct {
		Key string `json:"key"`
	}
	status, err = tailscaleCall(ctx, deps, "/api/v2/tailnet/-/keys",
		map[string]string{"authorization": "Bearer " + token.AccessToken, "content-type": "application/json"},
		joinKeyRequest, &created)
	if err != nil {
		return "", err
	}
	if status < 200 || status > 299 || created.Key == "" {
		return "", fmt.Errorf("Tailscale key creation answered %d", status)
	}
	return created.Key, nil
}

// keeperState is state/grok-box.json. A time of 0 is one that isn't set.
type keeperState struct {
	UpkeepAt int64  `json:"upkeepAt,omitempty"`
	RepairAt int64  `json:"repairAt,omitempty"`
	VerifyAt int64  `json:"verifyAt,omitempty"`
	RetryAt  int64  `json:"retryAt,omitempty"`
	Failures *int   `json:"failures,omitempty"`
	Result   string `json:"result,omitempty"`
	Detail   string `json:"detail,omitempty"`
}

// repairStatus is repair-status.json: what the plugin tells Hermes when its browser can't reach the
// box.
type repairStatus struct {
	RepairAt *int64  `json:"repairAt"`
	Failures int     `json:"failures"`
	Result   *string `json:"result"`
	Detail   *string `json:"detail"`
}

type boxHealth struct {
	at int64
	ok bool
}

type boxKeeper struct {
	stateFile string
	log       logFunc
	// settings reads Hermes's .env again each time, so a change there needs no restart.
	settings func() *boxSettings
	deps     boxDeps

	// mu guards the fields below. It is never held across a command or a network call.
	mu     sync.Mutex
	state  keeperState
	health *boxHealth
}

func newBoxKeeper(stateFile string, log logFunc, settings func() *boxSettings, deps boxDeps) *boxKeeper {
	return &boxKeeper{
		stateFile: stateFile,
		log:       log,
		settings:  settings,
		deps:      deps,
		state:     readJSON(stateFile, keeperState{}),
	}
}

// optional is a pointer to value, or nil for the zero value.
func optional[T comparable](value T) *T {
	var zero T
	if value == zero {
		return nil
	}
	return &value
}

// save writes the keeper's state, and the status the plugin reads. The caller holds mu.
func (k *boxKeeper) save(settings *boxSettings) error {
	if err := host.WriteJSONAtomic(k.stateFile, k.state); err != nil {
		return err
	}
	status := repairStatus{
		RepairAt: optional(k.state.RepairAt),
		Result:   optional(k.state.Result),
		Detail:   optional(k.state.Detail),
	}
	if k.state.Failures != nil {
		status.Failures = *k.state.Failures
	}
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}
	// The plugin reads this file from Hermes's side, so it keeps ordinary permissions, unlike the
	// keeper's own state.
	if err := os.MkdirAll(settings.shared, 0o777); err != nil {
		return err
	}
	file := filepath.Join(settings.shared, "repair-status.json")
	if err := os.WriteFile(file+".tmp", data, 0o666); err != nil {
		return err
	}
	return os.Rename(file+".tmp", file)
}

// healthy asks the broker, or answers from the last check when that is under a minute old.
func (k *boxKeeper) healthy(ctx context.Context, settings *boxSettings, fresh bool) bool {
	k.mu.Lock()
	cached := k.health
	k.mu.Unlock()
	if !fresh && cached != nil && k.deps.now()-cached.at < healthCacheMS {
		return cached.ok
	}
	checked := &boxHealth{at: k.deps.now()}
	checked.ok = boxHealthy(ctx, settings, k.deps)
	k.mu.Lock()
	k.health = checked
	k.mu.Unlock()
	return checked.ok
}

// command is the setup for the installed release, with a join key when the box is off the tailnet.
func (k *boxKeeper) command(ctx context.Context, settings *boxSettings) (string, error) {
	pinned, err := installedRelease(ctx, settings, k.deps)
	if err != nil {
		return "", err
	}
	key := ""
	if online, known := boxOnline(ctx, settings, k.deps); known && !online {
		if key, err = mintJoinKey(ctx, settings, k.deps); err != nil {
			k.log("grok_box_key_error", map[string]any{"message": err.Error()})
		}
	}
	return setupCommand(pinned, settings.token, key), nil
}

// upkeep returns the text to put before an outgoing Grok message: empty unless the box needs its
// setup.
func (k *boxKeeper) upkeep(ctx context.Context) string {
	settings := k.settings()
	if settings == nil {
		return ""
	}
	block, err := k.setupIfDown(ctx, settings)
	if err != nil {
		k.log("grok_box_upkeep_error", map[string]any{"message": err.Error()})
		return ""
	}
	return block
}

func (k *boxKeeper) setupIfDown(ctx context.Context, settings *boxSettings) (string, error) {
	k.mu.Lock()
	asked := k.state.UpkeepAt
	k.mu.Unlock()
	if asked != 0 && k.deps.now()-asked < upkeepEveryMS {
		return "", nil
	}
	if k.healthy(ctx, settings, false) {
		return "", nil
	}
	command, err := k.command(ctx, settings)
	if err != nil {
		return "", err
	}
	k.mu.Lock()
	k.state.UpkeepAt = k.deps.now()
	err = k.save(settings)
	k.mu.Unlock()
	if err != nil {
		return "", err
	}
	k.log("grok_box_upkeep", map[string]any{})
	return upkeepBlock(command), nil
}

// tick handles a repair request from the plugin and checks a sent repair. send delivers one message
// to a bot, and fails when the bot can't take it now.
func (k *boxKeeper) tick(ctx context.Context, send func(ctx context.Context, bot, text string) error) error {
	settings := k.settings()
	if settings == nil {
		return nil
	}
	now := k.deps.now()
	k.mu.Lock()
	verify := k.state.VerifyAt != 0 && now >= k.state.VerifyAt
	k.mu.Unlock()
	if verify {
		ok := k.healthy(ctx, settings, true)
		k.mu.Lock()
		failures := 0
		event := "grok_box_repaired"
		k.state.Result = "ok"
		if !ok {
			if k.state.Failures != nil {
				failures = *k.state.Failures
			}
			failures++
			event = "grok_box_repair_error"
			k.state.Result = "failed"
		}
		k.state.VerifyAt = 0
		k.state.Failures = &failures
		err := k.save(settings)
		k.mu.Unlock()
		if err != nil {
			return err
		}
		k.log(event, map[string]any{"failures": failures})
	}

	requestFile := filepath.Join(settings.shared, "repair-request.json")
	data, err := k.deps.readFile(requestFile)
	if err != nil {
		return nil
	}
	var request map[string]any
	if err := json.Unmarshal(data, &request); err != nil {
		return nil
	}
	at, set := request["at"]
	requested := jsNumber(at)
	if !set || math.IsNaN(requested) || math.IsInf(requested, 0) {
		return nil
	}
	k.mu.Lock()
	repairAt, retryAt := k.state.RepairAt, k.state.RetryAt
	k.mu.Unlock()
	if repairAt != 0 && (requested <= float64(repairAt) || now-repairAt < repairEveryMS) {
		return nil
	}
	if retryAt != 0 && now < retryAt {
		return nil
	}
	if k.healthy(ctx, settings, true) {
		if err := os.Remove(requestFile); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	command, err := k.command(ctx, settings)
	if err == nil {
		err = send(ctx, repairBot, repairMessage(command))
	}
	k.mu.Lock()
	if err == nil {
		k.state.RepairAt = now
		k.state.VerifyAt = now + verifyAfterMS
		k.state.RetryAt = 0
		k.state.Result = "sent"
		k.state.Detail = ""
	} else {
		// Not sent (the bot is busy, the budget is used up): try again in a few minutes.
		k.state.RetryAt = now + retryAfterMS
		k.state.Result = "skipped"
		k.state.Detail = utf16Prefix(err.Error(), 300)
	}
	k.mu.Unlock()
	if err == nil {
		k.log("grok_box_repair_sent", map[string]any{"bot": repairBot})
	} else {
		k.log("grok_box_repair_error", map[string]any{"message": utf16Prefix(err.Error(), 300)})
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.save(settings)
}

// status is the keeper's state for the daemon's status, and whether the box is configured at all.
func (k *boxKeeper) status() map[string]any {
	status := map[string]any{}
	k.mu.Lock()
	data, err := json.Marshal(k.state)
	k.mu.Unlock()
	if err == nil {
		_ = json.Unmarshal(data, &status)
	}
	status["configured"] = k.settings() != nil
	return status
}

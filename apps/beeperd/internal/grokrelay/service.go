// Package grokrelay is slack22grokbot: the relay through which Hermes hands browser work to Leon's
// Grok Bot bots in Beeper, as Leon, with each task mirrored both ways to its Slack thread.
//
// It queues messages for bots that are still working, keeps Hermes's hourly budget, waits for
// replies through the journal, copies each task bot's chat to its Slack thread and back, retires
// finished task bots through the Grok Bot admin service, and keeps Hermes's browser service in the
// Grok Bot cloud computer set up. It reaches Beeper only through the inbox's own tools and journal,
// so the inbox's send ledger applies to it too.
package grokrelay

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/envfile"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

const (
	serviceName = "slack22grokbot"
	// cycleEvery is the pause between two cycles of the Slack bridge when nothing new arrived.
	cycleEvery = 15 * time.Second
	// newsDelay is how long a task bot's new message waits before the next cycle starts early. A bot
	// rewrites its message several times a second while it writes; one cycle after the burst copies
	// the text once instead of sending Slack an edit per rewrite.
	newsDelay = 1500 * time.Millisecond
	boxEvery  = 60 * time.Second
)

// service is the relay before it starts. Its fields are the outside world, which tests replace.
type service struct {
	// now is the clock, in Unix milliseconds.
	now func() int64
	// client reaches slack-puppet and the Grok Bot admin service.
	client httpDoer
	// getenv is the daemon's environment: HERMES_HOME and GROK_BOX_ENV_FILE say where Hermes's own
	// .env is.
	getenv func(string) string
	// box runs git and tailscale and reaches the Tailscale API.
	box        boxDeps
	cycleEvery time.Duration
	boxEvery   time.Duration
}

// Service is the relay as a service of the daemon: `beeperd mcp slack22grokbot` is its MCP server.
// It runs inside the daemon because the queue, the budget and the flusher need exactly one owner,
// and Hermes starts an MCP server in several processes at once.
func Service() host.Service {
	now := func() int64 { return time.Now().UnixMilli() }
	return &service{
		now: now,
		// A redirect would carry the bearer token somewhere else.
		client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("slack22grokbot does not follow redirects")
		}},
		getenv: os.Getenv,
		box: boxDeps{
			exec:         runCommand,
			nc:           runNC,
			client:       &http.Client{},
			tailscaleAPI: tailscaleAPI,
			readFile:     os.ReadFile,
			now:          now,
		},
		cycleEvery: cycleEvery,
		boxEvery:   boxEvery,
	}
}

func (s *service) Name() string { return serviceName }

func (s *service) Server() *host.Server {
	described := describedServer()
	return &described
}

func (s *service) Start(ctx context.Context, h host.Host) (host.Running, error) {
	home := h.Home()
	log := func(event string, fields map[string]any) {
		level := "info"
		if strings.HasSuffix(event, "_error") {
			level = "warn"
		}
		h.Log()(level, event, fields)
	}
	inbox := &inboxBackend{tool: h.Tool, journal: h.Journal()}
	ctx, cancel := context.WithCancel(ctx)
	run := &running{log: log, ctx: ctx, cancel: cancel, cycleEvery: s.cycleEvery, boxEvery: s.boxEvery, newsDelay: newsDelay}

	// Without its settings the Slack bridge stays off: Hermes can still list and read bots, and a
	// handoff is refused.
	options := relayOptions{stateDir: filepath.Join(home, "state"), backend: inbox, log: log, now: s.now}
	settings, err := os.ReadFile(filepath.Join(home, serviceName+".env"))
	if err == nil {
		env := envfile.Parse(string(settings))
		var services bridgeServices
		if services, err = newBridgeServices(env, s.client); err == nil {
			run.bridge, err = newBridge(bridgeOptions{
				backend:      inbox,
				journal:      h.Journal(),
				services:     services,
				stateFile:    filepath.Join(home, serviceName+".json"),
				hermesUserID: env["SLACK_HERMES_USER_ID"],
				log:          log,
				now:          s.now,
			})
		}
	}
	switch {
	case err == nil:
		options.bridge = run.bridge
	case errors.Is(err, os.ErrNotExist):
		run.problem = "no settings file"
	default:
		run.problem = err.Error()
		log("slack22grokbot_config_error", map[string]any{"message": run.problem})
	}

	// Keeps grok-box-browser set up in the Grok Bot cloud computer (box.go).
	run.keeper = newBoxKeeper(
		filepath.Join(home, "state", "grok-box.json"),
		log,
		func() *boxSettings { return loadBoxSettings(s.getenv) },
		s.box,
	)
	options.upkeep = func(ctx context.Context) (string, error) { return run.keeper.upkeep(ctx), nil }
	run.relay = newRelay(options)
	run.relay.startFlusher(ctx)
	if run.bridge != nil {
		run.news = make(chan struct{}, 1)
		run.unsubscribe = h.Journal().Subscribe(func() {
			select {
			case run.news <- struct{}{}:
			default:
			}
		})
		run.background.Go(run.cycle)
	}
	run.background.Go(run.keepBox)
	return run, nil
}

// running is the started relay.
type running struct {
	relay  *relay
	bridge *slackBridge
	keeper *boxKeeper
	log    logFunc
	// ctx ends when the service stops.
	ctx        context.Context
	cancel     context.CancelFunc
	background sync.WaitGroup
	cycleEvery time.Duration
	boxEvery   time.Duration
	newsDelay  time.Duration
	// news is signalled on every journal change, so a task bot's message reaches Slack in a second or
	// two instead of at the next cycle.
	news        chan struct{}
	unsubscribe func()

	mu sync.Mutex
	// problem is why the Slack bridge isn't working, or empty.
	problem string
}

// cycle runs the Slack bridge until the service stops, with a pause after each cycle.
func (r *running) cycle() {
	for {
		err := r.bridge.tick(r.ctx)
		if r.ctx.Err() != nil {
			return
		}
		problem := ""
		if err != nil {
			problem = err.Error()
		}
		r.mu.Lock()
		changed := problem != r.problem
		r.problem = problem
		r.mu.Unlock()
		if changed && err != nil {
			r.log("slack22grokbot_cycle_error", map[string]any{"message": problem})
		}
		if !r.pause() {
			return
		}
	}
}

// pause waits for the next cycle: cycleEvery, or sooner when a task bot's chat has something the
// bridge has not copied yet. It returns false when the service stops.
func (r *running) pause() bool {
	timer := time.NewTimer(r.cycleEvery)
	defer timer.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return false
		case <-timer.C:
			return true
		case <-r.news:
			if r.bridge.hasNews(r.ctx) {
				return sleep(r.ctx, r.newsDelay)
			}
		}
	}
}

// keepBox lets the box keeper look for a repair request once a minute.
func (r *running) keepBox() {
	ticker := time.NewTicker(r.boxEvery)
	defer ticker.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
			if err := r.keeper.tick(r.ctx, r.relay.direct); err != nil && r.ctx.Err() == nil {
				r.log("grok_box_tick_error", map[string]any{"message": err.Error()})
			}
		}
	}
}

// CallTool runs one tool. A refusal (unknown bot, budget reached, Beeper unreachable) comes back as
// {ok: false, error}, written for Hermes to read.
func (r *running) CallTool(ctx context.Context, name string, args map[string]any) (map[string]any, error) {
	// The call also ends when the service stops, so a wait for a reply doesn't outlive it.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer context.AfterFunc(r.ctx, cancel)()
	result, err := r.call(ctx, name, args)
	if err != nil {
		return map[string]any{
			"ok":    false,
			"error": map[string]any{"code": "slack22grokbot_error", "message": err.Error()},
		}, nil
	}
	return result, nil
}

func (r *running) call(ctx context.Context, name string, args map[string]any) (map[string]any, error) {
	switch name {
	case "grok_bots":
		bots, err := r.relay.bots(ctx, false)
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "bots": bots}, nil
	case "grok_bot_send":
		return r.relay.send(ctx, args)
	case "grok_bot_read":
		return r.relay.read(ctx, args)
	case "grok_task_complete":
		return r.relay.complete(ctx, args)
	}
	return nil, fmt.Errorf("Unknown tool %s", name)
}

func (r *running) Status() map[string]any {
	status := map[string]any{"running": r.bridge != nil}
	if r.bridge != nil {
		maps.Copy(status, r.bridge.status())
	}
	r.mu.Lock()
	if r.problem != "" {
		status["problem"] = r.problem
	}
	r.mu.Unlock()
	status["grokBox"] = r.keeper.status()
	return status
}

// Stop ends the flusher, the Slack bridge's cycle and the box keeper, and waits for them. A tool
// call that is still waiting for a reply returns what it has.
func (r *running) Stop() {
	if r.unsubscribe != nil {
		r.unsubscribe()
	}
	r.cancel()
	r.relay.stop()
	r.background.Wait()
}

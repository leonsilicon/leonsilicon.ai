// Package daemon is the store's one owner. It takes the lock or exits, then serves the socket, signs
// in, runs the services and keeps syncing until it is told to stop.
package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/daemonclient"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/inbox"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/ipc"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/lockfile"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/logfile"
)

// Options configures a daemon.
type Options struct {
	Paths    inbox.Paths
	Services []host.Service
	// Debug adds debug-level lines to the log.
	Debug bool
}

type running struct {
	service host.Service
	handle  host.Running
}

// Run runs the daemon until a signal or a shutdown request, and returns its exit code.
func Run(options Options) int {
	paths := options.Paths
	if err := paths.EnsureDirectories(); err != nil {
		fmt.Fprintln(os.Stderr, "beeperd:", err)
		return 1
	}
	logs := logfile.Open(paths.LogFile)
	logs.Debug = options.Debug
	log := logs.Logger("daemon")
	lock, err := lockfile.TryAcquire(paths.Lock)
	if err != nil {
		log("error", "couldn't take the owner lock", map[string]any{"error": err.Error()})
		return 1
	}
	if lock == nil {
		log("info", "another process owns the store; exiting", nil)
		return daemonclient.ExitAlreadyOwned
	}
	defer lock.Release()
	// The daemon shares a 4 GB machine with Hermes and needs little: collect early, and treat 64 MB
	// as the point to collect hard (a soft limit; a burst may pass it).
	debug.SetGCPercent(50)
	debug.SetMemoryLimit(64 << 20)
	_ = host.WriteJSONAtomic(paths.DaemonInfo, map[string]any{
		"pid": os.Getpid(), "version": inbox.Version, "startedAt": time.Now().UTC().Format(time.RFC3339), "argv": os.Args,
	})
	log("info", "daemon starting", map[string]any{"version": inbox.Version})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	core := inbox.New(inbox.Options{
		Paths: paths,
		Log:   log,
		// The Matrix library's warnings and errors go to the same file. They name events and rooms,
		// never text.
		LibraryLog: zerolog.New(logs).Level(zerolog.WarnLevel).With().Timestamp().Str("component", "matrix").Logger(),
	})
	_ = core.Start(ctx)

	var services []running
	for _, service := range options.Services {
		home := filepath.Join(paths.Home, service.Name())
		if err := os.MkdirAll(home, 0o700); err != nil {
			log("error", "service failed to start", map[string]any{"service": service.Name(), "error": err.Error()})
			continue
		}
		handle, err := startService(ctx, service, &serviceHost{name: service.Name(), home: home, inbox: core, log: logs.Logger(service.Name())})
		if err != nil {
			// A service that fails to start is left out; the inbox itself still runs.
			log("error", "service failed to start", map[string]any{"service": service.Name(), "error": err.Error()})
			continue
		}
		services = append(services, running{service, handle})
	}

	stop := make(chan int, 1)
	requestStop := func(code int) {
		select {
		case stop <- code:
		default:
		}
	}
	server, err := ipc.Serve(paths.Socket, handler(core, services, requestStop), func(method string, err error) {
		log("error", "ipc handler failed", map[string]any{"method": method, "error": err.Error()})
	})
	if err != nil {
		log("error", "couldn't serve the socket", map[string]any{"error": err.Error()})
		core.Stop()
		return 1
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	lastStart := time.Now()
	wasStale := false
	code := 0
loop:
	for {
		select {
		case <-signals:
			break loop
		case code = <-stop:
			break loop
		case <-ticker.C:
			core.Tick(ctx)
			if stale := core.SyncStale(); stale != wasStale {
				wasStale = stale
				if stale {
					log("warn", "sync has had no answer for five minutes; it keeps retrying", nil)
				} else {
					log("info", "sync is answering again", nil)
				}
			}
			// A failed start (the homeserver was down, say) is retried with a long backoff.
			if core.State() == inbox.StateError && time.Since(lastStart) > 5*time.Minute {
				lastStart = time.Now()
				log("info", "retrying start after an error", nil)
				_ = core.Reload(ctx)
			}
		}
	}

	log("info", "daemon stopping", map[string]any{"code": code})
	var stopping sync.WaitGroup
	for _, service := range services {
		stopping.Add(1)
		go func() {
			defer stopping.Done()
			service.handle.Stop()
		}()
	}
	stopping.Wait()
	cancel()
	server.Close()
	core.Stop()
	log("info", "daemon stopped; the device stays signed in", nil)
	return code
}

func startService(ctx context.Context, service host.Service, h host.Host) (handle host.Running, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("panic: %v", recovered)
		}
	}()
	return service.Start(ctx, h)
}

func coded(err error) error {
	var tool *host.ToolError
	if errors.As(err, &tool) {
		return &ipc.Error{Code: tool.Code, Message: tool.Message, Data: tool.Data}
	}
	return err
}

func handler(core *inbox.Inbox, services []running, requestStop func(int)) ipc.Handler {
	return func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		var input map[string]any
		if len(params) > 0 {
			_ = json.Unmarshal(params, &input)
		}
		arguments, _ := input["arguments"].(map[string]any)
		name, _ := input["name"].(string)
		switch method {
		case "ping":
			return map[string]any{"pid": os.Getpid(), "state": string(core.State()), "version": inbox.Version}, nil
		case "status":
			status := core.Status(ctx)
			extensions := map[string]any{}
			for _, service := range services {
				extensions[service.service.Name()] = serviceStatus(service.handle)
			}
			status["extensions"] = extensions
			return status, nil
		case "tool":
			result, err := core.RunTool(ctx, name, arguments, inbox.Caller{})
			return result, coded(err)
		case "extension":
			wanted, _ := input["extension"].(string)
			for _, service := range services {
				if service.service.Name() == wanted && service.service.Server() != nil {
					result, err := service.handle.CallTool(ctx, name, arguments)
					return result, coded(err)
				}
			}
			return nil, &ipc.Error{Code: "bad_method", Message: fmt.Sprintf("this daemon has no extension %q", wanted)}
		case "journal":
			return journalPage(ctx, core, input)
		case "refresh_directory":
			result, err := core.RefreshDirectory(ctx, 0)
			return result, coded(err)
		case "reload":
			if err := core.Reload(ctx); err != nil {
				return nil, err
			}
			return core.Status(ctx), nil
		case "shutdown":
			go func() {
				time.Sleep(50 * time.Millisecond)
				requestStop(0)
			}()
			return map[string]any{"stopping": true, "pid": os.Getpid()}, nil
		}
		return nil, &ipc.Error{Code: "bad_method", Message: "unknown method " + method}
	}
}

func serviceStatus(handle host.Running) (status any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			status = map[string]any{"error": fmt.Sprint(recovered)}
		}
	}()
	if result := handle.Status(); result != nil {
		return result
	}
	return map[string]any{"running": true}
}

// journalPage lists what sync delivered lately, without text unless it is asked for.
func journalPage(ctx context.Context, core *inbox.Inbox, input map[string]any) (any, error) {
	journal := core.Journal()
	if journal == nil {
		return nil, &ipc.Error{Code: "not_ready", Message: "beeper-inbox's stores aren't open (it is stopping)"}
	}
	stats, err := journal.Stats()
	if err != nil {
		return nil, err
	}
	after := stats.Head - 50
	if value, ok := input["after"].(float64); ok {
		after = int64(value)
	}
	options := host.ChangesOptions{After: max(after, 0), Limit: 50}
	if value, ok := input["limit"].(float64); ok && value > 0 {
		options.Limit = int(value)
	}
	options.RoomID, _ = input["room_id"].(string)
	entries, cursor, err := journal.Changes(ctx, options)
	if err != nil {
		return nil, err
	}
	withText, _ := input["text"].(bool)
	listed := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		item := map[string]any{
			"seq": entry.Seq, "rev": entry.Rev, "roomId": entry.RoomID, "eventId": entry.EventID, "sender": entry.Sender,
			"isMe": entry.IsMe, "type": entry.Type, "ts": entry.TS, "receivedAt": entry.ReceivedAt, "edited": entry.Edited,
			"redacted": entry.Redacted, "replyTo": entry.ReplyTo, "attachments": entry.Attachments,
			"chars": len([]rune(entry.Text)), "html": entry.HTML != nil,
		}
		if withText {
			item["text"] = entry.Text
		}
		listed = append(listed, item)
	}
	return map[string]any{
		"head": stats.Head, "coveredSince": stats.CoveredSince, "entries": stats.Entries, "pending": stats.Pending,
		"cursor": cursor, "page": listed,
	}, nil
}

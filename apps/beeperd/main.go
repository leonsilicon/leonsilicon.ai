// beeperd is Hermes's Beeper inbox: one small daemon that signs in to Leon's Beeper account as its
// own encrypted device, copies new messages to Slack as they arrive, and sends for Hermes.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/daemon"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/daemonclient"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/feeds"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/grokrelay"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/inbox"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/ipc"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/linearmeta"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/lockfile"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/mcpserver"
)

const usage = `beeperd: Hermes's Beeper inbox.

  beeperd daemon                      run the daemon (the MCP adapter starts it; you rarely do)
  beeperd mcp [service]               stdio MCP server for Hermes: the inbox's tools, or a service's
  beeperd status                      JSON health: device, encryption, sync, directory, services
  beeperd start | stop | restart      same device and stores
  beeperd tool <name> [json]          run an inbox tool as Hermes would
  beeperd extension <service> <tool> [json]
  beeperd journal [json]              what sync delivered lately, without text
  beeperd refresh-directory           rebuild the room directory from a full snapshot
  beeperd login-start                 email on stdin; Beeper emails a code to it
  beeperd login-finish <code>         create this home's device from the code
  beeperd verify                      recovery key on stdin; cross-signs the device (daemon stopped)
  beeperd version

The home is $BEEPERD_HOME, else $HERMES_HOME/beeperd, else /opt/data/beeperd.`

// stopWait is how long a stop waits for the daemon to go. A feed lets the message in flight finish,
// and its model call can take half a minute.
const stopWait = 75 * time.Second

// services are what runs inside the daemon besides the inbox itself.
func services() []host.Service {
	return append(feeds.Services(), grokrelay.Service(), linearmeta.Service())
}

// enabledServices leaves out what $BEEPERD_SERVICES excludes: unset runs everything, "none" runs
// only the inbox (for a second daemon beside the live one, which must not post or relay anything),
// and a comma-separated list runs just those.
func enabledServices() []host.Service {
	setting := strings.TrimSpace(os.Getenv("BEEPERD_SERVICES"))
	if setting == "" {
		return services()
	}
	wanted := map[string]bool{}
	for _, name := range strings.Split(setting, ",") {
		wanted[strings.TrimSpace(name)] = true
	}
	var enabled []host.Service
	for _, service := range services() {
		if wanted[service.Name()] {
			enabled = append(enabled, service)
		}
	}
	return enabled
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		fmt.Println(usage)
		return 0
	}
	ctx := context.Background()
	paths := inbox.PathsFromEnv(os.Getenv)
	if err := paths.EnsureDirectories(); err != nil {
		return fail(err)
	}
	executable, err := os.Executable()
	if err != nil {
		return fail(err)
	}
	target := daemonclient.Target{
		Socket: paths.Socket, DaemonInfo: paths.DaemonInfo, LogFile: paths.LogFile,
		Command: []string{executable, "daemon"}, Env: daemonclient.DaemonEnv(os.Environ()),
	}
	call := func(method string, params any, timeout time.Duration) int {
		var result any
		if err := ipc.Call(ctx, paths.Socket, method, params, timeout, &result); err != nil {
			return fail(err)
		}
		return print(result)
	}
	ensure := func() error { return daemonclient.Ensure(ctx, target, 45*time.Second) }

	switch args[0] {
	case "version":
		fmt.Println(inbox.Version)
		return 0
	case "daemon":
		return daemon.Run(daemon.Options{Paths: paths, Services: enabledServices(), Debug: os.Getenv("BEEPERD_DEBUG") != ""})
	case "mcp":
		return runMCP(ctx, paths, target, args[1:])
	case "status":
		return call("status", nil, 120*time.Second)
	case "start":
		if err := ensure(); err != nil {
			return fail(err)
		}
		return call("status", nil, 120*time.Second)
	case "stop":
		stopped, pid := daemonclient.Stop(ctx, target, stopWait)
		return print(map[string]any{"stopped": stopped, "pid": pid})
	case "restart":
		stopped, pid := daemonclient.Stop(ctx, target, stopWait)
		if !stopped {
			return fail(fmt.Errorf("the daemon (pid %d) didn't stop within %s; nothing was started", pid, stopWait))
		}
		if err := ensure(); err != nil {
			return fail(err)
		}
		return call("status", nil, 120*time.Second)
	case "tool":
		if len(args) < 2 {
			return fail(errors.New("usage: beeperd tool <name> [json]"))
		}
		arguments, err := jsonArg(args, 2)
		if err != nil {
			return fail(err)
		}
		if err := ensure(); err != nil {
			return fail(err)
		}
		return call("tool", map[string]any{"name": args[1], "arguments": arguments}, 175*time.Second)
	case "extension":
		if len(args) < 3 {
			return fail(errors.New("usage: beeperd extension <service> <tool> [json]"))
		}
		arguments, err := jsonArg(args, 3)
		if err != nil {
			return fail(err)
		}
		if err := ensure(); err != nil {
			return fail(err)
		}
		return call("extension", map[string]any{"extension": args[1], "name": args[2], "arguments": arguments}, 175*time.Second)
	case "journal":
		arguments, err := jsonArg(args, 1)
		if err != nil {
			return fail(err)
		}
		if err := ensure(); err != nil {
			return fail(err)
		}
		return call("journal", arguments, 60*time.Second)
	case "refresh-directory":
		if err := ensure(); err != nil {
			return fail(err)
		}
		return call("refresh_directory", nil, 200*time.Second)
	case "login-start":
		return loginStart(ctx, paths)
	case "login-finish":
		if len(args) < 2 {
			return fail(errors.New("usage: beeperd login-finish <code>"))
		}
		return loginFinish(ctx, paths, args[1])
	case "verify":
		return verify(ctx, paths)
	}
	fmt.Fprintln(os.Stderr, usage)
	return 2
}

func jsonArg(args []string, index int) (map[string]any, error) {
	arguments := map[string]any{}
	if len(args) > index && strings.TrimSpace(args[index]) != "" {
		if err := json.Unmarshal([]byte(args[index]), &arguments); err != nil {
			return nil, fmt.Errorf("the arguments aren't a JSON object: %w", err)
		}
	}
	return arguments, nil
}

func print(value any) int {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return fail(err)
	}
	return 0
}

func fail(err error) int {
	var coded *ipc.Error
	if errors.As(err, &coded) {
		fmt.Fprintf(os.Stderr, "beeperd: %s: %s\n", coded.Code, coded.Message)
	} else {
		fmt.Fprintln(os.Stderr, "beeperd:", err)
	}
	return 1
}

// runMCP serves MCP on stdio for Hermes. It starts the daemon when Hermes starts and checks on it
// every minute, so background sync survives gateway restarts and machine restarts.
func runMCP(ctx context.Context, paths inbox.Paths, target daemonclient.Target, args []string) int {
	server := inbox.Server()
	extension := ""
	if len(args) > 0 {
		extension = args[0]
		found := false
		for _, service := range services() {
			if described := service.Server(); service.Name() == extension && described != nil {
				server, found = *described, true
			}
		}
		if !found {
			return fail(fmt.Errorf("no service %q with tools", extension))
		}
	}
	send := func(ctx context.Context, name string, arguments json.RawMessage) (map[string]any, error) {
		params := map[string]any{"name": name, "arguments": json.RawMessage("{}")}
		if len(arguments) > 0 && string(arguments) != "null" {
			params["arguments"] = arguments
		}
		method := "tool"
		if extension != "" {
			method, params["extension"] = "extension", extension
		}
		var result map[string]any
		err := ipc.Call(ctx, paths.Socket, method, params, 175*time.Second, &result)
		return result, err
	}
	call := func(ctx context.Context, name string, arguments json.RawMessage) (map[string]any, error) {
		// Straight to the daemon: a busy one answers within the call's own timeout. A ping first
		// failed calls whenever the daemon was a few seconds slow (2026-11-26).
		result, err := send(ctx, name, arguments)
		var coded *ipc.Error
		if errors.As(err, &coded) && coded.Code == ipc.CodeUnreachable {
			// Nothing listening (no daemon yet, or it exited), so the call never arrived: start one
			// and send it again.
			if err := daemonclient.Ensure(ctx, target, 45*time.Second); err != nil {
				return nil, err
			}
			return send(ctx, name, arguments)
		}
		return result, err
	}
	go func() {
		for {
			_ = daemonclient.Ensure(ctx, target, 45*time.Second)
			time.Sleep(time.Minute)
		}
	}()
	// Hermes closing stdin ends this adapter only; the daemon keeps the device's session.
	if err := mcpserver.Run(ctx, server, call, os.Stdin, os.Stdout); err != nil {
		return fail(err)
	}
	return 0
}

func loginStart(ctx context.Context, paths inbox.Paths) int {
	email, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	email = strings.TrimSpace(email)
	if email == "" {
		return fail(errors.New("give the Beeper account's email on stdin"))
	}
	login, err := inbox.StartLogin(ctx, email)
	if err != nil {
		return fail(err)
	}
	if err := host.WriteJSONAtomic(paths.State+"/login.json", map[string]string{"request": login.RequestID}); err != nil {
		return fail(err)
	}
	fmt.Println("Beeper emailed a code. Run: beeperd login-finish <code>")
	return 0
}

func loginFinish(ctx context.Context, paths inbox.Paths, code string) int {
	if _, err := inbox.LoadSession(paths.Session); err == nil {
		return fail(fmt.Errorf("%s already holds a device; sign in to a new home instead of replacing it", paths.Session))
	}
	data, err := os.ReadFile(paths.State + "/login.json")
	if err != nil {
		return fail(errors.New("no sign-in is in progress; run beeperd login-start first"))
	}
	var pending struct {
		Request string `json:"request"`
	}
	if err := json.Unmarshal(data, &pending); err != nil || pending.Request == "" {
		return fail(errors.New("login.json is unreadable; run beeperd login-start again"))
	}
	session, err := inbox.ResumeLogin(pending.Request).Finish(ctx, code, "Hermes Cloud inbox (beeperd)")
	if err != nil {
		return fail(err)
	}
	if err := session.Save(paths.Session); err != nil {
		return fail(err)
	}
	_ = os.Remove(paths.State + "/login.json")
	fmt.Printf("signed in: device %s. Next: beeperd verify\n", session.DeviceID)
	return 0
}

// verify cross-signs the device from the recovery key. It opens the crypto store itself, so the
// daemon must not be running.
func verify(ctx context.Context, paths inbox.Paths) int {
	lock, err := lockfile.TryAcquire(paths.Lock)
	if err != nil {
		return fail(err)
	}
	if lock == nil {
		return fail(errors.New("the daemon is running; stop it first (beeperd stop)"))
	}
	defer lock.Release()
	recoveryKey, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	recoveryKey = strings.TrimSpace(recoveryKey)
	if recoveryKey == "" {
		return fail(errors.New("give the recovery key on stdin"))
	}
	version, err := inbox.Verify(ctx, paths, recoveryKey)
	if err != nil {
		return fail(err)
	}
	fmt.Printf("the device is cross-signed; key backup version %q\n", version)
	return 0
}

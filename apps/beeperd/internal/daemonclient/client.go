// Package daemonclient is how clients (the MCP adapter, the CLI) reach the daemon, starting it when
// nothing answers and no live owner is named in daemon.json. Any number of clients may race here:
// each may start a daemon, the owner lock lets exactly one keep running, and the rest exit at once.
package daemonclient

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/ipc"
)

// ExitAlreadyOwned is the daemon's exit code when another live process owns the store (EX_TEMPFAIL).
const ExitAlreadyOwned = 75

// respawnAfter is how long a daemon that was just started gets before another is started.
const respawnAfter = 10 * time.Second

// Target says where the daemon lives and how to start it.
type Target struct {
	Socket     string
	DaemonInfo string
	LogFile    string
	// Command is the daemon's argv, e.g. ["/opt/data/beeperd/bin/beeperd", "daemon"].
	Command []string
	Env     []string
}

var (
	inflightMu sync.Mutex
	inflight   *call
)

type call struct {
	done chan struct{}
	err  error
}

// Ensure returns once the daemon answers a ping. Concurrent callers share one attempt.
func Ensure(ctx context.Context, target Target, wait time.Duration) error {
	inflightMu.Lock()
	current := inflight
	if current == nil {
		current = &call{done: make(chan struct{})}
		inflight = current
		go func() {
			current.err = start(context.WithoutCancel(ctx), target, wait)
			inflightMu.Lock()
			inflight = nil
			inflightMu.Unlock()
			close(current.done)
		}()
	}
	inflightMu.Unlock()
	select {
	case <-current.done:
		return current.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func answers(ctx context.Context, socket string, timeout time.Duration) bool {
	return ipc.Call(ctx, socket, "ping", nil, timeout, nil) == nil
}

func start(ctx context.Context, target Target, wait time.Duration) error {
	if answers(ctx, target.Socket, 5*time.Second) {
		return nil
	}
	if len(target.Command) == 0 {
		return &ipc.Error{Code: ipc.CodeUnreachable, Message: "no daemon command"}
	}
	deadline := time.Now().Add(wait)
	var spawnedAt time.Time
	owner := Pid(target.DaemonInfo)
	for {
		// A live owner that is slow to answer (busy with Matrix, or the machine is throttled) is waited
		// for, not replaced: a second daemon can't take the store from it and exits at once.
		if owner == 0 && time.Since(spawnedAt) >= respawnAfter {
			spawnedAt = time.Now()
			spawn(target)
		}
		if !time.Now().Before(deadline) {
			break
		}
		time.Sleep(300 * time.Millisecond)
		timeout := 2 * time.Second
		if owner != 0 {
			timeout = 5 * time.Second
		}
		if answers(ctx, target.Socket, timeout) {
			return nil
		}
		owner = Pid(target.DaemonInfo)
	}
	if owner != 0 {
		return &ipc.Error{Code: "daemon_busy", Message: fmt.Sprintf(
			"the beeper-inbox daemon (pid %d) is running but hasn't answered for %s; try again in a minute (see %s)",
			owner, wait, target.LogFile)}
	}
	return &ipc.Error{Code: ipc.CodeUnreachable, Message: fmt.Sprintf(
		"the beeper-inbox daemon didn't start within %s; see %s", wait, target.LogFile)}
}

// spawn starts the daemon in its own session, outside the MCP adapter's process group that Hermes
// reaps when the adapter exits. Its output goes to its own log file.
func spawn(target Target) {
	cmd := exec.Command(target.Command[0], target.Command[1:]...)
	cmd.Env = target.Env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return
	}
	go func() { _ = cmd.Wait() }()
}

// DaemonEnv keeps only what the daemon needs from the caller's environment. Its secrets are in its
// own state directory.
func DaemonEnv(environ []string) []string {
	keep := map[string]bool{
		"HOME": true, "HERMES_HOME": true, "PATH": true, "LANG": true, "TZ": true, "TMPDIR": true,
		"BEEPERD_HOME": true, "BEEPERD_DEBUG": true, "BEEPERD_SERVICES": true,
	}
	var out []string
	for _, entry := range environ {
		name, _, _ := strings.Cut(entry, "=")
		if keep[name] {
			out = append(out, entry)
		}
	}
	return out
}

// Pid is the daemon's pid when daemon.json names a live daemon process, else 0.
func Pid(daemonInfo string) int {
	data, err := os.ReadFile(daemonInfo)
	if err != nil {
		return 0
	}
	var info struct {
		Pid int `json:"pid"`
	}
	if json.Unmarshal(data, &info) != nil || info.Pid <= 0 {
		return 0
	}
	if syscall.Kill(info.Pid, 0) != nil {
		return 0
	}
	// A pid can be reused by an unrelated process after a reboot.
	if cmdline, err := os.ReadFile("/proc/" + strconv.Itoa(info.Pid) + "/cmdline"); err == nil && len(cmdline) > 0 {
		if !strings.Contains(string(cmdline), "daemon") {
			return 0
		}
	}
	return info.Pid
}

// Stop asks the daemon to stop and waits until its socket is silent and its process is gone.
func Stop(ctx context.Context, target Target, wait time.Duration) (stopped bool, pid int) {
	pid = Pid(target.DaemonInfo)
	err := ipc.Call(ctx, target.Socket, "shutdown", nil, 5*time.Second, nil)
	if coded, ok := err.(*ipc.Error); err != nil && (!ok || coded.Code != ipc.CodeUnreachable) && pid != 0 {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		if !answers(ctx, target.Socket, time.Second) && (pid == 0 || syscall.Kill(pid, 0) != nil) {
			return true, pid
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false, pid
}

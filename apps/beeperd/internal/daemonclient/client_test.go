package daemonclient

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/ipc"
)

func TestALiveOwnerIsWaitedForAndADeadOneReplaced(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "started")
	target := Target{
		Socket: filepath.Join(dir, "d.sock"), DaemonInfo: filepath.Join(dir, "daemon.json"), LogFile: filepath.Join(dir, "daemon.log"),
		Command: []string{"/bin/sh", "-c", "touch " + marker},
	}
	// An owner that is alive but not answering, as on 2026-11-26 when the machine was throttled.
	// (Its command line says "daemon", which is what tells a daemon from a reused pid.)
	owner := exec.Command("/bin/sh", "-c", "sleep 30 # daemon")
	if err := owner.Start(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target.DaemonInfo, []byte(`{"pid":`+strconv.Itoa(owner.Process.Pid)+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
	err := Ensure(context.Background(), target, time.Second)
	var coded *ipc.Error
	if !errors.As(err, &coded) || coded.Code != "daemon_busy" {
		t.Fatalf("a live, silent owner is busy, got %v", err)
	}
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Fatal("no second daemon is started while the owner lives")
	}
	_ = owner.Process.Kill()
	_ = owner.Wait()

	err = Ensure(context.Background(), target, time.Second)
	if !errors.As(err, &coded) || coded.Code != ipc.CodeUnreachable {
		t.Fatalf("with no owner and nothing answering, the daemon is unreachable, got %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, statErr := os.Stat(marker); statErr == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("with the owner gone, a daemon is started")
}

func TestDaemonEnvKeepsOnlyWhatTheDaemonNeeds(t *testing.T) {
	got := DaemonEnv([]string{"HOME=/h", "BEEPERD_HOME=/b", "SLACK_BOT_TOKEN=xoxb", "PATH=/bin", "OPENAI_API_KEY=sk"})
	want := []string{"HOME=/h", "BEEPERD_HOME=/b", "PATH=/bin"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("got %v", got)
		}
	}
}

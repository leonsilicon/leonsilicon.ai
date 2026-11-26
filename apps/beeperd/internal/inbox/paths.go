// Package inbox is the daemon's Matrix core: one signed-in, cross-signed device of Leon's Beeper
// account that syncs, decrypts, keeps a journal of what arrived, and sends.
package inbox

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
)

// Paths is where the daemon keeps everything, under one home on the persistent volume.
type Paths struct {
	Home      string
	State     string
	Logs      string
	Downloads string
	// Session holds the device's identity and access token (0600).
	Session string
	// PickleKey encrypts the Olm and Megolm sessions in the crypto store (0600).
	PickleKey string
	CryptoDB  string
	InboxDB   string
	Lock      string
	Socket    string
	// DaemonInfo names the running daemon's pid, for clients that find the socket silent.
	DaemonInfo string
	LogFile    string
}

// PathsFromEnv resolves the home: $BEEPERD_HOME, else $HERMES_HOME/beeperd, else /opt/data/beeperd.
func PathsFromEnv(getenv func(string) string) Paths {
	home := getenv("BEEPERD_HOME")
	if home == "" {
		hermes := getenv("HERMES_HOME")
		if hermes == "" {
			hermes = "/opt/data"
		}
		home = filepath.Join(hermes, "beeperd")
	}
	state := filepath.Join(home, "state")
	return Paths{
		Home:       home,
		State:      state,
		Logs:       filepath.Join(home, "logs"),
		Downloads:  filepath.Join(home, "downloads"),
		Session:    filepath.Join(state, "session.json"),
		PickleKey:  filepath.Join(state, "pickle-key"),
		CryptoDB:   filepath.Join(state, "crypto.db"),
		InboxDB:    filepath.Join(state, "inbox.db"),
		Lock:       filepath.Join(state, "owner.lock"),
		Socket:     socketPath(state),
		DaemonInfo: filepath.Join(state, "daemon.json"),
		LogFile:    filepath.Join(home, "logs", "daemon.log"),
	}
}

// socketPath is state/daemon.sock, or for a home too deep for a Unix socket path (about 104 bytes
// on macOS, 108 on Linux), a per-home name in the temp directory.
func socketPath(state string) string {
	path := filepath.Join(state, "daemon.sock")
	if len(path) < 100 {
		return path
	}
	sum := sha256.Sum256([]byte(state))
	return filepath.Join(os.TempDir(), "beeperd-"+hex.EncodeToString(sum[:8])+".sock")
}

// EnsureDirectories creates the home's directories, owner-only where they hold keys or text.
func (p Paths) EnsureDirectories() error {
	for _, dir := range []string{p.Home, p.State, p.Logs} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	return os.MkdirAll(p.Downloads, 0o755)
}

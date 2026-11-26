// Package lockfile is the store's single-writer guarantee across processes. Hermes runs many
// processes (the gateway, cron runs, dashboard chats), each of which may start the daemon; whoever
// holds this lock is the only one that opens the crypto store.
package lockfile

import (
	"errors"
	"os"
	"syscall"
)

// Lock is a held owner lock.
type Lock struct {
	file *os.File
}

// TryAcquire takes the lock, or returns nil when another live process holds it. It is a flock, which
// the kernel drops when the holder dies by any cause (crash, SIGKILL, machine stop), so a dead owner
// never leaves a stale lock behind and there is no pid file to second-guess.
func TryAcquire(path string) (*Lock, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, nil
		}
		return nil, err
	}
	return &Lock{file: file}, nil
}

// Release gives the lock up.
func (l *Lock) Release() {
	if l == nil || l.file == nil {
		return
	}
	_ = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	_ = l.file.Close()
	l.file = nil
}

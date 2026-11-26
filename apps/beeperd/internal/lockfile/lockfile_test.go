package lockfile

import (
	"path/filepath"
	"testing"
)

func TestOneHolderAtATime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "owner.lock")
	first, err := TryAcquire(path)
	if err != nil || first == nil {
		t.Fatalf("the first taker gets the lock: %v", err)
	}
	second, err := TryAcquire(path)
	if err != nil || second != nil {
		t.Fatalf("a second taker gets nothing while it is held: %v %v", second, err)
	}
	first.Release()
	third, err := TryAcquire(path)
	if err != nil || third == nil {
		t.Fatalf("the lock is free once released: %v", err)
	}
	third.Release()
}

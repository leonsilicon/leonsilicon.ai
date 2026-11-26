package inbox

import (
	"context"
	"os"
	"time"

	"github.com/rs/zerolog"
)

// Verify cross-signs the home's device from Leon's recovery key and records it in the session
// file. The caller holds the owner lock. It returns the key backup version the device can now read.
func Verify(ctx context.Context, paths Paths, recoveryKey string) (string, error) {
	session, err := LoadSession(paths.Session)
	if err != nil {
		return "", err
	}
	_, statErr := os.Stat(paths.CryptoDB)
	pickleKey, err := LoadOrCreatePickleKey(paths.PickleKey, statErr == nil)
	if err != nil {
		return "", err
	}
	core, err := openMatrix(ctx, session, pickleKey, paths.CryptoDB, zerolog.New(os.Stderr).Level(zerolog.WarnLevel))
	if err != nil {
		return "", err
	}
	defer core.close()
	version, err := core.verifyWithRecoveryKey(ctx, recoveryKey)
	if err != nil {
		return "", err
	}
	session.VerifiedAt = time.Now().UTC().Format(time.RFC3339)
	session.KeyBackupVersion = version.String()
	return version.String(), session.Save(paths.Session)
}

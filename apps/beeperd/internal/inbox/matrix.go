package inbox

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/crypto"
	"maunium.net/go/mautrix/crypto/backup"
	"maunium.net/go/mautrix/crypto/cryptohelper"
	"maunium.net/go/mautrix/crypto/ssss"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

// matrixCore is the mautrix-go client with its crypto machine and stores: the same library
// Beeper's own bridges run. Its SQL stores write one row per change.
type matrixCore struct {
	cli    *mautrix.Client
	helper *cryptohelper.CryptoHelper
	mach   *crypto.OlmMachine
	syncer *mautrix.DefaultSyncer
	// backupKey reads the account's server-side key backup; nil until the device is verified.
	backupKey     *backup.MegolmBackupKey
	backupVersion id.KeyBackupVersion
}

// openMatrix opens the crypto store and prepares the client. It contacts the homeserver to check
// that this device's keys are still there, and uploads them the first time.
func openMatrix(ctx context.Context, session *Session, pickleKey []byte, cryptoDB string, log zerolog.Logger) (*matrixCore, error) {
	cli, err := mautrix.NewClient(session.Homeserver, id.UserID(session.UserID), session.AccessToken)
	if err != nil {
		return nil, err
	}
	cli.DeviceID = id.DeviceID(session.DeviceID)
	cli.Log = log
	cli.SyncPresence = event.PresenceOffline
	cli.UserAgent = "beeperd"
	syncer, ok := cli.Syncer.(*mautrix.DefaultSyncer)
	if !ok {
		return nil, errors.New("unexpected syncer type")
	}
	syncer.ParseEventContent = true
	syncer.ParseErrorHandler = func(*event.Event, error) bool { return true }
	helper, err := cryptohelper.NewCryptoHelper(cli, pickleKey, cryptoDB)
	if err != nil {
		return nil, err
	}
	if err := helper.Init(ctx); err != nil {
		return nil, fmt.Errorf("couldn't start encryption: %w", err)
	}
	cli.Crypto = helper
	mach := helper.Machine()
	// Decrypting only needs the session key. Looking the sender's device up on every message is
	// what cost the old daemon a full store rewrite per signature (2026-11-26); the only thing it
	// buys is a "verified device" label nothing here reads.
	mach.DisableDecryptKeyFetching = true
	if err := mach.ShareKeys(ctx, -1); err != nil {
		return nil, fmt.Errorf("couldn't upload this device's keys: %w", err)
	}
	core := &matrixCore{cli: cli, helper: helper, mach: mach, syncer: syncer}
	core.backupVersion = id.KeyBackupVersion(session.KeyBackupVersion)
	if secret, err := mach.CryptoStore.GetSecret(ctx, id.SecretMegolmBackupV1); err == nil && secret != "" {
		if raw, err := base64.StdEncoding.DecodeString(secret); err == nil {
			core.backupKey, _ = backup.MegolmBackupKeyFromBytes(raw)
		}
	}
	return core, nil
}

func (m *matrixCore) close() {
	if m.helper != nil {
		_ = m.helper.Close()
	}
}

// verifyWithRecoveryKey cross-signs this device from Leon's recovery key and keeps the key that
// reads the server-side key backup. Without the signature Beeper's bridges don't share message
// keys with the device. The recovery key itself is not stored.
func (m *matrixCore) verifyWithRecoveryKey(ctx context.Context, recoveryKey string) (id.KeyBackupVersion, error) {
	keyID, keyData, err := m.mach.SSSS.GetDefaultKeyData(ctx)
	if err != nil {
		return "", fmt.Errorf("couldn't read the account's secret storage: %w", err)
	}
	key, err := keyData.VerifyRecoveryKey(keyID, recoveryKey)
	if err != nil && !errors.Is(err, ssss.ErrUnverifiableKey) {
		return "", fmt.Errorf("the recovery key was not accepted: %w", err)
	}
	if err := m.mach.FetchCrossSigningKeysFromSSSS(ctx, key); err != nil {
		return "", fmt.Errorf("couldn't fetch the cross-signing keys: %w", err)
	}
	if err := m.mach.SignOwnDevice(ctx, m.mach.OwnIdentity()); err != nil {
		return "", fmt.Errorf("couldn't sign this device: %w", err)
	}
	if err := m.mach.SignOwnMasterKey(ctx); err != nil {
		return "", fmt.Errorf("couldn't sign the master key: %w", err)
	}
	data, err := m.mach.SSSS.GetDecryptedAccountData(ctx, event.AccountDataMegolmBackupKey, key)
	if err != nil {
		return "", fmt.Errorf("the device is signed, but the key backup key couldn't be read: %w", err)
	}
	backupKey, err := backup.MegolmBackupKeyFromBytes(data)
	if err != nil {
		return "", fmt.Errorf("the device is signed, but the key backup key is malformed: %w", err)
	}
	if err := m.mach.CryptoStore.PutSecret(ctx, id.SecretMegolmBackupV1, base64.StdEncoding.EncodeToString(data)); err != nil {
		return "", err
	}
	m.backupKey = backupKey
	version, err := m.mach.GetAndVerifyLatestKeyBackupVersion(ctx, backupKey)
	if err != nil || version == nil {
		return "", nil
	}
	m.backupVersion = version.Version
	_ = m.mach.SetKeyBackupVersion(ctx, version.Version)
	return version.Version, nil
}

// restoreFromBackup fetches one room key from the server-side backup, for a message whose key never
// reached this device directly. It reports whether the key is now in the store.
func (m *matrixCore) restoreFromBackup(ctx context.Context, roomID id.RoomID, sessionID id.SessionID) bool {
	if m.backupKey == nil || roomID == "" || sessionID == "" {
		return false
	}
	if m.backupVersion == "" {
		version, err := m.mach.GetAndVerifyLatestKeyBackupVersion(ctx, m.backupKey)
		if err != nil || version == nil {
			return false
		}
		m.backupVersion = version.Version
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	resp, err := m.cli.GetKeyBackupForRoomAndSession(ctx, m.backupVersion, roomID, sessionID)
	if err != nil || resp == nil {
		return false
	}
	data, err := resp.SessionData.Decrypt(m.backupKey)
	if err != nil {
		return false
	}
	imported, err := m.mach.ImportRoomKeyFromBackup(ctx, m.backupVersion, roomID, sessionID, data)
	return err == nil && imported != nil
}

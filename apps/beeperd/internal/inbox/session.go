package inbox

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// Session is the device this daemon runs as. The access token is as good as the device itself,
// so the file is owner-only and never leaves the state directory.
type Session struct {
	Homeserver  string `json:"homeserver"`
	UserID      string `json:"userId"`
	DeviceID    string `json:"deviceId"`
	AccessToken string `json:"accessToken"`
	DisplayName string `json:"displayName,omitempty"`
	// VerifiedAt is when the device was cross-signed from the recovery key (RFC 3339), if it was.
	VerifiedAt string `json:"verifiedAt,omitempty"`
	// KeyBackupVersion is the server-side key backup the device can read, once verified.
	KeyBackupVersion string `json:"keyBackupVersion,omitempty"`
}

// ErrNoSession means nobody has signed this home in yet.
var ErrNoSession = errors.New("no device yet")

// LoadSession reads the session file.
func LoadSession(path string) (*Session, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoSession
	} else if err != nil {
		return nil, err
	}
	var session Session
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, fmt.Errorf("%s isn't valid JSON: %w", path, err)
	}
	if session.Homeserver == "" || session.UserID == "" || session.DeviceID == "" || session.AccessToken == "" {
		return nil, fmt.Errorf("%s is missing homeserver, userId, deviceId or accessToken", path)
	}
	return &session, nil
}

// Save writes the session file atomically, owner-only.
func (s *Session) Save(path string) error {
	return host.WriteJSONAtomic(path, s)
}

// LoadOrCreatePickleKey returns the key that encrypts the crypto store. It is created once per
// device and never regenerated: a store can't be opened with any other key, so when the store
// exists and the key doesn't, that is an error and not a reason to make a new one.
func LoadOrCreatePickleKey(path string, storeExists bool) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		key := strings.TrimSpace(string(data))
		if key == "" {
			return nil, fmt.Errorf("%s is empty", path)
		}
		return []byte(key), nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if storeExists {
		return nil, fmt.Errorf("the crypto store exists but its key %s is missing; the store can't be opened without it", path)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	key := base64.RawStdEncoding.EncodeToString(raw)
	if err := os.WriteFile(path, []byte(key+"\n"), 0o600); err != nil {
		return nil, err
	}
	return []byte(key), nil
}

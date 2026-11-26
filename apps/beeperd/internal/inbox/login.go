package inbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"maunium.net/go/mautrix"
)

// Beeper's own sign-in, the one its apps use: a request, an emailed code, then a token the
// homeserver accepts as a JWT login. (Beeper names this header value itself.)
const (
	beeperAPI       = "https://api.beeper.com"
	beeperLoginAuth = "BEEPER-PRIVATE-API-PLEASE-DONT-USE"
	// beeperAppType is the client name Beeper's sign-in wants. Without one it answers
	// "old-client-login-disabled". This is the name of Beeper's own mautrix-go SDK for bots, which
	// the previous daemon used and which this one shares its Matrix library with.
	beeperAppType = "pickle"
	// BeeperHomeserver is Beeper's Matrix homeserver.
	BeeperHomeserver = "https://matrix.beeper.com"
)

// Login is a Beeper sign-in in progress.
type Login struct {
	API       string
	HTTP      *http.Client
	RequestID string
}

func (l *Login) post(ctx context.Context, path string, body map[string]any, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.API+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+beeperLoginAuth)
	req.Header.Set("content-type", "application/json")
	resp, err := l.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("Beeper sign-in %s: HTTP %d %s", path, resp.StatusCode, bytes.TrimSpace(raw))
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		// The email step answers 204 with no body.
		return nil
	}
	return json.Unmarshal(raw, out)
}

// StartLogin opens a sign-in request and has Beeper email the code to the account's address.
func StartLogin(ctx context.Context, email string) (*Login, error) {
	login := &Login{API: beeperAPI, HTTP: &http.Client{Timeout: 30 * time.Second}}
	var started struct {
		Request string `json:"request"`
	}
	if err := login.post(ctx, "/user/login", map[string]any{}, &started); err != nil {
		return nil, err
	}
	if started.Request == "" {
		return nil, fmt.Errorf("Beeper sign-in: the answer has no request ID")
	}
	login.RequestID = started.Request
	err := login.post(ctx, "/user/login/email", map[string]any{
		"request": login.RequestID, "email": email, "onlyExistingAccounts": true, "appType": beeperAppType,
	}, nil)
	if err != nil {
		return nil, err
	}
	return login, nil
}

// Finish trades the emailed code for a new device on the homeserver.
func (l *Login) Finish(ctx context.Context, code, deviceName string) (*Session, error) {
	var answer struct {
		Token string `json:"token"`
	}
	err := l.post(ctx, "/user/login/response", map[string]any{
		"request": l.RequestID, "response": code, "onlyExistingAccounts": true, "appType": beeperAppType,
	}, &answer)
	if err != nil {
		return nil, err
	}
	if answer.Token == "" {
		return nil, fmt.Errorf("Beeper sign-in: the answer has no token")
	}
	cli, err := mautrix.NewClient(BeeperHomeserver, "", "")
	if err != nil {
		return nil, err
	}
	resp, err := cli.Login(ctx, &mautrix.ReqLogin{
		Type:                     mautrix.AuthTypeSynapseJWT,
		Token:                    answer.Token,
		InitialDeviceDisplayName: deviceName,
	})
	if err != nil {
		return nil, fmt.Errorf("Matrix login: %w", err)
	}
	return &Session{
		Homeserver:  BeeperHomeserver,
		UserID:      resp.UserID.String(),
		DeviceID:    resp.DeviceID.String(),
		AccessToken: resp.AccessToken,
		DisplayName: deviceName,
	}, nil
}

// ResumeLogin continues a sign-in that StartLogin opened in an earlier process.
func ResumeLogin(requestID string) *Login {
	return &Login{API: beeperAPI, HTTP: &http.Client{Timeout: 30 * time.Second}, RequestID: requestID}
}

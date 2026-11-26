package inbox

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"time"
)

// PublishLinearIssue writes and verifies a Linear issue snapshot in this account's room data.
func (ib *Inbox) PublishLinearIssue(ctx context.Context, roomID string, record map[string]any) error {
	roomID, err := roomIDOf(roomID)
	if err != nil {
		return err
	}
	return ib.publishAccountData(ctx, "/rooms/"+url.PathEscape(roomID)+"/account_data/ai.leonsilicon.linear.issue", record)
}

// PublishProjectAppearance writes and verifies a Linear project's color and icon in room data.
func (ib *Inbox) PublishProjectAppearance(ctx context.Context, roomID string, record map[string]any) error {
	roomID, err := roomIDOf(roomID)
	if err != nil {
		return err
	}
	return ib.publishAccountData(ctx, "/rooms/"+url.PathEscape(roomID)+"/account_data/ai.leonsilicon.linear.project", record)
}

// PublishProjectVisibility writes and verifies closed Slack project channels in global data.
func (ib *Inbox) PublishProjectVisibility(ctx context.Context, record map[string]any) error {
	return ib.publishAccountData(ctx, "/account_data/ai.leonsilicon.linear.project_visibility", record)
}

func (ib *Inbox) publishAccountData(ctx context.Context, suffix string, record map[string]any) error {
	_, session, err := ib.ready()
	if err != nil {
		return err
	}
	path := "/_matrix/client/v3/user/" + url.PathEscape(session.UserID) + suffix
	saved, err := ib.matrix(ctx, http.MethodPut, path, nil, record, 15*time.Second)
	if err != nil {
		return toolError("unavailable", "Matrix account data write failed: "+trim(err.Error(), 200))
	}
	if saved.Status != 200 {
		return toolError("unavailable", fmt.Sprintf("Matrix account data write failed: HTTP %d", saved.Status))
	}
	readback, err := ib.matrix(ctx, http.MethodGet, path, nil, nil, 15*time.Second)
	if err != nil {
		return toolError("unavailable", "Matrix account data readback failed: "+trim(err.Error(), 200))
	}
	// Both sides went through JSON, so numbers compare as float64.
	var expected any = normalizeJSON(record)
	if readback.Status != 200 || !reflect.DeepEqual(readback.Body, expected) {
		return toolError("unavailable", fmt.Sprintf("Matrix account data readback failed: HTTP %d", readback.Status))
	}
	return nil
}

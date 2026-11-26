package inbox

import (
	"context"
	"os"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/format"
)

// Status is the inbox's health: device, encryption, sync, directory, recent sends, limits and what
// isn't supported. Hermes reads it through inbox_status.
func (ib *Inbox) Status(ctx context.Context) map[string]any {
	ib.mu.Lock()
	state, stateError, session, core := ib.state, ib.stateError, ib.session, ib.core
	messages, rooms, sends := ib.journal, ib.directory, ib.ledger
	startedAt, bootedAt, subscribed := ib.startedAt, ib.bootedAt, ib.syncCancel != nil
	ib.mu.Unlock()
	ib.syncMu.Lock()
	stats := ib.syncStats
	ib.syncMu.Unlock()
	now := ib.now()
	syncHealthy := stats.lastOKAt != 0 && now-stats.lastOKAt < syncStale.Milliseconds()

	out := map[string]any{
		"service":    "beeper-inbox",
		"version":    Version,
		"state":      string(state),
		"healthy":    state == StateReady && syncHealthy,
		"pid":        os.Getpid(),
		"started_at": format.ISOTime(startedAt),
		"booted_at":  nil,
		"account":    nil,
		"crypto":     nil,
		"sync": map[string]any{
			"subscribed":           subscribed,
			"last_state":           stats.state,
			"last_ok_at":           nil,
			"consecutive_failures": stats.consecutiveFailures,
			"last_error":           nil,
			"syncs":                stats.syncs,
		},
		"journal":                nil,
		"directory":              nil,
		"recent_sends":           []any{},
		"decryption_errors_seen": ib.cache.decryptErrorCount(),
		"limits": map[string]any{
			"max_download_bytes": MaxDownloadBytes, "max_upload_bytes": MaxUploadBytes, "max_page": MaxPage,
		},
		"paths": map[string]any{"downloads": ib.paths.Downloads, "state": ib.paths.State, "log": ib.paths.LogFile},
		"not_supported": []string{
			"starting new conversations",
			"edits and deletions",
			"Beeper merged chats (each bridged room is listed on its own)",
			"network-specific actions",
			"thread replies in bridged rooms (Beeper refuses /relations there)",
		},
	}
	if stateError != "" {
		out["state_error"] = stateError
	}
	if bootedAt != 0 {
		out["booted_at"] = format.ISOTime(bootedAt)
	}
	sync := out["sync"].(map[string]any)
	if stats.lastOKAt != 0 {
		sync["last_ok_at"] = format.ISOTime(stats.lastOKAt)
	}
	if stats.lastError != "" && stats.consecutiveFailures > 0 {
		sync["last_error"] = trim(stats.lastError, 300)
	}
	if session != nil {
		account := map[string]any{
			"user_id": session.UserID, "device_id": session.DeviceID, "homeserver": session.Homeserver, "display_name": nil,
		}
		if session.DisplayName != "" {
			account["display_name"] = session.DisplayName
		}
		out["account"] = account
		crypto := map[string]any{
			"state":              "unverified",
			"key_backup_version": nil,
			"has_key_backup_key": core != nil && core.backupKey != nil,
			"store_backed":       true,
			"cross_signed_at":    nil,
		}
		if session.VerifiedAt != "" {
			crypto["state"] = "verified"
			crypto["cross_signed_at"] = session.VerifiedAt
		}
		if session.KeyBackupVersion != "" {
			crypto["key_backup_version"] = session.KeyBackupVersion
		}
		out["crypto"] = crypto
	}
	if messages != nil {
		if journal, err := messages.Stats(); err == nil {
			out["journal"] = map[string]any{
				"head": journal.Head, "covered_since": format.ISOTime(journal.CoveredSince),
				"entries": journal.Entries, "waiting_for_keys": journal.Pending,
			}
		}
	}
	if rooms != nil {
		count, _ := rooms.Count()
		networks, _ := rooms.Networks()
		directory := map[string]any{"rooms": count, "refreshed_at": nil, "networks": networks}
		if refreshedAt, _ := rooms.RefreshedAt(); refreshedAt != nil {
			directory["refreshed_at"] = format.ISOTime(*refreshedAt)
		}
		out["directory"] = directory
	}
	if sends != nil {
		if recent, err := sends.Recent(10); err == nil {
			list := make([]map[string]any, 0, len(recent))
			for _, record := range recent {
				list = append(list, map[string]any{
					"room_id": record.RoomID, "kind": record.Kind, "status": record.Status, "event_id": record.EventID,
					"txn_id": record.TxnID, "attempts": record.Attempts, "updated_at": format.ISOTime(record.UpdatedAt),
				})
			}
			out["recent_sends"] = list
		}
	}
	return out
}

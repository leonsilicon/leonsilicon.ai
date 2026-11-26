package inbox

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"maunium.net/go/mautrix/id"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/directory"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/format"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// RoomInfos is what a service needs to know about rooms: name, network, connection, direct, muted.
// Unknown rooms are left out.
func (ib *Inbox) RoomInfos(roomIDs []string) ([]host.RoomInfo, error) {
	if _, _, err := ib.ready(); err != nil {
		return nil, err
	}
	rooms := ib.rooms()
	out := []host.RoomInfo{}
	seen := map[string]bool{}
	for _, roomID := range roomIDs {
		if seen[roomID] {
			continue
		}
		seen[roomID] = true
		record, err := rooms.Get(roomID)
		if err != nil || record == nil {
			continue
		}
		info := host.RoomInfo{RoomID: roomID, Name: record.Name, Network: record.Network, IsDirect: record.IsDirect}
		if record.Bridge != nil {
			info.NetworkName, info.ProtocolID, info.NetworkID = record.Bridge.ProtocolName, record.Bridge.ProtocolID, record.Bridge.NetworkID
		}
		info.IsMuted, _ = ib.cache.isMuted(roomID)
		out = append(out, info)
	}
	return out, nil
}

// Connections lists each bridge connection Leon's rooms belong to.
func (ib *Inbox) Connections() ([]host.Connection, error) {
	if _, _, err := ib.ready(); err != nil {
		return nil, err
	}
	return ib.rooms().Connections()
}

// Names returns display names for Matrix user IDs, where the homeserver has one.
func (ib *Inbox) Names(ctx context.Context, userIDs []string) (map[string]string, error) {
	if _, _, err := ib.ready(); err != nil {
		return nil, err
	}
	return ib.senderNames(ctx, userIDs), nil
}

func (ib *Inbox) senderNames(ctx context.Context, userIDs []string) map[string]string {
	out := map[string]string{}
	now := ib.now()
	var missing []string
	seen := map[string]bool{}
	ib.cache.mu.Lock()
	for _, userID := range userIDs {
		if seen[userID] {
			continue
		}
		seen[userID] = true
		cached, ok := ib.cache.profiles[userID]
		if ok && now-cached.at < 60*60_000 {
			if cached.name != "" {
				out[userID] = cached.name
			}
		} else {
			missing = append(missing, userID)
		}
	}
	ib.cache.mu.Unlock()
	if len(missing) > 40 {
		missing = missing[:40]
	}
	var found sync.Mutex
	for start := 0; start < len(missing); start += 8 {
		var group sync.WaitGroup
		for _, userID := range missing[start:min(start+8, len(missing))] {
			group.Add(1)
			go func() {
				defer group.Done()
				response, err := ib.matrix(ctx, http.MethodGet, "/_matrix/client/v3/profile/"+url.PathEscape(userID)+"/displayname", nil, nil, 10*time.Second)
				if err != nil {
					// A name is a convenience.
					return
				}
				name := ""
				if response.Status == 200 {
					name = text(response.object()["displayname"])
				}
				ib.cache.mu.Lock()
				ib.cache.profiles[userID] = profile{name: name, at: now}
				ib.cache.mu.Unlock()
				if name != "" {
					found.Lock()
					out[userID] = name
					found.Unlock()
				}
			}()
		}
		group.Wait()
	}
	return out
}

func (ib *Inbox) conversation(record directory.RoomRecord) map[string]any {
	out := map[string]any{
		"room_id":              record.RoomID,
		"name":                 record.Name,
		"network":              record.Network,
		"network_display_name": nil,
		"bridge":               nil,
		"is_direct":            record.IsDirect,
		"member_count":         record.MemberCount,
		"encrypted":            record.Encrypted,
		"last_activity":        nil,
	}
	if record.Bridge != nil {
		out["network_display_name"] = record.Bridge.ProtocolName
		out["bridge"] = map[string]any{
			"protocol_id":  record.Bridge.ProtocolID,
			"bridge_bot":   record.Bridge.BridgeBot,
			"channel_name": record.Bridge.ChannelName,
			"channel_id":   record.Bridge.ChannelID,
			"network_id":   record.Bridge.NetworkID,
			"account":      record.Bridge.Receiver,
			"room_type":    record.Bridge.RoomType,
		}
	}
	if muted, known := ib.cache.isMuted(record.RoomID); known {
		out["is_muted"] = muted
	}
	if record.LastEventTS != nil {
		out["last_activity"] = format.ISOTime(*record.LastEventTS)
	}
	if len(record.Heroes) > 0 && (record.Name == nil || *record.Name != strings.Join(record.Heroes, ", ")) {
		out["participants"] = record.Heroes
	}
	if len(record.Tags) > 0 {
		out["tags"] = record.Tags
	}
	return out
}

// ListConversations searches the room directory. refreshMaxAgeMS is how recent a rebuild may be for
// `refresh: true` to reuse it; 0 always rebuilds.
func (ib *Inbox) ListConversations(ctx context.Context, args map[string]any, refreshMaxAgeMS int64) (map[string]any, error) {
	if _, _, err := ib.ready(); err != nil {
		return nil, err
	}
	rooms := ib.rooms()
	count, err := rooms.Count()
	if err != nil {
		return nil, err
	}
	if count == 0 {
		if _, err := ib.RefreshDirectory(ctx, 0); err != nil {
			return nil, err
		}
	} else if refresh, _ := args["refresh"].(bool); refresh && !ib.directoryYoungerThan(refreshMaxAgeMS) {
		if _, err := ib.RefreshDirectory(ctx, refreshMaxAgeMS); err != nil {
			return nil, err
		}
	}
	limit := clamp(numberArg(args, "limit", 20), 1, 100)
	offset := max(numberArg(args, "offset", 0), 0)
	options := directory.SearchOptions{Limit: limit, Offset: offset}
	if query, ok := stringArg(args, "query"); ok {
		options.Query = strings.TrimSpace(query)
	}
	if network, ok := stringArg(args, "network"); ok {
		options.Network = strings.TrimSpace(network)
	}
	if direct, _ := args["direct_only"].(bool); direct {
		options.IsDirect = &direct
	}
	found, total, err := rooms.Search(options)
	if err != nil {
		return nil, err
	}
	conversations := make([]map[string]any, 0, len(found))
	for _, record := range found {
		conversations = append(conversations, ib.conversation(record))
	}
	out := map[string]any{
		"conversations":          conversations,
		"total":                  total,
		"offset":                 offset,
		"next_offset":            nil,
		"directory_refreshed_at": nil,
		"note":                   "Sorted by last activity. Names come from room state; search matches names, participants and bridge channel names. Use the exact room_id with the other tools.",
	}
	if offset+len(found) < total {
		out["next_offset"] = offset + len(found)
	}
	if refreshedAt, _ := rooms.RefreshedAt(); refreshedAt != nil {
		out["directory_refreshed_at"] = format.ISOTime(*refreshedAt)
	}
	return out, nil
}

// directoryYoungerThan reports whether the last full rebuild (by this process or an earlier one) is
// more recent than maxAgeMS. Zero means "never recent enough".
func (ib *Inbox) directoryYoungerThan(maxAgeMS int64) bool {
	if maxAgeMS <= 0 {
		return false
	}
	refreshedAt, err := ib.rooms().RefreshedAt()
	return err == nil && refreshedAt != nil && ib.now()-*refreshedAt < maxAgeMS
}

func (ib *Inbox) isJoined(ctx context.Context, roomID string) (bool, error) {
	if record, _ := ib.rooms().Get(roomID); record != nil {
		return true, nil
	}
	ib.mu.Lock()
	userID := ib.session.UserID
	ib.mu.Unlock()
	response, err := ib.matrix(ctx, http.MethodGet, roomPath(roomID)+"/state/m.room.member/"+url.PathEscape(userID), nil, nil, 0)
	if err != nil {
		return false, err
	}
	return response.Status == 200 && text(response.object()["membership"]) == "join", nil
}

func (ib *Inbox) requireJoined(ctx context.Context, roomID string) error {
	joined, err := ib.isJoined(ctx, roomID)
	if err != nil {
		return err
	}
	if !joined {
		return toolError("not_found", roomID+" isn't one of Leon's joined conversations on this account. Room IDs are used exactly as given (a :beeper.local suffix is normal); find the right one with list_conversations.")
	}
	return nil
}

// roomRecord returns a room's directory row, learning the room from the homeserver when the
// directory doesn't have it yet.
func (ib *Inbox) roomRecord(ctx context.Context, core *matrixCore, roomID string) *directory.RoomRecord {
	rooms := ib.rooms()
	if record, _ := rooms.Get(roomID); record != nil {
		return record
	}
	ib.learnRoom(ctx, core, rooms, id.RoomID(roomID), directory.SyncRoom{}, nil, core.cli.UserID.String(), ib.now())
	record, _ := rooms.Get(roomID)
	return record
}

func (ib *Inbox) roomEncrypted(ctx context.Context, roomID string) (bool, error) {
	if record, _ := ib.rooms().Get(roomID); record != nil && record.Encrypted {
		return true, nil
	}
	response, err := ib.matrix(ctx, http.MethodGet, roomPath(roomID)+"/state/m.room.encryption/", nil, nil, 0)
	if err != nil {
		return false, toolError("unavailable", "couldn't read "+roomID+"'s encryption state ("+err.Error()+")")
	}
	switch response.Status {
	case 200:
		return true, nil
	case 404:
		return false, nil
	}
	return false, toolError("unavailable", "couldn't read "+roomID+"'s encryption state (HTTP "+itoa(response.Status)+")")
}

// GetConversation describes one room.
func (ib *Inbox) GetConversation(ctx context.Context, args map[string]any) (map[string]any, error) {
	core, _, err := ib.ready()
	if err != nil {
		return nil, err
	}
	roomID, err := roomIDOf(args["room_id"])
	if err != nil {
		return nil, err
	}
	if err := ib.requireJoined(ctx, roomID); err != nil {
		return nil, err
	}
	out := map[string]any{"room_id": roomID, "network": "unknown", "name": nil, "member_count": nil, "encrypted": false}
	record := ib.roomRecord(ctx, core, roomID)
	if record != nil {
		out = ib.conversation(*record)
	}
	if members, err := core.cli.JoinedMembers(ctx, id.RoomID(roomID)); err == nil {
		out["member_count"] = len(members.Joined)
	}
	if encrypted, err := ib.roomEncrypted(ctx, roomID); err == nil && encrypted {
		out["encrypted"] = true
	}
	if user := ib.cache.directUser(roomID); user != "" {
		out["direct_user_id"] = user
	}
	return out, nil
}

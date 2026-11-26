package inbox

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime/debug"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/directory"
)

// directoryState are the state events a room's directory row is built from.
var directoryState = map[string]bool{
	event.StateRoomName.Type: true, event.StateCanonicalAlias.Type: true, event.StateEncryption.Type: true,
	event.StateTombstone.Type: true, event.StateBridge.Type: true, event.StateHalfShotBridge.Type: true,
}

func stateEvents(events []*event.Event) []directory.StateEvent {
	out := make([]directory.StateEvent, 0, len(events))
	for _, evt := range events {
		if evt == nil {
			continue
		}
		out = append(out, directory.StateEvent{
			Type: evt.Type.Type, StateKey: evt.StateKey, Content: evt.Content.Raw,
			Sender: evt.Sender.String(), OriginServerTS: evt.Timestamp,
		})
	}
	return out
}

func syncRoom(room *mautrix.SyncJoinedRoom) directory.SyncRoom {
	state := room.State.Events
	if room.StateAfter != nil {
		state = room.StateAfter.Events
	}
	out := directory.SyncRoom{
		State:       directory.EventList{Events: stateEvents(state)},
		Timeline:    directory.EventList{Events: stateEvents(room.Timeline.Events)},
		AccountData: directory.EventList{Events: stateEvents(room.AccountData.Events)},
	}
	for _, hero := range room.Summary.Heroes {
		out.Summary.Heroes = append(out.Summary.Heroes, hero.String())
	}
	out.Summary.JoinedMemberCount = room.Summary.JoinedMemberCount
	out.Summary.InvitedMemberCount = room.Summary.InvitedMemberCount
	return out
}

// directoryFromSync keeps the room directory current from what sync delivers, so nothing has to
// rebuild it on a timer: the first sync fills it, later ones add new rooms and apply changes.
func (ib *Inbox) directoryFromSync(ctx context.Context, core *matrixCore, resp *mautrix.RespSync, initial bool) {
	rooms := ib.rooms()
	if rooms == nil {
		return
	}
	for _, evt := range resp.AccountData.Events {
		if evt != nil && evt.Type.Type == event.AccountDataDirectChats.Type {
			ib.cache.setDirect(evt.Content.Raw)
		}
	}
	own := core.cli.UserID.String()
	now := ib.now()
	if initial {
		records := make([]directory.RoomRecord, 0, len(resp.Rooms.Join))
		for roomID, room := range resp.Rooms.Join {
			records = append(records, directory.RecordFromSyncRoom(roomID.String(), syncRoom(room), ib.cache.isDirect(roomID.String()), own, now))
		}
		if err := rooms.ReplaceAll(records, now); err != nil {
			ib.log("warn", "directory update failed", map[string]any{"error": err.Error()})
			return
		}
		ib.log("info", "directory built from the first sync", map[string]any{"rooms": len(records)})
		return
	}
	for roomID, room := range resp.Rooms.Join {
		existing, err := rooms.Get(roomID.String())
		if err != nil {
			continue
		}
		synced := syncRoom(room)
		changed := false
		for _, evt := range append(append([]directory.StateEvent{}, synced.State.Events...), synced.Timeline.Events...) {
			if evt.StateKey != nil && directoryState[evt.Type] {
				changed = true
				break
			}
		}
		switch {
		case existing == nil && len(synced.State.Events) > 0:
			// A room joined since the last sync comes with its state.
			ib.upsertRoom(rooms, directory.RecordFromSyncRoom(roomID.String(), synced, ib.cache.isDirect(roomID.String()), own, now), nil, now)
		case existing == nil || changed:
			ib.learnRoom(ctx, core, rooms, roomID, synced, existing, own, now)
		case len(synced.AccountData.Events) > 0:
			// Leon tagged or untagged the chat.
			fresh := directory.RecordFromSyncRoom(roomID.String(), synced, existing.IsDirect, own, now)
			updated := *existing
			updated.Tags = fresh.Tags
			ib.upsertRoom(rooms, updated, nil, now)
		}
	}
	for roomID := range resp.Rooms.Leave {
		ib.mu.Lock()
		db := ib.db
		ib.mu.Unlock()
		if db != nil {
			_, _ = db.Exec("DELETE FROM rooms WHERE room_id = ?", roomID.String())
		}
	}
}

// learnRoom rebuilds one room's row from its full state on the homeserver.
func (ib *Inbox) learnRoom(ctx context.Context, core *matrixCore, rooms *directory.RoomDirectory, roomID id.RoomID, synced directory.SyncRoom, existing *directory.RoomRecord, own string, now int64) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	state, err := core.cli.State(ctx, roomID)
	if err != nil {
		ib.log("warn", "couldn't read a room's state", map[string]any{"roomId": roomID.String(), "error": trim(err.Error(), 200)})
		return
	}
	var events []*event.Event
	for _, byKey := range state {
		for _, evt := range byKey {
			events = append(events, evt)
		}
	}
	synced.State = directory.EventList{Events: stateEvents(events)}
	direct := ib.cache.isDirect(roomID.String()) || (existing != nil && existing.IsDirect)
	ib.upsertRoom(rooms, directory.RecordFromSyncRoom(roomID.String(), synced, direct, own, now), existing, now)
}

// upsertRoom writes a room's row. What an incremental sync doesn't repeat (the room's summary, its
// tags, its latest activity) is kept from the row it replaces.
func (ib *Inbox) upsertRoom(rooms *directory.RoomDirectory, record directory.RoomRecord, existing *directory.RoomRecord, now int64) {
	if existing != nil {
		if record.Name == nil {
			record.Name = existing.Name
		}
		if len(record.Heroes) == 0 {
			record.Heroes = existing.Heroes
		}
		if record.MemberCount == nil {
			record.MemberCount = existing.MemberCount
		}
		if record.LastEventTS == nil {
			record.LastEventTS, record.LastSender = existing.LastEventTS, existing.LastSender
		}
		if len(record.Tags) == 0 {
			record.Tags = existing.Tags
		}
	}
	if err := rooms.Upsert(record, now); err != nil {
		ib.log("warn", "directory update failed", map[string]any{"error": err.Error()})
	}
}

// RefreshDirectory rebuilds the directory from a full snapshot, sharing a rebuild that is already
// running. With maxAgeMS, a rebuild that started that recently is reused instead.
func (ib *Inbox) RefreshDirectory(ctx context.Context, maxAgeMS int64) (map[string]any, error) {
	if _, _, err := ib.ready(); err != nil {
		return nil, err
	}
	result, err := ib.refresh.get(maxAgeMS)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"rooms":        result.Rooms,
		"refreshed_at": time.UnixMilli(result.RefreshedAt).UTC().Format("2006-01-02T15:04:05.000Z"),
		"ms":           result.TookMS,
	}, nil
}

func (ib *Inbox) refreshDirectoryNow() (refreshResult, error) {
	rooms := ib.rooms()
	ib.mu.Lock()
	session := ib.session
	ib.mu.Unlock()
	if rooms == nil || session == nil {
		return refreshResult{}, toolError("unavailable", "beeper-inbox's stores aren't open")
	}
	started := ib.now()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	// A sync without `since` is a stateless snapshot: it doesn't acknowledge to-device messages or
	// move the device's own position, so it can't take room keys away from the live sync.
	target := session.Homeserver + "/_matrix/client/v3/sync?" + url.Values{
		"filter": {directory.DirectoryFilter}, "timeout": {"0"}, "set_presence": {"offline"},
	}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return refreshResult{}, err
	}
	req.Header.Set("authorization", "Bearer "+session.AccessToken)
	resp, err := httpClient.Do(req)
	if err != nil {
		return refreshResult{}, toolError("unavailable", "directory sync failed: "+trim(err.Error(), 200))
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return refreshResult{}, toolError("unavailable", fmt.Sprintf("directory sync failed: HTTP %d", resp.StatusCode))
	}
	now := ib.now()
	records, err := recordsFromSnapshot(resp.Body, session.UserID, now)
	if err != nil {
		return refreshResult{}, toolError("unavailable", "directory sync returned unreadable JSON: "+trim(err.Error(), 200))
	}
	if err := rooms.ReplaceAll(records, now); err != nil {
		return refreshResult{}, err
	}
	// The snapshot is megabytes of JSON; give the memory back instead of keeping it for next time.
	debug.FreeOSMemory()
	took := ib.now() - started
	ib.log("info", "directory refreshed", map[string]any{"rooms": len(records), "ms": took})
	return refreshResult{Rooms: len(records), RefreshedAt: ib.now(), TookMS: took}, nil
}

// recordsFromSnapshot reads a sync snapshot one room at a time, so the whole answer (every room's
// state: megabytes) is never held in memory at once.
func recordsFromSnapshot(body io.Reader, ownUserID string, now int64) ([]directory.RoomRecord, error) {
	decoder := json.NewDecoder(body)
	var records []directory.RoomRecord
	direct := map[string]bool{}
	skip := func() error {
		var ignored json.RawMessage
		return decoder.Decode(&ignored)
	}
	// object walks a JSON object, calling member for each key with the decoder at its value.
	object := func(member func(key string) error) error {
		if token, err := decoder.Token(); err != nil {
			return err
		} else if token != json.Delim('{') {
			return fmt.Errorf("expected an object, got %v", token)
		}
		for decoder.More() {
			token, err := decoder.Token()
			if err != nil {
				return err
			}
			key, _ := token.(string)
			if err := member(key); err != nil {
				return err
			}
		}
		_, err := decoder.Token()
		return err
	}
	err := object(func(key string) error {
		switch key {
		case "account_data":
			var list directory.EventList
			if err := decoder.Decode(&list); err != nil {
				return err
			}
			for _, evt := range list.Events {
				if evt.Type != "m.direct" {
					continue
				}
				for _, listed := range evt.Content {
					roomIDs, _ := listed.([]any)
					for _, roomID := range roomIDs {
						if id, ok := roomID.(string); ok {
							direct[id] = true
						}
					}
				}
			}
			return nil
		case "rooms":
			return object(func(key string) error {
				if key != "join" {
					return skip()
				}
				return object(func(roomID string) error {
					var room directory.SyncRoom
					if err := decoder.Decode(&room); err != nil {
						return err
					}
					records = append(records, directory.RecordFromSyncRoom(roomID, room, false, ownUserID, now))
					return nil
				})
			})
		}
		return skip()
	})
	if err != nil {
		return nil, err
	}
	// The list of direct chats may come after the rooms it names.
	for index := range records {
		if direct[records[index].RoomID] {
			records[index].IsDirect = true
		}
	}
	return records, nil
}

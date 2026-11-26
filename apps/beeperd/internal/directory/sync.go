package directory

import (
	"maps"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// BridgeInfo is what a room's bridge state event says about the chat it mirrors.
type BridgeInfo struct {
	StateKey     string  `json:"stateKey"`
	ProtocolID   *string `json:"protocolId"`
	ProtocolName *string `json:"protocolName"`
	// NetworkID is the bridged network's own ID for this connection, when the bridge gives one (a
	// Slack team ID). Rows written before it existed don't have it.
	NetworkID   *string `json:"networkId"`
	ChannelName *string `json:"channelName"`
	ChannelID   *string `json:"channelId"`
	Receiver    *string `json:"receiver"`
	BridgeBot   *string `json:"bridgeBot"`
	RoomType    *string `json:"roomType"`
}

// RoomRecord is one room of the directory.
type RoomRecord struct {
	RoomID string  `json:"roomId"`
	Name   *string `json:"name"`
	// Network is the short network name, as the Slack feed channels use it: whatsapp, instagram,
	// imessage, beeper…
	Network        string      `json:"network"`
	Bridge         *BridgeInfo `json:"bridge"`
	IsDirect       bool        `json:"isDirect"`
	MemberCount    *int        `json:"memberCount"`
	Encrypted      bool        `json:"encrypted"`
	CanonicalAlias *string     `json:"canonicalAlias"`
	// LastEventTS is when the room's latest event was sent (Unix ms).
	LastEventTS *int64   `json:"lastEventTs"`
	LastSender  *string  `json:"lastSender"`
	Tags        []string `json:"tags"`
	// Heroes are the display names of the room's other members, as far as the summary gives them.
	Heroes    []string `json:"heroes"`
	UpdatedAt int64    `json:"updatedAt"`
}

var networkAliases = map[string]string{
	"matrix":       "beeper",
	"hungryserv":   "beeper",
	"twitter":      "x",
	"facebook":     "messenger",
	"gmessages":    "sms",
	"gvoice":       "google-voice",
	"googlechat":   "google-chat",
	"chatgpt-dots": "chatgpt",
	"grokbot":      "grok",
}

var (
	goSuffix        = regexp.MustCompile(`^(.{3,})go$`)
	notAlphanumeric = regexp.MustCompile(`[^a-z0-9]+`)
)

// NormalizeNetwork turns a bridge's protocol ID into the short network name. No protocol ID means a
// plain Matrix room: beeper.
func NormalizeNetwork(protocolID string) string {
	if protocolID == "" {
		return "beeper"
	}
	id := strings.TrimPrefix(strings.ToLower(protocolID), "local-")
	id = goSuffix.ReplaceAllString(id, "$1")
	if alias, known := networkAliases[id]; known {
		return alias
	}
	if name := strings.Trim(notAlphanumeric.ReplaceAllString(id, "-"), "-"); name != "" {
		return name
	}
	return "other"
}

// StateEvent is a room event as /sync gives it, with the fields the directory reads. A timeline
// event that isn't a state event has no StateKey. OriginServerTS and Sender are zero when the event
// doesn't have them.
type StateEvent struct {
	Type           string         `json:"type,omitempty"`
	StateKey       *string        `json:"state_key,omitempty"`
	Content        map[string]any `json:"content,omitempty"`
	Sender         string         `json:"sender,omitempty"`
	OriginServerTS int64          `json:"origin_server_ts,omitempty"`
}

// EventList is a list of events as /sync wraps it.
type EventList struct {
	Events []StateEvent `json:"events,omitempty"`
}

// RoomSummary is a room's summary in /sync.
type RoomSummary struct {
	Heroes             []string `json:"m.heroes,omitempty"`
	JoinedMemberCount  *int     `json:"m.joined_member_count,omitempty"`
	InvitedMemberCount *int     `json:"m.invited_member_count,omitempty"`
}

// SyncRoom is one joined room of a /sync response.
type SyncRoom struct {
	State       EventList   `json:"state"`
	Timeline    EventList   `json:"timeline"`
	Summary     RoomSummary `json:"summary"`
	AccountData EventList   `json:"account_data"`
}

// SyncRooms are the rooms of a /sync response.
type SyncRooms struct {
	Join map[string]SyncRoom `json:"join,omitempty"`
}

// SyncBody is the part of a /sync response the directory is built from.
type SyncBody struct {
	Rooms       SyncRooms `json:"rooms"`
	AccountData EventList `json:"account_data"`
}

// DirectoryFilter is the /sync filter for a directory refresh: room metadata and each room's latest
// event, nothing else.
const DirectoryFilter = `{"presence":{"types":[]},"account_data":{"types":["m.direct"]},"room":{"state":{"types":["m.room.name","m.room.canonical_alias","m.room.encryption","m.room.member","m.room.tombstone","m.bridge","uk.half-shot.bridge"],"lazy_load_members":true},"timeline":{"limit":1,"lazy_load_members":true},"ephemeral":{"types":[]},"account_data":{"types":["m.tag"]},"include_leave":false}}`

// filled is a string that isn't empty, or nil for anything else.
func filled(value any) *string {
	if found, isString := value.(string); isString && found != "" {
		return &found
	}
	return nil
}

// BridgeFrom reads a room's bridge from its state: the first m.bridge event, or else the first
// event of its older name. It returns nil for a room that isn't bridged.
func BridgeFrom(events []StateEvent) *BridgeInfo {
	var event *StateEvent
	for index := range events {
		if events[index].Type == "m.bridge" {
			event = &events[index]
			break
		}
		if events[index].Type == "uk.half-shot.bridge" && event == nil {
			event = &events[index]
		}
	}
	if event == nil || event.Content == nil {
		return nil
	}
	content := event.Content
	protocol, _ := content["protocol"].(map[string]any)
	channel, _ := content["channel"].(map[string]any)
	network, _ := content["network"].(map[string]any)
	bridge := &BridgeInfo{
		ProtocolID:   filled(protocol["id"]),
		ProtocolName: filled(protocol["displayname"]),
		NetworkID:    filled(network["id"]),
		ChannelName:  filled(channel["displayname"]),
		ChannelID:    filled(channel["id"]),
		Receiver:     filled(channel["receiver"]),
		BridgeBot:    filled(content["bridgebot"]),
		RoomType:     filled(content["com.beeper.room_type"]),
	}
	if event.StateKey != nil {
		bridge.StateKey = *event.StateKey
	}
	if bridge.RoomType == nil {
		bridge.RoomType = filled(content["com.beeper.room_type.v2"])
	}
	return bridge
}

// given says whether a JSON value counts as present, the way the TypeScript service's `!name` did:
// null, false, 0 and "" don't.
func given(value any) bool {
	switch value := value.(type) {
	case nil:
		return false
	case bool:
		return value
	case float64:
		return value != 0
	case string:
		return value != ""
	}
	return true
}

// trim removes the leading and trailing whitespace JavaScript's trim does. strings.TrimSpace differs
// in two characters (it drops U+0085 and keeps U+FEFF), and a room keeps the name it had under the
// TypeScript service.
func trim(text string) string {
	return strings.TrimFunc(text, func(char rune) bool {
		switch char {
		case '\t', '\n', '\v', '\f', '\r', 0x2028, 0x2029, 0xFEFF:
			return true
		}
		return unicode.Is(unicode.Zs, char)
	})
}

// RecordFromSyncRoom builds the directory row of one joined room from its part of a /sync response.
// direct says whether the account's m.direct list names the room. The room's part must hold its
// whole state (as a sync without `since` gives it): what is missing reads as absent.
func RecordFromSyncRoom(roomID string, room SyncRoom, direct bool, ownUserID string, now int64) RoomRecord {
	timeline := room.Timeline.Events
	state := slices.Clone(room.State.Events)
	for _, event := range timeline {
		if event.StateKey != nil {
			state = append(state, event)
		}
	}
	latest := func(eventType, field string) any {
		for index := len(state) - 1; index >= 0; index-- {
			if state[index].Type == eventType {
				return state[index].Content[field]
			}
		}
		return nil
	}
	name := latest("m.room.name", "name")
	bridge := BridgeFrom(state)
	members := map[string]string{}
	encrypted := false
	for _, event := range state {
		if event.Type == "m.room.encryption" {
			encrypted = true
		}
		if event.Type != "m.room.member" || event.StateKey == nil || *event.StateKey == "" {
			continue
		}
		if displayName, isString := event.Content["displayname"].(string); isString {
			members[*event.StateKey] = displayName
		}
	}
	heroes := []string{}
	for _, user := range room.Summary.Heroes {
		if user == ownUserID {
			continue
		}
		if displayName, known := members[user]; known {
			user = displayName
		}
		heroes = append(heroes, user)
	}
	protocolID, roomType := "", ""
	if bridge != nil && bridge.ProtocolID != nil {
		protocolID = *bridge.ProtocolID
	}
	if bridge != nil && bridge.RoomType != nil {
		roomType = *bridge.RoomType
	}
	joined := room.Summary.JoinedMemberCount
	record := RoomRecord{
		RoomID:    roomID,
		Network:   NormalizeNetwork(protocolID),
		Bridge:    bridge,
		IsDirect:  direct || roomType == "dm" || (joined != nil && *joined <= 2 && !given(name)),
		Encrypted: encrypted,
		Tags:      []string{},
		Heroes:    heroes,
		UpdatedAt: now,
	}
	if title, isString := name.(string); isString && trim(title) != "" {
		title = trim(title)
		record.Name = &title
	} else if len(heroes) > 0 {
		title := strings.Join(heroes, ", ")
		record.Name = &title
	}
	if joined != nil {
		count := *joined
		record.MemberCount = &count
	}
	if alias, isString := latest("m.room.canonical_alias", "alias").(string); isString {
		record.CanonicalAlias = &alias
	}
	if len(timeline) > 0 {
		last := timeline[len(timeline)-1]
		if last.OriginServerTS != 0 {
			record.LastEventTS = &last.OriginServerTS
		}
		if last.Sender != "" {
			record.LastSender = &last.Sender
		}
	}
	for _, event := range room.AccountData.Events {
		if event.Type != "m.tag" {
			continue
		}
		// A Go map has no order, so the tags are sorted to give the same row every time.
		if tags, isObject := event.Content["tags"].(map[string]any); isObject {
			record.Tags = slices.Sorted(maps.Keys(tags))
		}
		break
	}
	return record
}

// RoomsFromSync builds directory rows from a filtered sync response, in room ID order.
func RoomsFromSync(body SyncBody, ownUserID string, now int64) []RoomRecord {
	direct := map[string]bool{}
	for _, event := range body.AccountData.Events {
		if event.Type != "m.direct" {
			continue
		}
		for _, rooms := range event.Content {
			list, _ := rooms.([]any)
			for _, room := range list {
				if roomID, isString := room.(string); isString {
					direct[roomID] = true
				}
			}
		}
	}
	records := []RoomRecord{}
	for _, roomID := range slices.Sorted(maps.Keys(body.Rooms.Join)) {
		records = append(records, RecordFromSyncRoom(roomID, body.Rooms.Join[roomID], direct[roomID], ownUserID, now))
	}
	return records
}

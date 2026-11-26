package directory

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/sqlitedb"
)

func open(t *testing.T) *RoomDirectory {
	t.Helper()
	db, err := sqlitedb.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	directory, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func must[T any](value T, err error) func(t *testing.T) T {
	return func(t *testing.T) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
}

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func equal(t *testing.T, got, want any, message string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %s, want %s", message, show(got), show(want))
	}
}

func show(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err.Error()
	}
	return string(encoded)
}

func ptr[T any](value T) *T { return &value }

func search(t *testing.T, directory *RoomDirectory, options SearchOptions) ([]string, int) {
	t.Helper()
	rooms, total, err := directory.Search(options)
	check(t, err)
	ids := []string{}
	for _, room := range rooms {
		ids = append(ids, room.RoomID)
	}
	return ids, total
}

func find(t *testing.T, rooms []RoomRecord, roomID string) RoomRecord {
	t.Helper()
	for _, room := range rooms {
		if room.RoomID == roomID {
			return room
		}
	}
	t.Fatalf("no room %s", roomID)
	return RoomRecord{}
}

func parse[T any](t *testing.T, text string) T {
	t.Helper()
	var value T
	check(t, json.Unmarshal([]byte(text), &value))
	return value
}

const syncBody = `{
  "account_data": {
    "events": [{ "type": "m.direct", "content": { "@x:beeper.local": ["!dm:beeper.local"] } }]
  },
  "rooms": {
    "join": {
      "!dm:beeper.local": {
        "state": {
          "events": [
            { "type": "m.room.encryption", "state_key": "", "content": { "algorithm": "m.megolm.v1.aes-sha2" } },
            {
              "type": "m.bridge",
              "state_key": "fi.mau.whatsapp://whatsapp/123",
              "content": {
                "bridgebot": "@whatsappbot:beeper.local",
                "protocol": { "id": "whatsapp", "displayname": "WhatsApp" },
                "channel": { "id": "123", "displayname": "Sam", "receiver": "acct1" },
                "com.beeper.room_type": "dm"
              }
            },
            {
              "type": "m.room.member",
              "state_key": "@whatsapp_123:beeper.local",
              "content": { "displayname": "Sam Lee", "membership": "join" }
            }
          ]
        },
        "summary": { "m.heroes": ["@whatsapp_123:beeper.local"], "m.joined_member_count": 2 },
        "timeline": {
          "events": [
            { "type": "m.room.encrypted", "sender": "@whatsapp_123:beeper.local", "origin_server_ts": 5000, "content": {} }
          ]
        }
      },
      "!group:beeper.local": {
        "state": {
          "events": [
            { "type": "m.room.name", "state_key": "", "content": { "name": "Study group" } },
            { "type": "m.bridge", "state_key": "k", "content": { "protocol": { "id": "instagramgo" } } }
          ]
        },
        "summary": { "m.joined_member_count": 6 },
        "timeline": {
          "events": [
            { "type": "m.room.message", "sender": "@me:beeper.com", "origin_server_ts": 9000, "content": {} }
          ]
        }
      },
      "!note:beeper.com": {
        "state": {
          "events": [{ "type": "m.room.name", "state_key": "", "content": { "name": "Note to self" } }]
        }
      }
    }
  }
}`

func TestBridgeIdentityNamesDirectChatsAndSearch(t *testing.T) {
	rooms := RoomsFromSync(parse[SyncBody](t, syncBody), "@me:beeper.com", 1)
	dm := find(t, rooms, "!dm:beeper.local")
	equal(t, dm.Name, ptr("Sam Lee"), "a direct chat is named after the other person")
	equal(t, dm.Network, "whatsapp", "network")
	equal(t, dm.IsDirect, true, "direct")
	equal(t, dm.Encrypted, true, "encrypted")
	equal(t, dm.Bridge.Receiver, ptr("acct1"), "the bridge's account")
	equal(t, find(t, rooms, "!group:beeper.local").Network, "instagram", "a Go bridge's network")
	equal(t, find(t, rooms, "!note:beeper.com").Network, "beeper", "a room with no bridge")
	directory := open(t)
	check(t, directory.ReplaceAll(rooms, 1))
	ids, _ := search(t, directory, SearchOptions{Limit: 10})
	equal(t, ids, []string{"!group:beeper.local", "!dm:beeper.local", "!note:beeper.com"}, "the latest activity first")
	_, total := search(t, directory, SearchOptions{Query: "sam", Limit: 10})
	equal(t, total, 1, "search by name")
	_, total = search(t, directory, SearchOptions{Network: "WhatsApp", Limit: 10})
	equal(t, total, 1, "search by network")
	_, total = search(t, directory, SearchOptions{Query: "!note:beeper.com", Limit: 10})
	equal(t, total, 1, "search by room ID")
	check(t, directory.Touch("!note:beeper.com", 10_000, "@me:beeper.com"))
	ids, _ = search(t, directory, SearchOptions{Limit: 1})
	equal(t, ids, []string{"!note:beeper.com"}, "activity moves a room to the top")
	equal(t, NormalizeNetwork("discordgo"), "discord", "a Go bridge")
	equal(t, NormalizeNetwork("twitter"), "x", "a renamed network")
}

// The rows below are what directory.ts builds from the same sync response.
func TestRowsFromSync(t *testing.T) {
	equal(t, RoomsFromSync(parse[SyncBody](t, syncBody), "@me:beeper.com", 1), []RoomRecord{
		{
			RoomID:  "!dm:beeper.local",
			Name:    ptr("Sam Lee"),
			Network: "whatsapp",
			Bridge: &BridgeInfo{
				StateKey:     "fi.mau.whatsapp://whatsapp/123",
				ProtocolID:   ptr("whatsapp"),
				ProtocolName: ptr("WhatsApp"),
				ChannelName:  ptr("Sam"),
				ChannelID:    ptr("123"),
				Receiver:     ptr("acct1"),
				BridgeBot:    ptr("@whatsappbot:beeper.local"),
				RoomType:     ptr("dm"),
			},
			IsDirect:    true,
			MemberCount: ptr(2),
			Encrypted:   true,
			LastEventTS: ptr(int64(5000)),
			LastSender:  ptr("@whatsapp_123:beeper.local"),
			Tags:        []string{},
			Heroes:      []string{"Sam Lee"},
			UpdatedAt:   1,
		},
		{
			RoomID:      "!group:beeper.local",
			Name:        ptr("Study group"),
			Network:     "instagram",
			Bridge:      &BridgeInfo{StateKey: "k", ProtocolID: ptr("instagramgo")},
			MemberCount: ptr(6),
			LastEventTS: ptr(int64(9000)),
			LastSender:  ptr("@me:beeper.com"),
			Tags:        []string{},
			Heroes:      []string{},
			UpdatedAt:   1,
		},
		{
			RoomID:    "!note:beeper.com",
			Name:      ptr("Note to self"),
			Network:   "beeper",
			Tags:      []string{},
			Heroes:    []string{},
			UpdatedAt: 1,
		},
	}, "rows, in room ID order")
}

func TestOneRoomFromSync(t *testing.T) {
	room := parse[SyncRoom](t, `{
    "state": { "events": [
      { "type": "m.room.name", "state_key": "", "content": { "name": "Old name" } },
      { "type": "m.room.canonical_alias", "state_key": "", "content": { "alias": "#team:beeper.com" } },
      { "type": "uk.half-shot.bridge", "state_key": "old", "content": { "protocol": { "id": "telegram" }, "com.beeper.room_type.v2": "group" } },
      { "type": "m.room.member", "state_key": "@a:x", "content": { "displayname": "Ann & Bo" } },
      { "type": "m.room.member", "state_key": "@me:x", "content": { "displayname": "Me" } }
    ] },
    "timeline": { "events": [
      { "type": "m.room.name", "state_key": "", "sender": "@a:x", "origin_server_ts": 100, "content": { "name": "  New name  " } },
      { "type": "m.room.message", "sender": "@b:x", "origin_server_ts": 200, "content": { "body": "hi" } }
    ] },
    "summary": { "m.heroes": ["@me:x", "@a:x", "@b:x"], "m.joined_member_count": 3, "m.invited_member_count": 1 },
    "account_data": { "events": [
      { "type": "m.fully_read", "content": {} },
      { "type": "m.tag", "content": { "tags": { "u.work": {}, "m.favourite": { "order": 0.5 } } } }
    ] }
  }`)
	record := RecordFromSyncRoom("!team:x", room, false, "@me:x", 7)
	equal(t, record, RoomRecord{
		RoomID:         "!team:x",
		Name:           ptr("New name"),
		Network:        "telegram",
		Bridge:         &BridgeInfo{StateKey: "old", ProtocolID: ptr("telegram"), RoomType: ptr("group")},
		MemberCount:    ptr(3),
		CanonicalAlias: ptr("#team:beeper.com"),
		LastEventTS:    ptr(int64(200)),
		LastSender:     ptr("@b:x"),
		Tags:           []string{"m.favourite", "u.work"},
		Heroes:         []string{"Ann & Bo", "@b:x"},
		UpdatedAt:      7,
	}, "state in the timeline counts, and the latest event of any kind is the last activity")
	equal(t, RecordFromSyncRoom("!team:x", room, true, "@me:x", 7).IsDirect, true, "a room on the m.direct list")

	// With no name, the other members name the room, and two members make it a direct chat.
	unnamed := SyncRoom{
		State:   EventList{Events: []StateEvent{{Type: "m.room.member", StateKey: ptr("@a:x"), Content: map[string]any{"displayname": "Ann"}}}},
		Summary: RoomSummary{Heroes: []string{"@a:x", "@c:x"}, JoinedMemberCount: ptr(2)},
	}
	record = RecordFromSyncRoom("!pair:x", unnamed, false, "@me:x", 7)
	equal(t, []any{record.Name, record.IsDirect, record.Heroes}, []any{ptr("Ann, @c:x"), true, []string{"Ann", "@c:x"}}, "an unnamed pair")
	unnamed.State.Events = append(unnamed.State.Events, StateEvent{Type: "m.room.name", StateKey: ptr(""), Content: map[string]any{"name": "Pair"}})
	equal(t, RecordFromSyncRoom("!pair:x", unnamed, false, "@me:x", 7).IsDirect, false, "a named pair")
	equal(t, RecordFromSyncRoom("!empty:x", SyncRoom{}, false, "@me:x", 7),
		RoomRecord{RoomID: "!empty:x", Network: "beeper", Tags: []string{}, Heroes: []string{}, UpdatedAt: 7}, "a room nothing is known about")
}

func TestBridgeFrom(t *testing.T) {
	old := StateEvent{Type: "uk.half-shot.bridge", StateKey: ptr("old"), Content: map[string]any{"protocol": map[string]any{"id": "signal"}}}
	current := StateEvent{Type: "m.bridge", StateKey: ptr("new"), Content: map[string]any{
		"protocol": map[string]any{"id": "slackgo", "displayname": "Slack"},
		"network":  map[string]any{"id": "T123"},
		"channel":  "not an object",
	}}
	equal(t, BridgeFrom([]StateEvent{old, current}),
		&BridgeInfo{StateKey: "new", ProtocolID: ptr("slackgo"), ProtocolName: ptr("Slack"), NetworkID: ptr("T123")},
		"m.bridge wins over its older name, wherever it comes")
	equal(t, BridgeFrom([]StateEvent{{Type: "m.room.name"}, old}).ProtocolID, ptr("signal"), "the older name alone")
	equal(t, BridgeFrom([]StateEvent{{Type: "m.room.name"}}), (*BridgeInfo)(nil), "no bridge")
	equal(t, BridgeFrom([]StateEvent{{Type: "m.bridge"}, old}), (*BridgeInfo)(nil), "a bridge event with no content")
	equal(t, BridgeFrom([]StateEvent{{Type: "m.bridge", Content: map[string]any{"bridgebot": ""}}}), &BridgeInfo{}, "empty values read as none")
}

// The names directory.ts gives the same protocol IDs.
func TestNormalizeNetwork(t *testing.T) {
	for protocolID, network := range map[string]string{
		"":                 "beeper",
		"whatsapp":         "whatsapp",
		"discordgo":        "discord",
		"twitter":          "x",
		"local-whatsapp":   "whatsapp",
		"LOCAL-Signal":     "signal",
		"go":               "go",
		"gogo":             "gogo",
		"abgo":             "abgo",
		"abcgo":            "abc",
		"instagramgo":      "instagram",
		"matrix":           "beeper",
		"hungryserv":       "beeper",
		"gmessages":        "sms",
		"gvoice":           "google-voice",
		"googlechat":       "google-chat",
		"chatgpt-dots":     "chatgpt",
		"grokbot":          "grok",
		"Slack Go!":        "slack-go",
		"---":              "other",
		"imessage":         "imessage",
		"local-imessagego": "imessage",
		"facebook":         "messenger",
		"facebookgo":       "messenger",
		"a.b_c":            "a-b-c",
		"telegram":         "telegram",
		"linkedin":         "linkedin",
	} {
		equal(t, NormalizeNetwork(protocolID), network, "network of "+protocolID)
	}
}

func TestDirectoryFilter(t *testing.T) {
	filter := parse[map[string]any](t, DirectoryFilter)
	room := filter["room"].(map[string]any)
	equal(t, room["timeline"], map[string]any{"limit": 1.0, "lazy_load_members": true}, "each room's latest event only")
	equal(t, room["account_data"], map[string]any{"types": []any{"m.tag"}}, "tags only")
	equal(t, filter["account_data"], map[string]any{"types": []any{"m.direct"}}, "the direct chat list only")
	equal(t, len(room["state"].(map[string]any)["types"].([]any)), 7, "the state the directory reads")
}

func TestStoredTextIsWhatJSONStringifyWrites(t *testing.T) {
	backslash := string(rune(0x5C))
	for _, sample := range [][2]string{
		{"Tom & Jerry <3 > all", `"Tom & Jerry <3 > all"`},
		{`Sam "The Man" \ back`, `"Sam \"The Man\" \\ back"`},
		{"tab\there\nnewline\rreturn", `"tab\there\nnewline\rreturn"`},
		{string([]rune{1, 8, 12, 0x1F, 0x7F}), `"` + backslash + `u0001\b\f` + backslash + `u001f` + string(rune(0x7F)) + `"`},
		{"line" + string(rune(0x2028)) + "sep" + string(rune(0x2029)) + "end", `"line` + string(rune(0x2028)) + "sep" + string(rune(0x2029)) + `end"`},
		{"typed " + backslash + "u2028 and " + backslash + backslash + "u2029", `"typed \\` + `u2028 and \\\\` + `u2029"`},
		{"👍 café", `"👍 café"`},
		{"", `""`},
	} {
		equal(t, must(stringify(sample[0]))(t), sample[1], "a string")
		equal(t, must(stringify([]any{sample[0], nil}))(t), "["+sample[1]+",null]", "a list")
	}
	bridge := must(stringify(&BridgeInfo{StateKey: "k", ProtocolID: ptr("whatsapp")}))(t)
	equal(t, bridge,
		`{"stateKey":"k","protocolId":"whatsapp","protocolName":null,"networkId":null,"channelName":null,"channelId":null,"receiver":null,"bridgeBot":null,"roomType":null}`,
		"a bridge, with its fields in the order directory.ts writes them")
}

func TestStorage(t *testing.T) {
	directory := open(t)
	equal(t, must(directory.RefreshedAt())(t), (*int64)(nil), "never refreshed")
	equal(t, must(directory.Count())(t), 0, "empty")
	slack := &BridgeInfo{StateKey: "s", ProtocolID: ptr("slackgo"), ProtocolName: ptr("Slack"), NetworkID: ptr("T1"), ChannelName: ptr("general")}
	rooms := []RoomRecord{
		{RoomID: "!a:x", Name: ptr("50% off_sale"), Network: "slack", Bridge: slack, MemberCount: ptr(4), LastEventTS: ptr(int64(300)), Heroes: []string{"Tom & Jerry"}, Tags: []string{"m.favourite"}, UpdatedAt: 10},
		{RoomID: "!b:x", Name: ptr("500 offers"), Network: "slack", Bridge: &BridgeInfo{StateKey: "s", ProtocolID: ptr("slackgo"), ProtocolName: ptr("Slack"), NetworkID: ptr("T2")}, IsDirect: true, LastEventTS: ptr(int64(200)), UpdatedAt: 10},
		{RoomID: "!c:x", Network: "slack", Bridge: slack, CanonicalAlias: ptr("#sale:x"), Encrypted: true, UpdatedAt: 10},
		{RoomID: "!d:x", Name: ptr("Notes"), Network: "beeper", LastEventTS: ptr(int64(100)), LastSender: ptr("@me:x"), UpdatedAt: 10},
	}
	check(t, directory.ReplaceAll(rooms, 1234))
	equal(t, must(directory.RefreshedAt())(t), ptr(int64(1234)), "the time of the refresh")
	equal(t, must(directory.Count())(t), 4, "rooms")

	// A room comes back as it went in; missing lists come back empty.
	stored := rooms[1]
	stored.Tags, stored.Heroes = []string{}, []string{}
	equal(t, must(directory.Get("!b:x"))(t), &stored, "a stored room")
	equal(t, must(directory.Get("!a:x"))(t), &rooms[0], "a stored room with everything set")
	equal(t, must(directory.Get("!unknown:x"))(t), (*RoomRecord)(nil), "an unknown room")

	equal(t, must(directory.Connections())(t), []host.Connection{
		{ProtocolID: ptr("slackgo"), NetworkID: ptr("T1"), Name: ptr("Slack"), Rooms: 2},
		{ProtocolID: ptr("slackgo"), NetworkID: ptr("T2"), Name: ptr("Slack"), Rooms: 1},
		{Rooms: 1},
	}, "a connection per bridge and network ID; plain rooms together")
	equal(t, must(directory.Networks())(t), []NetworkRooms{{Network: "slack", Rooms: 3}, {Network: "beeper", Rooms: 1}}, "networks by size")

	// Search: % and _ in a query are text, not wildcards.
	ids, total := search(t, directory, SearchOptions{Query: "50%", Limit: 10})
	equal(t, []any{ids, total}, []any{[]string{"!a:x"}, 1}, "a percent sign is searched for as it is")
	ids, _ = search(t, directory, SearchOptions{Query: "off_", Limit: 10})
	equal(t, ids, []string{"!a:x"}, "an underscore is searched for as it is")
	ids, _ = search(t, directory, SearchOptions{Query: "tom & jerry", Limit: 10})
	equal(t, ids, []string{"!a:x"}, "participants are searched, whatever the case")
	ids, _ = search(t, directory, SearchOptions{Query: "#sale", Limit: 10})
	equal(t, ids, []string{"!c:x"}, "aliases are searched")
	ids, _ = search(t, directory, SearchOptions{Query: "general", Limit: 10})
	equal(t, ids, []string{"!a:x", "!c:x"}, "the bridge's channel name is searched")
	ids, _ = search(t, directory, SearchOptions{IsDirect: ptr(true), Limit: 10})
	equal(t, ids, []string{"!b:x"}, "direct chats only")
	ids, _ = search(t, directory, SearchOptions{IsDirect: ptr(false), Network: "slackgo", Limit: 10})
	equal(t, ids, []string{"!a:x", "!c:x"}, "filters combine")
	ids, total = search(t, directory, SearchOptions{Limit: 2, Offset: 1})
	equal(t, []any{ids, total}, []any{[]string{"!b:x", "!d:x"}, 4}, "a page, and the count of all matches")

	// Activity only moves forward, and an unknown sender keeps the last one.
	check(t, directory.Touch("!d:x", 50, ""))
	check(t, directory.Touch("!c:x", 400, "@a:x"))
	note := must(directory.Get("!d:x"))(t)
	equal(t, []any{note.LastEventTS, note.LastSender}, []any{ptr(int64(100)), ptr("@me:x")}, "an older event changes nothing")
	sale := must(directory.Get("!c:x"))(t)
	equal(t, []any{sale.LastEventTS, sale.LastSender}, []any{ptr(int64(400)), ptr("@a:x")}, "a first event")
	check(t, directory.Rename("!c:x", "Sale"))
	equal(t, must(directory.Get("!c:x"))(t).Name, ptr("Sale"), "a new name")

	// One room at a time: a new row, then a replacement of the whole row.
	added := RoomRecord{RoomID: "!e:x", Name: ptr("New"), Network: "whatsapp", Tags: []string{}, Heroes: []string{"Eve"}, UpdatedAt: 1}
	check(t, directory.Upsert(added, 2000))
	added.UpdatedAt = 2000
	equal(t, must(directory.Get("!e:x"))(t), &added, "a room learned about between refreshes")
	replacement := RoomRecord{RoomID: "!c:x", Name: ptr("Sale!"), Network: "beeper", Tags: []string{}, Heroes: []string{}}
	check(t, directory.Upsert(replacement, 3000))
	replacement.UpdatedAt = 3000
	equal(t, must(directory.Get("!c:x"))(t), &replacement, "a known room is replaced whole")
	equal(t, must(directory.Count())(t), 5, "rooms after two upserts")
	equal(t, must(directory.RefreshedAt())(t), ptr(int64(1234)), "the time of the last full refresh stays")

	// A refresh drops rooms no longer joined.
	check(t, directory.ReplaceAll(rooms[:1], 5000))
	ids, total = search(t, directory, SearchOptions{Limit: 10})
	equal(t, []any{ids, total, must(directory.RefreshedAt())(t)}, []any{[]string{"!a:x"}, 1, ptr(int64(5000))}, "after a refresh")
}

// A row the TypeScript service wrote before bridges had a network ID.
func TestRowsFromBeforeNetworkIDs(t *testing.T) {
	directory := open(t)
	_, err := directory.db.Exec(
		`INSERT INTO rooms (room_id, name, network, bridge, is_direct, member_count, encrypted, canonical_alias, last_event_ts, last_sender, tags, heroes, updated_at)
     VALUES ('!old:x', 'Old', 'signal', '{"stateKey":"k","protocolId":"signal","protocolName":"Signal","channelName":null,"channelId":null,"receiver":null,"bridgeBot":null,"roomType":"dm"}', 1, 2, 1, NULL, NULL, NULL, '[]', '["Old"]', 5)`)
	check(t, err)
	equal(t, must(directory.Get("!old:x"))(t), &RoomRecord{
		RoomID: "!old:x", Name: ptr("Old"), Network: "signal",
		Bridge:   &BridgeInfo{StateKey: "k", ProtocolID: ptr("signal"), ProtocolName: ptr("Signal"), RoomType: ptr("dm")},
		IsDirect: true, MemberCount: ptr(2), Encrypted: true, Tags: []string{}, Heroes: []string{"Old"}, UpdatedAt: 5,
	}, "an older row")
	equal(t, must(directory.Connections())(t), []host.Connection{{ProtocolID: ptr("signal"), Name: ptr("Signal"), Rooms: 1}}, "its connection")
}

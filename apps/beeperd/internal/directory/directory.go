// Package directory is what list_conversations searches: one row per joined room with its name,
// network and last activity. It's metadata only (no message text), rebuilt from one filtered /sync
// and kept fresh by the daemon's live sync. Room IDs are stored exactly as the homeserver gives
// them.
package directory

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// RoomDirectory is the rooms table of inbox.db.
type RoomDirectory struct {
	db *sql.DB
}

// New opens the directory in db, creating its tables when they are missing.
func New(db *sql.DB) (*RoomDirectory, error) {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      name TEXT,
      network TEXT NOT NULL,
      bridge TEXT,
      is_direct INTEGER NOT NULL,
      member_count INTEGER,
      encrypted INTEGER NOT NULL,
      canonical_alias TEXT,
      last_event_ts INTEGER,
      last_sender TEXT,
      tags TEXT NOT NULL,
      heroes TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
		"CREATE TABLE IF NOT EXISTS directory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	} {
		if _, err := db.Exec(statement); err != nil {
			return nil, err
		}
	}
	return &RoomDirectory{db: db}, nil
}

// inTx runs the statements of one operation together: all of them happen, or none.
func (d *RoomDirectory) inTx(run func(tx *sql.Tx) error) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	if err := run(tx); err != nil {
		return errors.Join(err, tx.Rollback())
	}
	return tx.Commit()
}

const columns = "room_id, name, network, bridge, is_direct, member_count, encrypted, canonical_alias, last_event_ts, last_sender, tags, heroes, updated_at"

// encoding/json writes U+2028 and U+2029 as escapes where JSON.stringify writes the characters. An
// escaped backslash is matched first, so text that only looks like such an escape is left alone.
var lineSeparators = strings.NewReplacer(
	`\\`, `\\`,
	`\`+"u2028", string(rune(0x2028)),
	`\`+"u2029", string(rune(0x2029)),
)

// stringify encodes a value exactly as JSON.stringify does. Search matches the stored text of
// bridges and participants, so it must stay what the TypeScript service wrote: "Tom & Jerry" with
// its ampersand, which encoding/json would escape unless told not to.
func stringify(value any) (string, error) {
	var out strings.Builder
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return lineSeparators.Replace(strings.TrimSuffix(out.String(), "\n")), nil
}

func flag(value bool) int {
	if value {
		return 1
	}
	return 0
}

// values are a record's columns, in the order of `columns`.
func values(record RoomRecord, updatedAt int64) ([]any, error) {
	var bridge any
	if record.Bridge != nil {
		encoded, err := stringify(record.Bridge)
		if err != nil {
			return nil, err
		}
		bridge = encoded
	}
	tags, err := stringify(append([]string{}, record.Tags...))
	if err != nil {
		return nil, err
	}
	heroes, err := stringify(append([]string{}, record.Heroes...))
	if err != nil {
		return nil, err
	}
	return []any{
		record.RoomID,
		record.Name,
		record.Network,
		bridge,
		flag(record.IsDirect),
		record.MemberCount,
		flag(record.Encrypted),
		record.CanonicalAlias,
		record.LastEventTS,
		record.LastSender,
		tags,
		heroes,
		updatedAt,
	}, nil
}

func scan(scanner interface{ Scan(...any) error }) (RoomRecord, error) {
	var (
		record                                   RoomRecord
		name, bridge, canonicalAlias, lastSender sql.NullString
		memberCount, lastEventTS                 sql.NullInt64
		isDirect, encrypted                      int64
		tags, heroes                             string
	)
	err := scanner.Scan(&record.RoomID, &name, &record.Network, &bridge, &isDirect, &memberCount, &encrypted,
		&canonicalAlias, &lastEventTS, &lastSender, &tags, &heroes, &record.UpdatedAt)
	if err != nil {
		return RoomRecord{}, err
	}
	if name.Valid {
		record.Name = &name.String
	}
	if bridge.Valid && bridge.String != "" {
		if err := json.Unmarshal([]byte(bridge.String), &record.Bridge); err != nil {
			return RoomRecord{}, err
		}
	}
	record.IsDirect = isDirect == 1
	if memberCount.Valid {
		count := int(memberCount.Int64)
		record.MemberCount = &count
	}
	record.Encrypted = encrypted == 1
	if canonicalAlias.Valid {
		record.CanonicalAlias = &canonicalAlias.String
	}
	if lastEventTS.Valid {
		record.LastEventTS = &lastEventTS.Int64
	}
	if lastSender.Valid {
		record.LastSender = &lastSender.String
	}
	if err := json.Unmarshal([]byte(tags), &record.Tags); err != nil {
		return RoomRecord{}, err
	}
	if err := json.Unmarshal([]byte(heroes), &record.Heroes); err != nil {
		return RoomRecord{}, err
	}
	return record, nil
}

// ReplaceAll replaces the directory with a full refresh: rooms no longer joined disappear.
func (d *RoomDirectory) ReplaceAll(records []RoomRecord, now int64) error {
	return d.inTx(func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM rooms"); err != nil {
			return err
		}
		insert, err := tx.Prepare(
			`INSERT INTO rooms (room_id, name, network, bridge, is_direct, member_count, encrypted, canonical_alias, last_event_ts, last_sender, tags, heroes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		if err != nil {
			return err
		}
		defer insert.Close()
		for _, record := range records {
			row, err := values(record, record.UpdatedAt)
			if err != nil {
				return err
			}
			if _, err := insert.Exec(row...); err != nil {
				return err
			}
		}
		_, err = tx.Exec(
			"INSERT OR REPLACE INTO directory_meta (key, value) VALUES ('refreshed_at', ?)",
			strconv.FormatInt(now, 10),
		)
		return err
	})
}

// Upsert writes one room the daemon learned about between refreshes: a new row, or a replacement
// for the whole row the room had. now becomes the row's update time. The time of the last full
// refresh stays as it is.
func (d *RoomDirectory) Upsert(record RoomRecord, now int64) error {
	row, err := values(record, now)
	if err != nil {
		return err
	}
	_, err = d.db.Exec(
		`INSERT OR REPLACE INTO rooms (room_id, name, network, bridge, is_direct, member_count, encrypted, canonical_alias, last_event_ts, last_sender, tags, heroes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		row...,
	)
	return err
}

// Touch notes that live sync saw activity in a room. An empty sender keeps the one the room has.
func (d *RoomDirectory) Touch(roomID string, ts int64, sender string) error {
	var lastSender any
	if sender != "" {
		lastSender = sender
	}
	_, err := d.db.Exec(
		"UPDATE rooms SET last_event_ts = MAX(COALESCE(last_event_ts, 0), ?), last_sender = COALESCE(?, last_sender) WHERE room_id = ?",
		ts, lastSender, roomID,
	)
	return err
}

// Rename gives a room a new name.
func (d *RoomDirectory) Rename(roomID, name string) error {
	_, err := d.db.Exec("UPDATE rooms SET name = ? WHERE room_id = ?", name, roomID)
	return err
}

// RefreshedAt is when the directory was last replaced by a full refresh (Unix ms), or nil when it
// never was.
func (d *RoomDirectory) RefreshedAt() (*int64, error) {
	var value string
	err := d.db.QueryRow("SELECT value FROM directory_meta WHERE key = 'refreshed_at'").Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	refreshedAt, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return nil, err
	}
	return &refreshedAt, nil
}

// Count is the number of rooms.
func (d *RoomDirectory) Count() (int, error) {
	var count int
	err := d.db.QueryRow("SELECT COUNT(*) AS n FROM rooms").Scan(&count)
	return count, err
}

// Connections returns each connection the rooms belong to: a bridge and, where it has one, the
// network's ID.
func (d *RoomDirectory) Connections() ([]host.Connection, error) {
	rows, err := d.db.Query("SELECT bridge FROM rooms")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	connections := []host.Connection{}
	position := map[string]int{}
	for rows.Next() {
		var (
			encoded sql.NullString
			// A room with no bridge counts under the connection with no protocol.
			bridge BridgeInfo
		)
		if err := rows.Scan(&encoded); err != nil {
			return nil, err
		}
		if encoded.Valid && encoded.String != "" {
			if err := json.Unmarshal([]byte(encoded.String), &bridge); err != nil {
				return nil, err
			}
		}
		key := ""
		if bridge.ProtocolID != nil {
			key = *bridge.ProtocolID
		}
		key += "\n"
		if bridge.NetworkID != nil {
			key += *bridge.NetworkID
		}
		at, seen := position[key]
		if !seen {
			at = len(connections)
			position[key] = at
			connections = append(connections, host.Connection{
				ProtocolID: bridge.ProtocolID,
				NetworkID:  bridge.NetworkID,
				Name:       bridge.ProtocolName,
			})
		}
		connections[at].Rooms++
	}
	return connections, rows.Err()
}

// NetworkRooms is how many rooms a network has.
type NetworkRooms struct {
	Network string `json:"network"`
	Rooms   int    `json:"rooms"`
}

// Networks returns the networks of the directory, the one with the most rooms first.
func (d *RoomDirectory) Networks() ([]NetworkRooms, error) {
	rows, err := d.db.Query("SELECT network, COUNT(*) AS rooms FROM rooms GROUP BY network ORDER BY rooms DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	networks := []NetworkRooms{}
	for rows.Next() {
		var network NetworkRooms
		if err := rows.Scan(&network.Network, &network.Rooms); err != nil {
			return nil, err
		}
		networks = append(networks, network)
	}
	return networks, rows.Err()
}

// Get returns a room, or nil when the directory doesn't have it.
func (d *RoomDirectory) Get(roomID string) (*RoomRecord, error) {
	record, err := scan(d.db.QueryRow("SELECT "+columns+" FROM rooms WHERE room_id = ?", roomID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// SearchOptions narrows a search. The zero value of Query, Network and IsDirect means "any".
type SearchOptions struct {
	// Query matches part of a name, a participant, an alias or the bridge's details, or a whole room
	// ID.
	Query string
	// Network is a network name or a bridge's protocol ID: "WhatsApp" finds whatsapp.
	Network  string
	IsDirect *bool
	Limit    int
	Offset   int
}

var likeEscapes = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// Search returns the matching rooms, the latest activity first, and how many match in all.
func (d *RoomDirectory) Search(options SearchOptions) (rooms []RoomRecord, total int, err error) {
	var (
		where  []string
		params []any
	)
	if options.Query != "" {
		like := "%" + likeEscapes.Replace(options.Query) + "%"
		where = append(where,
			`(name LIKE ? ESCAPE '\' OR heroes LIKE ? ESCAPE '\' OR canonical_alias LIKE ? ESCAPE '\' OR room_id = ? OR bridge LIKE ? ESCAPE '\')`)
		params = append(params, like, like, like, options.Query, like)
	}
	if options.Network != "" {
		where = append(where, "network = ?")
		params = append(params, NormalizeNetwork(options.Network))
	}
	if options.IsDirect != nil {
		where = append(where, "is_direct = ?")
		params = append(params, flag(*options.IsDirect))
	}
	clause := ""
	if len(where) > 0 {
		clause = "WHERE " + strings.Join(where, " AND ")
	}
	rooms = []RoomRecord{}
	err = d.inTx(func(tx *sql.Tx) error {
		if err := tx.QueryRow("SELECT COUNT(*) AS n FROM rooms "+clause, params...).Scan(&total); err != nil {
			return err
		}
		rows, err := tx.Query(
			"SELECT "+columns+" FROM rooms "+clause+" ORDER BY COALESCE(last_event_ts, 0) DESC, room_id LIMIT ? OFFSET ?",
			append(params, options.Limit, options.Offset)...,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			record, err := scan(rows)
			if err != nil {
				return err
			}
			rooms = append(rooms, record)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, 0, err
	}
	return rooms, total, nil
}

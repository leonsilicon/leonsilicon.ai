// Package host is what the daemon gives the services that run inside it (the Slack feeds, the Grok
// relay, the Linear publisher), and the types they share. It mirrors the TypeScript
// ExtensionContext the services were first written against, so their state files stay readable.
package host

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// Logger writes one line to the daemon's log. Fields hold IDs and counts only, never message text.
// Levels: "debug", "info", "warn", "error".
type Logger func(level, message string, fields map[string]any)

// JournalEntry is one message as sync delivered it. JSON field names match the TypeScript journal,
// because services keep entries in their state files.
type JournalEntry struct {
	// Seq is where the message first arrived.
	Seq int64 `json:"seq"`
	// Rev is where it last changed; equal to Seq for a message that never changed.
	Rev     int64  `json:"rev"`
	RoomID  string `json:"roomId"`
	EventID string `json:"eventId"`
	Sender  string `json:"sender"`
	IsMe    bool   `json:"isMe"`
	// Type is the Matrix message type: m.text, m.notice, m.image…
	Type string  `json:"type"`
	Text string  `json:"text"`
	HTML *string `json:"html"`
	// TS is when it was sent, as the homeserver recorded it (Unix ms).
	TS int64 `json:"ts"`
	// ReceivedAt is when sync delivered it here (Unix ms).
	ReceivedAt  int64   `json:"receivedAt"`
	Edited      bool    `json:"edited"`
	Redacted    bool    `json:"redacted"`
	ReplyTo     *string `json:"replyTo"`
	Attachments int     `json:"attachments"`
}

// ChangesOptions asks the journal for what arrived or changed after a position.
type ChangesOptions struct {
	After int64
	// RoomID limits the answer to one room when set.
	RoomID string
	// Limit caps the entries returned; 0 means the journal's default.
	Limit int
	// Wait is how long to wait for the first entry when there is nothing yet.
	Wait time.Duration
}

// Journal is every message sync delivered, readable by position.
type Journal interface {
	// Head is the latest position: "after this" means from now on.
	Head() (int64, error)
	// CoveredSince is the time (Unix ms) from which the journal has every message sync delivered.
	CoveredSince() (int64, error)
	// Latest returns the newest count messages of a room, oldest first.
	Latest(roomID string, count int) ([]JournalEntry, error)
	// Since returns a room's messages sent at or after a time (Unix ms), oldest first.
	Since(roomID string, sinceTS int64) ([]JournalEntry, error)
	// Recent returns every room's messages sent at or after a time, oldest first. limit 0 = 2000.
	Recent(sinceTS int64, limit int) ([]JournalEntry, error)
	// Changes returns entries that arrived or changed after a position, and the position to ask
	// from next time. It returns early with what it has when ctx ends.
	Changes(ctx context.Context, options ChangesOptions) (entries []JournalEntry, cursor int64, err error)
	// Subscribe calls wake after every committed change. The returned function unsubscribes.
	Subscribe(wake func()) (unsubscribe func())
}

// RoomInfo is what the inbox knows about a room.
type RoomInfo struct {
	RoomID string  `json:"roomId"`
	Name   *string `json:"name"`
	// Network is the short network name the feed channels use: whatsapp, instagram, grok…
	Network string `json:"network"`
	// NetworkName is the bridge's own name for the network: "WhatsApp", "Instagram"…
	NetworkName *string `json:"networkName"`
	// ProtocolID is the bridge, e.g. "instagramgo"; nil for a plain Matrix room.
	ProtocolID *string `json:"protocolId"`
	NetworkID  *string `json:"networkId"`
	IsDirect   bool    `json:"isDirect"`
	IsMuted    bool    `json:"isMuted"`
}

// Connection is one bridge connection Leon's rooms belong to.
type Connection struct {
	ProtocolID *string `json:"protocolId"`
	NetworkID  *string `json:"networkId"`
	Name       *string `json:"name"`
	Rooms      int     `json:"rooms"`
}

// ToolError is a refused tool call: a code Hermes can act on and a message written for it.
type ToolError struct {
	Code    string
	Message string
	Data    any
}

func (e *ToolError) Error() string { return e.Message }

// Host is the daemon, as a service running inside it sees it.
type Host interface {
	// Tool runs one of the inbox's own tools (list_conversations, list_messages, send_message…) and
	// returns its JSON result. A refused call returns a *ToolError.
	Tool(ctx context.Context, name string, args map[string]any) (map[string]any, error)
	Journal() Journal
	// Rooms returns what the inbox knows about the given rooms; unknown rooms are left out.
	Rooms(ctx context.Context, roomIDs []string) ([]RoomInfo, error)
	Connections(ctx context.Context) ([]Connection, error)
	// SenderNames returns display names for Matrix user IDs, where the homeserver has one.
	SenderNames(ctx context.Context, userIDs []string) (map[string]string, error)
	// PublishLinearIssue writes and verifies a Linear issue snapshot in this account's room data.
	PublishLinearIssue(ctx context.Context, roomID string, record map[string]any) error
	// PublishProjectAppearance writes and verifies a Linear project's color and icon in room data.
	PublishProjectAppearance(ctx context.Context, roomID string, record map[string]any) error
	// PublishProjectVisibility writes and verifies closed Slack project channels in global data.
	PublishProjectVisibility(ctx context.Context, record map[string]any) error
	// Home is the service's own directory under the daemon's home (0700), for its settings and state.
	Home() string
	// Log is the daemon's log, tagged with the service's name.
	Log() Logger
}

// Tool is a tool as MCP lists it.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations json.RawMessage `json:"annotations,omitempty"`
}

// Server is the MCP server a service exposes through `beeperd mcp <name>`.
type Server struct {
	Name         string `json:"name"`
	Version      string `json:"version"`
	Instructions string `json:"instructions"`
	Tools        []Tool `json:"tools"`
}

// Service is something that runs inside the daemon, with the store's single writer.
type Service interface {
	// Name is the service's directory, command and status name.
	Name() string
	// Server describes its MCP tools, or nil when it has none.
	Server() *Server
	// Start begins its work. ctx ends when the daemon stops.
	Start(ctx context.Context, h Host) (Running, error)
}

// Running is a started service.
type Running interface {
	// CallTool runs one of the service's own tools. A refused call returns a *ToolError or a result
	// with "ok": false, as the service's tools did before.
	CallTool(ctx context.Context, name string, args map[string]any) (map[string]any, error)
	// Status is a few facts about its health, shown under its name in the daemon's status.
	Status() map[string]any
	// Stop ends its work and waits for it.
	Stop()
}

// WriteJSONAtomic writes value to path through a temporary file, so a crash never leaves half a file.
func WriteJSONAtomic(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(append(data, '\n')); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}

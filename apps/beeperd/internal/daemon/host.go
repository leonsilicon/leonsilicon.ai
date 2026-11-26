package daemon

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/inbox"
)

// servicesDirectoryMaxAgeMS: the directory is kept current by sync, so a service that asks for a
// refresh (the feeds, the Grok relay and the Linear publisher each did about once a minute) gets a
// rebuild only when none has run for this long.
const servicesDirectoryMaxAgeMS = 24 * 60 * 60_000

// serviceHost is the daemon as one service sees it.
type serviceHost struct {
	name  string
	home  string
	inbox *inbox.Inbox
	log   host.Logger
}

var _ host.Host = (*serviceHost)(nil)

// Tool runs one of the inbox's tools. The result goes through JSON, so a service always sees what a
// client on the socket would: objects, arrays, strings, float64 numbers and nil.
func (h *serviceHost) Tool(ctx context.Context, name string, args map[string]any) (map[string]any, error) {
	result, err := h.inbox.RunTool(ctx, name, args, inbox.Caller{
		// Only the Grok relay may deliver a handoff to a Grok room.
		GrokRelay:         h.name == "slack22grokbot",
		DirectoryMaxAgeMS: servicesDirectoryMaxAgeMS,
	})
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	var plain map[string]any
	if err := json.Unmarshal(data, &plain); err != nil {
		return nil, err
	}
	return plain, nil
}

func (h *serviceHost) Journal() host.Journal { return liveJournal{h.inbox} }

func (h *serviceHost) Rooms(ctx context.Context, roomIDs []string) ([]host.RoomInfo, error) {
	return h.inbox.RoomInfos(roomIDs)
}

func (h *serviceHost) Connections(ctx context.Context) ([]host.Connection, error) {
	return h.inbox.Connections()
}

func (h *serviceHost) SenderNames(ctx context.Context, userIDs []string) (map[string]string, error) {
	return h.inbox.Names(ctx, userIDs)
}

func (h *serviceHost) PublishLinearIssue(ctx context.Context, roomID string, record map[string]any) error {
	return h.inbox.PublishLinearIssue(ctx, roomID, record)
}

func (h *serviceHost) PublishProjectAppearance(ctx context.Context, roomID string, record map[string]any) error {
	return h.inbox.PublishProjectAppearance(ctx, roomID, record)
}

func (h *serviceHost) PublishProjectVisibility(ctx context.Context, record map[string]any) error {
	return h.inbox.PublishProjectVisibility(ctx, record)
}

func (h *serviceHost) Home() string     { return h.home }
func (h *serviceHost) Log() host.Logger { return h.log }

var errJournalClosed = errors.New("beeper-inbox's stores aren't open (it is stopping)")

// liveJournal looks the journal up on every call, because a reload replaces it.
type liveJournal struct{ inbox *inbox.Inbox }

func (j liveJournal) Head() (int64, error) {
	journal := j.inbox.Journal()
	if journal == nil {
		return 0, errJournalClosed
	}
	return journal.Head()
}

func (j liveJournal) CoveredSince() (int64, error) {
	journal := j.inbox.Journal()
	if journal == nil {
		return 0, errJournalClosed
	}
	return journal.CoveredSince()
}

func (j liveJournal) Latest(roomID string, count int) ([]host.JournalEntry, error) {
	journal := j.inbox.Journal()
	if journal == nil {
		return nil, errJournalClosed
	}
	return journal.Latest(roomID, count)
}

func (j liveJournal) Since(roomID string, sinceTS int64) ([]host.JournalEntry, error) {
	journal := j.inbox.Journal()
	if journal == nil {
		return nil, errJournalClosed
	}
	return journal.Since(roomID, sinceTS)
}

func (j liveJournal) Recent(sinceTS int64, limit int) ([]host.JournalEntry, error) {
	journal := j.inbox.Journal()
	if journal == nil {
		return nil, errJournalClosed
	}
	return journal.Recent(sinceTS, limit)
}

func (j liveJournal) Changes(ctx context.Context, options host.ChangesOptions) ([]host.JournalEntry, int64, error) {
	journal := j.inbox.Journal()
	if journal == nil {
		return nil, 0, errJournalClosed
	}
	return journal.Changes(ctx, options)
}

func (j liveJournal) Subscribe(wake func()) (unsubscribe func()) {
	return j.inbox.SubscribeToJournal(wake)
}

package feeds

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"slices"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// state is the feed's state file. Its JSON is exactly what the TypeScript feed wrote, so a feed
// carries on from the file it finds.
type state struct {
	// Since is when the feed first ran (Unix ms). Older messages are history, not news.
	Since int64 `json:"since"`
	// Cursor is the journal position the feed has read up to.
	Cursor  int64 `json:"cursor"`
	Pending queue `json:"pending"`
	Posted  int64 `json:"posted"`
	Expired int64 `json:"expired"`
}

// pendingMessage is a message waiting to be screened and posted.
type pendingMessage struct {
	Message  host.JournalEntry `json:"message"`
	QueuedAt int64             `json:"queuedAt"`
	Attempts int               `json:"attempts"`
	// RetryAt is when to try again (Unix ms); 0 means now.
	RetryAt int64 `json:"retryAt"`
	// Verdict is kept once the message is screened, so a delivery retry doesn't screen it again.
	Verdict *verdict `json:"verdict,omitempty"`
}

// queue is the pending messages by event ID, in the order they were queued. The TypeScript feed
// kept them in an object, which remembers that order in the file and delivers in it, so the order
// is part of the file's format.
type queue struct {
	order []string
	items map[string]pendingMessage
}

func (q queue) get(eventID string) (pendingMessage, bool) {
	item, queued := q.items[eventID]
	return item, queued
}

// list returns the messages, oldest queued first.
func (q queue) list() []pendingMessage {
	items := make([]pendingMessage, len(q.order))
	for i, eventID := range q.order {
		items[i] = q.items[eventID]
	}
	return items
}

// clone returns a copy to change. A queue that is part of the feed's state is never changed, so
// the state always matches its file.
func (q queue) clone() queue {
	items := maps.Clone(q.items)
	if items == nil {
		items = map[string]pendingMessage{}
	}
	return queue{order: slices.Clone(q.order), items: items}
}

// put queues a message. One already queued keeps its place.
func (q *queue) put(item pendingMessage) {
	eventID := item.Message.EventID
	if _, queued := q.items[eventID]; !queued {
		q.order = append(q.order, eventID)
	}
	q.items[eventID] = item
}

func (q *queue) remove(eventID string) {
	if _, queued := q.items[eventID]; !queued {
		return
	}
	delete(q.items, eventID)
	q.order = slices.DeleteFunc(q.order, func(queued string) bool { return queued == eventID })
}

func (q queue) MarshalJSON() ([]byte, error) {
	var object bytes.Buffer
	object.WriteByte('{')
	for i, eventID := range q.order {
		if i > 0 {
			object.WriteByte(',')
		}
		key, err := json.Marshal(eventID)
		if err != nil {
			return nil, err
		}
		item, err := json.Marshal(q.items[eventID])
		if err != nil {
			return nil, err
		}
		object.Write(key)
		object.WriteByte(':')
		object.Write(item)
	}
	object.WriteByte('}')
	return object.Bytes(), nil
}

func (q *queue) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if opening, err := decoder.Token(); err != nil || opening != json.Delim('{') {
		return errors.New("pending is not an object")
	}
	*q = queue{items: map[string]pendingMessage{}}
	for decoder.More() {
		if _, err := decoder.Token(); err != nil {
			return err
		}
		var item pendingMessage
		if err := decoder.Decode(&item); err != nil {
			return err
		}
		q.put(item)
	}
	return nil
}

// loadState reads a state file. A feed that has never run has none, and gets nil.
func loadState(path string) (*state, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Pointers tell a missing or null field from a zero, which the TypeScript feed refused too.
	var saved struct {
		Since   *int64 `json:"since"`
		Cursor  *int64 `json:"cursor"`
		Pending *queue `json:"pending"`
		Posted  *int64 `json:"posted"`
		Expired *int64 `json:"expired"`
	}
	if err := json.Unmarshal(data, &saved); err != nil {
		return nil, fmt.Errorf("invalid Slack feed state: %w", err)
	}
	if saved.Since == nil || saved.Cursor == nil || *saved.Cursor < 0 || saved.Pending == nil || saved.Posted == nil || saved.Expired == nil {
		return nil, errors.New("invalid Slack feed state")
	}
	return &state{
		Since:   *saved.Since,
		Cursor:  *saved.Cursor,
		Pending: *saved.Pending,
		Posted:  *saved.Posted,
		Expired: *saved.Expired,
	}, nil
}

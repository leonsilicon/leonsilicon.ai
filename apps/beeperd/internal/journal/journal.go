// Package journal writes down every message sync delivers, once, as it arrives, so that whatever
// needs new messages often (slack22grokbot waiting for a reply, a feed of every chat) can ask "what
// is new or changed since N?" instead of reading history again. A page of history costs about half a
// second per message; a journal read is one indexed query.
//
// Each message gets a position when it first arrives (seq) and a new one whenever it changes (rev:
// an edit, a deletion, a decryption that succeeded late). Positions only grow, so "after N" never
// misses or repeats a change.
//
// Unlike the rest of inbox.db this table holds message text, for RetentionMS at most. It sits in the
// owner-only state directory beside the keys that decrypt everything anyway.
package journal

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

const (
	// RetentionMS is how long a message stays in the journal.
	RetentionMS int64 = 7 * 24 * 60 * 60_000
	// GapMS is how long the daemon can be away before the journal counts as broken off: sync may
	// have skipped events.
	GapMS int64 = 30 * 60_000

	maxRows     = 100_000
	maxAttempts = 5
)

// Message is a message to write down.
type Message struct {
	RoomID  string
	EventID string
	Sender  string
	IsMe    bool
	// Type is the Matrix message type: m.text, m.notice, m.image…
	Type string
	Text string
	// HTML is the formatted body, or nil when there is none.
	HTML *string
	// TS is when it was sent, as the homeserver recorded it (Unix ms).
	TS int64
	// Replaces is, for an edit, the message it replaces; empty otherwise.
	Replaces string
	// ReplyTo is the message it answers; empty when it isn't a reply.
	ReplyTo     string
	Attachments int
}

// PendingEvent is an event still waiting to be decrypted.
type PendingEvent struct {
	RoomID  string `json:"roomId"`
	EventID string `json:"eventId"`
}

// Stats is the journal at a glance.
type Stats struct {
	Head         int64 `json:"head"`
	CoveredSince int64 `json:"coveredSince"`
	Entries      int   `json:"entries"`
	// Pending counts the events still waiting to be decrypted.
	Pending int `json:"pending"`
}

// MessageJournal is the journal table of inbox.db. It is safe to use from several goroutines.
type MessageJournal struct {
	db *sql.DB

	mu        sync.Mutex
	listeners []*listener
}

type listener struct {
	call    func(host.JournalEntry)
	removed atomic.Bool
}

var _ host.Journal = (*MessageJournal)(nil)

// New opens the journal in db, creating its tables when they are missing, and notes that the daemon
// is alive at now (Unix ms).
func New(db *sql.DB, now int64) (*MessageJournal, error) {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS journal (
      seq INTEGER PRIMARY KEY,
      rev INTEGER NOT NULL,
      room_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      sender TEXT NOT NULL,
      is_me INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      html TEXT,
      ts INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      edited INTEGER NOT NULL DEFAULT 0,
      redacted INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      reply_to TEXT,
      attachments INTEGER NOT NULL DEFAULT 0
    )`,
		"CREATE INDEX IF NOT EXISTS journal_rev ON journal (rev)",
		"CREATE INDEX IF NOT EXISTS journal_room_rev ON journal (room_id, rev)",
		"CREATE INDEX IF NOT EXISTS journal_room_ts ON journal (room_id, ts)",
		"CREATE INDEX IF NOT EXISTS journal_ts ON journal (ts)",
		"CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
	} {
		if _, err := db.Exec(statement); err != nil {
			return nil, err
		}
	}
	journal := &MessageJournal{db: db}
	if err := journal.Alive(now); err != nil {
		return nil, err
	}
	return journal, nil
}

// inTx runs the statements of one operation together: all of them happen, or none.
func (j *MessageJournal) inTx(run func(tx *sql.Tx) error) error {
	tx, err := j.db.Begin()
	if err != nil {
		return err
	}
	if err := run(tx); err != nil {
		return errors.Join(err, tx.Rollback())
	}
	return tx.Commit()
}

// queryer is what a read needs: the database itself, or a transaction on it.
type queryer interface {
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

func meta(db queryer, key string) (value int64, found bool, err error) {
	err = db.QueryRow("SELECT value FROM journal_meta WHERE key = ?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return value, err == nil, err
}

func setMeta(tx *sql.Tx, key string, value int64) error {
	_, err := tx.Exec("INSERT OR REPLACE INTO journal_meta (key, value) VALUES (?, ?)", key, value)
	return err
}

// next takes the next position.
func next(tx *sql.Tx) (int64, error) {
	head, _, err := meta(tx, "head")
	if err != nil {
		return 0, err
	}
	return head + 1, setMeta(tx, "head", head+1)
}

func coveredSince(db queryer) (int64, error) {
	since, found, err := meta(db, "covered_since")
	if err != nil {
		return 0, err
	}
	if !found {
		return time.Now().UnixMilli(), nil
	}
	return since, nil
}

const columns = "seq, rev, room_id, event_id, sender, is_me, type, text, html, ts, received_at, edited, redacted, pending, reply_to, attachments"

type row struct {
	entry   host.JournalEntry
	pending bool
}

func scan(scanner interface{ Scan(...any) error }) (row, error) {
	var (
		scanned                         row
		isMe, edited, redacted, pending int64
		html, replyTo                   sql.NullString
	)
	entry := &scanned.entry
	err := scanner.Scan(&entry.Seq, &entry.Rev, &entry.RoomID, &entry.EventID, &entry.Sender, &isMe,
		&entry.Type, &entry.Text, &html, &entry.TS, &entry.ReceivedAt, &edited, &redacted, &pending,
		&replyTo, &entry.Attachments)
	if err != nil {
		return row{}, err
	}
	entry.IsMe = isMe == 1
	entry.Edited = edited == 1
	entry.Redacted = redacted == 1
	scanned.pending = pending == 1
	if html.Valid {
		entry.HTML = &html.String
	}
	if replyTo.Valid {
		entry.ReplyTo = &replyTo.String
	}
	return scanned, nil
}

func find(db queryer, eventID string) (*row, error) {
	found, err := scan(db.QueryRow("SELECT "+columns+" FROM journal WHERE event_id = ?", eventID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &found, nil
}

func entries(db queryer, query string, args ...any) ([]host.JournalEntry, error) {
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := []host.JournalEntry{}
	for rows.Next() {
		scanned, err := scan(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, scanned.entry)
	}
	return found, rows.Err()
}

// nullable is the SQL value of an optional string: NULL when it is empty.
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func flag(value bool) int {
	if value {
		return 1
	}
	return 0
}

func clamp(value, low, high int) int {
	return min(max(value, low), high)
}

// changed reads back the entry that was just written, for the listeners.
func changed(db queryer, eventID string) (*host.JournalEntry, error) {
	found, err := find(db, eventID)
	if err != nil || found == nil {
		return nil, err
	}
	return &found.entry, nil
}

// notify tells the listeners about a committed change. It runs outside the transaction and holds no
// lock while a listener runs, so a listener can read the journal or unsubscribe.
func (j *MessageJournal) notify(entry *host.JournalEntry) {
	if entry == nil {
		return
	}
	j.mu.Lock()
	listeners := slices.Clone(j.listeners)
	j.mu.Unlock()
	for _, listener := range listeners {
		if listener.removed.Load() {
			continue
		}
		func() {
			// a listener's failure is its own
			defer func() { _ = recover() }()
			listener.call(*entry)
		}()
	}
}

// Alive is called once a minute, and at start. After an absence of GapMS or more, sync may have
// skipped events, so the journal only vouches for what came after.
func (j *MessageJournal) Alive(now int64) error {
	return j.inTx(func(tx *sql.Tx) error {
		last, seen, err := meta(tx, "alive_at")
		if err != nil {
			return err
		}
		_, covered, err := meta(tx, "covered_since")
		if err != nil {
			return err
		}
		if !seen || !covered || now-last >= GapMS {
			if err := setMeta(tx, "covered_since", now); err != nil {
				return err
			}
		}
		return setMeta(tx, "alive_at", now)
	})
}

// CoveredSince is the time (Unix ms) from which the journal has every message sync delivered.
func (j *MessageJournal) CoveredSince() (int64, error) {
	return coveredSince(j.db)
}

// Head is the latest position: "after this" means from now on.
func (j *MessageJournal) Head() (int64, error) {
	head, _, err := meta(j.db, "head")
	return head, err
}

// Record writes a message down. An edit updates the message it replaces; a message seen before is
// left alone, unless it was waiting to be decrypted. It returns the entry when something changed,
// and nil otherwise.
func (j *MessageJournal) Record(message Message, now int64) (*host.JournalEntry, error) {
	target := message.EventID
	if message.Replaces != "" {
		target = message.Replaces
	}
	var entry *host.JournalEntry
	err := j.inTx(func(tx *sql.Tx) error {
		existing, err := find(tx, target)
		if err != nil {
			return err
		}
		if existing != nil && message.Replaces == "" && !existing.pending {
			return nil
		}
		position, err := next(tx)
		if err != nil {
			return err
		}
		if existing != nil {
			_, err = tx.Exec(
				`UPDATE journal SET rev = ?, text = ?, html = ?, type = ?, edited = ?, pending = 0,
             sender = ?, is_me = ?, ts = CASE WHEN pending = 1 THEN ? ELSE ts END,
             attachments = ?, reply_to = COALESCE(?, reply_to)
           WHERE event_id = ?`,
				position,
				message.Text,
				message.HTML,
				message.Type,
				flag(message.Replaces != "" || existing.entry.Edited),
				message.Sender,
				flag(message.IsMe),
				message.TS,
				message.Attachments,
				nullable(message.ReplyTo),
				target,
			)
		} else {
			_, err = tx.Exec(
				`INSERT INTO journal (seq, rev, room_id, event_id, sender, is_me, type, text, html, ts,
           received_at, edited, reply_to, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				position,
				position,
				message.RoomID,
				target,
				message.Sender,
				flag(message.IsMe),
				message.Type,
				message.Text,
				message.HTML,
				message.TS,
				now,
				flag(message.Replaces != ""),
				nullable(message.ReplyTo),
				message.Attachments,
			)
		}
		if err != nil {
			return err
		}
		entry, err = changed(tx, target)
		return err
	})
	if err != nil {
		return nil, err
	}
	j.notify(entry)
	return entry, nil
}

// Pending notes an event that arrived but couldn't be decrypted yet. It shows up once it can be.
func (j *MessageJournal) Pending(roomID, eventID, sender string, now int64) error {
	return j.inTx(func(tx *sql.Tx) error {
		existing, err := find(tx, eventID)
		if err != nil || existing != nil {
			return err
		}
		position, err := next(tx)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			`INSERT INTO journal (seq, rev, room_id, event_id, sender, is_me, type, text, ts, received_at, pending)
         VALUES (?, ?, ?, ?, ?, 0, '', '', ?, ?, 1)`,
			position, position, roomID, eventID, sender, now, now,
		)
		return err
	})
}

// PendingDue returns the events still waiting to be decrypted that are due another try; each call
// counts as one. limit 0 means 5.
func (j *MessageJournal) PendingDue(now int64, limit int) ([]PendingEvent, error) {
	if limit == 0 {
		limit = 5
	}
	var due []PendingEvent
	err := j.inTx(func(tx *sql.Tx) error {
		var err error
		due, err = pendingDue(tx, now, limit)
		if err != nil {
			return err
		}
		for _, event := range due {
			if _, err := tx.Exec("UPDATE journal SET attempts = attempts + 1 WHERE event_id = ?", event.EventID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return due, nil
}

func pendingDue(db queryer, now int64, limit int) ([]PendingEvent, error) {
	rows, err := db.Query(
		`SELECT room_id, event_id FROM journal
         WHERE pending = 1 AND attempts < ? AND received_at <= ? - (attempts + 1) * 30000
         ORDER BY seq LIMIT ?`,
		maxAttempts, now, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	due := []PendingEvent{}
	for rows.Next() {
		var event PendingEvent
		if err := rows.Scan(&event.RoomID, &event.EventID); err != nil {
			return nil, err
		}
		due = append(due, event)
	}
	return due, rows.Err()
}

// Redact marks a message deleted: it keeps its place and loses its text. It returns the entry, or
// nil when the message is unknown or already deleted.
func (j *MessageJournal) Redact(eventID string) (*host.JournalEntry, error) {
	var entry *host.JournalEntry
	err := j.inTx(func(tx *sql.Tx) error {
		existing, err := find(tx, eventID)
		if err != nil || existing == nil || existing.entry.Redacted {
			return err
		}
		position, err := next(tx)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			"UPDATE journal SET rev = ?, text = '', html = NULL, redacted = 1, pending = 0 WHERE event_id = ?",
			position, eventID,
		)
		if err != nil {
			return err
		}
		entry, err = changed(tx, eventID)
		return err
	})
	if err != nil {
		return nil, err
	}
	j.notify(entry)
	return entry, nil
}

// changes returns the messages that arrived or changed after a position, oldest change first, and
// the position to ask from next time.
func (j *MessageJournal) changes(options host.ChangesOptions) ([]host.JournalEntry, int64, error) {
	limit := options.Limit
	if limit == 0 {
		limit = 200
	}
	limit = clamp(limit, 1, 1000)
	var (
		found []host.JournalEntry
		err   error
	)
	if options.RoomID != "" {
		found, err = entries(j.db,
			"SELECT "+columns+" FROM journal WHERE room_id = ? AND rev > ? AND pending = 0 ORDER BY rev LIMIT ?",
			options.RoomID, options.After, limit,
		)
	} else {
		found, err = entries(j.db,
			"SELECT "+columns+" FROM journal WHERE rev > ? AND pending = 0 ORDER BY rev LIMIT ?",
			options.After, limit,
		)
	}
	if err != nil {
		return nil, options.After, err
	}
	cursor := options.After
	if len(found) > 0 {
		cursor = found[len(found)-1].Rev
	}
	return found, cursor, nil
}

// Changes returns the messages that arrived or changed after a position, oldest change first, and
// the position to ask from next time. With options.Wait, when there is nothing yet it waits that
// long for the first change, and returns what it has when ctx ends first.
func (j *MessageJournal) Changes(ctx context.Context, options host.ChangesOptions) ([]host.JournalEntry, int64, error) {
	if options.Wait <= 0 {
		return j.changes(options)
	}
	// Listening starts before the first look, so a change committed in between is not missed.
	woken := make(chan struct{}, 1)
	unsubscribe := j.SubscribeEntries(func(entry host.JournalEntry) {
		if entry.Rev <= options.After || (options.RoomID != "" && entry.RoomID != options.RoomID) {
			return
		}
		select {
		case woken <- struct{}{}:
		default:
		}
	})
	defer unsubscribe()
	found, cursor, err := j.changes(options)
	if err != nil || len(found) > 0 {
		return found, cursor, err
	}
	timer := time.NewTimer(options.Wait)
	defer timer.Stop()
	select {
	case <-woken:
	case <-timer.C:
	case <-ctx.Done():
	}
	return j.changes(options)
}

// SubscribeEntries listens for committed changes in this journal: call gets each changed entry,
// after its commit, on the goroutine that made the change. The returned function removes the
// listener.
func (j *MessageJournal) SubscribeEntries(call func(host.JournalEntry)) (unsubscribe func()) {
	added := &listener{call: call}
	j.mu.Lock()
	j.listeners = append(j.listeners, added)
	j.mu.Unlock()
	return func() {
		added.removed.Store(true)
		j.mu.Lock()
		j.listeners = slices.DeleteFunc(j.listeners, func(other *listener) bool { return other == added })
		j.mu.Unlock()
	}
}

// Subscribe calls wake after every committed change. The returned function unsubscribes.
func (j *MessageJournal) Subscribe(wake func()) (unsubscribe func()) {
	return j.SubscribeEntries(func(host.JournalEntry) { wake() })
}

// Latest returns the newest count messages of a room, oldest first, from the time the journal
// vouches for. An older message can be in the journal too (reading history, or a bridge filling in
// the past, makes sync deliver it), but there may be gaps around it, so it isn't counted as "the
// latest".
func (j *MessageJournal) Latest(roomID string, count int) ([]host.JournalEntry, error) {
	var latest []host.JournalEntry
	err := j.inTx(func(tx *sql.Tx) error {
		since, err := coveredSince(tx)
		if err != nil {
			return err
		}
		latest, err = entries(tx,
			`SELECT `+columns+` FROM journal WHERE room_id = ? AND pending = 0 AND ts >= ?
         ORDER BY ts DESC, seq DESC LIMIT ?`,
			roomID, since, clamp(count, 1, 500),
		)
		return err
	})
	if err != nil {
		return nil, err
	}
	slices.Reverse(latest)
	return latest, nil
}

// Since returns a room's messages sent at or after a time (Unix ms), oldest first (500 at most).
func (j *MessageJournal) Since(roomID string, sinceTS int64) ([]host.JournalEntry, error) {
	return entries(j.db,
		"SELECT "+columns+" FROM journal WHERE room_id = ? AND ts >= ? AND pending = 0 ORDER BY ts, seq LIMIT 500",
		roomID, sinceTS,
	)
}

// Recent returns every room's messages sent at or after a time, oldest first, limit at most (the
// oldest). limit 0 means 2000.
func (j *MessageJournal) Recent(sinceTS int64, limit int) ([]host.JournalEntry, error) {
	if limit == 0 {
		limit = 2000
	}
	return entries(j.db,
		"SELECT "+columns+" FROM journal WHERE ts >= ? AND pending = 0 ORDER BY ts, seq LIMIT ?",
		sinceTS, clamp(limit, 1, 5000),
	)
}

// Prune drops what is older than the retention, and the oldest rows past the cap.
func (j *MessageJournal) Prune(now int64) error {
	return j.inTx(func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM journal WHERE received_at < ?", now-RetentionMS); err != nil {
			return err
		}
		_, err := tx.Exec(
			"DELETE FROM journal WHERE seq <= (SELECT seq FROM journal ORDER BY seq DESC LIMIT 1 OFFSET ?)",
			maxRows,
		)
		return err
	})
}

// Stats returns the journal's position, coverage and size.
func (j *MessageJournal) Stats() (Stats, error) {
	var stats Stats
	err := j.inTx(func(tx *sql.Tx) error {
		err := tx.QueryRow("SELECT COUNT(*) AS entries, COALESCE(SUM(pending), 0) AS pending FROM journal").
			Scan(&stats.Entries, &stats.Pending)
		if err != nil {
			return err
		}
		if stats.Head, _, err = meta(tx, "head"); err != nil {
			return err
		}
		stats.CoveredSince, err = coveredSince(tx)
		return err
	})
	return stats, err
}

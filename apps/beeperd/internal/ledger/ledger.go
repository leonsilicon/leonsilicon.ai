// Package ledger records every send, keyed by its idempotency key, so a retried or overlapping
// request can't post twice.
//
//   - pending: being sent now, or the daemon died mid-send.
//   - sent: the homeserver returned an event ID.
//   - failed: the homeserver definitely refused it (a 4xx on the send itself, or it never got that far).
//   - unknown: the send PUT went out and no definite answer came back (timeout, connection loss, 5xx).
//
// Each key has one transaction ID for life, so resending a failed or unknown key reuses it and the
// homeserver deduplicates the event if it already has it.
package ledger

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
)

// SendStatus is how far a send got.
type SendStatus string

const (
	StatusPending SendStatus = "pending"
	StatusSent    SendStatus = "sent"
	StatusFailed  SendStatus = "failed"
	StatusUnknown SendStatus = "unknown"
)

// SendKind is what was sent.
type SendKind string

const (
	KindText     SendKind = "text"
	KindFile     SendKind = "file"
	KindReaction SendKind = "reaction"
)

// SendRecord is one row of the ledger.
type SendRecord struct {
	Key string `json:"key"`
	// Derived is true when the key was made from the payload, not given by the caller.
	Derived     bool       `json:"derived"`
	RoomID      string     `json:"roomId"`
	Kind        SendKind   `json:"kind"`
	PayloadHash string     `json:"payloadHash"`
	TxnID       string     `json:"txnId"`
	Status      SendStatus `json:"status"`
	EventID     *string    `json:"eventId"`
	Error       *string    `json:"error"`
	Attempts    int        `json:"attempts"`
	CreatedAt   int64      `json:"createdAt"`
	UpdatedAt   int64      `json:"updatedAt"`
}

// Attempt is what Begin needs to know about a send that is starting.
type Attempt struct {
	Key         string
	Derived     bool
	RoomID      string
	Kind        SendKind
	PayloadHash string
	TxnID       string
}

const (
	// DerivedKeyWindowMS is how long an identical message with no explicit key counts as a repeat of
	// the earlier one.
	DerivedKeyWindowMS int64 = 15 * 60_000
	// SafeResendWindowMS: homeservers keep transaction IDs for a limited time; past this a resend may
	// not be deduplicated.
	SafeResendWindowMS int64 = 30 * 60_000
)

// PayloadHash is the SHA-256 of a send's parts, each prefixed with its length so that moving text
// from one part to the next changes the hash. The length is in UTF-16 units, as the TypeScript
// service counted it: hashes in an existing ledger must stay the same.
func PayloadHash(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		units := 0
		for _, char := range part {
			units += utf16.RuneLen(char)
		}
		hash.Write([]byte(strconv.Itoa(units) + ":" + part))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

var explicitKey = regexp.MustCompile(`^[\w.:@!#+=-]{1,128}$`)

// IdempotencyKey is the ledger key. An explicit key is the caller's; without one (nil), the payload
// itself is the key, so the same text sent again within about DerivedKeyWindowMS is treated as a
// retry.
func IdempotencyKey(explicit *string, roomID string, kind SendKind, hash string) (key string, derived bool, err error) {
	if explicit != nil {
		trimmed := trim(*explicit)
		if !explicitKey.MatchString(trimmed) {
			return "", false, errors.New("idempotency_key must be 1-128 characters of letters, digits and . : @ ! # + = _ -")
		}
		return "k:" + roomID + ":" + trimmed, false, nil
	}
	return "h:" + roomID + ":" + string(kind) + ":" + hash, true, nil
}

// trim removes the leading and trailing whitespace JavaScript's trim does. strings.TrimSpace differs
// in two characters (it drops U+0085 and keeps U+FEFF), and a key must mean the same after the move
// from the TypeScript service.
func trim(text string) string {
	return strings.TrimFunc(text, func(char rune) bool {
		switch char {
		case '\t', '\n', '\v', '\f', '\r', 0x2028, 0x2029, 0xFEFF:
			return true
		}
		return unicode.Is(unicode.Zs, char)
	})
}

// TxnIDFor is the Matrix transaction ID for a key: stable, opaque, URL-safe. generation is 0 for a
// key's first and only ID.
func TxnIDFor(key string, generation int) string {
	sum := sha256.Sum256([]byte(strconv.Itoa(generation) + ":" + key))
	digest := base64.RawURLEncoding.EncodeToString(sum[:])
	prefix := "bi"
	if generation != 0 {
		prefix += strconv.Itoa(generation) + "."
	}
	return prefix + digest[:26]
}

// SendLedger is the sends table of inbox.db.
type SendLedger struct {
	db *sql.DB
}

// New opens the ledger in db, creating its table when it is missing.
func New(db *sql.DB) (*SendLedger, error) {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS sends (
      key TEXT PRIMARY KEY,
      derived INTEGER NOT NULL,
      room_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      txn_id TEXT NOT NULL,
      status TEXT NOT NULL,
      event_id TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
	if err != nil {
		return nil, err
	}
	return &SendLedger{db: db}, nil
}

const columns = "key, derived, room_id, kind, payload_hash, txn_id, status, event_id, error, attempts, created_at, updated_at"

func scan(scanner interface{ Scan(...any) error }) (SendRecord, error) {
	var (
		record         SendRecord
		derived        int64
		eventID, cause sql.NullString
	)
	err := scanner.Scan(&record.Key, &derived, &record.RoomID, &record.Kind, &record.PayloadHash, &record.TxnID,
		&record.Status, &eventID, &cause, &record.Attempts, &record.CreatedAt, &record.UpdatedAt)
	if err != nil {
		return SendRecord{}, err
	}
	record.Derived = derived == 1
	if eventID.Valid {
		record.EventID = &eventID.String
	}
	if cause.Valid {
		record.Error = &cause.String
	}
	return record, nil
}

// queryer is what a read needs: the database itself, or a transaction on it.
type queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}

func get(db queryer, key string) (*SendRecord, error) {
	record, err := scan(db.QueryRow("SELECT "+columns+" FROM sends WHERE key = ?", key))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// written runs a write and reads the row back in one transaction, so the record returned is the one
// this call left behind.
func (l *SendLedger) written(key string, write func(tx *sql.Tx) error) (SendRecord, error) {
	tx, err := l.db.Begin()
	if err != nil {
		return SendRecord{}, err
	}
	fail := func(err error) (SendRecord, error) {
		return SendRecord{}, errors.Join(err, tx.Rollback())
	}
	if err := write(tx); err != nil {
		return fail(err)
	}
	record, err := get(tx, key)
	if err != nil {
		return fail(err)
	}
	if record == nil {
		return fail(fmt.Errorf("the ledger has no send with key %q", key))
	}
	return *record, tx.Commit()
}

// nullable is the SQL value of an optional string: NULL when it is empty.
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// Get returns the record of a key, or nil when there is none.
func (l *SendLedger) Get(key string) (*SendRecord, error) {
	return get(l.db, key)
}

// Begin records an attempt starting. It creates the record, or bumps an existing one back to pending
// (which keeps its first transaction ID).
func (l *SendLedger) Begin(attempt Attempt, now int64) (SendRecord, error) {
	derived := 0
	if attempt.Derived {
		derived = 1
	}
	return l.written(attempt.Key, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`INSERT INTO sends (key, derived, room_id, kind, payload_hash, txn_id, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET status = 'pending', attempts = attempts + 1, updated_at = excluded.updated_at, error = NULL`,
			attempt.Key, derived, attempt.RoomID, string(attempt.Kind), attempt.PayloadHash, attempt.TxnID, now, now,
		)
		return err
	})
}

// Finish records how an attempt ended: sent, failed or unknown. An empty eventID keeps the one the
// record has; an empty failure clears its error.
func (l *SendLedger) Finish(key string, status SendStatus, eventID, failure string, now int64) (SendRecord, error) {
	return l.written(key, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			"UPDATE sends SET status = ?, event_id = COALESCE(?, event_id), error = ?, updated_at = ? WHERE key = ?",
			string(status), nullable(eventID), nullable(failure), now, key,
		)
		return err
	})
}

// Retire renames a derived key past its window, so the same text can be sent again on purpose.
func (l *SendLedger) Retire(key string, now int64) error {
	_, err := l.db.Exec("UPDATE sends SET key = ? WHERE key = ?", key+"#retired@"+strconv.FormatInt(now, 10), key)
	return err
}

// Recent returns the sends that changed last, newest first. limit 0 means 20.
func (l *SendLedger) Recent(limit int) ([]SendRecord, error) {
	if limit == 0 {
		limit = 20
	}
	rows, err := l.db.Query("SELECT "+columns+" FROM sends ORDER BY updated_at DESC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []SendRecord{}
	for rows.Next() {
		record, err := scan(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

// Prune drops the sends that last changed more than olderThanMS ago, and returns how many.
func (l *SendLedger) Prune(olderThanMS, now int64) (int64, error) {
	result, err := l.db.Exec("DELETE FROM sends WHERE updated_at < ?", now-olderThanMS)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

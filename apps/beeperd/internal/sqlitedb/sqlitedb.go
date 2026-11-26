// Package sqlitedb opens the daemon's own SQLite files (journal, send ledger, room directory).
package sqlitedb

import (
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

// Open opens (and creates) a SQLite file in WAL mode with one connection, so every statement sees
// the same transaction state. Use ":memory:" in tests.
func Open(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_synchronous=FULL&_busy_timeout=5000&_txlock=immediate", path)
	if path == ":memory:" {
		dsn = "file::memory:?_busy_timeout=5000"
	}
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

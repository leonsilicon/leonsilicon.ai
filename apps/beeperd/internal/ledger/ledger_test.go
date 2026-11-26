package ledger

import (
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/sqlitedb"
)

const keyRule = "idempotency_key must be 1-128 characters of letters, digits and . : @ ! # + = _ -"

func open(t *testing.T, path string) *SendLedger {
	t.Helper()
	db, err := sqlitedb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ledger, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	return ledger
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

func equal(t *testing.T, got, want any, message string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %#v, want %#v", message, got, want)
	}
}

func key(t *testing.T, explicit *string, kind SendKind, hash string) (string, bool) {
	t.Helper()
	key, derived, err := IdempotencyKey(explicit, "!r:x", kind, hash)
	if err != nil {
		t.Fatal(err)
	}
	return key, derived
}

func ptr(text string) *string { return &text }

func TestKeysTransactionIDsAndStateTransitions(t *testing.T) {
	ledger := open(t, ":memory:")
	hash := PayloadHash("text", "hello", "")
	if hash == PayloadHash("text", "hell", "o") {
		t.Fatal("parts are length-prefixed")
	}
	derivedKey, derived := key(t, nil, KindText, hash)
	equal(t, derived, true, "a key made from the payload")
	explicit, derived := key(t, ptr("order-42"), KindText, hash)
	equal(t, []any{explicit, derived}, []any{"k:!r:x:order-42", false}, "the caller's key")
	if _, _, err := IdempotencyKey(ptr("has space"), "!r:x", KindText, hash); err == nil || err.Error() != keyRule {
		t.Fatalf("a key with a space is refused with the rule, not %v", err)
	}
	equal(t, TxnIDFor(explicit, 0), TxnIDFor(explicit, 0), "a key's transaction ID is stable")
	if TxnIDFor(explicit, 0) == TxnIDFor(derivedKey, 0) {
		t.Fatal("two keys share a transaction ID")
	}
	if !regexp.MustCompile(`^bi[A-Za-z0-9_-]{26}$`).MatchString(TxnIDFor(explicit, 0)) {
		t.Fatalf("transaction ID %q isn't opaque and URL-safe", TxnIDFor(explicit, 0))
	}
	begun := must(ledger.Begin(Attempt{
		Key: explicit, RoomID: "!r:x", Kind: KindText, PayloadHash: hash, TxnID: TxnIDFor(explicit, 0),
	}, 1000))(t)
	equal(t, begun.Status, StatusPending, "an attempt that started")
	equal(t, must(ledger.Finish(explicit, StatusUnknown, "", "timeout", 2000))(t).Status, StatusUnknown, "no definite answer")
	retried := must(ledger.Begin(Attempt{
		Key: explicit, RoomID: "!r:x", Kind: KindText, PayloadHash: hash, TxnID: "ignored",
	}, 3000))(t)
	equal(t, retried.Attempts, 2, "attempts")
	equal(t, retried.TxnID, TxnIDFor(explicit, 0), "a key keeps its first transaction ID")
	sent := must(ledger.Finish(explicit, StatusSent, "$e", "", 4000))(t)
	equal(t, sent.EventID, ptr("$e"), "the event the homeserver returned")
	if err := ledger.Retire(explicit, 5000); err != nil {
		t.Fatal(err)
	}
	equal(t, must(ledger.Get(explicit))(t), (*SendRecord)(nil), "a retired key is free again")
}

// Hashes, keys and transaction IDs are in the ledger the TypeScript service left behind, and a
// retry after the move must land on the same row and the same transaction ID. The expected values
// are what ledger.ts returns.
func TestSameValuesAsTheTypeScriptService(t *testing.T) {
	equal(t, PayloadHash("text", "hello", ""), "a15367fa7984ef2ba97315c276c42d97d0d412f2645b3d9c17ff50050f45b52d", "a text")
	equal(t, PayloadHash("text", "héllo 👍", "$reply"), "51a427bb63858e73533968e1f126ec5d9076ce161fd72636752698e520deaa25",
		"lengths count UTF-16 units")
	equal(t, PayloadHash(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "no parts")
	equal(t, TxnIDFor("k:!r:x:order-42", 0), "biK9-1UNLkpBq3pZ1Ss10fyyfUt1", "a key's transaction ID")
	equal(t, TxnIDFor("k:!r:x:order-42", 3), "bi3.xg1cMq7iWiagOY9Ry7T7vN_tBQ", "a later generation")

	trimmed, derived := key(t, ptr("  order-42\n"), KindText, "abc")
	equal(t, []any{trimmed, derived}, []any{"k:!r:x:order-42", false}, "a key is trimmed")
	fromPayload, derived := key(t, nil, KindReaction, "abc")
	equal(t, []any{fromPayload, derived}, []any{"h:!r:x:reaction:abc", true}, "a key made from the payload")
	longest, _ := key(t, ptr(strings.Repeat("x", 128)), KindText, "abc")
	equal(t, len(longest), 135, "128 characters are allowed")
	// JavaScript's trim drops a byte order mark and a no-break space, and keeps U+0085.
	byteOrderMark, noBreakSpace, nextLine := string(rune(0xFEFF)), string(rune(0xA0)), string(rune(0x85))
	spaced, _ := key(t, ptr(byteOrderMark+"ab"+noBreakSpace), KindText, "abc")
	equal(t, spaced, "k:!r:x:ab", "trimmed as JavaScript trims")
	for _, bad := range []string{"has space", "", " ", strings.Repeat("x", 129), "kéy", "a/b", nextLine + "ab"} {
		if _, _, err := IdempotencyKey(&bad, "!r:x", KindText, "abc"); err == nil || err.Error() != keyRule {
			t.Fatalf("key %q is refused with the rule, not %v", bad, err)
		}
	}
}

func TestRecordsAsStored(t *testing.T) {
	ledger := open(t, ":memory:")
	begin := func(key string, derived bool, now int64) SendRecord {
		t.Helper()
		return must(ledger.Begin(Attempt{Key: key, Derived: derived, RoomID: "!r:x", Kind: KindFile, PayloadHash: "h", TxnID: "t-" + key}, now))(t)
	}
	equal(t, begin("a", true, 1000), SendRecord{
		Key: "a", Derived: true, RoomID: "!r:x", Kind: KindFile, PayloadHash: "h", TxnID: "t-a",
		Status: StatusPending, Attempts: 1, CreatedAt: 1000, UpdatedAt: 1000,
	}, "a new record")
	failed := must(ledger.Finish("a", StatusFailed, "", "M_FORBIDDEN", 2000))(t)
	equal(t, []any{failed.Status, failed.EventID, failed.Error, failed.UpdatedAt},
		[]any{StatusFailed, (*string)(nil), ptr("M_FORBIDDEN"), int64(2000)}, "a refused send")
	again := begin("a", true, 3000)
	equal(t, []any{again.Status, again.Error, again.Attempts, again.CreatedAt, again.UpdatedAt},
		[]any{StatusPending, (*string)(nil), 2, int64(1000), int64(3000)}, "a new attempt clears the error")
	must(ledger.Finish("a", StatusSent, "$a", "", 4000))(t)
	// An event ID, once known, stays: a later answer without one doesn't forget it.
	equal(t, must(ledger.Finish("a", StatusUnknown, "", "timeout", 5000))(t).EventID, ptr("$a"), "the event ID is kept")

	if _, err := ledger.Finish("missing", StatusSent, "$x", "", 6000); err == nil {
		t.Fatal("finishing a send that never began is an error")
	}

	begin("b", false, 7000)
	begin("c", false, 6000)
	recent := must(ledger.Recent(0))(t)
	equal(t, []string{recent[0].Key, recent[1].Key, recent[2].Key}, []string{"b", "c", "a"}, "newest change first")
	equal(t, len(must(ledger.Recent(2))(t)), 2, "up to the limit")

	if err := ledger.Retire("a", 8000); err != nil {
		t.Fatal(err)
	}
	equal(t, must(ledger.Get("a#retired@8000"))(t).TxnID, "t-a", "a retired key keeps its history under another name")

	equal(t, must(ledger.Prune(1000, 7500))(t), int64(2), "what last changed before the cutoff is dropped")
	equal(t, must(ledger.Recent(0))(t)[0].Key, "b", "the rest stays")
}

func TestTheLedgerSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inbox.db")
	db, err := sqlitedb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	must(ledger.Begin(Attempt{Key: "k:!r:x:q1", RoomID: "!r:x", Kind: KindText, PayloadHash: "h", TxnID: "t"}, 1000))(t)
	must(ledger.Finish("k:!r:x:q1", StatusSent, "$sent", "", 2000))(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	record := must(open(t, path).Get("k:!r:x:q1"))(t)
	equal(t, []any{record.Status, record.EventID}, []any{StatusSent, ptr("$sent")}, "the send is still known")
}

package inbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/directory"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/journal"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/ledger"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/sqlitedb"
)

// Version is the daemon's version, shown in status and to MCP clients.
const Version = "1.0.0"

// Limits on what the tools read and send.
const (
	DefaultPage  = 30
	MaxPage      = 100
	MaxTextChars = 4000
	MaxSendChars = 20_000
	// MaxDownloadBytes: decrypted media is held in memory on a 4 GB machine shared with Hermes.
	MaxDownloadBytes = 64 * 1024 * 1024
	// MaxUploadBytes: WhatsApp documents top out at 100 MB and most networks lower; Beeper's media
	// limit applies too.
	MaxUploadBytes       = 50 * 1024 * 1024
	RoundTripVerifyBytes = 16 * 1024 * 1024
)

const (
	// directoryMaxAge is how old the directory may get before it is rebuilt from a full snapshot,
	// as a check on what live sync kept up to date.
	directoryMaxAge = 24 * time.Hour
	// syncStale is how long sync may go without an answer before the daemon counts as unhealthy.
	syncStale = 5 * time.Minute
	// syncTimeout is how long the homeserver holds a sync request open when nothing is new.
	syncTimeout = 30 * time.Second
)

// State is where the inbox is in its life.
type State string

const (
	StateStarting   State = "starting"
	StateNeedsLogin State = "needs_login"
	StateReady      State = "ready"
	StateError      State = "error"
	StateStopped    State = "stopped"
)

// Options configures an Inbox.
type Options struct {
	Paths Paths
	Log   host.Logger
	// LibraryLog receives the Matrix library's own warnings (no message text).
	LibraryLog zerolog.Logger
	// Now is the clock (Unix ms); nil means the system clock.
	Now func() int64
	// BridgeStatusWait is how long a send waits for the bridge's delivery status; 0 means 8 s.
	BridgeStatusWait time.Duration
}

type bridgeStatus struct {
	Status  string
	Reason  string
	Message string
	Network string
	At      int64
}

// Inbox is the signed-in device: it syncs, decrypts, writes down what arrives and sends.
type Inbox struct {
	paths            Paths
	log              host.Logger
	libraryLog       zerolog.Logger
	now              func() int64
	bridgeStatusWait time.Duration

	// mu guards everything below it that changes after Start.
	mu         sync.Mutex
	state      State
	stateError string
	session    *Session
	core       *matrixCore
	db         *sql.DB
	journal    *journal.MessageJournal
	directory  *directory.RoomDirectory
	ledger     *ledger.SendLedger
	startedAt  int64
	bootedAt   int64
	syncCancel context.CancelFunc
	syncDone   chan struct{}

	// sendMu makes sends one at a time, so overlapping requests with the same key wait for the first.
	sendMu sync.Mutex

	cache caches

	syncMu    sync.Mutex
	syncStats syncStats

	refresh *coalesced

	// journalWakers are told about every committed journal change, across reloads (which replace the
	// journal).
	wakersMu sync.Mutex
	wakers   map[int]func()
	nextWake int
}

type syncStats struct {
	lastOKAt            int64
	lastErrorAt         int64
	lastError           string
	consecutiveFailures int
	syncs               int64
	state               string
}

// New prepares an Inbox. Nothing is opened until Start.
func New(options Options) *Inbox {
	now := options.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	wait := options.BridgeStatusWait
	if wait == 0 {
		wait = 8 * time.Second
	}
	inbox := &Inbox{
		paths:            options.Paths,
		log:              options.Log,
		libraryLog:       options.LibraryLog,
		now:              now,
		bridgeStatusWait: wait,
		state:            StateStarting,
		startedAt:        now(),
	}
	inbox.cache.init()
	inbox.refresh = newCoalesced(inbox.refreshDirectoryNow, now)
	return inbox
}

// State reports where the inbox is in its life.
func (ib *Inbox) State() State {
	ib.mu.Lock()
	defer ib.mu.Unlock()
	return ib.state
}

// Journal is the journal of messages as sync delivered them, or nil while the stores are closed.
func (ib *Inbox) Journal() *journal.MessageJournal {
	ib.mu.Lock()
	defer ib.mu.Unlock()
	return ib.journal
}

func (ib *Inbox) fail(state State, err error) {
	ib.mu.Lock()
	ib.state = state
	ib.stateError = err.Error()
	ib.mu.Unlock()
}

// Start opens the stores, signs in and begins syncing. It never returns an error for a missing
// login or a refused token: those leave the state at needs_login or error, which status reports.
func (ib *Inbox) Start(ctx context.Context) error {
	if err := ib.openStores(); err != nil {
		ib.fail(StateError, err)
		ib.log("error", "beeper-inbox failed to open its stores", map[string]any{"error": err.Error()})
		return err
	}
	session, err := LoadSession(ib.paths.Session)
	if errors.Is(err, ErrNoSession) {
		ib.fail(StateNeedsLogin, fmt.Errorf("no device yet: %s is missing", ib.paths.Session))
		ib.log("warn", "beeper-inbox needs a login", map[string]any{"reason": "no session file"})
		return nil
	} else if err != nil {
		ib.fail(StateError, err)
		return nil
	}
	_, statErr := os.Stat(ib.paths.CryptoDB)
	pickleKey, err := LoadOrCreatePickleKey(ib.paths.PickleKey, statErr == nil)
	if err != nil {
		ib.fail(StateError, err)
		ib.log("error", "beeper-inbox failed to start", map[string]any{"error": err.Error()})
		return nil
	}
	core, err := openMatrix(ctx, session, pickleKey, ib.paths.CryptoDB, ib.libraryLog)
	if err != nil {
		ib.fail(StateError, err)
		ib.log("error", "beeper-inbox failed to start", map[string]any{"error": err.Error()})
		return nil
	}
	ib.mu.Lock()
	ib.session = session
	ib.core = core
	ib.bootedAt = ib.now()
	ib.mu.Unlock()
	ib.register(core)

	syncCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	ib.mu.Lock()
	ib.syncCancel = cancel
	ib.syncDone = done
	ib.state = StateReady
	ib.stateError = ""
	ib.mu.Unlock()
	go func() {
		defer close(done)
		ib.syncLoop(syncCtx, core)
	}()
	go ib.refreshMuted(syncCtx)
	ib.log("info", "beeper-inbox ready", map[string]any{
		"userId": session.UserID, "deviceId": session.DeviceID,
		"verified": session.VerifiedAt != "", "keyBackup": core.backupKey != nil,
	})
	return nil
}

func (ib *Inbox) openStores() error {
	ib.mu.Lock()
	defer ib.mu.Unlock()
	if ib.db != nil {
		return nil
	}
	db, err := sqlitedb.Open(ib.paths.InboxDB)
	if err != nil {
		return err
	}
	now := ib.now()
	messages, err := journal.New(db, now)
	if err != nil {
		db.Close()
		return err
	}
	rooms, err := directory.New(db)
	if err != nil {
		db.Close()
		return err
	}
	sends, err := ledger.New(db)
	if err != nil {
		db.Close()
		return err
	}
	_ = messages.Prune(now)
	_, _ = sends.Prune(30*24*60*60_000, now)
	messages.Subscribe(ib.wakeAll)
	ib.db, ib.journal, ib.directory, ib.ledger = db, messages, rooms, sends
	return nil
}

func (ib *Inbox) wakeAll() {
	ib.wakersMu.Lock()
	wakers := make([]func(), 0, len(ib.wakers))
	for _, wake := range ib.wakers {
		wakers = append(wakers, wake)
	}
	ib.wakersMu.Unlock()
	for _, wake := range wakers {
		wake()
	}
}

// SubscribeToJournal calls wake after every committed journal change, including after a reload.
// The returned function unsubscribes.
func (ib *Inbox) SubscribeToJournal(wake func()) (unsubscribe func()) {
	ib.wakersMu.Lock()
	defer ib.wakersMu.Unlock()
	if ib.wakers == nil {
		ib.wakers = map[int]func(){}
	}
	key := ib.nextWake
	ib.nextWake++
	ib.wakers[key] = wake
	return func() {
		ib.wakersMu.Lock()
		delete(ib.wakers, key)
		ib.wakersMu.Unlock()
	}
}

// Reload re-reads the session (after a login) and starts again in the same process.
func (ib *Inbox) Reload(ctx context.Context) error {
	ib.Stop()
	ib.refresh.reset()
	ib.mu.Lock()
	ib.state, ib.stateError = StateStarting, ""
	ib.mu.Unlock()
	return ib.Start(ctx)
}

// Stop ends sync and closes the stores. The device stays signed in: there is no logout.
func (ib *Inbox) Stop() {
	ib.mu.Lock()
	cancel, done, core, db := ib.syncCancel, ib.syncDone, ib.core, ib.db
	ib.syncCancel, ib.syncDone, ib.core, ib.db = nil, nil, nil, nil
	ib.state = StateStopped
	ib.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	if core != nil {
		core.close()
	}
	if db != nil {
		_ = db.Close()
	}
	ib.mu.Lock()
	ib.journal, ib.directory, ib.ledger = nil, nil, nil
	ib.mu.Unlock()
}

// ready returns the open pieces, or the error a tool should give while the inbox isn't usable.
func (ib *Inbox) ready() (*matrixCore, *Session, error) {
	ib.mu.Lock()
	defer ib.mu.Unlock()
	if ib.state == StateNeedsLogin {
		return nil, nil, toolError("not_logged_in", fmt.Sprintf(
			"beeper-inbox isn't signed in yet (%s). Ask Leon; the login steps are in the beeperd README.", ib.stateError))
	}
	if ib.state != StateReady || ib.core == nil || ib.session == nil || ib.directory == nil || ib.ledger == nil {
		message := "beeper-inbox is " + string(ib.state)
		if ib.stateError != "" {
			message += ": " + ib.stateError
		}
		return nil, nil, toolError("unavailable", message)
	}
	return ib.core, ib.session, nil
}

func toolError(code, message string) *host.ToolError {
	return &host.ToolError{Code: code, Message: message}
}

func toolErrorData(code, message string, data any) *host.ToolError {
	return &host.ToolError{Code: code, Message: message, Data: data}
}

// ── Sync ─────────────────────────────────────────────────────────────────────────────────────────

var allTypes = []event.Type{{Type: "*"}}

// syncFilter is what sync delivers: room metadata the directory needs, every timeline event, the
// account data that says which chats are direct, muted or tagged, and nothing else (no presence,
// typing or read receipts). Beeper ignores an empty `types` list but honours `not_types: ["*"]`.
func syncFilter() *mautrix.Filter {
	return &mautrix.Filter{
		Presence:    &mautrix.FilterPart{NotTypes: allTypes},
		AccountData: &mautrix.FilterPart{Types: []event.Type{event.AccountDataDirectChats, event.AccountDataPushRules}},
		Room: &mautrix.RoomFilter{
			AccountData: &mautrix.FilterPart{Types: []event.Type{event.AccountDataRoomTags}},
			Ephemeral:   &mautrix.FilterPart{NotTypes: allTypes},
			State: &mautrix.FilterPart{
				Types: []event.Type{
					event.StateRoomName, event.StateCanonicalAlias, event.StateEncryption, event.StateMember,
					event.StateTombstone, event.StateBridge, event.StateHalfShotBridge,
				},
				LazyLoadMembers: true,
			},
			Timeline: &mautrix.FilterPart{Limit: 50, LazyLoadMembers: true},
		},
	}
}

// syncLoop long-polls the homeserver until ctx ends. A response is processed before its position is
// saved, so a crash in between repeats the response instead of losing it: the journal ignores
// messages it already has, and a room key that is already stored is left alone.
func (ib *Inbox) syncLoop(ctx context.Context, core *matrixCore) {
	var filterID string
	since, err := core.cli.Store.LoadNextBatch(ctx, core.cli.UserID)
	if err != nil {
		ib.log("error", "couldn't read the sync position", map[string]any{"error": err.Error()})
	}
	if since != "" {
		// Sync resumes where it left off and only brings changes, so a directory that was never
		// built (or is days old) has to be rebuilt from a snapshot.
		if rooms := ib.rooms(); rooms != nil {
			if refreshedAt, _ := rooms.RefreshedAt(); refreshedAt == nil || ib.now()-*refreshedAt > directoryMaxAge.Milliseconds() {
				go func() {
					if _, err := ib.refresh.get(0); err != nil {
						ib.log("warn", "directory refresh failed", map[string]any{"error": err.Error()})
					}
				}()
			}
		}
	}
	failures := 0
	// The first request, and the first after a failure, returns at once instead of waiting for news.
	immediate := true
	for ctx.Err() == nil {
		if filterID == "" {
			created, err := core.cli.CreateFilter(ctx, syncFilter())
			if err != nil {
				failures = ib.syncFailed(ctx, err, failures)
				continue
			}
			filterID = created.FilterID
		}
		timeout := int(syncTimeout / time.Millisecond)
		if immediate || since == "" {
			timeout = 0
		}
		requestCtx, cancel := context.WithTimeout(ctx, syncTimeout+60*time.Second)
		if since == "" {
			// The first sync returns every room: minutes on a slow day.
			cancel()
			requestCtx, cancel = context.WithTimeout(ctx, 5*time.Minute)
		}
		resp, err := core.cli.FullSyncRequest(requestCtx, mautrix.ReqSync{
			Timeout: timeout, Since: since, FilterID: filterID, SetPresence: event.PresenceOffline,
		})
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if errors.Is(err, mautrix.MUnknownToken) {
				ib.fail(StateError, errors.New("the homeserver no longer accepts this device's token: it was signed out"))
				ib.log("error", "the device was signed out", nil)
				return
			}
			immediate = true
			failures = ib.syncFailed(ctx, err, failures)
			continue
		}
		failures = 0
		immediate = false
		ib.syncMu.Lock()
		ib.syncStats.lastOKAt = ib.now()
		ib.syncStats.consecutiveFailures = 0
		ib.syncStats.syncs++
		ib.syncStats.state = "syncing"
		ib.syncMu.Unlock()

		ib.processSync(ctx, core, resp, since)
		if err := core.cli.Store.SaveNextBatch(ctx, core.cli.UserID, resp.NextBatch); err != nil {
			ib.log("error", "couldn't save the sync position", map[string]any{"error": err.Error()})
			continue
		}
		since = resp.NextBatch
	}
}

func (ib *Inbox) syncFailed(ctx context.Context, err error, failures int) int {
	failures++
	ib.syncMu.Lock()
	ib.syncStats.lastErrorAt = ib.now()
	ib.syncStats.lastError = err.Error()
	ib.syncStats.consecutiveFailures = failures
	ib.syncStats.state = "failing"
	ib.syncMu.Unlock()
	if failures == 1 || failures%20 == 0 {
		ib.log("warn", "sync failed; retrying", map[string]any{"failures": failures, "error": trim(err.Error(), 300)})
	}
	wait := time.Duration(failures) * 2 * time.Second
	if wait > 30*time.Second {
		wait = 30 * time.Second
	}
	select {
	case <-ctx.Done():
	case <-time.After(wait):
	}
	return failures
}

func (ib *Inbox) processSync(ctx context.Context, core *matrixCore, resp *mautrix.RespSync, since string) {
	defer func() {
		if recovered := recover(); recovered != nil {
			ib.log("error", "processing a sync response panicked", map[string]any{"panic": fmt.Sprint(recovered)})
		}
	}()
	ib.directoryFromSync(ctx, core, resp, since == "")
	if since == "" {
		// The first sync's timelines are history, not news: nothing in them is written down.
		for _, room := range resp.Rooms.Join {
			room.Timeline.Events = nil
		}
	}
	if err := core.syncer.ProcessResponse(ctx, resp, since); err != nil {
		ib.log("error", "processing a sync response failed", map[string]any{"error": trim(err.Error(), 300)})
	}
	if since == "" {
		// The first sync holds every room; give its memory back instead of keeping it for next time.
		debug.FreeOSMemory()
	}
}

// register hooks the inbox into the Matrix client: decrypted and plain messages, deletions, bridge
// delivery statuses, mutes, and events that couldn't be decrypted.
func (ib *Inbox) register(core *matrixCore) {
	core.syncer.OnEventType(event.EventMessage, func(ctx context.Context, evt *event.Event) {
		ib.onMessage(core, evt)
	})
	core.syncer.OnEventType(event.EventRedaction, func(ctx context.Context, evt *event.Event) {
		redacts := evt.Redacts
		if redacts == "" {
			if content, ok := evt.Content.Parsed.(*event.RedactionEventContent); ok {
				redacts = content.Redacts
			}
		}
		if redacts == "" {
			return
		}
		if journal := ib.Journal(); journal != nil {
			if _, err := journal.Redact(redacts.String()); err != nil {
				ib.log("warn", "journal update failed", map[string]any{"error": err.Error()})
			}
		}
	})
	core.syncer.OnEventType(event.EventEncrypted, func(ctx context.Context, evt *event.Event) {
		ib.touch(evt.RoomID.String(), evt.Timestamp, evt.Sender.String())
	})
	core.syncer.OnEventType(event.BeeperMessageStatus, func(ctx context.Context, evt *event.Event) {
		ib.onBridgeStatus(evt)
	})
	core.syncer.OnEventType(event.AccountDataPushRules, func(ctx context.Context, evt *event.Event) {
		ib.setMuted(evt.Content.Raw["global"])
	})
	core.syncer.OnEventType(event.AccountDataDirectChats, func(ctx context.Context, evt *event.Event) {
		ib.cache.setDirect(evt.Content.Raw)
	})
	core.syncer.OnEventType(event.StateRoomName, func(ctx context.Context, evt *event.Event) {
		if evt.Mautrix.EventSource&event.SourceTimeline == 0 {
			return
		}
		if name, _ := evt.Content.Raw["name"].(string); trimSpace(name) != "" {
			if rooms := ib.rooms(); rooms != nil {
				_ = rooms.Rename(evt.RoomID.String(), trimSpace(name))
			}
		}
	})
	// A key that arrives after its message: read what was waiting for it right away.
	core.mach.SessionReceived = func(ctx context.Context, roomID id.RoomID, sessionID id.SessionID, _ uint32) {
		go ib.retryPending(context.WithoutCancel(ctx), core, roomID.String())
	}
	core.helper.DecryptErrorCallback = func(evt *event.Event, err error) {
		ib.onUndecryptable(context.Background(), core, evt, err)
	}
}

func (ib *Inbox) rooms() *directory.RoomDirectory {
	ib.mu.Lock()
	defer ib.mu.Unlock()
	return ib.directory
}

func (ib *Inbox) touch(roomID string, ts int64, sender string) {
	if ts <= 0 {
		return
	}
	if rooms := ib.rooms(); rooms != nil {
		_ = rooms.Touch(roomID, ts, sender)
	}
}

// onMessage writes one message from sync (or from a late decryption) into the journal.
func (ib *Inbox) onMessage(core *matrixCore, evt *event.Event) {
	message := convertMessage(evt, core.cli.UserID)
	if message == nil {
		return
	}
	ib.touch(message.RoomID, evt.Timestamp, evt.Sender.String())
	ib.record(message)
}

// onUndecryptable handles an event whose key isn't in the store. The key may be in the account's
// server-side backup (another of Leon's devices uploads them); otherwise the event waits in the
// journal and is tried again when a key arrives and once a minute.
func (ib *Inbox) onUndecryptable(ctx context.Context, core *matrixCore, evt *event.Event, cause error) {
	if evt == nil {
		return
	}
	if decrypted := ib.decryptFromBackup(ctx, core, evt); decrypted != nil {
		core.syncer.Dispatch(ctx, decrypted)
		return
	}
	ib.cache.setDecryptError(evt.ID.String(), cause.Error())
	if journal := ib.Journal(); journal != nil {
		if err := journal.Pending(evt.RoomID.String(), evt.ID.String(), evt.Sender.String(), ib.now()); err != nil {
			ib.log("debug", "journal update failed", map[string]any{"error": err.Error()})
		}
	}
}

func (ib *Inbox) decryptFromBackup(ctx context.Context, core *matrixCore, evt *event.Event) *event.Event {
	content, ok := evt.Content.Parsed.(*event.EncryptedEventContent)
	if !ok {
		if evt.Content.ParseRaw(evt.Type) != nil {
			return nil
		}
		if content, ok = evt.Content.Parsed.(*event.EncryptedEventContent); !ok {
			return nil
		}
	}
	if !core.restoreFromBackup(ctx, evt.RoomID, content.SessionID) {
		return nil
	}
	decrypted, err := core.helper.Decrypt(ctx, evt)
	if err != nil {
		return nil
	}
	decrypted.Mautrix.EventSource |= event.SourceDecrypted
	return decrypted
}

// retryPending reads again the events of a room that were waiting for a key.
func (ib *Inbox) retryPending(ctx context.Context, core *matrixCore, roomID string) {
	journal := ib.Journal()
	if journal == nil {
		return
	}
	due, err := journal.PendingDue(ib.now()+24*60*60_000, 50)
	if err != nil {
		return
	}
	for _, pending := range due {
		if roomID != "" && pending.RoomID != roomID {
			continue
		}
		ib.readPending(ctx, core, pending.RoomID, pending.EventID)
	}
}

func (ib *Inbox) readPending(ctx context.Context, core *matrixCore, roomID, eventID string) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	message, _, err := ib.fetchMessage(ctx, core, roomID, eventID)
	if err != nil || message == nil {
		// Counts the attempt, so an event that never decrypts is given up on in the end.
		if journal := ib.Journal(); journal != nil {
			_ = journal.Pending(roomID, eventID, "", ib.now())
		}
		return
	}
	ib.record(message)
}

// Tick runs once a minute: it keeps the journal's coverage current, drops what is past its
// retention, tries again to read events that arrived before their keys did, and refreshes what goes
// stale (mutes, the directory).
func (ib *Inbox) Tick(ctx context.Context) {
	journal := ib.Journal()
	if journal == nil {
		return
	}
	now := ib.now()
	_ = journal.Alive(now)
	_ = journal.Prune(now)
	core, _, err := ib.ready()
	if err != nil {
		return
	}
	if now-ib.cache.mutedAt() > 10*60_000 {
		ib.refreshMuted(ctx)
	}
	due, err := journal.PendingDue(now, 5)
	if err == nil {
		for _, pending := range due {
			ib.readPending(ctx, core, pending.RoomID, pending.EventID)
		}
	}
	if rooms := ib.rooms(); rooms != nil {
		refreshedAt, _ := rooms.RefreshedAt()
		if refreshedAt != nil && now-*refreshedAt > directoryMaxAge.Milliseconds() {
			go func() {
				if _, err := ib.RefreshDirectory(context.WithoutCancel(ctx), 0); err != nil {
					ib.log("warn", "directory refresh failed", map[string]any{"error": err.Error()})
				}
			}()
		}
	}
}

// SyncStale reports whether sync has gone too long without an answer.
func (ib *Inbox) SyncStale() bool {
	if ib.State() != StateReady {
		return false
	}
	ib.syncMu.Lock()
	last := ib.syncStats.lastOKAt
	ib.syncMu.Unlock()
	if last == 0 {
		ib.mu.Lock()
		last = ib.bootedAt
		ib.mu.Unlock()
	}
	return ib.now()-last > syncStale.Milliseconds()
}

func trim(text string, max int) string {
	if len(text) > max {
		return text[:max]
	}
	return text
}

package inbox

import (
	"sync"
	"time"
)

type profile struct {
	name string
	at   int64
}

// caches holds what the inbox remembers between sync and the tools: why an event couldn't be
// decrypted, what the bridges said about sent messages, display names, mutes and direct chats.
type caches struct {
	mu sync.Mutex

	decryptErrors map[string]string
	decryptOrder  []string

	bridge       map[string]bridgeStatus
	bridgeOrder  []string
	bridgeChange chan struct{}

	profiles map[string]profile

	// muted is nil until Leon's push rules have been read.
	muted       map[string]bool
	mutedAtTime int64

	// direct maps a direct chat's room to the other person.
	direct map[string]string

	// backups maps a room to the outbound session whose key is in the key backup.
	backups map[string]string
}

func (c *caches) init() {
	c.decryptErrors = map[string]string{}
	c.bridge = map[string]bridgeStatus{}
	c.bridgeChange = make(chan struct{})
	c.profiles = map[string]profile{}
	c.direct = map[string]string{}
}

func (c *caches) setDecryptError(eventID, message string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, seen := c.decryptErrors[eventID]; !seen {
		c.decryptOrder = append(c.decryptOrder, eventID)
		if len(c.decryptOrder) > 5000 {
			delete(c.decryptErrors, c.decryptOrder[0])
			c.decryptOrder = c.decryptOrder[1:]
		}
	}
	c.decryptErrors[eventID] = message
}

func (c *caches) decryptError(eventID string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	message, ok := c.decryptErrors[eventID]
	return message, ok
}

func (c *caches) decryptErrorsCopy() map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]string, len(c.decryptErrors))
	for key, value := range c.decryptErrors {
		out[key] = value
	}
	return out
}

func (c *caches) decryptErrorCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.decryptErrors)
}

func (c *caches) setBridgeStatus(eventID string, status bridgeStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, seen := c.bridge[eventID]; !seen {
		c.bridgeOrder = append(c.bridgeOrder, eventID)
		if len(c.bridgeOrder) > 500 {
			delete(c.bridge, c.bridgeOrder[0])
			c.bridgeOrder = c.bridgeOrder[1:]
		}
	}
	c.bridge[eventID] = status
	close(c.bridgeChange)
	c.bridgeChange = make(chan struct{})
}

func (c *caches) bridgeStatus(eventID string) (bridgeStatus, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	status, ok := c.bridge[eventID]
	return status, ok
}

// awaitBridgeStatus waits for the bridge's delivery status of a sent event, up to wait.
func (c *caches) awaitBridgeStatus(eventID string, wait time.Duration) (bridgeStatus, bool) {
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		c.mu.Lock()
		status, ok := c.bridge[eventID]
		changed := c.bridgeChange
		c.mu.Unlock()
		if ok {
			return status, true
		}
		select {
		case <-changed:
		case <-deadline.C:
			return c.bridgeStatus(eventID)
		}
	}
}

func (c *caches) mutedAt() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.mutedAtTime
}

// isMuted reports whether Leon muted the room, and whether his mutes are known at all.
func (c *caches) isMuted(roomID string) (muted, known bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.muted[roomID], c.muted != nil
}

// setDirect remembers the account's m.direct list: user ID to the rooms that are direct chats.
func (c *caches) setDirect(content map[string]any) {
	direct := map[string]string{}
	for userID, rooms := range content {
		list, ok := rooms.([]any)
		if !ok {
			continue
		}
		for _, room := range list {
			if roomID, ok := room.(string); ok {
				direct[roomID] = userID
			}
		}
	}
	c.mu.Lock()
	c.direct = direct
	c.mu.Unlock()
}

func (c *caches) isDirect(roomID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.direct[roomID]
	return ok
}

func (c *caches) directUser(roomID string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.direct[roomID]
}

// backedUp reports whether a room's current outbound session key was already uploaded to the key
// backup.
func (c *caches) backedUp(roomID, sessionID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.backups[roomID] == sessionID
}

func (c *caches) setBackedUp(roomID, sessionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.backups == nil {
		c.backups = map[string]string{}
	}
	c.backups[roomID] = sessionID
}

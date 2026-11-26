// Package msg holds a decrypted Matrix message as the rest of the daemon passes it around: what the
// Matrix core produces from an event, and what formatting and the journal read. JSON field names are
// the ones the TypeScript service used.
package msg

// EncryptedFile is the key material of an encrypted attachment (the event's `file` object).
type EncryptedFile struct {
	Hashes FileHashes     `json:"hashes"`
	IV     string         `json:"iv"`
	Key    map[string]any `json:"key"`
	URL    string         `json:"url"`
	V      string         `json:"v"`
}

// FileHashes are the hashes of an encrypted attachment's ciphertext.
type FileHashes struct {
	SHA256 string `json:"sha256"`
}

// Attachment is one file of a message. A nil field is one the event didn't give: an empty filename
// or a size of zero is not the same as none.
type Attachment struct {
	ContentType *string `json:"contentType,omitempty"`
	// ContentURI is the media URI of an unencrypted file.
	ContentURI *string `json:"contentUri,omitempty"`
	// Duration is in milliseconds.
	Duration      *int64         `json:"duration,omitempty"`
	EncryptedFile *EncryptedFile `json:"encryptedFile,omitempty"`
	Filename      *string        `json:"filename,omitempty"`
	Height        *int           `json:"height,omitempty"`
	// Kind is "image", "video", "audio" or "file".
	Kind  string `json:"kind"`
	Size  *int64 `json:"size,omitempty"`
	Width *int   `json:"width,omitempty"`
}

// Sender is who sent a message.
type Sender struct {
	IsMe   bool   `json:"isMe"`
	UserID string `json:"userId"`
}

// Relation is a message's `m.relates_to`.
type Relation struct {
	EventID string `json:"eventId"`
	Type    string `json:"type"`
	Key     string `json:"key,omitempty"`
}

// Message is one decrypted message event. Event IDs that don't apply (Replaces, ReplyTo, ThreadRoot)
// are empty, since a real event ID never is.
type Message struct {
	Attachments []Attachment   `json:"attachments"`
	Content     map[string]any `json:"content"`
	Edited      bool           `json:"edited"`
	Encrypted   bool           `json:"encrypted"`
	EventID     string         `json:"eventId"`
	// HTML is the formatted body; nil when the event has none.
	HTML *string `json:"html,omitempty"`
	// Kind is always "message".
	Kind string `json:"kind"`
	// MessageType is the Matrix message type: m.text, m.notice, m.image…
	MessageType string    `json:"messageType"`
	Relation    *Relation `json:"relation,omitempty"`
	// Replaces is, for an edit, the message it replaces.
	Replaces   string `json:"replaces,omitempty"`
	ReplyTo    string `json:"replyTo,omitempty"`
	RoomID     string `json:"roomId"`
	Sender     Sender `json:"sender"`
	Text       string `json:"text"`
	ThreadRoot string `json:"threadRoot,omitempty"`
	// Timestamp is when it was sent, as the homeserver recorded it (Unix ms); nil when unknown.
	Timestamp *int64 `json:"timestamp,omitempty"`
	// Type is the event type, such as m.room.message.
	Type string `json:"type"`
}

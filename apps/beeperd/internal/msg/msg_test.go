package msg

import (
	"encoding/json"
	"reflect"
	"testing"
)

func ptr[T any](value T) *T { return &value }

// A message under the field names the TypeScript service used, so what it wrote can be read and what
// is absent stays absent.
func TestFieldNames(t *testing.T) {
	const full = `{"attachments":[{"contentType":"image/jpeg","contentUri":"mxc://x/plain","duration":1500,` +
		`"encryptedFile":{"hashes":{"sha256":"abc"},"iv":"iv","key":{"k":"secret"},"url":"mxc://x/file","v":"v2"},` +
		`"filename":"photo.jpg","height":600,"kind":"image","size":9,"width":800}],"content":{"body":"hi"},` +
		`"edited":true,"encrypted":true,"eventId":"$1","html":"<b>hi</b>","kind":"message","messageType":"m.image",` +
		`"relation":{"eventId":"$0","type":"m.annotation","key":"ok"},"replaces":"$old","replyTo":"$0","roomId":"!r:x",` +
		`"sender":{"isMe":true,"userId":"@me:x"},"text":"hi","threadRoot":"$root","timestamp":1795000000000,"type":"m.room.message"}`
	var message Message
	if err := json.Unmarshal([]byte(full), &message); err != nil {
		t.Fatal(err)
	}
	want := Message{
		Attachments: []Attachment{{
			ContentType: ptr("image/jpeg"),
			ContentURI:  ptr("mxc://x/plain"),
			Duration:    ptr(int64(1500)),
			EncryptedFile: &EncryptedFile{
				Hashes: FileHashes{SHA256: "abc"}, IV: "iv", Key: map[string]any{"k": "secret"}, URL: "mxc://x/file", V: "v2",
			},
			Filename: ptr("photo.jpg"),
			Height:   ptr(600),
			Kind:     "image",
			Size:     ptr(int64(9)),
			Width:    ptr(800),
		}},
		Content:     map[string]any{"body": "hi"},
		Edited:      true,
		Encrypted:   true,
		EventID:     "$1",
		HTML:        ptr("<b>hi</b>"),
		Kind:        "message",
		MessageType: "m.image",
		Relation:    &Relation{EventID: "$0", Type: "m.annotation", Key: "ok"},
		Replaces:    "$old",
		ReplyTo:     "$0",
		RoomID:      "!r:x",
		Sender:      Sender{IsMe: true, UserID: "@me:x"},
		Text:        "hi",
		ThreadRoot:  "$root",
		Timestamp:   ptr(int64(1795000000000)),
		Type:        "m.room.message",
	}
	if !reflect.DeepEqual(message, want) {
		t.Fatalf("got %#v, want %#v", message, want)
	}

	bare, err := json.Marshal(Message{Attachments: []Attachment{{Kind: "file"}}, Content: map[string]any{}, Kind: "message"})
	if err != nil {
		t.Fatal(err)
	}
	const wantBare = `{"attachments":[{"kind":"file"}],"content":{},"edited":false,"encrypted":false,"eventId":"","kind":"message",` +
		`"messageType":"","roomId":"","sender":{"isMe":false,"userId":""},"text":"","type":""}`
	if string(bare) != wantBare {
		t.Fatalf("optional fields that are absent are left out: got %s", bare)
	}
}

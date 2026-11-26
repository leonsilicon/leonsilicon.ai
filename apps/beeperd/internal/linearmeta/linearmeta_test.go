package linearmeta

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

type published struct {
	Kind   string
	RoomID string
	Record map[string]any
}

// fakeHost is a daemon whose directory holds a few Slack rooms and which records what is published.
type fakeHost struct {
	home string
	mu   sync.Mutex
	// refreshes counts list_conversations calls that asked for a refresh.
	refreshes int
	writes    []published
	wrote     chan struct{}
}

func (h *fakeHost) Tool(ctx context.Context, name string, args map[string]any) (map[string]any, error) {
	h.mu.Lock()
	if refresh, _ := args["refresh"].(bool); refresh {
		h.refreshes++
	}
	h.mu.Unlock()
	// As the daemon hands results to services: plain JSON values.
	var page map[string]any
	_ = json.Unmarshal([]byte(`{"next_offset":null,"conversations":[
		{"room_id":"!project:x","name":"#proj-zami","is_direct":false,"bridge":{"channel_id":"TWORK-CPROJECT","room_type":"default"}},
		{"room_id":"!issue:x","name":"#leon-12-fix-the-feed","is_direct":false,"bridge":{"channel_id":"CISSUE","network_id":"TWORK"}},
		{"room_id":"!other-team:x","name":"#leon-12","is_direct":false,"bridge":{"channel_id":"TOTHER-CISSUE"}},
		{"room_id":"!dm:x","name":"Sam","is_direct":true,"bridge":{"channel_id":"TWORK-CDM","room_type":"dm"}}]}`), &page)
	return page, nil
}

func (h *fakeHost) record(kind, roomID string, record map[string]any) error {
	h.mu.Lock()
	h.writes = append(h.writes, published{kind, roomID, record})
	h.mu.Unlock()
	select {
	case h.wrote <- struct{}{}:
	default:
	}
	return nil
}

func (h *fakeHost) PublishLinearIssue(ctx context.Context, roomID string, record map[string]any) error {
	return h.record("issue", roomID, record)
}
func (h *fakeHost) PublishProjectAppearance(ctx context.Context, roomID string, record map[string]any) error {
	return h.record("project", roomID, record)
}
func (h *fakeHost) PublishProjectVisibility(ctx context.Context, record map[string]any) error {
	return h.record("visibility", "", record)
}
func (h *fakeHost) Journal() host.Journal                                    { return nil }
func (h *fakeHost) Rooms(context.Context, []string) ([]host.RoomInfo, error) { return nil, nil }
func (h *fakeHost) Connections(context.Context) ([]host.Connection, error)   { return nil, nil }
func (h *fakeHost) SenderNames(context.Context, []string) (map[string]string, error) {
	return nil, nil
}
func (h *fakeHost) Home() string     { return h.home }
func (h *fakeHost) Log() host.Logger { return func(string, string, map[string]any) {} }

func TestWithoutSettingsItStaysIdle(t *testing.T) {
	running, err := Service().Start(context.Background(), &fakeHost{home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer running.Stop()
	if status := running.Status(); status["running"] != false || status["reason"] != "no settings file" {
		t.Fatalf("got %v", status)
	}
}

func TestPublishesIssuesProjectsAndVisibilityToTheMatchingRooms(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "env"), []byte("LINEAR_ISSUE_METADATA_TOKEN=test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshots := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"teamId":"TWORK","closedProjectChannelIds":["CCLOSED"],
			"records":[{"channelId":"CISSUE","identifier":"LEON-12","title":"Fix the feed","state":"Executing"},
			           {"channelId":"CNOROOM","identifier":"LEON-13"}],
			"projectAppearances":[{"channelId":"CPROJECT","color":"#eb5757","icon":"IconBook"},{"channelId":"CNOPROJECT","color":null,"icon":null}]}`))
	}))
	defer snapshots.Close()
	fake := &fakeHost{home: home, wrote: make(chan struct{}, 8)}
	running, err := (&service{snapshotURL: snapshots.URL, client: snapshots.Client(), pollEvery: 20 * time.Millisecond}).Start(context.Background(), fake)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.After(3 * time.Second)
	for running.Status()["lastSuccess"] == nil {
		select {
		case <-deadline:
			t.Fatalf("no successful cycle: %v", running.Status())
		case <-time.After(5 * time.Millisecond):
		}
	}
	// A few more cycles: unchanged records are not written again.
	time.Sleep(100 * time.Millisecond)
	running.Stop()

	fake.mu.Lock()
	defer fake.mu.Unlock()
	byKind := map[string]published{}
	for _, item := range fake.writes {
		if _, seen := byKind[item.Kind]; seen {
			t.Fatalf("%s was written more than once: %v", item.Kind, fake.writes)
		}
		byKind[item.Kind] = item
	}
	if got := byKind["issue"]; got.RoomID != "!issue:x" || got.Record["identifier"] != "LEON-12" || got.Record["state"] != "Executing" {
		t.Fatalf("the issue goes to its own team's channel room: %v", got)
	}
	wantProject := map[string]any{"version": 1, "teamId": "TWORK", "channelId": "CPROJECT", "color": "#eb5757", "icon": "IconBook"}
	gotProject := byKind["project"]
	normalized := map[string]any{}
	data, _ := json.Marshal(gotProject.Record)
	_ = json.Unmarshal(data, &normalized)
	wantNormalized := map[string]any{}
	data, _ = json.Marshal(wantProject)
	_ = json.Unmarshal(data, &wantNormalized)
	if gotProject.RoomID != "!project:x" || !reflect.DeepEqual(normalized, wantNormalized) {
		t.Fatalf("got %v", gotProject)
	}
	if got := byKind["visibility"].Record; got["teamId"] != "TWORK" || !reflect.DeepEqual(got["closedChannelIds"], []string{"CCLOSED"}) {
		t.Fatalf("got %v", got)
	}
	status := running.Status()
	if status["published"] != 1 || status["publishedProjects"] != 1 || status["unmatched"] != 1 || status["unmatchedProjects"] != 1 || status["projectVisibilityPublished"] != true || status["failure"] != nil {
		t.Fatalf("got %v", status)
	}
	if fake.refreshes != 1 {
		t.Fatalf("the room map is read once a minute, not every cycle; got %d", fake.refreshes)
	}
}

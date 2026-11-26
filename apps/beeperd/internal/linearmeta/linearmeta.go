// Package linearmeta publishes Linear issue records and project colors and icons into the Matrix
// rooms of their Slack channels, as room account data, so Leon's own Matrix client can show them.
// It needs no encryption: it only writes account data.
package linearmeta

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/envfile"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

const (
	defaultSnapshotURL = "https://linear-slack.leonsilicon.ai/matrix/issue-metadata"
	pollEvery          = 10 * time.Second
	directoryEvery     = 60 * time.Second
)

var (
	teamPattern      = regexp.MustCompile(`^T[A-Z0-9]+$`)
	channelPattern   = regexp.MustCompile(`^[CG][A-Z0-9]+$`)
	compositePattern = regexp.MustCompile(`^(T[A-Z0-9]+)-([CG][A-Z0-9]+)$`)
)

type slackRoom struct {
	RoomID string
	Name   string
}

type service struct {
	// snapshotURL and client can be replaced in tests.
	snapshotURL string
	client      *http.Client
	pollEvery   time.Duration
}

// Service returns the Linear publisher.
func Service() host.Service {
	return &service{snapshotURL: defaultSnapshotURL, client: &http.Client{Timeout: 15 * time.Second}, pollEvery: pollEvery}
}

func (s *service) Name() string         { return "linear-issue-metadata" }
func (s *service) Server() *host.Server { return nil }

type idle struct{}

func (idle) CallTool(context.Context, string, map[string]any) (map[string]any, error) {
	return nil, errors.New("linear-issue-metadata has no tools")
}
func (idle) Status() map[string]any {
	return map[string]any{"running": false, "reason": "no settings file"}
}
func (idle) Stop() {}

func (s *service) Start(ctx context.Context, h host.Host) (host.Running, error) {
	data, err := os.ReadFile(filepath.Join(h.Home(), "env"))
	if errors.Is(err, os.ErrNotExist) {
		return idle{}, nil
	} else if err != nil {
		return nil, err
	}
	token := strings.TrimSpace(envfile.Parse(string(data))["LINEAR_ISSUE_METADATA_TOKEN"])
	if token == "" {
		return nil, errors.New("Linear issue metadata needs LINEAR_ISSUE_METADATA_TOKEN")
	}
	ctx, cancel := context.WithCancel(ctx)
	publisher := &publisher{
		service: s, host: h, token: token, cancel: cancel, done: make(chan struct{}),
		publishedIssues: map[string]string{}, publishedProjects: map[string]string{},
	}
	go publisher.run(ctx)
	return publisher, nil
}

type publisher struct {
	service *service
	host    host.Host
	token   string
	cancel  context.CancelFunc
	done    chan struct{}

	directory     map[string][]slackRoom
	nextDirectory time.Time

	mu                         sync.Mutex
	publishedIssues            map[string]string
	publishedProjects          map[string]string
	publishedVisibility        string
	projectVisibilityPublished bool
	lastSuccess                string
	failure                    string
	unmatched                  int
	unmatchedProjects          int
}

func (p *publisher) CallTool(context.Context, string, map[string]any) (map[string]any, error) {
	return nil, errors.New("linear-issue-metadata has no tools")
}

func (p *publisher) Status() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	status := map[string]any{
		"running": true, "lastSuccess": nil, "published": len(p.publishedIssues),
		"publishedProjects": len(p.publishedProjects), "projectVisibilityPublished": p.projectVisibilityPublished,
		"unmatched": p.unmatched, "unmatchedProjects": p.unmatchedProjects, "failure": nil,
	}
	if p.lastSuccess != "" {
		status["lastSuccess"] = p.lastSuccess
	}
	if p.failure != "" {
		status["failure"] = p.failure
	}
	return status
}

func (p *publisher) Stop() {
	p.cancel()
	<-p.done
}

func (p *publisher) run(ctx context.Context) {
	defer close(p.done)
	for {
		err := p.publish(ctx)
		if ctx.Err() != nil {
			return
		}
		p.mu.Lock()
		if err != nil {
			p.failure = err.Error()
		} else {
			p.failure = ""
		}
		p.mu.Unlock()
		if err != nil {
			p.host.Log()("warn", "Linear issue snapshot cycle failed", map[string]any{"error": err.Error()})
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(p.service.pollEvery):
		}
	}
}

type snapshot struct {
	TeamID                  string           `json:"teamId"`
	ClosedProjectChannelIDs json.RawMessage  `json:"closedProjectChannelIds"`
	Records                 []map[string]any `json:"records"`
	ProjectAppearances      []struct {
		ChannelID string  `json:"channelId"`
		Color     *string `json:"color"`
		Icon      *string `json:"icon"`
	} `json:"projectAppearances"`
}

// slackRooms maps each Slack channel of the team to its Matrix rooms, from the inbox's directory.
func (p *publisher) slackRooms(ctx context.Context, teamID string) (map[string][]slackRoom, error) {
	byChannel := map[string][]slackRoom{}
	offset := 0
	for {
		page, err := p.host.Tool(ctx, "list_conversations", map[string]any{
			"network": "slack", "limit": 100, "offset": offset, "refresh": offset == 0,
		})
		if err != nil {
			return nil, err
		}
		conversations, _ := page["conversations"].([]any)
		for _, entry := range conversations {
			room, _ := entry.(map[string]any)
			bridge, _ := room["bridge"].(map[string]any)
			channelID := text(bridge["channel_id"])
			roomType := text(bridge["room_type"])
			direct, _ := room["is_direct"].(bool)
			if channelID == "" || direct || roomType == "dm" || roomType == "group_dm" || roomType == "space" {
				continue
			}
			team, channel := text(bridge["network_id"]), channelID
			if parts := compositePattern.FindStringSubmatch(channelID); parts != nil {
				team, channel = parts[1], parts[2]
			}
			if team != teamID || !channelPattern.MatchString(channel) {
				continue
			}
			byChannel[channel] = append(byChannel[channel], slackRoom{RoomID: text(room["room_id"]), Name: text(room["name"])})
		}
		next, ok := page["next_offset"].(float64)
		if !ok || int(next) <= offset {
			return byChannel, nil
		}
		offset = int(next)
	}
}

func text(value any) string {
	typed, _ := value.(string)
	return typed
}

type write struct {
	issue     bool
	roomID    string
	record    map[string]any
	signature string
}

func (p *publisher) publish(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.service.snapshotURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+p.token)
	resp, err := p.service.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("snapshot request: HTTP %d", resp.StatusCode)
	}
	var snap snapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		return errors.New("invalid Linear issue snapshot")
	}
	if !teamPattern.MatchString(snap.TeamID) || snap.Records == nil {
		return errors.New("invalid Linear issue snapshot")
	}
	if !time.Now().Before(p.nextDirectory) {
		directory, err := p.slackRooms(ctx, snap.TeamID)
		if err != nil {
			return err
		}
		p.directory = directory
		p.nextDirectory = time.Now().Add(directoryEvery)
	}

	withoutRoom, projectsWithoutRoom := 0, 0
	var writes []write
	p.mu.Lock()
	for _, record := range snap.Records {
		identifier := strings.ToLower(text(record["identifier"]))
		var rooms []slackRoom
		for _, room := range p.directory[text(record["channelId"])] {
			name := strings.TrimPrefix(strings.ToLower(room.Name), "#")
			if name == identifier || strings.HasPrefix(name, identifier+"-") {
				rooms = append(rooms, room)
			}
		}
		if len(rooms) == 0 {
			withoutRoom++
			continue
		}
		signature := sign(record)
		for _, room := range rooms {
			if p.publishedIssues[room.RoomID] != signature {
				writes = append(writes, write{issue: true, roomID: room.RoomID, record: record, signature: signature})
			}
		}
	}
	for _, appearance := range snap.ProjectAppearances {
		rooms := p.directory[appearance.ChannelID]
		if len(rooms) == 0 {
			projectsWithoutRoom++
			continue
		}
		record := map[string]any{"version": 1, "teamId": snap.TeamID, "channelId": appearance.ChannelID, "color": appearance.Color, "icon": appearance.Icon}
		signature := sign(record)
		for _, room := range rooms {
			if p.publishedProjects[room.RoomID] != signature {
				writes = append(writes, write{roomID: room.RoomID, record: record, signature: signature})
			}
		}
	}
	p.unmatched, p.unmatchedProjects = withoutRoom, projectsWithoutRoom
	p.mu.Unlock()

	failed := 0
	for start := 0; start < len(writes) && ctx.Err() == nil; start += 8 {
		var group sync.WaitGroup
		for _, item := range writes[start:min(start+8, len(writes))] {
			group.Add(1)
			go func() {
				defer group.Done()
				var err error
				kind := "project"
				if item.issue {
					kind = "issue"
					err = p.host.PublishLinearIssue(ctx, item.roomID, item.record)
				} else {
					err = p.host.PublishProjectAppearance(ctx, item.roomID, item.record)
				}
				p.mu.Lock()
				defer p.mu.Unlock()
				if err != nil {
					failed++
					if failed == 1 {
						p.host.Log()("warn", "Linear room account data write failed", map[string]any{"kind": kind, "error": err.Error()})
					}
					return
				}
				if item.issue {
					p.publishedIssues[item.roomID] = item.signature
				} else {
					p.publishedProjects[item.roomID] = item.signature
				}
			}()
		}
		group.Wait()
	}
	if len(snap.ClosedProjectChannelIDs) > 0 && string(snap.ClosedProjectChannelIDs) != "null" && ctx.Err() == nil {
		var closed []string
		if err := json.Unmarshal(snap.ClosedProjectChannelIDs, &closed); err != nil {
			return errors.New("invalid project visibility snapshot")
		}
		for _, id := range closed {
			if !channelPattern.MatchString(id) {
				return errors.New("invalid project visibility snapshot")
			}
		}
		visibility := map[string]any{"version": 1, "teamId": snap.TeamID, "closedChannelIds": closed}
		signature := sign(visibility)
		p.mu.Lock()
		same := p.projectVisibilityPublished && p.publishedVisibility == signature
		p.mu.Unlock()
		if !same {
			if err := p.host.PublishProjectVisibility(ctx, visibility); err != nil {
				return err
			}
			p.mu.Lock()
			p.publishedVisibility, p.projectVisibilityPublished = signature, true
			p.mu.Unlock()
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d room writes failed", failed)
	}
	p.mu.Lock()
	p.lastSuccess = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	p.mu.Unlock()
	return nil
}

// sign is a record's content as text, to tell whether it changed since it was last written.
func sign(record map[string]any) string {
	data, _ := json.Marshal(record)
	return string(data)
}

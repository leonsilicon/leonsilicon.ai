package grokrelay

import (
	"context"
	"testing"
	"time"
)

func TestATaskBotsNewMessageStartsTheNextCycleEarly(t *testing.T) {
	journal := &memoryJournal{}
	bridge := &slackBridge{
		bridgeOptions: bridgeOptions{journal: journal},
		state:         &bridgeState{Routes: map[string]*route{"bot-1": {ChatID: "!task:beeper.local"}}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	run := &running{ctx: ctx, bridge: bridge, cycleEvery: time.Hour, newsDelay: 10 * time.Millisecond, news: make(chan struct{}, 1)}
	paused := make(chan bool, 1)
	go func() { paused <- run.pause() }()

	// Something arrived, but in a chat no task bot is served in: the cycle does not start early.
	journal.add("!someone:beeper.local", "$other", "hello", false)
	run.news <- struct{}{}
	select {
	case <-paused:
		t.Fatal("a message in an unrelated chat started a cycle")
	case <-time.After(50 * time.Millisecond):
	}

	journal.add("!task:beeper.local", "$reply", "done", false)
	run.news <- struct{}{}
	select {
	case more := <-paused:
		if !more {
			t.Fatal("the service is still running, so the pause ends with another cycle")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the task bot's message did not start the next cycle")
	}

	go func() { paused <- run.pause() }()
	cancel()
	if <-paused {
		t.Fatal("a stopped service runs no further cycle")
	}
}

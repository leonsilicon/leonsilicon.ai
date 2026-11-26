package inbox

import "sync"

// coalesced runs an expensive refresh one at a time, shared by everyone who asks while it runs.
//
//   - get(0) is for a caller that needs what the server has now: it gets a run that started after it
//     asked. Requests that arrive while one runs share a single next run.
//   - get(maxAge) is for periodic checks: the last result is reused while its run started less than
//     maxAge ms ago, and a run in progress is joined.
//
// The room directory's full rebuild is a /sync of every room (12-20 s, more when Matrix is slow).
type coalesced struct {
	run func() (refreshResult, error)
	now func() int64

	mu      sync.Mutex
	running *refreshRun
	next    *refreshRun
	last    *refreshResult
	lastAt  int64
}

type refreshResult struct {
	Rooms       int
	RefreshedAt int64
	TookMS      int64
}

type refreshRun struct {
	startedAt int64
	done      chan struct{}
	result    refreshResult
	err       error
}

func newCoalesced(run func() (refreshResult, error), now func() int64) *coalesced {
	return &coalesced{run: run, now: now}
}

func (c *coalesced) get(maxAgeMS int64) (refreshResult, error) {
	c.mu.Lock()
	asked := c.now()
	if maxAgeMS > 0 {
		if c.last != nil && asked-c.lastAt < maxAgeMS {
			result := *c.last
			c.mu.Unlock()
			return result, nil
		}
		if c.running != nil {
			run := c.running
			c.mu.Unlock()
			<-run.done
			return run.result, run.err
		}
	}
	var run *refreshRun
	switch {
	case c.running == nil:
		run = c.start()
	case c.running.startedAt >= asked:
		run = c.running
	default:
		if c.next == nil {
			c.next = &refreshRun{done: make(chan struct{})}
			go c.runAfter(c.running, c.next)
		}
		run = c.next
	}
	c.mu.Unlock()
	<-run.done
	return run.result, run.err
}

// start begins a run. The caller holds c.mu.
func (c *coalesced) start() *refreshRun {
	run := &refreshRun{startedAt: c.now(), done: make(chan struct{})}
	c.running = run
	go c.execute(run)
	return run
}

func (c *coalesced) execute(run *refreshRun) {
	run.result, run.err = c.run()
	c.mu.Lock()
	if run.err == nil {
		result := run.result
		c.last, c.lastAt = &result, run.startedAt
	}
	if c.running == run {
		c.running = nil
	}
	c.mu.Unlock()
	close(run.done)
}

func (c *coalesced) runAfter(current, next *refreshRun) {
	<-current.done
	c.mu.Lock()
	next.startedAt = c.now()
	c.next = nil
	c.running = next
	c.mu.Unlock()
	c.execute(next)
}

// reset forgets the last result (the store it described was closed).
func (c *coalesced) reset() {
	c.mu.Lock()
	c.last = nil
	c.mu.Unlock()
}

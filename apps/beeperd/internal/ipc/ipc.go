// Package ipc is newline-delimited JSON over the daemon's Unix socket (in the owner-only state
// directory). Every MCP adapter and the CLI are clients; the daemon is the only server. Payloads
// are small: files travel as paths on the shared volume, never as bytes.
package ipc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"sync"
	"time"
)

const maxLine = 4 * 1024 * 1024

// Error is a failed call, with a code a client can act on.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// Codes the client itself produces.
const (
	// CodeUnreachable: nothing listens on the socket, so the request never arrived.
	CodeUnreachable = "daemon_unreachable"
	// CodeTimeout: the daemon has the request but didn't answer in time.
	CodeTimeout = "daemon_timeout"
	// CodeClosed: the daemon closed the connection before answering.
	CodeClosed = "daemon_closed"
)

type request struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type reply struct {
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

// Handler answers one request. An *Error is passed to the client as is; any other error becomes
// "internal_error".
type Handler func(ctx context.Context, method string, params json.RawMessage) (any, error)

// Server is the daemon's socket.
type Server struct {
	listener net.Listener
	path     string
	wg       sync.WaitGroup
	cancel   context.CancelFunc
}

// Serve binds the socket and answers until Close. Call it only while holding the owner lock, which
// is what makes removing a stale socket safe. Each request runs in its own goroutine, so a slow
// call never delays a ping.
func Serve(path string, handler Handler, onInternalError func(method string, err error)) (*Server, error) {
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := &Server{listener: listener, path: path, cancel: cancel}
	server.wg.Add(1)
	go func() {
		defer server.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go server.serveConn(ctx, conn, handler, onInternalError)
		}
	}()
	return server, nil
}

func (s *Server) serveConn(ctx context.Context, conn net.Conn, handler Handler, onInternalError func(string, error)) {
	defer conn.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var write sync.Mutex
	var pending sync.WaitGroup
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), maxLine)
	for scanner.Scan() {
		var req request
		if json.Unmarshal(scanner.Bytes(), &req) != nil || req.Method == "" {
			continue
		}
		pending.Add(1)
		go func() {
			defer pending.Done()
			out := reply{ID: req.ID}
			result, err := handler(ctx, req.Method, req.Params)
			if err != nil {
				var coded *Error
				if !errors.As(err, &coded) {
					coded = &Error{Code: "internal_error", Message: err.Error()}
					if onInternalError != nil {
						onInternalError(req.Method, err)
					}
				}
				out.Error = coded
			} else {
				out.OK = true
				out.Result, err = json.Marshal(result)
				if err != nil {
					out.OK = false
					out.Result = nil
					out.Error = &Error{Code: "internal_error", Message: err.Error()}
				}
			}
			data, _ := json.Marshal(out)
			write.Lock()
			defer write.Unlock()
			_, _ = conn.Write(append(data, '\n'))
		}()
	}
	// The client hung up: let its calls see that, and wait for them before closing.
	cancel()
	pending.Wait()
}

// Close stops accepting and removes the socket. Calls in flight are cancelled.
func (s *Server) Close() {
	s.cancel()
	_ = s.listener.Close()
	s.wg.Wait()
	_ = os.Remove(s.path)
}

// Call sends one request on a fresh connection and decodes its result into out (which may be nil).
func Call(ctx context.Context, socket, method string, params any, timeout time.Duration, out any) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		if ctx.Err() != nil {
			// The socket exists but the daemon is too busy to accept.
			return &Error{Code: CodeTimeout, Message: "the beeper-inbox daemon did not accept " + method + " in time"}
		}
		// No socket, or nothing listening on it: either way the request was never sent.
		return &Error{Code: CodeUnreachable, Message: err.Error()}
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	req := request{ID: 1, Method: method}
	if params != nil {
		if req.Params, err = json.Marshal(params); err != nil {
			return err
		}
	}
	data, _ := json.Marshal(req)
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return &Error{Code: "ipc_error", Message: err.Error()}
	}
	reader := bufio.NewReaderSize(conn, 64*1024)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return &Error{Code: CodeTimeout, Message: "the beeper-inbox daemon did not answer " + method + " within " + timeout.String()}
		}
		return &Error{Code: CodeClosed, Message: "the beeper-inbox daemon closed the connection during " + method}
	}
	var answer reply
	if err := json.Unmarshal(line, &answer); err != nil {
		return &Error{Code: "ipc_error", Message: "unreadable answer: " + err.Error()}
	}
	if !answer.OK {
		if answer.Error == nil {
			answer.Error = &Error{Code: "error", Message: "error"}
		}
		return answer.Error
	}
	if out != nil && len(answer.Result) > 0 {
		return json.Unmarshal(answer.Result, out)
	}
	return nil
}

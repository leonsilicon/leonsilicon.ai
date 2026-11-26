// Package mcpserver is the stdio MCP server Hermes starts. It holds no Matrix state: every call goes
// to the daemon, so any number of Hermes processes can run one while the crypto store keeps a single
// writer. It speaks the small part of MCP that tools need.
package mcpserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/ipc"
)

// latestProtocol is offered when the client names no version.
const latestProtocol = "2025-06-18"

// CallFunc runs one tool. A refused call returns an *ipc.Error or a result with "ok": false.
type CallFunc func(ctx context.Context, name string, arguments json.RawMessage) (map[string]any, error)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// Run serves MCP on in and out until in ends. Tool calls run concurrently.
func Run(ctx context.Context, server host.Server, call CallFunc, in io.Reader, out io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var write sync.Mutex
	send := func(response rpcResponse) {
		response.JSONRPC = "2.0"
		data, err := marshal(response, "")
		if err != nil {
			return
		}
		write.Lock()
		defer write.Unlock()
		_, _ = out.Write(append(data, '\n'))
	}
	var pending sync.WaitGroup
	defer pending.Wait()
	reader := bufio.NewReaderSize(in, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var req rpcRequest
			if json.Unmarshal(line, &req) == nil && req.Method != "" {
				// A request without an ID is a notification: nothing is answered.
				if len(req.ID) > 0 {
					pending.Add(1)
					go func() {
						defer pending.Done()
						send(answer(ctx, server, call, req))
					}()
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func answer(ctx context.Context, server host.Server, call CallFunc, req rpcRequest) rpcResponse {
	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		version := params.ProtocolVersion
		if version == "" {
			version = latestProtocol
		}
		return rpcResponse{ID: req.ID, Result: map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": server.Name, "version": server.Version},
			"instructions":    server.Instructions,
		}}
	case "ping":
		return rpcResponse{ID: req.ID, Result: map[string]any{}}
	case "tools/list":
		return rpcResponse{ID: req.ID, Result: map[string]any{"tools": server.Tools}}
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return rpcResponse{ID: req.ID, Error: &rpcError{Code: -32602, Message: "invalid params"}}
		}
		return rpcResponse{ID: req.ID, Result: toolResult(call(ctx, params.Name, params.Arguments))}
	default:
		return rpcResponse{ID: req.ID, Error: &rpcError{Code: -32601, Message: "method not found: " + req.Method}}
	}
}

// toolResult shapes a tool's answer as MCP wants it: the JSON as text Hermes reads, and the same
// object as structured content.
func toolResult(result map[string]any, err error) map[string]any {
	if err != nil {
		code, message, data := "error", err.Error(), any(nil)
		var coded *ipc.Error
		if errors.As(err, &coded) {
			code, message, data = coded.Code, coded.Message, coded.Data
		}
		body := map[string]any{"code": code, "message": message}
		if data != nil {
			body["data"] = data
		}
		text, _ := marshal(map[string]any{"error": body}, " ")
		return map[string]any{
			"isError": true,
			"content": []map[string]any{{"type": "text", "text": string(text)}},
		}
	}
	text, _ := marshal(result, " ")
	out := map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(text)}},
		"structuredContent": result,
	}
	// A service reports a refused call as "ok": false (the Grok relay's budget, for example).
	if ok, isBool := result["ok"].(bool); isBool && !ok {
		out["isError"] = true
	}
	return out
}

// marshal is json.Marshal without HTML escaping: message text with < or & should read as written.
func marshal(value any, indent string) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if indent != "" {
		encoder.SetIndent("", indent)
	}
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

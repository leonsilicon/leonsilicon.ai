package inbox

import (
	"context"
	_ "embed"
	"encoding/json"
	"sort"
	"strings"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// tools.json is the MCP contract: tool names, schemas, descriptions and the server's instructions.
// The descriptions are what Hermes reads, so they say what each tool can't do, and they change only
// when Leon changes a rule.
//
//go:embed tools.json
var toolsJSON []byte

var (
	server  host.Server
	allowed = map[string]map[string]bool{}
)

func init() {
	if err := json.Unmarshal(toolsJSON, &server); err != nil {
		panic("tools.json: " + err.Error())
	}
	server.Version = Version
	for _, tool := range server.Tools {
		var schema struct {
			Properties map[string]json.RawMessage `json:"properties"`
		}
		_ = json.Unmarshal(tool.InputSchema, &schema)
		names := map[string]bool{}
		for name := range schema.Properties {
			names[name] = true
		}
		allowed[tool.Name] = names
	}
}

// Server describes the inbox's own MCP server.
func Server() host.Server { return server }

// Caller says who is running a tool.
type Caller struct {
	// GrokRelay is true only for the Grok relay inside this daemon, which alone may deliver a
	// handoff to a Grok room.
	GrokRelay bool
	// DirectoryMaxAgeMS lets `list_conversations` with `refresh` reuse a directory rebuild that
	// started this recently. Services ask about once a minute each; Hermes's own request is exact.
	DirectoryMaxAgeMS int64
}

// RunTool checks argument names (types are checked where they're used) and runs the tool.
func (ib *Inbox) RunTool(ctx context.Context, name string, args map[string]any, caller Caller) (map[string]any, error) {
	names, known := allowed[name]
	if !known {
		return nil, toolError("unknown_tool", "unknown tool "+name)
	}
	var unknown []string
	for key := range args {
		if !names[key] {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, toolError("bad_argument", "unknown argument(s) for "+name+": "+strings.Join(unknown, ", "))
	}
	if args == nil {
		args = map[string]any{}
	}
	switch name {
	case "list_conversations":
		return ib.ListConversations(ctx, args, caller.DirectoryMaxAgeMS)
	case "get_conversation":
		return ib.GetConversation(ctx, args)
	case "list_messages":
		return ib.ListMessages(ctx, args)
	case "get_message":
		return ib.GetMessage(ctx, args)
	case "download_attachment":
		return ib.DownloadAttachment(ctx, args)
	case "send_message":
		return ib.SendMessage(ctx, args, caller.GrokRelay)
	case "send_file":
		return ib.SendFile(ctx, args)
	case "send_reaction":
		return ib.SendReaction(ctx, args)
	case "inbox_status":
		return ib.Status(ctx), nil
	}
	return nil, toolError("unknown_tool", "unknown tool "+name)
}

package grokrelay

import (
	_ "embed"
	"encoding/json"
	"sync"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

// tools.json is the MCP server as Hermes sees it: its name, version and instructions, and each
// tool's description and schema. The wording carries Leon's rules (how to write as him, what Hermes
// may approve, how to save Grok usage), so it is not retyped here: _gen-tools.ts writes the file
// from the TypeScript source, and it changes only when he changes a rule.
//
//go:embed tools.json
var serverJSON []byte

var describedServer = sync.OnceValue(func() host.Server {
	var described host.Server
	if err := json.Unmarshal(serverJSON, &described); err != nil {
		panic("grokrelay: tools.json is not a server description: " + err.Error())
	}
	return described
})

# @-/com.npmjs.vscode-jsonrpc

Workspace wrapper for `vscode-jsonrpc`, Microsoft's JSON-RPC 2.0 implementation over streams. It is the library VS Code's language servers speak through.

## Usage

```ts
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "@-/com.npmjs.vscode-jsonrpc";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
connection.onRequest("ping", () => "pong");
connection.listen();
```

The exports come from `vscode-jsonrpc/node`, which reads and writes Node streams. The other side can be any JSON-RPC peer that frames messages with `Content-Length` headers, such as pygls in Python.

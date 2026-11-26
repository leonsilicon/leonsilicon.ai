// Package logfile is the daemon's log: one JSON object per line, so it can be searched by field.
// Lines carry IDs, counts and reasons, never message text.
package logfile

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/host"
)

const maxBytes = 5 * 1024 * 1024

// File appends to one log file and keeps a single previous file (".1") when it grows past 5 MB.
type File struct {
	path string
	mu   sync.Mutex
	// Debug includes debug-level lines when true.
	Debug bool
}

// Open returns a log on path. The file is created on the first line.
func Open(path string) *File { return &File{path: path} }

// Logger returns a host.Logger that tags its lines with component.
func (f *File) Logger(component string) host.Logger {
	return func(level, message string, fields map[string]any) {
		if level == "debug" && !f.Debug {
			return
		}
		line := map[string]any{}
		for key, value := range fields {
			if err, ok := value.(error); ok {
				value = err.Error()
			}
			line[key] = value
		}
		line["ts"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		line["level"] = level
		line["component"] = component
		line["pid"] = os.Getpid()
		line["message"] = message
		data, err := json.Marshal(line)
		if err != nil {
			data = []byte(fmt.Sprintf(`{"level":"error","component":%q,"message":"unloggable line"}`, component))
		}
		f.write(append(data, '\n'))
	}
}

// Write lets libraries that log through an io.Writer (zerolog) share the file.
func (f *File) Write(data []byte) (int, error) {
	f.write(data)
	return len(data), nil
}

func (f *File) write(data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if info, err := os.Stat(f.path); err == nil && info.Size() > maxBytes {
		_ = os.Rename(f.path, f.path+".1")
	}
	file, err := os.OpenFile(f.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		_, _ = os.Stderr.Write(data)
		return
	}
	_, _ = file.Write(data)
	_ = file.Close()
}

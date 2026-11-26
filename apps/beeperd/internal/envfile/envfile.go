// Package envfile reads the services' settings files.
package envfile

import "strings"

// Parse reads a settings file of KEY=VALUE lines exactly as Node's util.parseEnv read it for the
// TypeScript feeds, so the files on the server keep their meaning: # starts a comment, "export "
// before a key is dropped, and a value may be in single quotes, backticks or double quotes (where
// \n becomes a line break). An unquoted value ends at a #.
func Parse(text string) map[string]string {
	values := map[string]string{}
	content := trimBlanks(strings.ReplaceAll(text, "\r", ""))
	for content != "" {
		// Skip empty lines and comments.
		if content[0] == '\n' || content[0] == '#' {
			_, content, _ = strings.Cut(content, "\n")
			continue
		}
		// A line without an equals sign is not a setting.
		end := strings.IndexAny(content, "=\n")
		if end < 0 {
			break
		}
		if content[end] == '\n' {
			content = trimBlanks(content[end+1:])
			continue
		}
		key := trimBlanks(content[:end])
		content = content[end+1:]
		if content == "" || content[0] == '\n' {
			values[key] = ""
			continue
		}
		content = trimBlanks(content)
		if key == "" {
			continue
		}
		if strings.HasPrefix(key, "export ") {
			key = trimBlanks(key[len("export "):])
		}
		if content == "" {
			values[key] = ""
			break
		}

		quote := content[0]
		quoted := quote == '\'' || quote == '"' || quote == '`'
		closing := -1
		if quoted {
			closing = strings.IndexByte(content[1:], quote)
		}
		switch {
		case closing >= 0:
			// A quoted value can span lines. Whatever follows the closing quote on its line is dropped.
			value := content[1 : 1+closing]
			if quote == '"' {
				value = strings.ReplaceAll(value, `\n`, "\n")
			}
			values[key] = value
			_, content, _ = strings.Cut(content[closing+2:], "\n")
			continue
		case quoted:
			// Without a closing quote the rest of the line is the value, opening quote included.
			values[key], content, _ = strings.Cut(content, "\n")
		default:
			var line string
			line, content, _ = strings.Cut(content, "\n")
			value, _, _ := strings.Cut(line, "#")
			values[key] = trimBlanks(value)
		}
		content = trimBlanks(content)
	}
	return values
}

// trimBlanks removes the spaces, tabs and line breaks around text.
func trimBlanks(text string) string {
	return strings.Trim(text, " \t\n")
}

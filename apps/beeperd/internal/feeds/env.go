package feeds

import "github.com/leonsilicon/leonsilicon.ai/apps/beeperd/internal/envfile"

// parseEnv reads a feed's settings file as Node's util.parseEnv read it for the TypeScript feeds.
func parseEnv(text string) map[string]string { return envfile.Parse(text) }

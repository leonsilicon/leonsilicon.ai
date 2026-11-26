package feeds

import (
	"regexp"
	"strings"
	"unicode/utf16"
)

// jsSpaces is every character JavaScript's \s and trim() count as white space. Go's \s and
// TrimSpace use other sets, and what the feeds post and screen was defined with JavaScript's.
const jsSpaces = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

var whitespace = regexp.MustCompile("[" + jsSpaces + "]+")

// trim removes white space from both ends, as JavaScript's trim() does.
func trim(text string) string {
	return strings.Trim(text, jsSpaces)
}

// oneLine turns every run of white space into a single space.
func oneLine(text string) string {
	return whitespace.ReplaceAllString(text, " ")
}

// units is the length of text as JavaScript counts it, in UTF-16 code units. The limits on what is
// kept, screened and posted were set in that unit, and Slack counts the same way.
func units(text string) int {
	count := 0
	for _, char := range text {
		count += utf16.RuneLen(char)
	}
	return count
}

// cut keeps the first limit UTF-16 code units of text, as JavaScript's slice(0, limit) does. Half
// a character left at the cut becomes U+FFFD, which is what Slack made of it too.
func cut(text string, limit int) string {
	if units(text) <= limit {
		return text
	}
	return string(utf16.Decode(utf16.Encode([]rune(text))[:max(limit, 0)]))
}

package feeds

import "testing"

func TestCountsCutsAndTrimsTextAsJavaScriptDoes(t *testing.T) {
	// A character outside the basic plane counts as two.
	equal(t, units("a😀界"), 4)
	equal(t, cut("a😀b", 3), "a😀")
	equal(t, cut("abc", 5), "abc")
	equal(t, cut("abc", 0), "")
	// A cut through such a character leaves a replacement character, never broken text.
	equal(t, cut("a😀b", 2), "a\ufffd")

	// JavaScript's white space includes the no-break space, the line separators and the byte order
	// mark, but not the "next line" control character.
	equal(t, trim("\ufeff\u00a0 \tx y\u2028\u3000\n"), "x y")
	equal(t, trim("\u0085x\u0085"), "\u0085x\u0085")
	equal(t, oneLine("a \t\r\n\u00a0\u2003b\u0085c"), "a b\u0085c")
}

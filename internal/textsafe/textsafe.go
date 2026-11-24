// Package textsafe decides which characters may stand in text that people
// read and approve: issue text frozen as criteria, and the pull request
// descriptions builders write.
package textsafe

import "unicode"

// Hidden reports whether a terminal could show r as nothing, or as
// something else: control characters other than newline and tab, format
// characters (direction overrides, zero-width joiners), line and paragraph
// separators, spaces other than the plain space, private-use and unassigned
// code points, variation selectors and the code points that render blank.
func Hidden(r rune) bool {
	switch {
	case r == '\n' || r == '\t' || r == ' ':
		return false
	case unicode.IsControl(r), unicode.In(r, unicode.Cf, unicode.Co, unicode.Zl, unicode.Zp, unicode.Zs, unicode.Variation_Selector):
		return true
	case !unicode.In(r, unicode.L, unicode.M, unicode.N, unicode.P, unicode.S):
		return true // unassigned, surrogate, noncharacter
	}
	switch r {
	case 0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x2800, 0x3164, 0xFFA0, 0x180B, 0x180C, 0x180D, 0x180E, 0x180F,
		0x16FE4, 0x1D159, 0xFFFD:
		return true // grapheme joiner, Hangul, Khmer and Khitan fillers, braille blank, Mongolian selectors, blank notehead, replacement character
	}
	return false
}

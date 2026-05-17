package pkg

// Concat exists to trigger gopls' modernize/stringsbuilder analyzer
// (a Hint diagnostic about building strings via += in a loop).
func Concat(parts []string) string {
	s := ""
	for _, p := range parts {
		s += p
	}
	return s
}

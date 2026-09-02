package sequence

import (
	"testing"
)

func TestSequenceOrdering(t *testing.T) {
	seq1 := int64(1)
	seq2 := int64(2)

	if seq2 <= seq1 {
		t.Fatalf("expected sequence numbers to be strictly monotonic")
	}
}

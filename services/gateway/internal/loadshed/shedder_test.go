package loadshed

import (
	"testing"
)

func TestLoadShedder_NormalState(t *testing.T) {
	ls := New(Options{
		MaxGoroutines: 100000,
		MaxHeapMB:     8192,
	})

	if ls.IsOverloaded() {
		t.Fatal("expected LoadShedder to report not overloaded under generous limits")
	}
	if ls.ShouldShedNonCritical() {
		t.Fatal("expected ShouldShedNonCritical to report false under generous limits")
	}
}

func TestLoadShedder_GoroutineLimitTripped(t *testing.T) {
	// Set threshold to 1 goroutine, which must be tripped because tests run with >1 goroutines
	ls := New(Options{
		MaxGoroutines: 1,
		MaxHeapMB:     8192,
	})

	if !ls.IsOverloaded() {
		t.Fatal("expected LoadShedder to trip when max goroutines is set to 1")
	}
	if !ls.ShouldShedNonCritical() {
		t.Fatal("expected ShouldShedNonCritical to trip when overloaded")
	}
}

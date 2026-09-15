package features

import (
	"testing"
)

func TestFeatureFlags_Defaults(t *testing.T) {
	r := NewRegistry()
	userID := "user-123"

	// All defaults are 100% enabled
	if !r.IsEnabled("device_linking", userID) {
		t.Fatalf("expected device_linking to be enabled by default")
	}
	if !r.IsEnabled("group_calling", userID) {
		t.Fatalf("expected group_calling to be enabled by default")
	}
	if !r.IsEnabled("ai_summary", userID) {
		t.Fatalf("expected ai_summary to be enabled by default")
	}
	if !r.IsEnabled("protobuf_wire", userID) {
		t.Fatalf("expected protobuf_wire to be enabled by default")
	}
	if r.IsEnabled("unknown_feature", userID) {
		t.Fatalf("expected unknown feature to be disabled")
	}
}

func TestFeatureFlags_PercentageRollout(t *testing.T) {
	r := NewRegistry()
	r.SetFlag("canary_feature", FlagConfig{
		Name:       "canary_feature",
		Enabled:    true,
		Percentage: 30, // 30% cohort
	})

	enabledCount := 0
	total := 1000
	for i := 0; i < total; i++ {
		uid := string(rune('a'+(i%26))) + string(rune('0'+(i%10))) + "-user-id"
		if r.IsEnabled("canary_feature", uid) {
			enabledCount++
		}
	}

	// For 1000 pseudo-random users, 30% should yield approximately 250-350 enabled users
	if enabledCount < 200 || enabledCount > 400 {
		t.Fatalf("expected approximately 300 users enabled (+/-100), got %d", enabledCount)
	}
}

func TestFeatureFlags_WhitelistAndBlacklist(t *testing.T) {
	r := NewRegistry()
	r.SetFlag("secret_feature", FlagConfig{
		Name:        "secret_feature",
		Enabled:     true,
		Percentage:  0, // 0% general rollout
		Whitelisted: []string{"vip-user-1", "vip-user-2"},
		Blacklisted: []string{"blocked-user-1"},
	})

	if !r.IsEnabled("secret_feature", "vip-user-1") {
		t.Fatalf("expected whitelisted user to have feature enabled")
	}
	if r.IsEnabled("secret_feature", "regular-user") {
		t.Fatalf("expected regular user to have 0%% rollout feature disabled")
	}

	// Whitelist overrides percentage, but blacklist overrides all
	r.SetFlag("open_feature", FlagConfig{
		Name:        "open_feature",
		Enabled:     true,
		Percentage:  100,
		Blacklisted: []string{"banned-user"},
	})
	if r.IsEnabled("open_feature", "banned-user") {
		t.Fatalf("expected blacklisted user to be disabled despite 100%% rollout")
	}
	if !r.IsEnabled("open_feature", "good-user") {
		t.Fatalf("expected non-blacklisted user to be enabled")
	}
}

package features

import (
	"crypto/sha256"
	"encoding/binary"
	"os"
	"strconv"
	"strings"
	"sync"
)

type FlagConfig struct {
	Name        string   `json:"name"`
	Enabled     bool     `json:"enabled"`
	Percentage  int      `json:"percentage"` // 0 - 100
	Whitelisted []string `json:"whitelisted,omitempty"`
	Blacklisted []string `json:"blacklisted,omitempty"`
}

type Registry struct {
	mu    sync.RWMutex
	flags map[string]FlagConfig
}

var DefaultRegistry = NewRegistry()

func NewRegistry() *Registry {
	r := &Registry{
		flags: make(map[string]FlagConfig),
	}
	r.initDefaults()
	return r
}

func (r *Registry) initDefaults() {
	r.flags["device_linking"] = FlagConfig{
		Name:       "device_linking",
		Enabled:    getEnvBool("FEATURE_DEVICE_LINKING_ENABLED", true),
		Percentage: getEnvInt("FEATURE_DEVICE_LINKING_PERCENTAGE", 100),
	}
	r.flags["group_calling"] = FlagConfig{
		Name:       "group_calling",
		Enabled:    getEnvBool("FEATURE_GROUP_CALLING_ENABLED", true),
		Percentage: getEnvInt("FEATURE_GROUP_CALLING_PERCENTAGE", 100),
	}
	r.flags["ai_summary"] = FlagConfig{
		Name:       "ai_summary",
		Enabled:    getEnvBool("FEATURE_AI_SUMMARY_ENABLED", true),
		Percentage: getEnvInt("FEATURE_AI_SUMMARY_PERCENTAGE", 100),
	}
	r.flags["protobuf_wire"] = FlagConfig{
		Name:       "protobuf_wire",
		Enabled:    getEnvBool("FEATURE_PROTOBUF_WIRE_ENABLED", true),
		Percentage: getEnvInt("FEATURE_PROTOBUF_WIRE_PERCENTAGE", 100),
	}
}

func (r *Registry) SetFlag(name string, cfg FlagConfig) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.flags[name] = cfg
}

func (r *Registry) IsEnabled(flagName string, userID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	flag, ok := r.flags[flagName]
	if !ok || !flag.Enabled {
		return false
	}

	for _, b := range flag.Blacklisted {
		if strings.EqualFold(b, userID) {
			return false
		}
	}
	for _, w := range flag.Whitelisted {
		if strings.EqualFold(w, userID) {
			return true
		}
	}

	if flag.Percentage >= 100 {
		return true
	}
	if flag.Percentage <= 0 {
		return false
	}

	if userID == "" {
		return false
	}

	// Deterministic cohort hashing: sha256(flagName + ":" + userID) % 100 < percentage
	h := sha256.Sum256([]byte(flagName + ":" + userID))
	bucket := int(binary.BigEndian.Uint32(h[:4]) % 100)
	return bucket < flag.Percentage
}

func (r *Registry) GetAllFlagsForUser(userID string) map[string]bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	res := make(map[string]bool)
	for name := range r.flags {
		res[name] = r.IsEnabled(name, userID)
	}
	return res
}

func getEnvBool(key string, fallback bool) bool {
	if val := os.Getenv(key); val != "" {
		if b, err := strconv.ParseBool(val); err == nil {
			return b
		}
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if val := os.Getenv(key); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			return n
		}
	}
	return fallback
}

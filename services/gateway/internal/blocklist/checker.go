package blocklist

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type Checker interface {
	IsBlocked(ctx context.Context, blockerID, blockedID string) bool
}

type HTTPBlockChecker struct {
	authURL    string
	httpClient *http.Client
	mu         sync.RWMutex
	cache      map[string]cacheEntry
}

type cacheEntry struct {
	blocked   bool
	expiresAt time.Time
}

func NewHTTPBlockChecker(authURL string) *HTTPBlockChecker {
	return &HTTPBlockChecker{
		authURL: authURL,
		httpClient: &http.Client{
			Timeout: 2 * time.Second,
		},
		cache: make(map[string]cacheEntry),
	}
}

func (c *HTTPBlockChecker) IsBlocked(ctx context.Context, blockerID, blockedID string) bool {
	if blockerID == "" || blockedID == "" || blockerID == blockedID {
		return false
	}

	key := blockerID + ":" + blockedID

	c.mu.RLock()
	if entry, found := c.cache[key]; found && time.Now().Before(entry.expiresAt) {
		c.mu.RUnlock()
		return entry.blocked
	}
	c.mu.RUnlock()

	reqURL := fmt.Sprintf("%s/users/is-blocked?blocker_id=%s&blocked_id=%s",
		c.authURL, url.QueryEscape(blockerID), url.QueryEscape(blockedID))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return false
	}

	resp, err := c.httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		return false
	}
	defer resp.Body.Close()

	var result struct {
		Blocked bool `json:"blocked"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false
	}

	c.mu.Lock()
	c.cache[key] = cacheEntry{
		blocked:   result.Blocked,
		expiresAt: time.Now().Add(10 * time.Second),
	}
	c.mu.Unlock()

	return result.Blocked
}

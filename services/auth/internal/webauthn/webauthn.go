package webauthn

import (
	"fmt"
	"strings"

	"github.com/go-webauthn/webauthn/webauthn"
)

// Config wraps the WebAuthn instance.
type Config struct {
	WebAuthn *webauthn.WebAuthn
}

// NewConfig creates a new WebAuthn configuration.
func NewConfig(rpID, rpOrigin, rpName string) *Config {
	origins := []string{
		"http://localhost:3000",
		"http://localhost:5173",
		"http://127.0.0.1:3000",
		"http://127.0.0.1:5173",
	}
	for _, o := range strings.Split(rpOrigin, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			origins = append(origins, o)
		}
	}

	wconfig := &webauthn.Config{
		RPDisplayName: rpName,
		RPID:          rpID,
		RPOrigins:     origins,
	}

	w, err := webauthn.New(wconfig)
	if err != nil {
		panic(fmt.Sprintf("failed to create webauthn: %v", err))
	}

	return &Config{WebAuthn: w}
}

// User implements the webauthn.User interface for registration/login ceremonies.
type User struct {
	ID          []byte
	Name        string
	DisplayName string
	Credentials []webauthn.Credential
}

func (u *User) WebAuthnID() []byte                         { return u.ID }
func (u *User) WebAuthnName() string                       { return u.Name }
func (u *User) WebAuthnDisplayName() string                { return u.DisplayName }
func (u *User) WebAuthnCredentials() []webauthn.Credential { return u.Credentials }

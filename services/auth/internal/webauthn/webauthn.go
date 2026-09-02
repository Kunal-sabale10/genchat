package webauthn

import (
	"fmt"

	"github.com/go-webauthn/webauthn/webauthn"
)

// Config wraps the WebAuthn instance.
type Config struct {
	WebAuthn *webauthn.WebAuthn
}

// NewConfig creates a new WebAuthn configuration.
func NewConfig(rpID, rpOrigin, rpName string) *Config {
	wconfig := &webauthn.Config{
		RPDisplayName: rpName,
		RPID:          rpID,
		RPOrigins:     []string{rpOrigin},
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

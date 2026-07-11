package passkit

import (
	"testing"

	"github.com/stek29/loungekey-pkpass/internal/loungekey"
)

func TestPasswordTokenRoundTrip(t *testing.T) {
	password := "p@ss:/+ word"
	got, err := DecodePasswordToken(PasswordToken(password))
	if err != nil {
		t.Fatal(err)
	}
	if got != password {
		t.Fatalf("got %q, want %q", got, password)
	}
}

func TestDecodePasswordTokenRejectsInvalidInput(t *testing.T) {
	if _, err := DecodePasswordToken("***"); err == nil {
		t.Fatal("expected error")
	}
}

func TestDefaultMetadataUsesProjectNamespace(t *testing.T) {
	pass, err := makePass(loungekey.Account{
		Name: "Example", LoungeNumber: "123", CardLast4: "1234",
		Expiration: "2030-01-01", DateAdded: "2025-01-01", QRMessage: "data",
	}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := pass["passTypeIdentifier"]; got != DefaultPassTypeIdentifier {
		t.Fatalf("passTypeIdentifier = %q", got)
	}
	if got := pass["organizationName"]; got != DefaultOrganizationName {
		t.Fatalf("organizationName = %q", got)
	}
}

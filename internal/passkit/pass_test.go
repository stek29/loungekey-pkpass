package passkit

import (
	"os"
	"path/filepath"
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

func TestCopyAssetsOmitsStripImages(t *testing.T) {
	source := t.TempDir()
	destination := t.TempDir()
	for _, name := range []string{"logo.png", "strip.png", "strip@2x.png"} {
		if err := os.WriteFile(filepath.Join(source, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := copyAssets(source, destination); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(destination, "logo.png")); err != nil {
		t.Fatalf("logo asset was not copied: %v", err)
	}
	for _, name := range []string{"strip.png", "strip@2x.png"} {
		if _, err := os.Stat(filepath.Join(destination, name)); !os.IsNotExist(err) {
			t.Errorf("%s was copied", name)
		}
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

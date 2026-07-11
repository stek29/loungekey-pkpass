package passkit

import "testing"

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

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPassForm(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://passes.example.com/", nil)
	response := httptest.NewRecorder()
	(&refreshHandler{}).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	body := response.Body.String()
	for _, expected := range []string{`method="post"`, `action="/generate"`, `name="username"`, `name="password"`} {
		if !strings.Contains(body, expected) {
			t.Errorf("response does not contain %q", expected)
		}
	}
	if strings.Contains(strings.ToLower(body), "<script") {
		t.Error("form must not contain JavaScript")
	}
}

func TestRequestOrigin(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://internal:8080/", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-Host", "passes.example.com")
	if got := requestOrigin(request); got != "https://passes.example.com" {
		t.Fatalf("origin = %q", got)
	}
}

func TestGenerateRequiresPost(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://passes.example.com/generate", nil)
	response := httptest.NewRecorder()
	(&refreshHandler{}).ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", response.Code)
	}
}

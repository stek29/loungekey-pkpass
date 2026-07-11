package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/stek29/loungekey-pkpass/internal/loungekey"
	"github.com/stek29/loungekey-pkpass/internal/passkit"
)

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "generate":
		err = generate(os.Args[2:])
	case "serve":
		err = serve(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		log.Fatal(err)
	}
}

func usage() { fmt.Fprintln(os.Stderr, "usage: loungekey-pass <generate|serve> [options]"); os.Exit(2) }

func generate(arguments []string) error {
	flags := flag.NewFlagSet("generate", flag.ContinueOnError)
	envFile := flags.String("env-file", "account1.env", "LoungeKey credentials file")
	manual := flags.Bool("manual", false, "use fields instead of fetching LoungeKey")
	name := flags.String("name", "", "member name")
	loungeNumber := flags.String("lounge-number", "", "Lounge Access Number")
	cardLast4 := flags.String("card-last4", "", "last four card digits")
	expiration := flags.String("expiration", "", "expiration date (YYYY-MM-DD)")
	dateAdded := flags.String("date-added", "", "date added (YYYY-MM-DD)")
	qrMessage := flags.String("qr-message", "", "QR payload")
	assets := flags.String("assets", "", "custom asset directory")
	webServiceURL := flags.String("web-service-url", "", "public refresh server URL")
	output := flags.String("output", "", "output .pkpass path")
	flags.StringVar(output, "o", "", "output .pkpass path")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if *output == "" {
		return errors.New("--output is required")
	}

	account := loungekey.Account{
		Name:         *name,
		LoungeNumber: *loungeNumber,
		CardLast4:    *cardLast4,
		Expiration:   *expiration,
		DateAdded:    *dateAdded,
		QRMessage:    *qrMessage,
	}
	var username, password string
	if *manual {
		if *webServiceURL != "" {
			return errors.New("--web-service-url requires automatic mode")
		}
		if account.Name == "" || account.LoungeNumber == "" || account.CardLast4 == "" || account.Expiration == "" || account.DateAdded == "" || account.QRMessage == "" {
			return errors.New("all account fields are required in manual mode")
		}
	} else {
		credentials, err := readEnv(*envFile)
		if err != nil {
			return err
		}
		username, password = credentials["LOUNGEKEY_LOGIN"], credentials["LOUNGEKEY_PASSWORD"]
		if username == "" || password == "" {
			return errors.New("LOUNGEKEY_LOGIN and LOUNGEKEY_PASSWORD are required")
		}
		client, err := loungekey.NewClient(30 * time.Second)
		if err != nil {
			return err
		}
		fetched, err := client.Fetch(context.Background(), username, password)
		if err != nil {
			return err
		}
		account = mergeOverrides(fetched, account)
	}
	options := passkit.Options{}
	if *webServiceURL != "" {
		options = passkit.Options{SerialNumber: username, WebServiceURL: *webServiceURL, AuthenticationToken: passkit.PasswordToken(password)}
	}
	if err := passkit.Build(account, options, *output, *assets); err != nil {
		return err
	}
	fmt.Printf("Created: %s\n", *output)
	return nil
}

func serve(arguments []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	host := flags.String("host", "127.0.0.1", "listen address")
	port := flags.Int("port", 8080, "listen port")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	handler := &refreshHandler{publicURL: strings.TrimRight(os.Getenv("PASS_SERVER_URL"), "/")}
	server := &http.Server{Addr: fmt.Sprintf("%s:%d", *host, *port), Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("Listening on http://%s", server.Addr)
	return server.ListenAndServe()
}

type refreshHandler struct{ publicURL string }

func (h *refreshHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/healthz" {
		writeJSONResponse(w, http.StatusOK, `{"status":"ok"}`)
		return
	}
	prefix := "/v1/passes/" + passkit.PassTypeIdentifier + "/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		writeJSONResponse(w, http.StatusNotFound, `{"error":"not found"}`)
		return
	}
	username, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, prefix))
	if err != nil || username == "" || strings.Contains(username, "/") || len(username) > 256 {
		writeJSONResponse(w, http.StatusBadRequest, `{"error":"invalid username"}`)
		return
	}
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "ApplePass") || token == "" {
		writeJSONResponse(w, http.StatusUnauthorized, `{"error":"missing ApplePass authorization"}`)
		return
	}
	password, err := passkit.DecodePasswordToken(token)
	if err != nil {
		writeJSONResponse(w, http.StatusUnauthorized, `{"error":"invalid ApplePass authorization"}`)
		return
	}
	client, err := loungekey.NewClient(30 * time.Second)
	if err != nil {
		writeJSONResponse(w, http.StatusBadGateway, `{"error":"could not refresh pass from LoungeKey"}`)
		return
	}
	account, err := client.Fetch(r.Context(), username, password)
	if err != nil {
		log.Printf("refresh failed for %q: %v", username, err)
		writeJSONResponse(w, http.StatusBadGateway, `{"error":"could not refresh pass from LoungeKey"}`)
		return
	}
	temp, err := os.CreateTemp("", "loungekey-*.pkpass")
	if err != nil {
		writeJSONResponse(w, 500, `{"error":"could not build pass"}`)
		return
	}
	path := temp.Name()
	temp.Close()
	defer os.Remove(path)
	baseURL := h.publicURL
	if baseURL == "" {
		protocol := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
		if protocol == "" {
			protocol = "http"
		}
		host := r.Header.Get("X-Forwarded-Host")
		if host == "" {
			host = r.Host
		}
		baseURL = protocol + "://" + host
	}
	if err := passkit.Build(account, passkit.Options{SerialNumber: username, WebServiceURL: baseURL, AuthenticationToken: passkit.PasswordToken(password)}, path, ""); err != nil {
		log.Printf("build pass: %v", err)
		writeJSONResponse(w, 500, `{"error":"could not build pass"}`)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.pkpass")
	w.Header().Set("Content-Disposition", `attachment; filename="loungekey.pkpass"`)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, path)
}
func writeJSONResponse(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func readEnv(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read credentials: %w", err)
	}
	values := map[string]string{}
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
		}
	}
	return values, nil
}
func mergeOverrides(value, override loungekey.Account) loungekey.Account {
	if override.Name != "" {
		value.Name = override.Name
	}
	if override.LoungeNumber != "" {
		value.LoungeNumber = override.LoungeNumber
	}
	if override.CardLast4 != "" {
		value.CardLast4 = override.CardLast4
	}
	if override.Expiration != "" {
		value.Expiration = override.Expiration
	}
	if override.DateAdded != "" {
		value.DateAdded = override.DateAdded
	}
	if override.QRMessage != "" {
		value.QRMessage = override.QRMessage
	}
	return value
}

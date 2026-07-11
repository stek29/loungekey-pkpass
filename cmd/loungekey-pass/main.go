package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"html/template"
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
	handler := &refreshHandler{}
	server := &http.Server{Addr: fmt.Sprintf("%s:%d", *host, *port), Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("Listening on http://%s", server.Addr)
	return server.ListenAndServe()
}

type refreshHandler struct{}

func (h *refreshHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/" && r.Method == http.MethodGet:
		h.serveForm(w, http.StatusOK, "", "")
	case r.URL.Path == "/generate":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSONResponse(w, http.StatusMethodNotAllowed, `{"error":"method not allowed"}`)
			return
		}
		h.generatePass(w, r)
	case r.URL.Path == "/healthz" && r.Method == http.MethodGet:
		writeJSONResponse(w, http.StatusOK, `{"status":"ok"}`)
	case r.Method == http.MethodGet:
		h.refreshPass(w, r)
	default:
		w.Header().Set("Allow", allowedMethods(r.URL.Path))
		writeJSONResponse(w, http.StatusMethodNotAllowed, `{"error":"method not allowed"}`)
	}
}

func (h *refreshHandler) refreshPass(w http.ResponseWriter, r *http.Request) {
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
	if err := passkit.Build(account, passkit.Options{SerialNumber: username, WebServiceURL: requestOrigin(r), AuthenticationToken: passkit.PasswordToken(password)}, path, ""); err != nil {
		log.Printf("build pass: %v", err)
		writeJSONResponse(w, 500, `{"error":"could not build pass"}`)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.pkpass")
	w.Header().Set("Content-Disposition", `attachment; filename="loungekey.pkpass"`)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, path)
}

func (h *refreshHandler) generatePass(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		h.serveForm(w, http.StatusBadRequest, "Invalid form submission.", "")
		return
	}
	username := strings.TrimSpace(r.PostFormValue("username"))
	password := r.PostFormValue("password")
	if username == "" || password == "" || len(username) > 256 || len(password) > 1024 {
		h.serveForm(w, http.StatusBadRequest, "Username and password are required.", username)
		return
	}
	client, err := loungekey.NewClient(30 * time.Second)
	if err != nil {
		h.serveForm(w, http.StatusInternalServerError, "Could not generate the pass.", username)
		return
	}
	account, err := client.Fetch(r.Context(), username, password)
	if err != nil {
		log.Printf("initial generation failed for %q: %v", username, err)
		h.serveForm(w, http.StatusBadGateway, "Could not log in to LoungeKey.", username)
		return
	}
	temp, err := os.CreateTemp("", "loungekey-*.pkpass")
	if err != nil {
		h.serveForm(w, http.StatusInternalServerError, "Could not generate the pass.", username)
		return
	}
	path := temp.Name()
	if err := temp.Close(); err != nil {
		os.Remove(path)
		h.serveForm(w, http.StatusInternalServerError, "Could not generate the pass.", username)
		return
	}
	defer os.Remove(path)
	options := passkit.Options{SerialNumber: username, WebServiceURL: requestOrigin(r), AuthenticationToken: passkit.PasswordToken(password)}
	if err := passkit.Build(account, options, path, ""); err != nil {
		log.Printf("build initial pass: %v", err)
		h.serveForm(w, http.StatusInternalServerError, "Could not generate the pass.", username)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		h.serveForm(w, http.StatusInternalServerError, "Could not generate the pass.", username)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		h.serveForm(w, http.StatusInternalServerError, "Could not generate the pass.", username)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.pkpass")
	w.Header().Set("Content-Disposition", `attachment; filename="loungekey.pkpass"`)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "loungekey.pkpass", info.ModTime(), file)
}

func (h *refreshHandler) serveForm(w http.ResponseWriter, status int, message, username string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := passForm.Execute(w, struct{ Message, Username string }{message, username}); err != nil {
		log.Printf("render form: %v", err)
	}
}

func requestOrigin(r *http.Request) string {
	scheme := firstHeaderValue(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := firstHeaderValue(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	return scheme + "://" + host
}

func firstHeaderValue(value string) string { return strings.TrimSpace(strings.Split(value, ",")[0]) }
func allowedMethods(path string) string {
	if path == "/generate" {
		return http.MethodPost
	}
	return http.MethodGet
}

var passForm = template.Must(template.New("pass-form").Parse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LoungeKey Pass</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f5f4; color: #24342d; }
    main { width: min(24rem, calc(100% - 3rem)); padding: 2rem; border-radius: 1rem; background: white; box-shadow: 0 .5rem 2rem #1735261a; }
    h1 { margin: 0 0 .5rem; font-size: 1.6rem; }
    p { margin: 0 0 1.5rem; color: #526159; }
    .error { color: #a12622; }
    label { display: block; margin-top: 1rem; font-weight: 600; }
    input { box-sizing: border-box; width: 100%; margin-top: .4rem; padding: .75rem; border: 1px solid #aab5af; border-radius: .5rem; font: inherit; background: white; color: #24342d; }
    button { width: 100%; margin-top: 1.5rem; padding: .8rem; border: 0; border-radius: .5rem; background: #009245; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    @media (prefers-color-scheme: dark) { body { background: #14201a; color: #edf5f0; } main { background: #202e27; } p { color: #b7c5bd; } input { background: #14201a; color: #edf5f0; } }
  </style>
</head>
<body>
  <main>
    <h1>LoungeKey Pass</h1>
    <p>Sign in to generate an updateable wallet pass.</p>
    {{if .Message}}<p class="error" role="alert">{{.Message}}</p>{{end}}
    <form method="post" action="/generate">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" value="{{.Username}}" autocomplete="username" required maxlength="256">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
      <button type="submit">Generate pass</button>
    </form>
  </main>
</body>
</html>`))

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

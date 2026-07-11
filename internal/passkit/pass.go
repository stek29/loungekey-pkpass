package passkit

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/stek29/loungekey-pkpass/internal/loungekey"
)

const (
	DefaultPassTypeIdentifier = "pass.rocks.stek29.lounge-access"
	DefaultTeamIdentifier     = "XXXXXXXXXX"
	DefaultOrganizationName   = "stek29"
	DefaultDescription        = "Lounge Access Pass"
)

type Metadata struct {
	PassTypeIdentifier string
	TeamIdentifier     string
	OrganizationName   string
	Description        string
}

func DefaultMetadata() Metadata {
	return Metadata{
		PassTypeIdentifier: DefaultPassTypeIdentifier,
		TeamIdentifier:     DefaultTeamIdentifier,
		OrganizationName:   DefaultOrganizationName,
		Description:        DefaultDescription,
	}
}

type Options struct {
	SerialNumber, WebServiceURL, AuthenticationToken string
	Metadata                                         Metadata
}

func PasswordToken(password string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(password))
}
func DecodePasswordToken(token string) (string, error) {
	value, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(value) == 0 {
		return "", errors.New("invalid password token")
	}
	return string(value), nil
}

func Build(account loungekey.Account, options Options, output, assetsDir string) error {
	pass, err := makePass(account, options)
	if err != nil {
		return err
	}
	temp, err := os.MkdirTemp("", "loungekey-pass-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	if err := writeJSON(filepath.Join(temp, "pass.json"), pass); err != nil {
		return err
	}
	if assetsDir != "" {
		if err := copyAssets(assetsDir, temp); err != nil {
			return err
		}
	} else if err := createAssets(temp); err != nil {
		return err
	}
	manifest, err := manifest(temp)
	if err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(temp, "manifest.json"), manifest); err != nil {
		return err
	}
	return createArchive(temp, output)
}

func makePass(a loungekey.Account, o Options) (map[string]any, error) {
	metadata := o.Metadata
	defaults := DefaultMetadata()
	if metadata.PassTypeIdentifier == "" {
		metadata.PassTypeIdentifier = defaults.PassTypeIdentifier
	}
	if metadata.TeamIdentifier == "" {
		metadata.TeamIdentifier = defaults.TeamIdentifier
	}
	if metadata.OrganizationName == "" {
		metadata.OrganizationName = defaults.OrganizationName
	}
	if metadata.Description == "" {
		metadata.Description = defaults.Description
	}
	if len(a.CardLast4) != 4 {
		return nil, errors.New("card-last4 must be exactly 4 digits")
	}
	for _, r := range a.CardLast4 {
		if r < '0' || r > '9' {
			return nil, errors.New("card-last4 must be exactly 4 digits")
		}
	}
	dateField := func(key, label, value string) (map[string]any, error) {
		date, err := time.Parse(time.DateOnly, value)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", key, err)
		}
		return map[string]any{"key": key, "label": label, "value": date.Format("2006-01-02T00:00:00Z"), "dateStyle": "PKDateStyleMedium", "timeStyle": "PKDateStyleNone", "textAlignment": "PKTextAlignmentCenter", "ignoresTimeZone": true}, nil
	}
	expiration, err := dateField("expiration", "Card Expiration Date", a.Expiration)
	if err != nil {
		return nil, err
	}
	added, err := dateField("dateAdded", "Date Card Added", a.DateAdded)
	if err != nil {
		return nil, err
	}
	serial := o.SerialNumber
	if serial == "" {
		serial = a.LoungeNumber
	}
	p := map[string]any{
		"description": metadata.Description, "formatVersion": 1, "organizationName": metadata.OrganizationName,
		"passTypeIdentifier": metadata.PassTypeIdentifier, "serialNumber": serial, "teamIdentifier": metadata.TeamIdentifier,
		"foregroundColor": "rgb(52, 73, 94)", "backgroundColor": "rgb(255, 255, 255)", "labelColor": "rgb(52, 73, 94)", "logoText": "",
		"barcode": map[string]any{"message": a.QRMessage, "format": "PKBarcodeFormatQR", "messageEncoding": "iso-8859-1"},
		"generic": map[string]any{
			"headerFields":    []any{map[string]any{"key": "cardOnFile", "label": "Card on File", "value": "•" + a.CardLast4}},
			"primaryFields":   []any{map[string]any{"key": "memberName", "label": "Member", "value": a.Name, "textAlignment": "PKTextAlignmentCenter"}},
			"secondaryFields": []any{map[string]any{"key": "loungeNumber", "label": "Lounge Access Number", "value": a.LoungeNumber, "textAlignment": "PKTextAlignmentCenter"}, expiration, added},
		},
	}
	if o.WebServiceURL != "" {
		if o.AuthenticationToken == "" {
			return nil, errors.New("authentication token is required with web service URL")
		}
		p["webServiceURL"] = strings.TrimRight(o.WebServiceURL, "/")
		p["authenticationToken"] = o.AuthenticationToken
	}
	return p, nil
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}
func copyAssets(source, destination string) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || e.Name() == "strip.png" || e.Name() == "strip@2x.png" {
			continue
		}
		in, err := os.Open(filepath.Join(source, e.Name()))
		if err != nil {
			return err
		}
		out, err := os.Create(filepath.Join(destination, e.Name()))
		if err != nil {
			in.Close()
			return err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		in.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
func createAssets(dir string) error {
	transparent := color.NRGBA{0, 0, 0, 0}
	for name, spec := range map[string]struct {
		w, h int
		c    color.Color
	}{"icon.png": {58, 58, transparent}, "icon@2x.png": {116, 116, transparent}} {
		if err := writePNG(filepath.Join(dir, name), spec.w, spec.h, spec.c); err != nil {
			return err
		}
	}
	for name, size := range map[string]image.Point{
		"logo.png":    {X: 160, Y: 58},
		"logo@2x.png": {X: 320, Y: 116},
	} {
		if err := writePNG(filepath.Join(dir, name), size.X, size.Y, transparent); err != nil {
			return err
		}
	}
	return nil
}
func writePNG(path string, w, h int, c color.Color) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	return png.Encode(f, img)
}
func manifest(dir string) (map[string]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	result := map[string]string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		result[e.Name()] = hex.EncodeToString(sum[:])
	}
	return result, nil
}
func createArchive(dir, output string) error {
	f, err := os.Create(output)
	if err != nil {
		return err
	}
	archive := zip.NewWriter(f)
	entries, err := os.ReadDir(dir)
	if err != nil {
		f.Close()
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		w, err := archive.Create(e.Name())
		if err != nil {
			return err
		}
		in, err := os.Open(filepath.Join(dir, e.Name()))
		if err != nil {
			return err
		}
		_, err = io.Copy(w, in)
		in.Close()
		if err != nil {
			return err
		}
	}
	if err := archive.Close(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

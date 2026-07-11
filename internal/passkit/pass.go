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

const PassTypeIdentifier = "pass.com.loungekey.membership"

type Options struct{ SerialNumber, WebServiceURL, AuthenticationToken string }

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
		"description": "LoungeKey Membership", "formatVersion": 1, "organizationName": "LoungeKey",
		"passTypeIdentifier": PassTypeIdentifier, "serialNumber": serial, "teamIdentifier": "XXXXXXXXXX",
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
		if e.IsDir() {
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
	green := color.NRGBA{0, 146, 69, 255}
	for name, spec := range map[string]struct {
		w, h int
		c    color.Color
	}{"icon.png": {58, 58, transparent}, "icon@2x.png": {116, 116, transparent}, "strip.png": {375, 3, green}, "strip@2x.png": {750, 6, green}} {
		if err := writePNG(filepath.Join(dir, name), spec.w, spec.h, spec.c); err != nil {
			return err
		}
	}
	for _, name := range []string{"logo.png", "logo@2x.png"} {
		source := "default_" + name
		if _, err := os.Stat(source); err == nil {
			if err := copyFile(source, filepath.Join(dir, name)); err != nil {
				return err
			}
		} else {
			size := 160
			height := 58
			if strings.Contains(name, "@2x") {
				size = 320
				height = 116
			}
			if err := writePNG(filepath.Join(dir, name), size, height, transparent); err != nil {
				return err
			}
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
func copyFile(source, destination string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(destination)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
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

package loungekey

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/makiuchi-d/gozxing"
	"github.com/makiuchi-d/gozxing/qrcode"
)

const (
	loginURL    = "https://www.loungekey.com/en/login"
	loginAPIURL = "https://www.loungekey.com/api/loungekey/lkaccount/login?sc_site=loungekey"
)

type Account struct {
	Name         string
	LoungeNumber string
	CardLast4    string
	Expiration   string
	DateAdded    string
	QRMessage    string
}

type Client struct {
	http *http.Client
}

func NewClient(timeout time.Duration) (*Client, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, fmt.Errorf("create cookie jar: %w", err)
	}
	return &Client{http: &http.Client{Jar: jar, Timeout: timeout}}, nil
}

func (c *Client) Fetch(ctx context.Context, username, password string) (Account, error) {
	if username == "" || password == "" {
		return Account{}, errors.New("username and password are required")
	}
	if err := c.getLoginPage(ctx); err != nil {
		return Account{}, err
	}

	_, offset := time.Now().Zone()
	payload := struct {
		TimezoneOffset string `json:"TimezoneOffset"`
		Username       string `json:"Username"`
		Password       string `json:"Password"`
	}{fmt.Sprintf("%d", -offset/60), username, password}
	body, err := json.Marshal(payload)
	if err != nil {
		return Account{}, fmt.Errorf("encode login request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, loginAPIURL, bytes.NewReader(body))
	if err != nil {
		return Account{}, fmt.Errorf("create login request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Referer", loginURL)
	req.Header.Set("User-Agent", "LoungeKey-pkpass-generator/2.0")
	resp, err := c.http.Do(req)
	if err != nil {
		return Account{}, fmt.Errorf("log in to LoungeKey: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Account{}, fmt.Errorf("LoungeKey login returned %s", resp.Status)
	}
	var result struct {
		RedirectURL string        `json:"RedirectUrl"`
		Success     bool          `json:"Success"`
		Errors      []interface{} `json:"Errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return Account{}, fmt.Errorf("decode LoungeKey login response: %w", err)
	}
	if !result.Success || result.RedirectURL == "" {
		return Account{}, fmt.Errorf("LoungeKey login failed: %v", result.Errors)
	}

	dashboardURL, err := url.Parse(loginURL)
	if err != nil {
		return Account{}, err
	}
	redirect, err := url.Parse(result.RedirectURL)
	if err != nil {
		return Account{}, fmt.Errorf("parse dashboard URL: %w", err)
	}
	return c.fetchDashboard(ctx, dashboardURL.ResolveReference(redirect).String())
}

func (c *Client) getLoginPage(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, loginURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "LoungeKey-pkpass-generator/2.0")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("load LoungeKey login page: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("LoungeKey login page returned %s", resp.Status)
	}
	return nil
}

func (c *Client) fetchDashboard(ctx context.Context, dashboardURL string) (Account, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, dashboardURL, nil)
	if err != nil {
		return Account{}, err
	}
	req.Header.Set("User-Agent", "LoungeKey-pkpass-generator/2.0")
	resp, err := c.http.Do(req)
	if err != nil {
		return Account{}, fmt.Errorf("load LoungeKey dashboard: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Account{}, fmt.Errorf("LoungeKey dashboard returned %s", resp.Status)
	}
	doc, err := goquery.NewDocumentFromReader(resp.Body)
	if err != nil {
		return Account{}, fmt.Errorf("parse LoungeKey dashboard: %w", err)
	}
	field := func(label string) (string, error) {
		var value string
		doc.Find("li").EachWithBreak(func(_ int, item *goquery.Selection) bool {
			strong := item.Find("strong").First()
			if strings.EqualFold(strings.TrimSpace(strong.Text()), label) {
				strong.Remove()
				value = strings.Join(strings.Fields(item.Text()), " ")
				return false
			}
			return true
		})
		if value == "" {
			return "", fmt.Errorf("LoungeKey dashboard field not found: %s", label)
		}
		return value, nil
	}

	name, err := field("Name on card")
	if err != nil {
		return Account{}, err
	}
	loungeNumber, err := field("Lounge Access Number")
	if err != nil {
		return Account{}, err
	}
	card, err := field("Card Details")
	if err != nil {
		return Account{}, err
	}
	if len(card) < 4 {
		return Account{}, errors.New("invalid LoungeKey card details")
	}
	expiration, err := parseWebsiteDateField(field, "Card Expiration Date")
	if err != nil {
		return Account{}, err
	}
	dateAdded, err := parseWebsiteDateField(field, "Date Card Added")
	if err != nil {
		return Account{}, err
	}
	source, ok := doc.Find("img.qr-code").First().Attr("src")
	if !ok {
		return Account{}, errors.New("LoungeKey QR image was not found")
	}
	qrMessage, err := decodeQRDataURL(source)
	if err != nil {
		return Account{}, err
	}
	return Account{
		Name:         name,
		LoungeNumber: loungeNumber,
		CardLast4:    card[len(card)-4:],
		Expiration:   expiration,
		DateAdded:    dateAdded,
		QRMessage:    qrMessage,
	}, nil
}

func parseWebsiteDateField(field func(string) (string, error), label string) (string, error) {
	value, err := field(label)
	if err != nil {
		return "", err
	}
	parsed, err := time.Parse("02 Jan 2006", value)
	if err != nil {
		return "", fmt.Errorf("parse %s: %w", label, err)
	}
	return parsed.Format(time.DateOnly), nil
}

func decodeQRDataURL(source string) (string, error) {
	const marker = ";base64,"
	index := strings.Index(source, marker)
	if index < 0 {
		return "", errors.New("invalid LoungeKey QR image data URL")
	}
	data, err := base64.StdEncoding.DecodeString(source[index+len(marker):])
	if err != nil {
		return "", fmt.Errorf("decode LoungeKey QR image: %w", err)
	}
	image, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("decode LoungeKey QR JPEG: %w", err)
	}
	bitmap, err := gozxing.NewBinaryBitmapFromImage(image)
	if err != nil {
		return "", fmt.Errorf("prepare LoungeKey QR image: %w", err)
	}
	result, err := qrcode.NewQRCodeReader().Decode(bitmap, nil)
	if err != nil {
		return "", fmt.Errorf("decode LoungeKey QR image: %w", err)
	}
	return result.GetText(), nil
}

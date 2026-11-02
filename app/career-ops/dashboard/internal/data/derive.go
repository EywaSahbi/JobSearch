package data

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

var (
	reMoneySpan = buildMoneySpanRegex(currencyTokens)
	reISODate   = regexp.MustCompile(`\b20\d{2}-\d{2}-\d{2}\b`)

	rePostedOn       = regexp.MustCompile(`(?im)(^|[;|])[^\S\n]*posted(?::[^\S\n]*|[^\S\n]+)(20\d{2}-\d{2}-\d{2})\b`)
	reCityState      = regexp.MustCompile(`\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),? (A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b`)
	reLocationLabel  = regexp.MustCompile(`(?i)\blocation:\s*([^;\n]+)`)
	reCityIntl       = regexp.MustCompile(`(?i)\b(Porto|Lisbon|London|Berlin|Munich|Hamburg|Frankfurt|Cologne|D(?:ü|u)sseldorf|Stuttgart|Z(?:ü|u)rich|Geneva|Lausanne|Basel|Dublin|Cork|Amsterdam|Rotterdam|Eindhoven|Utrecht|Paris|Lyon|Madrid|Barcelona|Valencia|Stockholm|Gothenburg|Malm(?:ö|o)|Copenhagen|Oslo|Helsinki|Milan|Rome|Turin|Vienna|Brussels|Ghent|Antwerp|Luxembourg|Warsaw|Krak(?:ó|o)w|Wroc(?:ł|l)aw|Tallinn|Riga|Vilnius|Prague|Brno|Budapest|Bucharest|Sofia|Athens|Bengaluru|Bangalore|Singapore|Sydney|Toronto|Vancouver|Tel Aviv|S(?:ã|a)o Paulo)\b`)
	reMoneyPart      = regexp.MustCompile(`(\d[\d,]*(?:\.\d+)?)\s*([KkMmBb]?)`)
	reEstHint        = regexp.MustCompile(`\(est[),;. ]|\best\)|\bmarket\b`)
	reFundingContext = regexp.MustCompile(`(?i)^\s*(valuation|(total\s+)?raised|series\s|round\b)`)
)

var currencyTokens = []string{
	"$", "€", "£", "¥", "₹", "₺", "₩", "zł", "₴",
	"CHF", "EUR", "USD", "GBP", "PLN", "UAH",
	"JPY", "CNY", "INR", "BRL", "SEK", "NOK", "DKK", "TRY", "KRW",
	"AUD", "CAD", "MXN", "SGD", "HKD", "ZAR",
}

func buildMoneySpanRegex(currencies []string) *regexp.Regexp {
	if len(currencies) == 0 {
		return regexp.MustCompile(`\b\B`)
	}
	prefixParts, rangePrefixParts, suffixParts := make([]string, 0, len(currencies)), make([]string, 0, len(currencies)), make([]string, 0, len(currencies))
	for _, tok := range currencies {
		q := regexp.QuoteMeta(tok)
		if isBareSymbol(tok) {
			prefixParts = append(prefixParts, q)
			rangePrefixParts = append(rangePrefixParts, q)
			suffixParts = append(suffixParts, q)
		} else {
			prefixParts = append(prefixParts, q+" ?")
			rangePrefixParts = append(rangePrefixParts, q+" ?")
			suffixParts = append(suffixParts, q)
		}
	}
	pattern := fmt.Sprintf(
		`(~?(?:%s)\s*\d[\d,]*(?:\.\d+)?[KkMmBb]?`+
			`(?:\s*[-–]\s*(?:%s)?\d[\d,]*(?:\.\d+)?[KkMmBb]?)?)`+
			`|(?:^|[^\p{L}\p{N}])(~?\d[\d,]*(?:\.\d+)?[KkMmBb]?`+
			`(?:\s*[-–]\s*\d[\d,]*(?:\.\d+)?[KkMmBb]?)?`+
			`\s+(?:%s))`,
		strings.Join(prefixParts, "|"),
		strings.Join(rangePrefixParts, "|"),
		strings.Join(suffixParts, "|"),
	)
	return regexp.MustCompile(pattern)
}

func isBareSymbol(tok string) bool {
	for _, r := range tok {
		if r >= 'A' && r <= 'Z' {
			return false
		}
	}
	return true
}

func payCeiling(span string) float64 {
	top := 0.0
	for _, p := range reMoneyPart.FindAllStringSubmatch(span, -1) {
		v, err := strconv.ParseFloat(strings.ReplaceAll(p[1], ",", ""), 64)
		if err != nil {
			continue
		}
		switch strings.ToLower(p[2]) {
		case "k":
			v *= 1_000
		case "m":
			v *= 1_000_000
		case "b":
			v *= 1_000_000_000
		}
		if v > top {
			top = v
		}
	}
	return top
}

func deriveNoteFields(app *model.CareerApplication) {
	lower := strings.ToLower(app.Role + " " + app.Notes + " " + app.Location)

	if app.Location == "" {
		if m := reLocationLabel.FindStringSubmatch(app.Notes); m != nil {
			app.Location = CanonicalizeLocation(m[1])
		}
	}
	if app.Location == "" {
		if m := reCityState.FindStringSubmatch(app.Notes); m != nil {
			app.Location = CanonicalizeLocation(m[1] + ", " + m[2])
		}
	}
	if app.Location == "" {
		if m := reCityState.FindStringSubmatch(app.Role); m != nil {
			app.Location = CanonicalizeLocation(m[1] + ", " + m[2])
		}
	}
	if app.Location == "" {
		if m := reCityIntl.FindString(app.Notes); m != "" {
			app.Location = CanonicalizeLocation(m)
		}
	}
	if app.Location == "" {
		if m := reCityIntl.FindString(app.Role); m != "" {
			app.Location = CanonicalizeLocation(m)
		}
	}

	switch {
	case strings.Contains(lower, "hybrid"):
		app.WorkMode = "Hybrid"
	case strings.Contains(lower, "remote") &&
		(strings.Contains(lower, "flex") ||
			strings.Contains(lower, "remote-first") ||
			strings.Contains(lower, "remote first")):
		app.WorkMode = "RemoteFlex"
	case strings.Contains(lower, "remote"):
		app.WorkMode = "Remote"
	case strings.Contains(lower, "onsite") || strings.Contains(lower, "on-site") || strings.Contains(lower, "in-office"):
		app.WorkMode = "Full"
	case app.Location != "":
		app.WorkMode = "Full"
	}

	var matches []string
	for _, m := range reMoneySpan.FindAllStringSubmatchIndex(app.Notes, -1) {
		start, end := m[2], m[3]
		if start < 0 {
			start, end = m[4], m[5]
		}
		if reFundingContext.MatchString(app.Notes[end:]) {
			continue
		}
		matches = append(matches, app.Notes[start:end])
	}
	for _, mm := range matches {
		if strings.ContainsAny(mm, "-–") {
			app.PayRange = mm
			break
		}
	}
	if app.PayRange == "" && len(matches) > 0 {
		app.PayRange = matches[0]
	}
	app.PayMax = payCeiling(app.PayRange)
	if app.PayRange != "" {
		switch {
		case strings.Contains(lower, "(posted"):
			app.PaySource = "POSTED"
		case reEstHint.MatchString(lower):
			app.PaySource = "est"
		}
	}

	for _, m := range rePostedOn.FindAllStringSubmatch(app.Notes, -1) {
		if m[2] > app.PostedOn {
			app.PostedOn = m[2]
		}
	}

	contactNotes := rePostedOn.ReplaceAllString(app.Notes, "$1")
	last := app.Date
	for _, d := range reISODate.FindAllString(contactNotes, -1) {
		if d > last {
			last = d
		}
	}
	app.LastContact = last
}

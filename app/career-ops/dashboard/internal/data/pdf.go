package data

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

type PDFManifestEntry struct {
	ReportNumber string
	PDFPath      string
	HTMLPath     string
	Format       string
	Date         string
}

type PDFManifest map[string]PDFManifestEntry

func isSafeRepoRelativePath(p string) bool {
	p = filepath.Clean(filepath.FromSlash(strings.TrimSpace(p)))
	if p == "." || p == "" {
		return false
	}
	if filepath.IsAbs(p) {
		return false
	}
	if p == ".." || strings.HasPrefix(p, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

func normalizeReportKey(s string) string {
	s = strings.TrimSpace(s)
	trimmed := strings.TrimLeft(s, "0")
	if trimmed == "" && s != "" {
		return "0"
	}
	return trimmed
}

func (m PDFManifest) Lookup(app model.CareerApplication) (PDFManifestEntry, bool) {
	if key := normalizeReportKey(app.ReportNumber); key != "" {
		if entry, ok := m[key]; ok {
			return entry, true
		}
	}
	if app.Number > 0 {
		if entry, ok := m[strconv.Itoa(app.Number)]; ok {
			return entry, true
		}
	}
	return PDFManifestEntry{}, false
}

func LoadPDFEntriesByPath(careerOpsPath string) map[string]PDFManifestEntry {
	byPath := make(map[string]PDFManifestEntry)
	raw, err := os.ReadFile(filepath.Join(careerOpsPath, "data", "pdf-index.tsv"))
	if err != nil {
		return byPath
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 2 {
			continue
		}
		entry := PDFManifestEntry{
			ReportNumber: strings.TrimSpace(fields[0]),
			PDFPath:      strings.TrimSpace(fields[1]),
		}
		if entry.PDFPath == "" || !isSafeRepoRelativePath(entry.PDFPath) {
			continue
		}
		if len(fields) > 2 {
			entry.HTMLPath = strings.TrimSpace(fields[2])
			if entry.HTMLPath != "" && !isSafeRepoRelativePath(entry.HTMLPath) {
				entry.HTMLPath = ""
			}
		}
		if len(fields) > 3 {
			entry.Format = strings.TrimSpace(fields[3])
		}
		if len(fields) > 4 {
			entry.Date = strings.TrimSpace(fields[4])
		}
		byPath[entry.PDFPath] = entry
	}
	return byPath
}

func LoadPDFManifest(careerOpsPath string) PDFManifest {
	manifest := make(PDFManifest)
	raw, err := os.ReadFile(filepath.Join(careerOpsPath, "data", "pdf-index.tsv"))
	if err != nil {
		return manifest
	}

	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 2 {
			continue
		}
		entry := PDFManifestEntry{
			ReportNumber: strings.TrimSpace(fields[0]),
			PDFPath:      strings.TrimSpace(fields[1]),
		}
		if len(fields) > 2 {
			entry.HTMLPath = strings.TrimSpace(fields[2])
			if entry.HTMLPath != "" && !isSafeRepoRelativePath(entry.HTMLPath) {
				entry.HTMLPath = ""
			}
		}
		if len(fields) > 3 {
			entry.Format = strings.TrimSpace(fields[3])
		}
		if len(fields) > 4 {
			entry.Date = strings.TrimSpace(fields[4])
		}
		if entry.ReportNumber == "" || entry.PDFPath == "" || !isSafeRepoRelativePath(entry.PDFPath) {
			continue
		}
		manifest[normalizeReportKey(entry.ReportNumber)] = entry
	}
	return manifest
}

var rePDFDate = regexp.MustCompile(`(\d{4}-\d{2}-\d{2})\.pdf$`)

func ResolvePDFs(careerOpsPath string, app model.CareerApplication, manifest PDFManifest) []string {
	if entry, ok := manifest.Lookup(app); ok {
		if _, err := os.Stat(filepath.Join(careerOpsPath, filepath.FromSlash(entry.PDFPath))); err == nil {
			return []string{entry.PDFPath}
		}
	}

	slug := kebabCase(app.Company)
	if slug == "" {
		return nil
	}

	globbed, err := filepath.Glob(filepath.Join(careerOpsPath, "output", "cv-*.pdf"))
	if err != nil {
		return nil
	}

	var matches []string
	for _, p := range globbed {
		base := strings.ToLower(filepath.Base(p))
		if matchesCompanySlug(base, slug) {
			if rel, err := filepath.Rel(careerOpsPath, p); err == nil {
				matches = append(matches, filepath.ToSlash(rel))
			}
		}
	}

	sortPDFsNewestFirst(careerOpsPath, matches)
	return matches
}

func matchesCompanySlug(base, slug string) bool {
	return strings.Contains(base, "-"+slug+"-")
}

func sortPDFsNewestFirst(careerOpsPath string, paths []string) {
	dateOf := func(p string) string {
		if m := rePDFDate.FindStringSubmatch(p); m != nil {
			return m[1]
		}
		return ""
	}
	mtimeOf := func(p string) int64 {
		info, err := os.Stat(filepath.Join(careerOpsPath, filepath.FromSlash(p)))
		if err != nil {
			return 0
		}
		return info.ModTime().UnixNano()
	}
	sort.SliceStable(paths, func(i, j int) bool {
		di, dj := dateOf(paths[i]), dateOf(paths[j])
		if di != dj {
			return di > dj
		}
		return mtimeOf(paths[i]) > mtimeOf(paths[j])
	})
}

func kebabCase(s string) string {
	var b strings.Builder
	lastHyphen := true
	for _, r := range strings.ToLower(s) {
		isAlnum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if isAlnum {
			b.WriteRune(r)
			lastHyphen = false
		} else if !lastHyphen {
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	return strings.TrimRight(b.String(), "-")
}

func ResolveHTML(careerOpsPath string, app model.CareerApplication) (htmlPath, pdfPath string) {
	slug := kebabCase(app.Company)
	if slug == "" {
		return "", ""
	}
	globbed, err := filepath.Glob(filepath.Join(careerOpsPath, "output", "cv-*.html"))
	if err != nil {
		return "", ""
	}
	var matches []string
	for _, p := range globbed {
		base := strings.ToLower(filepath.Base(p))
		if matchesCompanySlug(base, slug) {
			if rel, err := filepath.Rel(careerOpsPath, p); err == nil {
				matches = append(matches, filepath.ToSlash(rel))
			}
		}
	}
	if len(matches) == 0 {
		return "", ""
	}
	sortPDFsNewestFirst(careerOpsPath, matches)
	relHTML := matches[0]
	relPDF := strings.TrimSuffix(relHTML, ".html") + ".pdf"
	return relHTML, relPDF
}

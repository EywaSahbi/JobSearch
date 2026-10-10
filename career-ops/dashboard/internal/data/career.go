package data

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

var (
	reReportLink         = regexp.MustCompile(`\[(\d+)\]\(([^)]+)\)`)
	reScoreValue         = regexp.MustCompile(`(\d+\.?\d*)/5`)
	reSeparatorRow       = regexp.MustCompile(`^\|\s*:?-+:?(?:\s*\|\s*:?-+:?)*\s*\|?\s*$`)
	reArchetype          = regexp.MustCompile(`(?i)\*\*(?:Arquetipo|Archetype)(?:\s+(?:detectado|detected))?\*\*\s*\|\s*(.+)`)
	reTlDr               = regexp.MustCompile(`(?i)\*\*TL;DR\*\*\s*\|\s*(.+)`)
	reTlDrColon          = regexp.MustCompile(`(?i)\*\*TL;DR:\*\*\s*(.+)`)
	reRemote             = regexp.MustCompile(`(?i)\*\*Remote\*\*\s*\|\s*(.+)`)
	reComp               = regexp.MustCompile(`(?i)\*\*Comp\*\*\s*\|\s*(.+)`)
	reArchetypeColon     = regexp.MustCompile(`(?i)\*\*(?:Arquetipo|Archetype):\*\*\s*(.+)`)
	reArchetypeYAML      = regexp.MustCompile(`(?m)^archetype:\s*"?([^"\n]+)"?\s*$`)
	reReportURL          = regexp.MustCompile(`(?m)^\*\*URL:\*\*\s*(https?://\S+)`)
	reMarkdownDestEscape = regexp.MustCompile(`\\([\\()<> ])`)
	reBatchID            = regexp.MustCompile(`(?m)^\*\*Batch ID:\*\*\s*(\d+)`)
	reDiscardReasons     = regexp.MustCompile(`(?s)discard_reasons:\s*\n((?:\s*-\s*.+?\n)+)`)
	reDiscardItem        = regexp.MustCompile(`\s*-\s*([^\n]+)`)
)

func resolveReportPath(careerOpsPath, trackerPath, link string) string {
	resolved := filepath.Join(filepath.Dir(trackerPath), link)
	if _, err := os.Stat(resolved); err != nil {
		legacy := filepath.Join(careerOpsPath, link)
		if _, err2 := os.Stat(legacy); err2 == nil {
			resolved = legacy
		}
	}
	if rel, err := filepath.Rel(careerOpsPath, resolved); err == nil {
		return rel
	}
	return link
}

func getRepoRoot() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	current := cwd
	for {
		if _, err := os.Stat(filepath.Join(current, "path-resolver.mjs")); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return cwd
}

func resolveTrackerPath(careerOpsPath string) string {
	if envTracker := strings.TrimSpace(os.Getenv("CAREER_OPS_TRACKER")); envTracker != "" {
		if filepath.IsAbs(envTracker) {
			return filepath.Clean(envTracker)
		}
		return filepath.Clean(filepath.Join(getRepoRoot(), envTracker))
	}
	dataPath := filepath.Clean(filepath.Join(careerOpsPath, "data", "applications.md"))
	if _, err := os.Stat(dataPath); err == nil {
		return dataPath
	}
	return filepath.Clean(filepath.Join(careerOpsPath, "applications.md"))
}

func ParseApplications(careerOpsPath string) []model.CareerApplication {
	filePath := resolveTrackerPath(careerOpsPath)
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil
	}

	lines := strings.Split(string(content), "\n")
	apps := make([]model.CareerApplication, 0)
	num := 0

	cols := resolveTrackerColumns(lines)

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "# ") || reSeparatorRow.MatchString(line) || strings.HasPrefix(line, "| #") {
			continue
		}
		if !strings.HasPrefix(line, "|") {
			continue
		}
		if detectTrackerColumns([]string{line}) != nil {
			continue
		}

		fields := splitTrackerRow(line)
		if len(fields) < 8 {
			continue
		}

		at := func(name string) string {
			if idx, ok := cols[name]; ok && idx >= 0 && idx < len(fields) {
				return fields[idx]
			}
			return ""
		}

		num++
		trackerNumber := num
		rawNumber := at("num")
		missingNumber := rawNumber == "" || strings.IndexFunc(rawNumber, func(r rune) bool { return r < '0' || r > '9' }) >= 0
		if parsedNumber, err := strconv.Atoi(rawNumber); err == nil && !missingNumber {
			trackerNumber = parsedNumber
		} else {
			missingNumber = true
		}
		app := model.CareerApplication{
			Number:               trackerNumber,
			TrackerNumberMissing: missingNumber,
			Date:                 at("date"),
			Company:              at("company"),
			Role:                 at("role"),
			JobURL:               extractCellURL(at("url")),
			Status:               at("status"),
			HasPDF:               strings.Contains(at("pdf"), "\u2705"),
			Location:             CanonicalizeLocation(at("location")),
		}

		app.ScoreRaw = at("score")
		if sm := reScoreValue.FindStringSubmatch(at("score")); sm != nil {
			if score, err := strconv.ParseFloat(sm[1], 64); err == nil {
				app.Score = score
				app.HasScore = true
			}
		}

		if rm := reReportLink.FindStringSubmatch(at("report")); rm != nil {
			app.ReportNumber = rm[1]
			app.ReportPath = resolveReportPath(careerOpsPath, filePath, rm[2])
		}

		app.Notes = at("notes")

		deriveNoteFields(&app)

		apps = append(apps, app)
	}

	batchURLs := loadBatchInputURLs(careerOpsPath)
	reportNumURLs := loadJobURLs(careerOpsPath)

	for i := range apps {
		if apps[i].JobURL != "" {
			continue
		}
		if apps[i].ReportPath == "" {
			continue
		}
		fullReport := filepath.Join(careerOpsPath, apps[i].ReportPath)
		reportContent, err := os.ReadFile(fullReport)
		if err != nil {
			continue
		}
		header := string(reportContent)
		if len(header) > 1000 {
			header = header[:1000]
		}

		if m := reReportURL.FindStringSubmatch(header); m != nil {
			apps[i].JobURL = m[1]
			continue
		}

		if m := reBatchID.FindStringSubmatch(header); m != nil {
			if url, ok := batchURLs[m[1]]; ok {
				apps[i].JobURL = url
				continue
			}
		}

		if reportNumURLs != nil {
			if url, ok := reportNumURLs[apps[i].ReportNumber]; ok {
				apps[i].JobURL = url
				continue
			}
		}
	}

	enrichFromScanHistory(careerOpsPath, apps)

	enrichAppURLsByCompany(careerOpsPath, apps)

	return apps
}

func loadBatchInputURLs(careerOpsPath string) map[string]string {
	inputPath := filepath.Join(careerOpsPath, "batch", "batch-input.tsv")
	inputData, err := os.ReadFile(inputPath)
	if err != nil {
		return nil
	}
	result := make(map[string]string)
	for _, line := range strings.Split(string(inputData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "id" {
			continue
		}
		id := fields[0]
		notes := fields[3]
		if idx := strings.LastIndex(notes, "| "); idx >= 0 {
			u := strings.TrimSpace(notes[idx+2:])
			if strings.HasPrefix(u, "http") {
				result[id] = u
				continue
			}
		}
		if strings.HasPrefix(fields[1], "http") {
			result[id] = fields[1]
		}
	}
	return result
}

type batchEntry struct {
	id      string
	url     string
	company string
	role    string
}

func loadJobURLs(careerOpsPath string) map[string]string {
	inputPath := filepath.Join(careerOpsPath, "batch", "batch-input.tsv")
	inputData, err := os.ReadFile(inputPath)
	if err != nil {
		return nil
	}

	entries := make(map[string]batchEntry)
	for _, line := range strings.Split(string(inputData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "id" {
			continue
		}
		e := batchEntry{id: fields[0]}
		notes := fields[3]

		if idx := strings.LastIndex(notes, "| "); idx >= 0 {
			u := strings.TrimSpace(notes[idx+2:])
			if strings.HasPrefix(u, "http") {
				e.url = u
			}
		}
		if e.url == "" && strings.HasPrefix(fields[1], "http") {
			e.url = fields[1]
		}

		notesPart := notes
		if pipeIdx := strings.Index(notesPart, " | "); pipeIdx >= 0 {
			notesPart = notesPart[:pipeIdx]
		}
		if atIdx := strings.LastIndex(notesPart, " @ "); atIdx >= 0 {
			e.role = strings.TrimSpace(notesPart[:atIdx])
			e.company = strings.TrimSpace(notesPart[atIdx+3:])
		}

		if e.url != "" {
			entries[fields[0]] = e
		}
	}

	statePath := filepath.Join(careerOpsPath, "batch", "batch-state.tsv")
	stateData, err := os.ReadFile(statePath)
	if err != nil {
		return nil
	}

	reportToURL := make(map[string]string)
	for _, line := range strings.Split(string(stateData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 6 || fields[0] == "id" {
			continue
		}
		id := fields[0]
		status := fields[2]
		reportNum := fields[5]
		if status != "completed" || reportNum == "" || reportNum == "-" {
			continue
		}
		if e, ok := entries[id]; ok {
			reportToURL[reportNum] = e.url
			if len(reportNum) < 3 {
				reportToURL[fmt.Sprintf("%03s", reportNum)] = e.url
			}
		}
	}

	return reportToURL
}

func enrichFromScanHistory(careerOpsPath string, apps []model.CareerApplication) {
	scanPath := filepath.Join(careerOpsPath, "scan-history.tsv")
	scanData, err := os.ReadFile(scanPath)
	if err != nil {
		return
	}

	type scanEntry struct {
		url     string
		company string
		title   string
	}
	byCompany := make(map[string][]scanEntry)
	for _, line := range strings.Split(string(scanData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 5 || fields[0] == "url" {
			continue
		}
		url := fields[0]
		company := fields[4]
		title := fields[3]
		if url == "" || !strings.HasPrefix(url, "http") {
			continue
		}
		key := normalizeCompany(company)
		byCompany[key] = append(byCompany[key], scanEntry{url: url, company: company, title: title})
	}

	for i := range apps {
		if apps[i].JobURL != "" {
			continue
		}
		key := normalizeCompany(apps[i].Company)
		matches := byCompany[key]
		if len(matches) == 1 {
			apps[i].JobURL = matches[0].url
		} else if len(matches) > 1 {
			appRole := strings.ToLower(apps[i].Role)
			best := matches[0].url
			bestScore := 0
			for _, m := range matches {
				score := 0
				mTitle := strings.ToLower(m.title)
				for _, word := range strings.Fields(appRole) {
					if len(word) > 2 && strings.Contains(mTitle, word) {
						score++
					}
				}
				if score > bestScore {
					bestScore = score
					best = m.url
				}
			}
			apps[i].JobURL = best
		}
	}
}

func normalizeCompany(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	for _, suffix := range []string{" inc.", " inc", " llc", " ltd", " corp", " corporation", " technologies", " technology", " group", " co."} {
		s = strings.TrimSuffix(s, suffix)
	}
	return strings.TrimSpace(s)
}

func enrichAppURLsByCompany(careerOpsPath string, apps []model.CareerApplication) {
	inputPath := filepath.Join(careerOpsPath, "batch", "batch-input.tsv")
	inputData, err := os.ReadFile(inputPath)
	if err != nil {
		return
	}

	type entry struct {
		role string
		url  string
	}
	byCompany := make(map[string][]entry)
	for _, line := range strings.Split(string(inputData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "id" {
			continue
		}
		notes := fields[3]
		var url string
		if idx := strings.LastIndex(notes, "| "); idx >= 0 {
			u := strings.TrimSpace(notes[idx+2:])
			if strings.HasPrefix(u, "http") {
				url = u
			}
		}
		if url == "" && strings.HasPrefix(fields[1], "http") {
			url = fields[1]
		}
		if url == "" {
			continue
		}
		notesPart := notes
		if pipeIdx := strings.Index(notesPart, " | "); pipeIdx >= 0 {
			notesPart = notesPart[:pipeIdx]
		}
		if atIdx := strings.LastIndex(notesPart, " @ "); atIdx >= 0 {
			role := strings.TrimSpace(notesPart[:atIdx])
			company := strings.TrimSpace(notesPart[atIdx+3:])
			key := normalizeCompany(company)
			byCompany[key] = append(byCompany[key], entry{role: role, url: url})
		}
	}

	for i := range apps {
		if apps[i].JobURL != "" {
			continue
		}
		key := normalizeCompany(apps[i].Company)
		matches := byCompany[key]
		if len(matches) == 1 {
			apps[i].JobURL = matches[0].url
		} else if len(matches) > 1 {
			appRole := strings.ToLower(apps[i].Role)
			best := matches[0].url
			bestScore := 0
			for _, m := range matches {
				score := 0
				mRole := strings.ToLower(m.role)
				for _, word := range strings.Fields(appRole) {
					if len(word) > 2 && strings.Contains(mRole, word) {
						score++
					}
				}
				if score > bestScore {
					bestScore = score
					best = m.url
				}
			}
			apps[i].JobURL = best
		}
	}
}

func ComputeMetrics(apps []model.CareerApplication) model.PipelineMetrics {
	m := model.PipelineMetrics{
		Total:    len(apps),
		ByStatus: make(map[string]int),
	}

	var totalScore float64
	var scored int

	for _, app := range apps {
		status := NormalizeStatus(app.Status)
		m.ByStatus[status]++

		if app.Score > 0 {
			totalScore += app.Score
			scored++
			if app.Score > m.TopScore {
				m.TopScore = app.Score
			}
		}
		if app.HasPDF {
			m.WithPDF++
		}
		if status != "skip" && status != "rejected" && status != "discarded" {
			m.Actionable++
		}
	}

	if scored > 0 {
		m.AvgScore = totalScore / float64(scored)
	}

	return m
}

func NormalizeStatus(raw string) string {
	s := strings.ReplaceAll(raw, "**", "")
	s = strings.TrimSpace(strings.ToLower(s))
	if idx := strings.Index(s, " 202"); idx > 0 {
		s = strings.TrimSpace(s[:idx])
	}

	switch {
	case s == "hired" || s == "contratado" || s == "contratada" || s == "accepted" || s == "accept" || s == "kabul edildi" || s == "kabul_edildi" || s == "işe alındı" || s == "ise alindi":
		return "hired"
	case strings.Contains(s, "no aplicar") || strings.Contains(s, "no_aplicar") || s == "skip" || strings.Contains(s, "geo blocker") || strings.Contains(s, "uygun değil") || strings.Contains(s, "uygun_değil") || strings.Contains(s, "uygun degil") || strings.Contains(s, "uygun_degil"):
		return "skip"
	case strings.Contains(s, "interview") || strings.Contains(s, "entrevista") || strings.Contains(s, "mülakat") || strings.Contains(s, "mulakat"):
		return "interview"
	case s == "offer" || strings.Contains(s, "oferta") || strings.Contains(s, "teklif"):
		return "offer"
	case strings.Contains(s, "responded") || strings.Contains(s, "respondido") || strings.Contains(s, "yanıt verildi") || strings.Contains(s, "yanıt_verildi") || strings.Contains(s, "yanit verildi") || strings.Contains(s, "yanit_verildi"):
		return "responded"
	case strings.Contains(s, "applied") || strings.Contains(s, "aplicado") || s == "enviada" || s == "aplicada" || s == "sent" || strings.Contains(s, "başvuruldu") || strings.Contains(s, "basvuruldu"):
		return "applied"
	case strings.Contains(s, "rejected") || strings.Contains(s, "rechazado") || s == "rechazada" || strings.Contains(s, "reddedildi"):
		return "rejected"
	case strings.Contains(s, "discarded") || strings.Contains(s, "descartado") || s == "descartada" || s == "cerrada" || s == "cancelada" ||
		strings.HasPrefix(s, "duplicado") || strings.HasPrefix(s, "dup") || strings.Contains(s, "iptal edildi") || strings.Contains(s, "iptal_edildi") || strings.Contains(s, "ıptal edildi") || strings.Contains(s, "ıptal_edildi"):
		return "discarded"
	case strings.Contains(s, "evaluated") || strings.Contains(s, "evaluada") || s == "condicional" || s == "hold" || s == "monitor" || s == "evaluar" || s == "verificar" || strings.Contains(s, "değerlendirildi") || strings.Contains(s, "degerlendirildi"):
		return "evaluated"
	default:
		return s
	}
}

func LoadReportSummary(careerOpsPath, reportPath string) (archetype, tldr, remote, comp string) {
	fullPath := filepath.Join(careerOpsPath, reportPath)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return
	}
	text := string(content)

	if m := reArchetype.FindStringSubmatch(text); m != nil {
		archetype = cleanTableCell(m[1])
	} else if m := reArchetypeColon.FindStringSubmatch(text); m != nil {
		archetype = cleanTableCell(m[1])
	} else if m := reArchetypeYAML.FindStringSubmatch(text); m != nil {
		archetype = strings.TrimSpace(m[1])
	}

	if m := reTlDr.FindStringSubmatch(text); m != nil {
		tldr = cleanTableCell(m[1])
	} else if m := reTlDrColon.FindStringSubmatch(text); m != nil {
		tldr = cleanTableCell(m[1])
	}

	if m := reRemote.FindStringSubmatch(text); m != nil {
		remote = cleanTableCell(m[1])
	}

	if m := reComp.FindStringSubmatch(text); m != nil {
		comp = cleanTableCell(m[1])
	}

	if len(tldr) > 120 {
		tldr = tldr[:117] + "..."
	}

	return
}

func splitTrackerRow(line string) []string {
	line = strings.TrimSpace(line)
	var fields []string
	if strings.Contains(line, "\t") {
		line = strings.TrimPrefix(line, "|")
		line = strings.TrimSpace(line)
		for _, p := range strings.Split(line, "\t") {
			fields = append(fields, strings.TrimSpace(strings.Trim(p, "|")))
		}
	} else {
		line = strings.Trim(line, "|")
		for _, p := range strings.Split(line, "|") {
			fields = append(fields, strings.TrimSpace(p))
		}
	}
	return fields
}

func extractCellURL(cellValue string) string {
	value := strings.TrimSpace(cellValue)
	if value == "" {
		return ""
	}
	for _, link := range parseMarkdownLinks(value) {
		target := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(link.target), "<"), ">")
		lower := strings.ToLower(target)
		if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
			return target
		}
	}
	return value
}

type markdownLink struct {
	label  string
	target string
}

func parseMarkdownLinks(value string) []markdownLink {
	r := []rune(value)
	var links []markdownLink
	cursor := 0
	for cursor < len(r) {
		labelStart := -1
		for i := cursor; i < len(r); i++ {
			if r[i] == '[' {
				labelStart = i
				break
			}
		}
		if labelStart == -1 {
			break
		}
		labelEnd := -1
		for i := labelStart + 1; i < len(r); i++ {
			if r[i] == '\\' {
				i++
			} else if r[i] == ']' {
				labelEnd = i
				break
			}
		}
		if labelEnd == -1 || labelEnd+1 >= len(r) || r[labelEnd+1] != '(' {
			cursor = labelStart + 1
			continue
		}
		depth, linkEnd := 1, -1
		for i := labelEnd + 2; i < len(r); i++ {
			if r[i] == '\\' {
				i++
			} else if r[i] == '(' {
				depth++
			} else if r[i] == ')' {
				depth--
				if depth == 0 {
					linkEnd = i
					break
				}
			}
		}
		if linkEnd == -1 {
			cursor = labelStart + 1
			continue
		}
		if target, ok := markdownLinkDestination(string(r[labelEnd+2 : linkEnd])); ok {
			links = append(links, markdownLink{label: string(r[labelStart+1 : labelEnd]), target: target})
		}
		cursor = linkEnd + 1
	}
	return links
}

func markdownLinkDestination(raw string) (string, bool) {
	r := []rune(strings.TrimLeftFunc(raw, unicode.IsSpace))
	if len(r) > 0 && r[0] == '<' {
		for i := 1; i < len(r); i++ {
			if r[i] == '\\' {
				i++
			} else if r[i] == '>' {
				return reMarkdownDestEscape.ReplaceAllString(string(r[1:i]), "$1"), true
			}
		}
		return "", false
	}
	depth, end := 0, len(r)
	for i := 0; i < len(r); i++ {
		switch {
		case r[i] == '\\':
			i++
		case r[i] == '(':
			depth++
		case r[i] == ')' && depth > 0:
			depth--
		case unicode.IsSpace(r[i]) && depth == 0:
			end = i
		}
		if end != len(r) {
			break
		}
	}
	destination := strings.TrimSpace(string(r[:end]))
	if destination == "" {
		return "", false
	}
	return reMarkdownDestEscape.ReplaceAllString(destination, "$1"), true
}

var trackerHeaderAliases = map[string]string{
	"#": "num", "num": "num",
	"date": "date", "fecha": "date", "datum": "date", "data": "date",
	"dato": "date", "tanggal": "date",
	"company": "company", "empresa": "company",
	"firma": "company", "virksomhed": "company", "perusahaan": "company",
	"via": "via", "role": "role", "puesto": "role",
	"rolle": "role", "rola": "role", "vaga": "role",
	"location": "location", "ort": "location", "score": "score", "status": "status",
	"pdf": "pdf", "materials": "pdf", "report": "report",
	"apply link": "applylink", "apply": "applylink",
	"follow-up": "followup", "follow up": "followup", "followup": "followup",
	"notes": "notes", "url": "url",
}

var legacyTrackerColumns = map[string]int{
	"num": 0, "date": 1, "company": 2, "role": 3, "score": 4,
	"status": 5, "pdf": 6, "report": 7, "notes": 8,
}

func detectTrackerColumns(lines []string) map[string]int {
	for _, line := range lines {
		if !strings.HasPrefix(strings.TrimSpace(line), "|") {
			continue
		}
		cells := splitTrackerRow(line)
		m := make(map[string]int)
		for i, c := range cells {
			if name, ok := trackerHeaderAliases[strings.ToLower(c)]; ok {
				m[name] = i
			}
		}
		complete := true
		for _, k := range []string{"num", "company", "role", "score", "status"} {
			if _, ok := m[k]; !ok {
				complete = false
				break
			}
		}
		if complete {
			return m
		}
	}
	return nil
}

func resolveTrackerColumns(lines []string) map[string]int {
	if m := detectTrackerColumns(lines); m != nil {
		return m
	}
	return legacyTrackerColumns
}

func UpdateApplicationStatus(careerOpsPath string, app model.CareerApplication, newStatus string) error {
	return UpdateApplicationStatusAndNotes(careerOpsPath, app, newStatus, "")
}

func UpdateApplicationStatusAndNotes(careerOpsPath string, app model.CareerApplication, newStatus, notesAppend string) error {
	if strings.ContainsAny(notesAppend, "|\r\n\t") {
		return fmt.Errorf("notes cannot contain table delimiters or line breaks")
	}
	if !isCanonicalStatusName(newStatus) {
		return fmt.Errorf("unrecognized status: %q", newStatus)
	}
	if app.ReportNumber == "" {
		return fmt.Errorf("application has no report identity; use set-status.mjs --row to select a tracker row")
	}
	return runStatusWriter(careerOpsPath, app.ReportNumber, newStatus, notesAppend)
}

func isCanonicalStatusName(status string) bool {
	switch strings.ToLower(status) {
	case "evaluated", "applied", "responded", "interview", "offer", "hired", "rejected", "discarded", "skip":
		return true
	}
	return false
}

func cleanTableCell(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, "|")
	return strings.TrimSpace(s)
}

func StatusPriority(status string) int {
	switch NormalizeStatus(status) {
	case "interview":
		return 0
	case "offer":
		return 1
	case "responded":
		return 2
	case "applied":
		return 3
	case "evaluated":
		return 4
	case "skip":
		return 5
	case "rejected":
		return 6
	case "discarded":
		return 7
	default:
		return 8
	}
}

func ComputeProgressMetrics(apps []model.CareerApplication, history ...map[int]int) model.ProgressMetrics {
	pm := model.ProgressMetrics{}

	statusCounts := make(map[string]int)
	var totalScore float64
	var scored int

	for _, app := range apps {
		norm := NormalizeStatus(app.Status)
		statusCounts[norm]++

		if app.Score > 0 {
			totalScore += app.Score
			scored++
			if app.Score > pm.TopScore {
				pm.TopScore = app.Score
			}
		}

		if norm != "skip" && norm != "rejected" && norm != "discarded" {
			pm.ActiveApps++
		}
	}

	if scored > 0 {
		pm.AvgScore = totalScore / float64(scored)
	}

	total := len(apps)
	applied := statusCounts["applied"] + statusCounts["responded"] + statusCounts["interview"] + statusCounts["offer"] + statusCounts["hired"] + statusCounts["rejected"]
	responded := statusCounts["responded"] + statusCounts["interview"] + statusCounts["offer"] + statusCounts["hired"] + statusCounts["rejected"]
	interview := statusCounts["interview"] + statusCounts["offer"] + statusCounts["hired"]
	offer := statusCounts["offer"] + statusCounts["hired"]
	if len(history) > 0 {
		applied, responded, interview, offer = 0, 0, 0, 0
		ranks := make(map[int]int)
		var unnumberedRanks []int
		for _, app := range apps {
			if NormalizeStatus(app.Status) == "skip" {
				continue
			}
			rank := funnelRank(app.Status)
			if app.TrackerNumberMissing {
				unnumberedRanks = append(unnumberedRanks, rank)
				continue
			}
			if history[0][app.Number] > rank {
				rank = history[0][app.Number]
			}
			if rank > ranks[app.Number] {
				ranks[app.Number] = rank
			}
		}
		for _, rank := range ranks {
			unnumberedRanks = append(unnumberedRanks, rank)
		}
		for _, rank := range unnumberedRanks {
			if rank >= 1 {
				applied++
			}
			if rank >= 2 {
				responded++
			}
			if rank >= 3 {
				interview++
			}
			if rank >= 4 {
				offer++
			}
		}
	}

	pm.TotalOffers = offer

	pm.FunnelStages = []model.FunnelStage{
		{Label: "Tracked", Count: total, Pct: 100.0},
		{Label: "Applied", Count: applied, Pct: safePct(applied, total)},
		{Label: "Responded", Count: responded, Pct: safePct(responded, applied)},
		{Label: "Interview", Count: interview, Pct: safePct(interview, applied)},
		{Label: "Offer", Count: offer, Pct: safePct(offer, applied)},
	}

	if applied > 0 {
		pm.ResponseRate = float64(responded) / float64(applied) * 100
		pm.InterviewRate = float64(interview) / float64(applied) * 100
		pm.OfferRate = float64(offer) / float64(applied) * 100
	}

	buckets := [5]int{}
	for _, app := range apps {
		if app.Score <= 0 {
			continue
		}
		switch {
		case app.Score >= 4.5:
			buckets[0]++
		case app.Score >= 4.0:
			buckets[1]++
		case app.Score >= 3.5:
			buckets[2]++
		case app.Score >= 3.0:
			buckets[3]++
		default:
			buckets[4]++
		}
	}
	pm.ScoreBuckets = []model.ScoreBucket{
		{Label: "4.5-5.0", Count: buckets[0]},
		{Label: "4.0-4.4", Count: buckets[1]},
		{Label: "3.5-3.9", Count: buckets[2]},
		{Label: "3.0-3.4", Count: buckets[3]},
		{Label: "  <3.0", Count: buckets[4]},
	}

	weekCounts := make(map[string]int)
	for _, app := range apps {
		if app.Date == "" {
			continue
		}
		t, err := time.Parse("2006-01-02", app.Date)
		if err != nil {
			continue
		}
		year, week := t.ISOWeek()
		key := fmt.Sprintf("%d-W%02d", year, week)
		weekCounts[key]++
	}

	var weeks []string
	for w := range weekCounts {
		weeks = append(weeks, w)
	}
	sort.Strings(weeks)
	if len(weeks) > 8 {
		weeks = weeks[len(weeks)-8:]
	}

	for _, w := range weeks {
		pm.WeeklyActivity = append(pm.WeeklyActivity, model.WeekActivity{
			Week:  w,
			Count: weekCounts[w],
		})
	}

	return pm
}

func safePct(part, whole int) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole) * 100
}

func LoadReportDiscardReasons(careerOpsPath, reportPath string) []string {
	if reportPath == "" {
		return nil
	}
	p := reportPath
	if strings.Contains(p, "](") {
		idx := strings.Index(p, "](")
		p = p[idx+2:]
		p = strings.TrimSuffix(p, ")")
	}
	fullPath := filepath.Join(careerOpsPath, p)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return nil
	}
	text := string(content)

	match := reDiscardReasons.FindStringSubmatch(text)
	if len(match) < 2 {
		return nil
	}

	itemsMatch := reDiscardItem.FindAllStringSubmatch(match[1], -1)
	var reasons []string
	for _, item := range itemsMatch {
		reasons = append(reasons, strings.TrimSpace(item[1]))
	}
	return reasons
}

func SaveAnonymousStat(careerOpsPath string, role string, weeks int) error {
	dirPath := filepath.Join(careerOpsPath, "data")
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return err
	}
	filePath := filepath.Join(dirPath, "reported-hires.tsv")
	f, err := os.OpenFile(filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err == nil && fi.Size() == 0 {
		_, _ = f.WriteString("Date\tRoleType\tWeeksToHire\n")
	}

	dateStr := time.Now().Format("2006-01-02")
	_, err = f.WriteString(fmt.Sprintf("%s\t%s\t%d\n", dateStr, role, weeks))
	return err
}

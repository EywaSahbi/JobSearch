package data

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

func funnelRank(status string) int {
	switch NormalizeStatus(status) {
	case "applied":
		return 1
	case "responded", "rejected":
		return 2
	case "interview":
		return 3
	case "offer", "hired":
		return 4
	}
	return 0
}

type StatusLedger struct {
	Reached    map[int]int
	LatestDate map[int]string
}

var reLedgerDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func ReadStatusLedger(root string) (StatusLedger, error) {
	content, err := os.ReadFile(filepath.Join(filepath.Dir(resolveTrackerPath(root)), "status-log.tsv"))
	if errors.Is(err, os.ErrNotExist) {
		return StatusLedger{}, nil
	}
	if err != nil {
		return StatusLedger{}, fmt.Errorf("read funnel history: %w", err)
	}
	return parseStatusLedger(string(content)), nil
}

func ReadFunnelHistory(root string) (map[int]int, error) {
	ledger, err := ReadStatusLedger(root)
	if err != nil {
		return nil, err
	}
	return ledger.Reached, nil
}

func parseFunnelHistory(content string) map[int]int {
	return parseStatusLedger(content).Reached
}

type ledgerObservation struct {
	to   string
	date string
}

func parseStatusLedger(content string) StatusLedger {
	reached := make(map[int]int)
	timelines := make(map[int][]ledgerObservation)
	for _, line := range strings.Split(content, "\n") {
		c := strings.Split(strings.TrimSuffix(line, "\r"), "\t")
		if len(c) < 4 {
			continue
		}
		for i := range c {
			c[i] = strings.TrimSpace(c[i])
		}
		if c[0] == "" || strings.IndexFunc(c[0], func(r rune) bool { return r < '0' || r > '9' }) >= 0 || c[1] == "" || c[2] == "" || c[3] == "" {
			continue
		}
		num, err := strconv.Atoi(c[0])
		if err != nil {
			continue
		}
		for _, status := range c[2:4] {
			if rank := funnelRank(status); rank > reached[num] {
				reached[num] = rank
			}
		}

		if !reLedgerDate.MatchString(c[1]) {
			continue
		}
		date, to := c[1], c[3]
		source := ""
		if len(c) > 4 {
			source = c[4]
		}
		tl := timelines[num]
		switch {
		case to == "-":
			if len(tl) > 0 {
				tl = tl[:len(tl)-1]
			}
		case source == "correction":
			corrected := false
			for i := len(tl) - 1; i >= 0; i-- {
				if NormalizeStatus(tl[i].to) == NormalizeStatus(to) {
					tl[i].date = date
					corrected = true
					break
				}
			}
			if !corrected {
				tl = append(tl, ledgerObservation{to: to, date: date})
			}
		default:
			tl = append(tl, ledgerObservation{to: to, date: date})
		}
		timelines[num] = tl
	}

	latest := make(map[int]string, len(timelines))
	for num, tl := range timelines {
		for _, o := range tl {
			if o.date > latest[num] {
				latest[num] = o.date
			}
		}
		if latest[num] == "" {
			delete(latest, num)
		}
	}
	return StatusLedger{Reached: reached, LatestDate: latest}
}

func ApplyStatusDates(apps []model.CareerApplication, dates map[int]string) {
	if len(dates) == 0 {
		return
	}
	for i := range apps {
		if apps[i].TrackerNumberMissing {
			continue
		}
		if d, ok := dates[apps[i].Number]; ok {
			apps[i].StatusDate = d
		}
	}
}

package screens

import (
	"fmt"
	"math"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/i18n"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

type StatsClosedMsg struct{}

type StatsModel struct {
	metrics      model.StatsMetrics
	evaluated    int
	scrollOffset int
	width        int
	height       int
	theme        theme.Theme
}

func NewStatsModel(t theme.Theme, metrics model.StatsMetrics, evaluated, width, height int) StatsModel {
	return StatsModel{
		metrics:   metrics,
		evaluated: evaluated,
		width:     width,
		height:    height,
		theme:     t,
	}
}

func (m StatsModel) Init() tea.Cmd {
	return nil
}

const (
	twoColumnMinWidth = 114

	panelPadW = 4

	archetypeCountW = 10
	archetypeScoreW = 10
	labelCountW     = 18
	payLabelW       = 16
	barGapW         = 1

	minReadableBarW = 8
)

func (m *StatsModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

func (m StatsModel) contentWidth() int {
	if m.width >= twoColumnMinWidth {
		return m.width/2 - 2
	}
	return m.width
}

func (m StatsModel) rightColumnWidth() int {
	if m.width >= twoColumnMinWidth {
		return m.width - m.contentWidth() - 4
	}
	return m.width
}

func (m StatsModel) barWidth(avail, fixedCells int) int {
	preferred := 25
	if avail < 90 {
		preferred = 15
	}
	return max(1, min(preferred, avail-panelPadW-fixedCells))
}

func countCells(stats []model.LabelCountStat, format string) ([]string, int) {
	cells := make([]string, len(stats))
	widest := 0
	for i, s := range stats {
		cells[i] = fmt.Sprintf(format, s.Count, s.Pct)
		widest = max(widest, lipgloss.Width(cells[i]))
	}
	return cells, widest
}

func (m StatsModel) Update(msg tea.Msg) (StatsModel, tea.Cmd) {
	switch keyEvent := msg.(type) {
	case tea.KeyMsg:
		switch keyEvent.String() {
		case "q", "esc":
			return m, func() tea.Msg { return StatsClosedMsg{} }
		case "t", "T":
			return m, nil
		case "j", "down":
			m.scrollOffset = m.scrollOffset + 1
		case "k", "up":
			m.scrollOffset = max(0, m.scrollOffset-1)
		case "pgdown", "ctrl+d":
			m.scrollOffset += m.height / 2
		case "pgup", "ctrl+u":
			m.scrollOffset = max(0, m.scrollOffset-m.height/2)
		}
		contentLines := strings.Count(m.renderBody(), "\n") + 1
		maxOffset := contentLines - (m.height - 4)
		if maxOffset < 0 {
			maxOffset = 0
		}
		if m.scrollOffset > maxOffset {
			m.scrollOffset = maxOffset
		}
	case tea.WindowSizeMsg:
		m.width, m.height = keyEvent.Width, keyEvent.Height
	}
	return m, nil
}

func (m StatsModel) renderBody() string {
	insights := m.renderInsights()
	archetypes := m.renderArchetypeChart()
	pieChart := m.renderPieChart(i18n.Current.FitQualityDistribution, i18n.Current.QualityBreakdown, m.metrics.ScoreTiers, []lipgloss.Color{
		m.theme.Green,
		m.theme.Sky,
		m.theme.Yellow,
		m.theme.Peach,
		m.theme.Red,
		m.theme.Mauve,
	}, true)
	seniorityPieChart := m.renderPieChart(i18n.Current.SeniorityMix, i18n.Current.SeniorityMix, m.metrics.SeniorityMix, []lipgloss.Color{
		m.theme.Mauve,
		m.theme.Peach,
		m.theme.Sky,
		m.theme.Green,
		m.theme.Yellow,
		m.theme.Red,
	}, false)
	workModes := m.renderLabelCountTable(i18n.Current.WorkModeTitle, m.metrics.WorkModes)
	locations := m.renderLabelCountTable(i18n.Current.LocationTitle, m.metrics.Locations)
	pay := m.renderPay()

	if m.width >= twoColumnMinWidth {
		leftColWidth := m.contentWidth()
		rightColWidth := m.rightColumnWidth()

		leftCol := lipgloss.NewStyle().Width(leftColWidth).Render(
			lipgloss.JoinVertical(lipgloss.Left,
				insights,
				"",
				archetypes,
				"",
				workModes,
				"",
				locations,
			),
		)

		rightCol := lipgloss.NewStyle().Width(rightColWidth).Render(
			lipgloss.JoinVertical(lipgloss.Left,
				pieChart,
				"",
				seniorityPieChart,
				"",
				pay,
			),
		)

		return lipgloss.JoinVertical(lipgloss.Left,
			"",
			lipgloss.JoinHorizontal(lipgloss.Top, leftCol, "  ", rightCol),
			"",
		)
	}
	return lipgloss.JoinVertical(lipgloss.Left,
		"",
		insights,
		"",
		pieChart,
		"",
		seniorityPieChart,
		"",
		archetypes,
		"",
		workModes,
		"",
		locations,
		"",
		pay,
		"",
	)
}

func (m StatsModel) View() string {
	header := m.renderHeader()
	help := m.renderHelp()
	body := m.renderBody()

	bodyLines := strings.Split(body, "\n")
	offset := m.scrollOffset
	if offset >= len(bodyLines) {
		offset = len(bodyLines) - 1
	}
	if offset < 0 {
		offset = 0
	}
	if offset > 0 {
		bodyLines = bodyLines[offset:]
	}

	availHeight := m.height - 4
	if availHeight < 3 {
		availHeight = 3
	}
	if len(bodyLines) > availHeight {
		bodyLines = bodyLines[:availHeight]
	}

	body = strings.Join(bodyLines, "\n")

	return lipgloss.JoinVertical(lipgloss.Left, header, body, help)
}

func (m StatsModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Render("📊 " + i18n.Current.StatsTitle)

	right := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	info := right.Render(fmt.Sprintf(i18n.Current.StatsSummary, m.evaluated, len(m.metrics.Archetypes)))

	gap := m.width - lipgloss.Width(title) - lipgloss.Width(info) - 4
	if gap < 1 {
		gap = 1
	}

	return style.Render(title + strings.Repeat(" ", gap) + info)
}

func (m StatsModel) renderInsights() string {
	insightsList := data.GenerateInsights(m.metrics)
	if len(insightsList) == 0 {
		return ""
	}
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	sectionTitle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow).Render("💡 " + i18n.Current.StatsStrategicInsights)

	boxW := m.width - 6
	if m.width >= twoColumnMinWidth {
		boxW = m.contentWidth() - 4
	}

	boxStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(m.theme.Overlay).
		Padding(0, 1).
		Width(boxW)

	var bulletLines []string
	bulletLines = append(bulletLines, sectionTitle)
	for _, ins := range insightsList {
		bullet := lipgloss.NewStyle().Foreground(m.theme.Sky).Render("• ")
		text := lipgloss.NewStyle().Foreground(m.theme.Text).Render(ins)
		bulletLines = append(bulletLines, bullet+text)
	}

	return padStyle.Render(boxStyle.Render(strings.Join(bulletLines, "\n")))
}

func (m StatsModel) renderPieChart(title, legendHeading string, stats []model.LabelCountStat, sliceColors []lipgloss.Color, showQualityBadge bool) string {
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	sectionTitle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Render(i18n.PieChartSectionTitle(title))
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	if len(stats) == 0 {
		return padStyle.Render(sectionTitle + "\n" + dimStyle.Render(i18n.Current.NoData))
	}

	totalCount := 0
	for _, s := range stats {
		totalCount += s.Count
	}
	if totalCount == 0 {
		return padStyle.Render(sectionTitle + "\n" + dimStyle.Render(i18n.Current.NoData))
	}

	cumFractions := make([]float64, len(stats))
	cum := 0.0
	for i, s := range stats {
		cum += float64(s.Count) / float64(totalCount)
		cumFractions[i] = cum
	}

	radius := 4
	var pieLines []string
	for y := -radius; y <= radius; y++ {
		var row strings.Builder
		for x := -2 * radius; x <= 2*radius; x++ {
			nx := float64(x) / 2.0
			ny := float64(y)
			dist := math.Sqrt(nx*nx + ny*ny)

			if dist <= float64(radius)+0.2 {
				angle := math.Atan2(nx, -ny)
				if angle < 0 {
					angle += 2 * math.Pi
				}
				frac := angle / (2 * math.Pi)

				sliceIdx := 0
				for idx, cf := range cumFractions {
					if frac <= cf || idx == len(cumFractions)-1 {
						sliceIdx = idx
						break
					}
				}

				color := m.theme.Text
				if sliceIdx < len(sliceColors) {
					color = sliceColors[sliceIdx]
				}

				char := "█"
				if dist > float64(radius)-0.3 {
					char = "▓"
				}
				row.WriteString(lipgloss.NewStyle().Foreground(color).Render(char))
			} else {
				row.WriteString(" ")
			}
		}
		pieLines = append(pieLines, row.String())
	}

	var legendLines []string
	legendLines = append(legendLines, lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text).Render(legendHeading))
	for i, s := range stats {
		color := m.theme.Text
		if i < len(sliceColors) {
			color = sliceColors[i]
		}
		bullet := lipgloss.NewStyle().Foreground(color).Render("● ")
		label := i18n.Current.SeniorityLabel(s.Label)
		lbl := lipgloss.NewStyle().Foreground(m.theme.Text).Width(18).Render(label)
		cnt := lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(fmt.Sprintf("%4d (%2.0f%%)", s.Count, s.Pct))
		legendLines = append(legendLines, bullet+lbl+cnt)
	}

	if showQualityBadge && m.metrics.QualityBarPct > 0 {
		summaryBadge := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Green).
			Render(fmt.Sprintf(i18n.Current.MeetQualityBar, m.metrics.QualityBarPct))
		legendLines = append(legendLines, "", summaryBadge)
	}

	pieBlock := strings.Join(pieLines, "\n")
	legendBlock := strings.Join(legendLines, "\n")

	chartWithLegend := lipgloss.JoinHorizontal(lipgloss.Center, pieBlock, "    ", legendBlock)

	return padStyle.Render(lipgloss.JoinVertical(lipgloss.Left, sectionTitle, "", chartWithLegend))
}

func (m StatsModel) renderArchetypeChart() string {
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	sectionTitle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	var lines []string
	lines = append(lines, padStyle.Render(sectionTitle.Render(i18n.Current.ArchetypeTitle)))

	if len(m.metrics.Archetypes) == 0 {
		lines = append(lines, padStyle.Render(dimStyle.Render(i18n.Current.NoData)))
		return strings.Join(lines, "\n")
	}

	avail := m.contentWidth()

	maxCount := 0
	counts := make([]string, len(m.metrics.Archetypes))
	countW := archetypeCountW
	for i, a := range m.metrics.Archetypes {
		maxCount = max(maxCount, a.Count)
		counts[i] = fmt.Sprintf("%4d (%.0f%%)", a.Count, a.Pct)
		countW = max(countW, lipgloss.Width(counts[i]))
	}

	fixedCells := func(labelW int) int {
		return labelW + countW + 2*barGapW + archetypeScoreW
	}

	labelW := 26
	if m.width < 90 || m.barWidth(avail, fixedCells(26)) < minReadableBarW {
		labelW = 20
	}
	barMaxW := m.barWidth(avail, fixedCells(labelW))

	for i, a := range m.metrics.Archetypes {
		label := ansi.Truncate(a.Label, labelW-1, "…")

		barW := 0
		if maxCount > 0 {
			barW = a.Count * barMaxW / maxCount
		}
		if barW < 1 && a.Count > 0 {
			barW = 1
		}

		color := m.scoreColor(a.AvgScore)
		barStyle := lipgloss.NewStyle().Foreground(color)
		labelStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Width(labelW)
		countStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(countW)
		scoreStyle := lipgloss.NewStyle().Bold(true).Foreground(color).Width(archetypeScoreW).Align(lipgloss.Right)

		bar := barStyle.Render(strings.Repeat("█", barW))
		lbl := labelStyle.Render(label)
		countStr := countStyle.Render(counts[i])

		scoreStr := "-"
		if a.AvgScore > 0 {
			scoreStr = fmt.Sprintf("★ %.1f/5", a.AvgScore)
		}
		score := scoreStyle.Render(scoreStr)

		lines = append(lines, padStyle.Render(lbl+countStr+" "+bar+" "+score))
	}

	return strings.Join(lines, "\n")
}

func (m StatsModel) renderLabelCountTable(title string, stats []model.LabelCountStat) string {
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	sectionTitle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	var lines []string
	lines = append(lines, padStyle.Render(sectionTitle.Render(title)))

	if len(stats) == 0 {
		lines = append(lines, padStyle.Render(dimStyle.Render(i18n.Current.NoData)))
		return strings.Join(lines, "\n")
	}

	maxCount := 0
	for _, s := range stats {
		if s.Count > maxCount {
			maxCount = s.Count
		}
	}

	counts, countW := countCells(stats, "  %d (%.0f%%)")
	barMaxW := m.barWidth(m.contentWidth(), labelCountW+countW)

	barColors := []lipgloss.Color{
		m.theme.Green,
		m.theme.Blue,
		m.theme.Yellow,
		m.theme.Peach,
		m.theme.Mauve,
		m.theme.Sky,
		m.theme.Red,
		m.theme.Text,
	}

	for i, s := range stats {
		barW := 0
		if maxCount > 0 {
			barW = s.Count * barMaxW / maxCount
		}
		if barW < 1 && s.Count > 0 {
			barW = 1
		}

		color := m.theme.Text
		if i < len(barColors) {
			color = barColors[i]
		}

		label := ansi.Truncate(s.Label, labelCountW-1, "…")

		barStyle := lipgloss.NewStyle().Foreground(color)
		labelStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Width(labelCountW)
		countStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

		bar := barStyle.Render(strings.Repeat("█", barW))
		lbl := labelStyle.Render(label)
		count := countStyle.Render(counts[i])

		lines = append(lines, padStyle.Render(lbl+bar+count))
	}

	return strings.Join(lines, "\n")
}

func (m StatsModel) renderPay() string {
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	sectionTitle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	var lines []string
	lines = append(lines, padStyle.Render(sectionTitle.Render("💰 "+i18n.Current.PayTitle)))

	if m.metrics.Pay.Count == 0 {
		lines = append(lines, padStyle.Render(dimStyle.Render(i18n.Current.NoData)))
		return strings.Join(lines, "\n")
	}

	labelStyle := lipgloss.NewStyle().Foreground(m.theme.Text)
	valueStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Green)
	sepStyle := lipgloss.NewStyle().Foreground(m.theme.Overlay)
	sep := sepStyle.Render("  |  ")

	stats := labelStyle.Render(i18n.Current.PayAvg) +
		valueStyle.Render(formatMoney(m.metrics.Pay.AvgPayMax)) +
		sep +
		labelStyle.Render(i18n.Current.PayMedian) +
		valueStyle.Render(formatMoney(m.metrics.Pay.MedianPayMax)) +
		sep +
		labelStyle.Render(i18n.Current.PayMax) +
		valueStyle.Render(formatMoney(m.metrics.Pay.MaxPayMax))
	lines = append(lines, padStyle.Render(stats))

	info := dimStyle.Render(
		i18n.Current.PayCount + fmt.Sprintf("%d", m.metrics.Pay.Count) +
			"  (" + fmt.Sprintf(i18n.Current.PaySourceSplit, m.metrics.Pay.PostedCount, m.metrics.Pay.EstCount) + ")",
	)
	lines = append(lines, padStyle.Render(info))

	if len(m.metrics.PayHistogram) > 0 {
		lines = append(lines, "")
		histTitle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Peach).Render(i18n.Current.SalaryBandDist)
		lines = append(lines, padStyle.Render(histTitle))

		maxHist := 0
		for _, b := range m.metrics.PayHistogram {
			if b.Count > maxHist {
				maxHist = b.Count
			}
		}

		counts, countW := countCells(m.metrics.PayHistogram, "  %2d (%.0f%%)")
		barMaxW := m.barWidth(m.rightColumnWidth(), payLabelW+countW)

		for i, b := range m.metrics.PayHistogram {
			barW := 0
			if maxHist > 0 {
				barW = b.Count * barMaxW / maxHist
			}
			if barW < 1 && b.Count > 0 {
				barW = 1
			}

			barStyle := lipgloss.NewStyle().Foreground(m.theme.Green)
			labelStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Width(payLabelW)
			countStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

			bar := barStyle.Render(strings.Repeat("█", barW))
			lbl := labelStyle.Render(b.Label)
			cnt := countStyle.Render(counts[i])

			lines = append(lines, padStyle.Render(lbl+bar+cnt))
		}
	}

	return strings.Join(lines, "\n")
}

func formatMoney(v float64) string {
	if v >= 1000 {
		return fmt.Sprintf("$%.0fK", v/1000)
	}
	return fmt.Sprintf("$%.0f", v)
}

func (m StatsModel) renderHelp() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 1)

	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	brand := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("career-ops by santifer.io")

	keys := keyStyle.Render("↑↓") + descStyle.Render(i18n.Current.HelpScroll) +
		keyStyle.Render("PgUp/Dn") + descStyle.Render(i18n.Current.HelpPage) +
		keyStyle.Render("t") + descStyle.Render(i18n.Current.HelpLanguage) +
		keyStyle.Render("Esc") + descStyle.Render(i18n.Current.HelpBack)

	gap := m.width - lipgloss.Width(keys) - lipgloss.Width(brand) - 2
	if gap < 1 {
		gap = 1
	}

	return style.Render(keys + strings.Repeat(" ", gap) + brand)
}

func (m StatsModel) scoreColor(score float64) lipgloss.Color {
	switch {
	case score >= 4.0:
		return m.theme.Green
	case score >= 3.5:
		return m.theme.Sky
	case score >= 3.0:
		return m.theme.Yellow
	case score > 0:
		return m.theme.Peach
	default:
		return m.theme.Subtext
	}
}

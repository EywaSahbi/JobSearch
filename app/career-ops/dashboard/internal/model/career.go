package model

type CareerApplication struct {
	Number               int
	TrackerNumberMissing bool
	Date                 string
	StatusDate           string
	Company              string
	Role                 string
	Status               string
	Score                float64
	ScoreRaw             string
	HasScore             bool
	HasPDF               bool
	ReportPath           string
	ReportNumber         string
	Notes                string
	JobURL               string
	Location             string
	WorkMode             string
	PayRange             string
	PayMax               float64
	PaySource            string
	PostedOn             string
	LastContact          string
	Archetype            string
	TlDr                 string
	Remote               string
	CompEstimate         string
}

type PipelineMetrics struct {
	Total      int
	ByStatus   map[string]int
	AvgScore   float64
	TopScore   float64
	WithPDF    int
	Actionable int
}

type ProgressMetrics struct {
	FunnelStages []FunnelStage

	ScoreBuckets []ScoreBucket

	WeeklyActivity []WeekActivity

	ResponseRate  float64
	InterviewRate float64
	OfferRate     float64

	AvgScore    float64
	TopScore    float64
	TotalOffers int
	ActiveApps  int
}

type FunnelStage struct {
	Label string
	Count int
	Pct   float64
}

type ScoreBucket struct {
	Label string
	Count int
}

type WeekActivity struct {
	Week  string
	Count int
}

type StatsMetrics struct {
	Archetypes    []ArchetypeStat
	WorkModes     []LabelCountStat
	Locations     []LabelCountStat
	Pay           PayStats
	PayHistogram  []LabelCountStat
	ScoreTiers    []LabelCountStat
	SeniorityMix  []LabelCountStat
	QualityBarPct float64
}

type ArchetypeStat struct {
	Label    string
	Count    int
	Pct      float64
	AvgScore float64
}

type LabelCountStat struct {
	Label string
	Count int
	Pct   float64
}

type PayStats struct {
	Count        int
	PostedCount  int
	EstCount     int
	AvgPayMax    float64
	MedianPayMax float64
	MaxPayMax    float64
}

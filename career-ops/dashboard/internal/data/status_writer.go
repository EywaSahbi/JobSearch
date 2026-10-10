package data

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	pendingRepairsMu sync.Mutex
	pendingRepairs   = map[string]struct{ ledger, followup bool }{}
)

func statusWriterScript() (string, error) {
	roots := []string{getRepoRoot()}
	if executable, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			executable = resolved
		}
		roots = append(roots, filepath.Dir(executable), filepath.Dir(filepath.Dir(executable)))
	}
	for _, root := range roots {
		if info, err := os.Stat(filepath.Join(root, "path-resolver.mjs")); err != nil || info.IsDir() {
			continue
		}
		script := filepath.Join(root, "set-status.mjs")
		if info, err := os.Stat(script); err == nil && !info.IsDir() {
			return filepath.Abs(script)
		}
	}
	return "", fmt.Errorf("status updates need set-status.mjs in the career-ops checkout")
}

func runStatusWriter(dataRoot, report, status, note string) error {
	script, err := statusWriterScript()
	if err != nil {
		return err
	}
	tracker, err := canonicalPath(resolveTrackerPath(dataRoot))
	if err != nil {
		return fmt.Errorf("resolve tracker path: %w", err)
	}
	root, err := filepath.Abs(dataRoot)
	if err != nil {
		return err
	}
	args := []string{script, "--report-link", report, status, "--json"}
	repairKey := tracker + "\x00" + report
	if strings.EqualFold(status, "applied") {
		pendingRepairsMu.Lock()
		pending := pendingRepairs[repairKey]
		pendingRepairsMu.Unlock()
		if pending.ledger {
			args = append(args, "--repair-status-log")
		}
		if pending.followup {
			args = append(args, "--repair-followup")
		}
	}
	markPending := func(ledger, followup bool) {
		pendingRepairsMu.Lock()
		defer pendingRepairsMu.Unlock()
		p := pendingRepairs[repairKey]
		p.ledger = p.ledger || ledger
		p.followup = p.followup || followup
		pendingRepairs[repairKey] = p
	}
	if note != "" {
		args = append(args, "--note="+note)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", args...)
	cmd.Dir = filepath.Dir(script)
	boundedWait := func(name string) string {
		wait := envMilliseconds(name, 10*time.Second)
		if wait > 10*time.Second {
			wait = 10 * time.Second
		}
		return strconv.FormatInt(wait.Milliseconds(), 10)
	}
	cmd.Env = append(cmd.Environ(), "CAREER_OPS_ROOT="+root, "CAREER_OPS_TRACKER="+tracker,
		"CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS="+boundedWait("CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS"),
		"CAREER_OPS_FOLLOWUPS_LOCK_TIMEOUT_MS="+boundedWait("CAREER_OPS_FOLLOWUPS_LOCK_TIMEOUT_MS"))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, runErr := cmd.Output()
	if ctx.Err() != nil {
		return fmt.Errorf("status update timed out; the change may or may not have been applied")
	}
	var result struct {
		Changed         *bool  `json:"changed"`
		NewStatus       string `json:"newStatus"`
		Error           string `json:"error"`
		StatusLogged    *bool  `json:"statusLogged"`
		StatusLogRepair *struct {
			Repaired bool   `json:"repaired"`
			Error    string `json:"error"`
		} `json:"statusLogRepair"`
		FollowupSeeded *struct {
			Reason string `json:"reason"`
			Error  string `json:"error"`
		} `json:"followupSeeded"`
	}
	parseErr := json.Unmarshal(stdout, &result)
	if result.Error != "" {
		return fmt.Errorf("status update: %s", result.Error)
	}
	if runErr != nil {
		return fmt.Errorf("run set-status.mjs: %w: %s", runErr, strings.TrimSpace(stderr.String()))
	}
	if parseErr != nil || result.Changed == nil || result.NewStatus == "" {
		return fmt.Errorf("set-status.mjs returned no valid result; reload to check whether the change was applied")
	}
	if result.StatusLogged != nil && !*result.StatusLogged {
		markPending(true, false)
		return fmt.Errorf("status saved, but status-log append failed: %s", strings.TrimSpace(stderr.String()))
	}
	if repair := result.StatusLogRepair; repair != nil && repair.Error != "" {
		markPending(true, false)
		return fmt.Errorf("status saved, but status-log repair failed: %s", repair.Error)
	}
	if seed := result.FollowupSeeded; seed != nil && seed.Reason == "error" {
		markPending(false, true)
		return fmt.Errorf("status saved, but follow-up seeding failed: %s", seed.Error)
	}
	pendingRepairsMu.Lock()
	delete(pendingRepairs, repairKey)
	pendingRepairsMu.Unlock()
	return nil
}

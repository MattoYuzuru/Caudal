package control

import (
	"strings"
	"testing"

	"github.com/MattoYuzuru/Caudal/internal/fleet"
)

func TestLocalAssistantUsesFreshMeasurements(t *testing.T) {
	nodes := []fleet.Node{
		{Name: "Fresh A", Status: "healthy", Metrics: &fleet.Metrics{MemoryTotal: 6 << 30, MemoryUsedBytes: 4 << 30, DiskTotal: 4 << 30, CPUPercent: 20}},
		{Name: "Fresh B", Status: "healthy", Metrics: &fleet.Metrics{MemoryTotal: 6 << 30, MemoryUsedBytes: 1 << 30, DiskTotal: 2 << 30, CPUPercent: 15}},
		{Name: "Old node", Status: "stale", Metrics: &fleet.Metrics{MemoryTotal: 8 << 30, DiskTotal: 8 << 30, CPUPercent: 90}},
		{Name: "New node", Status: "pending"},
	}
	for _, check := range []struct{ query, want string }{
		{"Где больше свободной памяти?", "у Fresh B — 5.00 ГиБ"},
		{"Где свободен диск?", "у Fresh A — 4.00 ГиБ"},
		{"Проверь CPU", "у Fresh A — 20.0%"},
		{"Что требует внимания?", "Old node — последний замер устарел"},
		{"Что пока готовится?", "New node — ждём первый сигнал"},
	} {
		if result := localAnswer(check.query, nodes); !strings.Contains(result, check.want) {
			t.Errorf("wrong local answer for %q: %s", check.query, result)
		}
	}
	if result := localAnswer("С чего начать?", nil); !strings.Contains(result, "Пока нет") {
		t.Fatalf("empty reply: %s", result)
	}
	if result := localAnswer("Что происходит?", nodes[:1]); !strings.Contains(result, "CPU 20.0%") {
		t.Fatalf("node-scoped reply: %s", result)
	}
}

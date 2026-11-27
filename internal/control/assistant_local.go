package control

import (
	"fmt"
	"strings"

	"github.com/MattoYuzuru/Caudal/internal/fleet"
)

func localAnswer(question string, nodes []fleet.Node) string {
	if len(nodes) == 0 {
		return "Пока нет подключённых узлов. Откройте «Маршруты», чтобы пройти пробный сценарий или зарегистрировать сборщик."
	}

	var answer strings.Builder
	var fresh, stale, pending int
	var mostFreeMemory, mostFreeDisk, highestCPU *fleet.Node
	for i := range nodes {
		node := &nodes[i]
		switch node.Status {
		case "healthy":
			fresh++
			if node.Metrics == nil {
				continue
			}
			if mostFreeMemory == nil || freeMemory(node) > freeMemory(mostFreeMemory) {
				mostFreeMemory = node
			}
			if mostFreeDisk == nil || freeDisk(node) > freeDisk(mostFreeDisk) {
				mostFreeDisk = node
			}
			if highestCPU == nil || node.Metrics.CPUPercent > highestCPU.Metrics.CPUPercent {
				highestCPU = node
			}
		case "stale":
			stale++
		case "pending":
			pending++
		}
	}

	question = strings.ToLower(question)
	switch {
	case mostFreeMemory != nil && containsAny(question, "памят", "озу", "ram", "memory"):
		fmt.Fprintf(&answer, "Больше всего свободной RAM по свежим замерам у %s — %.2f ГиБ.\n\n",
			mostFreeMemory.Name, gib(freeMemory(mostFreeMemory)))
	case mostFreeDisk != nil && containsAny(question, "диск", "disk", "storage"):
		fmt.Fprintf(&answer, "Больше всего места на корневом диске у %s — %.2f ГиБ свободно.\n\n",
			mostFreeDisk.Name, gib(freeDisk(mostFreeDisk)))
	case highestCPU != nil && containsAny(question, "cpu", "процессор", "нагруз"):
		fmt.Fprintf(&answer, "Наибольшая загрузка CPU по свежим замерам у %s — %.1f%%.\n\n",
			highestCPU.Name, highestCPU.Metrics.CPUPercent)
	}
	fmt.Fprintf(&answer, "Свежий сигнал: %d · данные устарели: %d · в ожидании: %d.", fresh, stale, pending)
	for _, node := range nodes {
		switch {
		case node.Status == "stale":
			fmt.Fprintf(&answer, "\n• %s — последний замер устарел.", node.Name)
		case node.Status == "pending":
			fmt.Fprintf(&answer, "\n• %s — ждём первый сигнал сборщика.", node.Name)
		case len(nodes) == 1 && node.Metrics != nil:
			fmt.Fprintf(&answer, "\n• %s — CPU %.1f%%, свободно %.2f ГиБ RAM и %.2f ГиБ на корневом диске.",
				node.Name, node.Metrics.CPUPercent, gib(freeMemory(&node)), gib(freeDisk(&node)))
		}
	}
	answer.WriteString("\n\nЛокальная сводка использует замеры сборщиков. Для свободного вопроса выберите DeepSeek.")
	return answer.String()
}

func containsAny(s string, parts ...string) bool {
	for _, part := range parts {
		if strings.Contains(s, part) {
			return true
		}
	}
	return false
}

func freeMemory(node *fleet.Node) uint64 {
	return node.Metrics.MemoryTotal - node.Metrics.MemoryUsedBytes
}

func freeDisk(node *fleet.Node) uint64 {
	return node.Metrics.DiskTotal - node.Metrics.DiskUsedBytes
}

func gib(bytes uint64) float64 { return float64(bytes) / (1 << 30) }

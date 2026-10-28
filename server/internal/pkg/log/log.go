// Package log 是自写的轻量结构化 logger（零第三方依赖，不 import zap）。
// 契约（docs/bridge-design.md §6）：每组件 logger 自带 {"c":"egress"} 组件名，
// 一行一事件（JSON lines）写 stdout，轮转/检索交给 journald。
package log

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

// Level 日志级别。
type Level int

const (
	DebugLevel Level = iota
	InfoLevel
	WarnLevel
	ErrorLevel
)

func (l Level) String() string {
	switch l {
	case DebugLevel:
		return "DEBUG"
	case InfoLevel:
		return "INFO"
	case WarnLevel:
		return "WARN"
	case ErrorLevel:
		return "ERROR"
	}
	return "UNKNOWN"
}

// Redactor 是脱敏值的接口：实现 String() 的值在输出时自动脱敏。
type Redactor interface {
	Redacted() string
}

// redactedString 包装一个已脱敏的字符串，用于输出。
type redactedString struct{ s string }

func (r redactedString) String() string    { return r.s }
func (r redactedString) MarshalJSON() ([]byte, error) { return json.Marshal(r.s) }

// RedactPhone 手机号脱敏：保留前 3 后 4（138****1234）；不足 7 位则全遮蔽。
func RedactPhone(p string) Redactor {
	if len(p) < 7 {
		return redactedString{"****"}
	}
	return redactedString{p[:3] + "****" + p[len(p)-4:]}
}

// RedactToken token 脱敏：只保留前 8 位，其余以 "…" 省略；过短则全遮蔽。
func RedactToken(t string) Redactor {
	if len(t) <= 8 {
		return redactedString{"****"}
	}
	return redactedString{t[:8] + "…"}
}

// Logger 带组件名的结构化 logger。零值不可用，请通过 For() 获取。
type Logger struct {
	component string
}

var (
	mu       sync.RWMutex
	minLevel = InfoLevel
	out      = os.Stdout
)

// SetLevel 设置全局最低输出级别（可被 SIGHUP 热重载白名单调用）。
func SetLevel(l Level) {
	mu.Lock()
	minLevel = l
	mu.Unlock()
}

// SetOutput 重定向输出（仅测试使用）。
func SetOutput(f *os.File) {
	mu.Lock()
	out = f
	mu.Unlock()
}

// For 返回带组件名的 logger，如 log.For("egress")。
func For(component string) *Logger { return &Logger{component: component} }

func (g *Logger) log(level Level, msg string, kv ...any) {
	mu.RLock()
	allowed := level >= minLevel
	w := out
	mu.RUnlock()
	if !allowed {
		return
	}
	rec := make(map[string]json.RawMessage, 5+len(kv)/2)
	put := func(k string, v any) {
		var b []byte
		if r, ok := v.(Redactor); ok {
			b, _ = json.Marshal(r.Redacted())
		} else {
			b, _ = json.Marshal(v)
		}
		rec[k] = b
	}
	var fields map[string]json.RawMessage
	if len(kv) > 0 {
		fields = make(map[string]json.RawMessage, len(kv)/2)
		for i := 0; i+1 < len(kv); i += 2 {
			k, ok := kv[i].(string)
			if !ok {
				k = fmt.Sprintf("%v", kv[i])
			}
			var b []byte
			if r, isR := kv[i+1].(Redactor); isR {
				b, _ = json.Marshal(r.Redacted())
			} else {
				b, _ = json.Marshal(kv[i+1])
			}
			fields[k] = b
		}
	}
	fb, _ := json.Marshal(fields)
	rec["ts"] = json.RawMessage(`"` + time.Now().UTC().Format(time.RFC3339Nano) + `"`)
	rec["level"] = json.RawMessage(`"` + level.String() + `"`)
	rec["component"] = json.RawMessage(`"` + g.component + `"`)
	rec["msg"] = json.RawMessage(mustJSON(msg))
	rec["fields"] = fb
	line, err := json.Marshal(rec)
	if err != nil {
		return
	}
	mu.Lock()
	w.Write(append(line, '\n'))
	mu.Unlock()
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// Debug 记录 DEBUG 级别事件，kv 为 key/value 变长参数。
func (g *Logger) Debug(msg string, kv ...any) { g.log(DebugLevel, msg, kv...) }

// Info 记录 INFO 级别事件（转发日志按 kind 采样由调用方负责）。
func (g *Logger) Info(msg string, kv ...any) { g.log(InfoLevel, msg, kv...) }

// Warn 记录 WARN 级别事件，全量不采样。
func (g *Logger) Warn(msg string, kv ...any) { g.log(WarnLevel, msg, kv...) }

// Error 记录 ERROR 级别事件，全量不采样。
func (g *Logger) Error(msg string, kv ...any) { g.log(ErrorLevel, msg, kv...) }

// Package main 是 chatd embedded 模式装配入口（零逻辑）：
// 读简化 TOML 配置 → 构造 stub 层（后续批次替换为真实 user/data/admin 层）
// → 装配 bridge 流水线 + supervisor → 运行。
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/yingo-server/OpenChat/server/internal/bridge"
	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
	"github.com/yingo-server/OpenChat/server/internal/proto"
	chatpb "github.com/yingo-server/OpenChat/server/internal/proto/gen/chatpb"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
	"github.com/yingo-server/OpenChat/server/internal/transport"
	"github.com/yingo-server/OpenChat/server/internal/transport/embedded"
)

type config struct {
	Mode      string // embedded | split
	Listen    string // bridge 监听地址
	LogLevel  string // debug|info|warn|error
	AdminAddr string // AdminAPI HTTP 监听地址（空=不启）
}

func main() {
	cfg, err := loadConfig("config/chatd.toml")
	if err != nil {
		fmt.Fprintln(os.Stderr, "chatd: config:", err)
		os.Exit(1) // 配置不可用
	}
	setLogLevel(cfg.LogLevel)
	lg := log.For("chatd")
	lg.Info("starting", "mode", cfg.Mode, "listen", cfg.Listen)

	if cfg.Mode != "" && cfg.Mode != "embedded" {
		fmt.Fprintln(os.Stderr, "chatd: unsupported mode (this build is embedded-only):", cfg.Mode)
		os.Exit(1)
	}

	// stub 层：本批次占位，后续批次替换为真实层实现。
	br := embedded.NewBridge(nil)
	_ = br.Attach(stubLayer("data"))  // data 层 stub
	_ = br.Attach(stubLayer("admin")) // admin 层 stub

	pl, err := bridge.Assemble(bridge.Config{Sender: br.SendTo}, br.Peer())
	if err != nil {
		fmt.Fprintln(os.Stderr, "chatd: assemble:", err)
		os.Exit(2) // 装配失败
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		if err := pl.Run(ctx); err != nil {
			lg.Warn("pipeline exited", "err", err.Error())
		}
	}()

	lg.Info("ready", "mode", "embedded")
	// 信号→事件全部由 pipeline 内 supervisor 处理；main 阻塞等待。
	select {}
}

// stubLayer 最小 echo 层：Deliver → 回投 ack；Outbound 静默。
type stub struct {
	name    string
	got     chan *proto.Frame
	out     chan *proto.Frame
	closeCh chan struct{}
}

func stubLayer(name string) transport.Layer {
	return &stub{
		name:    name,
		got:     make(chan *proto.Frame, 64),
		out:     make(chan *proto.Frame, 64),
		closeCh: make(chan struct{}),
	}
}

func (s *stub) LayerName() string { return s.name }
func (s *stub) Deliver(f *proto.Frame) error {
	resp := &proto.Frame{
		Kind: kinds.KindFlagSync,
		Env: &chatpb.Envelope{
			Kind:      uint32(kinds.KindFlagSync),
			RequestId: f.Env.GetRequestId(),
		},
		Meta: &proto.FrameMeta{SrcLayer: s.name, TraceID: f.Meta.TraceID, ConnID: f.Meta.ConnID},
	}
	select {
	case s.out <- resp:
	default:
	}
	return nil
}
func (s *stub) Outbound() <-chan *proto.Frame { return s.out }
func (s *stub) Close() error {
	select {
	case <-s.closeCh:
	default:
		close(s.closeCh)
	}
	return nil
}

// ---- mini TOML parser：只解析本文件所需 key=value 行 ----

func loadConfig(path string) (config, error) {
	cfg := config{Mode: "embedded", LogLevel: "info"}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil // 全默认
		}
		return cfg, err
	}
	var section string
	for _, line := range splitLines(string(data)) {
		line = trimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		if line[0] == '[' && line[len(line)-1] == ']' {
			section = line[1 : len(line)-1]
			_ = section
			continue
		}
		k, v, ok := splitKV(line)
		if !ok {
			continue
		}
		switch k {
		case "mode":
			cfg.Mode = v
		case "listen", "bridge_listen", "address":
			cfg.Listen = v
		case "log_level":
			cfg.LogLevel = v
		case "admin_listen":
			cfg.AdminAddr = v
		}
	}
	return cfg, nil
}

func setLogLevel(s string) {
	switch s {
	case "debug":
		log.SetLevel(log.DebugLevel)
	case "warn":
		log.SetLevel(log.WarnLevel)
	case "error":
		log.SetLevel(log.ErrorLevel)
	default:
		log.SetLevel(log.InfoLevel)
	}
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

func trimSpace(s string) string {
	i, j := 0, len(s)
	for i < j && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r') {
		i++
	}
	for j > i && (s[j-1] == ' ' || s[j-1] == '\t' || s[j-1] == '\r') {
		j--
	}
	return s[i:j]
}

func splitKV(line string) (string, string, bool) {
	for i := 0; i < len(line); i++ {
		if line[i] == '=' {
			k := trimSpace(line[:i])
			v := trimSpace(line[i+1:])
			if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
				v = v[1 : len(v)-1]
			}
			return k, v, true
		}
	}
	return "", "", false
}

# OpenChat 构建骨架。目标说明见 docs/architecture.md 实施顺序节。
SHELL := /bin/bash

PROTO_DIR     := proto
GEN_DIR       := server/internal/proto/gen/chatpb
DIST_DIR      := dist
BIN           := chatd

# protoc 生成到 internal/proto/gen/chatpb；source_relative 保证 import 路径与目录一致。
.PHONY: proto build test lint web release clean

proto:
	protoc \
		--go_out=server/internal/proto/gen \
		--go_opt=paths=source_relative \
		--go_opt=M$(PROTO_DIR)/chat.proto=github.com/yingo-server/OpenChat/$(GEN_DIR) \
		$(PROTO_DIR)/chat.proto

build: proto
	go build ./...

test:
	go test ./... -race -count=1

lint:
	go vet ./...
	@fmt_out=$$(gofmt -l server/); \
	if [ -n "$$fmt_out" ]; then \
		echo "gofmt 需要格式化的文件:"; echo "$$fmt_out"; exit 1; \
	fi

web:
	cd apps/client && npm ci && npm run build

release: web
	mkdir -p $(DIST_DIR)
	go build -trimpath -ldflags "-s -w" -o $(DIST_DIR)/$(BIN) ./server/cmd/chatd

clean:
	rm -rf $(DIST_DIR) $(GEN_DIR)

# OpenChat 构建骨架。目标说明见 docs/architecture.md 实施顺序节。
SHELL := /bin/bash

PROTO_DIR     := proto
GEN_DIR       := server/internal/proto/gen/chatpb
DIST_DIR      := dist
BIN           := chatd
CLIENT_DIR    := apps/client
ADMIN_DIR     := apps/admin
WEB_EMBED_DIR := server/web/dist

# protoc 生成到 internal/proto/gen/chatpb；source_relative 保证 import 路径与目录一致。
.PHONY: proto build test lint web admin-web release release-all clean

# proto: 生成 chatpb。无 protoc 时保留仓库内已提交的 wire 兼容实现
# (server/internal/proto/gen/chatpb)，代码照常构建。
proto:
	@command -v protoc >/dev/null 2>&1 || { \
		echo "protoc not found: keeping committed chatpb implementation"; exit 0; }
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

# 用户端：apps/client 尚未落地时跳过（CI 里目录存在则正常构建）
web:
	@if [ -f $(CLIENT_DIR)/package.json ]; then \
		cd $(CLIENT_DIR) && npm ci && npm run build; \
	else \
		echo "skip web: $(CLIENT_DIR) not present yet"; \
	fi

# 管理后台：独立产物，部署在 /admin/
admin-web:
	cd $(ADMIN_DIR) && npm ci && npm run build

# release: 构建 chatd + 把两端前端产物汇入 server/web/dist（供 Go embed）。
# 目录不存在时创建 .gitkeep，保证 embed 指令在未构建前也能编译。
release: web admin-web
	mkdir -p $(WEB_EMBED_DIR)
	@if [ -d $(CLIENT_DIR)/dist ]; then \
		echo "copy $(CLIENT_DIR)/dist -> $(WEB_EMBED_DIR)"; \
		cp -R $(CLIENT_DIR)/dist/. $(WEB_EMBED_DIR)/; \
	else \
		echo "skip copy: $(CLIENT_DIR)/dist not found"; \
	fi
	@if [ -d $(ADMIN_DIR)/dist ]; then \
		echo "copy $(ADMIN_DIR)/dist -> $(WEB_EMBED_DIR)/admin"; \
		mkdir -p $(WEB_EMBED_DIR)/admin; \
		cp -R $(ADMIN_DIR)/dist/. $(WEB_EMBED_DIR)/admin/; \
	fi
	@test -n "$$(ls -A $(WEB_EMBED_DIR) 2>/dev/null)" || touch $(WEB_EMBED_DIR)/.gitkeep
	mkdir -p $(DIST_DIR)
	go build -trimpath -ldflags "-s -w" -o $(DIST_DIR)/$(BIN) ./server/cmd/chatd

# release-all: 两端前端 + 全部 Go 二进制 + 发布包（tar.gz + SHA256SUMS）
release-all: admin-web
	@if [ -f $(CLIENT_DIR)/package.json ]; then \
		cd $(CLIENT_DIR) && npm ci && npm run build; \
	else \
		echo "skip client build: $(CLIENT_DIR) not present yet"; \
	fi
	mkdir -p $(DIST_DIR) $(WEB_EMBED_DIR) $(WEB_EMBED_DIR)/admin
	@if [ -d $(CLIENT_DIR)/dist ]; then cp -R $(CLIENT_DIR)/dist/. $(WEB_EMBED_DIR)/; fi
	@if [ -d $(ADMIN_DIR)/dist ]; then cp -R $(ADMIN_DIR)/dist/. $(WEB_EMBED_DIR)/admin/; fi
	@test -n "$$(ls -A $(WEB_EMBED_DIR) 2>/dev/null)" || touch $(WEB_EMBED_DIR)/.gitkeep
	go build -trimpath -ldflags "-s -w" -o $(DIST_DIR)/$(BIN) ./server/cmd/chatd
	@ver=$$(git describe --tags --always --dirty 2>/dev/null || date -u +%Y%m%d%H%M%S); \
	 stage=$(DIST_DIR)/pkg-$$ver; \
	 rm -rf "$$stage"; mkdir -p "$$stage/bin" "$$stage/web" "$$stage/deploy"; \
	 install -m 0755 $(DIST_DIR)/$(BIN) "$$stage/bin/$(BIN)"; \
	 if [ -d $(WEB_EMBED_DIR) ]; then cp -R $(WEB_EMBED_DIR)/. "$$stage/web/"; fi; \
	 cp -R deploy/systemd deploy/policy.json deploy/openchat.toml deploy/Caddyfile deploy/install.sh "$$stage/deploy/"; \
	 tar -czf "$(DIST_DIR)/openchat-$$ver.tar.gz" -C "$$stage" .; \
	 cd $(DIST_DIR) && sha256sum "openchat-$$ver.tar.gz" > SHA256SUMS; \
	 echo "release artifact: $(DIST_DIR)/openchat-$$ver.tar.gz"

clean:
	rm -rf $(DIST_DIR) $(GEN_DIR)

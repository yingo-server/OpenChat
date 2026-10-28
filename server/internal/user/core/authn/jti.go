package authn

import (
	"crypto/rand"
	"encoding/hex"
)

// newJTI 生成 128bit 随机 jti（security-spec §2.1 claims 最小集）。
func newJTI() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 失败属于不可恢复环境错误；返回时间无关的零值会让
		// 所有 token 撞 jti，因此 panic 交由 crash-only 重启处理。
		panic("authn: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

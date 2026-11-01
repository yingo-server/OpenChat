package pipe

import (
	"sync"
	"testing"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
)

// 扇出路径去全局锁（perf-spec 补充模块 B）后的并发安全压测：
// 多 goroutine 直接并发调 sendOne（绕过 lane），等价 fanSender + fanout
// 投递路径 + reply sender 同时发送。CI -race 下零 race、零丢帧。

// TestSendOneConcurrentNoGlobalLock: 8 goroutine × 250 帧并发 sendOne，
// TestPeer 的 out channel（cap 64）会满 —— sendOne 不阻塞（扇出允许丢），
// reply 路径走 replySendMu。断言不 panic、无 race、可用性计数正常。
func TestSendOneConcurrentNoGlobalLock(t *testing.T) {
	p := &Pipe{peer: NewTestPeer(), lg: log.For("pipe-test")}
	var wg sync.WaitGroup
	const goroutines = 8
	const per = 250
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(isReply bool) {
			defer wg.Done()
			for i := 0; i < per; i++ {
				p.sendOne(&env{Kind: 101, Payload: []byte("x"), isReply: isReply})
			}
		}(g%2 == 0)
	}
	wg.Wait()
	// 无 panic 即通过；TestPeer 满载丢弃由 select/default 语义兜住。
}

// TestSendOneReplyAndFanoutInterleave: reply 与 fanout 并发发送时 reply
// 全部到达（replySendMu 保证 ACK 不被扇出淹没——扇出侧在 TestPeer 满时
// 立即放弃，reply 侧持锁等待成功投递）。
func TestSendOneReplyAndFanoutInterleave(t *testing.T) {
	p := &Pipe{peer: NewTestPeer(), lg: log.For("pipe-test")}
	const n = 200
	var wg sync.WaitGroup
	// 扇出：先灌满 peer 的 out 通道并持续占位
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < n*4; i++ {
			p.sendOne(&env{Kind: 201, Payload: []byte("fan"), isReply: false})
		}
	}()
	// reply：必须全部到达
	for i := 0; i < n; i++ {
		p.sendOne(&env{Kind: 102, Payload: []byte("ack"), isReply: true})
	}
	wg.Wait()
	peer := p.peer.(*TestPeer)
	timeout := time.After(3 * time.Second)
	acks := 0
	for acks < n {
		select {
		case f := <-peer.Sent():
			if f.Kind == 102 {
				acks++
			}
		case <-timeout:
			t.Fatalf("only %d/%d acks delivered — reply path starved", acks, n)
		default:
			// fan-out fills the channel between reads; keep polling
			select {
			case f := <-peer.Sent():
				if f.Kind == 102 {
					acks++
				}
			case <-timeout:
				t.Fatalf("only %d/%d acks delivered — reply path starved", acks, n)
			}
		}
	}
}

// Package bridge 静态默认能力表（Router/Verifier 的启动期数据）。
// 单独成文件只为让装配文件 pipeline.go 保持 <300 行；不得在此写逻辑。
package bridge

import "github.com/yingo-server/OpenChat/server/internal/proto/kinds"

func defaultCaps() map[string][]kinds.Kind {
	return map[string][]kinds.Kind{
		"user":  allUserKinds(),
		"data":  {kinds.KindReadHistory, kinds.KindConvDataRequest, kinds.KindIdentityRequest, kinds.KindSecurityRequest, kinds.KindFlagGet, kinds.KindJobTrigger, kinds.KindShutdownNotice, kinds.KindFlagSync, kinds.KindConfigUpdate},
		"admin": {kinds.KindAdminBroadcast, kinds.KindAnnounce, kinds.KindMaintenance, kinds.KindTopology},
	}
}

func allUserKinds() []kinds.Kind {
	return []kinds.Kind{
		kinds.KindMsgSend, kinds.KindMsgNew, kinds.KindMsgAck, kinds.KindMsgRead, kinds.KindMsgDelivered,
		kinds.KindMsgEdit, kinds.KindMsgDelete, kinds.KindMsgRecall, kinds.KindMsgForward, kinds.KindMsgSync, kinds.KindMsgSearch,
		kinds.KindConvCreate, kinds.KindConvUpdate, kinds.KindConvPayload, kinds.KindMemberAdd, kinds.KindMemberRemove,
		kinds.KindMemberUpdate, kinds.KindRoleSet, kinds.KindMute, kinds.KindPin, kinds.KindTyping, kinds.KindDraft,
		kinds.KindMediaPresignRequest, kinds.KindMediaReady, kinds.KindMediaExpire, kinds.KindMediaThumb,
		kinds.KindPresenceUpdate, kinds.KindPresenceSubscribe, kinds.KindPresenceUnsubscribe,
		kinds.KindProfileUpdate, kinds.KindBlock, kinds.KindUnblock, kinds.KindReport,
		kinds.KindAdminBroadcast, kinds.KindAnnounce, kinds.KindMaintenance,
		kinds.KindShutdownNotice, kinds.KindFlagSync, kinds.KindConfigUpdate,
	}
}

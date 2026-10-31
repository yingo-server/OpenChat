/**
 * 通话领域类型（§ WebRTC 1v1）。
 *
 * 纯类型，无 React / 无浏览器 API 依赖，可被 net / core / ui 任意层引用。
 */

export type CallState = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

export type CallMedia = 'audio' | 'video';

/**
 * 一次通话的静态描述。
 * startedAt：发起/接听时间（ms）；endedAt + endReason：结束时间与原因（ended 状态时填充）。
 */
export interface CallInfo {
  callId: string;
  convId: number;
  peerUserId: number;
  media: CallMedia;
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
}

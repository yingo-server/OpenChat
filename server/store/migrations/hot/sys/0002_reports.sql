-- sys domain (hot, SQLite). 0002: report queue projection (ADDITIVE ONLY).
--
-- Why a hot table exists at all: 冷库 sys.reports 是权威投影（sys schema），
-- 但装配允许「无冷库」的降级部署（单机 embedded / 开发 / 灾备只读副本）。
-- 冷库缺失时，管理面的 reports 读写由本表承担；冷库接入后本表仍是
-- admin 侧的本地投影（写入 → 960 report.handle 帧 → 数据层落冷库）。
--
-- 列与 cold/sys/0001 的 sys.reports 一一对应，另加 note（处理备注）：
-- 冷库 DDL 目前没有 note 列，接入时随下一个 cold 迁移补充。
CREATE TABLE IF NOT EXISTS sys_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter    INTEGER NOT NULL,
    target_msg  INTEGER NOT NULL DEFAULT 0,
    target_user INTEGER NOT NULL DEFAULT 0,
    reason      TEXT    NOT NULL DEFAULT '',
    status      INTEGER NOT NULL DEFAULT 0,   -- 0 pending / 1 handling / 2 resolved / 3 rejected
    handled_by  TEXT,
    note        TEXT,
    at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sys_reports_status   ON sys_reports (status, at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_reports_reporter ON sys_reports (reporter, at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_reports_target   ON sys_reports (target_msg);

/**
 * 极简 i18n：零第三方依赖，key → 文案，{name} 插值。
 * 新增语言 = 新增平行 catalog + setLocale；组件不感知语言。
 */
import { zhCN, type I18nKey } from './zh-CN';

export type { I18nKey };

const catalogs: Record<string, Record<string, string>> = {
  'zh-CN': zhCN,
};

let locale = 'zh-CN';

export function setLocale(next: string): void {
  if (catalogs[next]) locale = next;
}

export function getLocale(): string {
  return locale;
}

/**
 * t 接受 string 以支持后端下发的动态 key（如 toast code），
 * 静态文案请使用 I18nKey 获得编译期校验。
 */
export function t(key: I18nKey | string, params?: Record<string, string | number>): string {
  const template = catalogs[locale]?.[key] ?? catalogs['zh-CN']?.[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] === undefined ? match : String(params[name]),
  );
}

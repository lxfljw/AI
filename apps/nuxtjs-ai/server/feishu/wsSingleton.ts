const WS_STARTED_KEY = "__feishuWsStarted__";

/** 防止 dev 热重载 / 插件重复执行导致多条长连接 */
export function markFeishuWsStarted(): boolean {
  const g = globalThis as typeof globalThis & {
    [WS_STARTED_KEY]?: boolean;
  };
  if (g[WS_STARTED_KEY]) return false;
  g[WS_STARTED_KEY] = true;
  return true;
}

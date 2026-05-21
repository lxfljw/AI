import * as Lark from "@larksuiteoapi/node-sdk";
import { createFeishuEventDispatcher } from "./events";
import { markFeishuWsStarted } from "./wsSingleton";

export interface FeishuWsOptions {
  appId: string;
  appSecret: string;
}

/** 飞书长连接：服务启动时由 plugins/feishu-ws.ts 调用 */
export function startFeishuWs({ appId, appSecret }: FeishuWsOptions) {
  if (!markFeishuWsStarted()) {
    console.warn("[feishu-ws] 长连接已存在，跳过重复启动（常见于 pnpm dev 热重载）");
    return;
  }

  const baseConfig = { appId, appSecret };

  const client = new Lark.Client(baseConfig);
  const wsClient = new Lark.WSClient({
    ...baseConfig,
    loggerLevel: Lark.LoggerLevel.debug,
  });

  const eventDispatcher = createFeishuEventDispatcher(client);

  wsClient.start({ eventDispatcher });
  console.log("[feishu-ws] 飞书长连接已启动（无需配置 Webhook POST 地址）");
}

import * as Lark from "@larksuiteoapi/node-sdk";

export interface FeishuWsOptions {
  appId: string;
  appSecret: string;
}

/** 飞书长连接：服务启动时调用，勿放在 api 路由里 */
export function startFeishuWs({ appId, appSecret }: FeishuWsOptions) {
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      console.log("[feishu-ws] im.message.receive_v1", JSON.stringify(data));
    },
  });

  const wsClient = new Lark.WSClient({ appId, appSecret });
  wsClient.start({ eventDispatcher });
  console.log("[feishu-ws] 飞书长连接已启动（无需配置 Webhook POST 地址）");
}

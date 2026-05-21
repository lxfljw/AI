import { startFeishuWs } from "../feishu/ws";

export default defineNitroPlugin(() => {
  const { feishuAppId, feishuAppSecret } = useRuntimeConfig();

  const appId = String(feishuAppId ?? "").trim();
  const appSecret = String(feishuAppSecret ?? "").trim();

  if (!appId || !appSecret) {
    console.warn(
      "[feishu-ws] 未配置 NUXT_FEISHU_APP_ID / NUXT_FEISHU_APP_SECRET，长连接未启动",
    );
    return;
  }

  startFeishuWs({ appId, appSecret });
});

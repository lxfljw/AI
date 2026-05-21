import type * as Lark from "@larksuiteoapi/node-sdk";
import { onImMessageReceiveV1 } from "./imMessageReceive";

/**
 * 飞书长连接事件表：新增事件时
 * 1. 在 handlers/ 下新建 xxx.ts 实现 onXxx(client, data)
 * 2. 在此文件 register 里加一行
 */
export function buildFeishuEventHandlers(client: Lark.Client) {
  return {
    "im.message.receive_v1": async (data: unknown) => {
      await onImMessageReceiveV1(client, data);
    },
    // 示例：卡片回调
    // "card.action.trigger": async (data: unknown) => {
    //   await onCardActionTrigger(client, data);
    // },
  };
}

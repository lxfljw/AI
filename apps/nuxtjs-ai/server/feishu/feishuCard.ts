export type FeishuCardTemplate =
  | "blue"
  | "wathet"
  | "turquoise"
  | "green"
  | "red"
  | "orange"
  | "purple"
  | "grey";

export interface FeishuInteractiveMessagePayload {
  msg_type: "interactive";
  content: string;
}

const CARD_BODY_MAX = 12_000;

/** 飞书卡片正文过长时截断，避免超 API 限制 */
function truncateCardBody(body: string): string {
  if (body.length <= CARD_BODY_MAX) return body;
  return `${body.slice(0, CARD_BODY_MAX)}\n\n…（内容过长已截断）`;
}

/**
 * 构造飞书消息卡片（schema 2.0）content 字符串
 * @see https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure
 */
export function buildFeishuCardContent(options: {
  title: string;
  body: string;
  template?: FeishuCardTemplate;
}): FeishuInteractiveMessagePayload {
  const card = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: options.title,
      },
      template: options.template ?? "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: truncateCardBody(options.body),
        },
      ],
    },
  };

  return {
    msg_type: "interactive",
    content: JSON.stringify(card),
  };
}

export function buildProcessingCardBody(userText: string): string {
  return `**您的问题**\n${userText}\n\n正在生成回答，请稍候…`;
}

export function buildAnswerCardBody(answer: string): string {
  return answer.trim() || "（无回复内容）";
}

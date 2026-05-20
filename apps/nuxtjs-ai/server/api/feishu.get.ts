/** GET 仅占位（健康检查 / 浏览器直连）；Webhook 请走 POST {@link ./feishu.post.ts} */
export default defineEventHandler(() => ({
  ok: true,
  hint: "飞书回调请使用 POST /api/feishu",
}));

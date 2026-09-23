# Book to Kindle

Cloudflare-first 的自动找书、选版本并发送到 Kindle 的工作流。

> 当前 `stabilize/book-to-kindle-v1` 是稳定化候选分支，不代表已经重新发布为稳定版本。只有完成真实环境回归后，才允许合并 `main` 并重新标记为稳定。

## 当前入口

- Telegram 自然语言文字
- Telegram 书封面 / 截图
- HTTP API
- `/send <书名>` 等确定性命令

## 当前架构

```text
Telegram free-form text
  -> webhook validates + claims update
  -> Queue: telegram_assistant_text
  -> Workers AI understands intent/context
  -> entity grounding against user text/history
  -> deterministic code tool
       reply / author catalog / book info / status / book task

Telegram image
  -> Queue: telegram_image
  -> Workers AI vision
  -> confirm/select recognized book
  -> book task

HTTP / Telegram book task
  -> D1 task
  -> Queue: book
  -> execution lease
  -> Open Library + Google Books resolver
  -> source searches
  -> shared relevance gate
  -> rank + deduplicate
  -> download
  -> R2 temporary staging
  -> Gmail delivery fence
  -> Send to Kindle
```

## AI 与代码的边界

AI 只负责自然语言理解：意图、实体角色、上下文和指代。

确定性代码负责：书目查询、来源搜索、候选过滤、排序、下载、状态机、幂等、权限、Queue、R2、Gmail 和 Kindle 投递。

### 文本模型

默认：

```text
@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

可通过：

```text
ASSISTANT_MODEL
```

覆盖。

模型输出的 `title` / `author` 不能直接被信任。任何会驱动书目查询或 Kindle 任务的实体，都必须能够在当前用户消息或最近对话中找到依据。模型把 `纳尼亚传奇` 改写成其他文字时，系统会拒绝创建任务，而不是拿错误书名继续搜索。

### 图片模型

当前 Vision 实际调用：

```text
@cf/qwen/qwen3.8-27b
```

`src/workers-ai.ts` 统一负责 Workers AI receiver-safe 调用和旧图片请求格式到 Qwen 多模态格式的兼容转换。

## 可靠性保护

### Telegram 自然语言

自由文本不再在 webhook 内直接跑模型。Webhook 只负责验证、持久化 Job 并放入 Queue。

`telegram_assistant_jobs` 保存：

- `update_id`
- 输入文本
- Queue 处理 lease
- 已创建的 `task_id`
- book Queue 是否已成功 enqueue
- 最终回复文本

因此：

- AI / 书目查询 / Telegram `sendMessage` 暂时失败可以安全重试；
- 已经创建过的 book task 不会因为回复失败而重新创建一份；
- Queue send 成功但进程随后崩溃时，可以从持久状态恢复。

### Book Queue

`task_execution_leases` 对同一 `task_id` 的重复 / 并发 Queue 消息做可过期执行租约。并发副本不会同时跑完整下载和投递链路。

### Gmail / Kindle

`delivery_fences` 是永久副作用栅栏：

- `started`：已经跨过 Gmail side-effect 边界；
- `accepted`：Gmail 已确认接受；
- `unknown`：调用已经开始，但最终结果无法确认。

如果 Worker 在 Gmail 成功之后、写回 task 状态之前崩溃，下一次执行会从 fence 恢复 `accepted` receipt，而不是误判失败或再次发送。

如果结果无法确认，自动重发被禁止。

### HTTP API

`POST /api/v1/tasks` 支持可选：

```http
Idempotency-Key: <client-generated-key>
```

相同 key 的客户端重试映射到同一个逻辑任务。若 D1 已建 task 但 Queue enqueue 失败，系统会回滚任务和幂等占位并返回 `503`，不会留下永久 `queued` 僵尸任务。

## 书目解析与来源

Resolver：

- Open Library
- Google Books

Download sources：

- ZLibrary（账号凭据）
- Gutendex / Project Gutenberg
- Google Books Free
- Internet Archive Public

所有来源结果统一经过 `src/relevance.ts` 的 deterministic relevance gate，然后才进入评分和候选选择。

主要排序信号：

1. ISBN / identifier 重合
2. 标题 / 已知版本标题
3. 作者
4. 语言偏好
5. EPUB / PDF 偏好
6. 来源质量
7. 云端文件大小限制

无法安全自动选择时进入 `needs_selection`，不会盲目发送。

## 任务状态

```text
queued
searching
needs_source
needs_selection
downloading
staged
delivering
delivery_unknown
delivered
failed
cancelled
```

`delivery_unknown` 是保护状态：系统不确定 Gmail 是否已经接受文档，因此不会自动再次投递。

## Telegram 命令

```text
/send <书名>
/status
/settings
/language zh
/language en
/cancel
/cancel <task-id>
/whoami
/help
```

`/send` 仍然是确定性入口，不依赖自然语言模型判断。

## D1 migrations

当前稳定化分支必须按顺序包含：

```text
0001_init.sql
0002_candidates.sql
0003_delivery_receipt.sql
0004_telegram_entry.sql
0005_telegram_update_idempotency.sql
0006_telegram_image_choices.sql
0007_user_settings.sql
0008_usage_counters.sql
0009_telegram_conversation.sql
0010_delivery_fence.sql
0011_api_idempotency.sql
0012_task_execution_lease.sql
0013_telegram_assistant_jobs.sql
```

仓库 migrations 必须能够完整重建生产所依赖的 schema；不再接受“生产里有、main 里没有”的隐式状态。

## 开发与验收

基础 CI：

```bash
npm run typecheck
npm test
```

这只是必要条件，不是“项目完成”的证明。

稳定化版本在合并 `main` 前还必须通过隔离 staging 的真实环境矩阵：

- 中文 / 英文裸书名和明确发送语句
- 作者查询、书籍信息、系列与上下文指代
- `纳尼亚传奇` 等实体保真回归
- Workers AI 超时 / 错误
- Queue 重复消息 / 并发消费者
- 来源超时 / 错误结果
- R2 失败
- Telegram reply 失败
- Gmail 请求失败 / 结果未知 / 成功后崩溃恢复
- 真实 Telegram 图片识别
- 真实来源检索与候选选择
- 真实 Gmail -> Kindle 投递

完整通过前，PR 必须保持 Draft，不合并 `main`。

## 关键文档

- `docs/ARCHITECTURE.md`：当前架构和边界
- `docs/DEPLOYMENT.md`：部署和 staging 验收
- `docs/SOURCES.md`：来源与 resolver
- `docs/CANCELLATION.md`：取消语义
- `docs/ASSISTANT_AGENT.md`：Assistant 规则

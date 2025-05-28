基于我们前面的深入探讨，这里为你量身打造一个将现有架构迁移到新的 `XxxApiClient` + `AiCompletionService` + 中间件链方案的步骤和概要。

**目标架构核心组件：**

1.  **`CompletionsParams` (及其他API的Params)：** 定义纯粹的应用层输入参数和回调。
2.  **`CoreCompletionsRequest` (及其他API的CoreRequest)：** Zod Schema 定义的、标准化的内部核心请求结构。
3.  **`GenericChunk`：** Zod Schema 定义的、标准化的应用层流式数据块类型。
4.  **`ApiClient` 接口：** 定义了特定AI供应商适配层需要提供的能力。
5.  **`XxxApiClient` 实现类 (如 `OpenAIApiClient`, `GeminiApiClient`)：**
    - 实现 `ApiClient` 接口。
    - 封装SDK实例、API配置。
    - 提供请求转换逻辑 (`CoreRequest` -> `SdkSpecificParams`)。
    - 提供响应块转换逻辑 (`SdkSpecificRawChunk` -> `GenericChunk[]`)。
    - 提供其他特定于Provider的辅助方法。
6.  **`ApiClientFactory`：** 根据配置创建对应的 `XxxApiClient` 实例。
7.  **`AiCompletionService` (或其他业务服务类)：**
    - 业务逻辑入口 (如 `executeCompletions`, `executeTranslate`)。
    - 负责获取 `ApiClient`。
    - 构建初始的 `AiProviderMiddlewareContext` (包含 `ApiClient` 实例和从业务参数转换来的 `CoreRequest`)。
    - **编排和执行中间件链。**
8.  **中间件链 (由 `AiCompletionService` 管理)：**
    - **请求阶段：** `Logging` -> `AbortHandler` -> `TransformCoreToSdkParams` (使用 `ApiClient` 的请求转换器) -> `RequestExecution` (使用 `ApiClient` 获取SDK实例并调用API)。
    - **响应阶段：** `StreamAdapter` (原始SDK流 -> `ReadableStream<RawSdkChunk>`) -> `SdkChunkToGenericChunk` (使用 `ApiClient` 的响应转换器将 `RawSdkChunk` -> `GenericChunk`) -> 通用处理器 (`Think`, `Text`, `Tool`, `WebSearch` 等，消费 `GenericChunk`) -> `FinalChunkConsumerAndNotifier` (调用 `onChunk`) -> `Logging` -> `ErrorHandling`。

**迁移步骤：**

**Phase 0: 准备工作和类型定义**

1.  **定义核心数据结构 (Zod Schemas)：**
    - `CoreCompletionsRequestSchema`：定义应用内部统一的对话请求结构。
    - `GenericChunkSchema`：定义所有可能的通用Chunk类型 (`TEXT_DELTA`, `THINKING_COMPLETE`, `MCP_TOOL_CALL_REQUEST`, `LLM_WEB_SEARCH_COMPLETE` 等)。
    - 为其他API（翻译、总结）定义类似的 `CoreXxxRequestSchema` (如果它们与 `CoreCompletionsRequestSchema` 差异较大)。
2.  **定义 `ApiClient` 接口：** 明确 `getRequestTransformer`, `getResponseChunkTransformer`, `getSdkInstance` 等核心方法。
3.  **调整 `AiProviderMiddlewareCompletionsContext`：**
    - 移除 `_providerInstance` (如果它指向旧的 `BaseProvider`)。
    - 添加 `_apiClientInstance: ApiClient<any,any,any>`。
    - 调整 `_internal` 结构 (如 `sdkPayload`, `messageContext` 等)。

**Phase 1: 实现第一个 `ApiClient` (以 `OpenAIApiClient` 为例)**

1.  **创建 `OpenAIApiClient` 类：** 实现 `ApiClient` 接口。
2.  **迁移SDK实例和配置：** 将原 `OpenAIProvider` 的构造函数中关于API Key、Host、SDK初始化的逻辑移入 `OpenAIApiClient` 的构造函数和 `getSdkInstance` 方法。
3.  **实现 `getRequestTransformer()`：**
    - 创建一个 `transformCoreToOpenAISdkParams` 函数（可以放在 `openaiSchemas.ts` 或 `OpenAIApiClient` 内部）。
    - 此函数接收 `CoreCompletionsRequest` 和 `Assistant`，输出符合OpenAI SDK要求的参数对象 (并用 `OpenAISdkParamsZodSchema` 校验)。
    - 将原 `OpenAIProvider.completions` 方法中构建 `reqMessages`, `tools`, `systemMessage`, `temperature` 等的逻辑迁移到此。
    - 原 `OpenAIProvider.getMessageParam` 的核心逻辑会被这个转换函数调用。
4.  **实现 `getResponseChunkTransformer()`：**
    - 此函数接收 `OpenAI.Chat.Completions.ChatCompletionChunk` 和 `Context`，输出 `GenericChunk[] | null`。
    - 将原 `OpenAIProvider.completions` 方法中 `processStream` (或 `extractReasoningMiddleware` 的类似逻辑) 里解析OpenAI原始块并生成应用层Chunk的逻辑迁移到此。
      - 识别 `delta.content` -> `TextDeltaChunk`。
      - 识别 `delta.reasoning_content` -> `ThinkingDeltaChunk`。
      - 识别 `delta.tool_calls` -> `McpToolCallRequestChunk`。
      - 识别 `annotations` (在 `finish_reason` 时) -> `LLMWebSearchCompleteChunk`。
5.  **迁移其他辅助方法：** 如 `convertMcpToolsToSdkTools` (即 `mcpToolsToOpenAIChatTools`)、`convertSdkToolCallToMcp`、`convertMcpToolResponseToSdkMessage` 等，作为 `OpenAIApiClient` 的方法或其转换器内部使用的辅助函数。

**Phase 2: 实现核心服务和中间件**

1.  **创建 `ApiClientFactory`：** 实现根据配置创建 `OpenAIApiClient` (以及后续其他ApiClient) 的逻辑。
2.  **创建 `AiCompletionService`：**
    - 实现 `executeCompletions(params: CompletionsParams)` 方法。
    - 内部通过 `ApiClientFactory` 获取 `OpenAIApiClient`。
    - 构建 `CoreCompletionsRequest` (从 `params` 转换)。
    - 构建初始的 `AiProviderMiddlewareCompletionsContext`，注入 `OpenAIApiClient` 和 `CoreCompletionsRequest`。
    - **定义并编排新的中间件链。**
3.  **实现/调整核心中间件：**
    - **`TransformCoreToSdkParamsMiddleware` (新/重构)：**
      - 从 `context._apiClientInstance` 获取 `getRequestTransformer()`。
      - 调用其 `.transform()` 方法，用 `context._internal.coreRequest` (或直接从 `context` 取) 生成 `sdkPayload`，存入 `context._internal.sdkPayload`。
    - **`RequestExecutionMiddleware` (新)：**
      - 从 `context._apiClientInstance` 获取 `getSdkInstance()`。
      - 从 `context._internal.sdkPayload` 获取参数。
      - 调用SDK API (如 `openaiSdk.chat.completions.create(sdkPayload.payload as OpenAISdkParams)`)。
      - 返回包含原始SDK响应/流的结果对象 (如 `{ stream: sdkStream }`)。
    - **`StreamAdapterMiddleware` (调整输入)：**
      - 输入是 `RequestExecutionMiddleware` 返回的原始SDK流。
      - 输出是 `ReadableStream<OpenAI.Chat.Completions.ChatCompletionChunk>` (对于OpenAI)。
    - **`SdkChunkToGenericChunkMiddleware` (新)：**
      - 从 `context._apiClientInstance` 获取 `getResponseChunkTransformer()`。
      - 将 `ReadableStream<OpenAI.Chat.Completions.ChatCompletionChunk>` 转换为 `ReadableStream<GenericChunk>`。
4.  **调整通用中间件：**
    - `ThinkChunkMiddleware`, `TextChunkMiddleware`, `McpToolChunkMiddleware`, `WebSearchMiddleware`：确保它们现在消费的是 `ReadableStream<GenericChunk>`，并且内部不再有特定于Provider的解析逻辑。它们的职责是基于标准化的 `GenericChunk` 进行状态管理和逻辑处理（如累积、判断完成、执行工具等）。
    - `McpToolChunkMiddleware` 在执行工具后，需要调用 `context._apiClientInstance.convertMcpToolResponseToSdkMessage()` 来准备递归调用时发送给SDK的工具响应消息。
    - `FinalChunkConsumerAndNotifierMiddleware`, `LoggingMiddleware`, `AbortHandlerMiddleware`, `ErrorMiddleware`：这些通常改动较小，主要是确保它们能正确地从新的 `Context` 中获取所需信息 (如 `onChunkCallback`, `abortController`)。

**Phase 3: 替换旧的调用流程**

1.  修改应用中原先调用 `ProviderFactory.create(config).completions(...)` 的地方，改为调用 `new AiCompletionService().executeCompletions(params)`。
2.  逐步废弃旧的 `BaseProvider` 和 `XxxProvider` 类，以及旧的 `wrapProviderWithMiddleware` (如果其功能已被 `AiCompletionService` 内部的中间件编排取代)。
3.  **彻底移除旧的 `ProviderFactory`，使用新的 `ApiClientFactory`。**

**Phase 4: 迁移其他Provider (如 `GeminiApiClient`)**

1.  重复 Phase 1 的步骤为 Gemini 创建 `GeminiApiClient`。
    - 实现其 `getRequestTransformer()`，包含构建Gemini特有的 `history`, `lastMessageContent`, `generateContentConfig` 的逻辑。
    - 实现其 `getResponseChunkTransformer()`，包含解析Gemini `GenerateContentResponse` 中 `part.text`, `part.thought`, `part.functionCall`, `groundingMetadata` 等并生成 `GenericChunk` 的逻辑。
2.  `ApiClientFactory` 中添加创建 `GeminiApiClient` 的分支。
3.  `AiCompletionService` 和核心中间件链应该不需要大的改动，因为它们是基于通用的 `ApiClient` 接口和 `GenericChunk` 工作的。

**Phase 5: 迁移其他API (如翻译、总结)**

1.  在 `AiCompletionService` 中添加新的方法，如 `executeTranslate`。
2.  这些方法内部会构建一个合适的 `CoreTranslateRequest` (或复用/扩展 `CoreCompletionsRequest` 并加入任务类型标记)。
3.  **复用 Phase 2 中定义的同一套核心中间件链！**
    - `ApiClient` 的 `getRequestTransformer()` 需要能处理这种特定任务的 `CoreRequest` (比如，通过读取任务类型标记，然后使用不同的提示词模板和参数配置来构建SDK请求)。
    - 响应通常也是文本流，所以 `getResponseChunkTransformer()` 和后续的 `TextChunkMiddleware` 等也能在很大程度上复用。

**迁移过程中的关键考量：**

- **小步迭代，逐步验证：** 不要试图一次性重构所有东西。先让 `OpenAIApiClient` 和 `completions` 流程跑通新的架构，再逐步迁移其他Provider和其他API。
- **单元测试和集成测试：**
  - 为每个 `XxxApiClient` 的转换函数编写单元测试。
  - 为每个核心中间件编写单元测试（可以mock `ApiClient` 的行为）。
  - 为 `AiCompletionService` 的端到端流程编写集成测试。
- **类型定义的演进：** 随着迁移的进行，你可能会发现需要调整 `CoreRequest`, `GenericChunk`, `ApiClient` 接口等核心类型定义，使其更通用或更精确。
- **向后兼容性 (如果需要)：** 如果需要在迁移过程中保持旧API的可用性，可能需要一些临时的适配器或开关。
- **团队沟通：** 确保团队成员理解新的架构设计和各个组件的职责。

import { DEFAULT_MAX_TOKENS } from '@renderer/config/constant'
import {
  findTokenLimit,
  isClaudeReasoningModel,
  isOpenAIReasoningModel,
  isReasoningModel,
  isSupportedReasoningEffortGrokModel,
  isSupportedReasoningEffortModel,
  isSupportedReasoningEffortOpenAIModel,
  isSupportedThinkingTokenClaudeModel,
  isSupportedThinkingTokenGeminiModel,
  isSupportedThinkingTokenModel,
  isSupportedThinkingTokenQwenModel,
  isVisionModel
} from '@renderer/config/models'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import store from '@renderer/store' // For Copilot token
import { Assistant, FileTypes, MCPCallToolResponse, MCPTool, MCPToolResponse, Model, Provider } from '@renderer/types'
import { EFFORT_RATIO } from '@renderer/types'
import { ChunkType, TextDeltaChunk, ThinkingDeltaChunk } from '@renderer/types/chunk' // Assuming GenericChunk variants are here
import { Message } from '@renderer/types/newMessage'
import {
  mcpToolCallResponseToOpenAICompatibleMessage,
  mcpToolsToOpenAIChatTools,
  openAIToolsToMcpTool
} from '@renderer/utils/mcp-tools'
import { findFileBlocks, findImageBlocks } from '@renderer/utils/messageUtils/find'
import OpenAI, { AzureOpenAI } from 'openai'
import { ChatCompletionContentPart, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources'

import { GenericChunk } from '../../../middleware/schemas'
import { BaseApiClient } from '../BaseApiClient'
import { RequestTransformer, ResponseChunkTransformer, ResponseChunkTransformerContext } from '../types'
import { OpenAISdkParams, ReasoningEffortOptionalParams } from './types'

// Define a context type if your response transformer needs it
interface OpenAIResponseTransformContext extends ResponseChunkTransformerContext {}

export class OpenAIApiClient extends BaseApiClient<
  OpenAI | AzureOpenAI,
  OpenAISdkParams,
  OpenAI.Chat.Completions.ChatCompletionChunk,
  OpenAIResponseTransformContext
> {
  constructor(provider: Provider) {
    super(provider)
  }

  async getSdkInstance(): Promise<OpenAI | AzureOpenAI> {
    if (this.sdkInstance) {
      return this.sdkInstance
    }

    if (this.provider.id === 'copilot') {
      const defaultHeaders = store.getState().copilot.defaultHeaders
      const { token } = await window.api.copilot.getToken(defaultHeaders)
      this.provider.apiKey = token // Update API key for each call to copilot
    }

    if (this.provider.id === 'azure-openai' || this.provider.type === 'azure-openai') {
      this.sdkInstance = new AzureOpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: this.provider.apiKey,
        apiVersion: this.provider.apiVersion,
        endpoint: this.provider.apiHost
      })
    } else {
      this.sdkInstance = new OpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: this.provider.apiKey,
        baseURL: this.getBaseURL(),
        defaultHeaders: {
          ...this.defaultHeaders(),
          ...(this.provider.id === 'copilot' ? { 'editor-version': 'vscode/1.97.2' } : {}),
          ...(this.provider.id === 'copilot' ? { 'copilot-vision-request': 'true' } : {})
        }
      })
    }
    return this.sdkInstance
  }

  getRequestTransformer(): RequestTransformer<OpenAISdkParams> {
    return {
      transform: async (coreRequest, assistant, model): Promise<{ payload: OpenAISdkParams }> => {
        const { messages, mcpTools, temperature, topP, maxTokens, streamOutput } = coreRequest

        let systemMessageContent = assistant.prompt || ''
        if (isSupportedReasoningEffortOpenAIModel(model)) {
          systemMessageContent = `Formatting re-enabled${systemMessageContent ? '\n' + systemMessageContent : ''}`
        }
        if (model.id.includes('o1-preview') || model.id.includes('o1-mini')) {
          systemMessageContent = `Formatting re-enabled${systemMessageContent ? '\n' + systemMessageContent : ''}`
        }

        const reqMessages: ChatCompletionMessageParam[] = []
        if (systemMessageContent) {
          reqMessages.push({
            role:
              isSupportedReasoningEffortOpenAIModel(model) ||
              model.id.includes('o1-preview') ||
              model.id.includes('o1-mini')
                ? 'system'
                : 'system',
            content: systemMessageContent
          } as ChatCompletionMessageParam)
        }

        for (const message of messages) {
          reqMessages.push(await this.convertMessageToSdkParam(message, model))
        }

        const tools = mcpTools && mcpTools.length > 0 ? this.convertMcpToolsToSdkTools(mcpTools) : undefined

        // Create common parameters that will be used in both streaming and non-streaming cases
        const commonParams = {
          model: model.id,
          messages: reqMessages,
          temperature: this.getTemperature(assistant, model, temperature),
          top_p: this.getTopP(assistant, model, topP),
          max_tokens: maxTokens,
          tools: tools as ChatCompletionTool[] | undefined,
          ...this.getProviderSpecificParameters(assistant, model),
          ...this.getReasoningEffort(assistant, model)
        }

        // Create the appropriate parameters object based on whether streaming is enabled
        const sdkParams: OpenAISdkParams = streamOutput
          ? {
              ...commonParams,
              stream: true
            }
          : {
              ...commonParams,
              stream: false
            }

        return { payload: sdkParams }
      }
    }
  }

  // 在RawSdkChunkToGenericChunkMiddleware中使用
  getResponseChunkTransformer(): ResponseChunkTransformer<
    OpenAI.Chat.Completions.ChatCompletionChunk,
    OpenAIResponseTransformContext
  > {
    return async function* (chunk, context): AsyncGenerator<GenericChunk> {
      const choice = chunk.choices[0]

      if (!choice) return

      const { delta } = choice

      if (delta?.content) {
        yield {
          type: ChunkType.TEXT_DELTA,
          text: delta.content
        } as TextDeltaChunk
      }

      if (delta?.tool_calls && context?.isEnabledToolCalling) {
        for (const toolCall of delta.tool_calls) {
          if (toolCall.function?.name) {
            // This is the start of a tool call
            const mcpTool = openAIToolsToMcpTool(context.mcpTools || [], toolCall as any)
            if (mcpTool) {
              yield {
                type: ChunkType.MCP_TOOL_IN_PROGRESS, // Or a more specific tool start chunk
                responses: [
                  {
                    id: toolCall.id || '',
                    toolCallId: toolCall.id,
                    tool: mcpTool,
                    arguments: {}, // Arguments will be accumulated
                    status: 'pending'
                  }
                ]
              } as GenericChunk
            }
          }
          if (toolCall.function?.arguments) {
            // Accumulate arguments. This part needs careful state management in the middleware
            // For simplicity, we just signal that arguments are coming.
            // Actual accumulation and parsing should happen in McpToolChunkMiddleware
            const mcpTool = openAIToolsToMcpTool(context.mcpTools || [], toolCall as any)
            if (mcpTool) {
              yield {
                type: ChunkType.MCP_TOOL_IN_PROGRESS, // Or a more specific tool start chunk
                responses: [
                  {
                    id: toolCall.id || '',
                    toolCallId: toolCall.id,
                    tool: mcpTool,
                    arguments: toolCall.function.arguments as any, // Cast to any, assuming middleware handles string fragments
                    status: 'pending'
                  }
                ]
              } as GenericChunk
            }
          }
        }
      }

      // Handle reasoning content (e.g. from OpenRouter DeepSeek-R1)
      // @ts-ignore reasoning_content is not in standard OpenAI types but some providers use it
      if (delta?.reasoning_content || delta?.reasoning) {
        yield {
          type: ChunkType.THINKING_DELTA,
          // @ts-ignore reasoning_content is a non-standard field from some providers
          text: delta.reasoning_content || delta.reasoning
        } as ThinkingDeltaChunk
      }
    }
  }

  private get isNotSupportFiles() {
    if (this.provider?.isNotSupportArrayContent) {
      return true
    }

    const providers = ['deepseek', 'baichuan', 'minimax', 'xirang']

    return providers.includes(this.provider.id)
  }

  private async convertMessageToSdkParam(
    message: Message,
    model: Model
  ): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
    const isVision = isVisionModel(model)
    const content = await this.getMessageContent(message)
    const fileBlocks = findFileBlocks(message)
    const imageBlocks = findImageBlocks(message)

    if (fileBlocks.length === 0 && imageBlocks.length === 0) {
      return {
        role: message.role === 'system' ? 'user' : message.role,
        content
      }
    }

    // If the model does not support files, extract the file content
    if (this.isNotSupportFiles) {
      const fileContent = await this.extractFileContent(message)

      return {
        role: message.role === 'system' ? 'user' : message.role,
        content: content + '\n\n---\n\n' + fileContent
      }
    }

    // If the model supports files, add the file content to the message
    const parts: ChatCompletionContentPart[] = []

    if (content) {
      parts.push({ type: 'text', text: content })
    }

    for (const imageBlock of imageBlocks) {
      if (isVision) {
        if (imageBlock.file) {
          const image = await window.api.file.base64Image(imageBlock.file.id + imageBlock.file.ext)
          parts.push({ type: 'image_url', image_url: { url: image.data } })
        } else if (imageBlock.url && imageBlock.url.startsWith('data:')) {
          parts.push({ type: 'image_url', image_url: { url: imageBlock.url } })
        }
      }
    }

    for (const fileBlock of fileBlocks) {
      const file = fileBlock.file
      if (!file) {
        continue
      }

      if ([FileTypes.TEXT, FileTypes.DOCUMENT].includes(file.type)) {
        const fileContent = await (await window.api.file.read(file.id + file.ext)).trim()
        parts.push({
          type: 'text',
          text: file.origin_name + '\n' + fileContent
        })
      }
    }

    return {
      role: message.role === 'system' ? 'user' : message.role,
      content: parts
    } as ChatCompletionMessageParam
  }

  // Method to get temperature, moved from OpenAIProvider
  override getTemperature(assistant: Assistant, model: Model, coreTemp?: number): number | undefined {
    if (isOpenAIReasoningModel(model) || (assistant.settings?.reasoning_effort && isClaudeReasoningModel(model))) {
      return undefined
    }
    return coreTemp ?? assistant.settings?.temperature
  }

  // Method to get topP, moved from OpenAIProvider
  override getTopP(assistant: Assistant, model: Model, coreTopP?: number): number | undefined {
    if (isOpenAIReasoningModel(model) || (assistant.settings?.reasoning_effort && isClaudeReasoningModel(model))) {
      return undefined
    }
    return coreTopP ?? assistant.settings?.topP
  }

  // Method for provider-specific parameters, moved from OpenAIProvider
  private getProviderSpecificParameters(assistant: Assistant, model: Model) {
    const { maxTokens: assistantMaxTokens } = getAssistantSettings(assistant)
    if (this.provider.id === 'openrouter' && model.id.includes('deepseek-r1')) {
      return { include_reasoning: true }
    }
    if (isOpenAIReasoningModel(model)) {
      return { max_tokens: undefined, max_completion_tokens: assistantMaxTokens }
    }
    return {}
  }

  // Method for reasoning effort, moved from OpenAIProvider
  private getReasoningEffort(assistant: Assistant, model: Model): ReasoningEffortOptionalParams {
    if (this.provider.id === 'groq') {
      return {}
    }

    if (!isReasoningModel(model)) {
      return {}
    }
    const reasoningEffort = assistant?.settings?.reasoning_effort
    if (!reasoningEffort) {
      if (isSupportedThinkingTokenQwenModel(model)) {
        return { enable_thinking: false }
      }

      if (isSupportedThinkingTokenClaudeModel(model)) {
        return { thinking: { type: 'disabled' } }
      }

      if (isSupportedThinkingTokenGeminiModel(model)) {
        // openrouter没有提供一个不推理的选项，先隐藏
        if (this.provider.id === 'openrouter') {
          return { reasoning: { max_tokens: 0, exclude: true } }
        }
        return {
          reasoning_effort: 'none'
        }
      }

      return {}
    }
    const effortRatio = EFFORT_RATIO[reasoningEffort]
    const budgetTokens = Math.floor(
      (findTokenLimit(model.id)?.max! - findTokenLimit(model.id)?.min!) * effortRatio + findTokenLimit(model.id)?.min!
    )

    // OpenRouter models
    if (model.provider === 'openrouter') {
      if (isSupportedReasoningEffortModel(model) || isSupportedThinkingTokenModel(model)) {
        return {
          reasoning: {
            effort: assistant?.settings?.reasoning_effort === 'auto' ? 'medium' : assistant?.settings?.reasoning_effort
          }
        }
      }
    }

    // Qwen models
    if (isSupportedThinkingTokenQwenModel(model)) {
      return {
        enable_thinking: true,
        thinking_budget: budgetTokens
      }
    }

    // Grok models
    if (isSupportedReasoningEffortGrokModel(model)) {
      return {
        reasoning_effort: assistant?.settings?.reasoning_effort
      }
    }

    // OpenAI models
    if (isSupportedReasoningEffortOpenAIModel(model) || isSupportedThinkingTokenGeminiModel(model)) {
      return {
        reasoning_effort: assistant?.settings?.reasoning_effort
      }
    }

    // Claude models
    if (isSupportedThinkingTokenClaudeModel(model)) {
      const maxTokens = assistant.settings?.maxTokens
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: Math.floor(
            Math.max(1024, Math.min(budgetTokens, (maxTokens || DEFAULT_MAX_TOKENS) * effortRatio))
          )
        }
      }
    }

    // Default case: no special thinking settings
    return {}
  }

  // Tool conversion methods - directly from OpenAIProvider for now
  convertMcpToolsToSdkTools<T>(mcpTools: MCPTool[]): T[] {
    return mcpToolsToOpenAIChatTools(mcpTools) as T[]
  }

  convertMcpToolResponseToSdkMessage(
    mcpToolResponse: MCPToolResponse,
    resp: MCPCallToolResponse,
    model: Model
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam | undefined {
    if ('toolUseId' in mcpToolResponse && mcpToolResponse.toolUseId) {
      // This case is for Anthropic/Claude like tool usage, OpenAI uses tool_call_id
      // For OpenAI, we primarily expect toolCallId. This might need adjustment if mixing provider concepts.
      return mcpToolCallResponseToOpenAICompatibleMessage(mcpToolResponse, resp, isVisionModel(model))
    } else if ('toolCallId' in mcpToolResponse && mcpToolResponse.toolCallId) {
      return {
        role: 'tool',
        tool_call_id: mcpToolResponse.toolCallId,
        content: JSON.stringify(resp.content)
      } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam
    }
    return undefined
  }
}

import { getAssistantSettings, getDefaultModel } from '@renderer/services/AssistantService'
import { ChunkType, ErrorChunk } from '@renderer/types/chunk'

import { CompletionsParams } from '../AiProvider'
import { AiProviderMiddlewareCompletionsContext, MIDDLEWARE_CONTEXT_SYMBOL } from './middlewareTypes'
import { CoreCompletionsRequest } from './schemas'

/**
 * Creates an ErrorChunk object with a standardized structure.
 * @param error The error object or message.
 * @param chunkType The type of chunk, defaults to ChunkType.ERROR.
 * @returns An ErrorChunk object.
 */
export function createErrorChunk(error: any, chunkType: ChunkType = ChunkType.ERROR): ErrorChunk {
  let errorDetails: Record<string, any> = {}

  if (error instanceof Error) {
    errorDetails = {
      message: error.message,
      name: error.name,
      stack: error.stack
    }
  } else if (typeof error === 'string') {
    errorDetails = { message: error }
  } else if (typeof error === 'object' && error !== null) {
    errorDetails = Object.getOwnPropertyNames(error).reduce(
      (acc, key) => {
        acc[key] = error[key]
        return acc
      },
      {} as Record<string, any>
    )
    if (!errorDetails.message && error.toString && typeof error.toString === 'function') {
      const errMsg = error.toString()
      if (errMsg !== '[object Object]') {
        errorDetails.message = errMsg
      }
    }
  }

  return {
    type: chunkType,
    error: errorDetails
  } as ErrorChunk
}

// Helper to capitalize method names for hook construction
export function capitalize(str: string): string {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Convert CompletionsParams to CoreCompletionsRequest
 * 将应用层的CompletionsParams转换为标准化的CoreCompletionsRequest
 */
export function convertCompletionsParamsToCoreRequest(params: CompletionsParams): CoreCompletionsRequest {
  const { messages, assistant, mcpTools } = params
  const model = assistant.model || getDefaultModel()
  const { contextCount, maxTokens, streamOutput } = getAssistantSettings(assistant)

  const coreRequest: CoreCompletionsRequest = {
    messages,
    assistant,
    model,
    mcpTools,

    // 生成参数
    temperature: assistant.settings?.temperature,
    topP: assistant.settings?.topP,
    maxTokens,

    // 功能开关
    streamOutput,
    enableWebSearch: assistant.enableWebSearch,
    enableReasoning: assistant.settings?.reasoning_effort !== undefined,

    // 上下文控制
    contextCount,

    // 任务类型
    taskType: 'completion'
  }

  // 直接返回构建的对象，不进行运行时校验
  return coreRequest
}

/**
 * Create initial middleware context for completions
 * 为completions创建初始的中间件上下文
 */
export function createCompletionsContext(
  params: CompletionsParams,
  apiClient?: any
): AiProviderMiddlewareCompletionsContext {
  const { messages, assistant, mcpTools, onChunk, onFilterMessages } = params
  const model = assistant.model || getDefaultModel()

  const coreRequest = convertCompletionsParamsToCoreRequest(params)

  return {
    [MIDDLEWARE_CONTEXT_SYMBOL]: true,
    methodName: 'completions',
    originalArgs: [params],

    // 便捷字段
    assistant,
    model,
    messages,
    mcpTools,
    onChunk,
    onFilterMessages,

    // 新架构支持
    _apiClientInstance: apiClient,

    // 内部字段
    _internal: {
      coreRequest,
      isRecursiveCall: false,
      recursionDepth: 0,
      messageContext: {
        reqMessages: [],
        toolResponses: [],
        finalUsage: {
          completion_tokens: 0,
          prompt_tokens: 0,
          total_tokens: 0
        },
        finalMetrics: {
          completion_tokens: 0,
          time_completion_millsec: 0,
          time_first_token_millsec: 0
        }
      }
    }
  }
}

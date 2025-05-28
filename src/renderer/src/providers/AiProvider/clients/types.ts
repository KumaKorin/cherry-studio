import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import { Assistant, MCPTool, Model } from '@renderer/types'
import { Provider } from '@renderer/types'
import OpenAI, { AzureOpenAI } from 'openai'

import { CoreCompletionsRequest, GenericChunk } from '../../middleware/schemas'

/**
 * 请求转换器接口
 */
export interface RequestTransformer<TSdkParams = any> {
  transform(
    coreRequest: CoreCompletionsRequest,
    assistant: Assistant,
    model: Model,
    provider: Provider
  ): Promise<{
    payload: TSdkParams
    metadata?: Record<string, any>
  }>
}

/**
 * 响应块转换器接口
 */
export type ResponseChunkTransformer<TRawChunk = any, TContext = any> = (
  rawChunk: TRawChunk,
  context?: TContext
) => AsyncGenerator<GenericChunk>

export interface ResponseChunkTransformerContext {
  isStreaming: boolean
  isEnabledToolCalling: boolean
  isEnabledWebSearch: boolean
  isEnabledReasoning: boolean
  mcpTools: MCPTool[]
}

export type SdkInstance = OpenAI | AzureOpenAI | Anthropic | GoogleGenAI

/**
 * API客户端接口
 */
export interface ApiClient<
  TSdkInstance = SdkInstance,
  TSdkParams = any,
  TRawChunk = any,
  TResponseContext = ResponseChunkTransformerContext
> {
  provider: Provider
  getSdkInstance(): Promise<TSdkInstance> | TSdkInstance
  getRequestTransformer(): RequestTransformer<TSdkParams>
  getResponseChunkTransformer(): ResponseChunkTransformer<TRawChunk, TResponseContext>

  // 工具转换相关方法 (保持可选，因为不是所有Provider都支持工具)
  convertMcpToolsToSdkTools?(mcpTools: any[]): any[]
  convertSdkToolCallToMcp?(toolCall: any, mcpTools?: any[]): any // Added mcpTools for context if needed
  convertMcpToolResponseToSdkMessage?(mcpToolResponse: any, resp: any, model: Model): any
}

import { Usage } from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { isEmpty } from 'lodash'

import type { CompletionsOpenAIResult } from '../../AiProvider'
import type { CompletionsMiddleware } from '../middlewareTypes'

const MIDDLEWARE_NAME = 'FinalChunkConsumerAndNotifierMiddleware'

/**
 * 最终Chunk消费和通知中间件
 *
 * 职责：
 * 1. 消费所有流中的chunks并转发给onChunk回调
 * 2. 从原始SDK chunks中提取和累加usage/metrics数据
 * 3. 在流结束时发送包含累计数据的BLOCK_COMPLETE和LLM_RESPONSE_COMPLETE chunks
 * 4. 处理MCP工具调用的多轮请求中的数据累加
 */
const FinalChunkConsumerMiddleware: CompletionsMiddleware = () => (next) => async (context, params) => {
  const isRecursiveCall = context._internal?.isRecursiveCall || false
  const recursionDepth = context._internal?.recursionDepth || 0

  console.log(`[${MIDDLEWARE_NAME}] Starting middleware. isRecursive: ${isRecursiveCall}, depth: ${recursionDepth}`)

  // 初始化累计数据（只在顶层调用时初始化）
  if (!isRecursiveCall) {
    if (!context._internal) {
      context._internal = {}
    }
    context._internal.accumulatedUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      thoughts_tokens: 0
    }
    context._internal.accumulatedMetrics = {
      completion_tokens: 0,
      time_completion_millsec: 0,
      time_first_token_millsec: 0,
      time_thinking_millsec: 0
    }
    console.log(`[${MIDDLEWARE_NAME}] Initialized accumulation data for top-level call`)
  } else {
    console.log(`[${MIDDLEWARE_NAME}] Recursive call, will use existing accumulation data`)
  }

  const resultFromUpstream = await next(context, params)

  console.log(
    `[${MIDDLEWARE_NAME}] Received result from upstream. Stream available: ${!!resultFromUpstream.stream}, isRecursive: ${isRecursiveCall}, depth: ${recursionDepth}`
  )

  if (resultFromUpstream.stream && resultFromUpstream.stream instanceof ReadableStream) {
    const inputStream = resultFromUpstream.stream
    const reader = inputStream.getReader()

    // console.log(`[${MIDDLEWARE_NAME}] Starting to consume and notify chunks. IsRecursive: ${isRecursiveCall}`)
    try {
      while (true) {
        const { done, value: chunk } = await reader.read()

        if (done) {
          console.log(`[${MIDDLEWARE_NAME}] Input stream finished.`)
          break
        }
        // console.warn('chunk', chunk)
        if (chunk) {
          if ('type' in chunk && typeof chunk.type === 'string') {
            if (params.onChunk) {
              params.onChunk(chunk)
            }
          } else {
            // TODO: 针对未处理的原始流,需要筛出来转换成error
            console.warn(`[${MIDDLEWARE_NAME}] Received chunk with no type property:`, chunk)
            if (!isEmpty(chunk.choices?.[0]?.finish_reason)) {
              // 从原始SDK chunks中提取usage/metrics数据并累加
              extractAndAccumulateUsageMetrics(chunk, context._internal)
            }
          }
        } else {
          // Should not happen if done is false, but good to be defensive
          console.warn(`[${MIDDLEWARE_NAME}] Received undefined chunk before stream was done.`)
        }
      }
    } catch (error) {
      console.error(`[${MIDDLEWARE_NAME}] Error consuming stream:`, error)
      throw error
    } finally {
      // console.log(`[${MIDDLEWARE_NAME}] Finished consuming stream.`)

      // 重新检查递归状态，因为它可能在递归调用期间被修改
      // const finalIsRecursiveCall = context._internal?.isRecursiveCall || false
      // const finalRecursionDepth = context._internal?.recursionDepth || 0

      console.log(`[${MIDDLEWARE_NAME}] Final state check:`)
      console.log(`  - Initial: isRecursive=${isRecursiveCall}, depth=${recursionDepth}`)

      // 只在顶层调用时发送最终的累计数据
      if (params.onChunk && !isRecursiveCall) {
        console.log(`[${MIDDLEWARE_NAME}] Sending final completion chunks with accumulated data (top-level call)`)

        // 发送包含累计数据的 BLOCK_COMPLETE
        params.onChunk({
          type: ChunkType.BLOCK_COMPLETE,
          response: {
            usage: context._internal.accumulatedUsage ? { ...context._internal.accumulatedUsage } : undefined,
            metrics: context._internal.accumulatedMetrics ? { ...context._internal.accumulatedMetrics } : undefined
          }
        })

        // 发送 LLM_RESPONSE_COMPLETE
        params.onChunk({
          type: ChunkType.LLM_RESPONSE_COMPLETE,
          response: undefined
        })

        console.log(`[${MIDDLEWARE_NAME}] Final accumulated data:`, {
          usage: context._internal.accumulatedUsage,
          metrics: context._internal.accumulatedMetrics
        })
      } else if (isRecursiveCall) {
        console.log(`[${MIDDLEWARE_NAME}] Skipping final completion chunks (recursive call detected)`)
      } else {
        console.log(`[${MIDDLEWARE_NAME}] No onChunk callback available`)
      }
    }

    const finalResult: CompletionsOpenAIResult = {
      ...resultFromUpstream,
      // Create an empty, already-closed stream explicitly typed as ReadableStream<Chunk>
      stream: new ReadableStream<Chunk>({
        // Explicitly type the new ReadableStream
        start(controller) {
          controller.close()
        }
      })
      // text: accumulatedText,
    }
    return finalResult
  } else {
    console.log(
      `[${MIDDLEWARE_NAME}] No stream to process or stream is not ReadableStream. Returning original result from upstream.`
    )
    return resultFromUpstream
  }
}

/**
 * 从原始SDK chunks中提取usage/metrics数据并累加
 */
function extractAndAccumulateUsageMetrics(chunk: any, internal: any): void {
  if (!internal?.accumulatedUsage || !internal?.accumulatedMetrics) {
    return
  }

  try {
    // OpenAI Response API chunks
    // if (chunk.type === 'response.completed' && chunk.response?.usage) {
    //   const usage = chunk.response.usage
    //   const completion_tokens = (usage.output_tokens || 0) + (usage.output_tokens_details?.reasoning_tokens || 0)
    //   const total_tokens = (usage.total_tokens || 0) + (usage.output_tokens_details?.reasoning_tokens || 0)

    //   accumulateUsage(internal.accumulatedUsage, {
    //     prompt_tokens: usage.input_tokens || 0,
    //     completion_tokens,
    //     total_tokens,
    //     thoughts_tokens: usage.output_tokens_details?.reasoning_tokens || 0
    //   })

    //   console.log(`[${MIDDLEWARE_NAME}] Extracted usage from OpenAI Response chunk:`, internal.accumulatedUsage)
    // }

    // Standard OpenAI Chat Completion chunks
    if (chunk.usage && !chunk.response && !chunk.usageMetadata) {
      accumulateUsage(internal.accumulatedUsage, chunk.usage)
      console.log(`[${MIDDLEWARE_NAME}] Extracted usage from OpenAI Chat chunk:`, internal.accumulatedUsage)
    }

    // // Gemini chunks
    // else if (chunk.usageMetadata) {
    //   const usage = {
    //     prompt_tokens: chunk.usageMetadata.promptTokenCount || 0,
    //     completion_tokens: chunk.usageMetadata.candidatesTokenCount || 0,
    //     total_tokens: chunk.usageMetadata.totalTokenCount || 0,
    //     thoughts_tokens: chunk.usageMetadata.thoughtsTokenCount || 0
    //   }
    //   accumulateUsage(internal.accumulatedUsage, usage)
    //   console.log(`[${MIDDLEWARE_NAME}] Extracted usage from Gemini chunk:`, internal.accumulatedUsage)
    // }

    // // Anthropic chunks
    // else if (chunk.usage && chunk.usage.input_tokens !== undefined && chunk.usage.output_tokens !== undefined) {
    //   const usage = {
    //     prompt_tokens: chunk.usage.input_tokens || 0,
    //     completion_tokens: chunk.usage.output_tokens || 0,
    //     total_tokens: (chunk.usage.input_tokens || 0) + (chunk.usage.output_tokens || 0)
    //   }
    //   accumulateUsage(internal.accumulatedUsage, usage)
    //   console.log(`[${MIDDLEWARE_NAME}] Extracted usage from Anthropic chunk:`, internal.accumulatedUsage)
    // }

    // TODO: 可以根据需要添加更多Provider的chunk格式支持
  } catch (error) {
    console.warn(`[${MIDDLEWARE_NAME}] Error extracting usage/metrics from chunk:`, error, chunk)
  }
}

/**
 * 累加Usage数据
 */
function accumulateUsage(accumulated: Usage, newUsage: Usage): void {
  accumulated.prompt_tokens += newUsage.prompt_tokens || 0
  accumulated.completion_tokens += newUsage.completion_tokens || 0
  accumulated.total_tokens += newUsage.total_tokens || 0
  if (newUsage.thoughts_tokens) {
    accumulated.thoughts_tokens = (accumulated.thoughts_tokens || 0) + newUsage.thoughts_tokens
  }
}

export default FinalChunkConsumerMiddleware

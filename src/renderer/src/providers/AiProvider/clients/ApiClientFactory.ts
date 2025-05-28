import { Provider } from '@renderer/types'

import { OpenAIApiClient } from './openai/OpenAIApiClient'
import { ApiClient } from './types'

/**
 * Factory for creating ApiClient instances based on provider configuration
 * 根据提供者配置创建ApiClient实例的工厂
 */
export class ApiClientFactory {
  /**
   * Create an ApiClient instance for the given provider
   * 为给定的提供者创建ApiClient实例
   */
  static create(provider: Provider): ApiClient<any, any, any> {
    // 然后检查标准的provider type
    switch (provider.type) {
      case 'openai':
      case 'azure-openai':
        return new OpenAIApiClient(provider)

      case 'gemini':
        throw new Error(`GeminiApiClient not implemented yet for provider: ${provider.id}`)

      case 'anthropic':
        throw new Error(`ClaudeApiClient not implemented yet for provider: ${provider.id}`)

      default:
        return new OpenAIApiClient(provider)
    }
  }
}

import { promptVariableReplacer } from '@renderer/utils/prompt'
import { useEffect, useState } from 'react'

import { useSettings } from './useSettings'

export function usePromptProcessor({ prompt }: { prompt: string }) {
  const { promptAutoRefresh, promptRefreshInterval, promptShowVariableReplacement } = useSettings()
  const [processedPrompt, setProcessedPrompt] = useState('')

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null

    const processPrompt = async () => {
      try {
        if (prompt && promptShowVariableReplacement) {
          const result = await promptVariableReplacer(prompt)
          setProcessedPrompt(result)
          console.log('执行了一次更新')
        } else {
          setProcessedPrompt(prompt)
        }
      } catch (error) {
        console.error('Error processing prompt variables:', error)
        setProcessedPrompt(prompt)
      }
    }

    // 立刻执行
    processPrompt()

    // 设置自动刷新
    if (promptAutoRefresh && promptRefreshInterval > 0) {
      intervalId = setInterval(processPrompt, promptRefreshInterval * 1000)
    }

    // 清理，确保在跳转到其他组件时清理该定时器
    return () => {
      if (intervalId !== null) {
        clearInterval(intervalId)
      }
    }
  }, [prompt, promptAutoRefresh, promptRefreshInterval, promptShowVariableReplacement])

  return processedPrompt
}

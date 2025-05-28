import * as cld3 from 'cld3-asm'
import React, { MutableRefObject } from 'react'

let langIdentifier: any = null

/**
 * 初始化语言识别器
 */
const initLangIdentifier = async () => {
  if (!langIdentifier) {
    langIdentifier = await cld3.loadModule()
  }
  return langIdentifier
}

/**
 * 使用Unicode字符范围检测语言
 * 适用于较短文本的语言检测
 * @param {string} text 需要检测语言的文本
 * @returns {string} 检测到的语言代码
 */
export const detectLanguageByUnicode = (text: string): string => {
  const counts = {
    zh: 0,
    ja: 0,
    ko: 0,
    ru: 0,
    ar: 0,
    latin: 0
  }

  let totalChars = 0

  for (const char of text) {
    const code = char.codePointAt(0) || 0
    totalChars++

    if (code >= 0x4e00 && code <= 0x9fff) {
      counts.zh++
    } else if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) {
      counts.ja++
    } else if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x1100 && code <= 0x11ff)) {
      counts.ko++
    } else if (code >= 0x0400 && code <= 0x04ff) {
      counts.ru++
    } else if (code >= 0x0600 && code <= 0x06ff) {
      counts.ar++
    } else if ((code >= 0x0020 && code <= 0x007f) || (code >= 0x0080 && code <= 0x00ff)) {
      counts.latin++
    } else {
      totalChars--
    }
  }

  if (totalChars === 0) return 'en'
  let maxLang = 'en'
  let maxCount = 0

  for (const [lang, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count
      maxLang = lang === 'latin' ? 'en' : lang
    }
  }

  if (maxCount / totalChars < 0.3) {
    return 'en'
  }
  return maxLang
}

/**
 * 检测输入文本的语言
 * @param {string} inputText 需要检测语言的文本
 * @returns {Promise<string>} 检测到的语言代码
 */
export const detectLanguage = async (inputText: string): Promise<string> => {
  if (!inputText.trim()) return 'any'

  const text = inputText.trim()

  // 由于算法的局限性会导致对较短的字符串识别不准确
  let detected
  if (text.length < 20) {
    detected = detectLanguageByUnicode(text)
  } else {
    const identifier = await initLangIdentifier()
    const result = identifier.findLanguage(text)
    detected = result.reliable ? result.language : 'en'
  }
  console.log(detected)
  const topLang = detected || 'en'

  // 映射cld3-asm返回的语言代码到应用使用的语言代码
  const languageMap: Record<string, string> = {
    zh: 'chinese', // 中文
    ja: 'japanese', // 日语
    ko: 'korean', // 韩语
    ru: 'russian', // 俄语
    es: 'spanish', // 西班牙语
    fr: 'french', // 法语
    de: 'german', // 德语
    it: 'italian', // 意大利语
    pt: 'portuguese', // 葡萄牙语
    ar: 'arabic', // 阿拉伯语
    en: 'english' // 英语
  }

  if (topLang && languageMap[topLang]) {
    return languageMap[topLang]
  }
  return 'english'
}

/**
 * 获取双向翻译的目标语言
 * @param sourceLanguage 检测到的源语言
 * @param languagePair 配置的语言对
 * @returns 目标语言
 */
export const getTargetLanguageForBidirectional = (sourceLanguage: string, languagePair: [string, string]): string => {
  if (sourceLanguage === languagePair[0]) {
    return languagePair[1]
  } else if (sourceLanguage === languagePair[1]) {
    return languagePair[0]
  }
  return languagePair[0] !== sourceLanguage ? languagePair[0] : languagePair[1]
}

/**
 * 检查源语言是否在配置的语言对中
 * @param sourceLanguage 检测到的源语言
 * @param languagePair 配置的语言对
 * @returns 是否在语言对中
 */
export const isLanguageInPair = (sourceLanguage: string, languagePair: [string, string]): boolean => {
  return [languagePair[0], languagePair[1]].includes(sourceLanguage)
}

/**
 * 确定翻译的目标语言
 * @param sourceLanguage 检测到的源语言
 * @param targetLanguage 用户设置的目标语言
 * @param isBidirectional 是否开启双向翻译
 * @param bidirectionalPair 双向翻译的语言对
 * @returns 处理结果对象
 */
export const determineTargetLanguage = (
  sourceLanguage: string,
  targetLanguage: string,
  isBidirectional: boolean,
  bidirectionalPair: [string, string]
): { success: boolean; language?: string; errorType?: 'same_language' | 'not_in_pair' } => {
  if (isBidirectional) {
    if (!isLanguageInPair(sourceLanguage, bidirectionalPair)) {
      return { success: false, errorType: 'not_in_pair' }
    }
    return {
      success: true,
      language: getTargetLanguageForBidirectional(sourceLanguage, bidirectionalPair)
    }
  } else {
    if (sourceLanguage === targetLanguage) {
      return { success: false, errorType: 'same_language' }
    }
    return { success: true, language: targetLanguage }
  }
}

/**
 * 处理滚动同步
 * @param sourceElement 源元素
 * @param targetElement 目标元素
 * @param isProgrammaticScrollRef 是否程序控制滚动的引用
 */
export const handleScrollSync = (
  sourceElement: HTMLElement,
  targetElement: HTMLElement,
  isProgrammaticScrollRef: MutableRefObject<boolean>
): void => {
  if (isProgrammaticScrollRef.current) return

  isProgrammaticScrollRef.current = true

  // 计算滚动位置比例
  const scrollRatio = sourceElement.scrollTop / (sourceElement.scrollHeight - sourceElement.clientHeight || 1)
  targetElement.scrollTop = scrollRatio * (targetElement.scrollHeight - targetElement.clientHeight || 1)

  requestAnimationFrame(() => {
    isProgrammaticScrollRef.current = false
  })
}

/**
 * 创建输入区域滚动处理函数
 */
export const createInputScrollHandler = (
  targetRef: MutableRefObject<HTMLDivElement | null>,
  isProgrammaticScrollRef: MutableRefObject<boolean>,
  isScrollSyncEnabled: boolean
) => {
  return (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (!isScrollSyncEnabled || !targetRef.current || isProgrammaticScrollRef.current) return
    handleScrollSync(e.currentTarget, targetRef.current, isProgrammaticScrollRef)
  }
}

/**
 * 创建输出区域滚动处理函数
 */
export const createOutputScrollHandler = (
  textAreaRef: MutableRefObject<any>,
  isProgrammaticScrollRef: MutableRefObject<boolean>,
  isScrollSyncEnabled: boolean
) => {
  return (e: React.UIEvent<HTMLDivElement>) => {
    const inputEl = textAreaRef.current?.resizableTextArea?.textArea
    if (!isScrollSyncEnabled || !inputEl || isProgrammaticScrollRef.current) return
    handleScrollSync(e.currentTarget, inputEl, isProgrammaticScrollRef)
  }
}

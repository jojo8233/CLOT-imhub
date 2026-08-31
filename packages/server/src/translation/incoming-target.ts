import { bilingualTranslationTarget } from '@im-hub/shared'

export { bilingualTranslationTarget }

/** 兼容既有调用方；新代码应使用不限定方向的名称。 */
export const incomingTranslationTarget = bilingualTranslationTarget

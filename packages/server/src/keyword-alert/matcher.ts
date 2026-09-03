import { KEYWORD_RULE_PATTERN_MAX_CODE_POINTS } from '@im-hub/shared'

const EXCERPT_MAX_CODE_POINTS = 160

interface TrieNode {
  transitions: Map<string, number>
  failure: number
  outputRuleIndexes: number[]
}

interface NormalizedTextMapping {
  normalizedText: string
  originalCharacters: string[]
  originalIndexByNormalizedIndex: number[]
}

export class KeywordPatternError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeywordPatternError'
  }
}

export function normalizeKeywordText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

export function normalizeKeywordPattern(value: string): string {
  if (containsControlCharacter(value)) {
    throw new KeywordPatternError('Keyword patterns cannot contain control characters')
  }

  const normalized = normalizeKeywordText(value.trim())
  if (containsControlCharacter(normalized)) {
    throw new KeywordPatternError('Keyword patterns cannot contain control characters')
  }

  const codePointLength = Array.from(normalized).length
  if (codePointLength === 0) {
    throw new KeywordPatternError('Keyword patterns cannot be empty')
  }
  if (codePointLength > KEYWORD_RULE_PATTERN_MAX_CODE_POINTS) {
    throw new KeywordPatternError(
      `Keyword patterns cannot exceed ${KEYWORD_RULE_PATTERN_MAX_CODE_POINTS} code points`,
    )
  }

  return normalized
}

export interface KeywordMatcherRule {
  id: string
  normalizedPattern: string
}

export class AhoCorasickKeywordMatcher {
  private readonly nodes: TrieNode[]
  private readonly ruleIds: string[]

  constructor(rules: readonly KeywordMatcherRule[]) {
    this.nodes = [{
      transitions: new Map(),
      failure: 0,
      outputRuleIndexes: [],
    }]
    this.ruleIds = rules.map(rule => rule.id)

    for (const [ruleIndex, rule] of rules.entries()) {
      this.addRule(ruleIndex, rule.normalizedPattern)
    }
    this.buildFailureLinks()
  }

  matchRuleIds(body: string): string[] {
    const matchedRuleIndexes = new Set<number>()
    let state = 0

    for (const character of Array.from(normalizeKeywordText(body))) {
      state = this.nextState(state, character)
      const node = this.nodes[state]
      if (node === undefined) {
        continue
      }
      for (const ruleIndex of node.outputRuleIndexes) {
        matchedRuleIndexes.add(ruleIndex)
      }
    }

    const seenRuleIds = new Set<string>()
    const orderedRuleIds: string[] = []
    for (const [ruleIndex, ruleId] of this.ruleIds.entries()) {
      if (matchedRuleIndexes.has(ruleIndex) && !seenRuleIds.has(ruleId)) {
        seenRuleIds.add(ruleId)
        orderedRuleIds.push(ruleId)
      }
    }
    return orderedRuleIds
  }

  private addRule(ruleIndex: number, normalizedPattern: string): void {
    let state = 0
    for (const character of Array.from(normalizedPattern)) {
      const node = this.nodes[state]
      if (node === undefined) {
        throw new Error('Aho-Corasick trie state is missing')
      }

      const existingState = node.transitions.get(character)
      if (existingState !== undefined) {
        state = existingState
        continue
      }

      const newState = this.nodes.length
      this.nodes.push({
        transitions: new Map(),
        failure: 0,
        outputRuleIndexes: [],
      })
      node.transitions.set(character, newState)
      state = newState
    }

    const finalNode = this.nodes[state]
    if (finalNode === undefined) {
      throw new Error('Aho-Corasick trie state is missing')
    }
    finalNode.outputRuleIndexes.push(ruleIndex)
  }

  private buildFailureLinks(): void {
    const root = this.nodes[0]
    if (root === undefined) {
      throw new Error('Aho-Corasick trie root is missing')
    }

    const queue: number[] = []
    for (const childState of root.transitions.values()) {
      const child = this.nodes[childState]
      if (child === undefined) {
        throw new Error('Aho-Corasick trie state is missing')
      }
      child.failure = 0
      queue.push(childState)
    }

    let queueIndex = 0
    while (queueIndex < queue.length) {
      const state = queue[queueIndex]
      queueIndex += 1
      if (state === undefined) {
        continue
      }
      const node = this.nodes[state]
      if (node === undefined) {
        throw new Error('Aho-Corasick trie state is missing')
      }

      for (const [character, childState] of node.transitions) {
        const child = this.nodes[childState]
        if (child === undefined) {
          throw new Error('Aho-Corasick trie state is missing')
        }

        let failureState = node.failure
        let failureNode = this.nodeAt(failureState)
        while (failureState !== 0 && !failureNode.transitions.has(character)) {
          failureState = failureNode.failure
          failureNode = this.nodeAt(failureState)
        }

        const transitionState = failureNode.transitions.get(character)
        child.failure = transitionState ?? 0
        const failureOutputs = this.nodeAt(child.failure).outputRuleIndexes
        child.outputRuleIndexes.push(...failureOutputs)
        queue.push(childState)
      }
    }
  }

  private nextState(state: number, character: string): number {
    let nextState = this.nodeAt(state).transitions.get(character)
    while (state !== 0 && nextState === undefined) {
      state = this.nodeAt(state).failure
      nextState = this.nodeAt(state).transitions.get(character)
    }
    return nextState ?? 0
  }

  private nodeAt(state: number): TrieNode {
    const node = this.nodes[state]
    if (node === undefined) {
      throw new Error('Aho-Corasick trie state is missing')
    }
    return node
  }
}

export function keywordAlertExcerpt(
  currentBody: string,
  pattern: string,
  deleted: boolean,
): string | null {
  if (deleted) {
    return null
  }

  const mapping = mapNormalizedText(currentBody)
  const normalizedPattern = normalizeKeywordText(pattern)
  if (normalizedPattern.length === 0) {
    return currentBodyPrefix(mapping.originalCharacters)
  }

  const matchOffset = mapping.normalizedText.indexOf(normalizedPattern)
  if (matchOffset === -1) {
    return currentBodyPrefix(mapping.originalCharacters)
  }

  const normalizedStart = Array.from(mapping.normalizedText.slice(0, matchOffset)).length
  const normalizedLength = Array.from(normalizedPattern).length
  const originalStart = mapping.originalIndexByNormalizedIndex[normalizedStart]
  const originalEnd = mapping.originalIndexByNormalizedIndex[normalizedStart + normalizedLength - 1]
  if (originalStart === undefined || originalEnd === undefined) {
    return currentBodyPrefix(mapping.originalCharacters)
  }

  return excerptAroundMatch(mapping.originalCharacters, originalStart, originalEnd + 1)
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) {
      return true
    }
  }
  return false
}

function mapNormalizedText(value: string): NormalizedTextMapping {
  const originalCharacters = Array.from(value)
  const normalizedText = normalizeKeywordText(value)
  const mappedNormalizedCharacters: string[] = []
  const originalIndexByNormalizedIndex: number[] = []

  for (const [originalIndex, character] of originalCharacters.entries()) {
    for (const normalizedCharacter of Array.from(normalizeKeywordText(character))) {
      mappedNormalizedCharacters.push(normalizedCharacter)
      originalIndexByNormalizedIndex.push(originalIndex)
    }
  }

  if (mappedNormalizedCharacters.join('') !== normalizedText) {
    return {
      normalizedText,
      originalCharacters,
      originalIndexByNormalizedIndex: [],
    }
  }

  return {
    normalizedText,
    originalCharacters,
    originalIndexByNormalizedIndex,
  }
}

function excerptAroundMatch(
  originalCharacters: readonly string[],
  matchStart: number,
  matchEnd: number,
): string {
  const excerptLength = Math.min(EXCERPT_MAX_CODE_POINTS, originalCharacters.length)
  const matchLength = matchEnd - matchStart
  const centeredStart = matchStart - Math.floor((excerptLength - matchLength) / 2)
  const maxStart = originalCharacters.length - excerptLength
  const start = Math.min(Math.max(centeredStart, 0), maxStart)
  return originalCharacters.slice(start, start + excerptLength).join('')
}

function currentBodyPrefix(originalCharacters: readonly string[]): string {
  return originalCharacters.slice(0, EXCERPT_MAX_CODE_POINTS).join('')
}

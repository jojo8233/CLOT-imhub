export type HiddenInputErrorCode = 'TTY_REQUIRED' | 'CANCELLED'

const ERROR_MESSAGES: Record<HiddenInputErrorCode, string> = {
  TTY_REQUIRED: 'interactive TTY is required',
  CANCELLED: 'input cancelled',
}

export class HiddenInputError extends Error {
  constructor(readonly code: HiddenInputErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'HiddenInputError'
  }
}

export interface HiddenInputIo {
  isInputTty(): boolean
  isRawMode(): boolean
  setRawMode(enabled: boolean): void
  write(value: string): void
  listen(listener: (chunk: string) => void): () => void
}

function processIo(): HiddenInputIo {
  return {
    isInputTty: () => process.stdin.isTTY === true,
    isRawMode: () => process.stdin.isRaw === true,
    setRawMode: enabled => process.stdin.setRawMode(enabled),
    write: value => {
      process.stdout.write(value)
    },
    listen: (listener) => {
      const wasPaused = process.stdin.isPaused()
      const onData = (chunk: string | Buffer): void => listener(chunk.toString())
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', onData)
      process.stdin.resume()
      return () => {
        process.stdin.off('data', onData)
        if (wasPaused) process.stdin.pause()
      }
    },
  }
}

export async function readHiddenLine(
  prompt: string,
  io: HiddenInputIo = processIo(),
): Promise<string> {
  if (!io.isInputTty()) throw new HiddenInputError('TTY_REQUIRED')

  const previousRawMode = io.isRawMode()
  let stopListening = (): void => {}
  let rawModeChanged = false
  io.write(prompt)

  try {
    io.setRawMode(true)
    rawModeChanged = true
    return await new Promise<string>((resolve, reject) => {
      const codePoints: string[] = []
      let inEscapeSequence = false
      stopListening = io.listen((chunk) => {
        for (const character of Array.from(chunk)) {
          if (inEscapeSequence) {
            if (character >= '@' && character <= '~') inEscapeSequence = false
            continue
          }
          if (character === '\u001b') {
            inEscapeSequence = true
            continue
          }
          if (character === '\r' || character === '\n') {
            io.write('\n')
            resolve(codePoints.join(''))
            return
          }
          if (character === '\u0003' || character === '\u0004') {
            io.write('\n')
            reject(new HiddenInputError('CANCELLED'))
            return
          }
          if (character === '\u0008' || character === '\u007f') {
            codePoints.pop()
            continue
          }
          const codePoint = character.codePointAt(0)
          if (codePoint === undefined || codePoint < 32) continue
          codePoints.push(character)
        }
      })
    })
  } finally {
    stopListening()
    if (rawModeChanged) io.setRawMode(previousRawMode)
  }
}

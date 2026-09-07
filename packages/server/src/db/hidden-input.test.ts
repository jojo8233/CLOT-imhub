import { describe, expect, it } from 'vitest'
import {
  HiddenInputError,
  readHiddenLine,
  type HiddenInputIo,
} from './hidden-input.js'

class FakeHiddenInputIo implements HiddenInputIo {
  readonly writes: string[] = []
  readonly rawModeChanges: boolean[] = []
  private listener: ((chunk: string) => void) | null = null

  constructor(
    readonly inputIsTty = true,
    private rawMode = false,
  ) {}

  isInputTty(): boolean {
    return this.inputIsTty
  }

  isRawMode(): boolean {
    return this.rawMode
  }

  setRawMode(enabled: boolean): void {
    this.rawMode = enabled
    this.rawModeChanges.push(enabled)
  }

  write(value: string): void {
    this.writes.push(value)
  }

  listen(listener: (chunk: string) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }

  send(chunk: string): void {
    this.listener?.(chunk)
  }
}

describe('readHiddenLine', () => {
  it('读取、编辑并返回密码，但输出中从不包含密码', async () => {
    const io = new FakeHiddenInputIo()
    const password = 'synthetic-hidden-password-sentinel'
    const reading = readHiddenLine('临时密码：', io)

    io.send(`${password}x`)
    io.send('\u007f')
    io.send('\r')

    await expect(reading).resolves.toBe(password)
    expect(io.writes).toEqual(['临时密码：', '\n'])
    expect(io.writes.join('')).not.toContain(password)
    expect(io.rawModeChanges).toEqual([true, false])
    expect(io.isRawMode()).toBe(false)
  })

  it('Ctrl-C 取消时恢复原始终端模式且不输出输入', async () => {
    const io = new FakeHiddenInputIo(true, false)
    const reading = readHiddenLine('再次输入：', io)

    io.send('must-never-be-echoed')
    io.send('\u0003')

    await expect(reading).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(io.writes).toEqual(['再次输入：', '\n'])
    expect(io.writes.join('')).not.toContain('must-never-be-echoed')
    expect(io.rawModeChanges).toEqual([true, false])
  })

  it('拒绝非交互式标准输入，防止通过管道提供密码', async () => {
    const io = new FakeHiddenInputIo(false)

    await expect(readHiddenLine('临时密码：', io)).rejects.toEqual(
      new HiddenInputError('TTY_REQUIRED'),
    )
    expect(io.writes).toEqual([])
    expect(io.rawModeChanges).toEqual([])
  })
})

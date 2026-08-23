import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // repo.test.ts 会 truncate 真实数据库来保证每个用例从干净状态开始。
    // vitest 默认并行跑不同测试文件，一旦将来出现第二个连真库的测试文件，
    // 两者的 truncate 会互相踩，产生极难复现的偶发失败。
    // 整个套件跑完不到 1 秒，关掉文件级并行的代价可以忽略。
    fileParallelism: false,
  },
})

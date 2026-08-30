import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPackageWithOptions, extractAll, extractFile, getRawHeader } from '@electron/asar'

const SUPPORTED_VERSION = '8.25.0'
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopOutput = resolve(scriptDirectory, '..', 'out')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`${label} 补丁锚点数量异常：${count}`)
  return source.replace(before, after)
}

function replaceEvery(source, before, after, expected, label) {
  const count = source.split(before).length - 1
  if (count !== expected) throw new Error(`${label} 补丁锚点数量异常：${count}`)
  return source.split(before).join(after)
}

function setPlist(plist, key, value) {
  const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' })
  if (set.status === 0) return
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], { stdio: 'ignore' })
}

if (process.platform !== 'darwin') throw new Error('当前 Signal Desktop 准备脚本只支持 macOS')

const source = argument('--source')
const output = argument('--output')
const profileSource = argument('--profile-source')
if (!source || !output) {
  throw new Error('用法：prepare:signal -- --source /Applications/Signal.app --output /private/tmp/Signal-imhub.app [--profile-source /private/tmp/旧测试包.app]')
}

const sourceApp = resolve(source)
const outputApp = resolve(output)
if (!sourceApp.endsWith('.app') || !outputApp.endsWith('.app')) throw new Error('source/output 必须是绝对 .app 路径')
if (sourceApp === outputApp) throw new Error('禁止原地修改 Signal.app；请指定新的 output')
if (!existsSync(sourceApp)) throw new Error('找不到 source Signal.app')
if (existsSync(outputApp)) throw new Error('output 已存在；为避免覆盖，请换一个新路径')
const profileSourceArchive = profileSource
  ? join(resolve(profileSource), 'Contents', 'Resources', 'app.asar')
  : null
if (profileSourceArchive && !existsSync(profileSourceArchive)) {
  throw new Error('找不到 profile-source 的 app.asar')
}
for (const required of [
  join(desktopOutput, 'main', 'signal-integrated-host.js'),
  join(desktopOutput, 'preload', 'index.mjs'),
  join(desktopOutput, 'renderer', 'index.html'),
]) {
  if (!existsSync(required)) throw new Error('找不到最新桌面构建产物；请先运行 pnpm build')
}

const workDirectory = mkdtempSync(join(tmpdir(), 'imhub-signal-build-'))
const extracted = join(workDirectory, 'app')
let succeeded = false

try {
  execFileSync('/usr/bin/ditto', [sourceApp, outputApp], { stdio: 'ignore' })
  const resources = join(outputApp, 'Contents', 'Resources')
  const archive = join(resources, 'app.asar')
  if (!existsSync(archive)) throw new Error('source 中没有 Resources/app.asar')

  extractAll(archive, extracted)
  const packageJson = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(`只支持 Signal Desktop ${SUPPORTED_VERSION}，当前是 ${String(packageJson.version)}`)
  }

  const mainPath = join(extracted, 'bundles', 'main.js')
  let main = readFileSync(mainPath, 'utf8')
  main = replaceOnce(
    main,
    'X.info(`Initializing BrowserWindow config:`,g),Z=new f.BrowserWindow(g),nv',
    'X.info(`Initializing BrowserWindow config:`,g),Z=await import(`../imhub/main/signal-integrated-host.js`).then(e=>e.createHost(g)),nv',
    '同窗口 Signal WebContentsView',
  )
  main = replaceOnce(
    main,
    'f.app.on(`web-contents-created`,(e,t)=>{t.on(`will-attach-webview`,e=>{e.preventDefault()}),t.setWindowOpenHandler(()=>({action:`deny`}))})',
    'f.app.on(`web-contents-created`,(e,t)=>{t.on(`will-attach-webview`,e=>{t.__imhubHostContents||e.preventDefault()}),t.__imhubHostContents||t.setWindowOpenHandler(()=>({action:`deny`}))})',
    '只对 im-hub 宿主放行 webview',
  )
  main = replaceEvery(
    main,
    'f.app.setLoginItemSettings(',
    '!1&&f.app.setLoginItemSettings(',
    3,
    '禁止修改开机启动',
  )
  main = replaceEvery(
    main,
    'f.app.setAsDefaultProtocolClient(',
    '!1&&f.app.setAsDefaultProtocolClient(',
    2,
    '禁止修改默认协议',
  )
  writeFileSync(mainPath, main)

  const signalPreloadMainPath = join(extracted, 'bundles', 'preload', 'main.js')
  let signalPreloadMain = readFileSync(signalPreloadMainPath, 'utf8')
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'await U.updateConversation(this.attributes)),this.addSingleMessage(e.attributes))}async addSingleMessage',
    'await U.updateConversation(this.attributes)),this.addSingleMessage(e.attributes),await window.__imHubSignalBridge?.onNewMessage(this,e,o))}async addSingleMessage',
    'Signal 入站消息桥接',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'u.contextBridge.exposeInMainWorld(`startApp`,window.startApp)',
    'u.contextBridge.exposeInMainWorld(`startApp`,(...e)=>(u.ipcRenderer.send(`imhub:signal-bridge-bootstrap`,`start-called`),import(require(`node:url`).pathToFileURL(require(`node:path`).join(__dirname,`..`,`..`,`imhub`,`preload`,`signal-bridge.mjs`)).href).then(t=>(t.installSignalPreloadBridge(window),u.ipcRenderer.send(`imhub:signal-bridge-bootstrap`,`installed`),window.startApp(...e))).catch(()=>{throw u.ipcRenderer.send(`imhub:signal-bridge-bootstrap`,`failed`),console.error(`[im-hub] Signal bridge preload failed`),new Error(`Signal bridge preload failed`)})))',
    'Signal startApp 桥接安装',
  )
  writeFileSync(signalPreloadMainPath, signalPreloadMain)

  const imhubRoot = join(extracted, 'imhub')
  mkdirSync(imhubRoot, { recursive: true })
  writeFileSync(join(imhubRoot, 'package.json'), '{"type":"module"}\n')
  cpSync(join(desktopOutput, 'main'), join(imhubRoot, 'main'), { recursive: true })
  cpSync(join(desktopOutput, 'preload'), join(imhubRoot, 'preload'), { recursive: true })
  cpSync(join(desktopOutput, 'renderer'), join(imhubRoot, 'renderer'), { recursive: true })

  const localConfigPath = join(extracted, 'config', 'local-production.json')
  if (profileSourceArchive) {
    // 只做不透明复制，不解析、不打印隔离资料位置或其他配置值。
    writeFileSync(localConfigPath, extractFile(profileSourceArchive, 'config/local-production.json'))
  } else {
    const localConfig = JSON.parse(readFileSync(localConfigPath, 'utf8'))
    localConfig.updatesEnabled = false
    writeFileSync(localConfigPath, `${JSON.stringify(localConfig, null, 2)}\n`)
  }

  rmSync(archive, { force: true })
  rmSync(join(resources, 'app.asar.unpacked'), { recursive: true, force: true })
  rmSync(join(resources, 'app'), { recursive: true, force: true })
  rmSync(join(resources, 'app.asar.official'), { force: true })
  await createPackageWithOptions(extracted, archive, { unpack: '**/*.node' })

  const { headerString } = getRawHeader(archive)
  const headerHash = createHash('sha256').update(headerString).digest('hex')
  const plist = join(outputApp, 'Contents', 'Info.plist')
  setPlist(plist, 'CFBundleIdentifier', 'org.imhub.SignalDesktop')
  // 与上一版隔离测试包保持一致，确保继续使用它已关联的测试资料。
  setPlist(plist, 'CFBundleDisplayName', 'Signal im-hub')
  setPlist(plist, 'ElectronAsarIntegrity:Resources/app.asar:hash', headerHash)

  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', outputApp], { stdio: 'ignore' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', outputApp], { stdio: 'ignore' })
  succeeded = true
  console.log(`Signal Desktop ${SUPPORTED_VERSION} im-hub 同窗口测试包已生成：${outputApp}`)
} finally {
  rmSync(workDirectory, { recursive: true, force: true })
  if (!succeeded) rmSync(outputApp, { recursive: true, force: true })
}

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

function assertOccurrence(source, needle, expected, label) {
  const count = source.split(needle).length - 1
  if (count !== expected) throw new Error(`${label} 源码边界数量异常：${count}`)
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
  assertOccurrence(
    signalPreloadMain,
    'onEditorStateChange:tZt',
    1,
    'Signal 原生草稿 action',
  )
  assertOccurrence(
    signalPreloadMain,
    'window.reduxActions.composer.setComposerFocus',
    1,
    'Signal 原生 Composer 聚焦 action',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'xe=(0,LZ.useCallback)(()=>{let e=Date.now();if(ce.current===void 0)return;if(!ue.current){rLn.warn(`Not submitting message - cannot send right now`);return}let{text:t,bodyRanges:n}=ge();rLn.info(`Submitting message ${e} with ${n.length} ranges`),ue.current=!1,T(t,n,e)||(ue.current=!0)},[T])',
    'xe=(0,LZ.useCallback)(e=>{if(e=e===void 0?Date.now():e,!Number.isSafeInteger(e)||ce.current===void 0)return!1;if(!ue.current)return rLn.warn(`Not submitting message - cannot send right now`),!1;let{text:t,bodyRanges:n}=ge();rLn.info(`Submitting message ${e} with ${n.length} ranges`),ue.current=!1;let a=T(t,n,e);return a||(ue.current=!0),a},[T])',
    'Signal CompositionInput attempt 时间戳提交',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    '(0,LZ.useImperativeHandle)(p,()=>({focus:_e,hasFocus:Se,insertEmoji:ve,setContents:be,reset:ye,submit:xe}),[_e,Se,ve,ye,be,xe]),(0,LZ.useEffect)(()=>{le.current=e},[e])',
    '(0,LZ.useImperativeHandle)(p,()=>({focus:_e,hasFocus:Se,insertEmoji:ve,setContents:be,reset:ye,submit:xe}),[_e,Se,ve,ye,be,xe]),(0,LZ.useEffect)(()=>{if(!o)return;let e={conversationId:o,readDraft:()=>ce.current===void 0?null:ge().text,setDraft:e=>{if(ce.current===void 0||typeof e!=`string`)return!1;return be(e,[],!0),!0},submit:e=>Number.isSafeInteger(e)&&xe(e)===!0};return window.__imHubSignalComposerEditor=e,()=>{window.__imHubSignalComposerEditor===e&&delete window.__imHubSignalComposerEditor}},[o,be,xe]),(0,LZ.useEffect)(()=>{le.current=e},[e])',
    'Signal 可见 Composer 草稿接口',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'if(r)return window.MessageCache.register(new Hp(r))}var lle,Gp=',
    // ii(message) 是 Signal 本机 ConversationModel.id，不是 sourceServiceId；它只适合
    // Signal 内部会话关联，不能与 im-hub 的规范发送者键比较。先用官方 DataReader 按
    // sent_at 取候选；入站按消息自身 sender、出站按 self ACI 筛选。guest store 还会
    // 二次校验方向、规范 sender、sent_at 与 edit revision，避免时间戳碰撞或迟到译文串消息。
    'if(r)return window.MessageCache.register(new Hp(r))}window.__imHubSignalResolveOutgoingMessage=e=>Aa.getMessageById(e),window.__imHubSignalResolveMessageForTranslation=async(e,t)=>{let n=window.ConversationController.getOurConversationOrThrow().getAci()?.toLowerCase(),r=(await Aa.getMessagesBySentAt(t)).find(t=>t.type===`outgoing`?n===e:t.type===`incoming`&&(t.sourceServiceId?.toLowerCase()===e||t.source===e));return r?window.MessageCache.register(new Hp(r)):null},window.__imHubSignalListMessagesForTranslation=async(e,t)=>{if(typeof e!=`string`||!Number.isSafeInteger(t)||t<1||t>200)return[];let n=await Aa.getOlderMessagesByConversation({conversationId:e,limit:t,storyId:void 0,includeStoryReplies:!1});return n.map(e=>window.MessageCache.register(new Hp(e)))};var lle,Gp=',
    'Signal 最终出向消息、双向译文解析与历史回填 action',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    '}),EA=class extends bA.PureComponent{',
    '}),imHubSignalTranslationSubscribe=()=>()=>{},imHubSignalTranslationView=({messageId:e})=>{let t=window.__imHubSignalTranslations,n=(0,bA.useSyncExternalStore)(t?t.subscribe:imHubSignalTranslationSubscribe,()=>t?.get(e)??null,()=>null);return n?(0,SA.jsx)(`div`,{style:{marginTop:`6px`,paddingTop:`6px`,borderTop:`1px solid currentColor`,fontSize:`0.92em`,lineHeight:1.35,opacity:.82,whiteSpace:`pre-wrap`,overflowWrap:`anywhere`},children:n}):null},EA=class extends bA.PureComponent{',
    'Signal 消息气泡译文 React 组件',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'text:e,textAttachment:g}),this.#r()===CA.InlineWithText',
    'text:e,textAttachment:g}),v==null&&(0,SA.jsx)(imHubSignalTranslationView,{messageId:c}),this.#r()===CA.InlineWithText',
    'Signal 消息气泡原文后插入译文',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'E=window.MessageCache.register(new Hp(T)),D=Date.now();t.ca(typeof E.get(`timestamp`)==`number`,`Expected a timestamp`),this.enableProfileSharing',
    'E=window.MessageCache.register(new Hp(T)),D=Date.now();await window.__imHubSignalBridge?.onOutgoingMessagePrepared(E),t.ca(typeof E.get(`timestamp`)==`number`,`Expected a timestamp`),this.enableProfileSharing',
    'Signal 出向 attempt 本地消息标识',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'await window.MessageCache.saveMessage(E,{jobToInsert:e,forceSave:!0})});let O=Date.now()-D;',
    'await window.MessageCache.saveMessage(E,{jobToInsert:e,forceSave:!0})}),await window.__imHubSignalBridge?.onOutgoingMessagePersisted(E);let O=Date.now()-D;',
    'Signal 最终出向消息持久化确认',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'await U.updateConversation(this.attributes)),this.addSingleMessage(e.attributes))}async addSingleMessage',
    'await U.updateConversation(this.attributes)),this.addSingleMessage(e.attributes),await window.__imHubSignalBridge?.onNewMessage(this,e,o))}async addSingleMessage',
    'Signal 入站消息桥接',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'if(await U.saveEditedMessage(c.attributes,W.user.getCheckedAci(),{conversationId:t.conversationId,messageId:e.id,readStatus:v,sentAt:u.timestamp}),_){',
    'if(await U.saveEditedMessage(c.attributes,W.user.getCheckedAci(),{conversationId:t.conversationId,messageId:e.id,readStatus:v,sentAt:u.timestamp}),await window.__imHubSignalBridge?.onMessageEdited(_,c,window.ConversationController.get(t.fromId)),_){',
    'Signal 入站编辑桥接',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'n&&(await U.removeMessageById(e.attributes.id,{cleanupMessages:async()=>{}}),await window.MessageCache.saveMessage(e.attributes,{forceSave:!0}))}finally',
    'n&&(await U.removeMessageById(e.attributes.id,{cleanupMessages:async()=>{}}),await window.MessageCache.saveMessage(e.attributes,{forceSave:!0})),await window.__imHubSignalBridge?.onMessageDeleted(e,t)}finally',
    'Signal 入站删除桥接',
  )
  signalPreloadMain = replaceOnce(
    signalPreloadMain,
    'else o&&!qr(e.attributes)&&(await window.MessageCache.saveMessage(e.attributes),window.reduxActions.conversations.markOpenConversationRead(c.id))}var jJt',
    'else o&&!qr(e.attributes)&&(await window.MessageCache.saveMessage(e.attributes),window.reduxActions.conversations.markOpenConversationRead(c.id));r||await window.__imHubSignalBridge?.onReaction(e,n,window.ConversationController.get(n.fromId))}var jJt',
    'Signal 入站回应桥接',
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

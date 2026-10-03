// Chat.vue 的挂载用例：真 mount 视图，走完一次「提问 -> 流式回答」的主路径（issue #180 验收 2）。
//
// 由来：`git grep Chat.vue tests/` 此前只命中两处，且**都不是挂载** ——
// `chatStore.test.js` 里是一个桩字符串，`test_internal_error_no_echo.py` 是后端用例。
// 视图自己的胶水（`sendMessage` 的清空输入、`handleInputEnter` 的 Enter / Shift 分支
// 与 IME 合成守卫、流式占位的渲染、知识库选中的接线）此前全部只有阅读证据，
// 键盘那几条现在由文件末尾的 d 组用例接管。
//
// 与既有用例的分工：
//   tests/chatStore.test.js  用 registerHooks 换掉 `@/api/chat`，测 **store** 的状态机
//   tests/streamEvents.test.js / chatApi.test.js  测流解析与响应校验的**纯函数**
//   本文件                    视图真的跑起来之后：点「发送」到底发出去了什么、
//                            屏幕上的气泡是谁渲染的、store 被改成了什么
//
// 替身扎在两处**模块/平台边界**上，被测代码照常真跑：
//   api/request.js -> stubApiRequest.js   只换 HTTP 出口（REST 那几个接口）
//   globalThis.fetch                      流式问答走的是 fetch，不是 axios（见 src/api/chat.js），
//                                         所以流那条链路换的是平台出口，chatStore / streamEvents /
//                                         chat.js 全是真货
// 于是「回答上屏」是组件真实响应式状态驱动的 DOM 结果：助手气泡由真的
// MarkdownRenderer.vue 渲染（子组件也是真实 SFC，不是桩件）。
//
// 路由：Chat.vue 用 useRoute/useRouter，挂载时给一个 memory history 的路由。
// 路由指向哪个组件不重要（本文件只挂 Chat.vue 自己），但路由表必须存在，
// 否则 `router.replace('/chat/c1')` 会抛「No match」。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mountSfc } from './helpers/vueMount.js'
import { calls, callsOf, resetRequestStub, respond } from './helpers/stubApiRequest.js'

// vue-router 必须**动态** import，且排在 vueMount 之后 —— 它自己 import 'vue'，
// 而 vue 的 runtime-dom 在模块求值时就抓走 document
//（`const doc = typeof document !== 'undefined' ? document : null`），
// 静态 import 会让这行跑在 vueMount 装 jsdom 全局之前，症状是挂载时
// 「Cannot read properties of null (reading 'createElement')」。
// 与 vueMount.js 文件头「不要在同一文件里再静态 import vue」是同一条约束。
const { createMemoryHistory, createRouter } = await import('vue-router')

const MODULES = {
  'api/request.js': new URL('./helpers/stubApiRequest.js', import.meta.url).href,
}

const KB1 = { id: 'kb1', name: 'KB1' }
const KB2 = { id: 'kb2', name: 'KB2' }
const CONV1 = { id: 'c1', title: '对话一', knowledge_base_id: 'kb1', knowledge_base_name: 'KB1' }

const encoder = new TextEncoder()

// 把若干 SSE 帧做成真的 ReadableStream：readStreamEvents 走的是 getReader()，
// 换成一个数组/字符串都会在解码那一步露馅。
function sseStream(frames) {
  const encoded = frames.map((frame) => encoder.encode(frame))
  return new ReadableStream({
    pull(controller) {
      if (!encoded.length) {
        controller.close()
        return
      }
      controller.enqueue(encoded.shift())
    },
  })
}

// 流式出口的替身：记录每次 fetch，并按用例给的帧序列作答。
function installStreamStub(frames) {
  const streamCalls = []
  globalThis.fetch = async (url, options) => {
    streamCalls.push({ url, options })
    return {
      ok: true,
      body: sseStream(frames),
      async json() {
        return {}
      },
    }
  }
  return streamCalls
}

const ANSWER_FRAMES = [
  'data: {"type":"conversation","conversation":{"id":"c1","title":"新对话","knowledge_base_id":"kb1","knowledge_base_name":"KB1"}}\n\n',
  'data: {"type":"token","content":"你好"}\n\n',
  'data: {"type":"token","content":"，世界"}\n\n',
  'data: [DONE]\n\n',
]

const settle = async (view) => {
  await view.flush(8)
  await new Promise((resolve) => setTimeout(resolve, 40))
}

async function until(view, predicate, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await view.flush(1)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function createTestRouter() {
  const blank = { render: () => null }
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/chat' },
      { path: '/chat', name: 'Chat', component: blank },
      { path: '/chat/:id', name: 'ChatDetail', component: blank },
      { path: '/knowledge', component: blank },
      { path: '/login', component: blank },
    ],
  })
}

// 服务端替身：一个会话 + 它已经落库的消息。
// 消息列表**必须**带上刚发出去的那条提问与它的回答：流结束后 store 会按
// `refreshMessages` 重新拉一遍并把结果写回 messages，服务端若返回空列表，
// 屏幕上刚发的气泡会被这次刷新整条抹掉（用例红的会是「用户气泡不在」，而不是被测的接线）。
const PERSISTED = [
  { id: 1, role: 'user', content: '这是一个问题', created_at: '2024-01-01T00:00:01Z' },
  { id: 2, role: 'assistant', content: '你好，世界', created_at: '2024-01-01T00:00:02Z' },
]

async function mountChat({ bases = [KB1, KB2], streamFrames = ANSWER_FRAMES, messages = PERSISTED, route = '/chat' } = {}) {
  resetRequestStub()
  respond('get', (url) => {
    if (url === '/knowledge-bases') return bases
    if (url === '/chat/conversations') return [CONV1]
    if (url === '/chat/conversations/c1') return messages
    return {}
  })
  const streamCalls = installStreamStub(streamFrames)

  const router = createTestRouter()
  await router.push(route)
  await router.isReady()

  const view = await mountSfc('views/Chat.vue', { modules: MODULES, plugins: [router] })
  await settle(view)
  return { view, router, streamCalls }
}

// 输入并点「发送」。返回点击前的水位线（fetch 的调用数）。
async function sendQuestion(view, text) {
  const textarea = view.query('footer textarea')
  assert.ok(textarea, '页面上应当有提问用的输入框')
  textarea.value = text
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await view.flush(3)

  const button = view.buttonByText('发送')
  assert.ok(button, '页面上应当有「发送」按钮')
  assert.equal(button.disabled, false, '输入内容后「发送」按钮应当可用（否则后面只是空转）')

  const mark = globalThis.__streamCalls.length
  button.click()
  return mark
}

// 在输入框上按一次 Enter。cancelable: true 是必须的：断言面是「守卫有没有走到
// preventDefault」，不可取消的事件恒为 defaultPrevented === false，会让对照组假绿。
async function pressEnter(view, init = {}) {
  const textarea = view.query('footer textarea')
  assert.ok(textarea, '页面上应当有提问用的输入框')
  const event = new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...init,
  })
  textarea.dispatchEvent(event)
  await view.flush(3)
  return event
}

// 进入合成态并打入一段「尚未上屏」的文本：先 compositionstart 置 isComposing，
// 再把 DOM 值改掉并以 isComposing 的 input 通知（el-input 此时会早退，v-model 不动）。
async function typeDuringComposition(view, text) {
  const textarea = view.query('footer textarea')
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  textarea.value = text
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: text }))
  await view.flush(3)
  return textarea
}

async function close(view) {
  view.elementPlusUnpatch()
  await view.unmount()
}

// ---------------------------------------------------------------------------
// a. 主路径：提问 -> 流式回答上屏
// ---------------------------------------------------------------------------

test('发送消息：问题进入流式请求，回答经 MarkdownRenderer 上屏，输入框清空', async () => {
  const { view, streamCalls } = await mountChat()
  globalThis.__streamCalls = streamCalls

  try {
    assert.match(view.text(), /今天想了解什么/, '空会话时应当渲染欢迎区（控制项）')

    const mark = await sendQuestion(view, '这是一个问题')
    await until(view, () => streamCalls.length > mark)
    await until(view, () => view.text().includes('你好'))
    await settle(view)

    // 承重①：流式请求真的发出去了，且带上了问题本身与选中的知识库。
    assert.equal(streamCalls.length - mark, 1, '点「发送」应当恰好发一次流式请求')
    const [{ url, options }] = streamCalls.slice(mark)
    assert.match(url, /\/chat\/stream$/, '流式请求应当打到 /chat/stream')
    const body = JSON.parse(options.body)
    assert.deepEqual(
      { question: body.question, knowledge_base_id: body.knowledge_base_id },
      { question: '这是一个问题', knowledge_base_id: 'kb1' },
      '请求体应当带上问题与当前选中的知识库'
    )

    // 承重②：两条气泡都在屏幕上，助手那条是**真的 MarkdownRenderer** 渲染的
    //（子组件是真实 SFC，`.markdown-body` 是它自己的 v-html 出口）。
    assert.match(view.text(), /这是一个问题/, '用户气泡应当上屏')
    const markdownBodies = view.queryAll('.markdown-body')
    assert.equal(markdownBodies.length, 1, '助手回答应当由 MarkdownRenderer 渲染出一个 .markdown-body')
    assert.match(markdownBodies[0].innerHTML, /你好，世界/, '流式增量应当拼成完整回答')

    // 承重③：输入框被清空（`sendMessage` 里的 `question.value = ''`）。
    // 少了它，用户发完一条还得手删一遍。
    assert.equal(view.query('footer textarea').value, '', '发送后输入框应当清空')

    // 流结束后按钮回到可用态（streaming 复位），而不是永久转圈。
    await until(view, () => view.buttonByText('发送')?.disabled === true || true)
    assert.equal(view.query('footer textarea').disabled, false, '流结束后输入框应当恢复可用')
  } finally {
    await close(view)
  }
})

// ---------------------------------------------------------------------------
// b. 对照：没有内容时不发请求
// ---------------------------------------------------------------------------

test('空输入：不点得动「发送」，也不会发出流式请求', async () => {
  const { view, streamCalls } = await mountChat()
  globalThis.__streamCalls = streamCalls

  try {
    const button = view.buttonByText('发送')
    assert.ok(button, '页面上应当有「发送」按钮')
    // 模板 :273 的禁用条件 `!question.trim() && !attachments.length`：
    // 没有文字也没有图片时按钮是禁用的。
    assert.equal(button.disabled, true, '没有输入内容时「发送」按钮应当禁用')

    button.click()
    await settle(view)
    assert.equal(streamCalls.length, 0, '空输入不得发出流式请求')
    assert.equal(view.queryAll('.markdown-body').length, 0, '没有提问就不该有回答气泡')
  } finally {
    await close(view)
  }
})

// ---------------------------------------------------------------------------
// c. 接线：挂载后当前知识库选中与列表同步
// ---------------------------------------------------------------------------

test('挂载后当前知识库与列表第一个同步（syncSelectedKnowledgeBase 接线）', async () => {
  const { view } = await mountChat()

  try {
    // 视图真的拉了知识库列表（挂载期的 GET /knowledge-bases 不是空跑）。
    assert.ok(
      calls.some((entry) => entry.method === 'get' && entry.args[0] === '/knowledge-bases'),
      '挂载时应当拉一次知识库列表'
    )
    // `syncSelectedKnowledgeBase`：没有首选时落到列表第一个，并写回 store。
    // 少了这步，选中停在 null，上面那条「发送时带 knowledge_base_id」的断言也会跟着红。
    assert.match(view.text(), /KB1/, '当前知识库应当显示为列表第一个')
    const selected = view.queryAll('.el-select').length
    assert.ok(selected > 0, '页面上应当渲染出知识库选择器')
  } finally {
    await close(view)
  }
})

// ---------------------------------------------------------------------------
// d. 键盘接线：Enter / Shift+Enter / IME 合成态（issue #240）
//
// 这一组把 `handleInputEnter` 的三条出口都钉住：非合成态的 Enter 照常发送、
// Shift+Enter 留给换行、合成态（isComposing 或旧引擎的 keyCode 229）一律放行给输入法。
// 判据是**事件本身**：组字中的 Enter 若被 preventDefault，输入法就没法用它选字
//（这正是 #240 里「候选框被打掉」的机制），所以那两条直接断言 defaultPrevented。
// ---------------------------------------------------------------------------

test('Enter：非合成态按下应当发送并阻止默认行为', async () => {
  const { view, streamCalls } = await mountChat()
  globalThis.__streamCalls = streamCalls

  try {
    const textarea = view.query('footer textarea')
    assert.ok(textarea, '页面上应当有提问用的输入框')
    textarea.value = 'q-plain'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await view.flush(3)
    assert.equal(view.buttonByText('发送').disabled, false, '输入内容后「发送」按钮应当可用')

    const event = await pressEnter(view)
    assert.equal(event.defaultPrevented, true, '非合成态的 Enter 应当被 preventDefault（交给 sendMessage）')

    await until(view, () => streamCalls.length > 0)
    assert.equal(streamCalls.length, 1, '非合成态按 Enter 应当恰好发一次流式请求')
    const body = JSON.parse(streamCalls[0].options.body)
    assert.equal(body.question, 'q-plain', '发出的应当就是输入框里的问题')
  } finally {
    await close(view)
  }
})

test('Shift+Enter：非合成态按下不发送、不阻止默认行为', async () => {
  const { view, streamCalls } = await mountChat()
  globalThis.__streamCalls = streamCalls

  try {
    const textarea = view.query('footer textarea')
    textarea.value = 'q-shift'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await view.flush(3)

    const event = await pressEnter(view, { shiftKey: true })
    assert.equal(event.defaultPrevented, false, 'Shift+Enter 是换行，不应当被 preventDefault')

    await settle(view)
    assert.equal(streamCalls.length, 0, 'Shift+Enter 不得发出流式请求')
    assert.equal(view.query('footer textarea').value, 'q-shift', '输入框内容应当留在原地（换行而非清空）')
  } finally {
    await close(view)
  }
})

test('IME：组字中按 Enter 不发送、也不吃掉候选框的默认行为', async () => {
  const { view, streamCalls } = await mountChat()
  globalThis.__streamCalls = streamCalls

  try {
    const textarea = await typeDuringComposition(view, 'shijie')
    // 前置闸门（防假绿）：DOM 里已经有未上屏的文本，但 v-model 没跟着走 ——
    // el-input 在 isComposing 的 input 上早退，`question` 仍是空串，按钮因此仍禁用。
    // 少了 vueMount 里的 CompositionEvent 全局，compositionstart 会在 emit 校验器里
    // 抛 ReferenceError 并被 Vue 吞掉，isComposing 无从置起，这条前置会先红。
    assert.equal(textarea.value, 'shijie', '前置：DOM 里应当有未上屏的文本')
    assert.equal(view.buttonByText('发送').disabled, true, '前置：组字中 v-model 不应跟着 DOM 走')

    const event = await pressEnter(view, { isComposing: true })
    assert.equal(event.defaultPrevented, false, '组字中的 Enter 应当留给输入法选字，不得被吃掉')

    await settle(view)
    assert.equal(streamCalls.length, 0, '组字中的 Enter 不得发出流式请求')
  } finally {
    await close(view)
  }
})

test('IME：组字中按 Enter 不得把未上屏文本之外的旧文本发出去（issue #240 原症状）', async () => {
  const { view, streamCalls } = await mountChat()
  globalThis.__streamCalls = streamCalls

  try {
    // 先正常输入一段并让它上屏（v-model = '你好'），再进入合成态打 '你好shijie'。
    const textarea = view.query('footer textarea')
    textarea.value = '你好'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await view.flush(3)
    assert.equal(view.buttonByText('发送').disabled, false, '前置：上屏后按钮应当可用')

    await typeDuringComposition(view, '你好shijie')
    assert.equal(textarea.value, '你好shijie', '前置：DOM 里是尚未上屏的新文本')

    const event = await pressEnter(view, { isComposing: true })
    assert.equal(event.defaultPrevented, false, '组字中的 Enter 不得被 preventDefault')

    await settle(view)
    // 修复前的红：这里恰好 1 次请求，且 body.question === '你好' —— 旧文本被发出去、
    // 合成中的候选框被打掉，就是 #240 的字面症状。
    assert.equal(streamCalls.length, 0, '组字中的 Enter 不得发出流式请求（尤其是旧文本）')
  } finally {
    await close(view)
  }
})

test('IME：仅 keyCode 229（旧引擎 / isComposing 缺失）时同样不发送', async () => {
  const { view, streamCalls } = await mountChat()
  globalThis.__streamCalls = streamCalls

  try {
    const textarea = view.query('footer textarea')
    textarea.value = 'q-229'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await view.flush(3)
    assert.equal(view.buttonByText('发送').disabled, false, '前置：非空输入时按钮应当可用')

    // 老引擎在「输入法正在处理」时只给 keyCode 229，不给 isComposing。
    const event = await pressEnter(view, { keyCode: 229 })
    assert.equal(event.defaultPrevented, false, '229 也是组字，不得被 preventDefault')

    await settle(view)
    assert.equal(streamCalls.length, 0, '仅凭 keyCode 229 就应当拦下这次 Enter')
  } finally {
    await close(view)
  }
})

test('IME：compositionend 之后按 Enter 发送的是上屏后的全文', async () => {
  const { view, streamCalls } = await mountChat()
  globalThis.__streamCalls = streamCalls

  try {
    const textarea = await typeDuringComposition(view, '你好shijie')
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await view.flush(3)
    // 上屏后 el-input 会把合成结果补进 v-model（handleCompositionEnd -> handleInput）。
    assert.equal(view.buttonByText('发送').disabled, false, '上屏后按钮应当可用')

    const event = await pressEnter(view)
    assert.equal(event.defaultPrevented, true, '上屏之后的 Enter 应当照常被 sendMessage 接管')

    await until(view, () => streamCalls.length > 0)
    assert.equal(streamCalls.length, 1, '上屏后的 Enter 应当恰好发一次流式请求')
    const body = JSON.parse(streamCalls[0].options.body)
    assert.equal(body.question, '你好shijie', '发出的应当是上屏后的全文')
  } finally {
    await close(view)
  }
})

// ---------------------------------------------------------------------------
// e. 消息反馈（issue #250）：👍/👎 的选中态、请求体、取消与失败回滚
//
// 视图这一层只有一条逻辑：`onFeedback` 把「再点同向 = 取消（归 0）」算出来，
// 交给 store 的 setMessageFeedback，并接住 store 回滚后重新抛出的 rejection。
// 所以这里钉三件事：按钮真的渲染出来了、点下去发出去的请求体对不对、
// 失败后 DOM 有没有跟着 store 回到调用前的值。
//
// 失败提示（ElMessage）**不在**断言面内：整个 `api/request.js` 被换成了替身，
// 弹提示的 axios 拦截器（src/api/request.js）根本没进模块图，替身也不负责弹。
// 视图只保证「接住了 rejection、不让它变成未处理的 Promise」。
// ---------------------------------------------------------------------------

// 挂载用例的 views/Chat.vue 与测试这里 import 的是同一个 src/stores/chat.js
//（同一个解析结果 -> 同一个模块实例），所以能从同一个 pinia 里取到视图正在用的 store。
async function viewStore(view) {
  const { useChatStore } = await import(new URL('../src/stores/chat.js', import.meta.url).href)
  return useChatStore(view.pinia)
}

test('反馈按钮：助手消息上有 👍/👎，落库消息可点', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })

  try {
    // PERSISTED 里只有一条助手消息（id=2），所以恰好一组反馈按钮。
    const ups = view.queryAll('[data-testid="feedback-up"]')
    const downs = view.queryAll('[data-testid="feedback-down"]')
    assert.equal(ups.length, 1, '助手消息上应当有一个「有帮助」按钮')
    assert.equal(downs.length, 1, '助手消息上应当有一个「没帮助」按钮')
    // 初始未反馈：两个都用「未选中」色，且因为消息已落库（有 id）都可点。
    for (const button of [...ups, ...downs]) {
      assert.equal(button.classList.contains('text-slate-400'), true, '未反馈时应当用未选中色')
      assert.equal(button.disabled, false, '已落库的助手消息，反馈按钮应当可点')
    }
  } finally {
    await close(view)
  }
})

test('反馈按钮：点「有帮助」发出 feedback=1，按钮切到选中色', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })

  try {
    assert.equal(callsOf('post').length, 0, '前置：挂载后还没有任何 POST')
    const up = view.query('[data-testid="feedback-up"]')
    assert.ok(up, '页面上应当有「有帮助」按钮')

    up.click()
    await view.flush(2)

    // 承重①：请求打到消息级反馈路由，body 是 { feedback: 1 }。
    assert.deepEqual(callsOf('post'), [
      { method: 'post', args: ['/chat/messages/2/feedback', { feedback: 1 }] },
    ], '点「有帮助」应当向 /chat/messages/2/feedback 发 { feedback: 1 }')

    // 承重②：选中态上屏（乐观更新，不等请求回来）。
    assert.equal(up.classList.contains('text-brand-600'), true, '选中后应当用高亮色')
    assert.equal(up.classList.contains('text-slate-400'), false, '选中后不应再是未选中色')
  } finally {
    await close(view)
  }
})

test('反馈按钮：再点同向取消（feedback=0），选中态回落', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })

  try {
    const up = view.query('[data-testid="feedback-up"]')
    up.click()
    await view.flush(2)
    assert.equal(up.classList.contains('text-brand-600'), true, '前置：第一次点应当选中')

    up.click()
    await view.flush(2)

    // 「再点同向 = 取消」：第二次发出的是 0，而不是把 1 再发一遍。
    assert.deepEqual(
      callsOf('post').map((entry) => entry.args[1]),
      [{ feedback: 1 }, { feedback: 0 }],
      '第二次点击应当发 { feedback: 0 }（取消），而不是重复提交 1'
    )
    assert.equal(up.classList.contains('text-slate-400'), true, '取消后应当回到未选中色')
  } finally {
    await close(view)
  }
})

test('反馈按钮：提交失败时回滚到调用前的值，并接住 rejection', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })

  try {
    const store = await viewStore(view)
    respond('post', () => {
      throw new Error('反馈提交失败')
    })
    const up = view.query('[data-testid="feedback-up"]')

    up.click()
    await view.flush(2)
    // 先乐观选中，请求被拒后滚回去。
    await settle(view)

    assert.equal(up.classList.contains('text-slate-400'), true, '失败后按钮应当回到未选中色')
    const message = store.messages.find((item) => item.id === 2)
    assert.equal(message.feedback, 0, '失败后 store 里的值应当回滚到调用前的 0')
    // 请求确实发出去了（不是因为没发才没变）。
    assert.equal(callsOf('post').length, 1, '无论成败，请求都应当发出去一次')
  } finally {
    await close(view)
  }
})

test('反馈按钮：没有 id 的本地消息按钮禁用，且点击不发请求', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })

  try {
    // 本地/流式中的助手消息没有 id（normalizeMessage 把缺省 id 归一成 null），
    // 此时按钮必须禁用 —— 否则会发出 `/chat/messages/null/feedback` 这种打不中的请求。
    const store = await viewStore(view)
    store.addMessage({ role: 'assistant', content: '本地回答', isLocal: true })
    await view.flush(2)

    const localUp = view.queryAll('[data-testid="feedback-up"]').at(-1)
    assert.ok(localUp, '本地助手消息也应当渲染出反馈按钮')
    assert.equal(localUp.disabled, true, '没有 id 的消息，反馈按钮应当禁用')

    localUp.click()
    await view.flush(2)
    assert.equal(callsOf('post').length, 0, '禁用的反馈按钮不得发出任何请求')
  } finally {
    await close(view)
  }
})

// ---------------------------------------------------------------------------
// f. 编辑用户消息并重发（issue #253）
//
// 接线只有一条：`resendFrom(index, text)` = 截断到 index + 把文本灌回 `question`
// + 走既有的 `sendMessage()`。「重新生成」是它的同构变体（文本取自上一条用户消息），
// 「编辑重发」的差异只在入口、文本来源与守卫。
//
// 所以这里钉三件事：
//   ① 编辑框真的渲染出来、带的是这条消息自己的原文，且**不碰页脚输入框**
//      （页脚在流式期间是禁用的，还可能存着用户草稿）；
//   ② 「提交」发出去的请求体是改后的文本（而不是原文），且截断只切掉它之后的内容；
//   ③ 三条退出路径（Esc / 「取消」/ 未改动提交）与三条守卫（空文本、生成中、连点）
//      各自不越界。
//
// 时序是这套用例最容易踩的地方：默认替身（ANSWER_FRAMES）会在**第一个宏任务**里
// 把整个流连着收尾的 refreshMessages 一起跑完，于是「已截断、新回答还没回来」
// 这个可观测窗口不到一个宏任务宽 —— 拿 flush() 去断言它就是竞态（实测：
// flush(3) 时旧回答已经刷回来了）。需要「按住生成中」的用例（E2/E3/E7/E8/E10）
// 一律改用 `installGatedStreamStub()`：流一直挂着，直到用例自己 release()。
// ---------------------------------------------------------------------------

// 出口替身：帧照给，但**挂在闸门上**——release() 之前流不结束、streaming 恒为 true。
// 返回的数组带一个 release 方法（挂载用例读的是数组本身，故直接挂在数组上）。
function installGatedStreamStub(frames = ANSWER_FRAMES) {
  const streamCalls = []
  let openGate
  const gate = new Promise((resolve) => {
    openGate = resolve
  })
  globalThis.fetch = async (url, options) => {
    streamCalls.push({ url, options })
    const encoded = frames.map((frame) => encoder.encode(frame))
    let pushed = false
    return {
      ok: true,
      body: new ReadableStream({
        async pull(controller) {
          // 只推一次：闸门放行后一次性把帧全给出去再收尾。
          if (pushed) return
          pushed = true
          await gate
          for (const chunk of encoded) controller.enqueue(chunk)
          controller.close()
        },
      }),
      async json() {
        return {}
      },
    }
  }
  streamCalls.release = () => openGate()
  return streamCalls
}

// 出口替身：一发起流式请求就以一个 !ok 的响应作答（走 assertStreamResponse 的报错分支）。
function installFailingStreamStub(detail = '编辑重发失败') {
  const streamCalls = []
  globalThis.fetch = async (url, options) => {
    streamCalls.push({ url, options })
    return {
      ok: false,
      status: 500,
      async json() {
        return { detail }
      },
    }
  }
  return streamCalls
}

// 气泡内联编辑框的选择器：`.message-edit-input` 在 el-input 外层，
// 里面的原生 textarea 才是写值/派发事件的地方。
const editBox = (view) => view.query('.message-edit-input textarea')

// 文档顺序里的第 ordinal 个「编辑」按钮 = 第 ordinal 条用户消息上的那个
//（助手消息上没有编辑按钮，所以序号天然按用户消息数）。
const editButton = (view, ordinal = 0) => view.queryAll('[data-testid="edit-message"]')[ordinal]

async function openEdit(view, ordinal = 0) {
  const button = editButton(view, ordinal)
  assert.ok(button, `前置：第 ${ordinal + 1} 条用户消息上应当有「编辑」按钮`)
  button.click()
  await view.nextTick()
  const box = editBox(view)
  assert.ok(box, '点「编辑」后应当渲染出编辑框')
  return box
}

async function typeInEditBox(view, text) {
  const box = editBox(view)
  assert.ok(box, '前置：编辑框还在')
  box.value = text
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await view.flush(3)
  return box
}

// 在任意元素上按一次键。cancelable: true 是断言面（defaultPrevented）的前提，
// 同 pressEnter：不可取消的事件恒为 false，会让对照组假绿。
async function pressKeyOn(view, element, key, init = {}) {
  const event = new KeyboardEvent('keydown', {
    key, code: key, bubbles: true, cancelable: true, ...init,
  })
  element.dispatchEvent(event)
  await view.flush(3)
  return event
}

test('编辑 E1：点「编辑」进入编辑态，编辑框带出原文，页脚输入框不受影响', async () => {
  const { view, streamCalls } = await mountChat({ route: '/chat/c1' })

  try {
    assert.equal(view.queryAll('.message-edit-input').length, 0, '前置：一开始没有编辑框')
    assert.equal(view.queryAll('[data-testid="edit-message"]').length, 1, '前置：唯一一条用户消息上有「编辑」按钮')

    const box = await openEdit(view, 0)

    // 承重①：编辑框真的渲染出来了，且带出的是这条消息自己的正文。
    assert.equal(view.queryAll('.message-edit-input').length, 1, '进入编辑态应当恰好渲染一个编辑框')
    assert.equal(box.value, '这是一个问题', '编辑框应当带出这条消息的原文')

    // 承重②：页脚输入框还在、还是空的 —— 编辑走的是气泡内联的输入框，
    // 不复用页脚（后者在流式期间被 :disabled，且可能存着用户没发出去的草稿）。
    const footer = view.query('footer textarea')
    assert.ok(footer, '页脚输入框应当还在')
    assert.equal(footer.value, '', '编辑不应动到页脚输入框的内容')

    // 承重③：只是进编辑态，不发任何请求。
    assert.equal(streamCalls.length, 0, '仅进入编辑态不得发出流式请求')
  } finally {
    await close(view)
  }
})

test('编辑 E2：改完点「提交」→ 截断旧尾巴并按新文本重发', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })
  // 换掉挂载时的替身：这条用例要的是「截断已发生、新回答还在路上」这个态。
  const streamCalls = installGatedStreamStub([]) // 不给帧：断言面是截断与请求体，不是新回答的内容

  try {
    await openEdit(view, 0)
    await typeInEditBox(view, '改过的问题')

    const mark = streamCalls.length
    const button = view.buttonByText('提交')
    assert.ok(button, '编辑态下应当有「提交」按钮')
    assert.equal(button.disabled, false, '未在生成中时「提交」应当可点')
    button.click()
    await settle(view)

    // 承重①：编辑态立刻退出，不会留一个「按了没反应」的框在屏幕上。
    assert.equal(view.queryAll('.message-edit-input').length, 0, '提交后编辑框应当关闭')
    assert.equal(view.queryAll('[data-testid="edit-message"]').length, 1, '提交后这条用户消息仍在屏幕上')

    // 承重②：旧的回答已经从屏幕上摘掉 —— 截断发生在重发之前（slice(0, index)）。
    assert.equal(view.text().includes('你好'), false, '提交后旧回答不应当还留在屏幕上')
    assert.equal(view.text().includes('改过的问题'), true, '改后的文本应当作为用户气泡上屏')

    // 承重③：真的按改后的文本重发了，且带上了当前知识库。
    assert.equal(streamCalls.length - mark, 1, '提交应当恰好发一次流式请求')
    const body = JSON.parse(streamCalls[mark].options.body)
    assert.equal(body.question, '改过的问题', '重发的应当是被改过的文本')
    assert.notEqual(body.question, '这是一个问题', '重发的不得是被改之前的原文')
    assert.equal(body.knowledge_base_id, 'kb1', '重发应当带上当前选中的知识库')
  } finally {
    await close(view)
  }
})

test('编辑 E3：截断边界 —— 只切掉这条之后的内容，之前的一条都不动', async () => {
  const FOUR = [
    { id: 11, role: 'user', content: '第一条问题', created_at: '2024-02-01T00:00:01Z' },
    { id: 12, role: 'assistant', content: '第一条回答', created_at: '2024-02-01T00:00:02Z' },
    { id: 13, role: 'user', content: '第二条问题', created_at: '2024-02-01T00:00:03Z' },
    { id: 14, role: 'assistant', content: '第二条回答', created_at: '2024-02-01T00:00:04Z' },
  ]
  const { view } = await mountChat({ route: '/chat/c1', messages: FOUR })
  const streamCalls = installGatedStreamStub([])

  try {
    // 第 2 个用户气泡 = 消息数组下标 2 的「第二条问题」。
    await openEdit(view, 1)
    assert.equal(editBox(view).value, '第二条问题', '前置：编辑的是第二条问题')

    // 承重①：不是最后一条 → 编辑框下方提示「之后的内容会被移除」。
    assert.equal(
      view.text().includes('提交后，这条消息之后的内容将被移除'),
      true,
      '编辑的不是最后一条时，应当提示后续内容会被移除'
    )

    await typeInEditBox(view, '修改后的问题')
    const mark = streamCalls.length
    view.buttonByText('提交').click()
    await settle(view)

    // 承重②：这条之前的（u1/a1）原样留着 —— slice(0, index) 不是 slice(0, 0)。
    assert.equal(view.text().includes('第一条问题'), true, '被编辑消息之前的内容不应当被切掉')
    assert.equal(view.text().includes('第一条回答'), true, '被编辑消息之前的回答不应当被切掉')

    // 承重③：这条及其之后的（u2/a2）从屏幕上摘掉。
    assert.equal(view.text().includes('第二条问题'), false, '被编辑的那条的原文本应当下屏')
    assert.equal(view.text().includes('第二条回答'), false, '被编辑消息之后的内容应当下屏')

    // 承重④：重发的是改后的文本。
    assert.equal(streamCalls.length - mark, 1, '提交应当恰好发一次流式请求')
    assert.equal(
      JSON.parse(streamCalls[mark].options.body).question,
      '修改后的问题',
      '重发的应当是被改过的文本'
    )
  } finally {
    await close(view)
  }
})

test('编辑 E4：Esc 取消 —— 关框、正文不动、不发请求，再进还是原文', async () => {
  const { view, streamCalls } = await mountChat({ route: '/chat/c1' })

  try {
    await openEdit(view, 0)
    await typeInEditBox(view, '不要这个')
    assert.equal(editBox(view).value, '不要这个', '前置：草稿已经改动')

    await pressKeyOn(view, editBox(view), 'Escape')

    // 承重①：框关了、请求没发、store 里的正文一个字没动。
    assert.equal(view.queryAll('.message-edit-input').length, 0, 'Esc 应当关闭编辑框')
    assert.equal(streamCalls.length, 0, '取消不得发出流式请求')
    const store = await viewStore(view)
    assert.equal(store.messages[0].content, '这是一个问题', '取消后 store 里的正文不应当变')

    // 承重②：草稿被丢弃 —— 再进一次带出的是原文，不是上次没提交的改动。
    await openEdit(view, 0)
    assert.equal(editBox(view).value, '这是一个问题', '重新进入编辑态应当重新带出原文（草稿已清）')
  } finally {
    await close(view)
  }
})

test('编辑 E5：「取消」按钮等价于 Esc；原文没改的「提交」不发请求', async () => {
  const { view, streamCalls } = await mountChat({ route: '/chat/c1' })

  try {
    await openEdit(view, 0)
    await typeInEditBox(view, '不要这个')
    const cancel = view.buttonByText('取消')
    assert.ok(cancel, '编辑态下应当有「取消」按钮')

    cancel.click()
    await view.nextTick()
    assert.equal(view.queryAll('.message-edit-input').length, 0, '点「取消」应当关闭编辑框')
    assert.equal(streamCalls.length, 0, '取消不得发出流式请求')

    // 未改动直接提交：等价于「什么都没发生」—— 关框、不发请求。
    // 少了这条守卫，点一次「提交」就会白白把后文清空重发一遍。
    await openEdit(view, 0)
    const mark = streamCalls.length
    view.buttonByText('提交').click()
    await view.nextTick()
    assert.equal(view.queryAll('.message-edit-input').length, 0, '未改动的提交也应当关框')
    assert.equal(streamCalls.length, mark, '文本没变时提交不得重发')
  } finally {
    await close(view)
  }
})

test('编辑 E6：编辑框里组字中按 Enter 不提交、不吃掉候选框', async () => {
  const { view, streamCalls } = await mountChat({ route: '/chat/c1' })

  try {
    const box = await openEdit(view, 0)
    box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    box.value = '这是一个问题shijie'
    box.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'shijie' }))
    await view.flush(3)
    assert.equal(editBox(view).value, '这是一个问题shijie', '前置：DOM 里是尚未上屏的拼音')

    // 承重①：isComposing 的 Enter 应当留给输入法（不 preventDefault、不提交）。
    const composing = await pressKeyOn(view, editBox(view), 'Enter', { isComposing: true })
    assert.equal(composing.defaultPrevented, false, '组字中的 Enter 应当放行给输入法，不得 preventDefault')
    assert.equal(view.queryAll('.message-edit-input').length, 1, '组字中的 Enter 不应当提交并关框')
    assert.equal(streamCalls.length, 0, '组字中的 Enter 不得发出流式请求')

    // 承重②：老引擎只给 keyCode 229，同样要放行。
    const legacy = await pressKeyOn(view, editBox(view), 'Enter', { keyCode: 229 })
    assert.equal(legacy.defaultPrevented, false, '仅 keyCode 229 也应当放行')
    assert.equal(view.queryAll('.message-edit-input').length, 1, '仅 keyCode 229 也不应当提交')
    assert.equal(streamCalls.length, 0, '仅 keyCode 229 不得发出流式请求')
  } finally {
    await close(view)
  }
})

test('编辑 E7：编辑框里 Shift+Enter 换行、裸 Enter 提交', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })
  const streamCalls = installGatedStreamStub()

  try {
    await openEdit(view, 0)
    await typeInEditBox(view, '改过的问题')

    // 承重①：Shift+Enter 是换行，不提交。
    const shift = await pressKeyOn(view, editBox(view), 'Enter', { shiftKey: true })
    assert.equal(shift.defaultPrevented, false, 'Shift+Enter 是换行，不应当 preventDefault')
    assert.equal(view.queryAll('.message-edit-input').length, 1, 'Shift+Enter 不应当关框')
    assert.equal(streamCalls.length, 0, 'Shift+Enter 不得发出流式请求')

    // 承重②：正对照 —— 同一位置裸 Enter 就该提交。
    // 没有它，E6/E7 的「不提交」在 handleEditEnter 整个没接线时也会假绿。
    const enter = await pressKeyOn(view, editBox(view), 'Enter')
    assert.equal(enter.defaultPrevented, true, '裸 Enter 应当被 preventDefault（交给 submitEdit）')
    await settle(view)
    assert.equal(view.queryAll('.message-edit-input').length, 0, '裸 Enter 应当提交并关框')
    assert.equal(streamCalls.length, 1, '裸 Enter 应当恰好发一次流式请求')
    assert.equal(JSON.parse(streamCalls[0].options.body).question, '改过的问题', '重发的应当是被改过的文本')
  } finally {
    await close(view)
  }
})

test('编辑 E8：生成中「编辑」按钮禁用，绕过禁用也进不去编辑态', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })
  const streamCalls = installGatedStreamStub()
  globalThis.__streamCalls = streamCalls

  try {
    assert.equal(editButton(view, 0)?.disabled, false, '前置：未生成时「编辑」按钮可用')

    await sendQuestion(view, '追问一句')
    await settle(view)
    assert.equal(view.text().includes('AI 正在生成'), true, '前置：现在处在生成中')

    // 承重①：生成中所有「编辑」按钮都禁用。
    const buttons = view.queryAll('[data-testid="edit-message"]')
    assert.equal(buttons.length, 2, '生成中两条用户消息都在屏幕上')
    for (const button of buttons) {
      assert.equal(button.disabled, true, '生成中「编辑」按钮应当禁用')
    }
    buttons[0].click()
    await view.nextTick()
    assert.equal(view.queryAll('.message-edit-input').length, 0, '禁用的按钮点下去不应当进入编辑态')

    // 承重②：绕过 DOM 禁用也进不去 —— jsdom 里 dispatchEvent 照样会送达监听器，
    // 挡它的是 startEdit 里的 streaming 守卫，不是 :disabled。少了这层守卫，
    // 生成中编辑就会截断到一半的对话。
    buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await view.nextTick()
    assert.equal(view.queryAll('.message-edit-input').length, 0, '绕过禁用也应当被脚本守卫挡下')

    // 承重③：流收尾后按钮回到可用态（不是永久禁用）。
    streamCalls.release()
    await settle(view)
    assert.equal(view.text().includes('AI 正在生成'), false, '流收尾后占位应当消失')
    assert.equal(editButton(view, 0)?.disabled, false, '流收尾后「编辑」按钮应当恢复可用')
  } finally {
    await close(view)
  }
})

test('编辑 E9：清空后提交是空操作（不关框、不重发、草稿留着）', async () => {
  const { view, streamCalls } = await mountChat({ route: '/chat/c1' })

  try {
    await openEdit(view, 0)
    await typeInEditBox(view, '   ')
    assert.equal(editBox(view).value, '   ', '前置：草稿已被清成空白')

    view.buttonByText('提交').click()
    await settle(view)

    // 承重①：留在编辑态 —— 这里刻意与 confirmRename 的「先退出再校验」相反：
    // 空文本是「校验不过」，不是「提交完成」，退出会把用户刚清掉的框连人带草稿一起吞掉。
    assert.equal(view.queryAll('.message-edit-input').length, 1, '空文本提交应当留在编辑态')
    assert.equal(editBox(view).value, '   ', '草稿应当原样留着，不该被清掉')
    assert.equal(streamCalls.length, 0, '空文本提交不得发出流式请求')
    const store = await viewStore(view)
    assert.equal(store.messages[0].content, '这是一个问题', 'store 里的正文不应当变')

    // 承重②：卡住的是校验，不是状态机坏了 —— Esc 照常退得出去。
    await pressKeyOn(view, editBox(view), 'Escape')
    assert.equal(view.queryAll('.message-edit-input').length, 0, 'Esc 应当照常退出编辑态')
  } finally {
    await close(view)
  }
})

test('编辑 E10：连点两次「提交」只发一次请求', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })
  const streamCalls = installGatedStreamStub()

  try {
    await openEdit(view, 0)
    await typeInEditBox(view, '改过的问题')

    const button = view.buttonByText('提交')
    button.click()
    // 第二次点在哪取决于 Vue 什么时候把 DOM patch 掉，两种落点都不该产生第二个请求：
    // 按钮还在就再点一次（吃 submitEdit 的「已退出」与 store 的 streaming 两道守卫），
    // 已经摘掉就没有可点的了。
    view.buttonByText('提交')?.click()
    await settle(view)

    assert.equal(streamCalls.length, 1, '连点两次提交只应当发一次流式请求')
    assert.equal(view.queryAll('.message-edit-input').length, 0, '编辑态应当已经退出')
  } finally {
    await close(view)
  }
})

test('编辑 E11：重发失败时退出编辑态、错误上屏、之后还能再编辑', async () => {
  const { view } = await mountChat({ route: '/chat/c1' })
  const streamCalls = installFailingStreamStub()

  try {
    await openEdit(view, 0)
    await typeInEditBox(view, '改过的问题')
    view.buttonByText('提交').click()
    await settle(view)

    // 承重①：请求确实发出去了，且编辑态已经退出（退出发生在发起重发之前），
    // 不会因为失败就卡在「编辑中」。
    assert.equal(streamCalls.length, 1, '重发请求应当发出去一次')
    assert.equal(view.queryAll('.message-edit-input').length, 0, '失败也不应当把编辑框留在屏幕上')

    // 承重②：错误走既有的 errorMessage -> ElMessage.error 通道上屏（只钉「报了」，
    // 不钉文案细节）；失败原因同时落在助手气泡的 stream_error 上。
    const errors = view.messages.filter((item) => item.level === 'error')
    assert.ok(errors.length >= 1, '重发失败应当在页面上报错')
    assert.equal(view.text().includes('编辑重发失败'), true, '失败原因应当上屏')

    // 承重③：失败不阻断重试 —— 还能再进编辑态（截断不会被回滚，这是既有行为）。
    await openEdit(view, 0)
    assert.equal(view.queryAll('.message-edit-input').length, 1, '失败之后应当还能再编辑')
  } finally {
    await close(view)
  }
})

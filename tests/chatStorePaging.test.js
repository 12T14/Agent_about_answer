import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// 会话列表分页（issue #191 引入、评审条件③点名缺用例）：fetchConversations /
// loadMoreConversations / hasMoreConversations。
//
// 后半段并入 issue #251 的标题检索：检索词怎么进参数（空值不带 q 键）、翻页怎么带上它、
// 以及搜索让并发成为常态之后的两个新问题——旧检索词的响应迟到、翻页在途时换了检索词。
//
// 只替换网络层（@/api/chat），跑的是真实的 src/stores/chat.js，口径同 tests/chatStore.test.js：
// 请求进队列，用例自己决定什么时候返回、返回什么，因此可以断言「翻页带过去的
// (updated_at, id) 复合游标是不是那一个」，而不只是数调用次数。
//
// 与 chatStore.test.js 分开成文件，是因为那边的桩把 getConversations 的入参丢掉了
// （只回一个 resolve），而分页要断言的恰恰是入参；两边的桩口径相同，只是这一个记参数。
const stubSource = [
  'const pending = []',
  'export const getConversationsCalls = []',
  'export const chatAPI = {',
  '  getConversations: (params) => new Promise((resolve, reject) => {',
  '    getConversationsCalls.push(params)',
  '    pending.push({ resolve, reject, params })',
  '  }),',
  '}',
  // chat.js 在模块层 import 了 streamChat，缺了它整个模块加载不起来。
  'export function streamChat() {}',
  'function take() {',
  '  const entry = pending.shift()',
  "  if (!entry) throw new Error('没有在飞的会话列表请求')",
  '  return entry',
  '}',
  'export function respond(data) { take().resolve(data) }',
  // 按位置返回：respond 是 FIFO，表达不了「后发的请求先回」——而搜索引入的并发正是
  // 要断言「旧检索词的响应迟到时会不会覆盖新结果」，所以需要指定哪一笔先落地。
  'export function respondAt(index, data) { pending[index].resolve(data) }',
  'export function respondError(error) { take().reject(error) }',
  'export function pendingCount() { return pending.length }',
  'export function resetStub() {',
  '  pending.length = 0',
  '  getConversationsCalls.length = 0',
  '}',
  '',
].join('\n')

export const chatApiStub = `data:text/javascript,${encodeURIComponent(stubSource)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/api/chat') {
      return { url: chatApiStub, shortCircuit: true }
    }
    if (specifier.startsWith('@/')) {
      return {
        url: new URL(`../src/${specifier.slice(2)}.js`, import.meta.url).href,
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})

const { createPinia, setActivePinia } = await import('pinia')
const { useChatStore } = await import('../src/stores/chat.js')
const { respond, respondAt, respondError, resetStub, getConversationsCalls, pendingCount } =
  await import(chatApiStub)

// 与 src/stores/chat.js 的常量对齐：一次取一页，多要一条判断「还有没有更早的」。
const PAGE_SIZE = 50
const FETCH_LIMIT = PAGE_SIZE + 1

const stamp = (n) => new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString()
const conv = (id, updatedAt) => ({ id, title: id, updated_at: updatedAt })
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index)
const rows = (from, to) => range(from, to).map((n) => conv(`c-${n}`, stamp(n)))
const idsOf = (store) => store.conversations.map((item) => item.id)

function createStore() {
  setActivePinia(createPinia())
  resetStub()
  return useChatStore()
}

function fetchWith(store, data) {
  const request = store.fetchConversations()
  respond(data)
  return request
}

test('初始没有「还有更多」：还没取过数就不该出现加载入口', async () => {
  const store = createStore()
  assert.equal(store.hasMoreConversations, false)
})

test('首屏只取一页，游标取该页末位（用翻页请求的入参反证）', async () => {
  const store = createStore()

  const request = store.fetchConversations()
  assert.equal(store.loading, true)
  assert.deepEqual(getConversationsCalls, [{ limit: FETCH_LIMIT }], '首屏不带游标')

  respond(rows(1, PAGE_SIZE + 1))
  await request

  assert.deepEqual(idsOf(store), range(1, PAGE_SIZE).map((n) => `c-${n}`))
  assert.equal(store.hasMoreConversations, true)
  assert.equal(store.loading, false)

  const load = store.loadMoreConversations()
  assert.deepEqual(getConversationsCalls.at(-1), {
    limit: FETCH_LIMIT,
    before_updated_at: stamp(PAGE_SIZE),
    before_id: `c-${PAGE_SIZE}`,
  })
  respond([])
  await load
})

test('取不满一页时没有更多，翻页是纯 no-op', async () => {
  const store = createStore()
  await fetchWith(store, rows(1, 10))
  assert.equal(store.hasMoreConversations, false)
  const callsAfterFetch = getConversationsCalls.length

  await store.loadMoreConversations()

  assert.equal(getConversationsCalls.length, callsAfterFetch, '到底之后不该再发请求')
  assert.equal(pendingCount(), 0)
  assert.equal(store.conversations.length, 10)
})

test('翻页：追加到列表末尾、复合游标前进、取不满一页即到底', async () => {
  const store = createStore()
  await fetchWith(store, rows(1, PAGE_SIZE + 1))
  assert.equal(store.hasMoreConversations, true)

  const first = store.loadMoreConversations()
  assert.deepEqual(getConversationsCalls.at(-1), {
    limit: FETCH_LIMIT,
    before_updated_at: stamp(PAGE_SIZE),
    before_id: `c-${PAGE_SIZE}`,
  })
  respond(rows(PAGE_SIZE + 1, 2 * PAGE_SIZE + 1))
  await first

  assert.equal(store.conversations.length, 2 * PAGE_SIZE, '更早的一页接在末尾')
  assert.equal(store.hasMoreConversations, true)

  const second = store.loadMoreConversations()
  assert.deepEqual(
    getConversationsCalls.at(-1),
    {
      limit: FETCH_LIMIT,
      before_updated_at: stamp(2 * PAGE_SIZE),
      before_id: `c-${2 * PAGE_SIZE}`,
    },
    '游标必须换成这一页的末位'
  )
  respond(rows(2 * PAGE_SIZE + 1, 2 * PAGE_SIZE + 30))
  await second

  assert.equal(store.conversations.length, 2 * PAGE_SIZE + 30)
  assert.equal(store.hasMoreConversations, false, '取不满一页 -> 到底')

  const callsAtBottom = getConversationsCalls.length
  await store.loadMoreConversations()
  assert.equal(getConversationsCalls.length, callsAtBottom)
})

test('与已加载内容重叠的返回逐条去重，不产生重复行', async () => {
  const store = createStore()
  await fetchWith(store, rows(1, PAGE_SIZE + 1)) // c-1..c-50

  const request = store.loadMoreConversations()
  respond(rows(40, 90)) // 51 条，前 11 条与已加载内容重叠
  await request

  const ids = idsOf(store)
  assert.equal(new Set(ids).size, ids.length, '不能有重复会话')
  assert.equal(ids.length, 89) // c-1..c-50 + c-51..c-89
  assert.equal(ids.at(-1), 'c-89')
})

test('末位缺 updated_at 时不给「还有更多」：给不出游标就不给入口', async () => {
  const store = createStore()
  const page = rows(1, PAGE_SIZE)
  page[PAGE_SIZE - 1] = { id: `c-${PAGE_SIZE}`, title: '没有 updated_at' }

  await fetchWith(store, [...page, conv(`c-${PAGE_SIZE + 1}`, stamp(PAGE_SIZE + 1))])

  assert.equal(store.hasMoreConversations, false)

  const calls = getConversationsCalls.length
  await store.loadMoreConversations()
  assert.equal(getConversationsCalls.length, calls)
})

test('响应不是数组时回落到空列表，且没有更多', async () => {
  const store = createStore()
  await fetchWith(store, null)

  assert.deepEqual(store.conversations, [])
  assert.equal(store.hasMoreConversations, false)
})

test('取数失败：loading 复位并把拒绝交给调用方', async () => {
  const store = createStore()

  const request = store.fetchConversations()
  respondError(new Error('会话接口不可用'))
  await assert.rejects(request, /会话接口不可用/)

  assert.equal(store.loading, false)
  assert.deepEqual(store.conversations, [])
})

test('重新取数会把列表换回最新一页，并重置游标与「还有更多」', async () => {
  const store = createStore()
  await fetchWith(store, rows(1, PAGE_SIZE + 1))
  const load = store.loadMoreConversations()
  respond(rows(PAGE_SIZE + 1, 2 * PAGE_SIZE + 1))
  await load
  assert.equal(store.conversations.length, 2 * PAGE_SIZE)

  const refresh = store.fetchConversations()
  respond(rows(1, PAGE_SIZE + 1))
  await refresh

  assert.equal(store.conversations.length, PAGE_SIZE, '刷新只取最新一页，不保留已翻出的更早会话')
  assert.equal(store.hasMoreConversations, true)

  const next = store.loadMoreConversations()
  assert.deepEqual(
    getConversationsCalls.at(-1),
    {
      limit: FETCH_LIMIT,
      before_updated_at: stamp(PAGE_SIZE),
      before_id: `c-${PAGE_SIZE}`,
    },
    '游标要回到新一页的末位，不能用刷新前的旧游标'
  )
  respond([])
  await next
})

test('在途时重复触发不叠加请求', async () => {
  const store = createStore()
  await fetchWith(store, rows(1, PAGE_SIZE + 1))

  const first = store.loadMoreConversations()
  const second = store.loadMoreConversations()

  assert.equal(pendingCount(), 1, '第二次触发必须被 loadingMoreConversations 挡住')
  assert.equal(getConversationsCalls.length, 2, '只有首屏那一次与这一次翻页')

  respond(rows(PAGE_SIZE + 1, PAGE_SIZE + 2))
  await Promise.all([first, second])

  assert.equal(store.conversations.length, PAGE_SIZE + 2)
})

// ── issue #251：标题检索 ────────────────────────────────────────────────

function searchWith(store, keyword, data) {
  const request = store.setConversationQuery(keyword)
  respond(data)
  return request
}

test('检索词并入请求参数：有词带 q 键，没搜索时不出现 q 键', async () => {
  const store = createStore()

  await fetchWith(store, rows(1, 3))
  // 「不搜索」必须逐字节等于引入检索之前的请求：多一个 q 键（哪怕是空串）都不算同现状。
  assert.deepEqual(getConversationsCalls.at(-1), { limit: FETCH_LIMIT })

  await searchWith(store, '制度', rows(1, 3))

  assert.deepEqual(getConversationsCalls.at(-1), { limit: FETCH_LIMIT, q: '制度' })
  assert.equal(store.conversationQuery, '制度', 'store 存的是已提交的检索词，供空结果文案判断')
})

test('过滤态翻页同时带上检索词与复合游标', async () => {
  const store = createStore()
  await searchWith(store, '制度', rows(1, PAGE_SIZE + 1))
  assert.equal(store.hasMoreConversations, true)

  const load = store.loadMoreConversations()
  assert.deepEqual(
    getConversationsCalls.at(-1),
    {
      limit: FETCH_LIMIT,
      q: '制度',
      before_updated_at: stamp(PAGE_SIZE),
      before_id: `c-${PAGE_SIZE}`,
    },
    '翻页不能丢掉检索词，否则「还有更多」翻出来的是不过滤的会话'
  )
  respond(rows(PAGE_SIZE + 1, PAGE_SIZE + 3))
  await load
})

test('清空检索词后请求里不再有 q 键', async () => {
  const store = createStore()
  await searchWith(store, '制度', rows(1, 3))

  await searchWith(store, '', rows(1, 3))

  assert.deepEqual(getConversationsCalls.at(-1), { limit: FETCH_LIMIT })
  assert.equal(store.conversationQuery, null)
})

test('过滤后恰好取满一页仍有「还有更多」，取不满即到底', async () => {
  const store = createStore()

  await searchWith(store, '制度', rows(1, PAGE_SIZE + 1))
  assert.equal(store.hasMoreConversations, true, '过滤后取回 51 条就是一整页，还有更早的命中')

  await searchWith(store, '报销', rows(1, PAGE_SIZE))
  assert.equal(store.hasMoreConversations, false, '只取回 50 条说明命中已经到底')
})

test('旧检索词的响应迟到时整段丢弃，不覆盖新结果', async () => {
  const store = createStore()

  const first = store.setConversationQuery('制')
  const second = store.setConversationQuery('制度')
  assert.equal(pendingCount(), 2, '两次检索各自在飞，后一次不取消前一次')

  respondAt(1, rows(20, 22)) // 新检索先回
  respondAt(0, rows(1, 3)) // 旧检索后回：必须被丢弃
  await Promise.all([first, second])

  assert.deepEqual(idsOf(store), ['c-20', 'c-21', 'c-22'])
  assert.equal(store.loading, false, '旧世代的收尾不得改新世代的状态')
})

test('翻页在途时切换检索词，旧的更早一页不会追加进新列表', async () => {
  const store = createStore()
  await searchWith(store, '制', rows(1, PAGE_SIZE + 1))
  assert.equal(store.hasMoreConversations, true)

  const load = store.loadMoreConversations() // 捕获旧世代
  const next = store.setConversationQuery('制度') // 开启新世代
  assert.equal(pendingCount(), 2)

  respondAt(1, rows(100, 102))
  respondAt(0, rows(PAGE_SIZE + 1, PAGE_SIZE + 5)) // 旧检索词的更早一页，必须被丢弃
  await Promise.all([load, next])

  assert.deepEqual(idsOf(store), ['c-100', 'c-101', 'c-102'])
  assert.equal(
    store.loadingMoreConversations,
    false,
    '在途翻页被新世代作废后标志必须复位，否则翻页从此不再放行'
  )
})

test('检索词剥空白后归一，与当前值相同的重复提交不产生请求', async () => {
  const store = createStore()

  const first = store.setConversationQuery('  制度  ')
  // 参数在发请求前就已归一：断言的是构造出来的入参，不是响应。
  assert.deepEqual(getConversationsCalls.at(-1), { limit: FETCH_LIMIT, q: '制度' })
  respond(rows(1, 3))
  await first

  const callsAfterFirst = getConversationsCalls.length
  await store.setConversationQuery('制度 ') // 归一后与当前值相同 -> 等值短路
  assert.equal(getConversationsCalls.length, callsAfterFirst, '等值重复不该再发请求')
  assert.equal(pendingCount(), 0)

  await searchWith(store, '  ', rows(1, 3)) // 纯空白等同清空
  assert.deepEqual(getConversationsCalls.at(-1), { limit: FETCH_LIMIT })
  assert.equal(store.conversationQuery, null)
})

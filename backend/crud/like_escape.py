"""LIKE 字面量匹配的转义规则（issue #251 从 rag/retrieval.py 提取，全仓唯一实现）。

用户输入的关键词在拼进 LIKE 模式前必须逐字符转义：`%` / `_` 是 LIKE 的通配符，不转义
就等于让用户输入当了通配符（搜 `100%` 会命中 `100达成`）。转义符本身也一并转义，否则
用户输入里的 `!` 会把后一位吃掉。

放在 `crud/` 的叶子模块而不是 `rag/retrieval.py`：检索链路（`rag/retrieval.py:16-23`）
顶层 import 了 `rag.llm` / `rag.milvus_client`，会话列表每来一个请求都从那里借这 5 行
的话，会把向量库与模型客户端一起拖进来，且 crud → rag 是反向依赖。也不能复制一份：
`crud/chat.py:18-20` 说清了本仓的取舍——同一条规则只在这里定义一次。本模块与
`crud/pagination.py` 同形：零依赖叶子，谁都能 import。

本模块只做转义，不做归一化（去空白、大小写折叠、按序通配）——那些是检索侧的匹配语义，
留在 `rag/retrieval.py`。
"""

LIKE_ESCAPE = "!"


def escape_like_char(char: str) -> str:
    # 反斜杠一并转义：MySQL 的习惯是把 \ 当默认转义符，`\%` 会被当成字面百分号，
    # 正好会把我插入的通配符吃掉（预筛变窄、可能漏召回）。
    if char == LIKE_ESCAPE or char in {"%", "_", "\\"}:
        return LIKE_ESCAPE + char
    return char


def like_contains_pattern(keyword: str) -> str:
    """把关键词变成「含该字面子串」的 LIKE 模式：逐字符转义后两端加 ``%``。

    调用方必须把 ``LIKE_ESCAPE`` 一并绑给 SQL 的 ``ESCAPE``（``ilike(..., escape=LIKE_ESCAPE)``），
    否则模式里的 ``!`` 只是普通字符，转义等于没做。

    空串不在契约内：调用方先判空（`crud/chat.py` 的 `if q:`），空串在这里会得到
    ``"%%"``——那是「匹配任意行」，与本模块要表达的「含这个子串」不是一回事。
    """
    return "%" + "".join(escape_like_char(char) for char in keyword) + "%"

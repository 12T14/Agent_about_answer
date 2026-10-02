"""issue #251 回归：会话列表按标题检索（服务端过滤）。

搜索必须下推成 SQL 谓词，与既有的 `(updated_at, id)` 键集游标**同层 AND**：先取一页再
在 Python 里按标题筛，会让「一页 51 条」变成「一堆命中不足 51 条的碎页」，前端
`hasMore` 的依据随之失真。本文件既钉过滤语义，也钉「过滤后仍取满一页」。

覆盖面的两条**有意不覆盖**（写在这里，免得下一个 reviewer 当成漏测）：

1. 非 ASCII 大小写折叠：`İ`(U+0130) / `K`(U+212A) 这类字符的 `lower()` 行为 SQLite
   （仅 ASCII）与 MySQL（全 Unicode）不同，仅 `rag/retrieval.py` 的 `_sql_case_foldable`
   在检索链路里处理过同类问题。本单只断言两库必然同解的命题。
2. MySQL 专属行为：CI 跑 SQLite，`utf8mb4_*` 排序规则不可见；`like_escape.escape_like_char`
   里转义反斜杠的那个分支在 SQLite 上零鉴别力（`\\` 在 `ESCAPE '!'` 下只是普通字符），
   真机验证见修复计划 §7 的「真机可选」。

fixture 形态照搬 `tests/test_list_query_counts.py`（内存 SQLite + StaticPool +
`api.statements` + alice/bob/act_as）；差异只在造数据的 helper 把标题参数化。
"""

from contextlib import contextmanager
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from crud import chat as crud_chat
from database import session as db_session
from database.session import Base
from model.models import Conversation, KnowledgeBase, KnowledgeFile, Message, RevokedToken, User
from router import chat as chat_router
from schema import schemas
from service import auth_service, chat_service, pagination_service


# 接口契约值，写字面量而不是从实现里读：否则实现把上限改没，用例会跟着一起「通过」。
QUERY_MAX_LENGTH = 200

# 会话列表序列化的字段集（`chat_service._serialize_conversation`）。带不带 `q` 都必须是这一组。
CONVERSATION_FIELDS = {
    "id",
    "title",
    "knowledge_base_id",
    "knowledge_base_name",
    "created_at",
    "updated_at",
}

# 造数据用的固定基准时刻：显式给 updated_at 让翻页用例跨过游标的时间戳那一档，
# 不必依赖「同一秒内按主键兜底」这一条。
BASE_TIME = datetime(2026, 1, 1, 0, 0, 0)


@compiles(LONGTEXT, "sqlite")
def _compile_longtext_as_text(_type, _compiler, **_kwargs):
    """建表要用到 knowledge_files.content（MySQL 的 LONGTEXT），SQLite 编不出来。"""
    return "TEXT"


@pytest.fixture()
def api():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        bind=engine,
        tables=[
            User.__table__, RevokedToken.__table__,
            KnowledgeBase.__table__,
            KnowledgeFile.__table__,
            Conversation.__table__,
            Message.__table__,
        ],
    )
    db = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)()

    alice = User(username="alice", password_hash="x")
    bob = User(username="bob", password_hash="x")
    db.add_all([alice, bob])
    db.commit()

    statements: list[str] = []

    @event.listens_for(engine, "before_cursor_execute")
    def _record_statement(conn, cursor, statement, parameters, context, executemany):
        if not executemany and statement.strip().upper().startswith("SELECT"):
            statements.append(" ".join(statement.split()))

    app = FastAPI()
    app.include_router(chat_router.router)
    app.dependency_overrides[db_session.get_db] = lambda: db
    # 归属校验不是本文件主题，默认固定为 alice，避免登录链路引入额外查询干扰 SQL 计数；
    # 换人的用例用 act_as() 覆盖。
    app.dependency_overrides[auth_service.get_current_user] = lambda: alice

    def act_as(user):
        app.dependency_overrides[auth_service.get_current_user] = lambda: user

    try:
        yield SimpleNamespace(
            client=TestClient(app),
            db=db,
            alice=alice,
            bob=bob,
            act_as=act_as,
            statements=statements,
        )
    finally:
        db.close()


@contextmanager
def recorded_selects(api):
    """记录请求期间引擎实际发出的 SELECT 语句（先清 identity map，理由见 #61 的用例）。"""
    api.db.expunge_all()
    api.statements.clear()
    yield api.statements


def _add_conversation(api, cid, title=None, updated_at=None, user=None):
    conversation = Conversation(
        id=cid,
        user_id=(user or api.alice).id,
        title=title if title is not None else f"会话-{cid}",
    )
    if updated_at is not None:
        conversation.updated_at = updated_at
    api.db.add(conversation)
    api.db.commit()
    return conversation


def _fetch(api, params=None):
    """发一次列表请求，连同这次请求实际发出的 SELECT 一起返回。"""
    with recorded_selects(api) as statements:
        response = api.client.get("/api/chat/conversations", params=params or {})
        return response, list(statements)


def _ids(response):
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()]


def _collect_all(api, q, limit):
    """带 q 从第一页翻到底，返回沿途收到的全部 id（含重复，交由调用方断言）。"""
    collected: list[str] = []
    cursor = None
    for _ in range(60):
        params = {"limit": limit, "q": q}
        if cursor is not None:
            params.update(cursor)
        response = api.client.get("/api/chat/conversations", params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        if not page:
            break
        collected.extend(item["id"] for item in page)
        last = page[-1]
        cursor = {"before_updated_at": last["updated_at"], "before_id": last["id"]}
    else:
        pytest.fail("游标翻页没有终止")
    return collected


def test_missing_and_blank_q_return_identical_pages(api):
    """无 q / 空 q / 全空白 q 三种请求逐项同结果，且它们的 SQL 里没有 LIKE。

    这一条同时钉死两头：「无 q 完全无感」与「有 q 确实下推」。
    """
    for index in range(5):
        _add_conversation(api, f"c-{index}", title=f"会话-{index}")

    no_q, no_q_sql = _fetch(api)
    blank, blank_sql = _fetch(api, {"q": ""})
    spaces, spaces_sql = _fetch(api, {"q": "   "})
    hits, hits_sql = _fetch(api, {"q": "会话"})

    assert _ids(no_q) == _ids(blank) == _ids(spaces) == [f"c-{index}" for index in range(4, -1, -1)]
    assert not any("LIKE" in statement for statement in no_q_sql)
    assert not any("LIKE" in statement for statement in blank_sql)
    assert not any("LIKE" in statement for statement in spaces_sql)
    # 有 q 的那次必须真的把过滤写进了 SQL（否则前三条断言可以靠「压根没实现过滤」通过）。
    assert any("LIKE" in statement for statement in hits_sql)


def test_chinese_substring_hits_title(api):
    _add_conversation(api, "c-hit-1", title="会话-制度问答")
    _add_conversation(api, "c-hit-2", title="会话-报销制度")
    _add_conversation(api, "c-miss", title="会话-天气")

    assert set(_ids(_fetch(api, {"q": "制度"})[0])) == {"c-hit-1", "c-hit-2"}
    # 子串匹配，不做分词：连在一起才命中。
    assert _ids(_fetch(api, {"q": "规章制度"})[0]) == []


def test_ascii_case_insensitive_both_directions(api):
    _add_conversation(api, "c-policy", title="Policy_QA")
    _add_conversation(api, "c-other", title="会话-天气")

    assert _ids(_fetch(api, {"q": "policy"})[0]) == ["c-policy"]
    assert _ids(_fetch(api, {"q": "POLICY"})[0]) == ["c-policy"]
    assert _ids(_fetch(api, {"q": "PoLiCy"})[0]) == ["c-policy"]


def test_percent_and_underscore_are_literal(api):
    _add_conversation(api, "c-pct", title="100%达成")
    _add_conversation(api, "c-plain", title="100达成")
    _add_conversation(api, "c-underscore", title="a_b")
    _add_conversation(api, "c-anychar", title="axb")

    # % 是字面量：搜 100% 不该命中 100达成（把 % 当通配符的话会命中）。
    assert _ids(_fetch(api, {"q": "100%"})[0]) == ["c-pct"]
    # 单独一个 % 只命中含有字面百分号的行。
    assert _ids(_fetch(api, {"q": "%"})[0]) == ["c-pct"]
    # _ 是字面量：搜 a_b 不该命中 axb。
    assert _ids(_fetch(api, {"q": "a_b"})[0]) == ["c-underscore"]
    # 这条专门抓「忘了转义 _」：当通配符用的话 100%达成 会被 100_ 命中。
    assert _ids(_fetch(api, {"q": "100_"})[0]) == []


def test_escape_char_itself_is_literal(api):
    _add_conversation(api, "c-bang", title="foo!bar")
    _add_conversation(api, "c-other", title="会话-天气")

    # ! 是 LIKE 的 ESCAPE 符：它出现在 q 里既不能报错，也不能把后一位吃掉。
    assert _ids(_fetch(api, {"q": "!"})[0]) == ["c-bang"]
    assert _ids(_fetch(api, {"q": "foo!bar"})[0]) == ["c-bang"]
    assert _ids(_fetch(api, {"q": "foo%b"})[0]) == []


def test_search_is_scoped_to_owner(api):
    _add_conversation(api, "c-alice-shared", title="会话-共享")
    _add_conversation(api, "c-alice-only", title="会话-alice专属")
    _add_conversation(api, "c-bob-shared", title="会话-共享", user=api.bob)

    assert set(_ids(_fetch(api, {"q": "共享"})[0])) == {"c-alice-shared"}

    api.act_as(api.bob)
    # bob 用自己的标题搜索，只看见自己的行。
    assert _ids(_fetch(api, {"q": "共享"})[0]) == ["c-bob-shared"]
    # bob 拿 alice 独有的标题搜索，搜不到 alice 的任何行。
    assert _ids(_fetch(api, {"q": "alice专属"})[0]) == []


def test_search_composes_with_cursor_without_gaps_or_dupes(api):
    """命中与不命中交错，带 q 全程翻页：并集恰为命中集合，且不命中行一页都不出现。"""
    expected = []
    for index in range(130):
        hit = index % 2 == 0
        cid = f"c-{index:03d}"
        title = f"会话-命中-{index}" if hit else f"会话-其他-{index}"
        _add_conversation(api, cid, title=title, updated_at=BASE_TIME + timedelta(minutes=index))
        if hit:
            expected.append(cid)

    collected = _collect_all(api, "命中", 7)

    assert len(collected) == len(set(collected))  # 不重复
    assert set(collected) == set(expected)  # 不遗漏，且没有任何不命中行混进来
    # 翻页顺序仍是「最近活动优先」：updated_at 递减。
    assert collected == sorted(expected, reverse=True)


def test_search_respects_effective_page_size(api):
    """过滤后仍取满一页——「先把整库取出来再筛」的实现会在这里垮掉。"""
    for index in range(51):
        _add_conversation(api, f"c-a-{index:02d}", title=f"会话-甲组-{index}")
    for index in range(50):
        _add_conversation(api, f"c-b-{index:02d}", title=f"会话-乙组-{index}")

    assert len(_ids(_fetch(api, {"q": "甲组", "limit": 51})[0])) == 51
    assert len(_ids(_fetch(api, {"q": "乙组", "limit": 51})[0])) == 50


def test_query_length_is_bounded(api):
    _add_conversation(api, "c-1", title="会话-1")

    assert api.client.get(
        "/api/chat/conversations", params={"q": "x" * (QUERY_MAX_LENGTH + 1)}
    ).status_code == 422
    # 边界之内不拦（200 上限本身是合法输入，只是搜不到东西）。
    assert api.client.get(
        "/api/chat/conversations", params={"q": "x" * QUERY_MAX_LENGTH}
    ).status_code == 200
    assert schemas.CONVERSATION_QUERY_MAX_LENGTH == QUERY_MAX_LENGTH

    # 绕过接口层的直接调用者同样拿不到超长检索词。
    with pytest.raises(HTTPException) as excinfo:
        pagination_service.resolve_conversation_query("x" * (QUERY_MAX_LENGTH + 1))
    assert excinfo.value.status_code == 422

    # 归一：空白/缺省等同「不检索」，两端空白剥掉。
    assert pagination_service.resolve_conversation_query(None) is None
    assert pagination_service.resolve_conversation_query("") is None
    assert pagination_service.resolve_conversation_query("   ") is None
    assert pagination_service.resolve_conversation_query(" 制度 ") == "制度"


def test_search_does_not_change_row_shape(api):
    _add_conversation(api, "c-1", title="会话-制度")
    _add_conversation(api, "c-2", title="会话-天气")

    plain = _fetch(api)[0].json()
    filtered = _fetch(api, {"q": "制度"})[0].json()

    assert len(plain) == 2
    assert [item["id"] for item in filtered] == ["c-1"]
    assert set(plain[0]) == CONVERSATION_FIELDS
    assert set(filtered[0]) == CONVERSATION_FIELDS


def test_q_is_optional_for_direct_service_callers(api):
    """q 必须有默认值：脚本、内部调用与既有用例都按「不传 q」调用。"""
    for index in range(5):
        _add_conversation(api, f"c-{index}")

    rows = chat_service.list_conversations(user=api.alice, db=api.db)
    assert [row["id"] for row in rows] == [f"c-{index}" for index in range(4, -1, -1)]

    crud_rows = crud_chat.list_conversations(api.db, api.alice.id, limit=3)
    assert len(crud_rows) == 3

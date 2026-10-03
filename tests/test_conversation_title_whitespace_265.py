"""Conversation renaming rejects blank titles and persists trimmed names (#265)."""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database.session import Base, get_db
from model.models import Conversation, User
from router import chat as chat_router
from service.auth_service import get_current_user


@pytest.fixture()
def api():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine, tables=[User.__table__, Conversation.__table__])
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    user = User(username="alice", password_hash="x")
    db.add(user)
    db.commit()
    conversation = Conversation(user_id=user.id, title="原标题")
    db.add(conversation)
    db.commit()

    app = FastAPI()
    app.include_router(chat_router.router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        with TestClient(app) as client:
            yield SimpleNamespace(client=client, db=db, cid=conversation.id)
    finally:
        db.close()
        engine.dispose()


def _stored_title(api, cid):
    # Reload from SQLite, rather than reading the object used to seed the fixture.
    api.db.expunge_all()
    return api.db.get(Conversation, cid).title


@pytest.mark.parametrize("title", ["", " ", "   ", "\t\n", "\u3000"])
def test_blank_title_is_rejected_without_changing_storage(api, title):
    response = api.client.put(f"/api/chat/conversations/{api.cid}", json={"title": title})

    assert response.status_code == 400
    assert response.json() == {"detail": "会话标题不能为空"}
    assert _stored_title(api, api.cid) == "原标题"


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("采购制度问答", "采购制度问答"),
        ("  采购 制度问答  ", "采购 制度问答"),
        ("\t采购制度问答\n", "采购制度问答"),
        ("中" * 40, "中" * 40),
    ],
)
def test_valid_title_is_trimmed_and_persisted(api, title, expected):
    response = api.client.put(f"/api/chat/conversations/{api.cid}", json={"title": title})

    assert response.status_code == 200
    assert response.json() == {"message": "ok"}
    assert _stored_title(api, api.cid) == expected


@pytest.mark.parametrize("title", ["x" * 41, " " + "x" * 40])
def test_original_request_length_limit_is_preserved(api, title):
    response = api.client.put(f"/api/chat/conversations/{api.cid}", json={"title": title})

    assert response.status_code == 422
    assert response.json()["detail"][0]["type"] == "string_too_long"
    assert _stored_title(api, api.cid) == "原标题"


@pytest.mark.parametrize("target", ["missing", "foreign"])
def test_valid_title_cannot_rename_a_missing_or_foreign_conversation(api, target):
    cid = "missing-conversation"
    if target == "foreign":
        other_user = User(username="bob", password_hash="x")
        api.db.add(other_user)
        api.db.commit()
        conversation = Conversation(user_id=other_user.id, title="他人的标题")
        api.db.add(conversation)
        api.db.commit()
        cid = conversation.id

    response = api.client.put(f"/api/chat/conversations/{cid}", json={"title": "新标题"})

    assert response.status_code == 404
    assert _stored_title(api, api.cid) == "原标题"
    if target == "foreign":
        assert _stored_title(api, cid) == "他人的标题"


def test_blank_title_still_requires_authentication(api):
    app = FastAPI()
    app.include_router(chat_router.router)
    app.dependency_overrides[get_db] = lambda: api.db
    with TestClient(app) as client:
        response = client.put(f"/api/chat/conversations/{api.cid}", json={"title": " "})

    assert response.status_code == 401
    assert _stored_title(api, api.cid) == "原标题"

from fastapi import FastAPI
from app.routes import router
from app.services.user_service import get_user
from .utils import helper

app = FastAPI()


def run() -> None:
    helper()
    get_user()
    app.include_router(router)
